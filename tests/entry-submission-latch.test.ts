import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredExecutionMutation } from "../src/domain/execution-state.js";
import {
  DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
  shouldClearStaleEntrySubmissionLatch,
} from "../src/execution/entry-submission-latch.js";

function submittedMutation(
  overrides: Partial<StoredExecutionMutation> = {},
): StoredExecutionMutation {
  return {
    intentId: "00000000-0000-4000-8000-000000000001",
    operation: "place_order",
    state: "submitted",
    customTag: "glt-test",
    request: {},
    createdUtc: "2026-08-07T19:06:50.274Z",
    submittingUtc: "2026-08-07T19:06:50.400Z",
    resolvedUtc: "2026-08-07T19:06:50.492Z",
    providerOrderId: 42,
    lastError: null,
    ...overrides,
  };
}

describe("entry submission latch stale clear", () => {
  it("clears when submitted, flat, and past TTL", () => {
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation(),
        "2026-08-07T19:12:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        false,
        false,
      ),
      true,
    );
  });

  it("does not clear inside TTL while flat", () => {
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation(),
        "2026-08-07T19:08:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        false,
        false,
      ),
      false,
    );
  });

  it("does not clear when position or order is still observed", () => {
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation(),
        "2026-08-10T00:00:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        true,
        false,
      ),
      false,
    );
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation(),
        "2026-08-10T00:00:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        false,
        true,
      ),
      false,
    );
  });

  it("does not clear while venue is not flat", () => {
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation(),
        "2026-08-10T00:00:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        false,
        false,
        false,
      ),
      false,
    );
  });

  it("does not clear for non-submitted mutations", () => {
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation({ state: "submitting", resolvedUtc: null }),
        "2026-08-10T00:00:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        false,
        false,
      ),
      false,
    );
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        submittedMutation({ state: "ambiguous", resolvedUtc: null }),
        "2026-08-10T00:00:00.000Z",
        DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS,
        true,
        false,
        false,
      ),
      false,
    );
  });
});
