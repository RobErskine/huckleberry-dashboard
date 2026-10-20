import { describe, it, expect } from "vitest";
import type { FirebaseDiaperData, FirebaseFeedIntervalData } from "huckleberry-js";
import { checkDuplicate, diaperEvents, feedEvents, type DupEvent } from "../src/dedupe.js";

/** Epoch seconds for a wall-clock time on Oct 19, 2026 in America/New_York (UTC-4). */
const at = (h: number, m: number) => Date.UTC(2026, 9, 19, h + 4, m) / 1000;

describe("checkDuplicate", () => {
  it("same type within 5 min is a duplicate", () => {
    const r = checkDuplicate({ kind: "bottle", start: at(10, 17) }, [{ kind: "bottle", start: at(10, 15) }]);
    expect(r.verdict).toBe("duplicate");
    expect(r.matches[0]!.minutesApart).toBe(2);
  });

  it("10:15 bottle vs a 10:32 bottle is a possible duplicate", () => {
    const r = checkDuplicate({ kind: "bottle", start: at(10, 32) }, [{ kind: "bottle", start: at(10, 15) }]);
    expect(r.verdict).toBe("possible_duplicate");
    expect(r.matches[0]!.minutesApart).toBe(17);
  });

  it("a different feed type nearby is a possible duplicate, not a duplicate", () => {
    const r = checkDuplicate({ kind: "bottle", start: at(10, 16) }, [{ kind: "nursing", start: at(10, 15), end: at(10, 30) }]);
    expect(r.verdict).toBe("possible_duplicate");
  });

  it("pee and poo diapers 3 min apart are a duplicate", () => {
    const r = checkDuplicate({ kind: "diaper", start: at(9, 3) }, [{ kind: "diaper", start: at(9, 0) }]);
    expect(r.verdict).toBe("duplicate");
  });

  it("a potty sit next to a diaper change is only a possible duplicate", () => {
    const r = checkDuplicate({ kind: "potty", start: at(9, 2) }, [{ kind: "diaper", start: at(9, 0) }]);
    expect(r.verdict).toBe("possible_duplicate");
  });

  it("overlapping sleep far from the existing start is a possible duplicate", () => {
    const existing: DupEvent[] = [{ kind: "sleep", start: at(13, 0), end: at(15, 0) }];
    const r = checkDuplicate({ kind: "sleep", start: at(14, 0), end: at(14, 45) }, existing);
    expect(r.verdict).toBe("possible_duplicate");
    expect(r.matches[0]!.overlaps).toBe(true);
  });

  it("a nap with the same start is a duplicate", () => {
    const existing: DupEvent[] = [{ kind: "sleep", start: at(13, 0), end: at(14, 30) }];
    expect(checkDuplicate({ kind: "sleep", start: at(13, 2), end: at(14, 0) }, existing).verdict).toBe("duplicate");
  });

  it("a later nap that does not overlap is ok", () => {
    const existing: DupEvent[] = [{ kind: "sleep", start: at(9, 0), end: at(10, 0) }];
    expect(checkDuplicate({ kind: "sleep", start: at(10, 31), end: at(11, 0) }, existing).verdict).toBe("ok");
  });

  it("same type more than 30 min away, or another family at the same time, is ok", () => {
    expect(checkDuplicate({ kind: "bottle", start: at(12, 0) }, [{ kind: "bottle", start: at(10, 15) }]).verdict).toBe("ok");
    expect(checkDuplicate({ kind: "bottle", start: at(10, 15) }, [{ kind: "diaper", start: at(10, 15) }]).verdict).toBe("ok");
    expect(checkDuplicate({ kind: "bottle", start: at(10, 15) }, []).verdict).toBe("ok");
  });

  it("lists matches closest first", () => {
    const r = checkDuplicate({ kind: "bottle", start: at(10, 30) }, [
      { kind: "bottle", start: at(10, 5) },
      { kind: "bottle", start: at(10, 20) },
    ]);
    expect(r.matches.map((m) => m.minutesApart)).toEqual([10, 25]);
  });
});

describe("row mappers", () => {
  it("maps feed rows by mode and gives nursing a length", () => {
    const rows = [
      { mode: "breast", start: 100, lastSide: "left", leftDuration: 300, rightDuration: 200, offset: 0 },
      { mode: "bottle", start: 200, bottleType: "Formula", amount: 90, units: "ml", offset: 0 },
      { mode: "solids", start: 300, offset: 0 },
    ] as FirebaseFeedIntervalData[];
    expect(feedEvents(rows)).toEqual([
      { kind: "nursing", start: 100, end: 600 },
      { kind: "bottle", start: 200 },
      { kind: "solids", start: 300 },
    ]);
  });

  it("splits potty rows from diaper rows", () => {
    const rows = [
      { mode: "pee", start: 100, offset: 0 },
      { mode: "pee", start: 200, offset: 0, isPotty: true },
    ] as FirebaseDiaperData[];
    expect(diaperEvents(rows).map((e) => e.kind)).toEqual(["diaper", "potty"]);
  });
});
