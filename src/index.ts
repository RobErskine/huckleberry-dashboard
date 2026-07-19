/**
 * Huckleberry dashboard — Cloudflare Worker.
 *
 * A tiny private app for one household: a login form mints a Firebase token
 * (via the `huckleberry-js` library), the session is stored in KV behind a
 * signed cookie, and a JSON API feeds a "heads-up" dashboard page
 * (last fed / last nap / last diaper) for a home display.
 *
 * As of huckleberry-js 0.3.0 the full set of single-shot writes are exposed
 * behind the same cookie auth: quick-log endpoints for diapers, potty, bottles,
 * nursing, solids, sleep, pump, growth, and activities (`POST /api/log/*`).
 * Every write supports a `dryRun` preview. MCP write tools are gated separately
 * by the `ENABLE_WRITES` env var (see mcp.ts).
 */

import { Hono, type Context } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { HuckleberryClient } from "huckleberry-js";
import type {
  ActivityMode,
  BottleType,
  DiaperAmount,
  DiaperMode,
  FeedSide,
  LogActivityInput,
  LogBottleInput,
  LogDiaperInput,
  LogGrowthInput,
  LogNursingInput,
  LogPottyInput,
  LogPumpInput,
  LogSleepInput,
  LogSolidsInput,
  PooColor,
  PooConsistency,
  PottyResult,
  SolidsFoodRef,
  SolidsReaction,
  VolumeUnits,
  WriteResult,
} from "huckleberry-js";
import {
  clientFromToken,
  deleteSession,
  deleteToken,
  getSession,
  getToken,
  listTokens,
  putSession,
  putToken,
  type StoredSession,
  type StoredToken,
} from "./session.js";
import { formatForTrmnl, trimForWebhook } from "./trmnl.js";
import { HuckleberryMCP } from "./mcp.js";
import { openapiSpec, docsHtml } from "./openapi.js";

// Durable Object class for the MCP server (referenced by wrangler binding).
// app is exported for the docs-coverage test (test/docs-coverage.test.ts).
export { HuckleberryMCP, app };

interface Bindings {
  SESSIONS: KVNamespace;
  SESSION_SECRET: string;
  ASSETS: Fetcher;
  MCP_OBJECT: DurableObjectNamespace;
  /** When truthy ("1"/"true"), the MCP server registers its write tools. */
  ENABLE_WRITES?: string;
  /** API token used by the cron job to fetch data. `wrangler secret put TRMNL_TOKEN` */
  TRMNL_TOKEN?: string;
  /** TRMNL webhook URL. `wrangler secret put TRMNL_WEBHOOK_URL` */
  TRMNL_WEBHOOK_URL?: string;
}

/** Per-request values set by the auth middleware for /api/* routes. */
interface Variables {
  sid: string;
  stored: StoredSession;
  client: HuckleberryClient;
}

const COOKIE = "hb_sid";
const COOKIE_MAX_AGE = 60 * 24 * 60 * 60; // 60 days

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Always return JSON for unhandled errors (the frontend expects JSON, not the
// default plain-text "Internal Server Error").
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal error", detail: String(err) }, 500);
});

// --- helpers ---------------------------------------------------------------

/** Build an authenticated client from a stored session; persist token refreshes. */
function clientFromStored(
  env: Bindings,
  sid: string,
  stored: StoredSession,
): HuckleberryClient {
  return new HuckleberryClient({
    session: {
      idToken: stored.idToken,
      refreshToken: stored.refreshToken,
      uid: stored.uid,
      expiresAt: stored.expiresAt,
    },
    // Firebase rotates/extends tokens on refresh — write them back to KV.
    onSession: async (s) => {
      await putSession(env.SESSIONS, sid, {
        ...s,
        childName: stored.childName,
        cid: stored.cid,
      });
    },
  });
}

/** Fetch all Huckleberry data and return a formatted TRMNL payload.
 *  Shared by the /api/trmnl route and the scheduled cron push. */
