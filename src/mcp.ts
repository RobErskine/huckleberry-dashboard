/**
 * Huckleberry MCP server — a remote Model Context Protocol endpoint so chat
 * clients (Claude, OpenClaw, Hermes, …) can read this household's Huckleberry
 * data over the same revocable bearer token the TRMNL plugin uses.
 *
 * Served over Streamable HTTP at `/mcp` (see index.ts). The Worker validates
 * the `Authorization: Bearer <token>` header and passes the token to this agent
 * via `ctx.props.token`; every tool rebuilds an authenticated `HuckleberryClient`
 * from that token (auto-refreshing the Firebase ID token as needed).
 *
 * Read tools are always on. Write tools (`log_*`) are gated: they're only
 * registered when the `ENABLE_WRITES` env var is truthy, mirroring the upstream
 * `huckleberry-js` MCP server's `HUCKLEBERRY_ENABLE_WRITES` flag. Every write
 * tool also accepts `dryRun` to preview the planned writes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { clientFromToken, getToken, type StoredToken } from "./session.js";

/** Bindings the agent needs (its own Durable Object namespace + the KV store). */
interface Env {
  SESSIONS: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  /** When truthy ("1"/"true"), the write tools are registered + allowed. */
  ENABLE_WRITES?: string;
}

/** Auth context injected per-connection by the Worker after token validation. */
interface Props {
  token: string;
  [key: string]: unknown;
}

type State = Record<string, never>;

/** Default lookback window for the interval tools. */
const DEFAULT_HOURS = 24;

