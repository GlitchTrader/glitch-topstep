import type { DatabaseSync } from "node:sqlite";

/** Shared migration ledger authority for SQLite stores (IA-260901-GW-08). */
export function applySqliteMigration(
  database: DatabaseSync,
  ledgerTable: string,
  version: number,
  sql: string,
): void {
  const applied = database.prepare(`
    SELECT 1 AS present FROM ${ledgerTable} WHERE version = ?
  `).get(version) as { present: number } | undefined;
  if (applied) {
    return;
  }
  database.exec(sql);
  database.prepare(`
    INSERT INTO ${ledgerTable}(version, applied_utc)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(version);
}
