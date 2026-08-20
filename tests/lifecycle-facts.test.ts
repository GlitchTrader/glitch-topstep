import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lifecycleFactId,
  lifecycleFactPhase,
  receiptDiagnostics,
  trancheLifecycleFact,
} from "../src/execution/lifecycle-facts.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

interface FactPage {
  facts: Array<{
    sequence: number;
    fact_id: string;
    intent_id: string;
    phase: string;
    revision: number;
    status: string;
    superseded_by: string | null;
    detail: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
  }>;
}

function tranche(filled: number, remaining: number, protection = "proven") {
  return {
    intent_id: "00000000-0000-4000-8000-00000000f001",
    filled_qty: filled,
    remaining_qty: remaining,
    protection: { status: protection, reason: "ok" },
  };
}

describe("lifecycle fact phases", () => {
  it("separates provider rejection from intent rejection", () => {
    assert.equal(
      lifecycleFactPhase({ status: "rejected", code: "projectx_mutation_rejected" }),
      "provider_rejected",
    );
    assert.equal(
      lifecycleFactPhase({ status: "rejected", code: "decision_packet_unknown_or_expired" }),
      "intent_rejected",
    );
  });

  it("names submission, exit submission, amendment and protection moments", () => {
    assert.equal(
      lifecycleFactPhase({ status: "pending", code: "entry_submitted_pending_reconciliation" }),
      "provider_submission_acknowledged",
    );
    assert.equal(
      lifecycleFactPhase({ status: "closed", code: "close_contract_submitted" }),
      "exit_submitted",
    );
    assert.equal(
      lifecycleFactPhase({ status: "submitted", code: "move_stop_reconciled" }),
      "amendment_applied",
    );
    assert.equal(
      lifecycleFactPhase({ status: "open_protected", code: "entry_open_with_proven_protection" }),
      "protection_confirmed",
    );
    assert.equal(
      lifecycleFactPhase({ status: "pending", code: "entry_protection_verification_failed" }),
      "protection_failed",
    );
    assert.equal(
      lifecycleFactPhase({ status: "ambiguous", code: "projectx_mutation_outcome_ambiguous" }),
      "provider_outcome_ambiguous",
    );
  });
});

describe("lifecycle diagnostics", () => {
  it("keeps rejection code, fill presence and protection fidelity separable", () => {
    const rejected = receiptDiagnostics({ status: "rejected", code: "risk_rejected" });
    assert.equal(rejected.rejection_code, "risk_rejected");
    assert.equal(rejected.fill.observed, false);
    assert.equal(rejected.protection.fidelity, "not_applicable");

    const protectedOpen = receiptDiagnostics({
      status: "open_protected",
      code: "entry_open_with_proven_protection",
      fill_observed_utc: "2026-07-21T12:00:10Z",
    });
    assert.equal(protectedOpen.rejection_code, null);
    assert.equal(protectedOpen.fill.observed, true);
    assert.equal(protectedOpen.protection.fidelity, "proven");

    const failed = receiptDiagnostics({
      status: "pending",
      code: "entry_protection_verification_failed",
      detail: "sl_missing",
    });
    assert.equal(failed.protection.fidelity, "failed");
    assert.equal(failed.protection.reason, "sl_missing");
  });

  it("declares latency fields as null when unmeasured and fills those it can measure", () => {
    const diagnostics = receiptDiagnostics(
      { status: "pending", code: "entry_submitted_pending_reconciliation" },
      { submittedUtc: "2026-07-21T12:00:04Z", fillObservedUtc: "2026-07-21T12:00:10Z" },
    );
    assert.deepEqual(diagnostics.latency, {
      decision_to_admission_ms: null,
      admission_to_submission_ms: null,
      submission_to_fill_ms: 6_000,
      fill_to_protection_ms: null,
    });
  });

  it("marks ambiguous provider outcomes as unresolved", () => {
    assert.equal(
      receiptDiagnostics({ status: "ambiguous", code: "projectx_mutation_outcome_ambiguous" }).source_quality,
      "unresolved",
    );
  });
});