async function buildTrmnlPayload(
  env: Bindings,
  token: string,
  rec: StoredToken,
  cid: string,
  tz: string,
): Promise<ReturnType<typeof formatForTrmnl>> {
  const client = clientFromToken(env.SESSIONS, token, rec);
  const nowMs = Date.now();
  const since = new Date(nowMs - 6 * 60 * 60 * 1000);
  const until = new Date(nowMs);
  const wideSince = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  const [summary, feed, feeds, sleeps, diapers, pumps, activities] = await Promise.all([
    client.getDashboardSummary(cid, rec.childName ?? null),
    client.getFeed(cid),
    client.listFeedIntervals(cid, wideSince, until),
    client.listSleepIntervals(cid, since, until),
    client.listDiaperIntervals(cid, wideSince, until),
    client.listPumpIntervals(cid, since, until),
    client.listActivityIntervals(cid, since, until),
  ]);
  return formatForTrmnl(summary, tz, nowMs, { feeds, sleeps, diapers, pumps, activities }, feed);
}

function serveAsset(env: Bindings, req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url.toString(), { headers: req.headers }));
}

/** Generate an opaque 48-char hex token. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- pages -----------------------------------------------------------------

app.get("/", async (c) => {
  const sid = await getSignedCookie(c, c.env.SESSION_SECRET, COOKIE);
  if (sid) {
    const stored = await getSession(c.env.SESSIONS, sid);
    if (stored) return serveAsset(c.env, c.req.raw, "/dashboard.html");
  }
  return c.redirect("/login", 302);
});

app.get("/login", (c) => serveAsset(c.env, c.req.raw, "/login.html"));

// --- auth ------------------------------------------------------------------

app.post("/api/login", async (c) => {
  let body: { email?: string; password?: string; cid?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { email, password, cid } = body;
  if (!email || !password) {
    return c.json({ error: "email and password are required" }, 400);
  }

  // Cookie signing needs this secret. Without it `setSignedCookie` throws — fail
  // early with a clear message instead of a generic 500.
  if (!c.env.SESSION_SECRET) {
    return c.json(
      {
        error:
          "Server not configured: SESSION_SECRET is missing. Run `wrangler secret put SESSION_SECRET`.",
      },
      500,
    );
  }

  const client = new HuckleberryClient();
  try {
    await client.authenticate(email, password);
  } catch (err) {
    return c.json({ error: "Authentication failed", detail: String(err) }, 401);
  }

  let children: Array<{ cid: string; nickname?: string | null }>;
  try {
    const user = await client.getUser();
    children = user?.childList ?? [];
  } catch (err) {
    return c.json({ error: "Failed to load account", detail: String(err) }, 502);
  }
  const chosen =
    children.find((ch) => ch.cid === cid) ?? children[0] ?? null;

  const session = client.getSession()!;
  const sid = crypto.randomUUID();
  await putSession(c.env.SESSIONS, sid, {
    idToken: session.idToken,
    refreshToken: session.refreshToken,
    uid: session.uid,
    expiresAt: session.expiresAt,
    childName: chosen?.nickname ?? null,
    cid: chosen?.cid ?? null,
  });

  await setSignedCookie(c, COOKIE, sid, c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return c.json({
    ok: true,
    children: children.map((ch) => ({ cid: ch.cid, name: ch.nickname ?? null })),
    selected: chosen ? { cid: chosen.cid, name: chosen.nickname ?? null } : null,
  });
});

app.post("/api/logout", async (c) => {
  const sid = await getSignedCookie(c, c.env.SESSION_SECRET, COOKIE);
  if (sid) await deleteSession(c.env.SESSIONS, sid);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// --- Token-authenticated polling endpoint ------------------------------------
//
// Returns flat, render-ready JSON for any polling client (TRMNL plugin, home
// dashboards, etc.). Auth via `Authorization: Bearer <token>` or `?token=`.
// Registered before the cookie middleware so it isn't gated by it.
//
// /api/trmnl is kept as a permanent alias for backwards compatibility — existing
// TRMNL plugin URLs already point to it and must keep working.

async function latestHandler(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  const auth = c.req.header("authorization") ?? "";
  const token =
    (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "") ||
    c.req.query("token") ||
    "";
  if (!token) return c.json({ error: "Missing token" }, 401);

  const rec = await getToken(c.env.SESSIONS, token);
  if (!rec) return c.json({ error: "Invalid or revoked token" }, 401);

  // Use `||` so an empty query string ("?cid=") falls back to the token's cid.
  const cid = c.req.query("cid") || rec.cid;
  if (!cid) return c.json({ error: "No child id (cid) available" }, 400);
  const tz = c.req.query("tz") || rec.tz || "UTC";

  try {
    return c.json(await buildTrmnlPayload(c.env, token, rec, cid, tz));
  } catch (err) {
    return c.json({ error: "Failed to load summary", detail: String(err) }, 502);
  }
}

app.get("/api/latest", latestHandler);
app.get("/api/trmnl", latestHandler); // permanent backwards-compat alias

// --- API docs (public, no auth) --------------------------------------------

app.get("/api", (c) => c.html(docsHtml()));
app.get("/api/openapi.json", (c) => c.json(openapiSpec));

// --- authenticated API (read-only) -----------------------------------------

/** Middleware: require a valid session for everything under /api/* except the public routes. */
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (
    path === "/api/login" ||
    path === "/api/logout" ||
    path === "/api/latest" ||
    path === "/api/trmnl" ||
    path === "/api/openapi.json"
  ) {
    return next();
  }

  const sid = await getSignedCookie(c, c.env.SESSION_SECRET, COOKIE);
  if (!sid) return c.json({ error: "Not authenticated" }, 401);
  const stored = await getSession(c.env.SESSIONS, sid);
  if (!stored) return c.json({ error: "Session expired" }, 401);

  c.set("sid", sid);
  c.set("stored", stored);
  c.set("client", clientFromStored(c.env, sid, stored));
  return next();
});

