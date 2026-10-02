import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RuntimeLockPayload {
  pid: number;
  acquired_utc: string;
  hostname: string;
  invocation_id: string;
  process_boot_ms: number;
}

export type ResolveProcessBootMs = (pid: number) => Promise<number | null>;

const defaultResolveProcessBootMs: ResolveProcessBootMs = async () => null;

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function resolveWindowsProcessBootMs(pid: number): Promise<number | null> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    "if (-not $p) { exit 2 }",
    "[DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds()",
  ].join("; ");
  try {
    const stdout = await execFileText("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Linux CLK_TCK is 100 on the CI image. Both sides use this, so equality does not depend on the true tick. */
async function resolveLinuxProcessBootMs(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]);
    const procStat = await readFile("/proc/stat", "utf8");
    const btimeLine = procStat.split("\n").find((line) => line.startsWith("btime "));
    const btime = Number(btimeLine?.split(" ")[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) {
      return null;
    }
    return Math.round(btime * 1000 + (startTicks * 1000) / 100);
  } catch {
    return null;
  }
}

/**
 * OS creation time of a live PID, in epoch ms.
 * Same value on repeat calls so a lock written from this function matches a later check.
 * null means unknown: the caller keeps the lock (fail closed).
 */
export async function resolveProcessBootMs(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    return resolveWindowsProcessBootMs(pid);
  }
  if (process.platform === "linux") {
    return resolveLinuxProcessBootMs(pid);
  }
  return null;
}

export class RuntimeScopeLock {
  private handle: FileHandle | null = null;
  private readonly path: string;
  private readonly invocationId = randomUUID();
  private readonly processBootMs = Math.floor(Date.now() - process.uptime() * 1000);

  public constructor(
    dataDirectory: string,
    accountId: number,
    private readonly resolveProcessBootMs: ResolveProcessBootMs = defaultResolveProcessBootMs,
  ) {
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
    const resolvedBoot = await this.resolveProcessBootMs(process.pid);
    const payload: RuntimeLockPayload = {
      pid: process.pid,
      acquired_utc: new Date().toISOString(),
      hostname: hostname(),
      invocation_id: this.invocationId,
      process_boot_ms: resolvedBoot ?? this.processBootMs,
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
          if (
            typeof parsed.process_boot_ms === "number"
            && Number.isFinite(parsed.process_boot_ms)
          ) {
            const liveBootMs = await this.resolveProcessBootMs(parsed.pid);
            if (liveBootMs === null) {
              return false;
            }
            if (liveBootMs !== parsed.process_boot_ms) {
              await unlink(this.path);
              return true;
            }
          }
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

/** Test helper: seed a lock file as if another process instance held it. */
export async function writeRuntimeLockFixture(
  dataDirectory: string,
  accountId: number,
  payload: Partial<RuntimeLockPayload> & Pick<RuntimeLockPayload, "pid">,
): Promise<string> {
  const path = resolve(join(dataDirectory, `runtime-account-${accountId}.lock`));
  const body: RuntimeLockPayload = {
    pid: payload.pid,
    acquired_utc: payload.acquired_utc ?? new Date().toISOString(),
    hostname: payload.hostname ?? hostname(),
    invocation_id: payload.invocation_id ?? randomUUID(),
    process_boot_ms: payload.process_boot_ms ?? Math.floor(Date.now() - process.uptime() * 1000),
  };
  await writeFile(path, JSON.stringify(body), { encoding: "utf8", flag: "wx" });
  return path;
}
