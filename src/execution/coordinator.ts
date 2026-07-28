import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { parseTradeIntent } from "../domain/intents.js";
import type { AccountVenueSnapshot, TradeIntent } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import {
  type PlaceOrderRequest,
  ProjectXApiClient,
  ProjectXApiError,
} from "../projectx/client.js";
import { RiskRejectedError, validateEntryRisk } from "../risk/risk-engine.js";
import { JsonlEventStore } from "../storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

export interface ExecutionReceipt {
  schema_version: "glitch.direct.execution_receipt.v1";
  receipt_id: string;
  recorded_utc: string;
  intent_id: string | null;
  mode: "disabled" | "shadow" | "armed";
  status: "rejected" | "shadowed" | "submitted" | "closed" | "ignored" | "ambiguous";
  code: string;
  order_id?: number;
  detail?: string;
}

export class ExecutionCoordinator {
  private executionQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly config: AppConfig,
    private readonly api: ProjectXApiClient,
    private readonly ledger: JsonlEventStore,
    private readonly store: SqliteExecutionStore,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly resolveIssuedPacket: (snapshotHash: string) => DirectDecisionPacket | null,
    private readonly invalidateIssuedPackets: () => void,
  ) {}

  public handleWireIntent(input: unknown): Promise<ExecutionReceipt> {
    const result = this.executionQueue.then(() => this.handleWireIntentSerial(input));
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async handleWireIntentSerial(input: unknown): Promise<ExecutionReceipt> {
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

    const receivedUtc = new Date().toISOString();
    const registration = this.store.registerIntent(intent, receivedUtc);
    if (registration.status === "conflict") {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "intent_body_conflict",
        detail: "The same intent_id was already registered with a different body hash.",
      });
    }
    if (registration.status === "duplicate") {
      const existing = this.store.receiptForIntent<ExecutionReceipt>(intent.intentId);
      return existing ?? this.ephemeral({
        intentId: intent.intentId,
        status: "ambiguous",
        code: "intent_already_processing_or_recovery_required",
      });
    }

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

    const recovery = this.store.recoveryStatus();
    if (recovery.blockingNewExposure) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: recovery.blockingAmbiguity
          ? "execution_recovery_required"
          : "entry_submission_pending",
        detail: recovery.blockingAmbiguity
          ? "A prior ProjectX mutation remains ambiguous; new exposure is blocked until provider reconciliation proves its outcome."
          : "A prior entry submission has not yet appeared in authoritative ProjectX order or position state.",
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

      const request: PlaceOrderRequest = {
        accountId: validated.account.id,
        contractId: validated.contract.id,
        type: 2,
        side: intent.action === "ENTER_LONG" ? 0 : 1,
        size: intent.quantity ?? 0,
        customTag: validated.customTag,
        stopLossBracket: { ticks: validated.stopTicks, type: 4 },
        takeProfitBracket: { ticks: validated.targetTicks, type: 1 },
      };
      this.store.prepareMutation(
        intent.intentId,
        "place_order",
        request as unknown as Record<string, unknown>,
        validated.customTag,
        new Date().toISOString(),
      );
      this.invalidateIssuedPackets();
      this.store.markMutationSubmitting(intent.intentId, new Date().toISOString());

      try {
        const orderId = await this.api.placeOrder(request);
        this.store.markMutationSubmitted(intent.intentId, orderId, new Date().toISOString());
        return this.record({
          intentId: intent.intentId,
          status: "submitted",
          code: "entry_submitted_with_provider_brackets",
          orderId,
          detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)}`,
        });
      } catch (error) {
        return this.recordMutationFailure(intent.intentId, error);
      }
    } catch (error) {
      const code = error instanceof RiskRejectedError
        ? error.code
        : error instanceof Error && error.message.startsWith("entry_submission_pending:")
          ? "entry_submission_pending"
          : "execution_preparation_failed";
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

    const request = {
      accountId: this.config.scope.accountId,
      contractId: this.config.scope.contractId,
    };
    this.store.prepareMutation(
      intent.intentId,
      "close_position",
      request,
      null,
      new Date().toISOString(),
    );
    this.invalidateIssuedPackets();
    this.store.markMutationSubmitting(intent.intentId, new Date().toISOString());
    try {
      await this.api.closePosition(request.accountId, request.contractId);
      this.store.markMutationSubmitted(intent.intentId, null, new Date().toISOString());
      return this.record({
        intentId: intent.intentId,
        status: "closed",
        code: "close_contract_submitted",
      });
    } catch (error) {
      return this.recordMutationFailure(intent.intentId, error);
    }
  }

  private async recordMutationFailure(
    intentId: string,
    error: unknown,
  ): Promise<ExecutionReceipt> {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    if (this.isAuthoritativeRejection(error)) {
      this.store.markMutationRejected(intentId, detail, new Date().toISOString());
      this.invalidateIssuedPackets();
      return this.record({
        intentId,
        status: "rejected",
        code: "projectx_mutation_rejected",
        detail,
      });
    }

    this.store.markMutationAmbiguous(intentId, detail, new Date().toISOString());
    return this.record({
      intentId,
      status: "ambiguous",
      code: "projectx_mutation_outcome_ambiguous",
      detail,
    });
  }

  private isAuthoritativeRejection(error: unknown): boolean {
    return error instanceof ProjectXApiError
      && (error.code.startsWith("projectx_") || error.code === "not_authenticated");
  }

  private ephemeral(input: {
    intentId: string | null;
    status: ExecutionReceipt["status"];
    code: string;
    detail?: string;
  }): ExecutionReceipt {
    return {
      schema_version: "glitch.direct.execution_receipt.v1",
      receipt_id: randomUUID(),
      recorded_utc: new Date().toISOString(),
      intent_id: input.intentId,
      mode: this.config.tradingMode,
      status: input.status,
      code: input.code,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
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
    this.store.recordReceipt({ ...receipt });
    try {
      await this.ledger.append({
        schema_version: "glitch.direct.event.v1",
        event_id: receipt.receipt_id,
        recorded_utc: receipt.recorded_utc,
        event: "execution_receipt",
        payload: receipt,
      });
    } catch (error) {
      console.error("SQLite receipt committed but JSONL evidence mirror failed", error);
    }
    return receipt;
  }
}