app.get("/api/children", async (c) => {
  const client = c.get("client");
  try {
    const user = await client.getUser();
    const children = (user?.childList ?? []).map((ch) => ({
      cid: ch.cid,
      name: ch.nickname ?? null,
    }));
    return c.json({ children, defaultCid: c.get("stored").cid ?? null });
  } catch (err) {
    return c.json({ error: "Failed to load children", detail: String(err) }, 502);
  }
});

app.get("/api/summary", async (c) => {
  const client = c.get("client");
  const stored = c.get("stored");
  const cid = c.req.query("cid") ?? stored.cid;
  if (!cid) return c.json({ error: "No child id (cid) available" }, 400);

  try {
    const summary = await client.getDashboardSummary(
      cid,
      cid === stored.cid ? (stored.childName ?? null) : null,
    );
    return c.json(summary);
  } catch (err) {
    return c.json({ error: "Failed to load summary", detail: String(err) }, 502);
  }
});

// --- write/log endpoints (cookie-authenticated) ----------------------------
//
// Quick-log actions backed by huckleberry-js 0.3.0 writes. They share the same
// session cookie as the read API (no extra gate — the login is the access
// boundary). Each accepts an optional `dryRun: true` to preview the planned
// Firestore writes without committing. Writes hit the real Huckleberry account.

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type Body = Record<string, unknown>;

const DIAPER_MODES: readonly DiaperMode[] = ["pee", "poo", "both", "dry"];
const DIAPER_AMOUNTS: readonly DiaperAmount[] = ["little", "medium", "big"];
const POO_COLORS: readonly PooColor[] = [
  "yellow",
  "brown",
  "black",
  "green",
  "red",
  "gray",
];
const POO_CONSISTENCIES: readonly PooConsistency[] = [
  "solid",
  "loose",
  "runny",
  "mucousy",
  "hard",
  "pebbles",
  "diarrhea",
];
const POTTY_RESULTS: readonly PottyResult[] = ["satButDry", "wentPotty", "accident"];
const BOTTLE_TYPES: readonly BottleType[] = [
  "Breast Milk",
  "Formula",
  "Tube Feeding",
  "Cow Milk",
  "Goat Milk",
  "Soy Milk",
  "Other",
];
const VOLUME_UNITS: readonly VolumeUnits[] = ["ml", "oz"];
const FEED_SIDES: readonly FeedSide[] = ["left", "right", "none"];
const SOLIDS_REACTIONS: readonly SolidsReaction[] = [
  "LOVED",
  "MEH",
  "HATED",
  "ALLERGIC",
];
const ACTIVITY_MODES: readonly ActivityMode[] = [
  "bath",
  "tummyTime",
  "storyTime",
  "screenTime",
  "skinToSkin",
  "outdoorPlay",
  "indoorPlay",
  "brushTeeth",
];
const GROWTH_UNITS = ["metric", "imperial"] as const;

