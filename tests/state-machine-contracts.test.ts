import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTION_SAGA_TRANSITIONS,
  INTENT_ADMISSION_TRANSITIONS,
  LIFECYCLE_TRANSITIONS,
  OUTCOME_FEED_TRANSITIONS,
  PROTECTED_REDUCTION_TRANSITIONS,
  PROTECTION_SAGA_TRANSITIONS,
  RECONCILIATION_TRANSITIONS,
  TRANSITION_GRAPHS,
  transitionExecutionSaga,
  transitionIntentAdmission,
  transitionLifecycle,
  transitionOutcomeFeed,
  transitionProtectedReduction,
  transitionProtectionSaga,
  transitionReconciliation,
} from "../src/domain/state-machines.js";

const OCCURRED = "2026-08-20T12:00:00.000Z";

function expectInvalid(fn: () => void): void {
  assert.throws(fn, /invalid_state_transition/);
}

test("TRANSITION_GRAPHS exposes all seven state machines", () => {
  assert.equal(Object.keys(TRANSITION_GRAPHS).length, 7);
  assert.ok(TRANSITION_GRAPHS.lifecycle);
  assert.ok(TRANSITION_GRAPHS.intentAdmission);
  assert.ok(TRANSITION_GRAPHS.executionSaga);
  assert.ok(TRANSITION_GRAPHS.protectionSaga);
  assert.ok(TRANSITION_GRAPHS.reconciliation);
  assert.ok(TRANSITION_GRAPHS.outcomeFeed);
  assert.ok(TRANSITION_GRAPHS.protectedReduction);
});

test("lifecycle transitions reject illegal edges", () => {
  transitionLifecycle(null, "starting", "svc", "boot", OCCURRED);
  transitionLifecycle("starting", "ready", "svc", "ready", OCCURRED);
  expectInvalid(() => transitionLifecycle("ready", "starting", "svc", "bad", OCCURRED));
});

test("intent admission transitions reject illegal edges", () => {
  transitionIntentAdmission(null, "received", "intent-1", "wire", OCCURRED);
  transitionIntentAdmission("received", "validated", "intent-1", "ok", OCCURRED);
  expectInvalid(() => transitionIntentAdmission("rejected", "validated", "intent-1", "bad", OCCURRED));
});

test("execution saga transitions reject illegal edges", () => {
  transitionExecutionSaga(null, "prepared", "intent-1", "prepare", OCCURRED);
  transitionExecutionSaga("prepared", "submitting", "intent-1", "wire", OCCURRED);
  transitionExecutionSaga("submitting", "ambiguous", "intent-1", "timeout", OCCURRED);
  expectInvalid(() => transitionExecutionSaga("filled", "prepared", "intent-1", "bad", OCCURRED));
});

test("protection saga transitions reject illegal edges", () => {
  transitionProtectionSaga(null, "pending", "intent-1", "need", OCCURRED);
  transitionProtectionSaga("pending", "proven", "intent-1", "brackets", OCCURRED);
  expectInvalid(() => transitionProtectionSaga("unrequired", "failed", "intent-1", "bad", OCCURRED));
});

test("reconciliation transitions reject illegal edges", () => {
  transitionReconciliation(null, "running", "venue", "timer", OCCURRED);
  transitionReconciliation("running", "succeeded", "venue", "rest", OCCURRED);
  expectInvalid(() => transitionReconciliation("idle", "succeeded", "venue", "bad", OCCURRED));
});

test("outcome feed transitions reject illegal edges", () => {
  transitionOutcomeFeed(null, "pending", "outcome-1", "created", OCCURRED);
  transitionOutcomeFeed("pending", "provisional", "outcome-1", "publish", OCCURRED);
  transitionOutcomeFeed("provisional", "corrected", "outcome-1", "fix", OCCURRED);
  expectInvalid(() => transitionOutcomeFeed("pending", "enriched", "outcome-1", "bad", OCCURRED));
});

test("protected reduction transitions reject illegal edges", () => {
  transitionProtectedReduction(null, "reduction_prepared", "r1", "begin", OCCURRED);
  transitionProtectedReduction("reduction_prepared", "reduction_submitting", "r1", "wire", OCCURRED);
  expectInvalid(() => transitionProtectedReduction("flat", "reduction_prepared", "r1", "bad", OCCURRED));
});

test("every graph exposes at least one legal edge or is terminal-only by design", () => {
  for (const [name, graph] of Object.entries(TRANSITION_GRAPHS)) {
    const states = Object.keys(graph);
    assert.ok(states.length > 0, `${name} must define states`);
    for (const state of states) {
      assert.ok(Array.isArray(graph[state as keyof typeof graph]), `${name}.${state}`);
    }
  }
  assert.deepEqual(EXECUTION_SAGA_TRANSITIONS.filled, []);
  assert.deepEqual(INTENT_ADMISSION_TRANSITIONS.rejected, []);
  assert.deepEqual(LIFECYCLE_TRANSITIONS.failed_shutdown, ["starting"]);
});
