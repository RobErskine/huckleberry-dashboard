/**
 * Time helpers shared by the REST log routes and the MCP write tools.
 *
 * Times come in as epoch seconds or ISO 8601 strings and leave as epoch
 * seconds, which is what huckleberry-js writes to Firestore.
 */

/** Epoch seconds above this are really milliseconds (year ~5138 in seconds). */
const MAX_EPOCH_SECONDS = 1e11;

/** Allowed clock skew for "future" times, in seconds. */
const FUTURE_SKEW_SEC = 5 * 60;

/** ISO strings must carry a zone; the Worker's local time is UTC, not the user's. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Parse a time input (epoch seconds or ISO string) into epoch seconds. */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

/**
 * Parse a strict time argument for a write tool. Returns `undefined` when the
 * argument is omitted, and throws on input that would write the wrong time:
 * unparseable values, milliseconds, ISO strings without a zone, or times in
 * the future.
 */
export function timeArg(
  name: string,
  v: string | number | undefined,
  nowSec: number,
): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number" && v > MAX_EPOCH_SECONDS) {
    throw new Error(`${name} looks like epoch milliseconds; pass epoch seconds or an ISO 8601 string.`);
  }
  if (typeof v === "string" && !HAS_ZONE.test(v.trim())) {
    throw new Error(`${name} must include a timezone offset (e.g. 2026-10-19T10:15:00-04:00).`);
  }
  const t = parseTime(typeof v === "string" ? v.trim() : v);
  if (t === undefined || t < 0) {
    throw new Error(`${name} is not a valid time; pass epoch seconds or an ISO 8601 string.`);
  }
  if (t > nowSec + FUTURE_SKEW_SEC) throw new Error(`${name} is in the future.`);
  return t;
}

/**
 * Resolve a start/end range (epoch seconds) for a timed event from any of:
 * `start`+`end`, `start`+`durationMinutes`, `end`+`durationMinutes`,
 * `durationMinutes` alone (ending now), or `start` alone (ending now).
 */
export function resolveRange(
  args: { start?: number; end?: number; durationMinutes?: number },
  nowSec: number,
): { start: number; end: number } {
  const { start, end, durationMinutes } = args;
  const dur = durationMinutes === undefined ? undefined : Math.round(durationMinutes * 60);
  if (start !== undefined && end !== undefined && dur !== undefined) {
    throw new Error("Pass at most two of start, end, and durationMinutes.");
  }

  let range: { start: number; end: number };
  if (start !== undefined && end !== undefined) range = { start, end };
  else if (start !== undefined && dur !== undefined) range = { start, end: start + dur };
  else if (end !== undefined && dur !== undefined) range = { start: end - dur, end };
  else if (dur !== undefined) range = { start: nowSec - dur, end: nowSec };
  else if (start !== undefined) range = { start, end: nowSec };
  else throw new Error("Provide durationMinutes, or start (and optionally end).");

  if (range.end <= range.start) throw new Error("end must be after start.");
  if (range.end > nowSec + FUTURE_SKEW_SEC) throw new Error("end is in the future.");
  return range;
}
