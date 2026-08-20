import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { parseTradeIntent, IntentParseError } from "../domain/intents.js";
import type { AccountVenueSnapshot, TradeIntent, TradingMode } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import {
  bindProtection,
  intentIdFromStopTag,
  lastProtectivePriceForIntent,
  latestOrderById,
  nextUnusedProtectionGeneration,
  parseProtectiveTag,
  protectionCustomTags,
  sanitizeRearmProtectionPrices,
  type ResolvedProtection,
} from "../ownership/protection.js";
import { isProtectiveCustomTag, scaleInActionForPosition } from "../ownership/scale-in.js";
import type { TrancheView } from "../ownership/tranches.js";
import {
  type ModifyOrderRequest,
  type PlaceOrderRequest,
  ProjectXApiClient,
  ProjectXApiError,
} from "../projectx/client.js";
import { RiskRejectedError, validateEntryRisk } from "../risk/risk-engine.js";
import { validateProtectiveAmendment } from "./amendment-safety.js";
import { instrumentNetSignedLots, sumInstrumentNetContracts } from "../state/venue-state.js";
import {
  gatewayModePermitsLiveOrders,
  gatewayModePermitsRiskReduction,
} from "./gateway-mode.js";
import { maybeKill } from "./kill-hook.js";
import {
  partialExitFailClosedEnabled,
  type ProtectedReductionHealth,
} from "./protected-reduction-saga.js";
import { isTickAligned, toProjectXBracketTicks } from "./brackets.js";
import { JsonlEventStore } from "../storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import { evaluatePortfolioAdmission, type ProtectedExposure } from "../risk/portfolio-risk.js";
import { validatePortfolioSelection } from "../risk/portfolio-selection.js";
import type { InstrumentUniverse } from "../domain/instrument-universe.js";

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
  field?: string;
  error?: string;
  path?: string;
  /** ISO timestamp when an open position was first observed for this entry. */
  fill_observed_utc?: string;
}

const STOP_ORDER_TYPE = 4;

/**
 * Worst-case stop distance in ticks for one contract, read from the stop orders actually
 * resting at the venue. Returns null when no stop geometry is observable, which forces the
 * caller to treat that position as unprotected.
 */
function observedStopDistanceTicks(
  snapshot: AccountVenueSnapshot,
  contractId: string,
  tickSize: number,
): number | null {
  if (!(tickSize > 0)) {
    return null;
  }
  const stops = snapshot.openOrders.filter((order) => (
    order.contractId === contractId && order.type === STOP_ORDER_TYPE && order.stopPrice !== null
  ));
  const legs = snapshot.positions.filter((position) => (
    position.contractId === contractId && position.type !== 0 && position.size !== 0
  ));
  if (stops.length === 0 || legs.length === 0) {
    return null;
  }
  const worst = Math.max(...legs.flatMap((leg) => stops.map(
    (stop) => Math.abs(leg.averagePrice - stop.stopPrice!) / tickSize,
  )));
  return worst > 0 ? Math.ceil(worst) : null;
}

