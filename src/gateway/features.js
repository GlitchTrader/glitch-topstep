import { summarizeBars } from "./bars.js";

export function averageTrueRange(bars, period = 14) {
  if (bars.length < 2) {
    return null;
  }
  const trs = [];
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const range = Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    );
    trs.push(range);
  }
  const window = trs.slice(-period);
  if (!window.length) {
    return null;
  }
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

export function sessionVwap(bars) {
  let volume = 0;
  let weighted = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    const barVolume = bar.v || 0;
    if (barVolume <= 0) {
      continue;
    }
    weighted += typical * barVolume;
    volume += barVolume;
  }
  if (volume <= 0) {
    return null;
  }
  return weighted / volume;
}

export function lastBarDirection(bars, count = 3) {
  const slice = bars.slice(-count);
  if (slice.length < 2) {
    return "unknown";
  }
  let ups = 0;
  let downs = 0;
  for (let index = 1; index < slice.length; index += 1) {
    const delta = slice[index].c - slice[index - 1].c;
    if (delta > 0.01) {
      ups += 1;
    } else if (delta < -0.01) {
      downs += 1;
    }
  }
  if (ups > 0 && downs > 0) {
    return "mixed";
  }
  if (ups > 0) {
    return "up";
  }
  if (downs > 0) {
    return "down";
  }
  return "flat";
}

export function detectRegime(bars1m, atr) {
  if (bars1m.length < 5 || !atr) {
    return "unknown";
  }
  const recent = bars1m.slice(-5);
  const high = Math.max(...recent.map((bar) => bar.h));
  const low = Math.min(...recent.map((bar) => bar.l));
  const range = high - low;
  if (range < atr * 1.5) {
    return "chop";
  }
  const summary = summarizeBars(recent);
  if (summary?.direction === "up" || summary?.direction === "down") {
    return "trend";
  }
  return "transition";
}

export function buildMarketFeatures({ bars1m, bars5m, quote, tickSize }) {
  const last = Number(quote?.last);
  const sessionHigh = Number(quote?.session_high ?? quote?.high);
  const sessionLow = Number(quote?.session_low ?? quote?.low);
  const sessionOpen = Number(quote?.session_open ?? quote?.open);
  const atr = averageTrueRange(bars1m, 14);
  const rangePts =
    Number.isFinite(sessionHigh) && Number.isFinite(sessionLow)
      ? sessionHigh - sessionLow
      : null;
  const distHigh =
    Number.isFinite(sessionHigh) && Number.isFinite(last) ? sessionHigh - last : null;
  const distLow =
    Number.isFinite(sessionLow) && Number.isFinite(last) ? last - sessionLow : null;
  const positionInRange =
    rangePts && rangePts > 0 && Number.isFinite(last) && Number.isFinite(sessionLow)
      ? (last - sessionLow) / rangePts
      : null;
  const recentVolumes = bars1m.slice(-20).map((bar) => bar.v || 0).filter((value) => value > 0);
  const currentVolume = bars1m.at(-1)?.v || 0;
  const avgVolume =
    recentVolumes.length > 0
      ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length
      : null;
  const relativeVolume =
    avgVolume && avgVolume > 0 ? Number((currentVolume / avgVolume).toFixed(4)) : null;

  return {
    atr_14_1m: atr == null ? null : Number(atr.toFixed(4)),
    vwap_session: sessionVwap(bars1m),
    dist_to_high_pts: distHigh == null ? null : Number(distHigh.toFixed(2)),
    dist_to_low_pts: distLow == null ? null : Number(distLow.toFixed(2)),
    position_in_range:
      positionInRange == null ? null : Number(positionInRange.toFixed(4)),
    session_range_pts: rangePts == null ? null : Number(rangePts.toFixed(2)),
    change_from_open_pts:
      Number.isFinite(sessionOpen) && Number.isFinite(last)
        ? Number((last - sessionOpen).toFixed(2))
        : null,
    last_3_bar_direction: lastBarDirection(bars1m, 3),
    regime_1m: detectRegime(bars1m, atr),
    relative_volume: relativeVolume,
    structure_5m: summarizeBars(bars5m),
    spread_ticks:
      Number.isFinite(quote?.bid) && Number.isFinite(quote?.ask) && tickSize
        ? Math.max(1, Math.round((quote.ask - quote.bid) / tickSize))
        : quote?.spread_ticks ?? null,
  };
}

export function isNearSessionExtreme(features, threshold = 0.85) {
  const position = features?.position_in_range;
  if (position == null) {
    return false;
  }
  return position >= threshold || position <= 1 - threshold;
}
