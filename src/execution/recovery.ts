import type { StoredExecutionMutation } from "../domain/execution-state.js";
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
}

export async function recoverExecutionMutations(
  store: SqliteExecutionStore,
  api: ExecutionRecoveryApi | ProjectXApiClient,
  accountId: number,
  contractId: string,
  positions: PositionInfo[],
  now = new Date(),
): Promise<ExecutionRecoveryResult> {
  const unresolved = store.unresolvedMutations();
  if (unresolved.length === 0) {
    store.recordRecoveryResult(now.toISOString(), null);
    return { changed: false, resolved: 0, ambiguous: 0 };
  }

  let changed = false;
  let resolved = 0;
  let ambiguous = 0;
  try {
    for (const mutation of unresolved.filter((candidate) => candidate.state === "prepared")) {
      store.markMutationConfirmedNotSubmitted(mutation.intentId, now.toISOString());
      changed = true;
      resolved += 1;
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
      const outcome = reconcileEntryMutation(mutation, historicalOrders, accountId, contractId);
      if (outcome.orderId !== null) {
        store.markMutationSubmitted(mutation.intentId, outcome.orderId, now.toISOString());
        changed = true;
        resolved += 1;
        continue;
      }
      store.markMutationAmbiguous(mutation.intentId, outcome.error, now.toISOString());
      ambiguous += 1;
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
      if (!contractStillOpen) {
        store.markMutationSubmitted(mutation.intentId, null, now.toISOString());
        changed = true;
        resolved += 1;
        continue;
      }
      store.markMutationAmbiguous(
        mutation.intentId,
        "close_position_outcome_ambiguous:configured_contract_still_open",
        now.toISOString(),
      );
      ambiguous += 1;
    }

    store.recordRecoveryResult(now.toISOString(), null);
    return { changed, resolved, ambiguous };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    store.recordRecoveryResult(now.toISOString(), detail);
    throw error;
  }
}

function reconcileEntryMutation(
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
): { orderId: number | null; error: string } {
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

  const order = tagged[0];
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
