import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const launcher = readFileSync("start.ps1", "utf8");

describe("canonical launcher safety", () => {
  it("refuses a non-shadow effective mode after loading the canonical dotenv", () => {
    assert.match(launcher, /effective GLITCH_TRADING_MODE must be shadow/);
    assert.match(launcher, /dotenvValues\[\"GLITCH_TRADING_MODE\"\]/);
  });

  it("falls back to netstat before starting a second listener", () => {
    assert.match(launcher, /netstat -ano -p tcp/);
    assert.match(launcher, /Refusing to stop an unverified process/);
  });
});
