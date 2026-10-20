/**
 * Duplicate check for events synced in from another source (e.g. daycare
 * notes): compare a candidate event against the rows already in Huckleberry
 * and decide whether it is safe to write. Pure; never writes.
 */

import type {
  FirebaseDiaperData,
  FirebaseFeedIntervalData,
  FirebaseSleepIntervalData,
} from "huckleberry-js";

export type DupKind = "bottle" | "nursing" | "solids" | "diaper" | "potty" | "sleep";

/** An event reduced to what the check compares. Times are epoch seconds. */
export interface DupEvent {
  kind: DupKind;
  start: number;
  /** Set for events with a length (sleep, nursing). */
  end?: number;
}

export type DupVerdict = "duplicate" | "possible_duplicate" | "ok";

export interface DupMatch extends DupEvent {
  minutesApart: number;
  overlaps: boolean;
}

export interface DupResult {
  verdict: DupVerdict;
  reason: string;
  /** Existing events that triggered the verdict, closest first. */
  matches: DupMatch[];
}

/** Same kind this close together: the same event. */
export const DUPLICATE_WINDOW_SEC = 5 * 60;
/** Same family this close together: maybe the same event, ask a human. */
export const POSSIBLE_WINDOW_SEC = 30 * 60;

/** Kinds that can describe the same real-world event. */
const FAMILY: Record<DupKind, string> = {
  bottle: "feed",
  nursing: "feed",
  solids: "feed",
  diaper: "diaper",
  potty: "diaper",
  sleep: "sleep",
};

/** True when two events with lengths share any time. */
function overlaps(a: DupEvent, b: DupEvent): boolean {
  if (a.end === undefined || b.end === undefined) return false;
  return a.start < b.end && b.start < a.end;
}

/**
 * Classify `event` against `existing`:
 * - same kind within 5 min of an existing entry → `duplicate` (skip)
 * - same family within 30 min, or overlapping times → `possible_duplicate` (ask)
 * - otherwise → `ok` (write)
 */
export function checkDuplicate(event: DupEvent, existing: DupEvent[]): DupResult {
  const related = existing
    .filter((e) => FAMILY[e.kind] === FAMILY[event.kind])
    .map((e) => ({
      ...e,
      gapSec: Math.abs(e.start - event.start),
      overlaps: overlaps(e, event),
    }))
    .sort((a, b) => a.gapSec - b.gapSec);

  const toMatch = ({ gapSec, ...e }: (typeof related)[number]): DupMatch => ({
    ...e,
    minutesApart: Math.round(gapSec / 60),
  });

  const dups = related.filter((e) => e.kind === event.kind && e.gapSec <= DUPLICATE_WINDOW_SEC);
  if (dups.length) {
    return {
      verdict: "duplicate",
      reason: `Matches an existing ${event.kind} ${dups[0]!.gapSec < 60 ? "at the same time" : `${Math.round(dups[0]!.gapSec / 60)} min away`}; skip it.`,
      matches: dups.map(toMatch),
    };
  }

  const near = related.filter((e) => e.gapSec <= POSSIBLE_WINDOW_SEC || e.overlaps);
  if (near.length) {
    const first = near[0]!;
    return {
      verdict: "possible_duplicate",
      reason: first.overlaps
        ? `Overlaps an existing ${first.kind}; ask before writing.`
        : `An existing ${first.kind} is ${Math.round(first.gapSec / 60)} min away; ask before writing.`,
      matches: near.map(toMatch),
    };
  }

  return { verdict: "ok", reason: "No similar event nearby; safe to write.", matches: [] };
}

/** Map feed history rows (bottle/nursing/solids) to events. */
export function feedEvents(rows: FirebaseFeedIntervalData[]): DupEvent[] {
  return rows.map((r) =>
    r.mode === "breast"
      ? {
          kind: "nursing",
          start: r.start,
          end: r.start + (r.leftDuration ?? 0) + (r.rightDuration ?? 0),
        }
      : { kind: r.mode === "bottle" ? "bottle" : "solids", start: r.start },
  );
}

/** Map sleep history rows to events. */
export function sleepEvents(rows: FirebaseSleepIntervalData[]): DupEvent[] {
  return rows.map((r) => ({ kind: "sleep", start: r.start, end: r.start + r.duration }));
}

/** Map diaper history rows (diapers + potty) to events. */
export function diaperEvents(rows: FirebaseDiaperData[]): DupEvent[] {
  return rows.map((r) => ({ kind: r.isPotty ? "potty" : "diaper", start: r.start }));
}
