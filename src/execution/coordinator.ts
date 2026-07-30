import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { parseTradeIntent } from "../domain/intents.js";
import type { AccountVenueSnapshot, TradeIntent } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import {
  bindProtection,
  intentIdFromStopTag,
  type ResolvedProtection,
} from "../ownership/protection.js";
import type { TrancheView } from "../ownership/tranches.js";
import {
  type ModifyOrderRequest,
  type PlaceOrderRequest,
  ProjectXApiClient,
  ProjectXApiError,
} from "../projectx/client.js";
import { RiskRejectedError, validateEntryRisk } from "../risk/risk-engine.js";
import { gatewayModePermitsLiveOrders } from "./gateway-mode.js";
import { isTickAligned, toProjectXBracketTicks } from "./brackets.js";
import { JsonlEventStore } from "../storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

export interface ExecutionReceipt {
  schema_version: "glitch.direct.execution_receipt.v1";
  receipt_id: string;
  recorded_utc: string;
  intent_id: string | null;
  mode: "disabled" | "shadow" | "armed";
  status: "rejected" | "shadowed" | "pending" | "submitted" | "open_protected" | "closed" | "ignored" | "ambiguous";
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
    private readonly tranches: () => TrancheView[] = () => [],
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

    const issuedPacket = intent.action === "NOTHING" || intent.action === "HOLD"
      ? null
      : this.resolveIssuedPacket(intent.snapshotHash);
    if (issuedPacket === null && intent.action !== "NOTHING" && intent.action !== "HOLD") {
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

    if (!issuedPacket) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "decision_packet_unknown_or_expired",
      });
    }

    if (intent.action === "EXIT") {
      return this.handleExit(intent, issuedPacket);
    }

    if (intent.action === "MOVE_STOP") {
      return this.handleMoveStop(intent, issuedPacket);
    }

    if (intent.action === "MOVE_TP") {
      return this.handleMoveTp(intent, issuedPacket);
    }

    if (intent.action !== "ENTER_LONG" && intent.action !== "ENTER_SHORT") {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "action_not_implemented",
        detail: `Unsupported action: ${intent.action}`,
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

      if (!gatewayModePermitsLiveOrders(issuedPacket.execution.gateway_mode)) {
        return this.record({
          intentId: intent.intentId,
          status: "shadowed",
          code: "entry_verified_not_submitted",
          detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)};stop_ticks=${validated.stopTicks};target_ticks=${validated.targetTicks}`,
        });
      }

      if (this.config.tradingMode === "shadow") {
        return this.record({
          intentId: intent.intentId,
          status: "shadowed",
          code: "entry_verified_not_submitted",
          detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)};stop_ticks=${validated.stopTicks};target_ticks=${validated.targetTicks}`,
        });
      }

      const side = intent.action === "ENTER_LONG" ? "long" : "short";
      const projectXBrackets = toProjectXBracketTicks(side, {
        stopTicks: validated.stopTicks,
        targetTicks: validated.targetTicks,
      });
      const request: PlaceOrderRequest = {
        accountId: validated.account.id,
        contractId: validated.contract.id,
        type: 2,
        side: intent.action === "ENTER_LONG" ? 0 : 1,
        size: validated.quantity,
        customTag: validated.customTag,
        stopLossBracket: { ticks: projectXBrackets.stopTicks, type: 4 },
        takeProfitBracket: { ticks: projectXBrackets.targetTicks, type: 1 },
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
        try {
          this.store.noteMutationProviderOrderId(intent.intentId, orderId);
        } catch {
          // ponytail: recovery can race submitting->ambiguous while placeOrder is in flight
        }
        this.store.markMutationSubmitted(intent.intentId, orderId, new Date().toISOString());
        return this.record({
          intentId: intent.intentId,
          status: "pending",
          code: "entry_submitted_pending_reconciliation",
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
    if (!gatewayModePermitsLiveOrders(issuedPacket.execution.gateway_mode)) {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: "exit_verified_not_submitted",
      });
    }
    if (this.config.tradingMode === "shadow") {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: "exit_verified_not_submitted",
      });
    }

    const contractPositions = snapshot.positions.filter(
      (candidate) => candidate.accountId === this.config.scope.accountId
        && candidate.contractId === this.config.scope.contractId
        && candidate.type !== 0
        && Math.abs(candidate.size) > 0,
    );
    if (contractPositions.length === 0) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "position_not_found",
      });
    }
    const position = contractPositions[0]!;
    const positionSize = snapshot.instrumentOpenContracts;
    let exitQuantity = intent.quantity
      ?? (intent.exitFraction !== undefined
        ? Math.max(1, Math.min(positionSize, Math.round(positionSize * intent.exitFraction)))
        : positionSize);

    if (intent.targetIntentId !== undefined) {
      const tranche = this.tranches().find((candidate) => candidate.intent_id === intent.targetIntentId);
      if (!tranche || tranche.filled_qty <= 0) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: "target_tranche_not_found",
          detail: intent.targetIntentId,
        });
      }
      const attributableQty = tranche.remaining_qty > 0
        ? tranche.remaining_qty
        : Math.min(tranche.filled_qty, positionSize);
      if (attributableQty <= 0) {
        return this.record({
          intentId: intent.intentId,
          status: "ignored",
          code: "target_tranche_already_flat",
          detail: intent.targetIntentId,
        });
      }
      if (intent.quantity === undefined && intent.exitFraction === undefined) {
        exitQuantity = attributableQty;
      } else if (exitQuantity > attributableQty) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: "exit_quantity_exceeds_tranche_remaining",
          detail: `requested=${exitQuantity};tranche_remaining=${attributableQty}`,
        });
      }
    } else if (
      intent.quantity !== undefined
      && intent.quantity < positionSize
      && this.tranches().length > 0
    ) {
      const fifoRemaining = this.tranches()
        .filter((candidate) => candidate.remaining_qty > 0)
        .reduce((total, candidate) => total + candidate.remaining_qty, 0);
      if (exitQuantity > fifoRemaining) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: "exit_quantity_exceeds_attributable_remaining",
          detail: `requested=${exitQuantity};attributable_remaining=${fifoRemaining}`,
        });
      }
    }

    if (!Number.isInteger(exitQuantity) || exitQuantity < 1 || exitQuantity > positionSize) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "exit_quantity_invalid",
        detail: `requested=${exitQuantity};position=${positionSize}`,
      });
    }

    const partialExit = exitQuantity < positionSize;
    if (partialExit && intent.targetIntentId !== undefined) {
      const cancelError = await this.cancelTrancheProtectionOrders(snapshot, intent);
      if (cancelError) {
        return cancelError;
      }
    }
    const request = partialExit
      ? {
          accountId: this.config.scope.accountId,
          contractId: this.config.scope.contractId,
          type: 2,
          side: position.size > 0 ? 1 : 0,
          size: exitQuantity,
          customTag: `glt-${intent.intentId}`.slice(0, 64),
        }
      : {
          accountId: this.config.scope.accountId,
          contractId: this.config.scope.contractId,
        };
    this.store.prepareMutation(
      intent.intentId,
      partialExit ? "place_order" : "close_position",
      request,
      partialExit ? `glt-${intent.intentId}`.slice(0, 64) : null,
      new Date().toISOString(),
    );
    this.invalidateIssuedPackets();
    this.store.markMutationSubmitting(intent.intentId, new Date().toISOString());
    try {
      if (partialExit) {
        const orderId = await this.api.placeOrder(request as PlaceOrderRequest);
        try {
          this.store.noteMutationProviderOrderId(intent.intentId, orderId);
        } catch {
          // ponytail: recovery can race submitting->ambiguous while placeOrder is in flight
        }
        this.store.markMutationSubmitted(intent.intentId, orderId, new Date().toISOString());
        return this.record({
          intentId: intent.intentId,
          status: "pending",
          code: "partial_exit_submitted_pending_reconciliation",
          orderId,
          detail: `exit_quantity=${exitQuantity};remaining=${positionSize - exitQuantity}`,
        });
      }
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

  private async handleMoveStop(
    intent: TradeIntent,
    issuedPacket: DirectDecisionPacket,
  ): Promise<ExecutionReceipt> {
    return this.handleProtectiveAmendment(intent, issuedPacket, "stop");
  }

  private async handleMoveTp(
    intent: TradeIntent,
    issuedPacket: DirectDecisionPacket,
  ): Promise<ExecutionReceipt> {
    return this.handleProtectiveAmendment(intent, issuedPacket, "target");
  }

  private async handleProtectiveAmendment(
    intent: TradeIntent,
    issuedPacket: DirectDecisionPacket,
    leg: "stop" | "target",
  ): Promise<ExecutionReceipt> {
    const snapshot = this.snapshot();
    const validation = await this.validateAmendmentIntent(intent, issuedPacket, snapshot);
    if (validation) {
      return validation;
    }

    const attributableTranches = this.attributableTranches(snapshot);
    if (intent.targetIntentId === undefined && attributableTranches.length > 1) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "target_intent_id_required",
      });
    }

    const active = this.resolveActiveProtection(snapshot, intent);
    if (!active) {
      if (intent.targetIntentId !== undefined) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: "target_tranche_not_found",
          detail: intent.targetIntentId,
        });
      }
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "protection_not_proven",
        detail: "no_active_protection",
      });
    }
    if (active.protection.status !== "proven") {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "protection_not_proven",
        detail: active.protection.reason,
      });
    }

    const protectiveLeg = leg === "stop" ? active.protection.stop : active.protection.target;
    const newPrice = leg === "stop" ? intent.newStopPrice : intent.takeProfit1;
    if (newPrice === undefined) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: leg === "stop" ? "new_stop_price_missing" : "new_take_profit_missing",
      });
    }
    if (!isTickAligned(newPrice, snapshot.contract.tickSize)) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: leg === "stop" ? "new_stop_not_tick_aligned" : "new_target_not_tick_aligned",
      });
    }
    if (protectiveLeg.providerOrderId === null) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "protective_leg_unresolved",
      });
    }

    if (!gatewayModePermitsLiveOrders(issuedPacket.execution.gateway_mode)) {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: leg === "stop" ? "move_stop_verified_not_submitted" : "move_tp_verified_not_submitted",
        detail: `new_price=${newPrice}`,
      });
    }
    if (this.config.tradingMode === "shadow") {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: leg === "stop" ? "move_stop_verified_not_submitted" : "move_tp_verified_not_submitted",
        detail: `new_price=${newPrice}`,
      });
    }

    const request: ModifyOrderRequest = {
      accountId: this.config.scope.accountId,
      orderId: protectiveLeg.providerOrderId,
      ...(leg === "stop" ? { stopPrice: newPrice } : { limitPrice: newPrice }),
    };
    this.store.prepareMutation(
      intent.intentId,
      "modify_order",
      request as unknown as Record<string, unknown>,
      protectiveLeg.customTag,
      new Date().toISOString(),
    );
    this.invalidateIssuedPackets();
    this.store.markMutationSubmitting(intent.intentId, new Date().toISOString());
    try {
      await this.api.modifyOrder(request);
      this.store.markMutationSubmitted(intent.intentId, protectiveLeg.providerOrderId, new Date().toISOString());
      return this.record({
        intentId: intent.intentId,
        status: "pending",
        code: leg === "stop" ? "move_stop_submitted_pending_reconciliation" : "move_tp_submitted_pending_reconciliation",
        orderId: protectiveLeg.providerOrderId,
        detail: `new_price=${newPrice}`,
      });
    } catch (error) {
      return this.recordMutationFailure(intent.intentId, error);
    }
  }

  private async validateAmendmentIntent(
    intent: TradeIntent,
    issuedPacket: DirectDecisionPacket,
    snapshot: AccountVenueSnapshot,
  ): Promise<ExecutionReceipt | null> {
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
    if (!issuedPacket.execution.supported_actions.includes(intent.action)) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "action_not_supported_in_current_packet",
      });
    }
    return null;
  }

  private attributableTranches(snapshot: AccountVenueSnapshot): TrancheView[] {
    const all = this.tranches();
    const open = all.filter((tranche) => tranche.remaining_qty > 0);
    if (open.length > 0) {
      return open;
    }
    if (snapshot.instrumentOpenContracts > 0) {
      return all.filter((tranche) => tranche.filled_qty > 0);
    }
    return open;
  }

  private async cancelTrancheProtectionOrders(
    snapshot: AccountVenueSnapshot,
    intent: TradeIntent,
  ): Promise<ExecutionReceipt | null> {
    const active = this.resolveActiveProtection(snapshot, intent);
    if (!active) {
      return null;
    }
    for (const leg of [active.protection.stop, active.protection.target]) {
      if (leg.providerOrderId === null) {
        continue;
      }
      try {
        await this.api.cancelOrder(this.config.scope.accountId, leg.providerOrderId);
      } catch (error) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: "protection_cancel_failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  }

  private resolveActiveProtection(
    snapshot: AccountVenueSnapshot,
    intent?: TradeIntent,
  ): { intentId: string; protection: ResolvedProtection } | null {
    const allTranches = this.tranches();
    const attributableTranches = this.attributableTranches(snapshot);

    const positionOpen = snapshot.instrumentOpenContracts > 0;

    if (intent?.targetIntentId !== undefined) {
      const tranche = allTranches.find((candidate) => candidate.intent_id === intent.targetIntentId);
      if (!tranche || tranche.filled_qty <= 0) {
        return null;
      }
      return {
        intentId: tranche.intent_id,
        protection: bindProtection(
          tranche.intent_id,
          snapshot.openOrders,
          this.config.scope.accountId,
          this.config.scope.contractId,
          positionOpen,
        ),
      };
    }

    if (attributableTranches.length === 1) {
      const tranche = attributableTranches[0]!;
      return {
        intentId: tranche.intent_id,
        protection: bindProtection(
          tranche.intent_id,
          snapshot.openOrders,
          this.config.scope.accountId,
          this.config.scope.contractId,
          positionOpen,
        ),
      };
    }

    if (attributableTranches.length > 1) {
      return null;
    }

    const intentId = snapshot.openOrders
      .map((order) => (order.customTag ? intentIdFromStopTag(order.customTag) : null))
      .find((candidate) => candidate !== null);
    if (!intentId) {
      return null;
    }
    return {
      intentId,
      protection: bindProtection(
        intentId,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        true,
      ),
    };
  }

  private async recordMutationFailure(
    intentId: string,
    error: unknown,
  ): Promise<ExecutionReceipt> {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const mutation = this.store.mutationForIntent(intentId);
    if (mutation?.state === "submitted") {
      return this.recordSubmittedMutationReceipt(intentId, mutation, detail);
    }
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

  private async recordSubmittedMutationReceipt(
    intentId: string,
    mutation: NonNullable<ReturnType<SqliteExecutionStore["mutationForIntent"]>>,
    detail: string,
  ): Promise<ExecutionReceipt> {
    if (mutation.operation === "close_position") {
      return this.record({
        intentId,
        status: "closed",
        code: "close_contract_submitted",
        detail,
      });
    }
    if (mutation.operation === "modify_order") {
      const leg = typeof mutation.request.stopPrice === "number" ? "stop" : "target";
      return this.record({
        intentId,
        status: "pending",
        code: leg === "stop"
          ? "move_stop_submitted_pending_reconciliation"
          : "move_tp_submitted_pending_reconciliation",
        orderId: mutation.providerOrderId ?? undefined,
        detail,
      });
    }
    return this.record({
      intentId,
      status: "pending",
      code: mutation.operation === "place_order"
        ? "partial_exit_submitted_pending_reconciliation"
        : "entry_submitted_pending_reconciliation",
      orderId: mutation.providerOrderId ?? undefined,
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