/** Resolve the child id from the body, falling back to the session default. */
function resolveCid(body: Body, stored: StoredSession): string | null {
  return (typeof body.cid === "string" && body.cid) || stored.cid || null;
}

/** Read a non-empty string field, or `undefined`. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Read a finite number field, or `undefined`. */
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a time input (epoch seconds or ISO string) into epoch seconds. */
function parseTime(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

/** Parse + validate the JSON body shared by every log endpoint. */
async function readLogBody(
  c: AppContext,
): Promise<{ body: Body; cid: string; dryRun: boolean } | Response> {
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const cid = resolveCid(body, c.get("stored"));
  if (!cid) return c.json({ error: "No child id (cid) available" }, 400);
  return { body, cid, dryRun: body.dryRun === true };
}

/** Run a log write (honoring dryRun) and return a uniform JSON envelope. */
async function runLog(
  c: AppContext,
  label: string,
  fn: () => Promise<WriteResult>,
): Promise<Response> {
  try {
    const result = await fn();
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ error: `Failed to log ${label}`, detail: String(err) }, 502);
  }
}

app.post("/api/log/diaper", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const mode = str(body.mode);
  if (!mode || !DIAPER_MODES.includes(mode as DiaperMode)) {
    return c.json(
      { error: `mode is required and must be one of: ${DIAPER_MODES.join(", ")}` },
      400,
    );
  }

  const input: LogDiaperInput = { mode: mode as DiaperMode };
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;
  const pee = str(body.peeAmount);
  if (pee && DIAPER_AMOUNTS.includes(pee as DiaperAmount)) input.peeAmount = pee as DiaperAmount;
  const poo = str(body.pooAmount);
  if (poo && DIAPER_AMOUNTS.includes(poo as DiaperAmount)) input.pooAmount = poo as DiaperAmount;
  const color = str(body.color);
  if (color && POO_COLORS.includes(color as PooColor)) input.color = color as PooColor;
  const consistency = str(body.consistency);
  if (consistency && POO_CONSISTENCIES.includes(consistency as PooConsistency)) {
    input.consistency = consistency as PooConsistency;
  }
  if (typeof body.diaperRash === "boolean") input.diaperRash = body.diaperRash;
  const notes = str(body.notes);
  if (notes) input.notes = notes;

  return runLog(c, "diaper", () => c.get("client").logDiaper(cid, input, { dryRun }));
});

app.post("/api/log/potty", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const mode = str(body.mode);
  if (!mode || !DIAPER_MODES.includes(mode as DiaperMode)) {
    return c.json(
      { error: `mode is required and must be one of: ${DIAPER_MODES.join(", ")}` },
      400,
    );
  }
  const howItHappened = str(body.howItHappened);
  if (!howItHappened || !POTTY_RESULTS.includes(howItHappened as PottyResult)) {
    return c.json(
      { error: `howItHappened is required and must be one of: ${POTTY_RESULTS.join(", ")}` },
      400,
    );
  }

  const input: LogPottyInput = {
    mode: mode as DiaperMode,
    howItHappened: howItHappened as PottyResult,
  };
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;
  const notes = str(body.notes);
  if (notes) input.notes = notes;

  return runLog(c, "potty", () => c.get("client").logPotty(cid, input, { dryRun }));
});

app.post("/api/log/bottle", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const amount = num(body.amount);
  if (amount === undefined || amount <= 0) {
    return c.json({ error: "amount is required and must be a positive number" }, 400);
  }

  const input: LogBottleInput = { amount };
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;
  const units = str(body.units);
  if (units && VOLUME_UNITS.includes(units as VolumeUnits)) input.units = units as VolumeUnits;
  const bottleType = str(body.bottleType);
  if (bottleType && BOTTLE_TYPES.includes(bottleType as BottleType)) {
    input.bottleType = bottleType as BottleType;
  }

  return runLog(c, "bottle", () => c.get("client").logBottle(cid, input, { dryRun }));
});

