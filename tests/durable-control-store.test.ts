import assert from "node:assert/strict";
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

