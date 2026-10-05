import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObservationWindow } from "../src/observability/observation-window.js";

describe("observation window", () => {
  it("keeps the start on a read and moves it only when the poll resets", () => {
    let now = Date.parse("2026-10-05T20:00:00.000Z");
    const window = new ObservationWindow(() => now);

    const opened = window.snapshot({ reset: false });
    assert.equal(opened.window_start_utc, "2026-10-05T20:00:00.000Z");
    assert.equal(opened.window_ms, 0);

    now += 90_000;
    const peeked = window.snapshot({ reset: false });
    assert.equal(peeked.window_start_utc, opened.window_start_utc);
    assert.equal(peeked.window_ms, 90_000);

    now += 30_000;
    const reset = window.snapshot({ reset: true });
    assert.equal(reset.window_start_utc, opened.window_start_utc);
    assert.equal(reset.window_ms, 120_000);

    now += 5_000;
    const next = window.snapshot({ reset: false });
    assert.equal(next.window_start_utc, "2026-10-05T20:02:00.000Z");
    assert.equal(next.window_ms, 5_000);
  });
});