app.post("/api/log/nursing", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const start = parseTime(body.start);
  const end = parseTime(body.end);
  if (start === undefined || end === undefined) {
    return c.json({ error: "start and end (epoch seconds or ISO) are required" }, 400);
  }
  if (end <= start) {
    return c.json({ error: "end must be after start" }, 400);
  }

  const input: LogNursingInput = { start, end };
  const side = str(body.side);
  if (side && FEED_SIDES.includes(side as FeedSide)) input.side = side as FeedSide;
  const leftDuration = num(body.leftDuration);
  const rightDuration = num(body.rightDuration);
  if (leftDuration !== undefined && rightDuration !== undefined) {
    input.leftDuration = leftDuration;
    input.rightDuration = rightDuration;
  }

  return runLog(c, "nursing", () => c.get("client").logNursing(cid, input, { dryRun }));
});

app.post("/api/log/sleep", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const start = parseTime(body.start);
  const end = parseTime(body.end);
  if (start === undefined || end === undefined) {
    return c.json({ error: "start and end (epoch seconds or ISO) are required" }, 400);
  }
  if (end <= start) {
    return c.json({ error: "end must be after start" }, 400);
  }

  const input: LogSleepInput = { start, end };
  return runLog(c, "sleep", () => c.get("client").logSleep(cid, input, { dryRun }));
});

app.post("/api/log/pump", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const totalAmount = num(body.totalAmount);
  const leftAmount = num(body.leftAmount);
  const rightAmount = num(body.rightAmount);
  if (
    (totalAmount === undefined || totalAmount <= 0) &&
    (leftAmount === undefined || rightAmount === undefined)
  ) {
    return c.json(
      { error: "Provide a positive totalAmount, or both leftAmount and rightAmount" },
      400,
    );
  }

  const input: LogPumpInput = {};
  if (totalAmount !== undefined) input.totalAmount = totalAmount;
  if (leftAmount !== undefined) input.leftAmount = leftAmount;
  if (rightAmount !== undefined) input.rightAmount = rightAmount;
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;
  const duration = num(body.duration);
  if (duration !== undefined) input.duration = duration;
  const units = str(body.units);
  if (units && VOLUME_UNITS.includes(units as VolumeUnits)) input.units = units as VolumeUnits;
  const notes = str(body.notes);
  if (notes) input.notes = notes;

  return runLog(c, "pump", () => c.get("client").logPump(cid, input, { dryRun }));
});

app.post("/api/log/growth", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const weight = num(body.weight);
  const height = num(body.height);
  const head = num(body.head);
  if (weight === undefined && height === undefined && head === undefined) {
    return c.json(
      { error: "At least one of weight, height, or head is required" },
      400,
    );
  }

  const input: LogGrowthInput = {};
  if (weight !== undefined) input.weight = weight;
  if (height !== undefined) input.height = height;
  if (head !== undefined) input.head = head;
  const units = str(body.units);
  if (units && (GROWTH_UNITS as readonly string[]).includes(units)) {
    input.units = units as "metric" | "imperial";
  }
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;

  return runLog(c, "growth", () => c.get("client").logGrowth(cid, input, { dryRun }));
});

app.post("/api/log/activity", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const mode = str(body.mode);
  if (!mode || !ACTIVITY_MODES.includes(mode as ActivityMode)) {
    return c.json(
      { error: `mode is required and must be one of: ${ACTIVITY_MODES.join(", ")}` },
      400,
    );
  }

  const input: LogActivityInput = { mode: mode as ActivityMode };
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;
  const duration = num(body.duration);
  if (duration !== undefined) input.duration = duration;
  const notes = str(body.notes);
  if (notes) input.notes = notes;

  return runLog(c, "activity", () => c.get("client").logActivity(cid, input, { dryRun }));
});

