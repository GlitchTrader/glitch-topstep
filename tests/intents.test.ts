import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTradeIntent } from "../src/domain/intents.js";

function baseIntent() {
  return {
    schema_version: "glitch.intent.v2",
    intent_id: "00000000-0000-4000-8000-000000000001",
    created_utc: "2026-07-21T12:00:00Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operator_profile: "glitch-topstep",
    action: "NOTHING",
    confidence: 0.5,
    snapshot_hash: "snapshot",
    model_version: "test",
    prompt_version: "glitch-topstep-v9",
    reason: "No edge.",
    decision_audit: {
      bull_case: "Limited bullish evidence.",
      bear_case: "Limited bearish evidence.",
      flat_case: "No clear advantage.",
      aggressive_case: "A probe is unsupported.",
      conservative_case: "Remain flat.",
      decisive_evidence: "No directional edge.",
      disconfirming_evidence: "A breakout would change this.",
      change_condition: "Reassess after structural change.",
      final_choice: "NOTHING",
    },
  };
}

describe("Glitch intent contract", () => {
  it("accepts a strict no-action intent", () => {
    assert.equal(parseTradeIntent(baseIntent()).action, "NOTHING");
  });

  it("accepts a protected market entry", () => {
    const input = baseIntent();
    const entry = {
      ...input,
      action: "ENTER_LONG",
      quantity: 1,
      order_type: "MARKET",
      stop_loss: 19_990,
      take_profit_1: 20_020,
      decision_audit: { ...input.decision_audit, final_choice: "ENTER_LONG" },
    };
    assert.equal(parseTradeIntent(entry).quantity, 1);
  });

  it("rejects unknown fields, profile mismatches, prompt mismatches, and choice mismatches", () => {
    assert.throws(() => parseTradeIntent({ ...baseIntent(), surprise: true }), /unknown_intent_field/);
    assert.throws(
      () => parseTradeIntent({ ...baseIntent(), operator_profile: "glitch-toptrader" }),
      /operator_profile_mismatch/,
    );
    assert.throws(
      () => parseTradeIntent({ ...baseIntent(), prompt_version: "glitch-topstep-v1" }),
      /prompt_version_mismatch/,
    );
    const mismatch = baseIntent();
    mismatch.decision_audit.final_choice = "HOLD";
    assert.throws(() => parseTradeIntent(mismatch), /final_choice must equal action/);
  });

  it("rejects unprotected entries", () => {
    const input = baseIntent();
    assert.throws(() => parseTradeIntent({
      ...input,
      action: "ENTER_LONG",
      decision_audit: { ...input.decision_audit, final_choice: "ENTER_LONG" },
    }), /entries require/);
  });

  it("accepts MOVE_STOP and MOVE_TP amendment intents", () => {
    const moveStop = {
      ...baseIntent(),
      action: "MOVE_STOP",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "MOVE_STOP" },
      new_stop_price: 20_000,
    };
    const moveTp = {
      ...baseIntent(),
      action: "MOVE_TP",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "MOVE_TP" },
      new_take_profit: 20_050,
    };
    const partialExit = {
      ...baseIntent(),
      action: "EXIT",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "EXIT" },
      quantity: 1,
    };
    assert.equal(parseTradeIntent(moveStop).newStopPrice, 20_000);
    assert.equal(parseTradeIntent(moveTp).newTakeProfit, 20_050);
    assert.equal(parseTradeIntent(partialExit).quantity, 1);
  });

  it("accepts MOVE_STOP and MOVE_TP with optional target_intent_id", () => {
    const targetedMoveStop = {
      ...baseIntent(),
      action: "MOVE_STOP",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "MOVE_STOP" },
      new_stop_price: 20_000,
      target_intent_id: "00000000-0000-4000-8000-00000000a001",
    };
    const targetedMoveTp = {
      ...baseIntent(),
      action: "MOVE_TP",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "MOVE_TP" },
      new_take_profit: 20_050,
      target_intent_id: "00000000-0000-4000-8000-00000000a002",
    };
    assert.equal(
      parseTradeIntent(targetedMoveStop).targetIntentId,
      "00000000-0000-4000-8000-00000000a001",
    );
    assert.equal(
      parseTradeIntent(targetedMoveTp).targetIntentId,
      "00000000-0000-4000-8000-00000000a002",
    );
  });

  it("accepts EXIT with optional target_intent_id", () => {
    const targetedExit = {
      ...baseIntent(),
      action: "EXIT",
      decision_audit: { ...baseIntent().decision_audit, final_choice: "EXIT" },
      quantity: 1,
      target_intent_id: "00000000-0000-4000-8000-00000000a001",
    };
    assert.equal(
      parseTradeIntent(targetedExit).targetIntentId,
      "00000000-0000-4000-8000-00000000a001",
    );
    assert.throws(
      () => parseTradeIntent({ ...baseIntent(), action: "ENTER_LONG", target_intent_id: targetedExit.target_intent_id }),
      /target_intent_id_only_allowed_on_exit_or_amendment/,
    );
  });
});
