import distributedStateMachine from "../../release/distributed-state-machine.v1.json" with { type: "json" };

export type DistributedStateMachineDocument = typeof distributedStateMachine;

export const DISTRIBUTED_STATE_MACHINE = Object.freeze(
  distributedStateMachine,
) as DistributedStateMachineDocument;

export const AMENDMENT_SOURCES = Object.freeze([
  ...DISTRIBUTED_STATE_MACHINE.field_contracts.amendment_source.enum,
] as const);

export type AmendmentSource = (typeof AMENDMENT_SOURCES)[number];

export const TIGHTEN_ONLY_AMENDMENT_SOURCES = Object.freeze(
  new Set<DistributedStateMachineDocument["field_contracts"]["amendment_source"]["tighten_only_sources"][number]>(
    DISTRIBUTED_STATE_MACHINE.field_contracts.amendment_source.tighten_only_sources,
  ),
);

export function isAmendmentSource(value: string): value is AmendmentSource {
  return (AMENDMENT_SOURCES as readonly string[]).includes(value);
}

export function isTightenOnlyAmendmentSource(source: AmendmentSource): boolean {
  return TIGHTEN_ONLY_AMENDMENT_SOURCES.has(source);
}
