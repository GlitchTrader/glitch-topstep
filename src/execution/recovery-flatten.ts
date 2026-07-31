import { createHash } from "node:crypto";
import type { StoredExecutionMutation } from "../domain/execution-state.js";
import type { OrderInfo, PositionInfo, TradeIntent } from "../domain/models.js";
import { GLITCH_TOPSTEP_OPERATOR_PROFILE, GLITCH_TOPSTEP_PROMPT_VERSION } from "../domain/operator.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { ExecutionRecoveryApi } from "./recovery.js";

export interface BoundedRecoveryFlattenResult {
  changed: boolean;
  resolved: number;
  resolutions: Array<{
    intentId: string;
    entryIntentId: string;
    providerOrderId: number | null;
    detail: string;
  }>;
}

export function recoveryFlattenIntentId(entryIntentId: string): string {
  const hex = createHash("sha256")
    .update(`bounded-recovery-flatten:${entryIntentId}`)
    .digest("hex")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

export function provesBoundedRecoveryOwnership(
  mutation: StoredExecutionMutation,
  openOrders: OrderInfo[],
  historicalOrders: OrderInfo[],
  accountId: number,
  contractId: string,
): { owned: true; providerOrderId: number; detail: string } | { owned: false; detail: string } {
  const observed = dedupeOrders([...openOrders, ...historicalOrders]);
  if (mutation.providerOrderId !== null) {
    const byId = observed.find((order) => order.id === mutation.providerOrderId);
    if (byId && orderIdentityMatches(byId, mutation, accountId, contractId)) {
      return {
        owned: true,
        providerOrderId: byId.id,
        detail: `provider_order_id=${byId.id}`,
      };
    }
  }
  if (!mutation.customTag) {
    return { owned: false, detail: "bounded_flatten_ownership:custom_tag_missing" };
  }
  const tagged = observed.filter((order) => order.customTag === mutation.customTag);
  if (tagged.length === 0) {
    return { owned: false, detail: "bounded_flatten_ownership:custom_tag_not_found" };
  }
  if (tagged.length > 1) {
    return { owned: false, detail: `bounded_flatten_ownership:custom_tag_duplicate:${tagged.length}` };
  }
  const order = tagged[0]!;
  if (!orderIdentityMatches(order, mutation, accountId, contractId)) {
    return { owned: false, detail: "bounded_flatten_ownership:tagged_order_identity_mismatch" };
  }
  return {
    owned: true,
    providerOrderId: order.id,
    detail: `custom_tag=${mutation.customTag};provider_order_id=${order.id}`,
  };
}

export async function attemptBoundedRecoveryFlattens(
  store: SqliteExecutionStore,
  api: ExecutionRecoveryApi,
  accountId: number,
  contractId: string,
  accountName: string,
  instrument: string,
  positions: PositionInfo[],
  openOrders: OrderInfo[],
  historicalOrders: OrderInfo[],
  now: Date,
): Promise<BoundedRecoveryFlattenResult> {
  if (typeof api.closePosition !== "function") {
    return { changed: false, resolved: 0, resolutions: [] };
  }

  const contractStillOpen = positions.some(
    (position) => position.accountId === accountId
      && position.contractId === contractId
      && position.type !== 0
      && Math.abs(position.size) > 0,
  );
  if (!contractStillOpen) {
    return { changed: false, resolved: 0, resolutions: [] };
  }

  const ambiguousEntries = store.unresolvedMutations().filter(
    (mutation) => mutation.operation === "place_order" && mutation.state === "ambiguous",
  );

  let changed = false;
  let resolved = 0;
  const resolutions: BoundedRecoveryFlattenResult["resolutions"] = [];

  for (const entryMutation of ambiguousEntries) {
    const ownership = provesBoundedRecoveryOwnership(
      entryMutation,
      openOrders,
      historicalOrders,
      accountId,
      contractId,
    );
    if (!ownership.owned) {
      continue;
    }

    const recoveryIntentId = recoveryFlattenIntentId(entryMutation.intentId);
    if (store.mutationForIntent(recoveryIntentId)) {
      continue;
    }

    const atUtc = now.toISOString();
    const recoveryIntent = buildRecoveryFlattenIntent(
      recoveryIntentId,
      entryMutation.intentId,
      accountName,
      instrument,
      atUtc,
    );
    store.registerIntent(recoveryIntent, atUtc);
    store.prepareMutation(
      recoveryIntentId,
      "close_position",
      { accountId, contractId },
      null,
      atUtc,
    );
    store.markMutationSubmitting(recoveryIntentId, atUtc);
    await api.closePosition!(accountId, contractId);
    store.markMutationSubmitted(recoveryIntentId, null, atUtc);
    store.markMutationSubmitted(entryMutation.intentId, ownership.providerOrderId, atUtc);
    store.clearEntrySubmissionLatch(entryMutation.intentId);

    changed = true;
    resolved += 1;
    resolutions.push({
      intentId: recoveryIntentId,
      entryIntentId: entryMutation.intentId,
      providerOrderId: ownership.providerOrderId,
      detail: `bounded_recovery_flatten_submitted;ownership=${ownership.detail}`,
    });
  }

  return { changed, resolved, resolutions };
}

function buildRecoveryFlattenIntent(
  recoveryIntentId: string,
  entryIntentId: string,
  accountName: string,
  instrument: string,
  createdUtc: string,
): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: recoveryIntentId,
    createdUtc,
    instrument,
    account: accountName,
    operatorProfile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
    action: "EXIT",
    confidence: 1,
    snapshotHash: `recovery-flatten:${entryIntentId}`,
    modelVersion: "gateway-recovery",
    promptVersion: GLITCH_TOPSTEP_PROMPT_VERSION,
    reason: `recovery_flatten_for:${entryIntentId}`,
    decisionAudit: {
      bullCase: "Owned unresolved exposure must be flattened without duplicate entry.",
      bearCase: "Flatten only when custom-tag or provider-order identity proves ownership.",
      flatCase: "Contract already flat; no flatten required.",
      aggressiveCase: "Not applicable.",
      conservativeCase: "Close configured contract only.",
      decisiveEvidence: `entry_intent_id=${entryIntentId}`,
      disconfirmingEvidence: "No proximity or price inference grants ownership.",
      changeCondition: "Provider position proves flat.",
      finalChoice: "EXIT",
    },
  };
}

function dedupeOrders(orders: OrderInfo[]): OrderInfo[] {
  const byId = new Map<number, OrderInfo>();
  for (const order of orders) {
    byId.set(order.id, order);
  }
  return [...byId.values()];
}

function orderIdentityMatches(
  order: OrderInfo,
  mutation: StoredExecutionMutation,
  accountId: number,
  contractId: string,
): boolean {
  const request = mutation.request;
  const expectedSide = requiredInteger(request.side, "side");
  const expectedSize = requiredInteger(request.size, "size");
  const expectedType = requiredInteger(request.type, "type");
  return order.accountId === accountId
    && order.contractId === contractId
    && order.side === expectedSide
    && order.size === expectedSize
    && order.type === expectedType;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`stored_execution_request_invalid:${name}`);
  }
  return value;
}
