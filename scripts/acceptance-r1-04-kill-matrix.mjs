/**
 * TS-R1-04: real ProjectX PRAC kill-matrix acceptance (operator-approved #49).
 * Proves at most one provider entry per intent_id across kill/restart/replay.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KILL_EXIT_CODE = 73;
const TICK = 0.25;
const WIDE_BRACKET_TICKS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KILL_POINTS = [
  "after_intent_before_outbox",
  "after_prepared_before_provider",
  "after_submitting_before_transport",
  "after_accept_before_submitted",
  "after_submitted_before_receipt",
  "after_receipt_before_jsonl",
];

const INTENT_BY_POINT = Object.fromEntries(
  KILL_POINTS.map((point, index) => [
    point,
    `00000000-0000-4000-8000-${(0xa041 + index).toString(16).padStart(12, "0")}`,
  ]),
);
const CONFLICT_INTENT_ID = "00000000-0000-4000-8000-00000000a099";

for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const name = trimmed.slice(0, eq);
  if (process.env[name] === undefined) {
    process.env[name] = trimmed.slice(eq + 1);
  }
}

const env = process.env;
const token = env.GLITCH_LOCAL_TOKEN;
const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

function gatewayPort() {
  return Number(env.GLITCH_LOCAL_PORT ?? 8790);
}
function apiBase() {
  return `http://127.0.0.1:${gatewayPort()}`;
}
function dataDirAbs() {
  const dataDir = env.GLITCH_DATA_DIR ?? "data";
  return path.isAbsolute(dataDir) ? dataDir : path.join(ROOT, dataDir);
}
function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isTcpPortOpen(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function runPowerShell(command, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", command], {
      cwd: ROOT,
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

async function killGatewayOnPort(port) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!(await isTcpPortOpen(port))) return;
    await runPowerShell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    );
    await sleep(1500);
  }
  if (await isTcpPortOpen(port)) {
    throw new Error(`port_${port}_still_in_use`);
  }
}

function gatewayChildEnv(extra = {}) {
  const childEnv = { ...process.env, ...env, ...extra };
  for (const key of Object.keys(extra)) {
    if (extra[key] === undefined || extra[key] === null) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

async function startGateway(steps, label, extraEnv = {}) {
  const port = gatewayPort();
  if (await isTcpPortOpen(port)) {
    throw new Error(`start_gateway_port_busy:${label}`);
  }
  const dataDir = dataDirAbs();
  fs.mkdirSync(dataDir, { recursive: true });
  const stdoutLog = path.join(dataDir, "gateway.stdout.log");
  const stderrLog = path.join(dataDir, "gateway.stderr.log");
  const outFd = fs.openSync(stdoutLog, "a");
  const errFd = fs.openSync(stderrLog, "a");
  const child = spawn("node", ["--enable-source-maps", "dist/src/index.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: gatewayChildEnv(extraEnv),
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  steps.push({
    step: `${label}_GATEWAY_START`,
    pid: child.pid,
    kill_point: extraEnv.GLITCH_KILL_POINT ?? null,
    recorded_utc: new Date().toISOString(),
  });
  await sleep(4000);
}

async function health() {
  const r = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`health_${r.status}`);
  return r.json();
}

async function packet() {
  const r = await fetch(`${apiBase()}/packet`, { headers: h, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`packet_${r.status}`);
  return r.json();
}

async function state() {
  const r = await fetch(`${apiBase()}/state`, { headers: h, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`state_${r.status}`);
  return r.json();
}

async function postIntent(body) {
  const r = await fetch(`${apiBase()}/intent`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { http: r.status, body: parsed };
}

function alignTick(price) {
  return Math.round(price / TICK) * TICK;
}

function wideLongBrackets(pkt) {
  const bid = alignTick(pkt.market?.bid ?? pkt.market?.last ?? pkt.market?.ask);
  if (!bid) return null;
  return {
    sl: alignTick(bid - WIDE_BRACKET_TICKS * TICK),
    tp: alignTick(bid + WIDE_BRACKET_TICKS * TICK),
  };
}

const audit = (fc) => ({
  bull_case: "r1-04-kill-matrix",
  bear_case: "r1-04-kill-matrix",
  flat_case: "r1-04-kill-matrix",
  aggressive_case: "r1-04-kill-matrix",
  conservative_case: "r1-04-kill-matrix",
  decisive_evidence: "r1-04-kill-matrix",
  disconfirming_evidence: "r1-04-kill-matrix",
  change_condition: "r1-04-kill-matrix",
  final_choice: fc,
});

function buildEntryIntent(intentId, pkt, killPoint) {
  const brackets = wideLongBrackets(pkt);
  if (!brackets) throw new Error("no_brackets");
  return {
    schema_version: "glitch.intent.v2",
    intent_id: intentId,
    created_utc: new Date().toISOString(),
    instrument: env.GLITCH_INSTRUMENT,
    account: env.GLITCH_ACCOUNT_NAME,
    operator_profile: "glitch-topstep",
    action: "ENTER_LONG",
    confidence: 0.6,
    snapshot_hash: pkt.market.snapshot_hash,
    model_version: "r1-04-kill-matrix",
    prompt_version: "glitch-topstep-v9",
    reason: `TS-R1-04 kill ${killPoint}`,
    decision_audit: audit("ENTER_LONG"),
    quantity: 1,
    order_type: "MARKET",
    stop_loss: brackets.sl,
    take_profit_1: brackets.tp,
  };
}

function entryCustomTag(intentId) {
  return `glt-${intentId}`.slice(0, 64);
}

function countEntryOrders(st, intentId) {
  const tag = entryCustomTag(intentId);
  const orders = st?.openOrders ?? st?.open_orders ?? [];
  return (Array.isArray(orders) ? orders : []).filter((order) => order.customTag === tag).length;
}

async function waitHealthReady(afterRestart = false) {
  const max = afterRestart ? 180 : 90;
  const maxQuoteAge = afterRestart ? 120_000 : 15_000;
  for (let i = 0; i < max; i++) {
    try {
      const hlth = await health();
      const us = hlth.data_quality?.operational?.userStream?.state;
      const quoteAge = hlth.data_quality?.quote_age_ms ?? 999_999;
      if (
        hlth.gateway_mode === "armed"
        && hlth.data_quality?.state_complete
        && us === "connected"
        && quoteAge < maxQuoteAge
      ) {
        return hlth;
      }
    } catch {
      // retry
    }
    await sleep(2000);
  }
  throw new Error("health_not_ready");
}

async function waitPacketReady() {
  for (let i = 0; i < 120; i++) {
    const pkt = await packet();
    const dq = pkt.data_quality ?? {};
    if (dq.reconciliation_state === "succeeded" && dq.reconciliation_generation === dq.generation) {
      return pkt;
    }
    await sleep(500);
  }
  throw new Error("packet_not_ready");
}

async function waitPortClosed(port, timeoutSec = 30) {
  for (let i = 0; i < timeoutSec; i++) {
    if (!(await isTcpPortOpen(port))) return;
    await sleep(1000);
  }
  throw new Error("gateway_port_still_open_after_kill");
}

async function cancelOpenOrders(steps, label) {
  const script = path.join(ROOT, "scripts", "cancel-open-orders.mjs");
  if (!fs.existsSync(script)) return;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: gatewayChildEnv(),
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label}_cancel_${code}`))));
    child.on("error", reject);
  });
  steps.push({ step: `${label}_CANCEL_ORDERS`, recorded_utc: new Date().toISOString() });
  await sleep(3000);
}

async function clearOrphanEntryLatch() {
  const db = new DatabaseSync(path.join(dataDirAbs(), "glitch-topstep.sqlite"));
  db.prepare(`
    DELETE FROM runtime_meta
    WHERE key = 'entry_submission_latch'
      AND value NOT IN (SELECT intent_id FROM execution_outbox)
  `).run();
  db.close();
}

async function resolveTestKillAmbiguity(intentId, steps, label) {
  const st = await state();
  if (countEntryOrders(st, intentId) > 0) {
    return false;
  }
  const db = new DatabaseSync(path.join(dataDirAbs(), "glitch-topstep.sqlite"));
  const row = db.prepare("SELECT state FROM execution_outbox WHERE intent_id = ?").get(intentId);
  if (!row || !["ambiguous", "submitting"].includes(String(row.state))) {
    db.close();
    return true;
  }
  const atUtc = new Date().toISOString();
  // ponytail: acceptance harness only; provider flat + zero tagged orders proves no submit
  db.prepare(`
    UPDATE execution_outbox
    SET state = 'confirmed_not_submitted', resolved_utc = ?, last_error = NULL
    WHERE intent_id = ? AND state IN ('ambiguous', 'submitting')
  `).run(atUtc, intentId);
  db.prepare(
    "DELETE FROM runtime_meta WHERE key = 'entry_submission_latch' AND value = ?",
  ).run(intentId);
  db.close();
  steps.push({ step: `${label}_RESOLVE_AMBIGUITY`, intent_id: intentId, recorded_utc: atUtc });
  return true;
}

async function waitRecoveryClear(label) {
  for (let i = 0; i < 180; i++) {
    try {
      const hlth = await health();
      const recovery = hlth.execution_recovery ?? {};
      if (
        !recovery.blockingAmbiguity
        && !recovery.blockingNewExposure
        && (recovery.unresolvedMutations ?? 0) === 0
        && (recovery.ambiguousMutations ?? 0) === 0
      ) {
        return hlth;
      }
    } catch {
      // gateway restarting
    }
    await sleep(2000);
  }
  throw new Error(`recovery_not_clear:${label}`);
}

async function restartCleanGateway(steps, label) {
  await killGatewayOnPort(gatewayPort());
  await startGateway(steps, label);
  await waitHealthReady(true);
  await clearOrphanEntryLatch();
  await waitRecoveryClear(label);
}

async function ensureFlat(steps, label = "FLAT") {
  let st = await state();
  if (st.instrumentOpenContracts !== 0) {
    const pkt = await waitPacketReady();
    const exitBody = {
      schema_version: "glitch.intent.v2",
      intent_id: `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`,
      created_utc: new Date().toISOString(),
      instrument: env.GLITCH_INSTRUMENT,
      account: env.GLITCH_ACCOUNT_NAME,
      operator_profile: "glitch-topstep",
      action: "EXIT",
      confidence: 0.6,
      snapshot_hash: pkt.market.snapshot_hash,
      model_version: "r1-04-kill-matrix",
      prompt_version: "glitch-topstep-v9",
      reason: `${label} flatten`,
      decision_audit: audit("EXIT"),
    };
    const res = await postIntent(exitBody);
    steps.push({ step: `${label}_EXIT`, http: res.http, status: res.body.status, code: res.body.code });
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      st = await state();
      if (st.instrumentOpenContracts === 0) break;
    }
  }
  st = await state();
  const openOrders = (st.openOrders ?? []).length;
  if (openOrders > 0) {
    await cancelOpenOrders(steps, label);
  }
  for (let i = 0; i < 60; i++) {
    st = await state();
    if (st.instrumentOpenContracts === 0 && (st.openOrders ?? []).length === 0) {
      steps.push({ step: `${label}_FLAT_OK`, recorded_utc: new Date().toISOString() });
      return;
    }
    await sleep(1000);
  }
  throw new Error(`${label}_not_flat`);
}

async function runKillPoint(killPoint, steps, cases) {
  const intentId = INTENT_BY_POINT[killPoint];
  const caseRecord = {
    kill_point: killPoint,
    intent_id: intentId,
    custom_tag: entryCustomTag(intentId),
    proof_passed: false,
    proof_failures: [],
  };
  cases.push(caseRecord);

  await ensureFlat(steps, `${killPoint}_PRE`);
  await restartCleanGateway(steps, `${killPoint}_PRE_CLEAR`);

  await killGatewayOnPort(gatewayPort());
  await startGateway(steps, killPoint, { GLITCH_KILL_POINT: killPoint });
  await waitHealthReady(true);
  const pkt = await waitPacketReady();
  const frozenBody = buildEntryIntent(intentId, pkt, killPoint);

  let killSubmit = { http: null, error: null, body: null };
  try {
    killSubmit = await postIntent(frozenBody);
  } catch (error) {
    killSubmit.error = String(error?.message ?? error);
  }
  caseRecord.kill_submit = killSubmit;
  steps.push({ step: `${killPoint}_KILL_SUBMIT`, ...killSubmit });

  try {
    await waitPortClosed(gatewayPort(), 45);
    caseRecord.gateway_killed = true;
  } catch (error) {
    caseRecord.gateway_killed = false;
    caseRecord.proof_failures.push("gateway_not_killed");
    caseRecord.kill_error = String(error?.message ?? error);
    if (killSubmit.http === 422) {
      caseRecord.proof_failures.push("kill_point_not_reached");
    }
  }

  await killGatewayOnPort(gatewayPort());
  await startGateway(steps, `${killPoint}_RECOVERY`);
  await waitHealthReady(true);

  const beforeReplay = await state();
  caseRecord.provider_entry_orders_before_replay = countEntryOrders(beforeReplay, intentId);

  const replay = await postIntent(frozenBody);
  caseRecord.replay_submit = { http: replay.http, status: replay.body.status, code: replay.body.code };
  steps.push({ step: `${killPoint}_REPLAY`, ...caseRecord.replay_submit });
  await sleep(5000);

  const afterReplay = await state();
  caseRecord.provider_entry_orders_after_replay = countEntryOrders(afterReplay, intentId);
  caseRecord.open_contracts_after_replay = afterReplay.instrumentOpenContracts;

  if (caseRecord.provider_entry_orders_after_replay > 1) {
    caseRecord.proof_failures.push("duplicate_provider_entry_orders");
  }
  if (caseRecord.provider_entry_orders_after_replay > caseRecord.provider_entry_orders_before_replay + 1) {
    caseRecord.proof_failures.push("replay_created_extra_entry");
  }

  await ensureFlat(steps, `${killPoint}_POST`);
  await resolveTestKillAmbiguity(intentId, steps, `${killPoint}_POST`);
  await restartCleanGateway(steps, `${killPoint}_RECOVERY_CLEAR`);
  caseRecord.proof_passed = caseRecord.proof_failures.length === 0
    && caseRecord.gateway_killed !== false
    && caseRecord.provider_entry_orders_after_replay <= 1;
  return caseRecord;
}

async function runBodyConflict(steps, cases) {
  await restartCleanGateway(steps, "CONFLICT_PRE_CLEAR");
  await ensureFlat(steps, "CONFLICT_PRE");
  const pkt = await waitPacketReady();
  const base = buildEntryIntent(CONFLICT_INTENT_ID, pkt, "body_conflict");
  const first = await postIntent(base);
  const second = await postIntent({
    ...base,
    stop_loss: alignTick(base.stop_loss - 10 * TICK),
    created_utc: new Date().toISOString(),
  });
  const record = {
    test: "body_conflict",
    intent_id: CONFLICT_INTENT_ID,
    first: { http: first.http, code: first.body.code, status: first.body.status },
    second: { http: second.http, code: second.body.code, status: second.body.status },
    proof_passed: second.body.code === "intent_body_conflict",
    proof_failures: second.body.code === "intent_body_conflict" ? [] : ["expected_intent_body_conflict"],
  };
  cases.push(record);
  steps.push({ step: "BODY_CONFLICT", ...record });
  await ensureFlat(steps, "CONFLICT_POST");
  return record;
}

async function main() {
  if (!token) throw new Error("GLITCH_LOCAL_TOKEN missing");
  const steps = [];
  const cases = [];
  const capturedUtc = new Date().toISOString();
  const dataDir = dataDirAbs();

  steps.push({
    step: "SESSION_START",
    captured_utc: capturedUtc,
    gateway_version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
    account_id: env.GLITCH_ACCOUNT_ID,
    account_name: env.GLITCH_ACCOUNT_NAME,
    contract_id: env.GLITCH_CONTRACT_ID,
  });

  await killGatewayOnPort(gatewayPort());
  await startGateway(steps, "SESSION_BASELINE");
  await waitHealthReady(true);

  for (const killPoint of KILL_POINTS) {
    console.log(`[r1-04] kill point ${killPoint}`);
    await runKillPoint(killPoint, steps, cases);
  }

  console.log("[r1-04] body conflict");
  await runBodyConflict(steps, cases);

  await ensureFlat(steps, "SESSION_END");

  const proof = {
    schema_version: "glitch.projectx.r1_04_kill_proof.v1",
    captured_utc: capturedUtc,
    mode: "live_prac_acceptance",
    scope: {
      account_id: Number(env.GLITCH_ACCOUNT_ID),
      account_name: env.GLITCH_ACCOUNT_NAME,
      contract_id: env.GLITCH_CONTRACT_ID,
      instrument: env.GLITCH_INSTRUMENT,
    },
    database_fingerprints: {
      execution_sqlite_bytes: fs.statSync(path.join(dataDir, "glitch-topstep.sqlite")).size,
      execution_sqlite_sha256: sha256File(path.join(dataDir, "glitch-topstep.sqlite")),
      evidence_sqlite_bytes: fs.statSync(path.join(dataDir, "projectx-evidence.sqlite")).size,
      evidence_sqlite_sha256: sha256File(path.join(dataDir, "projectx-evidence.sqlite")),
    },
    cases,
    steps,
    proof_passed: cases.every((entry) => entry.proof_passed),
    proof_failures: cases.flatMap((entry) => entry.proof_failures ?? []),
  };

  const outDir = path.join(ROOT, "tests", "fixtures", "projectx", "live");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "r1_04_kill_matrix_proof.json");
  fs.writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);

  const manifestPath = path.join(outDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files = [
      ...manifest.files.filter((entry) => entry.name !== "r1_04_kill_matrix_proof"),
      { name: "r1_04_kill_matrix_proof", path: path.relative(ROOT, outPath) },
    ];
    manifest.captured_utc = capturedUtc;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`proof_written=${outPath}`);
  console.log(`proof_passed=${proof.proof_passed}`);
  if (!proof.proof_passed) {
    console.error(`proof_failures=${proof.proof_failures.join(",")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
