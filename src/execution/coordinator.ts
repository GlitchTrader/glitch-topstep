import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { parseTradeIntent } from "../domain/intents.js";
import type { AccountVenueSnapshot, TradeIntent } from "../domain/models.js";
import { RiskRejectedError, validateEntryRisk } from "../risk/risk-engine.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import { JsonlEventStore } from "../storage/jsonl-event-store.js";
import { ProjectXApiClient } from "../projectx/client.js";

export interface ExecutionReceipt {
  schema_version: "glitch.direct.execution_receipt.v1";
  receipt_id: string;
  recorded_utc: string;
  intent_id: string | null;
  mode: "disabled" | "shadow" | "armed";
  status: "rejected" | "shadowed" | "submitted" | "closed" | "ignored";
  code: string;
  order_id?: number;
  detail?: string;
}

export class ExecutionCoordinator {
  private readonly seenIntentIds = new Set<string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly api: ProjectXApiClient,
    private readonly ledger: JsonlEventStore,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly resolveIssuedPacket: (snapshotHash: string) => DirectDecisionPacket | null,
  ) {}

  public async handleWireIntent(input: unknown): Promise<ExecutionReceipt> {
    let intent: TradeIntent;
    try {
      intent = parseTradeIntent(input);
    } catch (error) {
      return this.record({
        intentId: null,
        status: "rejected",
        code: "intent_schema_invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.seenIntentIds.has(intent.intentId)) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "intent_duplicate",
      });
    }
    this.seenIntentIds.add(intent.intentId);

    const issuedPacket = this.resolveIssuedPacket(intent.snapshotHash);
    if (!issuedPacket) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "decision_packet_unknown_or_expired",
      });
    }

    if (this.config.tradingMode === "disabled") {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "trading_disabled_by_operator",
      });
    }

    if (intent.action === "NOTHING" || intent.action === "HOLD") {
      return this.record({
        intentId: intent.intentId,
        status: "ignored",
        code: "no_execution_action",
      });
    }

    if (intent.action === "EXIT") {
      return this.handleExit(intent, issuedPacket);
    }

    if (intent.action !== "ENTER_LONG" && intent.action !== "ENTER_SHORT") {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "action_not_implemented",
        detail: "MOVE_STOP and MOVE_TP require durable protective-order ownership before activation.",
      });
    }

    try {
      const currentSnapshot = this.snapshot();
      const validated = validateEntryRisk(
        intent,
        currentSnapshot,
        this.config.policy,
        this.config.risk,
        {
          expectedAccountId: this.config.scope.accountId,
          expectedAccountName: this.config.scope.accountName,
          expectedInstrument: this.config.scope.instrument,
          expectedSnapshotHash: issuedPacket.market.snapshot_hash,
        },
      );

      if (this.config.tradingMode === "shadow") {
        return this.record({
          intentId: intent.intentId,
          status: "shadowed",
          code: "entry_verified_not_submitted",
          detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)};stop_ticks=${validated.stopTicks};target_ticks=${validated.targetTicks}`,
        });
      }

      const orderId = await this.api.placeOrder({
        accountId: validated.account.id,
        contractId: validated.contract.id,
        type: 2,
        side: intent.action === "ENTER_LONG" ? 0 : 1,
        size: intent.quantity ?? 0,
        customTag: validated.customTag,
        stopLossBracket: { ticks: validated.stopTicks, type: 4 },
        takeProfitBracket: { ticks: validated.targetTicks, type: 1 },
      });
      return this.record({
        intentId: intent.intentId,
        status: "submitted",
        code: "entry_submitted_with_provider_brackets",
        orderId,
        detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)}`,
      });
    } catch (error) {
      const code = error instanceof RiskRejectedError ? error.code : "execution_failed";
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleExit(
    intent: TradeIntent,
    issuedPacket: DirectDecisionPacket,
  ): Promise<ExecutionReceipt> {
    const snapshot = this.snapshot();
    if (intent.account !== this.config.scope.accountName) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "account_name_mismatch",
      });
    }
    if (intent.snapshotHash !== issuedPacket.market.snapshot_hash) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "snapshot_hash_mismatch",
      });
    }
    if (snapshot.instrumentOpenContracts === 0) {
      return this.record({
        intentId: intent.intentId,
        status: "ignored",
        code: "position_already_flat",
      });
    }
    if (this.config.tradingMode === "shadow") {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: "exit_verified_not_submitted",
      });
    }
    await this.api.closePosition(this.config.scope.accountId, this.config.scope.contractId);
    return this.record({
      intentId: intent.intentId,
      status: "closed",
      code: "close_contract_submitted",
    });
  }

  private async record(input: {
    intentId: string | null;
    status: ExecutionReceipt["status"];
    code: string;
    orderId?: number;
    detail?: string;
  }): Promise<ExecutionReceipt> {
    const receipt: ExecutionReceipt = {
      schema_version: "glitch.direct.execution_receipt.v1",
      receipt_id: randomUUID(),
      recorded_utc: new Date().toISOString(),
      intent_id: input.intentId,
      mode: this.config.tradingMode,
      status: input.status,
      code: input.code,
      ...(input.orderId === undefined ? {} : { order_id: input.orderId }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    await this.ledger.append({
      schema_version: "glitch.direct.event.v1",
      event_id: receipt.receipt_id,
      recorded_utc: receipt.recorded_utc,
      event: "execution_receipt",
      payload: receipt,
    });
    return receipt;
  }
}
