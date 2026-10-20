import { describe, it, expect } from "vitest";
import type { DashboardSummary, FirebaseChildDocument } from "huckleberry-js";
import { formatForTrmnl } from "../src/trmnl.js";

const NOW_MS = Date.UTC(2026, 9, 2, 18, 0); // 2:00 PM America/New_York
const NOW_S = NOW_MS / 1000;
const TZ = "America/New_York";

function summary(over: Partial<DashboardSummary>): DashboardSummary {
  return {
    child: { cid: "c1", name: "Baby" },
    sleepInProgress: false,
    feedInProgress: false,
    lastSleep: null,
    lastFeed: null,
    lastDiaper: null,
    lastPump: null,
    lastGrowth: null,
    generatedAt: NOW_MS,
    ...over,
  };
}

function childWithSweetSpot(t: number): FirebaseChildDocument {
  return { sweetspot: { selectedNapDay: 5, sweetSpotTimes: { "4": t - 600, "5": t } } } as FirebaseChildDocument;
}

const sleepCardOf = (p: ReturnType<typeof formatForTrmnl>) => p.leftCards[1];

describe("TRMNL sleep card", () => {
  it("shows elapsed time from the live timer (ms) while asleep, no sweet spot", () => {
    const start = NOW_S - 80 * 60;
    const p = formatForTrmnl(
      summary({ sleepInProgress: true }),
      TZ,
      NOW_MS,
      undefined,
      null,
      { timer: { active: true, paused: false, timerStartTime: start * 1000, uuid: "u" } },
      childWithSweetSpot(NOW_S + 3600),
    );
    const card = sleepCardOf(p);
    expect(card).toMatchObject({ key: "sleep", label: "Asleep", inProgress: true, ago: "1h 20m", sub: "since 12:40 PM", sweetSpot: "" });
  });

  it("shows time since the last nap ended and the upcoming sweet spot while awake", () => {
    const p = formatForTrmnl(
      summary({ lastSleep: { start: NOW_S - 3 * 3600, duration: 3600 } }),
      TZ,
      NOW_MS,
      undefined,
      null,
      null,
      childWithSweetSpot(NOW_S + 3600),
    );
    expect(sleepCardOf(p)).toMatchObject({
      label: "Last nap",
      inProgress: false,
      ago: "2h ago",
      sub: "12:00 PM · slept 1h 0m",
      sweetSpot: "3:00 PM",
    });
  });

  it("hides a sweet spot that is already past", () => {
    const p = formatForTrmnl(
      summary({ lastSleep: { start: NOW_S - 3 * 3600, duration: 3600 } }),
      TZ,
      NOW_MS,
      undefined,
      null,
      null,
      childWithSweetSpot(NOW_S - 60),
    );
    expect(sleepCardOf(p).sweetSpot).toBe("");
  });
});
