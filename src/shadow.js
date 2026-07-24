import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const intentsPath = path.join(dataDir, "intents.jsonl");

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function minutePacketId(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${iso}Z`;
}

function snapshotHash(seed) {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export function buildState() {
  return {
    schema_version: "glitch.topstep.state.v1",
    updated_utc: utcNow(),
    trading_mode: process.env.GLITCH_TOPSTEP_TRADING_MODE || "shadow",
    account: {
      name: process.env.GLITCH_TOPSTEP_ACCOUNT_ALIAS || "TopstepX-50K",
      canTrade: true,
      simulated: true,
      balance: 50250,
      unrealized_pnl: 0,
      conservative_equity: 50250,
      total_open_contracts: 0,
      instrument_open_contracts: 0,
    },
    contract: {
      name: process.env.GLITCH_TOPSTEP_CONTRACT || "MNQ U99",
      instrument: process.env.GLITCH_TOPSTEP_INSTRUMENT || "MNQ",
    },
  };
}

export function buildPacket(now = new Date()) {
  const stamp = utcNow();
  const packetId = minutePacketId(now);
  const last = 20000 + ((now.getUTCMinutes() % 10) - 5) * 0.5;
  const bid = last - 0.25;
  const ask = last + 0.25;
  const accountName = process.env.GLITCH_TOPSTEP_ACCOUNT_ALIAS || "TopstepX-50K";
  const instrument = process.env.GLITCH_TOPSTEP_INSTRUMENT || "MNQ";

  return {
    schema_version: "glitch.direct.decision_packet.v1",
    packet_id: packetId,
    created_utc: stamp,
    venue: "projectx",
    firm: "topstep",
    instrument,
    account: {
      id: 0,
      name: accountName,
      simulated: true,
      can_trade: true,
      balance: 50250,
      unrealized_pnl: 0,
      conservative_equity: 50250,
      total_open_contracts: 0,
      instrument_open_contracts: 0,
      working_orders: 0,
    },
    contract: {
      id: "CON.F.US.MNQ.U99",
      name: "MNQ U99",
      symbol_id: "F.US.MNQ",
      tick_size: 0.25,
      tick_value: 0.5,
    },
    market: {
      snapshot_hash: snapshotHash(`${packetId}:${last}`),
      quote_timestamp: stamp,
      last,
      bid,
      ask,
      spread_ticks: 2,
      session_open: 19950,
      session_high: 20020,
      session_low: 19920,
      volume: 1000,
    },
    policy: {
      program: "xfa",
      account_size: 50000,
      initial_max_loss: 2000,
      highest_end_of_day_balance: 50250,
      liquidation_floor: 48000,
      current_buffer: 2250,
      allowed_risk_usd: 50,
      max_contracts: 5,
      entry_window_open: true,
    },
    execution: {
      state_complete: true,
      entry_actions_enabled: true,
      valid_entry_quantities: [1, 2],
      authority: "Glitch validates and executes; Hermes proposes only",
    },
    required_output_template: {
      schema_version: "glitch.intent.v2",
      intent_id: "GENERATE_UUID",
      created_utc: stamp,
      instrument,
      account: accountName,
      operator_profile: "glitch-topstep",
      action: "NOTHING",
      confidence: 0.5,
      snapshot_hash: snapshotHash(`${packetId}:${last}`),
      model_version: "CONFIGURED_MODEL",
      prompt_version: "glitch-topstep-v1",
      reason: "Replace",
      decision_audit: {
        bull_case: "Replace",
        bear_case: "Replace",
        flat_case: "Replace",
        aggressive_case: "Replace",
        conservative_case: "Replace",
        decisive_evidence: "Replace",
        disconfirming_evidence: "Replace",
        change_condition: "Replace",
        final_choice: "NOTHING",
      },
    },
  };
}

export function handleIntent(intent, packet) {
  fs.mkdirSync(dataDir, { recursive: true });
  const record = {
    schema_version: "glitch.topstep.intent_receipt.v1",
    recorded_utc: utcNow(),
    trading_mode: process.env.GLITCH_TOPSTEP_TRADING_MODE || "shadow",
    accepted: true,
    shadow_only: (process.env.GLITCH_TOPSTEP_TRADING_MODE || "shadow") !== "armed",
    packet_id: packet.packet_id,
    intent,
  };
  fs.appendFileSync(intentsPath, `${JSON.stringify(record)}\n`, "utf8");
  return {
    schema_version: "glitch.topstep.intent_response.v1",
    status: "accepted",
    shadow: (process.env.GLITCH_TOPSTEP_TRADING_MODE || "shadow") !== "armed",
    message:
      (process.env.GLITCH_TOPSTEP_TRADING_MODE || "shadow") === "armed"
        ? "Intent forwarded to ProjectX."
        : "Intent recorded in shadow mode; no venue order submitted.",
    intent_id: intent.intent_id,
    packet_id: packet.packet_id,
  };
}
