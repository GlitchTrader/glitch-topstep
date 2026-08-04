export type TopstepSessionAuthority = "operator_configured" | "topstep_verified";

export interface TopstepSessionConfig {
  authority: TopstepSessionAuthority;
  timezone: string;
  mustFlatLocalTime: string | null;
  entryOpenLocalTime: string | null;
  notes: readonly string[];
}

export interface TopstepSessionPacket {
  authority: TopstepSessionAuthority;
  must_flat_utc: string | null;
  entry_window_open: boolean;
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
  if (mustFlatUtc === null) {
    return true;
  }
  return now.getTime() < Date.parse(mustFlatUtc);
}

export function emptySessionConfig(): TopstepSessionConfig {
  return {
    authority: "operator_configured",
    timezone: "America/Chicago",
    mustFlatLocalTime: null,
    entryOpenLocalTime: null,
    notes: [],
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
  return {
    authority: config.authority,
    must_flat_utc: mustFlatUtc,
    entry_window_open: entryWindowOpen(now, config, mustFlatUtc),
    notes,
  };
}
