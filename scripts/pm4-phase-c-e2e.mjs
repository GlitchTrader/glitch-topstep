import fs from "node:fs";
import path from "node:path";
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
const TICK = 0.25;

function gatewayPort() {
  return Number(env.GLITCH_LOCAL_PORT ?? 8790);
}

function apiBase() {
  return `http://127.0.0.1:${gatewayPort()}`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShell(command, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", command], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("powershell_timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", reject);
  });
}

async function isPortListening(port) {
  const { stdout } = await runPowerShell(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`,
  );
  return Number(stdout) > 0;
}

async function killGatewayOnPort(port) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!(await isPortListening(port))) return;
    await runPowerShell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    );
    await sleep(2000);
  }
  if (await isPortListening(port)) {
    throw new Error(`port_${port}_still_in_use`);
  }
}

async function startGatewayProcess(steps, label) {
  const port = gatewayPort();
  if (await isPortListening(port)) {
    steps.push({ step: `${label}_START_SKIPPED`, reason: "port_already_listening", port });
    return;
  }
  const cwd = psQuote(process.cwd());
  const dataDir = env.GLITCH_DATA_DIR ?? "data";
  const dataDirAbs = path.isAbsolute(dataDir) ? dataDir : path.join(process.cwd(), dataDir);
  const stdoutLog = psQuote(path.join(dataDirAbs, "gateway.stdout.log"));
  const stderrLog = psQuote(path.join(dataDirAbs, "gateway.stderr.log"));
  const dataDirQuoted = psQuote(dataDirAbs);
  // ponytail: skip npm build on E2E restart; mirror start.ps1 node launch with .env loaded
  const ps = `
Set-Location ${cwd}
Get-Content '.env' | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { return }
  $eq = $line.IndexOf('=')
  $name = $line.Substring(0, $eq).Trim()
  $value = $line.Substring($eq + 1).Trim()
  if ($name) { Set-Item -Path "env:$name" -Value $value }
}
New-Item -ItemType Directory -Force -Path ${dataDirQuoted} | Out-Null
Start-Process -FilePath 'node' -ArgumentList '--enable-source-maps','dist/src/index.js' -WorkingDirectory ${cwd} -WindowStyle Hidden -RedirectStandardOutput ${stdoutLog} -RedirectStandardError ${stderrLog}
`.trim();
  const { code, stderr } = await runPowerShell(ps);
  if (code !== 0) {
    throw new Error(`gateway_start_failed: exit=${code} stderr=${stderr}`);
  }
  steps.push({ step: `${label}_START_TRIGGERED`, port });
  await sleep(3000);
}

async function ensureGatewayUp(steps, label) {
  const port = gatewayPort();
  try {
    await health();
    steps.push({ step: `${label}_ALREADY_UP`, port });
  } catch {
    await startGatewayProcess(steps, label);
  }
  await waitHealthReady({ afterRestart: true });
  await waitReconciliationReady();
}
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

function wideShortBrackets(pkt) {
  const ask = alignTick(pkt.market?.ask ?? pkt.market?.last ?? pkt.market?.bid);
  if (!ask) return null;
  return {
    sl: alignTick(ask + 100 * TICK),
    tp: alignTick(ask - 100 * TICK),
  };
}

function wideLongBrackets(pkt) {
  const bid = alignTick(pkt.market?.bid ?? pkt.market?.last ?? pkt.market?.ask);
  if (!bid) return null;
  return {
    sl: alignTick(bid - 100 * TICK),
    tp: alignTick(bid + 100 * TICK),
  };
}

async function health() {
  const r = await fetch(`${apiBase()}/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}
