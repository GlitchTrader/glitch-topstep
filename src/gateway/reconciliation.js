let connectionGeneration = 0;

export function bumpConnectionGeneration() {
  connectionGeneration += 1;
  return connectionGeneration;
}

export function currentConnectionGeneration() {
  return connectionGeneration;
}

export function buildReconciliation({
  runtimeReady,
  realtimeStatus,
  protection,
  lastRefreshAt,
  idempotencyState,
}) {
  const realtimeOk = Boolean(realtimeStatus?.connected);
  const protectionOk = protection?.protection_complete || protection?.stop_confirmed;
  return {
    schema_version: "glitch.topstep.reconciliation.v1",
    connection_generation: connectionGeneration,
    projectx_connected: runtimeReady,
    realtime_connected: realtimeOk,
    state_trusted: runtimeReady && realtimeOk,
    protection_verified: protectionOk,
    last_refresh_utc: lastRefreshAt,
    pending_submissions: idempotencyState?.pending?.length ?? 0,
    notes: !realtimeOk
      ? "Realtime disconnected; quotes may be bar-derived."
      : !protectionOk
        ? "Protection not fully verified on working orders."
        : null,
  };
}
