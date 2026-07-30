import type {
  RecoveredExecutionResolution,
  StoredExecutionMutation,
  StoredIntentWithoutExecution,
} from "../domain/execution-state.js";
import type { OrderInfo, PositionInfo } from "../domain/models.js";
import type { ProjectXApiClient } from "../projectx/client.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

export interface ExecutionRecoveryApi {
  searchOrders(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<OrderInfo[]>;
}

export interface ExecutionRecoveryResult {
  changed: boolean;
  resolved: number;
  ambiguous: number;
  resolutions: RecoveredExecutionResolution[];
}

export async function recoverExecutionMutations(
  store: SqliteExecutionStore,
  api: ExecutionRecoveryApi | ProjectXApiClient,
  accountId: number,
  contractId: string,
  positions: PositionInfo[],
  now = new Date(),
): Promise<ExecutionRecoveryResult> {
  const orphanIntents = store.intentsWithoutReceiptsOrMutations();
  const unresolved = store.unresolvedMutations();
  const terminalWithoutReceipts = store.terminalMutationsWithoutReceipts();
  if (
    orphanIntents.length === 0
    && unresolved.length === 0
    && terminalWithoutReceipts.length === 0
  ) {
    store.recordRecoveryResult(now.toISOString(), null);
    return { changed: false, resolved: 0, ambiguous: 0, resolutions: [] };
  }

  let changed = orphanIntents.length > 0;
  let resolved = orphanIntents.length;
  let ambiguous = 0;
  const resolutions = [
    ...orphanIntents.map(reconstructOrphanIntentResolution),
    ...terminalWithoutReceipts.map(reconstructTerminalResolution),
  ];
  try {
    for (const mutation of unresolved.filter((candidate) => candidate.state === "prepared")) {
      store.markMutationConfirmedNotSubmitted(mutation.intentId, now.toISOString());
      changed = true;
      resolved += 1;
      resolutions.push({
        intentId: mutation.intentId,
        operation: mutation.operation,
        outcome: "confirmed_not_submitted",
        code: "mutation_confirmed_not_submitted_after_restart",
        providerOrderId: null,
        detail: "The durable outbox never reached submitting state; no ProjectX mutation was called.",
      });
    }

    const uncertainEntries = unresolved.filter(
      (candidate) => candidate.operation === "place_order" && candidate.state !== "prepared",
    );
    let historicalOrders: OrderInfo[] = [];
    if (uncertainEntries.length > 0) {
      const earliest = Math.min(
        ...uncertainEntries.map((mutation) => new Date(
          mutation.submittingUtc ?? mutation.createdUtc,
        ).getTime()),
      );
      historicalOrders = await api.searchOrders(
        accountId,
        new Date(earliest - 10 * 60 * 1000).toISOString(),
        now.toISOString(),
      );
    }

    for (const mutation of uncertainEntries) {
      const live = store.mutationForIntent(mutation.intentId);
      if (!live || isTerminalMutationState(live.state)) {
        continue;
      }
      if (
        live.state === "submitting"
        && live.submittingUtc
        && now.getTime() - new Date(live.submittingUtc).getTime() < 15_000
      ) {
        continue;
      }
      const outcome = reconcileEntryMutation(live, historicalOrders, accountId, contractId);
      if (outcome.orderId !== null) {
        store.markMutationSubmitted(mutation.intentId, outcome.orderId, now.toISOString());
        changed = true;
        resolved += 1;
        resolutions.push({
          intentId: mutation.intentId,
          operation: mutation.operation,
          outcome: "submitted",
          code: "entry_recovered_from_projectx_custom_tag",
          providerOrderId: outcome.orderId,
          detail: "A unique historical ProjectX order matched custom tag and complete order identity.",
        });
        continue;
      }
      store.markMutationAmbiguous(mutation.intentId, outcome.error, now.toISOString());
      changed = changed || mutation.state === "submitting";
      ambiguous += 1;
      resolutions.push({
        intentId: mutation.intentId,
        operation: mutation.operation,
        outcome: "ambiguous",
        code: "projectx_mutation_outcome_ambiguous",
        providerOrderId: null,
        detail: outcome.error,
      });
    }

    const uncertainModifyEntries = unresolved.filter(
      (candidate) => candidate.operation === "modify_order" && candidate.state !== "prepared",
    );
    if (uncertainModifyEntries.length > 0 && historicalOrders.length === 0) {
      const earliest = Math.min(
        ...uncertainModifyEntries.map((mutation) => new Date(
          mutation.submittingUtc ?? mutation.createdUtc,
        ).getTime()),
      );
      historicalOrders = await api.searchOrders(
        accountId,
        new Date(earliest - 10 * 60 * 1000).toISOString(),
        now.toISOString(),
      );
    }

    for (const mutation of uncertainModifyEntries) {
      const live = store.mutationForIntent(mutation.intentId);
      if (!live || isTerminalMutationState(live.state)) {
        continue;
      }
      const outcome = reconcileModifyMutation(live, historicalOrders, accountId, contractId);
      if (outcome.recovered) {
        store.markMutationSubmitted(
          mutation.intentId,
          outcome.orderId,
          now.toISOString(),
        );
        changed = true;
        resolved += 1;
        resolutions.push({
          intentId: mutation.intentId,
          operation: mutation.operation,
          outcome: "submitted",
          code: "modify_recovered_from_projectx_order_state",
          providerOrderId: outcome.orderId,
          detail: outcome.detail,
        });
        continue;
      }
      store.markMutationAmbiguous(mutation.intentId, outcome.error, now.toISOString());
      changed = changed || mutation.state === "submitting";
      ambiguous += 1;
      resolutions.push({
        intentId: mutation.intentId,
        operation: mutation.operation,
        outcome: "ambiguous",
        code: "projectx_mutation_outcome_ambiguous",
        providerOrderId: null,
        detail: outcome.error,
      });
    }

    const contractStillOpen = positions.some(
      (position) => position.accountId === accountId
        && position.contractId === contractId
        && position.type !== 0
        && Math.abs(position.size) > 0,
    );
    for (const mutation of unresolved.filter(
      (candidate) => candidate.operation === "close_position" && candidate.state !== "prepared",
    )) {
      const live = store.mutationForIntent(mutation.intentId);
      if (!live || isTerminalMutationState(live.state)) {
        continue;
      }
      if (!contractStillOpen) {
        store.markMutationSubmitted(mutation.intentId, null, now.toISOString());
        changed = true;
        resolved += 1;
        resolutions.push({
          intentId: mutation.intentId,
          operation: mutation.operation,
          outcome: "submitted",
          code: "close_recovered_from_flat_provider_state",
          providerOrderId: null,
          detail: "Current ProjectX position state proves the configured contract is flat.",
        });
        continue;
      }
      const detail = "close_position_outcome_ambiguous:configured_contract_still_open";
      store.markMutationAmbiguous(mutation.intentId, detail, now.toISOString());
      changed = changed || mutation.state === "submitting";
      ambiguous += 1;
      resolutions.push({
        intentId: mutation.intentId,
        operation: mutation.operation,
        outcome: "ambiguous",
        code: "projectx_mutation_outcome_ambiguous",
        providerOrderId: null,
        detail,
      });
    }

    store.recordRecoveryResult(now.toISOString(), null);
    return { changed, resolved, ambiguous, resolutions };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    store.recordRecoveryResult(now.toISOString(), detail);
    throw error;
  }
}

function isTerminalMutationState(
  state: StoredExecutionMutation["state"],
): boolean {
  return state === "submitted"
    || state === "confirmed_not_submitted"
    || state === "rejected";
}

function reconstructOrphanIntentResolution(
  intent: StoredIntentWithoutExecution,
): RecoveredExecutionResolution {
  if (intent.action === "HOLD" || intent.action === "NOTHING") {
    return {
      intentId: intent.intentId,
      operation: "no_mutation",
      outcome: "ignored",
      code: "no_op_receipt_reconstructed_after_restart",
      providerOrderId: null,
      detail: "The intent identity was durable, but no provider mutation was required or prepared.",
    };
  }

  const operation = intent.action === "EXIT"
    ? "close_position"
    : intent.action === "MOVE_STOP" || intent.action === "MOVE_TP"
      ? "modify_order"
      : intent.action === "ENTER_LONG" || intent.action === "ENTER_SHORT"
        ? "place_order"
        : "no_mutation";
  return {
    intentId: intent.intentId,
    operation,
    outcome: "confirmed_not_submitted",
    code: "intent_confirmed_not_submitted_without_outbox",
    providerOrderId: null,
    detail: "The intent identity was persisted, but no durable execution outbox exists; no ProjectX mutation was prepared.",
  };
}

function reconstructTerminalResolution(
  mutation: StoredExecutionMutation,
): RecoveredExecutionResolution {
  if (mutation.state === "submitted") {
    return {
      intentId: mutation.intentId,
      operation: mutation.operation,
      outcome: "submitted",
      code: mutation.operation === "close_position"
        ? "close_receipt_reconstructed_from_durable_state"
        : "entry_receipt_reconstructed_from_durable_state",
      providerOrderId: mutation.providerOrderId,
      detail: "The mutation reached durable submitted state before the prior process wrote its receipt.",
    };
  }
  if (mutation.state === "confirmed_not_submitted") {
    return {
      intentId: mutation.intentId,
      operation: mutation.operation,
      outcome: "confirmed_not_submitted",
      code: "not_submitted_receipt_reconstructed_from_durable_state",
      providerOrderId: null,
      detail: "The mutation was durably proven not submitted before the prior process wrote its receipt.",
    };
  }
  if (mutation.state === "rejected") {
    return {
      intentId: mutation.intentId,
      operation: mutation.operation,
      outcome: "rejected",
      code: "projectx_rejection_receipt_reconstructed_from_durable_state",
      providerOrderId: null,
      detail: mutation.lastError,
    };
  }
  throw new Error(`terminal_recovery_state_invalid:${mutation.state}`);
}

function reconcileModifyMutation(
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
): { recovered: true; orderId: number; detail: string } | { recovered: false; error: string } {
  const orderId = mutation.providerOrderId ?? requiredInteger(mutation.request.orderId, "orderId");
  const observed = orders.find((order) => order.id === orderId);
  if (!observed) {
    return { recovered: false, error: "modify_order_outcome_ambiguous:order_not_found" };
  }
  if (observed.accountId !== accountId || observed.contractId !== contractId) {
    return { recovered: false, error: "modify_order_outcome_ambiguous:order_identity_mismatch" };
  }

  const requestedStop = nullableNumber(mutation.request.stopPrice);
  const requestedLimit = nullableNumber(mutation.request.limitPrice);
  if (requestedStop !== null) {
    if (observed.stopPrice !== requestedStop) {
      return { recovered: false, error: "modify_order_outcome_ambiguous:stop_price_mismatch" };
    }
    return {
      recovered: true,
      orderId,
      detail: `stop_price=${requestedStop}`,
    };
  }
  if (requestedLimit !== null) {
    if (observed.limitPrice !== requestedLimit) {
      return { recovered: false, error: "modify_order_outcome_ambiguous:target_price_mismatch" };
    }
    return {
      recovered: true,
      orderId,
      detail: `target_price=${requestedLimit}`,
    };
  }
  return { recovered: false, error: "modify_order_outcome_ambiguous:request_price_missing" };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reconcileEntryMutation(
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
): { orderId: number | null; error: string } {
  if (mutation.providerOrderId !== null) {
    const observed = orders.find((order) => order.id === mutation.providerOrderId);
    if (observed) {
      const request = mutation.request;
      const expectedSide = requiredInteger(request.side, "side");
      const expectedSize = requiredInteger(request.size, "size");
      const expectedType = requiredInteger(request.type, "type");
      if (
        observed.accountId === accountId
        && observed.contractId === contractId
        && observed.side === expectedSide
        && observed.size === expectedSize
        && observed.type === expectedType
      ) {
        return { orderId: observed.id, error: "" };
      }
    }
    return {
      orderId: mutation.providerOrderId,
      error: "",
    };
  }

  if (!mutation.customTag) {
    return {
      orderId: null,
      error: "place_order_outcome_ambiguous:custom_tag_missing",
    };
  }

  const tagged = orders.filter((order) => order.customTag === mutation.customTag);
  if (tagged.length === 0) {
    return {
      orderId: null,
      error: "place_order_outcome_ambiguous:custom_tag_not_found",
    };
  }
  if (tagged.length > 1) {
    return {
      orderId: null,
      error: `place_order_outcome_ambiguous:custom_tag_duplicate:${tagged.length}`,
    };
  }

  const order = tagged[0]!;
  const request = mutation.request;
  const expectedSide = requiredInteger(request.side, "side");
  const expectedSize = requiredInteger(request.size, "size");
  const expectedType = requiredInteger(request.type, "type");
  if (
    order.accountId !== accountId
    || order.contractId !== contractId
    || order.side !== expectedSide
    || order.size !== expectedSize
    || order.type !== expectedType
  ) {
    return {
      orderId: null,
      error: "place_order_outcome_ambiguous:tagged_order_identity_mismatch",
    };
  }

  return { orderId: order.id, error: "" };
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`stored_execution_request_invalid:${name}`);
  }
  return value;
}
