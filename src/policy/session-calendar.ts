export type TopstepSessionAuthority = "operator_configured" | "topstep_verified";
export type SessionPhase = "regular" | "maintenance" | "asia";
export type SessionPhaseAuthority = "operator_configured" | "exchange_calendar";

export interface TopstepSessionConfig {
  authority: TopstepSessionAuthority;
  timezone: string;
  /** Local clock when the Topstep trading day rolls (default 17:00 CT). */
  tradingDayResetLocalTime: string;
  mustFlatLocalTime: string | null;
  entryOpenLocalTime: string | null;
  /** When true, publish session.phase from configured exchange maintenance / asia windows. */
  phaseCalendarEnabled: boolean;
  maintenanceStartLocalTime: string | null;
  maintenanceEndLocalTime: string | null;
  asiaStartLocalTime: string | null;
  asiaEndLocalTime: string | null;
  notes: readonly string[];
}

export interface TopstepSessionPacket {
  authority: TopstepSessionAuthority;
  must_flat_utc: string | null;
  entry_window_open: boolean;
  phase: SessionPhase | null;
  phase_authority: SessionPhaseAuthority | null;
  notes: string[];
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseSessionLocalTime(value: string): { hour: number; minute: number } {
  const match = LOCAL_TIME_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`invalid_session_local_time:${value}`);
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

export function assertValidSessionTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid_session_timezone:${timezone}`);
  }
}

function localParts(date: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function addCalendarDays(
  parts: LocalDateParts,
  days: number,
  timeZone: string,
): LocalDateParts {
  const shifted = localDateTimeToUtcIso(
    parts.year,
    parts.month,
    parts.day + days,
    12,
    0,
    timeZone,
  );
  return localParts(new Date(Date.parse(shifted)), timeZone);
}

function localDateTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observed = localParts(new Date(guess), timeZone);
    const targetMinutes = hour * 60 + minute;
    const observedMinutes = observed.hour * 60 + observed.minute;
    const dayDelta = observed.day - day;
    const minuteDelta = observedMinutes - targetMinutes + dayDelta * 1_440;
    if (minuteDelta === 0 && observed.month === month && observed.year === year) {
      return new Date(guess).toISOString();
    }
    guess -= minuteDelta * 60_000;
  }
  return new Date(guess).toISOString();
}

function nextMustFlatUtc(now: Date, config: TopstepSessionConfig): string | null {
  if (!config.mustFlatLocalTime) {
    return null;
  }
  const { hour, minute } = parseSessionLocalTime(config.mustFlatLocalTime);
  const today = localParts(now, config.timezone);
  let candidate = localDateTimeToUtcIso(
    today.year,
    today.month,
    today.day,
    hour,
    minute,
    config.timezone,
  );
  if (Date.parse(candidate) <= now.getTime()) {
    const tomorrow = addCalendarDays(today, 1, config.timezone);
    candidate = localDateTimeToUtcIso(
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      hour,
      minute,
      config.timezone,
    );
  }
  return candidate;
}

function inMustFlatToResetGap(now: Date, config: TopstepSessionConfig): boolean {
  if (!config.mustFlatLocalTime) {
    return false;
  }
  const flat = parseSessionLocalTime(config.mustFlatLocalTime);
  const reset = parseSessionLocalTime(config.tradingDayResetLocalTime);
  const flatMinutes = flat.hour * 60 + flat.minute;
  const resetMinutes = reset.hour * 60 + reset.minute;
  if (flatMinutes >= resetMinutes) {
    return false;
  }
  const nowMinutes = localMinutes(localParts(now, config.timezone));
  return nowMinutes >= flatMinutes && nowMinutes < resetMinutes;
}

function entryWindowOpen(now: Date, config: TopstepSessionConfig, mustFlatUtc: string | null): boolean {
  if (config.entryOpenLocalTime) {
    const { hour, minute } = parseSessionLocalTime(config.entryOpenLocalTime);
    const today = localParts(now, config.timezone);
    const openUtc = Date.parse(localDateTimeToUtcIso(
      today.year,
      today.month,
      today.day,
      hour,
      minute,
      config.timezone,
    ));
    if (now.getTime() < openUtc) {
      return false;
    }
  }
  // ponytail: nextMustFlatUtc jumps to tomorrow after 15:10, which would keep the
  // window open through the Topstep dead zone until 17:00 reset. Close that gap.
  if (inMustFlatToResetGap(now, config)) {
    return false;
  }
  if (mustFlatUtc === null) {
    return true;
  }
  return now.getTime() < Date.parse(mustFlatUtc);
}

function localMinutes(parts: LocalDateParts): number {
  return parts.hour * 60 + parts.minute;
}

function isWithinLocalTimeWindow(
  now: Date,
  timezone: string,
  startLocalTime: string,
  endLocalTime: string,
): boolean {
  const start = parseSessionLocalTime(startLocalTime);
  const end = parseSessionLocalTime(endLocalTime);
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const nowMinutes = localMinutes(localParts(now, timezone));
  if (startMinutes === endMinutes) {
    return false;
  }
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function resolveSessionPhase(
  config: TopstepSessionConfig,
  now: Date,
): { phase: SessionPhase | null; phase_authority: SessionPhaseAuthority | null; notes: string[] } {
  if (!config.phaseCalendarEnabled) {
    return {
      phase: null,
      phase_authority: null,
      notes: ["session.phase suppressed; GLITCH_SESSION_PHASE_CALENDAR=false"],
    };
  }
  const notes: string[] = [];
  const phaseAuthority: SessionPhaseAuthority = "exchange_calendar";
  if (config.maintenanceStartLocalTime && config.maintenanceEndLocalTime) {
    if (isWithinLocalTimeWindow(
      now,
      config.timezone,
      config.maintenanceStartLocalTime,
      config.maintenanceEndLocalTime,
    )) {
      notes.push(
        `maintenance window ${config.maintenanceStartLocalTime}-${config.maintenanceEndLocalTime} ${config.timezone} (CME-style daily halt; exchange_calendar).`,
      );
      return { phase: "maintenance", phase_authority: phaseAuthority, notes };
    }
  }
  if (config.asiaStartLocalTime && config.asiaEndLocalTime) {
    if (isWithinLocalTimeWindow(
      now,
      config.timezone,
      config.asiaStartLocalTime,
      config.asiaEndLocalTime,
    )) {
      notes.push(
        `asia window ${config.asiaStartLocalTime}-${config.asiaEndLocalTime} ${config.timezone} (operator_configured).`,
      );
      return { phase: "asia", phase_authority: "operator_configured", notes };
    }
  }
  notes.push("session.phase=regular outside configured maintenance and asia windows.");
  return { phase: "regular", phase_authority: phaseAuthority, notes };
}

export function emptySessionConfig(): TopstepSessionConfig {
  return {
    authority: "operator_configured",
    timezone: "America/Chicago",
    tradingDayResetLocalTime: "17:00",
    mustFlatLocalTime: null,
    entryOpenLocalTime: null,
    phaseCalendarEnabled: false,
    maintenanceStartLocalTime: null,
    maintenanceEndLocalTime: null,
    asiaStartLocalTime: null,
    asiaEndLocalTime: null,
    notes: [],
  };
}

function formatTradingDayId(parts: Pick<LocalDateParts, "year" | "month" | "day">): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Topstep maintenance-to-maintenance trading day label in the session timezone. */
export function resolveTradingDayId(
  now: Date,
  timezone: string,
  resetLocalTime: string,
): string {
  const { hour, minute } = parseSessionLocalTime(resetLocalTime);
  const today = localParts(now, timezone);
  const resetMinutes = hour * 60 + minute;
  const nowMinutes = today.hour * 60 + today.minute;
  if (nowMinutes >= resetMinutes) {
    const next = addCalendarDays(today, 1, timezone);
    return formatTradingDayId(next);
  }
  return formatTradingDayId(today);
}

export function tradingDayBoundsUtc(
  tradingDayId: string,
  timezone: string,
  resetLocalTime: string,
): { startUtc: string; endExclusiveUtc: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDayId);
  if (!match) {
    throw new Error(`invalid_trading_day_id:${tradingDayId}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const { hour, minute } = parseSessionLocalTime(resetLocalTime);
  const previous = addCalendarDays({ year, month, day, hour: 0, minute: 0 }, -1, timezone);
  return {
    startUtc: localDateTimeToUtcIso(previous.year, previous.month, previous.day, hour, minute, timezone),
    endExclusiveUtc: localDateTimeToUtcIso(year, month, day, hour, minute, timezone),
  };
}

export function resolveTopstepSession(
  config: TopstepSessionConfig,
  now = new Date(),
): TopstepSessionPacket {
  const mustFlatUtc = nextMustFlatUtc(now, config);
  const notes = [...config.notes];
  if (config.authority === "operator_configured" && config.mustFlatLocalTime) {
    notes.push("must_flat_utc is operator-configured; reconcile against Topstep dashboard policy.");
  }
  if (!config.mustFlatLocalTime) {
    notes.push("must_flat_utc unknown until GLITCH_SESSION_MUST_FLAT_LOCAL_TIME is configured.");
  }
  const phase = resolveSessionPhase(config, now);
  notes.push(...phase.notes);
  const entryOpen = entryWindowOpen(now, config, mustFlatUtc);
  if (!entryOpen && inMustFlatToResetGap(now, config)) {
    notes.push(
      `entry_window_open=false between must_flat ${config.mustFlatLocalTime} and trading-day reset ${config.tradingDayResetLocalTime} ${config.timezone}.`,
    );
  }
  return {
    authority: config.authority,
    must_flat_utc: mustFlatUtc,
    entry_window_open: entryOpen,
    phase: phase.phase,
    phase_authority: phase.phase_authority,
    notes,
  };
}
