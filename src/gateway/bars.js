export function normalizeBar(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const time = raw.t ?? raw.timestamp ?? raw.time;
  const open = Number(raw.o ?? raw.open);
  const high = Number(raw.h ?? raw.high);
  const low = Number(raw.l ?? raw.low);
  const close = Number(raw.c ?? raw.close);
  const volume = Number(raw.v ?? raw.volume ?? 0);
  if (!time || !Number.isFinite(close)) {
    return null;
  }
  return { t: String(time), o: open, h: high, l: low, c: close, v: volume };
}

export function normalizeBars(rawBars) {
  if (!Array.isArray(rawBars)) {
    return [];
  }
  return rawBars.map(normalizeBar).filter(Boolean);
}

export function compactBars(bars, limit) {
  return bars.slice(-Math.max(1, limit));
}

export function summarizeBars(bars) {
  if (!bars.length) {
    return null;
  }
  const first = bars[0];
  const last = bars.at(-1);
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const bar of bars) {
    high = Math.max(high, bar.h);
    low = Math.min(low, bar.l);
    volume += bar.v || 0;
  }
  const direction =
    last.c > first.o + 0.01 ? "up" : last.c < first.o - 0.01 ? "down" : "flat";
  return {
    count: bars.length,
    open: first.o,
    high,
    low,
    close: last.c,
    volume,
    direction,
    start: first.t,
    end: last.t,
  };
}