async function packet() {
  const r = await fetch(`${apiBase()}/packet`, { headers: h });
  if (!r.ok) throw new Error(`packet ${r.status}`);
  return r.json();
}
async function state() {
  const r = await fetch(`${apiBase()}/state`, { headers: h });
  if (!r.ok) throw new Error(`state ${r.status}`);
  return r.json();
}
async function ownership() {
  const r = await fetch(`${apiBase()}/ownership`, { headers: h });
  if (!r.ok) throw new Error(`ownership ${r.status}`);
  return r.json();
}
async function postIntent(body) {
  const r = await fetch(`${apiBase()}/intent`, { method: "POST", headers: h, body: JSON.stringify(body) });
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
  for (let i = 0; i < 120; i++) {
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

async function submitIntent(body, steps, stepName, retries = 12) {
  let current = { ...body, intent_id: body.intent_id ?? randomUUID() };
  for (let attempt = 0; attempt < retries; attempt++) {
    await waitReconciliationReady();
    const pkt = await packet();
    if (current.stop_loss !== undefined) {
      const brackets = body.action === "ENTER_LONG"
        ? wideLongBrackets(pkt)
        : wideShortBrackets(pkt);
      if (brackets) {
        current.stop_loss = brackets.sl;
        current.take_profit_1 = brackets.tp;
      }
    }
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
    if (res.http === 202 && res.body.status !== "shadowed") {
      return { ...res, intent_id: current.intent_id };
    }
    if (
      res.body.code === "entry_verified_not_submitted"
      || res.body.code === "exit_verified_not_submitted"
      || res.body.code === "move_stop_verified_not_submitted"
      || res.body.code === "move_tp_verified_not_submitted"
    ) {
      current.intent_id = randomUUID();
      await sleep(2000);
      continue;
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
      || res.body.code === "execution_preparation_failed"
      || String(res.body.detail ?? "").includes("stop_not_on_loss_side")
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

async function waitHealthReady(options = {}) {
  const afterRestart = options.afterRestart === true;
  const maxIterations = afterRestart ? 180 : 120;
  const maxQuoteAgeMs = afterRestart ? 120_000 : 8_000;
  let lastSnapshot = null;
  let lastError = null;
  for (let i = 0; i < maxIterations; i++) {
    try {
      const hlth = await health();
      const us = hlth.data_quality?.operational?.userStream?.state;
      const quoteAge = hlth.data_quality?.quote_age_ms ?? 99999;
      lastSnapshot = {
        iteration: i,
        status: hlth.status,
        state_complete: hlth.data_quality?.state_complete ?? false,
        userStream: us ?? null,
        quote_age_ms: quoteAge,
        port_listening: await isPortListening(gatewayPort()),
      };
      if (
        hlth.status === "ok"
        && hlth.data_quality?.state_complete
        && us === "connected"
        && quoteAge < maxQuoteAgeMs
      ) {
        return hlth;
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
      lastSnapshot = {
        iteration: i,
        fetch_error: lastError,
        port_listening: await isPortListening(gatewayPort()).catch(() => null),
      };
    }
    await sleep(2000);
  }
  throw new Error(`health_not_ready:${JSON.stringify({ lastSnapshot, lastError })}`);
}

async function restartGateway(steps, label) {
  const port = gatewayPort();
  steps.push({ step: `${label}_RESTART_TRIGGERED`, port });
  await killGatewayOnPort(port);
  await sleep(2000);
  await startGatewayProcess(steps, label);
  await waitHealthReady({ afterRestart: true });
  await waitReconciliationReady();
}

async function waitNoWorkingOrders(steps, label, timeoutSec = 120) {
  for (let i = 0; i < timeoutSec; i++) {
    const own = await ownership();
    const working = own.working_orders ?? 0;
    if (working === 0) return;
    if (i % 15 === 14) {
      steps.push({ step: `${label}_working_poll`, working_orders: working });
    }
    await sleep(1000);
  }
  const own = await ownership();
  throw new Error(`working_orders_still_open:${own.working_orders ?? "unknown"}`);
}

async function ensureFlat(steps) {
  let st = await state();
  let own = await ownership();
  if (st.instrumentOpenContracts === 0 && (own.working_orders ?? 0) === 0) return;
  if (st.instrumentOpenContracts !== 0) {
    const res = await submitIntent(
      { ...baseIntent("EXIT", "unused"), reason: "PRE_EXIT flat" },
      steps,
      "PRE_EXIT",
    );
    if (res.http !== 202) throw new Error("PRE_EXIT failed");
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      st = await state();
      if (st.instrumentOpenContracts === 0) break;
    }
    if (st.instrumentOpenContracts !== 0) throw new Error("still_not_flat");
  }
  await waitNoWorkingOrders(steps, "PRE_FLAT");
}

async function waitArmedPacket(steps, label, timeoutSec = 180) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    try {
      await waitReconciliationReady();
    } catch {
      // keep polling
    }
    const pkt = await packet();
    if (pkt.execution?.gateway_mode === "armed") {
      return pkt;
    }
    if (i % 15 === 14) {
      steps.push({ step: `${label}_armed_poll`, gateway_mode: pkt.execution?.gateway_mode });
    }
  }
  throw new Error(`${label}: gateway_not_armed`);
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

async function runTrancheScenario(scenario, {
  prefix,
  enterAction,
  moveStopDelta,
  moveTpDelta,
  onTwoTranches,
}) {
  const { steps, checks } = scenario;
  let pkt = await packet();
  const brackets = enterAction === "ENTER_LONG" ? wideLongBrackets(pkt) : wideShortBrackets(pkt);
  if (!brackets) throw new Error(`${prefix}: no_entry_price`);
  const { sl, tp } = brackets;
  const trancheAIntentId = randomUUID();

  const enter1 = await submitIntent({
    ...baseIntent(enterAction, "unused", trancheAIntentId),
    quantity: 1,
    order_type: "MARKET",
    stop_loss: sl,
    take_profit_1: tp,
    reason: `${enterAction} tranche A`,
  }, steps, `${prefix}_ENTER_A`);
  const trancheAIntentIdResolved = enter1.intent_id;
  checks.enter_a = enter1.http === 202 && enter1.body.status === "pending";
  if (!checks.enter_a) {
    throw new Error(`${prefix}_ENTER_A failed: ${enter1.body?.code ?? enter1.http}`);
  }

  pkt = await waitProven(steps, `${prefix}_A`);
  scenario.tranche_a_intent_id = trancheAIntentIdResolved;
  checks.proven_a = pkt.protection?.status === "proven";

  pkt = await waitArmedPacket(steps, `${prefix}_ARMED`);
  await sleep(8000);
  const trancheBIntentId = randomUUID();
  const enter2 = await submitIntent({
    ...baseIntent(enterAction, "unused", trancheBIntentId),
    quantity: 1,
    order_type: "MARKET",
    stop_loss: sl,
    take_profit_1: tp,
    reason: `${enterAction} scale-in tranche B`,
  }, steps, `${prefix}_SCALE_IN`, 24);
  const trancheBIntentIdResolved = enter2.intent_id;
  checks.scale_in =
    enter2.http === 202
    && enter2.body.status === "pending"
    && enter2.body.code !== "position_addition_not_implemented";

  await waitTwoTranches(steps, `${prefix}_two_tranches`, [
    trancheAIntentIdResolved,
    trancheBIntentIdResolved,
  ]);
  const stTwo = await state();
  checks.two_tranches = stTwo.instrumentOpenContracts === 2;
  scenario.tranche_b_intent_id = trancheBIntentIdResolved;

  if (onTwoTranches) {
    await onTwoTranches(trancheAIntentIdResolved, trancheBIntentIdResolved);
  }

  const exitB = await submitIntent({
    ...baseIntent("EXIT", "unused"),
    quantity: 1,
    target_intent_id: trancheBIntentIdResolved,
    reason: "EXIT tranche B only",
  }, steps, `${prefix}_EXIT_B`);
  checks.exit_b = exitB.http === 202 && exitB.body.status === "pending";

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = await state();
    if (st.instrumentOpenContracts === 1) break;
  }
  const stMid = await state();
  const ownMid = await ownership();
  const trancheAMid = ownMid.tranches?.find((t) => t.intent_id === trancheAIntentIdResolved);
  steps.push({
    step: `${prefix}_AFTER_EXIT_B`,
    instrument_open: stMid.instrumentOpenContracts,
    tranche_a_remaining: trancheAMid?.remaining_qty,
    tranche_a_protection: trancheAMid?.protection?.status,
  });
  checks.one_contract_left =
    stMid.instrumentOpenContracts === 1
    || (trancheAMid?.remaining_qty === 1 && stMid.instrumentOpenContracts >= 1);
  checks.tranche_a_alive =
    trancheAMid !== undefined
    && trancheAMid.remaining_qty === 1
    && trancheAMid.protection?.status === "proven";

  pkt = await packet();
  const trancheA = ownMid.tranches?.find((t) => t.intent_id === trancheAIntentIdResolved);
  const stopBeforeA = trancheA?.protection?.stop?.price ?? pkt.protection?.stop?.price ?? sl;
  const newStopA = stopBeforeA + moveStopDelta;

  const moveStopA = await submitIntent({
    ...baseIntent("MOVE_STOP", "unused"),
    new_stop_price: newStopA,
    target_intent_id: trancheAIntentIdResolved,
    reason: "MOVE_STOP tranche A only",
  }, steps, `${prefix}_MOVE_STOP_A`);
  checks.move_stop_a =
    moveStopA.http === 202
    && (moveStopA.body.status === "pending" || moveStopA.body.status === "submitted");

  await sleep(5000);
  pkt = await packet();
  const tpBeforeA = trancheA?.protection?.target?.price ?? pkt.protection?.target?.price ?? tp;
  const newTpA = tpBeforeA + moveTpDelta;

  const moveTpA = await submitIntent({
    ...baseIntent("MOVE_TP", "unused"),
    new_take_profit: newTpA,
    target_intent_id: trancheAIntentIdResolved,
    reason: "MOVE_TP tranche A",
  }, steps, `${prefix}_MOVE_TP_A`);
  checks.move_tp_a =
    moveTpA.http === 202
    && (moveTpA.body.status === "pending" || moveTpA.body.status === "submitted");

  const exitFlat = await submitIntent({
    ...baseIntent("EXIT", "unused"),
    reason: "EXIT flat",
  }, steps, `${prefix}_EXIT_FLAT`);
  checks.exit_flat =
    exitFlat.http === 202
    && (exitFlat.body.status === "pending" || exitFlat.body.status === "closed");

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const st = await state();
    if (st.instrumentOpenContracts === 0) break;
  }
  const stFinal = await state();
  checks.flat = stFinal.instrumentOpenContracts === 0;
  scenario.pass = Object.values(checks).every(Boolean);
}

const log = {
  started_utc: new Date().toISOString(),
  scenario_a: { steps: [], checks: {}, pass: false },
  scenario_b: { steps: [], checks: {}, pass: false, skipped: false },
  scenario_c: { steps: [], checks: {}, pass: false, skipped: false },
  all_pass: false,
};

try {
  const hlth = await waitHealthReady();
  await waitReconciliationReady();
  log.health_before = {
    status: hlth.status,
    userStream: hlth.data_quality?.operational?.userStream?.state,
    gateway_mode: hlth.gateway_mode,
  };

  await ensureFlat(log.scenario_a.steps);

  const runRestart = process.env.PM4_E2E_RESTART === "1";
  await runTrancheScenario(log.scenario_a, {
    prefix: "SHORT",
    enterAction: "ENTER_SHORT",
    moveStopDelta: -5 * TICK,
    moveTpDelta: 5 * TICK,
    onTwoTranches: runRestart
      ? async (trancheAId, trancheBId) => {
          log.scenario_b.skipped = false;
          try {
            await restartGateway(log.scenario_b.steps, "SCENARIO_B");
            await waitTwoTranches(
              log.scenario_b.steps,
              "restart_tranches",
              [trancheAId, trancheBId],
              300,
            );
            const ownRestart = await ownership();
            const activeAfterRestart = (ownRestart.tranches ?? []).filter(
              (t) => t.intent_id === trancheAId || t.intent_id === trancheBId,
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
                protection: t.protection?.status,
              })),
            });
            log.scenario_b.checks.two_tranches_after_restart = stRestart.instrumentOpenContracts === 2;
            log.scenario_b.checks.ownership_two_tranches =
              activeAfterRestart.length === 2
              && activeAfterRestart.every((t) => t.remaining_qty === 1);
            log.scenario_b.pass = Object.values(log.scenario_b.checks).every(Boolean);
          } catch (restartError) {
            log.scenario_b.reason = String(restartError?.message ?? restartError);
            log.scenario_b.pass = false;
            try {
              await ensureGatewayUp(log.scenario_b.steps, "SCENARIO_B_RECOVERY");
            } catch (recoveryError) {
              log.scenario_b.recovery_error = String(recoveryError?.message ?? recoveryError);
            }
          }
        }
      : undefined,
  });

  if (!runRestart) {
    log.scenario_b.skipped = true;
    log.scenario_b.reason = "PM4_E2E_RESTART not set";
    log.scenario_b.pass = false;
  }

  if (process.env.PM4_E2E_SKIP_C === "1") {
    log.scenario_c.skipped = true;
    log.scenario_c.reason = "PM4_E2E_SKIP_C set";
    log.scenario_c.pass = false;
  } else {
    await ensureFlat(log.scenario_c.steps);
    await runTrancheScenario(log.scenario_c, {
      prefix: "LONG",
      enterAction: "ENTER_LONG",
      moveStopDelta: 5 * TICK,
      moveTpDelta: 5 * TICK,
    });
  }

  const hlthEnd = await health();
  log.health_after = {
    status: hlthEnd.status,
    userStream: hlthEnd.data_quality?.operational?.userStream?.state,
    blockingAmbiguity: hlthEnd.execution_recovery?.blockingAmbiguity,
  };

  log.all_pass =
    log.scenario_a.pass
    && (log.scenario_b.pass || log.scenario_b.skipped)
    && (log.scenario_c.pass || log.scenario_c.skipped);
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
