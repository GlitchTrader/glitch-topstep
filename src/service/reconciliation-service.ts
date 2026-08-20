import { randomUUID } from "node:crypto";
import type { RecoveredExecutionResolution } from "../domain/execution-state.js";
import type { AccountInfo, OrderInfo, PositionInfo } from "../domain/models.js";
import { shouldPublishTradeOutcomesOnFlat } from "../learning/trade-outcome-flat.js";
import type { TrancheView } from "../ownership/tranches.js";
import { reconcilePendingReceipts } from "../execution/receipt-reconciliation.js";
import { recoverExecutionMutations } from "../execution/recovery.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { ProjectXApiClient } from "../projectx/client.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { ExecutionCoordinator } from "../execution/coordinator.js";
import type { JsonlEventStore } from "../storage/jsonl-event-store.js";
import type { VenueStateStore } from "../state/venue-state.js";
import type { TradeOutcomeFlatTrigger } from "../learning/trade-outcome-flat.js";

export interface ReconciliationScope {
  accountId: number;
  accountName: string;
  contractId: string;
  instrument: string;
}

export interface ReconciliationRuntime {
  scope: ReconciliationScope;
  api: ProjectXApiClient;
  state: VenueStateStore;
  executionStore: SqliteExecutionStore;
  ledger: JsonlEventStore;
  coordinator: ExecutionCoordinator | null;
  lastReconciledOpenContracts: number;
  setLastReconciledOpenContracts(value: number): void;
  resolveClosedTranchesForFlat(beforeOpen: number): TrancheView[];
  recordRestSnapshot(
    kind: string,
    receivedAt: string,
    payload: unknown,
    accountId: number,
    contractId: string | null,
    envelope: unknown,
  ): void;
  publishTradeOutcomesOnFlat(
    tranches: TrancheView[],
    exitUtc: string,
    trigger: TradeOutcomeFlatTrigger,
  ): Promise<void>;
  refreshCachedOpenTranches(openContracts: number): void;
  clearCachedOpenTranches(): void;
  observeTradeExcursion(openContracts: number, unrealizedPnl: number): void;
  retryIncompleteTradeOutcomes(exitUtc: string): Promise<void>;
  reconcileEntrySubmissionLatch(
    positions: PositionInfo[],
    orders: OrderInfo[],
    receivedUtc: string,
  ): boolean;
  persistRecoveryResolutions(resolutions: RecoveredExecutionResolution[]): Promise<void>;
  invalidateIssuedPackets(): void;
}

