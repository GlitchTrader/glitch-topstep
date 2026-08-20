import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableControlStore, type ControlCommand } from "../src/control/durable-control-store.js";

const command: ControlCommand = {
  schema_version: "glitch.topstep.control.v1",
  control_id: "123e4567-e89b-42d3-a456-426614174000",
  action: "pause",
  account_id: 1,
  contract_id: null,
  issuer: "operator",
  created_utc: "2026-08-19T12:00:00.000Z",
  reason: "test",
};

test("durable controls are idempotent and content-bound across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "controls-"));
  const path = join(directory, "controls.sqlite");
  let store = new DurableControlStore(path);
  try {
    assert.equal(store.submit(command).status, "pending");
    assert.equal(store.submit(command).status, "pending");
    assert.throws(() => store.submit({ ...command, reason: "changed" }), /control_id_content_conflict/);
    store.transition(command.control_id, "applying");
    store.close();
    store = new DurableControlStore(path);
    assert.equal(store.pending()[0]?.status, "applying");
    assert.equal(store.transition(command.control_id, "completed").status, "completed");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function control(action: ControlCommand["action"], reason: string): ControlCommand {
  return { ...command, control_id: randomUUID(), action, reason };
}

test("a long control stream stays ordered, idempotent, and content-bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "controls-stress-"));
  const store = new DurableControlStore(join(directory, "controls.sqlite"));
  try {
    const actions = ["pause", "resume", "flatten"] as const;
    const submitted: ControlCommand[] = [];
    for (let index = 0; index < 200; index += 1) {
      const next = control(actions[index % actions.length]!, `stress-${index}`);
      const stored = store.submit(next);
      assert.equal(stored.status, "pending");
      assert.equal(stored.sequence, index + 1);
      submitted.push(next);
    }
    assert.deepEqual(
      store.pending().map((entry) => entry.control_id),
      submitted.map((entry) => entry.control_id),
    );

    const replayed = store.submit(submitted[7]!);
    assert.equal(replayed.sequence, 8);
    assert.equal(replayed.status, "pending");
    assert.equal(store.pending().length, 200);

    assert.throws(
      () => store.submit({ ...submitted[7]!, reason: "tampered" }),
      /control_id_content_conflict/,
    );
    assert.equal(store.status().pending, 200);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart resumes pending control work without replaying completed commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "controls-restart-"));
  const path = join(directory, "controls.sqlite");
  const applied = control("pause", "already applied");
  const inFlight = control("flatten", "crashed mid-apply");
  const queued = control("resume", "queued behind the crash");
  let store = new DurableControlStore(path);
  try {
    store.submit(applied);
    store.transition(applied.control_id, "completed");
    store.submit(inFlight);
    assert.equal(store.claimPending(inFlight.control_id)?.status, "applying");
    store.submit(queued);
    store.close();

    store = new DurableControlStore(path);
    assert.deepEqual(
      store.pending().map((entry) => [entry.action, entry.status]),
      [["flatten", "applying"], ["resume", "pending"]],
    );
    // A completed command is never re-claimable, so restart cannot replay an applied control.
    assert.equal(store.claimPending(applied.control_id), null);
    assert.equal(store.get(applied.control_id)?.status, "completed");
    // The crashed command is already claimed; only the queued one is still claimable.
    assert.equal(store.claimPending(inFlight.control_id), null);
    assert.equal(store.claimPending(queued.control_id)?.status, "applying");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("flatten runs the full lifecycle without touching new-exposure state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "controls-flatten-"));
  const store = new DurableControlStore(join(directory, "controls.sqlite"));
  const contractId = "CON.F.US.MNQ.U26";
  const flatten: ControlCommand = { ...control("flatten", "flatten now"), contract_id: contractId };
  const pause = control("pause", "hold new exposure");
  try {
    assert.equal(store.submit(flatten).status, "pending");
    assert.equal(store.claimPending(flatten.control_id)?.status, "applying");
    assert.equal(store.transition(flatten.control_id, "completed").status, "completed");
    // Risk reduction is not an exposure gate: a completed flatten leaves pause and mode alone.
    assert.deepEqual(store.effectiveState(command.account_id, contractId), { paused: false, mode: null });

    store.submit(pause);
    store.transition(pause.control_id, "completed");
    assert.deepEqual(store.effectiveState(command.account_id, contractId), { paused: true, mode: null });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("status surface counts every control lifecycle state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "controls-status-"));
  const store = new DurableControlStore(join(directory, "controls.sqlite"));
  try {
    store.submit(control("pause", "still queued"));
    const applying = control("flatten", "in flight");
    store.submit(applying);
    store.claimPending(applying.control_id);
    for (const [action, status] of [
      ["resume", "completed"],
      ["pause", "rejected"],
      ["flatten", "failed"],
    ] as const) {
      const entry = control(action, `terminal-${status}`);
      store.submit(entry);
      store.transition(entry.control_id, status, `detail-${status}`);
    }
    assert.deepEqual(store.status(), {
      pending: 1,
      applying: 1,
      completed: 1,
      rejected: 1,
      failed: 1,
    });
    assert.throws(() => store.transition(randomUUID(), "completed"), /control_not_found/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

