import { PreconditionError } from "#/client/errors";

/**
 * Suivi Conso is a French service and reasons in Europe/Paris days: a "day" is
 * Paris midnight to Paris midnight, and its timestamps carry the Paris offset
 * (+01:00 in winter, +02:00 in summer). Its endpoints disagree on the format:
 *
 * - `beginTs`, `beginDate` (v2) and `ts` want ISO with an offset,
 *   e.g. 2026-11-01T00:00:00+01:00. A bare date answers 400 INVALID_DATE_FORMAT.
 * - `begin-date` / `end-date` (v1) want a bare YYYY-MM-DD.
 * - `begin-month` / `end-month` want YYYY-MM.
 *
 * End bounds are exclusive everywhere upstream. The tools take inclusive dates,
 * because that is how people say ranges, and convert here.
 */

export const TIME_ZONE = "Europe/Paris";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const assertDate = (value: string, field: string): string => {
  // Round-trip, because Date rolls 2026-02-30 over to 2 March instead of failing.
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (
    !DATE_RE.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new PreconditionError(`${field} must be a date like 2026-11-01, got "${value}".`);
  }
  return value;
};

/** The Paris UTC offset at an instant, as "+01:00" / "+02:00". */
export const parisOffsetAt = (instantMs: number): string => {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(new Date(instantMs))
    .find((p) => p.type === "timeZoneName")?.value;
  // "GMT+01:00"; plain "GMT" would mean +00:00, which Paris never is.
  const offset = part?.replace(/^GMT/, "") ?? "";
  return /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "+00:00";
};

const offsetMinutes = (offset: string): number => {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * ((h ?? 0) * 60 + (m ?? 0));
};

/**
 * Paris midnight of a date, with the offset in force AT that midnight. On the
 * last Sunday of March the change happens at 02:00, so midnight is still
 * +01:00 even though noon is +02:00. Hence the second pass.
 */
export const parisMidnight = (date: string): string => {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  let offset = parisOffsetAt(utcMidnight);
  const actual = parisOffsetAt(utcMidnight - offsetMinutes(offset) * 60_000);
  if (actual !== offset) offset = actual;
  return `${date}T00:00:00${offset}`;
};

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** "2026-11" from a date, and month arithmetic on it. */
export const monthOf = (date: string): string => date.slice(0, 7);

export const addMonths = (month: string, months: number): string => {
  const [y, m] = month.split("-").map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

/** Today's date in Paris. */
export const parisToday = (now: number = Date.now()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

/** Whole days from `from` to `to`, inclusive of both. */
export const daysInclusive = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * Validate an inclusive range and return it. `maxDays` caps how much one call
 * may pull, which is what keeps a 30-minute curve from becoming 50,000 rows.
 */
export const assertRange = (
  from: string,
  to: string,
  maxDays: number,
): { from: string; to: string } => {
  assertDate(from, "from");
  assertDate(to, "to");
  const days = daysInclusive(from, to);
  if (days < 1) throw new PreconditionError(`from (${from}) is after to (${to}).`);
  if (days > maxDays) {
    throw new PreconditionError(`That range is ${days} days; this tool takes at most ${maxDays}.`, {
      remedy: "Split it into several calls, or use a coarser step.",
    });
  }
  return { from, to };
};

/** "2026-11-05T00:30:00+01:00" → "2026-11-05T00:30": already Paris-local, so the offset is noise. */
export const localMinute = (iso: string): string => iso.slice(0, 16);
