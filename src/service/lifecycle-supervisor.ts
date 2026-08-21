import type { LifecycleState } from "../domain/state-machines.js";

export interface LifecycleStatus {
  state: LifecycleState;
  changed_utc: string;
  detail: string | null;
}

export type LifecycleDisposer = () => Promise<void> | void;

export interface LifecycleDisposerOptions {
  /** When true, failure aborts shutdown and retains recovery state (TS-REAUDIT-08). */
  critical?: boolean;
}

export interface LifecycleDrainResult {
  failed: string[];
  criticalFailed: string[];
}

interface Disposable {
  name: string;
  dispose: LifecycleDisposer;
  critical: boolean;
}

export class LifecycleSupervisor {
  private currentStatus: LifecycleStatus = {
    state: "stopped",
    changed_utc: new Date(0).toISOString(),
    detail: null,
  };

  private readonly disposables: Disposable[] = [];

  public transition(state: LifecycleState, detail: string | null = null): LifecycleStatus {
    this.currentStatus = {
      state,
      changed_utc: new Date().toISOString(),
      detail,
    };
    return this.status();
  }

  public status(): LifecycleStatus {
    return { ...this.currentStatus };
  }

  /** Records a resource so partial startups and shutdowns unwind in reverse acquisition order. */
  public register(
    name: string,
    dispose: LifecycleDisposer,
    options: LifecycleDisposerOptions = {},
  ): void {
    this.disposables.push({ name, dispose, critical: options.critical ?? false });
  }

  public registeredNames(): string[] {
    return this.disposables.map((entry) => entry.name);
  }

  /** Unwinds registered resources; critical failures stop the stack with the resource retained. */
  private async disposeAll(): Promise<LifecycleDrainResult> {
    const failed: string[] = [];
    const criticalFailed: string[] = [];
    while (this.disposables.length > 0) {
      const entry = this.disposables[this.disposables.length - 1] as Disposable;
      try {
        await entry.dispose();
        this.disposables.pop();
      } catch (error: unknown) {
        failed.push(entry.name);
        if (entry.critical) {
          criticalFailed.push(entry.name);
          console.error(`lifecycle dispose failed for ${entry.name}`, error);
          break;
        }
        this.disposables.pop();
        console.error(`lifecycle dispose failed for ${entry.name}`, error);
      }
    }
    return { failed, criticalFailed };
  }

  /** Startup aborted: release whatever was already acquired and park in failed_startup. */
  public async rollbackAfterFailure(reason: string): Promise<LifecycleStatus> {
    const { failed } = await this.disposeAll();
    return this.transition(
      "failed_startup",
      failed.length > 0 ? `${reason};dispose_failed:${failed.join(",")}` : reason,
    );
  }

  /**
   * Shutdown: enter draining and unwind resources. The caller owns the terminal
   * transition (stopped / failed_shutdown) because it also closes what it opened
   * outside this stack.
   */
  public async drain(detail: string | null = null): Promise<LifecycleDrainResult> {
    this.transition("draining", detail);
    return this.disposeAll();
  }
}
