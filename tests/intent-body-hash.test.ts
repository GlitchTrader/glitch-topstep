import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeIntentBodyHash } from "../src/domain/intent-body-hash.js";
import { parseTradeIntent } from "../src/domain/intents.js";

describe("intent body hash", () => {
  it("is stable for the same semantic intent", () => {
    const input = {
      schema_version: "glitch.intent.v2",
      intent_id: "00000000-0000-4000-8000-000000000501",
      created_utc: "2026-07-27T12:00:00Z",
      instrument: "MNQ",
      account: "TEST_ACCOUNT",
      operator_profile: "glitch-topstep",
      action: "ENTER_LONG",
      confidence: 0.6,
      snapshot_hash: "snapshot-hash",
      model_version: "test",
      prompt_version: "glitch-topstep-v14",
      reason: "Stable hash.",
      decision_audit: {
        bull_case: "Bull case.",
        bear_case: "Bear case.",
        flat_case: "Flat case.",
        aggressive_case: "Aggressive case.",
        conservative_case: "Conservative case.",
        decisive_evidence: "Evidence.",
        disconfirming_evidence: "Counter evidence.",
        change_condition: "Change condition.",
        final_choice: "ENTER_LONG",
      },
      quantity: 1,
      order_type: "MARKET",
      stop_loss: 19_990.25,
      take_profit_1: 20_020.25,
    };
    const first = parseTradeIntent(input);
    const second = parseTradeIntent({ ...input });
    assert.equal(computeIntentBodyHash(first), computeIntentBodyHash(second));
  });

  it("changes when semantic fields change", () => {
    const base = {
      schema_version: "glitch.intent.v2",
      intent_id: "00000000-0000-4000-8000-000000000502",
      created_utc: "2026-07-27T12:00:00Z",
      instrument: "MNQ",
      account: "TEST_ACCOUNT",
      operator_profile: "glitch-topstep",
      action: "ENTER_LONG",
      confidence: 0.6,
      snapshot_hash: "snapshot-hash",
      model_version: "test",
      prompt_version: "glitch-topstep-v14",
      reason: "First reason.",
      decision_audit: {
        bull_case: "Bull case.",
        bear_case: "Bear case.",
        flat_case: "Flat case.",
        aggressive_case: "Aggressive case.",
        conservative_case: "Conservative case.",
        decisive_evidence: "Evidence.",
        disconfirming_evidence: "Counter evidence.",
        change_condition: "Change condition.",
        final_choice: "ENTER_LONG",
      },
      quantity: 1,
      order_type: "MARKET",
      stop_loss: 19_990.25,
      take_profit_1: 20_020.25,
    };
    const first = parseTradeIntent(base);
    const second = parseTradeIntent({ ...base, reason: "Second reason." });
    assert.notEqual(computeIntentBodyHash(first), computeIntentBodyHash(second));
  });
});
