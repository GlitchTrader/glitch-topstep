import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export class RuntimeScopeLock {
  private handle: FileHandle | null = null;
  private readonly path: string;

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
    await this.handle.writeFile(JSON.stringify({
      pid: process.pid,
      acquired_utc: new Date().toISOString(),
    }), "utf8");
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
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
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

