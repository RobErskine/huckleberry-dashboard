/**
 * Shape a `DashboardSummary` into flat, render-ready JSON for the TRMNL plugin.
 *
 * TRMNL polls on an interval and renders the e-ink screen at poll time, so we
 * precompute the "x ago" / clock strings here (they're as fresh as the screen).
 * The `cards` array lets each Liquid view render with a single `{% for %}` loop
 * instead of duplicated markup per metric.
 */

import type {
  DashboardSummary,
  FirebaseFeedDocumentData,
  FirebaseFeedIntervalData,
  FirebaseSleepIntervalData,
  FirebaseDiaperData,
  FirebasePumpIntervalData,
  FirebaseActivityIntervalData,
  FirebaseSleepDocumentData,
  FirebaseChildDocument,
} from "huckleberry-js";

export interface TrmnlCard {
  key: string;
  emoji: string;
  label: string;
  present: boolean;
  inProgress: boolean;
  /** Big readout: "2h 15m ago", "Now", or "—" when absent. */
  ago: string;
  /** local clock, e.g. "3:42 PM" */
  at: string;
  /** free-form extra, e.g. "bottle · 120ml Formula" or "slept 1h 30m" */
  detail: string;
  /** Pre-joined subtitle ("3:42 PM · bottle · 120ml") — empty when absent. */
  sub: string;
  /** Optional parent note attached to the event — empty when none. */
  note: string;
  /** Next sleep "SweetSpot" clock, e.g. "3:00 PM" — empty when none. */
  sweetSpot: string;
  /** epoch seconds of the event (0 if absent) */
  ts: number;
}

/** One logged event placed on the right-hand vertical timeline. */
export interface TrmnlTimelineEvent {
  /** epoch seconds of the event start */
  ts: number;
  /** vertical position within the timeline area: 0 = top (oldest), 100 = now */
  topPct: number;
  /** local clock, e.g. "9:46 AM" */
  clock: string;
  emoji: string;
  /** short type word matching the app's bars: "Bottle", "Pee", "Mixed", … */
  label: string;
  /** category for background shading: feed | nap | diaper | pump | activity */
  group: string;
  /** label + value for display, e.g. "3oz Bottle", "Medium Poo", "25 min Breast" */
  text: string;
}

/** An hour gridline/label on the timeline (like the app's "2am" rows). */
export interface TrmnlTimelineHour {
  topPct: number;
  /** e.g. "2 AM" */
  label: string;
}

export interface TrmnlTimeline {
  /** how many hours back the timeline covers (top → bottom = oldest → now) */
  windowHours: number;
  events: TrmnlTimelineEvent[];
  hours: TrmnlTimelineHour[];
}

/** Raw interval lists (last N hours) used to build the timeline. */
export interface TimelineSources {
  feeds: FirebaseFeedIntervalData[];
  sleeps: FirebaseSleepIntervalData[];
  diapers: FirebaseDiaperData[];
  pumps: FirebasePumpIntervalData[];
  activities: FirebaseActivityIntervalData[];
}

export interface TrmnlPayload {
  childName: string;
  tz: string;
  generatedAt: number;
  generatedAtClock: string;
  cards: TrmnlCard[];
  /**
   * Cards for the full view's left column, in display order:
   * last bottle feed, sleep (asleep now / last nap), last poo, last pee. Split
   * out from `cards` so the home display can show these without affecting the
   * quadrant/half layouts.
   */
  leftCards: TrmnlCard[];
  timeline: TrmnlTimeline;
}

function agoText(startSeconds: number, nowMs: number): string {
  const diff = Math.max(0, nowMs / 1000 - startSeconds);
  const m = Math.floor(diff / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function clockText(startSeconds: number, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(
      new Date(startSeconds * 1000),
    );
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
      new Date(startSeconds * 1000),
    );
  }
}

