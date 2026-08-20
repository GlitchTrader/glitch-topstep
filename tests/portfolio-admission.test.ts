import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePortfolioAdmission, type ProtectedExposure } from "../src/risk/portfolio-risk.js";
import { RuntimeScopeLock } from "../src/service/runtime-lock.js";

const CANDIDATE: ProtectedExposure = {
  contract_id: "CON.F.US.MNQ.U26",
  quantity: 1,
  stop_distance_ticks: 20,
  tick_value: 0.5,
  fees_usd: 2.5,
  slippage_ticks: 2,
};

function admission(overrides: Partial<Parameters<typeof evaluatePortfolioAdmission>[0]>) {
  return evaluatePortfolioAdmission({
    hard_loss_buffer_usd: 500,
    existing: [],
    pending: [],
    candidate: CANDIDATE,
    simultaneous_exposure_enabled: false,
    ...overrides,
  });
}

test("foreign exposure the caller could not price still blocks new exposure", () => {
  // The venue snapshot showed exposure outside the selected contract but the admission
  // could not size it; admitting it as zero risk would be the optimistic failure mode.
  const result = admission({ foreign_exposure_present: true });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "simultaneous_exposure_disabled");
});

test("unpriceable existing exposure blocks admission even with simultaneous exposure opted in", () => {
  const result = admission({
    simultaneous_exposure_enabled: true,
    foreign_exposure_present: true,
    unprotected_existing_exposure: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "portfolio_protection_unproven");
});

test("account-wide protected downside is additive across contracts and respects the hard floor", () => {
  const existing: ProtectedExposure[] = [
    { contract_id: "CON.F.US.MES.U26", quantity: 2, stop_distance_ticks: 40, tick_value: 1.25, fees_usd: 2.5, slippage_ticks: 2 },
  ];
  const pending: ProtectedExposure[] = [
    { contract_id: "CON.F.US.MCLE.V26", quantity: 1, stop_distance_ticks: 30, tick_value: 1, fees_usd: 2.5, slippage_ticks: 2 },
  ];

  const withinBuffer = admission({
    simultaneous_exposure_enabled: true,
    hard_loss_buffer_usd: 500,
    existing,
    pending,
  });
  const overBuffer = admission({
    simultaneous_exposure_enabled: true,
    hard_loss_buffer_usd: 150,
    existing,
    pending,
  });

  // 2 * (40 + 2) * 1.25 + 2 * 2.5 = 110; 30 + 2 + 2.5 = 34.5; 20 * 0.5 + 2 * 0.5 + 2.5 = 13.5
  assert.equal(withinBuffer.protected_downside_usd, 158);
  assert.equal(withinBuffer.allowed, true);
  assert.equal(overBuffer.allowed, false);
  assert.equal(overBuffer.code, "portfolio_hard_loss_floor_breach");
  assert.equal(overBuffer.remaining_buffer_usd, -8);
});

test("the runtime account lock is scoped per account, not per process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-admission-lock-"));
  const owner = new RuntimeScopeLock(directory, 101);
  const rival = new RuntimeScopeLock(directory, 101);
  const otherAccount = new RuntimeScopeLock(directory, 202);
  try {
    await owner.acquire();
    await assert.rejects(() => rival.acquire(), /runtime_account_lock_held/);
    await otherAccount.acquire();
  } finally {
    await owner.release();
    await rival.release();
    await otherAccount.release();
    await rm(directory, { recursive: true, force: true });
  }
});
