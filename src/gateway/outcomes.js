import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function stableOutcomeId(intentId, exitUtc) {
  return crypto
    .createHash("sha256")
    .update(`${intentId}:${exitUtc}`)
    .digest("hex")
    .slice(0, 24);
}

function readSeen(outcomesPath) {
  try {
    if (!fs.existsSync(outcomesPath)) {
      return new Set();
    }
    const ids = new Set();
    for (const line of fs.readFileSync(outcomesPath, "utf8").splitlines()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const row = JSON.parse(line);
        if (row.outcome_id) {
          ids.add(row.outcome_id);
        }
      } catch {
        // ignore
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export function extractIntentIdFromTag(tag) {
  if (!tag || typeof tag !== "string") {
    return null;
  }
  const match = /glitch-topstep:([0-9a-f-]{36})/i.exec(tag);
  return match ? match[1] : null;
}

export function syncOutcomes({
  outcomesPath,
  trades,
  accountName,
  instrument,
  registry,
}) {
  if (!outcomesPath) {
    return { written: 0 };
  }

  const seen = readSeen(outcomesPath);
  const intentByOrder = new Map();
  for (const item of registry?.submissions || []) {
    const orderId = item?.venue_result?.orderId ?? item?.venue_result?.id;
    if (orderId) {
      intentByOrder.set(Number(orderId), item);
    }
  }

  let written = 0;
  for (const trade of trades || []) {
    if (trade.voided || trade.profitAndLoss == null) {
      continue;
    }
    const intentFromRegistry = intentByOrder.get(Number(trade.orderId));
    const intentId =
      intentFromRegistry?.intent_id || extractIntentIdFromTag(trade.customTag) || null;
    if (!intentId) {
      continue;
    }
    const exitUtc = trade.creationTimestamp;
    const outcomeId = stableOutcomeId(intentId, exitUtc);
    if (seen.has(outcomeId)) {
      continue;
    }
    const record = {
      schema_version: "glitch.topstep.trade_outcome.v1",
      outcome_id: outcomeId,
      intent_id: intentId,
      account: accountName,
      instrument,
      entry_utc: null,
      exit_utc: exitUtc,
      realized_pnl_usd: Number(trade.profitAndLoss) || 0,
      fees_usd: Number(trade.fees) || 0,
      learning_eligible: true,
      evidence: {
        trade_id: trade.id,
        order_id: trade.orderId,
        exit_price: Number(trade.price),
        side: trade.side,
        size: Number(trade.size),
      },
    };
    fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
    fs.appendFileSync(outcomesPath, `${JSON.stringify(record)}\n`, "utf8");
    seen.add(outcomeId);
    written += 1;
  }
  return { written, path: outcomesPath };
}
