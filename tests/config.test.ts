import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    PROJECTX_USERNAME: "user",
    PROJECTX_API_KEY: "key",
    GLITCH_ACCOUNT_ID: "1",
    GLITCH_ACCOUNT_NAME: "SIM",
    GLITCH_CONTRACT_ID: "MNQ",
    GLITCH_LOCAL_TOKEN: "012345678901234567890123",
  };
}

describe("configuration safety", () => {
  it("defaults to shadow mode with entries closed", () => {
    const config = loadConfig(environment());
    assert.equal(config.tradingMode, "shadow");
    assert.equal(config.policy.entryWindowOpen, false);
    assert.equal(config.requireSimulatedAccount, true);
  });

  it("requires an exact acknowledgement before armed mode", () => {
    assert.throws(
      () => loadConfig({ ...environment(), GLITCH_TRADING_MODE: "armed" }),
      /armed_mode_requires_explicit_scaffold_acknowledgement/,
    );
    const config = loadConfig({
      ...environment(),
      GLITCH_TRADING_MODE: "armed",
      GLITCH_ARMED_ACK: "I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY",
    });
    assert.equal(config.tradingMode, "armed");
  });
});