export class ExecutionCoordinator {
  private executionQueue: Promise<void> = Promise.resolve();
  /** ponytail: in-memory latch; restart clears and may re-place once per tranche */
  private readonly rearmLatched = new Set<string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly api: ProjectXApiClient,
    private readonly ledger: JsonlEventStore,
    private readonly store: SqliteExecutionStore,
    private readonly snapshot: () => AccountVenueSnapshot,
    private readonly resolveIssuedPacket: (snapshotHash: string) => DirectDecisionPacket | null,
    private readonly invalidateIssuedPackets: () => void,
    private readonly tranches: () => TrancheView[] = () => [],
    private readonly controlState: () => { paused: boolean; mode: TradingMode } = () => ({
      paused: false,
      mode: config.tradingMode,
    }),
    private readonly dailyCaptureLocked: () => boolean = () => false,
    private readonly instrumentUniverse: () => InstrumentUniverse | null = () => null,
  ) {}

  private currentMode(): TradingMode {
    return this.controlState().mode;
  }

  /**
   * Account-wide exposure that already exists when a new entry is admitted. Exposure whose
   * stop geometry or tick economics we cannot observe is reported as unprotected instead of
   * being priced at zero, so admission stays fail-closed rather than optimistic.
   */
  private existingProtectedExposure(
    snapshot: AccountVenueSnapshot,
    universe: InstrumentUniverse | null,
    packet: DirectDecisionPacket,
    candidateStopTicks: number,
  ): { existing: ProtectedExposure[]; unprotected: boolean } {
    const existing: ProtectedExposure[] = [];
    let unprotected = false;
    const openContractIds = new Set(
      snapshot.positions
        .filter((position) => position.type !== 0 && position.size !== 0)
        .map((position) => position.contractId),
    );
    for (const contractId of openContractIds) {
      const quantity = sumInstrumentNetContracts(snapshot.positions, contractId);
      if (quantity < 1) {
        continue;
      }
      const own = contractId === this.config.scope.contractId;
      // Same-contract size is admissible only where ownership already proved protection;
      // scale-in itself is gated earlier by validateScaleIn.
      if (own && packet.protection.status !== "proven") {
        unprotected = true;
        continue;
      }
      const economics = own
        ? { tick_size: snapshot.contract.tickSize, tick_value: snapshot.contract.tickValue }
        : universe?.contracts.find((candidate) => candidate.contract_id === contractId);
      const observedTicks = economics
        ? observedStopDistanceTicks(snapshot, contractId, economics.tick_size)
        : null;
      const stopTicks = own
        ? Math.max(candidateStopTicks, observedTicks ?? 0)
        : observedTicks;
      if (!economics || stopTicks === null) {
        unprotected = true;
        continue;
      }
      existing.push({
        contract_id: contractId,
        quantity,
        stop_distance_ticks: stopTicks,
        tick_value: economics.tick_value,
        fees_usd: this.config.risk.estimatedRoundTurnFeesUsd,
        slippage_ticks: this.config.risk.slippageReserveTicks,
      });
    }
    // A working order on a contract that carries no open position is exposure we cannot size.
    const unsizedWorkingOrder = snapshot.openOrders.some(
      (order) => !openContractIds.has(order.contractId),
    );
    return { existing, unprotected: unprotected || unsizedWorkingOrder };
  }

  public handleWireIntent(input: unknown): Promise<ExecutionReceipt> {
    const result = this.executionQueue.then(() => this.handleWireIntentSerial(input));
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Waits for work already queued to settle; new work queued after this call is not awaited. */
  public async drainExecutionQueue(): Promise<void> {
    await this.executionQueue;
  }

  public receiptForIntent(intentId: string): ExecutionReceipt | null {
    return this.store.receiptForIntent<ExecutionReceipt>(intentId);
  }

  private async handleWireIntentSerial(input: unknown): Promise<ExecutionReceipt> {
    let intent: TradeIntent;
    try {
      intent = parseTradeIntent(input);
    } catch (error) {
      if (error instanceof IntentParseError) {
        return this.record({
          intentId: null,
          status: "rejected",
          code: "intent_schema_invalid",
          detail: error.message,
          field: error.field,
          error: error.errorCode,
          path: error.path,
        });
      }
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
    this.store.recordExecutionFact({
      intentId: intent.intentId,
      phase: "intent_admitted",
      recordedUtc: receivedUtc,
      detail: {
        action: intent.action,
        decision_latency_ms: Math.max(0, Date.parse(receivedUtc) - Date.parse(intent.createdUtc)),
      },
    });

    maybeKill("after_intent_before_outbox");

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

    if (this.currentMode() === "disabled") {
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

    if (this.controlState().paused) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "new_exposure_paused_by_operator",
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
          expectedPacketId: issuedPacket.packet_id,
          expectedContractId: issuedPacket.contract.id,
          expectedScopeHash: issuedPacket.decision_scope.scope_hash,
          expectedScopeGeneration: issuedPacket.decision_scope.generation,
          dailyCaptureLocked: issuedPacket.execution.daily_capture_locked || this.dailyCaptureLocked(),
          armedMode: this.currentMode() === "armed",
        },
      );

      const foreignExposure = currentSnapshot.positions.some(
        (position) => position.contractId !== this.config.scope.contractId,
      ) || currentSnapshot.openOrders.some(
        (order) => order.contractId !== this.config.scope.contractId,
      );
      const resolvedUniverse = this.instrumentUniverse();
      if (resolvedUniverse) {
        const selection = validatePortfolioSelection({
          universe: resolvedUniverse,
          selected_contract_id: this.config.scope.contractId,
          open_contract_ids: [
            ...currentSnapshot.positions.map((position) => position.contractId),
            ...currentSnapshot.openOrders.map((order) => order.contractId),
          ],
          simultaneous_exposure_enabled: this.config.multiInstrument?.simultaneousExposureEnabled ?? false,
        });
        if (!selection.allowed) {
          return this.record({
            intentId: intent.intentId,
            status: "rejected",
            code: selection.code,
            detail: `selected_contract_id=${selection.selected_contract_id};selected_instrument=${selection.selected_instrument ?? "unknown"}`,
          });
        }
      }
      const existingExposure = this.existingProtectedExposure(
        currentSnapshot,
        resolvedUniverse,
        issuedPacket,
        validated.stopTicks,
      );
      const portfolio = evaluatePortfolioAdmission({
        hard_loss_buffer_usd: validated.riskBudget.currentBuffer,
        existing: existingExposure.existing,
        pending: [],
        candidate: {
          contract_id: validated.contract.id,
          quantity: validated.quantity,
          stop_distance_ticks: validated.stopTicks,
          tick_value: validated.contract.tickValue,
          fees_usd: this.config.risk.estimatedRoundTurnFeesUsd,
          slippage_ticks: this.config.risk.slippageReserveTicks,
        },
        simultaneous_exposure_enabled: this.config.multiInstrument?.simultaneousExposureEnabled ?? false,
        foreign_exposure_present: foreignExposure,
        unprotected_existing_exposure: existingExposure.unprotected,
      });
      if (!portfolio.allowed) {
        return this.record({
          intentId: intent.intentId,
          status: "rejected",
          code: portfolio.code,
          detail: `protected_downside_usd=${portfolio.protected_downside_usd.toFixed(2)};remaining_buffer_usd=${portfolio.remaining_buffer_usd.toFixed(2)}`,
        });
      }

      if (!gatewayModePermitsLiveOrders(issuedPacket.execution.gateway_mode)) {
        return this.record({
          intentId: intent.intentId,
          status: "shadowed",
          code: "entry_verified_not_submitted",
          detail: `protected_risk_usd=${validated.riskUsd.toFixed(2)};hard_buffer_usd=${validated.riskBudget.currentBuffer.toFixed(2)};stop_ticks=${validated.stopTicks};target_ticks=${validated.targetTicks}`,
        });
      }

      if (this.currentMode() === "shadow") {
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
      maybeKill("after_prepared_before_provider");
      this.store.markMutationSubmitting(intent.intentId, new Date().toISOString());
      maybeKill("after_submitting_before_transport");

      try {
        const orderId = await this.api.placeOrder(request);
        try {
          this.store.noteMutationProviderOrderId(intent.intentId, orderId);
        } catch {
          // ponytail: recovery can race submitting->ambiguous while placeOrder is in flight
        }
        maybeKill("after_accept_before_submitted");
        this.store.markMutationSubmitted(intent.intentId, orderId, new Date().toISOString());
        maybeKill("after_submitted_before_receipt");
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
    if (!gatewayModePermitsRiskReduction(issuedPacket.execution.gateway_mode)) {
      return this.record({
        intentId: intent.intentId,
        status: "shadowed",
        code: "exit_verified_not_submitted",
      });
    }
    if (this.currentMode() === "shadow") {
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
    const netSignedLots = instrumentNetSignedLots(contractPositions, this.config.scope.contractId);
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
      const attributableQty = tranche.remaining_qty;
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
    // ponytail: armed default admits partial EXIT via ProtectedReductionSaga (#109).
    // Emergency rollback: GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1 restores the old gate.
    if (partialExit && this.currentMode() === "armed" && partialExitFailClosedEnabled()) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "partial_exit_protection_transition_unproven",
        detail: "Armed partial EXIT fail-closed via GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1 rollback switch.",
      });
    }

    const survivorTranches = this.attributableTranches().filter(
      (tranche) => tranche.intent_id !== intent.targetIntentId && tranche.remaining_qty > 0,
    );
    const survivorProtection = survivorTranches.length === 1
      ? bindProtection(
        survivorTranches[0]!.intent_id,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        true,
        survivorTranches[0]!.entry_order_id,
      )
      : null;
    const nowUtc = new Date().toISOString();
    if (partialExit) {
      this.store.beginProtectedReduction({
        reductionId: randomUUID(),
        exitIntentId: intent.intentId,
        targetIntentId: intent.targetIntentId ?? null,
        accountId: this.config.scope.accountId,
        contractId: this.config.scope.contractId,
        exitQuantity,
        positionSizeBefore: positionSize,
        survivorStopOrderId: survivorProtection?.stop.providerOrderId ?? null,
        survivorTargetOrderId: survivorProtection?.target.providerOrderId ?? null,
        nowUtc,
      });
      maybeKill("reduction_after_prepared");
      this.store.advanceProtectedReduction(
        intent.intentId,
        "reduction_submitting",
        "prepared_to_submitting",
        new Date().toISOString(),
      );
    }

    // Cancel only the exited tranche brackets. Never cancel the last proven survivor stop
    // before the reduction (or a substitute stop) is on the wire.
    if (partialExit && intent.targetIntentId !== undefined) {
      const cancelError = await this.cancelTrancheProtectionOrders(snapshot, intent);
      if (cancelError) {
        this.store.advanceProtectedReduction(
          intent.intentId,
          "failed",
          "protection_cancel_failed",
          new Date().toISOString(),
          { detail: cancelError.detail ?? cancelError.code },
        );
        return cancelError;
      }
      maybeKill("reduction_after_cancel_before_place");
    }
    const request = partialExit
      ? {
          accountId: this.config.scope.accountId,
          contractId: this.config.scope.contractId,
          type: 2,
          side: netSignedLots > 0 ? 1 : 0,
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
        maybeKill("reduction_after_place_before_mark");
        try {
          this.store.noteMutationProviderOrderId(intent.intentId, orderId);
        } catch {
          // ponytail: recovery can race submitting->ambiguous while placeOrder is in flight
        }
        this.store.markMutationSubmitted(intent.intentId, orderId, new Date().toISOString());
        this.store.advanceProtectedReduction(
          intent.intentId,
          "reduction_ambiguous",
          "exit_submitted_pending_survivor_proof",
          new Date().toISOString(),
          { providerExitOrderId: orderId },
        );
        return this.record({
          intentId: intent.intentId,
          status: "pending",
          code: "partial_exit_submitted_pending_reconciliation",
          orderId,
          detail: `exit_quantity=${exitQuantity};remaining=${positionSize - exitQuantity}`,
        });
      }
      maybeKill("during_close_position");
      await this.api.closePosition(request.accountId, request.contractId);
      this.store.markMutationSubmitted(intent.intentId, null, new Date().toISOString());
      return this.record({
        intentId: intent.intentId,
        status: "closed",
        code: "close_contract_submitted",
      });
    } catch (error) {
      if (partialExit) {
        try {
          this.store.advanceProtectedReduction(
            intent.intentId,
            "failed",
            "provider_partial_exit_failed",
            new Date().toISOString(),
            { detail: error instanceof Error ? error.message : String(error) },
          );
        } catch {
          // saga row may be absent if begin failed earlier
        }
      }
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

    const attributableTranches = this.attributableTranches();
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
    const position = snapshot.positions.find(
      (candidate) => candidate.accountId === this.config.scope.accountId
        && candidate.contractId === this.config.scope.contractId
        && candidate.type !== 0
        && Math.abs(candidate.size) > 0,
    );
    const scaleInAction = position ? scaleInActionForPosition(position) : null;
    if (!scaleInAction) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: "position_side_unknown",
      });
    }
    const amendmentSafety = validateProtectiveAmendment({
      side: scaleInAction === "ENTER_LONG" ? "long" : "short",
      leg,
      currentPrice: protectiveLeg.price,
      newPrice,
      averageEntry: position?.averagePrice ?? null,
      bestBid: snapshot.quote?.bestBid ?? null,
      bestAsk: snapshot.quote?.bestAsk ?? null,
    });
    if (!amendmentSafety.ok) {
      return this.record({
        intentId: intent.intentId,
        status: "rejected",
        code: amendmentSafety.code,
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
    if (this.currentMode() === "shadow") {
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
    // ponytail: outbox rows are keyed by intent_id; venue protective tags are stable across amends
    this.store.prepareMutation(
      intent.intentId,
      "modify_order",
      request as unknown as Record<string, unknown>,
      null,
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

  private attributableTranches(): TrancheView[] {
    return this.tranches().filter((tranche) => tranche.remaining_qty > 0);
  }

  /**
   * Cancel working `glt-*-SL` / `glt-*-TP` orders when the venue position is flat.
   *
   * Stop fills and `position_already_flat` EXIT paths do not always clear protective legs,
   * and a stale tranche can later trigger re-arm. Flat venue is the authoritative invariant:
   * no attributable protective order may remain working.
   */
  public sweepOrphanProtectiveOrders(snapshot: AccountVenueSnapshot): Promise<boolean> {
    const result = this.executionQueue.then(() => this.sweepOrphanProtectiveOrdersSerial(snapshot));
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async sweepOrphanProtectiveOrdersSerial(snapshot: AccountVenueSnapshot): Promise<boolean> {
    if (snapshot.instrumentOpenContracts !== 0) {
      return false;
    }
    this.store.markProtectedReductionsFlat(new Date().toISOString());
    const orphans = snapshot.openOrders.filter(
      (order) => order.accountId === this.config.scope.accountId
        && order.contractId === this.config.scope.contractId
        && isProtectiveCustomTag(order.customTag),
    );
    if (orphans.length === 0) {
      return false;
    }

    let changed = false;
    for (const order of orphans) {
      try {
        await this.api.cancelOrder(this.config.scope.accountId, order.id);
        changed = true;
        const parsed = order.customTag ? parseProtectiveTag(order.customTag) : null;
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "protective_orders_swept_flat",
          payload: {
            provider_order_id: order.id,
            custom_tag: order.customTag,
            intent_id: parsed?.intentId ?? null,
            leg: parsed?.leg ?? null,
            generation: parsed?.generation ?? null,
          },
        });
      } catch (error) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "protective_order_sweep_failed",
          payload: {
            provider_order_id: order.id,
            custom_tag: order.customTag,
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (changed) {
      this.invalidateIssuedPackets();
    }
    return changed;
  }

  /**
   * Re-place SL/TP for tranches the venue left holding contracts with no protective order.
   *
   * Auto OCO cancels the whole bracket group when a partial exit fills, so the surviving
   * tranche is genuinely naked. Runs on the same executionQueue as wire intents so EXIT/MOVE
   * cannot race a rearm. Defers while non-protective working orders or an open EXIT exist.
   */
  public rearmTrancheProtection(snapshot: AccountVenueSnapshot): Promise<boolean> {
    const result = this.executionQueue.then(() => this.rearmTrancheProtectionSerial(snapshot));
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async rearmTrancheProtectionSerial(snapshot: AccountVenueSnapshot): Promise<boolean> {
    if (this.currentMode() !== "armed" || snapshot.instrumentOpenContracts === 0) {
      return false;
    }
    const nonProtective = snapshot.openOrders.filter(
      (order) => order.accountId === this.config.scope.accountId
        && order.contractId === this.config.scope.contractId
        && !isProtectiveCustomTag(order.customTag),
    );
    if (nonProtective.length > 0 || this.store.hasOpenExitMutation()) {
      return false;
    }
    const exitTargets = this.store.submittedExitTargetIntentIds();
    const contractPositions = snapshot.positions.filter(
      (position) => position.accountId === this.config.scope.accountId
        && position.contractId === this.config.scope.contractId
        && position.type !== 0
        && Math.abs(position.size) > 0,
    );
    const netSigned = instrumentNetSignedLots(contractPositions, this.config.scope.contractId);
    if (netSigned === 0) {
      return false;
    }
    const coverSide: 0 | 1 = netSigned < 0 ? 0 : 1;
    const candidates = this.attributableTranches().filter((tranche) => {
      if (this.rearmLatched.has(tranche.intent_id) || exitTargets.has(tranche.intent_id)) {
        return false;
      }
      const protection = bindProtection(
        tranche.intent_id,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        true,
        tranche.entry_order_id,
      );
      if (protection.status === "proven") {
        this.rearmLatched.delete(tranche.intent_id);
        return false;
      }
      return true;
    });
    if (candidates.length === 0) {
      return false;
    }

    // Open-order snapshots drop cancelled legs, but ProjectX still treats their custom tags as
    // used. Recent order history is the venue truth for both the next free tag generation and
    // the stop/target prices MOVE_STOP may have already tightened.
    const historyStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentOrders = latestOrderById([
      ...snapshot.openOrders,
      ...await this.api.searchOrders(this.config.scope.accountId, historyStart),
    ]);
    let changed = false;

    for (const tranche of candidates) {
      const protection = bindProtection(
        tranche.intent_id,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        true,
        tranche.entry_order_id,
      );
      // Rearm always advances past generation 0: that tag pair was consumed by the original
      // Auto OCO bracket, and ProjectX rejects reused custom tags even after cancel.
      const generation = Math.max(
        1,
        nextUnusedProtectionGeneration(
          tranche.intent_id,
          recentOrders,
          this.config.scope.accountId,
        ),
      );
      const tags = protectionCustomTags(tranche.intent_id, generation);
      const entry = this.store.registeredIntentPayload(tranche.intent_id);
      const historicalStop = lastProtectivePriceForIntent(
        recentOrders,
        tranche.intent_id,
        "SL",
        4,
        this.config.scope.accountId,
        this.config.scope.contractId,
      ) ?? entry?.stopLoss ?? null;
      const historicalTarget = lastProtectivePriceForIntent(
        recentOrders,
        tranche.intent_id,
        "TP",
        1,
        this.config.scope.accountId,
        this.config.scope.contractId,
      ) ?? entry?.takeProfit1 ?? null;
      if (historicalStop === null) {
        continue;
      }
      if (!snapshot.quote) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "tranche_protection_rearm_deferred",
          payload: {
            tranche_intent_id: tranche.intent_id,
            remaining_qty: tranche.remaining_qty,
            detail: "quote_unavailable_for_marketable_stop_guard",
          },
        });
        continue;
      }
      const sanitized = sanitizeRearmProtectionPrices(
        coverSide,
        historicalStop,
        historicalTarget ?? historicalStop,
        snapshot.quote,
        snapshot.contract.tickSize,
      );
      const stopPrice = sanitized.stopPrice;
      const targetPrice = historicalTarget === null ? null : sanitized.targetPrice;
      const size = tranche.remaining_qty;
      let activeReduction = this.store.activeProtectedReduction();
      try {
        if (!protection.stop.providerOrderId) {
          await this.api.placeOrder({
            accountId: this.config.scope.accountId,
            contractId: this.config.scope.contractId,
            type: 4,
            side: coverSide,
            size,
            stopPrice,
            customTag: tags.stop,
          });
          activeReduction = this.store.activeProtectedReduction();
          if (activeReduction
            && (activeReduction.state === "reduction_ambiguous"
              || activeReduction.state === "reduction_submitting")) {
            this.store.advanceProtectedReduction(
              activeReduction.exit_intent_id,
              "degraded_stop_only",
              "survivor_stop_replaced",
              new Date().toISOString(),
              { detail: `tranche=${tranche.intent_id};generation=${generation}` },
            );
            activeReduction = this.store.activeProtectedReduction();
          }
          maybeKill("rearm_after_stop_before_tp");
        }
        if (targetPrice !== null && !protection.target.providerOrderId) {
          try {
            await this.api.placeOrder({
              accountId: this.config.scope.accountId,
              contractId: this.config.scope.contractId,
              type: 1,
              side: coverSide,
              size,
              limitPrice: targetPrice,
              customTag: tags.target,
            });
            activeReduction = this.store.activeProtectedReduction();
            if (activeReduction
              && (activeReduction.state === "degraded_stop_only"
                || activeReduction.state === "reduction_ambiguous")) {
              this.store.advanceProtectedReduction(
                activeReduction.exit_intent_id,
                "reduced_protected",
                "survivor_stop_and_target_replaced",
                new Date().toISOString(),
              );
            }
          } catch (tpError) {
            activeReduction = this.store.activeProtectedReduction();
            if (activeReduction && activeReduction.state === "reduction_ambiguous") {
              try {
                this.store.advanceProtectedReduction(
                  activeReduction.exit_intent_id,
                  "degraded_stop_only",
                  "target_rearm_failed_stop_only",
                  new Date().toISOString(),
                  { detail: tpError instanceof Error ? tpError.message : String(tpError) },
                );
              } catch {
                // best-effort
              }
            }
            await this.ledger.append({
              schema_version: "glitch.direct.event.v1",
              event_id: randomUUID(),
              recorded_utc: new Date().toISOString(),
              event: "tranche_protection_rearm_target_failed",
              payload: {
                tranche_intent_id: tranche.intent_id,
                remaining_qty: size,
                stop_price: stopPrice,
                target_price: targetPrice,
                detail: tpError instanceof Error ? tpError.message : String(tpError),
              },
            });
          }
        } else if (
          protection.stop.providerOrderId
          && protection.target.providerOrderId
        ) {
          activeReduction = this.store.activeProtectedReduction();
          if (activeReduction && activeReduction.state === "reduction_ambiguous") {
            this.store.advanceProtectedReduction(
              activeReduction.exit_intent_id,
              "reduced_protected",
              "survivor_protection_still_proven",
              new Date().toISOString(),
            );
          }
        }
        this.rearmLatched.add(tranche.intent_id);
        changed = true;
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "tranche_protection_rearmed",
          payload: {
            tranche_intent_id: tranche.intent_id,
            remaining_qty: size,
            stop_price: stopPrice,
            target_price: targetPrice,
            custom_tag_generation: generation,
            prices_adjusted_for_market: sanitized.adjusted,
          },
        });
      } catch (error) {
        activeReduction = this.store.activeProtectedReduction();
        if (activeReduction) {
          try {
            this.store.advanceProtectedReduction(
              activeReduction.exit_intent_id,
              "failed",
              "survivor_stop_rearm_failed",
              new Date().toISOString(),
              { detail: error instanceof Error ? error.message : String(error) },
            );
          } catch {
            // best-effort
          }
        }
        // An unprotected position is the one state this gateway exists to prevent, so a
        // rejected re-arm has to be visible rather than retried in silence.
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "tranche_protection_rearm_failed",
          payload: {
            tranche_intent_id: tranche.intent_id,
            remaining_qty: size,
            stop_price: stopPrice,
            target_price: targetPrice,
            cover_side: coverSide,
            custom_tag_generation: generation,
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return changed;
  }

  /**
   * Pull owned stops to breakeven once the daily capture objective latched (TS-CAP-02).
   *
   * Tighten-only and best effort: amendment safety rejects any widening, nothing is flattened
   * for the objective, and a stop already at or past entry is left untouched so repeated calls
   * — including one per restart — converge on the same venue state.
   */
  public tightenOwnedStopsAfterCaptureLock(): Promise<number> {
    const result = this.executionQueue.then(() => this.tightenOwnedStopsAfterCaptureLockSerial());
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async tightenOwnedStopsAfterCaptureLockSerial(): Promise<number> {
    const snapshot = this.snapshot();
    if (this.currentMode() !== "armed" || snapshot.instrumentOpenContracts === 0) {
      return 0;
    }
    const tickSize = snapshot.contract.tickSize;
    const position = snapshot.positions.find(
      (candidate) => candidate.accountId === this.config.scope.accountId
        && candidate.contractId === this.config.scope.contractId
        && candidate.type !== 0
        && Math.abs(candidate.size) > 0,
    );
    const scaleInAction = position ? scaleInActionForPosition(position) : null;
    if (!position || !scaleInAction || !(tickSize > 0)) {
      return 0;
    }
    const side = scaleInAction === "ENTER_LONG" ? "long" : "short";
    const breakeven = Math.round(position.averagePrice / tickSize) * tickSize;

    let tightened = 0;
    for (const tranche of this.attributableTranches()) {
      const protection = bindProtection(
        tranche.intent_id,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        true,
        tranche.entry_order_id,
      );
      const stop = protection.stop;
      if (protection.status !== "proven" || stop.providerOrderId === null || stop.price === breakeven) {
        continue;
      }
      const stopQty = Math.abs(stop.observedOrder?.size ?? 0);
      const trancheQty = Math.abs(tranche.remaining_qty);
      if (trancheQty > 0 && stopQty < trancheQty) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "capture_lock_stop_coverage_incomplete",
          payload: {
            tranche_intent_id: tranche.intent_id,
            provider_order_id: stop.providerOrderId,
            stop_qty: stopQty,
            tranche_qty: trancheQty,
          },
        });
        continue;
      }
      const safety = validateProtectiveAmendment({
        side,
        leg: "stop",
        currentPrice: stop.price,
        newPrice: breakeven,
        averageEntry: position.averagePrice,
        bestBid: snapshot.quote?.bestBid ?? null,
        bestAsk: snapshot.quote?.bestAsk ?? null,
      });
      if (!safety.ok) {
        continue;
      }
      // ponytail: no outbox row — this amendment carries no intent_id, so the JSONL event is
      // its only evidence. Upgrade path is a synthetic operator intent if replay needs it.
      try {
        await this.api.modifyOrder({
          accountId: this.config.scope.accountId,
          orderId: stop.providerOrderId,
          stopPrice: breakeven,
        });
        tightened += 1;
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "capture_lock_stop_tightened",
          payload: {
            tranche_intent_id: tranche.intent_id,
            provider_order_id: stop.providerOrderId,
            previous_stop_price: stop.price,
            new_stop_price: breakeven,
          },
        });
      } catch (error) {
        await this.ledger.append({
          schema_version: "glitch.direct.event.v1",
          event_id: randomUUID(),
          recorded_utc: new Date().toISOString(),
          event: "capture_lock_stop_tighten_failed",
          payload: {
            tranche_intent_id: tranche.intent_id,
            provider_order_id: stop.providerOrderId,
            new_stop_price: breakeven,
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (tightened > 0) {
      this.invalidateIssuedPackets();
    }
    return tightened;
  }

  public protectedReductionHealth(snapshot: AccountVenueSnapshot = this.snapshot()): ProtectedReductionHealth {
    const active = this.store.activeProtectedReduction();
    const attributable = this.attributableTranches();
    let unprotected = 0;
    for (const tranche of attributable) {
      const protection = bindProtection(
        tranche.intent_id,
        snapshot.openOrders,
        this.config.scope.accountId,
        this.config.scope.contractId,
        snapshot.instrumentOpenContracts > 0,
        tranche.entry_order_id,
      );
      const stopCovered = protection.stop.providerOrderId !== null
        || (active?.state === "degraded_stop_only" && active.survivor_stop_order_id !== null);
      if (!stopCovered) {
        unprotected += tranche.remaining_qty;
      }
    }
    const orphans = snapshot.instrumentOpenContracts === 0
      ? snapshot.openOrders.filter(
        (order) => order.accountId === this.config.scope.accountId
          && order.contractId === this.config.scope.contractId
          && isProtectiveCustomTag(order.customTag),
      ).length
      : 0;
    const ambiguousAgeMs = active?.state === "reduction_ambiguous"
      ? Math.max(0, Date.now() - Date.parse(active.updated_utc))
      : null;
    return {
      active_state: active?.state ?? null,
      active_reduction_id: active?.reduction_id ?? null,
      unprotected_open_quantity: unprotected,
      orphan_protective_orders: orphans,
      ambiguous_age_ms: ambiguousAgeMs,
      fail_closed_rollback: partialExitFailClosedEnabled(),
    };
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
    const attributableTranches = this.attributableTranches();

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
          tranche.entry_order_id,
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
          tranche.entry_order_id,
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
    field?: string;
    error?: string;
    path?: string;
  }): ExecutionReceipt {
    return {
      schema_version: "glitch.direct.execution_receipt.v1",
      receipt_id: randomUUID(),
      recorded_utc: new Date().toISOString(),
      intent_id: input.intentId,
      mode: this.currentMode(),
      status: input.status,
      code: input.code,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.field === undefined ? {} : { field: input.field }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.path === undefined ? {} : { path: input.path }),
    };
  }

  private async record(input: {
    intentId: string | null;
    status: ExecutionReceipt["status"];
    code: string;
    orderId?: number;
    detail?: string;
    field?: string;
    error?: string;
    path?: string;
  }): Promise<ExecutionReceipt> {
    const receipt: ExecutionReceipt = {
      schema_version: "glitch.direct.execution_receipt.v1",
      receipt_id: randomUUID(),
      recorded_utc: new Date().toISOString(),
      intent_id: input.intentId,
      mode: this.currentMode(),
      status: input.status,
      code: input.code,
      ...(input.orderId === undefined ? {} : { order_id: input.orderId }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.field === undefined ? {} : { field: input.field }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.path === undefined ? {} : { path: input.path }),
    };
    if (receipt.intent_id) {
      this.store.recordExecutionFact({
        intentId: receipt.intent_id,
        phase: executionFactPhase(receipt),
        recordedUtc: receipt.recorded_utc,
        detail: {
          status: receipt.status,
          code: receipt.code,
          provider_order_id: receipt.order_id ?? null,
          transport_or_provider_detail: receipt.detail ?? null,
        },
      });
    }
    this.store.recordReceipt({ ...receipt });
    maybeKill("after_receipt_before_jsonl");
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

function executionFactPhase(receipt: ExecutionReceipt): string {
  if (receipt.code.includes("submitted")) {
    return "provider_submission_acknowledged";
  }
  if (receipt.status === "open_protected") {
    return "protection_confirmed";
  }
  if (receipt.status === "closed") {
    return "exit_submitted_or_flat";
  }
  if (receipt.status === "rejected") {
    return "intent_rejected";
  }
  if (receipt.status === "ambiguous") {
    return "provider_outcome_ambiguous";
  }
  return "execution_receipt";
}
