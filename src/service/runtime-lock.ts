import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RuntimeLockPayload {
  pid: number;
  acquired_utc: string;
  hostname: string;
  invocation_id: string;
  process_boot_ms: number;
}

export class RuntimeScopeLock {
  private handle: FileHandle | null = null;
  private readonly path: string;
  private readonly invocationId = randomUUID();
  private readonly processBootMs = Math.floor(Date.now() - process.uptime() * 1000);

  public constructor(dataDirectory: string, accountId: number) {
    this.path = resolve(join(dataDirectory, `runtime-account-${accountId}.lock`));
  }

  public async acquire(): Promise<void> {
    if (this.handle) {
      return;
    }
    try {
      this.handle = await open(this.path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (!await this.removeIfStale()) {
        throw new Error(`runtime_account_lock_held:${this.path}`);
      }
      this.handle = await open(this.path, "wx", 0o600);
    }
    const payload: RuntimeLockPayload = {
      pid: process.pid,
      acquired_utc: new Date().toISOString(),
      hostname: hostname(),
      invocation_id: this.invocationId,
      process_boot_ms: this.processBootMs,
    };
    await this.handle.writeFile(JSON.stringify(payload), "utf8");
    await this.handle.sync();
  }

  public async release(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (!handle) {
      return;
    }
    await handle.close();
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  private async removeIfStale(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<RuntimeLockPayload>;
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        if (typeof parsed.hostname === "string" && parsed.hostname !== hostname()) {
          await unlink(this.path);
          return true;
        }
        try {
          process.kill(parsed.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return false;
          }
        }
      }
      await unlink(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      return false;
    }
  }
}
