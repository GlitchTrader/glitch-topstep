import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlattenVenueSnapshot,
  resolveFlattenAfterReceipt,
  resolveFlattenAfterRestart,
  shouldCompletePendingFlatten,
} from "../src/service/flatten-workflow.js";
import { snapshot } from "./fixtures.js";

test("TS-AUDIT-09 flatten workflow completes only on authoritative flat venue", () => {
  const venue = buildFlattenVenueSnapshot(snapshot(), 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterReceipt("submitted", venue).status,
    "completed",
  );
});

test("TS-AUDIT-09 flatten workflow waits when exposure remains", () => {
  const snap = snapshot();
  snap.instrumentOpenContracts = 2;
  const venue = buildFlattenVenueSnapshot(snap, 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterReceipt("submitted", venue).detail,
    "waiting_for_flat",
  );
});

test("TS-AUDIT-09 flatten restart preserves waiting_for_flat detail", () => {
  const snap = snapshot();
  snap.instrumentOpenContracts = 1;
  const venue = buildFlattenVenueSnapshot(snap, 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterRestart("waiting_for_flat", venue).status,
    "applying",
  );
});

test("TS-AUDIT-09 pending flatten completion uses the same saga contract", () => {
  const venue = buildFlattenVenueSnapshot(snapshot(), 101, "CON.F.US.MNQ.U26");
  assert.equal(shouldCompletePendingFlatten(venue), true);
});

test("TS-REAUDIT-03 restart fails ambiguous flatten without waiting_for_flat detail", () => {
  const snap = snapshot();
  snap.instrumentOpenContracts = 1;
  const venue = buildFlattenVenueSnapshot(snap, 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterRestart(null, venue).status,
    "failed",
  );
});

test("TS-REAUDIT-03 restart completes when venue is flat after waiting_for_flat", () => {
  const venue = buildFlattenVenueSnapshot(snapshot(), 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterRestart("waiting_for_flat", venue).status,
    "completed",
  );
});

test("TS-REAUDIT-03 rejected cancel receipt requires manual intervention path", () => {
  const snap = snapshot();
  snap.instrumentOpenContracts = 2;
  const venue = buildFlattenVenueSnapshot(snap, 101, "CON.F.US.MNQ.U26");
  assert.equal(
    resolveFlattenAfterReceipt("rejected", venue).status,
    "applying",
  );
});
