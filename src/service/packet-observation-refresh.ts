/** Bounded market-observation refresh for /packet — never block HTTP past budget. */

export interface PacketObservationRefreshResult {
  timed_out: boolean;
  skipped_fresh: boolean;
  waited_ms: number;
}

export interface BoundedPacketObservationRefreshOptions {
  budgetMs: number;
  observationFresh: boolean;
  refresh: () => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function boundedPacketObservationRefresh(
  options: BoundedPacketObservationRefreshOptions,
): Promise<PacketObservationRefreshResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  if (options.observationFresh) {
    return { timed_out: false, skipped_fresh: true, waited_ms: 0 };
  }
  let timedOut = false;
  await Promise.race([
    options.refresh().then(
      () => undefined,
      () => undefined,
    ),
    sleep(options.budgetMs).then(() => {
      timedOut = true;
    }),
  ]);
  return {
    timed_out: timedOut,
    skipped_fresh: false,
    waited_ms: Math.max(0, (options.now ?? Date.now)() - started),
  };
}
