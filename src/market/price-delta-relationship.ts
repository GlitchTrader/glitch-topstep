import type { ProjectXOrderFlowState } from "../domain/order-flow.js";

export type PriceDeltaAlignment = "aligned" | "conflict" | "neutral" | "unknown";

export interface PriceDeltaWindowRelationship {
  window_seconds: number;
  price_change_bps: number | null;
  rolling_delta: number | null;
  delta_ratio: number | null;
  alignment: PriceDeltaAlignment;
}

export interface PriceDeltaRelationshipPacket {
  schema_version: "glitch.topstep.price_delta_relationship.v1";
  generated_utc: string;
  windows: PriceDeltaWindowRelationship[];
  summary: PriceDeltaAlignment;
}

function classifyAlignment(
  priceChangeBps: number | null,
  deltaRatio: number | null,
): PriceDeltaAlignment {
  if (priceChangeBps === null || deltaRatio === null) {
    return "unknown";
  }
  const priceSign = priceChangeBps > 0.5 ? 1 : priceChangeBps < -0.5 ? -1 : 0;
  const deltaSign = deltaRatio > 0.05 ? 1 : deltaRatio < -0.05 ? -1 : 0;
  if (priceSign === 0 || deltaSign === 0) {
    return "neutral";
  }
  return priceSign === deltaSign ? "aligned" : "conflict";
}

function summarize(windows: PriceDeltaWindowRelationship[]): PriceDeltaAlignment {
  const scored = windows.filter((row) => row.alignment !== "unknown");
  if (scored.length === 0) {
    return "unknown";
  }
  const aligned = scored.filter((row) => row.alignment === "aligned").length;
  const conflict = scored.filter((row) => row.alignment === "conflict").length;
  if (aligned > conflict && aligned >= Math.ceil(scored.length / 2)) {
    return "aligned";
  }
  if (conflict > aligned && conflict >= Math.ceil(scored.length / 2)) {
    return "conflict";
  }
  return "neutral";
}

export function buildPriceDeltaRelationship(
  orderFlow: ProjectXOrderFlowState,
  generatedUtc: string,
): PriceDeltaRelationshipPacket {
  const windows: PriceDeltaWindowRelationship[] = [];
  for (const seconds of [15, 60, 300]) {
    const row = orderFlow.observation?.windows?.find((window) => window.window_seconds === seconds);
    if (!row) {
      windows.push({
        window_seconds: seconds,
        price_change_bps: null,
        rolling_delta: null,
        delta_ratio: null,
        alignment: "unknown",
      });
      continue;
    }
    const priceChangeBps = typeof row.price_change_bps === "number" ? row.price_change_bps : null;
    const rollingDelta = typeof row.rolling_delta === "number" ? row.rolling_delta : null;
    const deltaRatio = typeof row.delta_ratio === "number" ? row.delta_ratio : null;
    windows.push({
      window_seconds: seconds,
      price_change_bps: priceChangeBps,
      rolling_delta: rollingDelta,
      delta_ratio: deltaRatio,
      alignment: classifyAlignment(priceChangeBps, deltaRatio),
    });
  }
  return {
    schema_version: "glitch.topstep.price_delta_relationship.v1",
    generated_utc: generatedUtc,
    windows,
    summary: summarize(windows),
  };
}
