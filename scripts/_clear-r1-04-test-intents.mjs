import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/glitch-topstep.sqlite");
const ids = db
  .prepare(
    `SELECT intent_id FROM execution_outbox
     WHERE intent_id LIKE '00000000-0000-4000-8000-00000000a04%'
        OR intent_id = '00000000-0000-4000-8000-00000000a099'`,
  )
  .all()
  .map((row) => row.intent_id);

for (const intentId of ids) {
  db.prepare("DELETE FROM execution_receipts WHERE intent_id = ?").run(intentId);
  db.prepare("DELETE FROM execution_outbox WHERE intent_id = ?").run(intentId);
  db.prepare("DELETE FROM intents WHERE intent_id = ?").run(intentId);
  db.prepare(
    "DELETE FROM runtime_meta WHERE key = 'entry_submission_latch' AND value = ?",
  ).run(intentId);
}

// ponytail: orphan latch blocks acceptance when outbox row was removed manually
db.prepare(`
  DELETE FROM runtime_meta
  WHERE key = 'entry_submission_latch'
    AND value NOT IN (SELECT intent_id FROM execution_outbox)
`).run();

console.log("cleared", ids);
db.close();