function durationText(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function cap(s: string | null | undefined): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface CardInput {
  key: string;
  emoji: string;
  label: string;
  /** Event time in epoch seconds, or 0/undefined if there's no event. */
  ts?: number;
  inProgress?: boolean;
  /** Word shown while a timer is running, e.g. "Feeding". */
  progressWord?: string;
  /** Extra detail when not in progress, e.g. "bottle · 120ml" or "slept 1h". */
  detail?: string;
  /** Optional free-text parent note attached to the event. */
  note?: string | null;
  /** Next sleep "SweetSpot" clock, e.g. "3:00 PM". */
  sweetSpot?: string;
}

function makeCard(input: CardInput, tz: string, nowMs: number): TrmnlCard {
  const ts = input.ts ?? 0;
  const present = ts > 0;
  const at = present ? clockText(ts, tz) : "";
  const detail = input.detail ?? "";
  const note = present ? (input.note ?? "").trim() : "";

  let ago: string;
  let sub: string;
  if (input.inProgress) {
    ago = "Now";
    sub = input.progressWord ?? "in progress";
  } else if (present) {
    ago = agoText(ts, nowMs);
    sub = [at, detail].filter(Boolean).join(" · ");
  } else {
    ago = "—";
    sub = "";
  }

  return {
    key: input.key,
    emoji: input.emoji,
    label: input.label,
    present,
    inProgress: !!input.inProgress,
    ago,
    at,
    detail,
    sub,
    note,
    sweetSpot: input.sweetSpot ?? "",
    ts,
  };
}

/** Hour-only clock for gridline labels, e.g. "2 AM". */
function hourLabel(seconds: number, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(seconds * 1000));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
      new Date(seconds * 1000),
    );
  }
}

const DIAPER_LABEL: Record<string, string> = {
  pee: "Pee",
  poo: "Poo",
  both: "Mixed",
  dry: "Dry",
};