app.post("/api/log/solids", async (c) => {
  const parsed = await readLogBody(c);
  if (parsed instanceof Response) return parsed;
  const { body, cid, dryRun } = parsed;

  const rawFoods = Array.isArray(body.foods) ? body.foods : [];
  const foods: SolidsFoodRef[] = [];
  for (const f of rawFoods) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const id = str(rec.id);
    const name = str(rec.name);
    const source = str(rec.source);
    if (!id || !name || (source !== "curated" && source !== "custom")) continue;
    const ref: SolidsFoodRef = { id, name, source };
    const amount = str(rec.amount) ?? num(rec.amount);
    if (amount !== undefined) ref.amount = amount;
    foods.push(ref);
  }
  if (!foods.length) {
    return c.json(
      { error: "foods is required: an array of { id, name, source } from /api/foods" },
      400,
    );
  }

  const input: LogSolidsInput = { foods };
  const reaction = str(body.reaction);
  if (reaction && SOLIDS_REACTIONS.includes(reaction as SolidsReaction)) {
    input.reaction = reaction as SolidsReaction;
  }
  const notes = str(body.notes);
  if (notes) input.notes = notes;
  const start = parseTime(body.start);
  if (start !== undefined) input.start = start;

  return runLog(c, "solids", () => c.get("client").logSolids(cid, input, { dryRun }));
});

/** Solids food catalog (curated + this child's custom foods) for the log UI. */
app.get("/api/foods", async (c) => {
  const client = c.get("client");
  const stored = c.get("stored");
  const cid = c.req.query("cid") || stored.cid || null;
  try {
    const [curated, custom] = await Promise.all([
      client.listSolidsCuratedFoods(),
      cid ? client.listSolidsCustomFoods(cid) : Promise.resolve([]),
    ]);
    const foods = [
      ...custom.map((f) => ({ id: f.id, name: f.name, source: "custom" as const })),
      ...curated.map((f) => ({ id: f.id, name: f.name, source: "curated" as const })),
    ];
    return c.json({ foods });
  } catch (err) {
    return c.json({ error: "Failed to load foods", detail: String(err) }, 502);
  }
});

// --- TRMNL token management (cookie-authenticated) -------------------------

/** Mint a revocable token for the TRMNL plugin from the current session. */
app.post("/api/tokens", async (c) => {
  const stored = c.get("stored");
  let body: { label?: string; tz?: string; cid?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    /* body is optional */
  }

  const token = newToken();
  await putToken(c.env.SESSIONS, token, {
    refreshToken: stored.refreshToken,
    uid: stored.uid,
    idToken: stored.idToken,
    expiresAt: stored.expiresAt,
    cid: body.cid ?? stored.cid ?? null,
    childName: stored.childName ?? null,
    tz: body.tz ?? null,
    label: body.label ?? null,
    createdAt: Date.now(),
  });

  const base = new URL(c.req.url).origin;
  const pollUrl = `${base}/api/latest${body.cid ?? stored.cid ? `?cid=${body.cid ?? stored.cid}` : ""}`;
  return c.json({ token, pollUrl, header: `authorization=Bearer ${token}` });
});

/** List existing tokens (id masked) for display/revocation. */
app.get("/api/tokens", async (c) => {
  const ids = await listTokens(c.env.SESSIONS);
  const tokens = await Promise.all(
    ids.map(async (id) => {
      const rec = await getToken(c.env.SESSIONS, id);
      return {
        id,
        masked: `${id.slice(0, 6)}…${id.slice(-4)}`,
        label: rec?.label ?? null,
        createdAt: rec?.createdAt ?? null,
        cid: rec?.cid ?? null,
      };
    }),
  );
  return c.json({ tokens });
});

/** Revoke a token. */
app.delete("/api/tokens/:token", async (c) => {
  await deleteToken(c.env.SESSIONS, c.req.param("token"));
  return c.json({ ok: true });
});

// --- MCP server (token-authenticated, Streamable HTTP) ---------------------
//
// Remote Model Context Protocol endpoint at /mcp so chat clients (Claude,
// OpenClaw, Hermes, …) can read this household's data. Auth reuses the same
// revocable bearer tokens as the TRMNL plugin: we validate the token here and
// hand it to the Durable Object agent via `ctx.props`. Handled before Hono so
// the MCP transport's raw request/response isn't wrapped.

const mcpHandler = HuckleberryMCP.serve("/mcp", { binding: "MCP_OBJECT" });

