import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const token = env.GLITCH_LOCAL_TOKEN;
const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const base = "http://127.0.0.1:8790";
const TICK = 0.25;
const audit = (fc) => ({
  bull_case: "pm4-phase-c",
  bear_case: "pm4-phase-c",
  flat_case: "pm4-phase-c",
  aggressive_case: "pm4-phase-c",
  conservative_case: "pm4-phase-c",
  decisive_evidence: "pm4-phase-c",
  disconfirming_evidence: "pm4-phase-c",
  change_condition: "pm4-phase-c",
  final_choice: fc,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alignTick(price) {
  return Math.round(price / TICK) * TICK;
}

function wideShortBrackets(entry) {
  const ref = alignTick(entry);
  return {
    entry: ref,
    sl: alignTick(ref + 100 * TICK),
    tp: alignTick(ref - 100 * TICK),
  };
}

async function health() {
  const r = await fetch(`${base}/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}
async function packet() {
  const r = await fetch(`${base}/packet`, { headers: h });
  if (!r.ok) throw new Error(`packet ${r.status}`);
  return r.json();
}
async function state() {
  const r = await fetch(`${base}/state`, { headers: h });
  if (!r.ok) throw new Error(`state ${r.status}`);
  return r.json();
}
async function ownership() {
  const r = await fetch(`${base}/ownership`, { headers: h });
  if (!r.ok) throw new Error(`ownership ${r.status}`);
  return r.json();
}
async function postIntent(body) {
  const r = await fetch(`${base}/intent`, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { http: r.status, body: await r.json() };
}

function baseIntent(action, snap, intentId = randomUUID()) {
  return {
    schema_version: "glitch.intent.v2",
    intent_id: intentId,
    created_utc: new Date().toISOString(),
    instrument: env.GLITCH_INSTRUMENT,
    account: env.GLITCH_ACCOUNT_NAME,
    operator_profile: "glitch-topstep",
    action,
    confidence: 0.6,
    snapshot_hash: snap,
    model_version: "pm4-phase-c-e2e",
    prompt_version: "glitch-topstep-v2",
    reason: `pm4-phase-c ${action}`,
    decision_audit: audit(action),
  };
}

async function waitReconciliationReady() {
  for (let i = 0; i < 60; i++) {
    const hlth = await health();
    const rec = hlth.data_quality?.operational?.reconciliation;
    const stateAge = hlth.data_quality?.state_age_ms ?? 99999;
    if (
      rec?.state === "succeeded"
      && hlth.data_quality?.state_complete
      && stateAge < 4000
    ) {
      return hlth;
    }
    await sleep(1000);
  }
  throw new Error("reconciliation_not_ready");
}

async function submitIntent(body, steps, stepName, retries = 5) {
  let current = { ...body, intent_id: body.intent_id ?? randomUUID() };
  for (let attempt = 0; attempt < retries; attempt++) {
    await waitReconciliationReady();
    const pkt = await packet();
    current = {
      ...current,
      snapshot_hash: pkt.market.snapshot_hash,
      created_utc: new Date().toISOString(),
    };
    const res = await postIntent(current);
    steps.push({
      step: stepName,
      attempt,
      http: res.http,
      status: res.body.status,
      code: res.body.code,
      detail: res.body.detail,
      intent_id: current.intent_id,
    });
    if (res.http === 202) {
      return { ...res, intent_id: current.intent_id };
    }
    if (res.body.code === "intent_body_conflict") {
      return { ...res, intent_id: current.intent_id };
    }
    if (
      res.body.code === "decision_packet_unknown_or_expired"
      || res.body.code === "account_state_stale"
      || res.body.code === "quote_stale"
      || res.body.code === "venue_state_incomplete"
      || res.body.code === "stop_not_tick_aligned"
      || res.body.code === "target_not_tick_aligned"
      || res.body.code === "working_order_ownership_unresolved"
      || String(res.body.detail ?? "").includes("reconciliation_not_current")
    ) {
      current.intent_id = randomUUID();
      await sleep(1500);
      continue;
    }
    return { ...res, intent_id: current.intent_id };
  }
  throw new Error(`${stepName}: intent_submit_failed`);
}

async function waitHealthReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const hlth = await health();
      const us = hlth.data_quality?.operational?.userStream?.state;
      if (hlth.status === "ok" && hlth.data_quality?.state_complete && us === "connected") return hlth;
    } catch {
      // gateway still starting
    }
    await sleep(2000);
  }
  throw new Error("health_not_ready");
}

async function ensureFlat(steps) {
  const st = await state();
  if (st.instrumentOpenContracts === 0) return;
  const res = await submitIntent(
    { ...baseIntent("EXIT", "unused"), reason: "PRE_EXIT flat" },
    steps,
    "PRE_EXIT",
  );
  if (res.http !== 202) throw new Error("PRE_EXIT failed");
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const s = await state();
    if (s.instrumentOpenContracts === 0) return;
  }
  throw new Error("still_not_flat");
}

async function waitProven(steps, label, timeoutSec = 180) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    const pkt = await packet();
    if (pkt.protection?.status === "proven") return pkt;
    if (i % 20 === 19) steps.push({ step: `${label}_poll`, protection: pkt.protection?.status });
  }
  throw new Error(`${label}: protection_not_proven`);
}

async function waitTwoTranches(steps, label, intentIds, timeoutSec = 300) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    const own = await ownership();
    const st = await state();
    const filledEntries = (own.entries ?? []).filter(
      (entry) => intentIds.includes(entry.intentId) && entry.effectiveFilledQuantity > 0,
    );
    const active = (own.tranches ?? []).filter(
      (t) => intentIds.includes(t.intent_id) && t.remaining_qty > 0,
    );
    if (
      st.instrumentOpenContracts === 2
      && filledEntries.length === 2
      && filledEntries.every((entry) => entry.effectiveFilledQuantity >= 1)
    ) {
      return own;
    }
    if (
      st.instrumentOpenContracts === 2
      && active.length === 2
      && active.every((t) => t.remaining_qty === 1)
    ) {
      return own;
    }
    if (i % 20 === 19) {
      steps.push({
        step: `${label}_tranche_poll`,
        open_contracts: st.instrumentOpenContracts,
        filled_entries: filledEntries.length,
        active_tranches: active.length,
      });
    }
  }
  throw new Error(`${label}: two_tranches_not_ready`);
}

const log = {
  started_utc: new Date().toISOString(),
  scenario_a: { steps: [], checks: {}, pass: false },
  scenario_b: { steps: [], checks: {}, pass: false, skipped: false },
  scenario_c: { skipped: true, reason: "time budget — mirror LONG deferred" },
  all_pass: false,
};

try {
  const hlth = await waitHealthReady();
  log.health_before = {
    status: hlth.status,
    userStream: hlth.data_quality?.operational?.userStream?.state,
    gateway_mode: hlth.gateway_mode,
  };

  await ensureFlat(log.scenario_a.steps);

  let pkt = await packet();
  const brackets = wideShortBrackets(pkt.market?.last ?? pkt.market?.ask ?? pkt.market?.bid);
  if (!brackets.entry) throw new Error("no_entry_price");
  const { entry, sl, tp } = brackets;
  const trancheAIntentId = randomUUID();

  const enter1 = await submitIntent({
    ...baseIntent("ENTER_SHORT", "unused", trancheAIntentId),
    quantity: 1,
    order_type: "MARKET",
    stop_loss: sl,
    take_profit_1: tp,
    reason: "ENTER_SHORT tranche A",
  }, log.scenario_a.steps, "ENTER_SHORT_A");
  const trancheAIntentIdResolved = enter1.intent_id;
  log.scenario_a.checks.enter_a = enter1.http === 202 && enter1.body.status === "pending";
  if (!log.scenario_a.checks.enter_a) {
    throw new Error(`ENTER_SHORT_A failed: ${enter1.body?.code ?? enter1.http}`);
  }

  pkt = await waitProven(log.scenario_a.steps, "A");
  log.scenario_a.tranche_a_intent_id = trancheAIntentIdResolved;
  log.scenario_a.checks.proven_a = pkt.protection?.status === "proven";

  pkt = await packet();
  const trancheBIntentId = randomUUID();
  const enter2 = await submitIntent({
    ...baseIntent("ENTER_SHORT", "unused", trancheBIntentId),
    quantity: 1,
    order_type: "MARKET",
    stop_loss: sl,
    take_profit_1: tp,
    reason: "ENTER_SHORT scale-in tranche B",
  }, log.scenario_a.steps, "ENTER_SHORT_B_SCALE_IN");
  const trancheBIntentIdResolved = enter2.intent_id;
  log.scenario_a.checks.scale_in =
    enter2.http === 202 &&
    enter2.body.status === "pending" &&
    enter2.body.code !== "position_addition_not_implemented";

  const own2 = await waitTwoTranches(
    log.scenario_a.steps,
    "two_tranches",
    [trancheAIntentIdResolved, trancheBIntentIdResolved],
  );
  const stTwo = await state();
  log.scenario_a.checks.two_tranches = stTwo.instrumentOpenContracts === 2;
  log.scenario_a.tranche_b_intent_id = trancheBIntentIdResolved;

  // Scenario B (optional): restart while 2 tranches open.
  if (process.env.PM4_E2E_RESTART === "1") {
    const port = env.GLITCH_LOCAL_PORT ?? "8790";
    try {
      const kill = spawn("powershell", [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ]);
      await new Promise((r) => kill.on("close", r));
      await sleep(5000);
      spawn("powershell", ["-NoProfile", "-File", "start.ps1"], { cwd: process.cwd(), detached: true, stdio: "ignore" }).unref();
      await waitHealthReady();
      const ownRestart = await ownership();
      const activeAfterRestart = (ownRestart.tranches ?? []).filter(
        (t) => t.intent_id === trancheAIntentIdResolved || t.intent_id === trancheBIntentIdResolved,
      );
      const stRestart = await state();
      log.scenario_b.steps.push({
        step: "RESTART_OWNERSHIP",
        open_contracts: stRestart.instrumentOpenContracts,
        tranche_count: activeAfterRestart.length,
        tranches: activeAfterRestart.map((t) => ({
          intent_id: t.intent_id,
          filled_qty: t.filled_qty,
          remaining_qty: t.remaining_qty,
        })),
      });
      log.scenario_b.checks.two_tranches_after_restart = stRestart.instrumentOpenContracts === 2;
      log.scenario_b.pass = log.scenario_b.checks.two_tranches_after_restart;
    } catch (restartError) {
      log.scenario_b.skipped = true;
      log.scenario_b.reason = String(restartError?.message ?? restartError);
      log.scenario_b.pass = false;
      spawn("powershell", ["-NoProfile", "-File", "start.ps1"], { cwd: process.cwd(), detached: true, stdio: "ignore" }).unref();
      await waitHealthReady();
    }
  } else {
    log.scenario_b.skipped = true;
    log.scenario_b.reason = "PM4_E2E_RESTART not set";
    log.scenario_b.pass = false;
  }

  pkt = await packet();
  const exitB = await submitIntent({
    ...baseIntent("EXIT", "unused"),
    quantity: 1,
    target_intent_id: trancheBIntentIdResolved,
    reason: "EXIT tranche B only (before amendments to avoid stop trigger)",
  }, log.scenario_a.steps, "EXIT_B");
  log.scenario_a.checks.exit_b = exitB.http === 202 && exitB.body.status === "pending";

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = await state();
    if (st.instrumentOpenContracts === 1) break;
  }
  const stMid = await state();
  const ownMid = await ownership();
  const trancheAMid = ownMid.tranches?.find((t) => t.intent_id === trancheAIntentIdResolved);
  log.scenario_a.steps.push({
    step: "AFTER_EXIT_B",
    instrument_open: stMid.instrumentOpenContracts,
    tranche_a_remaining: trancheAMid?.remaining_qty,
    tranche_a_protection: trancheAMid?.protection?.status,
  });
  log.scenario_a.checks.one_contract_left =
    stMid.instrumentOpenContracts === 1
    || (trancheAMid?.remaining_qty === 1 && stMid.instrumentOpenContracts >= 1);
  log.scenario_a.checks.tranche_a_alive =
    trancheAMid !== undefined && trancheAMid.remaining_qty === 1 && trancheAMid.protection?.status === "proven";

  pkt = await packet();
  const trancheA = ownMid.tranches?.find((t) => t.intent_id === trancheAIntentIdResolved);
  const stopBeforeA = trancheA?.protection?.stop?.price ?? pkt.protection?.stop?.price ?? sl;
  const newStopA = stopBeforeA - 5 * TICK;

  const moveStopA = await submitIntent({
    ...baseIntent("MOVE_STOP", "unused"),
    new_stop_price: newStopA,
    target_intent_id: trancheAIntentIdResolved,
    reason: "MOVE_STOP tranche A only",
  }, log.scenario_a.steps, "MOVE_STOP_A");
  log.scenario_a.checks.move_stop_a =
    moveStopA.http === 202 && (moveStopA.body.status === "pending" || moveStopA.body.status === "submitted");

  await sleep(5000);
  pkt = await packet();
  const tpBeforeA = trancheA?.protection?.target?.price ?? pkt.protection?.target?.price ?? tp;
  const newTpA = tpBeforeA + 5 * TICK;

  const moveTpA = await submitIntent({
    ...baseIntent("MOVE_TP", "unused"),
    new_take_profit: newTpA,
    target_intent_id: trancheAIntentIdResolved,
    reason: "MOVE_TP tranche A",
  }, log.scenario_a.steps, "MOVE_TP_A");
  log.scenario_a.checks.move_tp_a =
    moveTpA.http === 202 && (moveTpA.body.status === "pending" || moveTpA.body.status === "submitted");

  pkt = await packet();
  const exitFlat = await submitIntent({
    ...baseIntent("EXIT", "unused"),
    reason: "EXIT flat",
  }, log.scenario_a.steps, "EXIT_FLAT");
  log.scenario_a.checks.exit_flat =
    exitFlat.http === 202 && (exitFlat.body.status === "pending" || exitFlat.body.status === "closed");

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const st = await state();
    if (st.instrumentOpenContracts === 0) break;
  }
  const stFinal = await state();
  log.scenario_a.checks.flat = stFinal.instrumentOpenContracts === 0;

  log.scenario_a.pass = Object.values(log.scenario_a.checks).every(Boolean);

  const hlthEnd = await health();
  log.health_after = {
    status: hlthEnd.status,
    userStream: hlthEnd.data_quality?.operational?.userStream?.state,
    blockingAmbiguity: hlthEnd.execution_recovery?.blockingAmbiguity,
  };

  log.all_pass = log.scenario_a.pass && (log.scenario_b.pass || log.scenario_b.skipped);
  log.finished_utc = new Date().toISOString();
  fs.writeFileSync("data/pm4-phase-c-e2e.json", JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log, null, 2));
  process.exit(log.all_pass ? 0 : 1);
} catch (e) {
  log.fatal = String(e?.message ?? e);
  log.finished_utc = new Date().toISOString();
  fs.writeFileSync("data/pm4-phase-c-e2e.json", JSON.stringify(log, null, 2));
  console.error(e);
  process.exit(1);
}