/** Humanize an activity mode (e.g. "tummyTime" → "Tummy Time"). */
function humanizeActivity(mode: string): string {
  return cap(mode.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

/** Huckleberry encodes diaper amount as a level; surface it as a size word. */
function sizeWord(n: number | null | undefined): string {
  if (n === 1) return "Small";
  if (n === 2) return "Medium";
  if (n && n >= 3) return "Large";
  return "";
}

/**
 * From a diaper history, pick the two latest changes to show side by side:
 *   - `poo`: the latest poopy change (mode "poo" or "both" / mixed)
 *   - `pee`: the latest pee change (mode "pee" or "both"), but NOT the same
 *     event as `poo` — so the two cards are always distinct.
 */
function pickLatestDiapers(diapers: FirebaseDiaperData[]): {
  poo?: FirebaseDiaperData;
  pee?: FirebaseDiaperData;
} {
  const sorted = [...diapers]
    .filter((d) => d?.start)
    .sort((a, b) => b.start - a.start);
  const poo = sorted.find((d) => d.mode === "poo" || d.mode === "both");
  const pee = sorted.find(
    (d) => (d.mode === "pee" || d.mode === "both") && d !== poo,
  );
  return { poo, pee };
}

/**
 * Find the parent note for the last feed of a given mode. `prefs.last*` carries
 * the time but not the note, so we read it off the matching feed interval row
 * (prefer an exact start match; otherwise the latest of that mode in the window).
 */
function noteForFeed(
  feeds: FirebaseFeedIntervalData[],
  mode: "bottle" | "breast",
  prefStart: number | null | undefined,
): string {
  const ofMode = feeds.filter((f) => f.mode === mode && f.start);
  if (!ofMode.length) return "";
  const exact =
    prefStart != null
      ? ofMode.find((f) => Math.abs(f.start - prefStart) < 2)
      : undefined;
  const chosen = exact ?? [...ofMode].sort((a, b) => b.start - a.start)[0];
  return (chosen?.notes ?? "").trim();
}

/** `childs/{cid}.sweetspot` — read from the raw child doc (huckleberry-js
 *  doesn't type it). `sweetSpotTimes` is keyed by nap-day count ("4", "5"…);
 *  `selectedNapDay` picks the active one. Values are epoch seconds. */
interface ChildSweetSpot {
  selectedNapDay?: number | null;
  sweetSpotTimes?: Record<string, number | null> | null;
}

/** Clock of the next SweetSpot (ideal nap start), or "" if none or already past. */
function nextSweetSpot(
  child: FirebaseChildDocument | null | undefined,
  tz: string,
  nowMs: number,
): string {
  const ss = (child as { sweetspot?: ChildSweetSpot | null } | null | undefined)?.sweetspot;
  const t = ss?.sweetSpotTimes?.[String(ss.selectedNapDay)];
  return t && t > nowMs / 1000 ? clockText(t, tz) : "";
}

/** Detail line for a diaper card: size, plus "Mixed" when it's a both event. */
function diaperDetail(d: FirebaseDiaperData | undefined, slot: "poo" | "pee"): string {
  if (!d) return "";
  const parts: string[] = [];
  if (slot === "poo" && d.mode === "both") parts.push("Mixed");
  const size = sizeWord(slot === "poo" ? d.quantity?.poo : d.quantity?.pee);
  if (size) parts.push(size);
  return parts.join(" · ");
}

interface RawTimelineEvent {
  ts: number;
  emoji: string;
  /** category for background shading */
  group: string;
  /** short type word, e.g. "Bottle" */
  label: string;
  /** value/detail prefix, e.g. "3oz", "Medium", "25 min" — empty if none */
  detail: string;
}

/**
 * Flatten the raw interval lists into a single time-ordered set of timeline
 * markers. Each marker carries an emoji, a category (for the gray background),
 * a short type word matching the app's bars, and a value detail (amount /
 * duration / size). We can't show color on e-ink, so label + shade do the work.
 */
function collectTimelineEvents(sources: TimelineSources): RawTimelineEvent[] {
  const out: RawTimelineEvent[] = [];

  for (const f of sources.feeds) {
    if (!f?.start) continue;
    if (f.mode === "breast") {
      const secs = (f.leftDuration ?? 0) + (f.rightDuration ?? 0);
      out.push({ ts: f.start, emoji: "🍼", group: "feed", label: "Breast", detail: durationText(secs) });
    } else if (f.mode === "solids") {
      out.push({ ts: f.start, emoji: "🍼", group: "feed", label: "Solids", detail: "" });
    } else {
      const detail = f.amount != null ? `${f.amount}${f.units ?? ""}` : "";
      out.push({ ts: f.start, emoji: "🍼", group: "feed", label: "Bottle", detail });
    }
  }
  for (const s of sources.sleeps) {
    if (!s?.start) continue;
    out.push({ ts: s.start, emoji: "💤", group: "nap", label: "Nap", detail: durationText(s.duration) });
  }
  for (const d of sources.diapers) {
    if (!d?.start) continue;
    const qty = d.mode === "pee" ? d.quantity?.pee : d.quantity?.poo;
    out.push({
      ts: d.start,
      emoji: "🧷",
      group: "diaper",
      label: DIAPER_LABEL[d.mode] ?? "Diaper",
      detail: sizeWord(qty),
    });
  }
  for (const p of sources.pumps) {
    if (!p?.start) continue;
    const amount = (p.leftAmount ?? 0) + (p.rightAmount ?? 0);
    const detail = amount > 0 ? `${amount}${p.units ?? ""}` : durationText(p.duration);
    out.push({ ts: p.start, emoji: "🤱", group: "pump", label: "Pump", detail });
  }
  for (const a of sources.activities) {
    if (!a?.start) continue;
    out.push({
      ts: a.start,
      emoji: "🧸",
      group: "activity",
      label: humanizeActivity(a.mode),
      detail: durationText(a.duration),
    });
  }

  return out;
}

/**
 * Build the right-hand vertical timeline: events placed proportionally by time
 * over a fixed window (top = `windowHours` ago, bottom = now) plus hour
 * gridlines. Positions are precomputed as percentages so the Liquid view just
 * sets `top: {{ topPct }}%`.
 */
export function buildTimeline(
  sources: TimelineSources,
  tz: string,
  nowMs: number,
  windowHours = 6,
): TrmnlTimeline {
  const nowS = Math.floor(nowMs / 1000);
  const startS = nowS - windowHours * 3600;
  const span = nowS - startS; // seconds, > 0
  const pct = (ts: number) =>
    Math.min(100, Math.max(0, ((ts - startS) / span) * 100));

  const events: TrmnlTimelineEvent[] = collectTimelineEvents(sources)
    .filter((e) => e.ts >= startS && e.ts <= nowS)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({
      ts: e.ts,
      topPct: Math.round(pct(e.ts) * 10) / 10,
      clock: clockText(e.ts, tz),
      emoji: e.emoji,
      label: e.label,
      group: e.group,
      text: e.detail ? `${e.detail} ${e.label}` : e.label,
    }));

  // Hour gridlines aligned to whole hours within the window.
  const hours: TrmnlTimelineHour[] = [];
  const firstHour = Math.ceil(startS / 3600) * 3600;
  for (let t = firstHour; t <= nowS; t += 3600) {
    hours.push({ topPct: Math.round(pct(t) * 10) / 10, label: hourLabel(t, tz) });
  }

  return { windowHours, events, hours };
}

/** Strip Liquid-unused card fields, round timeline topPct to integers, then
 *  drop the oldest timeline events (front of the array) until the serialised
 *  object fits within `limitBytes`. Returns a plain object ready to be sent as
 *  the `merge_variables` body to the TRMNL webhook. */
export function trimForWebhook(payload: TrmnlPayload, limitBytes = 4900): object {
  // Keep only fields the Liquid views actually reference. `sub`/`note` must
  // always be present (even as "") because the views use `!= ""` comparisons —
  // nil (absent) would pass that check in Liquid and render empty content.
  function minifyCard(c: TrmnlCard): object {
    const out: Record<string, unknown> = {
      emoji: c.emoji,
      label: c.label,
      present: c.present,
      ago: c.ago,
      sub: c.sub,
      note: c.note,
    };
    if (c.inProgress) out.inProgress = true;
    // Optional: the view tests `{% if c.sweetSpot %}` (absent = nil = falsy).
    if (c.sweetSpot) out.sweetSpot = c.sweetSpot;
    return out;
  }

  // Mutable copy; buildTimeline already sorts oldest→newest, so shift() drops
  // the oldest event each iteration.
  const events = payload.timeline.events.map((e) => ({
    ts: e.ts,
    topPct: Math.round(e.topPct),
    clock: e.clock,
    emoji: e.emoji,
    label: e.label,
    group: e.group,
    text: e.text,
  }));

  const build = (evts: typeof events): object => ({
    childName: payload.childName,
    tz: payload.tz,
    generatedAt: payload.generatedAt,
    generatedAtClock: payload.generatedAtClock,
    cards: payload.cards.map(minifyCard),
    leftCards: payload.leftCards.map(minifyCard),
    timeline: {
      windowHours: payload.timeline.windowHours,
      events: evts,
      hours: payload.timeline.hours,
    },
  });

  let result = build(events);
  let dropped = 0;
  while (events.length > 0 && JSON.stringify(result).length > limitBytes) {
    events.shift();
    dropped++;
    result = build(events);
  }

  const size = JSON.stringify(result).length;
  if (dropped > 0) {
    console.log(`[trmnl-webhook] dropped ${dropped} oldest timeline events; size=${size}B`);
  } else {
    console.log(`[trmnl-webhook] payload size=${size}B`);
  }

  return result;
}

/**
 * Full-view sleep card. While asleep: how long so far ("1h 20m", since the
 * live timer started). While awake: time since the last nap *ended* (awake
 * time), how long it lasted, and the next SweetSpot if it's still ahead.
 */
function sleepCard(
  summary: DashboardSummary,
  sleep: FirebaseSleepDocumentData | null | undefined,
  child: FirebaseChildDocument | null | undefined,
  tz: string,
  nowMs: number,
): TrmnlCard {
  if (summary.sleepInProgress) {
    // Sleep timers store `timerStartTime` in milliseconds.
    const startMs = sleep?.timer?.timerStartTime ?? 0;
    const since = Math.floor(startMs / 1000);
    const card = makeCard(
      { key: "sleep", emoji: "💤", label: "Asleep", ts: since, inProgress: true, progressWord: "Sleeping" },
      tz,
      nowMs,
    );
    if (since) {
      card.ago = durationText(Math.max(60, nowMs / 1000 - since));
      card.sub = `since ${card.at}`;
    }
    return card;
  }

  const s = summary.lastSleep;
  return makeCard(
    {
      key: "sleep",
      emoji: "💤",
      label: "Last nap",
      ts: s ? Math.round(s.start + (s.duration ?? 0)) : undefined,
      detail: s && durationText(s.duration) ? `slept ${durationText(s.duration)}` : "",
      sweetSpot: nextSweetSpot(child, tz, nowMs),
    },
    tz,
    nowMs,
  );
}

export function formatForTrmnl(
  summary: DashboardSummary,
  tz: string,
  nowMs: number,
  sources?: TimelineSources,
  feed?: FirebaseFeedDocumentData | null,
  sleep?: FirebaseSleepDocumentData | null,
  child?: FirebaseChildDocument | null,
): TrmnlPayload {
  const f = summary.lastFeed;
  const s = summary.lastSleep;
  const g = summary.lastGrowth;

  const cards: TrmnlCard[] = [
    makeCard(
      {
        key: "fed",
        emoji: "🍼",
        label: "Fed",
        ts: f?.start,
        inProgress: summary.feedInProgress,
        progressWord: "Feeding",
        detail: f ? [cap(f.kind), f.detail].filter(Boolean).join(" · ") : "",
      },
      tz,
      nowMs,
    ),
    makeCard(
      {
        key: "nap",
        emoji: "💤",
        label: "Nap",
        ts: s?.start,
        inProgress: summary.sleepInProgress,
        progressWord: "Sleeping",
        detail: s && durationText(s.duration) ? `slept ${durationText(s.duration)}` : "",
      },
      tz,
      nowMs,
    ),
    makeCard(
      {
        key: "diaper",
        emoji: "🧷",
        label: "Diaper",
        ts: summary.lastDiaper?.start,
        detail: cap(summary.lastDiaper?.mode),
      },
      tz,
      nowMs,
    ),
    makeCard(
      {
        key: "pump",
        emoji: "🤱",
        label: "Pump",
        ts: summary.lastPump?.start,
        detail: durationText(summary.lastPump?.duration),
      },
      tz,
      nowMs,
    ),
  ];

  // Growth (optional, appended so the core four stay first).
  if (g?.weight) {
    cards.push(
      makeCard(
        {
          key: "growth",
          emoji: "📏",
          label: "Weight",
          ts: g.start,
          detail: `${g.weight}${g.weightUnits ?? ""}`,
        },
        tz,
        nowMs,
      ),
    );
  }

  // Left column of the full view: last bottle, sleep, and the two latest
  // diaper changes (poopy vs pee). The bottle comes from the feed tracker's
  // prefs so it's the *last* of its kind; the diapers come from the diaper
  // history so we can find the last poopy change even if it's older than the
  // timeline window.
  const bottle = feed?.prefs?.lastBottle;
  const { poo, pee } = pickLatestDiapers(sources?.diapers ?? []);
  const feeds = sources?.feeds ?? [];
  const leftCards: TrmnlCard[] = [
    makeCard(
      {
        key: "fed-bottle",
        emoji: "🍼",
        label: "Bottle",
        ts: bottle?.start ?? undefined,
        detail:
          bottle?.bottleAmount != null
            ? `${bottle.bottleAmount}${bottle.bottleUnits ?? ""}`
            : cap(bottle?.bottleType),
        note: noteForFeed(feeds, "bottle", bottle?.start),
      },
      tz,
      nowMs,
    ),
    sleepCard(summary, sleep, child, tz, nowMs),
    makeCard(
      {
        key: "diaper-poo",
        emoji: "💩",
        label: "Poo",
        ts: poo?.start,
        detail: diaperDetail(poo, "poo"),
        note: poo?.notes,
      },
      tz,
      nowMs,
    ),
    makeCard(
      {
        key: "diaper-pee",
        emoji: "💧",
        label: "Pee",
        ts: pee?.start,
        detail: diaperDetail(pee, "pee"),
        note: pee?.notes,
      },
      tz,
      nowMs,
    ),
  ];

  const timeline = sources
    ? buildTimeline(sources, tz, nowMs)
    : { windowHours: 6, events: [], hours: [] };

  return {
    childName: summary.child.name ?? "Baby",
    tz,
    generatedAt: nowMs,
    generatedAtClock: clockText(Math.floor(nowMs / 1000), tz),
    cards,
    leftCards,
    timeline,
  };
}