describe("tranche fill facts", () => {
  it("distinguishes partial fill, full fill, exit fill and flat", () => {
    const at = "2026-07-21T12:05:00Z";
    assert.equal(
      trancheLifecycleFact({ tranche: tranche(1, 1), requestedQuantity: 2, recordedUtc: at, instrumentFlat: false })?.phase,
      "partial_fill_observed",
    );
    assert.equal(
      trancheLifecycleFact({ tranche: tranche(2, 2), requestedQuantity: 2, recordedUtc: at, instrumentFlat: false })?.phase,
      "entry_fill_observed",
    );
    assert.equal(
      trancheLifecycleFact({ tranche: tranche(2, 0), requestedQuantity: 2, recordedUtc: at, instrumentFlat: false })?.phase,
      "exit_fill_observed",
    );
    assert.equal(
      trancheLifecycleFact({ tranche: tranche(2, 0), requestedQuantity: 2, recordedUtc: at, instrumentFlat: true })?.phase,
      "position_flat",
    );
    assert.equal(
      trancheLifecycleFact({ tranche: tranche(0, 0), requestedQuantity: 2, recordedUtc: at, instrumentFlat: false }),
      null,
    );
  });

  it("reports derived source quality and unproven protection honestly", () => {
    const fact = trancheLifecycleFact({
      tranche: tranche(1, 1, "incomplete"),
      requestedQuantity: 1,
      recordedUtc: "2026-07-21T12:05:00Z",
      instrumentFlat: false,
    });
    assert.equal(fact?.diagnostics.source_quality, "derived");
    assert.equal(fact?.diagnostics.protection.fidelity, "failed");
    assert.equal(fact?.diagnostics.fill.filled_quantity, 1);
  });
});

describe("execution fact feed", () => {
  const intentId = "00000000-0000-4000-8000-00000000f010";

  it("keeps a stable identity across corrections and deduplicates unchanged content", () => {
    const store = new SqliteExecutionStore(":memory:");
    try {
      const first = store.recordExecutionFact({
        intentId,
        phase: "partial_fill_observed",
        factKey: "fill",
        recordedUtc: "2026-07-21T12:00:10Z",
        detail: { filled_qty: 1 },
      });
      const unchanged = store.recordExecutionFact({
        intentId,
        phase: "partial_fill_observed",
        factKey: "fill",
        recordedUtc: "2026-07-21T12:00:11Z",
        detail: { filled_qty: 1 },
      });
      const corrected = store.recordExecutionFact({
        intentId,
        phase: "entry_fill_observed",
        factKey: "fill",
        recordedUtc: "2026-07-21T12:00:12Z",
        detail: { filled_qty: 2 },
      });

      assert.equal(first.factId, lifecycleFactId(intentId, "fill"));
      assert.equal(unchanged.recorded, false);
      assert.equal(unchanged.sequence, first.sequence);
      assert.equal(corrected.factId, first.factId);
      assert.equal(corrected.revision, 2);

      const page = store.executionFactsAfter(0) as unknown as FactPage;
      assert.equal(page.facts.length, 2);
      assert.deepEqual(page.facts.map((fact) => fact.revision), [1, 2]);
      assert.ok(page.facts.every((fact) => fact.status === "live"));
    } finally {
      store.close();
    }
  });

  it("keeps facts visible but flagged once the revisioned outcome catches up", () => {
    const store = new SqliteExecutionStore(":memory:");
    try {
      store.recordExecutionFact({
        intentId,
        phase: "position_flat",
        factKey: "fill",
        recordedUtc: "2026-07-21T12:00:10Z",
        detail: { filled_qty: 1, remaining_qty: 0 },
        diagnostics: { source_quality: "derived" },
      });
      const superseded = store.supersedeExecutionFacts(
        intentId,
        `outcome:${intentId}`,
        "2026-07-21T12:00:20Z",
      );
      assert.equal(superseded, 1);
      assert.equal(store.supersedeExecutionFacts(intentId, `outcome:${intentId}`, "2026-07-21T12:00:30Z"), 0);

      const page = store.executionFactsAfter(0) as unknown as FactPage;
      const fill = page.facts.find((fact) => fact.phase === "position_flat");
      assert.equal(fill?.status, "superseded_by_outcome");
      assert.equal(fill?.superseded_by, `outcome:${intentId}`);
      assert.deepEqual(fill?.diagnostics, { source_quality: "derived" });

      const marker = page.facts.find((fact) => fact.phase === "outcome_superseded");
      assert.equal(marker?.status, "live");
      assert.equal(marker?.detail.superseded_facts, 1);
      assert.deepEqual(store.executionFactsStatus(), {
        live: 1,
        superseded: 1,
        high_water_sequence: 2,
      });
    } finally {
      store.close();
    }
  });
});
