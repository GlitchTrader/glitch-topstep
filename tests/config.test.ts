import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    PROJECTX_USERNAME: "user",
    PROJECTX_API_KEY: "key",
    GLITCH_ACCOUNT_ID: "1",
    GLITCH_ACCOUNT_NAME: "SIM",
    GLITCH_CONTRACT_ID: "CON.F.US.MNQ.U26",
    GLITCH_INSTRUMENT: "MNQ",
    GLITCH_LOSS_MODEL: "express_funded_eod",
    GLITCH_LOCAL_TOKEN: "012345678901234567890123",
    GLITCH_OPERATOR_TOKEN: "987654321098765432109876",
  };
}

describe("configuration authority", () => {
  it("defaults to shadow without strategy or paper/live gates", () => {
    const config = loadConfig(environment());
    assert.equal(config.tradingMode, "shadow");
    assert.equal(config.scope.instrument, "MNQ");
    assert.equal(config.localGateway.host, "127.0.0.1");
    assert.equal(config.policy.authority, "operator_configured");
    assert.equal(config.policy.lossModel, "express_funded_eod");
    assert.equal(config.providerEvidence.marketEventRetention, 500_000);
    assert.equal(config.providerEvidence.marketPruneInterval, 10_000);
    assert.equal("requireSimulatedAccount" in config, false);
    assert.equal("maxRiskFractionOfBuffer" in config.risk, false);
    assert.equal("entryWindowOpen" in config.policy, false);
  });

  it("accepts only numeric loopback hosts for the local gateway", () => {
    const ipv6 = loadConfig({
      ...environment(),
      GLITCH_LOCAL_HOST: "::1",
    });
    assert.equal(ipv6.localGateway.host, "::1");

    for (const host of ["0.0.0.0", "::", "192.168.1.15", "203.0.113.10", "localhost", "gateway.local"]) {
      assert.throws(
        () => loadConfig({ ...environment(), GLITCH_LOCAL_HOST: host }),
        /GLITCH_LOCAL_HOST must be the numeric loopback address/,
      );
    }
  });

  it("requires an explicit instrument and loss model", () => {
    const withoutInstrument = { ...environment() };
    delete withoutInstrument.GLITCH_INSTRUMENT;
    assert.throws(() => loadConfig(withoutInstrument), /GLITCH_INSTRUMENT/);

    const withoutModel = { ...environment() };
    delete withoutModel.GLITCH_LOSS_MODEL;
    assert.throws(() => loadConfig(withoutModel), /GLITCH_LOSS_MODEL/);
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

  it("validates bounded market evidence retention", () => {
    const configured = loadConfig({
      ...environment(),
      GLITCH_PROVIDER_MARKET_EVENT_RETENTION: "25000",
      GLITCH_PROVIDER_MARKET_PRUNE_INTERVAL: "500",
    });
    assert.equal(configured.providerEvidence.marketEventRetention, 25_000);
    assert.equal(configured.providerEvidence.marketPruneInterval, 500);

    assert.throws(() => loadConfig({
      ...environment(),
      GLITCH_PROVIDER_MARKET_EVENT_RETENTION: "9999",
    }), /GLITCH_PROVIDER_MARKET_EVENT_RETENTION/);
    assert.throws(() => loadConfig({
      ...environment(),
      GLITCH_PROVIDER_MARKET_EVENT_RETENTION: "10000",
      GLITCH_PROVIDER_MARKET_PRUNE_INTERVAL: "10001",
    }), /cannot exceed retention/);
  });
});
