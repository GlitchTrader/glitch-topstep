import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storePath = path.join(root, "data", "intent-idempotency.json");

function readStore() {
  try {
    if (!fs.existsSync(storePath)) {
      return { submissions: [] };
    }
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return { submissions: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

export function getIdempotencyState() {
  const store = readStore();
  const pending = store.submissions.filter((item) => item.status === "pending");
  return { submissions: store.submissions, pending };
}

export function hasSubmission(packetId, action) {
  const store = readStore();
  return store.submissions.some(
    (item) => item.packet_id === packetId && item.action === action && item.status !== "failed",
  );
}

export function recordSubmission({ packetId, action, intentId, status = "pending", venueResult = null }) {
  const store = readStore();
  store.submissions.push({
    packet_id: packetId,
    action,
    intent_id: intentId,
    status,
    recorded_utc: new Date().toISOString(),
    venue_result: venueResult,
  });
  store.submissions = store.submissions.slice(-500);
  writeStore(store);
}

export function markSubmission(packetId, action, status, venueResult = null) {
  const store = readStore();
  const match = store.submissions.findLast(
    (item) => item.packet_id === packetId && item.action === action,
  );
  if (match) {
    match.status = status;
    match.venue_result = venueResult;
    match.updated_utc = new Date().toISOString();
  }
  writeStore(store);
}