/** Render any value as a single text content block. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export class HuckleberryMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "huckleberry", version: "0.1.0" });

  initialState: State = {};

  /** Load the token record + an authenticated client, or throw if revoked. */
  private async resolve(): Promise<{ rec: StoredToken; client: ReturnType<typeof clientFromToken> }> {
    const token = this.props?.token;
    if (!token) throw new Error("Missing auth context (no bearer token).");
    const rec = await getToken(this.env.SESSIONS, token);
    if (!rec) throw new Error("Token is invalid or has been revoked.");
    return { rec, client: clientFromToken(this.env.SESSIONS, token, rec) };
  }

  /** Epoch-second range ending now, going back `hours`. */
  private range(hours: number): { start: number; end: number } {
    const end = Math.floor(Date.now() / 1000);
    return { start: end - Math.round(hours * 3600), end };
  }

  async init() {
    const cidArg = z
      .string()
      .optional()
      .describe("Child id (cid). Omit to use the token's default child.");
    const hoursArg = z
      .number()
      .positive()
      .default(DEFAULT_HOURS)
      .describe(`How many hours back to look (default ${DEFAULT_HOURS}).`);

    this.server.registerTool(
      "get_dashboard_summary",
      {
        description:
          "Heads-up rollup for a child: last feed, last sleep/nap, last diaper, last pump, latest weight, and any timers currently running. Best first call.",
        inputSchema: { cid: cidArg },
      },
      async ({ cid }) => {
        const { rec, client } = await this.resolve();
        const childId = cid ?? rec.cid;
        if (!childId) throw new Error("No child id (cid) available.");
        const summary = await client.getDashboardSummary(
          childId,
          childId === rec.cid ? (rec.childName ?? null) : null,
        );
        return json(summary);
      },
    );

    this.server.registerTool(
      "list_children",
      {
        description: "List the children on this account with their cid and nickname.",
        inputSchema: {},
      },
      async () => {
        const { rec, client } = await this.resolve();
        const user = await client.getUser();
        const children = (user?.childList ?? []).map((ch) => ({
          cid: ch.cid,
          name: ch.nickname ?? null,
          isDefault: ch.cid === rec.cid,
        }));
        return json({ children, defaultCid: rec.cid ?? null });
      },
    );

    const intervalTool = (
      name: string,
      label: string,
      call: (
        client: ReturnType<typeof clientFromToken>,
        cid: string,
        start: number,
        end: number,
      ) => Promise<unknown>,
    ) => {
      this.server.registerTool(
        name,
        {
          description: `List ${label} events for a child over a recent time window.`,
          inputSchema: { cid: cidArg, hours: hoursArg },
        },
        async ({ cid, hours }) => {
          const { rec, client } = await this.resolve();
          const childId = cid ?? rec.cid;
          if (!childId) throw new Error("No child id (cid) available.");
          const { start, end } = this.range(hours ?? DEFAULT_HOURS);
          const rows = await call(client, childId, start, end);
          return json({ cid: childId, start, end, events: rows });
        },
      );
    };

    intervalTool("list_sleep", "sleep/nap", (c, cid, s, e) => c.listSleepIntervals(cid, s, e));
    intervalTool("list_feeds", "feeding", (c, cid, s, e) => c.listFeedIntervals(cid, s, e));
    intervalTool("list_diapers", "diaper", (c, cid, s, e) => c.listDiaperIntervals(cid, s, e));
    intervalTool("list_pumps", "pumping", (c, cid, s, e) => c.listPumpIntervals(cid, s, e));
    intervalTool("list_activities", "activity", (c, cid, s, e) =>
      c.listActivityIntervals(cid, s, e),
    );

    // --- write tools (gated by ENABLE_WRITES) ------------------------------
    //
    // Only registered when the server is configured to allow writes. Mirrors the
    // upstream huckleberry-js MCP `HUCKLEBERRY_ENABLE_WRITES` flag so write tools
    // stay hidden (not just rejected) on read-only deployments. Each accepts an
    // optional `dryRun` to preview the planned Firestore writes.
    const writesEnabled = /^(1|true|yes)$/i.test(this.env.ENABLE_WRITES ?? "");
    if (!writesEnabled) return;

    const dryRunArg = z
      .boolean()
      .optional()
      .describe("Preview the planned writes without committing them.");
    const writeAnnotations = { readOnlyHint: false, destructiveHint: false };

    /** Resolve the child id (arg or token default) or throw. */
    const childOrThrow = (cid: string | undefined, rec: StoredToken): string => {
      const childId = cid ?? rec.cid;
      if (!childId) throw new Error("No child id (cid) available.");
      return childId;
    };

    /** Convert a duration in minutes into a {start,end} epoch-seconds range ending now. */
    const rangeFromDuration = (minutes: number): { start: number; end: number } => {
      const end = Math.floor(Date.now() / 1000);
      return { start: end - Math.round(minutes * 60), end };
    };

    this.server.registerTool(
      "log_diaper",
      {
        description:
          "Log a diaper change. Records a history row and updates the last-diaper summary. Pass dryRun to preview without committing.",
        inputSchema: {
          cid: cidArg,
          mode: z.enum(["pee", "poo", "both", "dry"]).describe("What was in the diaper."),
          peeAmount: z.enum(["little", "medium", "big"]).optional(),
          pooAmount: z.enum(["little", "medium", "big"]).optional(),
          color: z.enum(["yellow", "brown", "black", "green", "red", "gray"]).optional(),
          consistency: z
            .enum(["solid", "loose", "runny", "mucousy", "hard", "pebbles", "diarrhea"])
            .optional(),
          notes: z.string().optional(),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, mode, peeAmount, pooAmount, color, consistency, notes, dryRun }) => {
        const { rec, client } = await this.resolve();
        const result = await client.logDiaper(
          childOrThrow(cid, rec),
          { mode, peeAmount, pooAmount, color, consistency, notes },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_potty",
      {
        description:
          "Log a potty event (toilet training). Records a history row and updates the last-potty summary.",
        inputSchema: {
          cid: cidArg,
          mode: z.enum(["pee", "poo", "both", "dry"]).describe("What happened."),
          howItHappened: z
            .enum(["satButDry", "wentPotty", "accident"])
            .describe("Outcome of the potty sit."),
          notes: z.string().optional(),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, mode, howItHappened, notes, dryRun }) => {
        const { rec, client } = await this.resolve();
        const result = await client.logPotty(
          childOrThrow(cid, rec),
          { mode, howItHappened, notes },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_bottle",
      {
        description:
          "Log a bottle feed. Records a history row and updates the last-bottle summary.",
        inputSchema: {
          cid: cidArg,
          amount: z.number().positive().describe("Volume fed."),
          units: z.enum(["ml", "oz"]).optional().describe("Volume units (default ml)."),
          bottleType: z
            .enum([
              "Breast Milk",
              "Formula",
              "Tube Feeding",
              "Cow Milk",
              "Goat Milk",
              "Soy Milk",
              "Other",
            ])
            .optional()
            .describe("Contents of the bottle (default Formula)."),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, amount, units, bottleType, dryRun }) => {
        const { rec, client } = await this.resolve();
        const result = await client.logBottle(
          childOrThrow(cid, rec),
          { amount, units, bottleType },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_nursing",
      {
        description:
          "Log a completed nursing session of the given length, ending now. Updates the last-nursing summary.",
        inputSchema: {
          cid: cidArg,
          durationMinutes: z.number().positive().describe("How long the session lasted."),
          side: z.enum(["left", "right", "none"]).optional().describe("Side nursed (default left)."),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, durationMinutes, side, dryRun }) => {
        const { rec, client } = await this.resolve();
        const { start, end } = rangeFromDuration(durationMinutes);
        const result = await client.logNursing(
          childOrThrow(cid, rec),
          { start, end, side },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_sleep",
      {
        description:
          "Log a completed sleep/nap of the given length, ending now. Updates the last-sleep summary.",
        inputSchema: {
          cid: cidArg,
          durationMinutes: z.number().positive().describe("How long the sleep lasted."),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, durationMinutes, dryRun }) => {
        const { rec, client } = await this.resolve();
        const { start, end } = rangeFromDuration(durationMinutes);
        const result = await client.logSleep(
          childOrThrow(cid, rec),
          { start, end },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_pump",
      {
        description:
          "Log a pump session. Provide totalAmount (split across sides) or both leftAmount and rightAmount.",
        inputSchema: {
          cid: cidArg,
          totalAmount: z.number().positive().optional(),
          leftAmount: z.number().nonnegative().optional(),
          rightAmount: z.number().nonnegative().optional(),
          units: z.enum(["ml", "oz"]).optional().describe("Volume units (default ml)."),
          durationMinutes: z.number().positive().optional(),
          notes: z.string().optional(),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, totalAmount, leftAmount, rightAmount, units, durationMinutes, notes, dryRun }) => {
        const { rec, client } = await this.resolve();
        if (
          totalAmount === undefined &&
          (leftAmount === undefined || rightAmount === undefined)
        ) {
          throw new Error("Provide totalAmount, or both leftAmount and rightAmount.");
        }
        const result = await client.logPump(
          childOrThrow(cid, rec),
          {
            totalAmount,
            leftAmount,
            rightAmount,
            units,
            duration: durationMinutes === undefined ? undefined : Math.round(durationMinutes * 60),
            notes,
          },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_growth",
      {
        description:
          "Log a growth measurement (at least one of weight/height/head). Updates the last-growth summary.",
        inputSchema: {
          cid: cidArg,
          weight: z.number().positive().optional(),
          height: z.number().positive().optional(),
          head: z.number().positive().optional(),
          units: z.enum(["metric", "imperial"]).optional().describe("Unit system (default metric)."),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, weight, height, head, units, dryRun }) => {
        const { rec, client } = await this.resolve();
        if (weight === undefined && height === undefined && head === undefined) {
          throw new Error("At least one of weight, height, or head is required.");
        }
        const result = await client.logGrowth(
          childOrThrow(cid, rec),
          { weight, height, head, units },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "log_activity",
      {
        description:
          "Log an activity (tummy time, bath, etc.). Updates the matching per-mode summary.",
        inputSchema: {
          cid: cidArg,
          mode: z
            .enum([
              "bath",
              "tummyTime",
              "storyTime",
              "screenTime",
              "skinToSkin",
              "outdoorPlay",
              "indoorPlay",
              "brushTeeth",
            ])
            .describe("Activity type."),
          durationMinutes: z.number().positive().optional(),
          notes: z.string().optional(),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, mode, durationMinutes, notes, dryRun }) => {
        const { rec, client } = await this.resolve();
        const result = await client.logActivity(
          childOrThrow(cid, rec),
          {
            mode,
            duration: durationMinutes === undefined ? undefined : Math.round(durationMinutes * 60),
            notes,
          },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );

    this.server.registerTool(
      "list_foods",
      {
        description:
          "List solids foods (curated + this child's custom foods) with the id/source/name needed by log_solids.",
        inputSchema: { cid: cidArg },
      },
      async ({ cid }) => {
        const { rec, client } = await this.resolve();
        const childId = cid ?? rec.cid;
        const [curated, custom] = await Promise.all([
          client.listSolidsCuratedFoods(),
          childId ? client.listSolidsCustomFoods(childId) : Promise.resolve([]),
        ]);
        const foods = [
          ...custom.map((f) => ({ id: f.id, name: f.name, source: "custom" as const })),
          ...curated.map((f) => ({ id: f.id, name: f.name, source: "curated" as const })),
        ];
        return json({ foods });
      },
    );

    this.server.registerTool(
      "log_solids",
      {
        description:
          "Log a solid-food meal. Look up food ids with list_foods first. Updates the last-solid summary.",
        inputSchema: {
          cid: cidArg,
          foods: z
            .array(
              z.object({
                id: z.string(),
                source: z.enum(["curated", "custom"]),
                name: z.string(),
                amount: z.union([z.string(), z.number()]).optional(),
              }),
            )
            .min(1)
            .describe("Foods eaten, from list_foods."),
          reaction: z.enum(["LOVED", "MEH", "HATED", "ALLERGIC"]).optional(),
          notes: z.string().optional(),
          dryRun: dryRunArg,
        },
        annotations: writeAnnotations,
      },
      async ({ cid, foods, reaction, notes, dryRun }) => {
        const { rec, client } = await this.resolve();
        const result = await client.logSolids(
          childOrThrow(cid, rec),
          { foods, reaction, notes },
          { dryRun: !!dryRun },
        );
        return json(result);
      },
    );
  }
}