function sortedById<T extends { id: number | string }>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    if (typeof left.id === "number" && typeof right.id === "number") {
      return left.id - right.id;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

/** One authoritative REST reconciliation cycle extracted from GlitchTopstepService.reconcile(). */
export async function runReconciliationCycle(runtime: ReconciliationRuntime): Promise<void> {
  runtime.state.markReconciliationStarted();
  const beforeOpen = runtime.state.buildSnapshot(
    runtime.scope.accountId,
    runtime.scope.contractId,
  ).instrumentOpenContracts;
  const openTranches = runtime.resolveClosedTranchesForFlat(beforeOpen);
  const [accountsCol, positionsCol, ordersCol] = await Promise.all([
    runtime.api.searchAccountsCollection(true),
    runtime.api.searchOpenPositionsCollection(runtime.scope.accountId),
    runtime.api.searchOpenOrdersCollection(runtime.scope.accountId),
  ]);
  const accounts = accountsCol.items;
  const positions = positionsCol.items;
  const orders = ordersCol.items;
  const account = accounts.find((candidate) => candidate.id === runtime.scope.accountId);
  if (!account || account.name !== runtime.scope.accountName) {
    throw new Error("configured_account_disappeared_or_changed");
  }

  const receivedAt = new Date().toISOString();
  runtime.recordRestSnapshot(
    "accounts_snapshot",
    receivedAt,
    sortedById(accounts),
    runtime.scope.accountId,
    null,
    accountsCol.envelope,
  );
  runtime.recordRestSnapshot(
    "positions_snapshot",
    receivedAt,
    sortedById(positions),
    runtime.scope.accountId,
    runtime.scope.contractId,
    positionsCol.envelope,
  );
  runtime.recordRestSnapshot(
    "open_orders_snapshot",
    receivedAt,
    sortedById(orders),
    runtime.scope.accountId,
    runtime.scope.contractId,
    ordersCol.envelope,
  );

  runtime.state.replaceAccounts(accounts, receivedAt);
  runtime.state.replacePositions(positions, receivedAt);
  runtime.state.replaceOrders(orders, receivedAt);
  runtime.state.markReconciliationSucceeded(receivedAt);

  const afterOpen = runtime.state.buildSnapshot(
    runtime.scope.accountId,
    runtime.scope.contractId,
  ).instrumentOpenContracts;
  if (shouldPublishTradeOutcomesOnFlat({
    beforeOpen,
    afterOpen,
    lastReconciledOpenContracts: runtime.lastReconciledOpenContracts,
    tranches: openTranches,
  })) {
    await runtime.publishTradeOutcomesOnFlat(openTranches, receivedAt, "reconcile");
  }
  runtime.setLastReconciledOpenContracts(afterOpen);
  if (afterOpen > 0) {
    runtime.refreshCachedOpenTranches(afterOpen);
    runtime.observeTradeExcursion(
      afterOpen,
      runtime.state.buildSnapshot(
        runtime.scope.accountId,
        runtime.scope.contractId,
      ).unrealizedPnl,
    );
  } else {
    runtime.clearCachedOpenTranches();
    await runtime.retryIncompleteTradeOutcomes(receivedAt);
  }

  const latchCleared = runtime.reconcileEntrySubmissionLatch(positions, orders, receivedAt);
  const positionOpen = positions.some(
    (position) => position.accountId === runtime.scope.accountId
      && position.contractId === runtime.scope.contractId
      && position.type !== 0
      && Math.abs(position.size) > 0,
  );
  const receiptReconciliation = reconcilePendingReceipts(
    runtime.executionStore,
    orders,
    runtime.scope.accountId,
    runtime.scope.contractId,
    positionOpen,
    receivedAt,
  );
  const requiresRecovery = runtime.executionStore.recoveryStatus().unresolvedMutations > 0
    || runtime.executionStore.terminalMutationsWithoutReceipts().length > 0
    || runtime.executionStore.intentsWithoutReceiptsOrMutations().length > 0;
  if (requiresRecovery) {
    const before = JSON.stringify(runtime.executionStore.recoveryStatus());
    const recovery = await recoverExecutionMutations(
      runtime.executionStore,
      runtime.api,
      runtime.scope.accountId,
      runtime.scope.contractId,
      positions,
      undefined,
      {
        accountName: runtime.scope.accountName,
        instrument: runtime.scope.instrument,
        openOrders: orders,
      },
    );
    await runtime.persistRecoveryResolutions(recovery.resolutions);
    if (JSON.stringify(runtime.executionStore.recoveryStatus()) !== before) {
      runtime.invalidateIssuedPackets();
    }
  }
  if (latchCleared || receiptReconciliation.changed) {
    runtime.invalidateIssuedPackets();
  }
  for (const event of receiptReconciliation.events) {
    await runtime.ledger.append({
      schema_version: "glitch.direct.event.v1",
      event_id: randomUUID(),
      recorded_utc: receivedAt,
      event: event.event,
      payload: event,
    });
  }
  if (afterOpen > 0) {
    runtime.refreshCachedOpenTranches(afterOpen);
  }
  const liveSnapshot = runtime.state.buildSnapshot(
    runtime.scope.accountId,
    runtime.scope.contractId,
  );
  if (runtime.coordinator) {
    if (liveSnapshot.instrumentOpenContracts === 0) {
      const swept = await runtime.coordinator.sweepOrphanProtectiveOrders(liveSnapshot);
      if (swept) {
        runtime.invalidateIssuedPackets();
      }
    } else {
      const rearmed = await runtime.coordinator.rearmTrancheProtection(liveSnapshot);
      if (rearmed) {
        runtime.invalidateIssuedPackets();
      }
    }
  }
}

export type { AccountInfo, AccountVenueSnapshot };