/** Pull a bearer token from the Authorization header or `?token=`. */
function bearerToken(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return new URL(request.url).searchParams.get("token") ?? "";
}

// The Cloudflare `agents` SDK always answers a Streamable-HTTP POST with an
// SSE-framed body (`Content-Type: text/event-stream`), never plain JSON. The
// MCP spec permits either, and some minimal clients (e.g. the Pebble Index
// hardware ring) only understand the JSON form and hang on the SSE stream.
// `jsonifyMcpResponse` transparently converts the single request→response frame
// back to `application/json`. This is spec-valid and invisible to compliant
// clients, which advertise (and accept) both content types.

/** Force both accept types so the SDK doesn't 406 a client that only sends one. */
function withStreamAccept(headers: Headers): Headers {
  const h = new Headers(headers);
  h.set("accept", "application/json, text/event-stream");
  return h;
}

/** If the response is an SSE stream, unwrap its `data:` frame(s) into JSON. */
async function jsonifyMcpResponse(res: Response): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) return res; // JSON / 202 / errors: pass through

  const text = await res.text();
  const messages: unknown[] = [];
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* ignore non-JSON keepalive/comment frames */
    }
  }

  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changes
  headers.delete("cache-control");

  // Couldn't parse anything usable — preserve the original stream verbatim.
  if (messages.length === 0) return new Response(text, { status: res.status, headers });

  headers.set("content-type", "application/json");
  const payload = messages.length === 1 ? messages[0] : messages;
  return new Response(JSON.stringify(payload), { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      const token = bearerToken(request);
      const rec = token ? await getToken(env.SESSIONS, token) : null;
      if (!rec) {
        return Response.json(
          { error: "Invalid or missing bearer token" },
          { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
        );
      }
      // Some minimal Streamable-HTTP clients (e.g. the Pebble Index ring) open a
      // GET /mcp server→client SSE stream and block on it as part of connecting.
      // This server never emits server-initiated messages, so that stream would
      // sit idle until the client's socket timeout (~60s) and the connection is
      // reported as failed. The MCP spec permits answering GET with 405 ("no SSE
      // stream offered here"); compliant clients (incl. Claude) then proceed with
      // request/response over POST only. All our tools are request→response, so
      // nothing is lost.
      if (request.method === "GET") {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method Not Allowed: no server SSE stream at this endpoint" },
            id: null,
          },
          { status: 405, headers: { Allow: "POST, DELETE" } },
        );
      }

      // Hand the validated token to the agent; tools rebuild a client from it.
      (ctx as ExecutionContext & { props?: unknown }).props = { token };
      // Normalize Accept so the SDK never 406s, then return a plain-JSON body
      // for POST request→response calls (see jsonifyMcpResponse). DELETE
      // (session teardown) passes through untouched.
      const upstream = new Request(request, { headers: withStreamAccept(request.headers) });
      const res = await mcpHandler.fetch(upstream, env, ctx);
      return request.method === "POST" ? jsonifyMcpResponse(res) : res;
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext): Promise<void> {
    const token = env.TRMNL_TOKEN;
    const webhookUrl = env.TRMNL_WEBHOOK_URL;
    if (!token || !webhookUrl) {
      console.error("[trmnl-cron] TRMNL_TOKEN or TRMNL_WEBHOOK_URL not configured");
      return;
    }
    const rec = await getToken(env.SESSIONS, token);
    if (!rec) {
      console.error("[trmnl-cron] TRMNL_TOKEN not found in KV — has the token been revoked?");
      return;
    }
    const cid = rec.cid;
    if (!cid) {
      console.error("[trmnl-cron] token record has no cid");
      return;
    }
    const tz = rec.tz ?? "UTC";
    try {
      const payload = await buildTrmnlPayload(env, token, rec, cid, tz);
      const trimmed = trimForWebhook(payload);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merge_variables: trimmed }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[trmnl-cron] TRMNL returned ${res.status}: ${body}`);
      } else {
        console.log(`[trmnl-cron] push OK (${res.status})`);
      }
    } catch (err) {
      console.error("[trmnl-cron] push failed:", String(err));
    }
  },
};
