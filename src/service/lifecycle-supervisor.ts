import type { LifecycleState } from "../domain/state-machines.js";

export interface LifecycleStatus {
  state: LifecycleState;
  changed_utc: string;
  detail: string | null;
}

export class LifecycleSupervisor {
  private currentStatus: LifecycleStatus = {
    state: "stopped",
    changed_utc: new Date(0).toISOString(),
    detail: null,
  };

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
}

