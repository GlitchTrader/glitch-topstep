import type { LifecycleState } from "../state-machines.js";

export interface LifecycleStatus {
  state: LifecycleState;
  changed_utc: string;
  detail: string | null;
}

export type LifecycleDisposer = () => Promise<void> | void;

export interface LifecycleSupervisorPort {
  transition(state: LifecycleState, detail?: string | null): LifecycleStatus;
  status(): LifecycleStatus;
  register(name: string, dispose: LifecycleDisposer): void;
  registeredNames(): string[];
  rollbackAfterFailure(reason: string): Promise<LifecycleStatus>;
  drain(detail?: string | null): Promise<string[]>;
}
