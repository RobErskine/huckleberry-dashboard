import { describe, it, expect } from "vitest";
import { parseTime, resolveRange, timeArg } from "../src/time.js";

const NOW = Date.UTC(2026, 9, 20, 14, 0) / 1000; // 10:00 AM America/New_York
const HOUR = 3600;

describe("timeArg", () => {
  it("returns undefined when omitted, so the write defaults to now", () => {
    expect(timeArg("start", undefined, NOW)).toBeUndefined();
  });

  it("accepts epoch seconds and ISO strings with an offset", () => {
    expect(timeArg("start", NOW - HOUR, NOW)).toBe(NOW - HOUR);
    expect(timeArg("start", "2026-10-19T10:15:00-04:00", NOW)).toBe(Date.UTC(2026, 9, 19, 14, 15) / 1000);
    expect(timeArg("start", "2026-10-19T14:15:00Z", NOW)).toBe(Date.UTC(2026, 9, 19, 14, 15) / 1000);
  });

  it("rejects milliseconds, zoneless strings, garbage, and future times", () => {
    expect(() => timeArg("start", NOW * 1000, NOW)).toThrow(/milliseconds/);
    expect(() => timeArg("start", "2026-10-19T10:15:00", NOW)).toThrow(/timezone/);
    expect(() => timeArg("start", "yesterday Z", NOW)).toThrow(/not a valid time/);
    expect(() => timeArg("start", NOW + HOUR, NOW)).toThrow(/future/);
  });

  it("allows small clock skew", () => {
    expect(timeArg("start", NOW + 60, NOW)).toBe(NOW + 60);
  });
});

describe("resolveRange", () => {
  it("durationMinutes alone ends now (old behavior)", () => {
    expect(resolveRange({ durationMinutes: 45 }, NOW)).toEqual({ start: NOW - 45 * 60, end: NOW });
  });

  it("uses start + end as given", () => {
    expect(resolveRange({ start: NOW - 3 * HOUR, end: NOW - 2 * HOUR }, NOW)).toEqual({
      start: NOW - 3 * HOUR,
      end: NOW - 2 * HOUR,
    });
  });

  it("fills the missing side from durationMinutes", () => {
    expect(resolveRange({ start: NOW - 3 * HOUR, durationMinutes: 30 }, NOW)).toEqual({
      start: NOW - 3 * HOUR,
      end: NOW - 3 * HOUR + 1800,
    });
    expect(resolveRange({ end: NOW - HOUR, durationMinutes: 30 }, NOW)).toEqual({
      start: NOW - HOUR - 1800,
      end: NOW - HOUR,
    });
  });

  it("start alone ends now", () => {
    expect(resolveRange({ start: NOW - HOUR }, NOW)).toEqual({ start: NOW - HOUR, end: NOW });
  });

  it("rejects empty, over-specified, reversed, and future ranges", () => {
    expect(() => resolveRange({}, NOW)).toThrow(/Provide/);
    expect(() => resolveRange({ end: NOW - HOUR }, NOW)).toThrow(/Provide/);
    expect(() => resolveRange({ start: NOW - 2 * HOUR, end: NOW - HOUR, durationMinutes: 5 }, NOW)).toThrow(/at most two/);
    expect(() => resolveRange({ start: NOW - HOUR, end: NOW - 2 * HOUR }, NOW)).toThrow(/after start/);
    expect(() => resolveRange({ start: NOW - HOUR, durationMinutes: 600 }, NOW)).toThrow(/future/);
  });
});

describe("parseTime", () => {
  it("keeps the lenient REST behavior", () => {
    expect(parseTime(123)).toBe(123);
    expect(parseTime("2026-10-19T14:15:00Z")).toBe(Date.UTC(2026, 9, 19, 14, 15) / 1000);
    expect(parseTime("nope")).toBeUndefined();
    expect(parseTime(undefined)).toBeUndefined();
  });
});
