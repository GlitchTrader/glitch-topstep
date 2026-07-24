export function swingPoints(bars, lookback = 3) {
  const swings = { highs: [], lows: [] };
  if (bars.length < lookback * 2 + 1) {
    return swings;
  }
  for (let index = lookback; index < bars.length - lookback; index += 1) {
    const bar = bars[index];
    const left = bars.slice(index - lookback, index);
    const right = bars.slice(index + 1, index + 1 + lookback);
    if (left.every((item) => bar.h >= item.h) && right.every((item) => bar.h >= item.h)) {
      swings.highs.push({ t: bar.t, price: bar.h });
    }
    if (left.every((item) => bar.l <= item.l) && right.every((item) => bar.l <= item.l)) {
      swings.lows.push({ t: bar.t, price: bar.l });
    }
  }
  return {
    highs: swings.highs.slice(-5),
    lows: swings.lows.slice(-5),
  };
}

export function buildStructuralLevels({ bars1m, bars5m, features, quote }) {
  const sessionHigh = Number(quote.session_high);
  const sessionLow = Number(quote.session_low);
  const sessionOpen = Number(quote.session_open);
  const last = Number(quote.last);
  const swings1m = swingPoints(bars1m, 2);
  const swings5m = swingPoints(bars5m, 2);
  const recent1m = bars1m.slice(-60);
  const priorWindow = bars1m.slice(0, Math.max(0, bars1m.length - 15));
  const priorHigh = priorWindow.length ? Math.max(...priorWindow.map((bar) => bar.h)) : null;
  const priorLow = priorWindow.length ? Math.min(...priorWindow.map((bar) => bar.l)) : null;

  return {
    session: {
      open: sessionOpen,
      high: sessionHigh,
      low: sessionLow,
      vwap: features?.vwap_session ?? null,
    },
    prior_hour: {
      high: priorHigh,
      low: priorLow,
    },
    swings_1m: swings1m,
    swings_5m: swings5m,
    nearest_resistance:
      swings1m.highs.filter((point) => point.price > last).sort((a, b) => a.price - b.price)[0]
        ?.price ?? sessionHigh,
    nearest_support:
      swings1m.lows.filter((point) => point.price < last).sort((a, b) => b.price - a.price)[0]
        ?.price ?? sessionLow,
    distance_to_vwap_pts:
      features?.vwap_session != null && Number.isFinite(last)
        ? Number((last - features.vwap_session).toFixed(2))
        : null,
  };
}
