import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface QuarantineRecord {
  path: string;
  bytes: number;
  reason: string;
  quarantined_utc: string;
}

/**
 * Replace a file through a temp write plus rename so a reader (or a crash) can never
 * observe a half-written export. The temp file is fsynced before the rename.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

/**
 * Park an unreadable tail beside the file and rewrite the readable prefix atomically.
 * Corrupt bytes are moved, never dropped, so the damage stays auditable.
 */
export async function quarantineCorruptTail(
  path: string,
  keptPrefix: string,
  corruptTail: string,
  reason: string,
): Promise<QuarantineRecord> {
  const quarantinedUtc = new Date().toISOString();
  const target = `${path}.corrupt-${quarantinedUtc.replace(/[:.]/g, "-")}`;
  await writeFileAtomic(target, corruptTail);
  await writeFileAtomic(path, keptPrefix);
  return {
    path: target,
    bytes: Buffer.byteLength(corruptTail, "utf8"),
    reason,
    quarantined_utc: quarantinedUtc,
  };
}

/**
 * A rename is only durable once the parent directory entry is flushed.
 * ponytail: Windows cannot open a directory handle, so this stays best effort there;
 * the file fsync above still bounds the loss window to the directory entry.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close();
  }
}
