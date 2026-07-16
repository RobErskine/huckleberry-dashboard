/**
 * OpenAPI 3.1 contract for the Huckleberry dashboard API.
 *
 * Hand-authored (not generated) — update this file when:
 *   - Adding a new Hono route (test/docs-coverage.test.ts will fail if you forget)
 *   - Consuming new response fields from huckleberry-js (response schemas are manual)
 *
 * Route coverage is verified by: npm test
 */

const cookieSecurity = [{ cookieAuth: [] }];
const tokenSecurity = [{ bearerAuth: [] }, { queryToken: [] }];

const timeParam = {
  oneOf: [{ type: "number" }, { type: "string" }],
  description: "Epoch seconds or ISO 8601 timestamp",
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Huckleberry Dashboard API",
    version: "1.0.0",
    description:
      "Private baby-tracker dashboard on Cloudflare Workers.\n\n" +
      "**Authentication:**\n" +
      "- **Cookie** (`hb_sid`) — browser dashboard routes; set by `POST /api/login`.\n" +
      "- **Bearer token** — TRMNL plugins and MCP clients. Pass as `Authorization: Bearer <token>` header **or** `?token=<token>` query param. Tokens are minted by `POST /api/tokens`.",
  },
  servers: [{ url: "/", description: "This server" }],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "hb_sid",
        description: "Signed session cookie. Set by `POST /api/login`; cleared by `POST /api/logout`.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "`Authorization: Bearer <token>` header. Token issued by `POST /api/tokens`. " +
          "Valid for 180 days; refreshed on each use.",
      },
      queryToken: {
        type: "apiKey",
        in: "query",
        name: "token",
        description:
          "`?token=<token>` query-param fallback for clients that cannot set request headers " +
          "(e.g. TRMNL plugin URL config). Same token value as `bearerAuth`.",
      },
    },
  },
  paths: {
    "/": {
      get: {
        summary: "Dashboard page",
        description: "Serves the dashboard HTML if a valid session cookie exists; redirects to `/login` otherwise.",
        tags: ["Pages"],
        responses: {
          "200": { description: "Dashboard HTML" },
          "302": { description: "Redirect to /login" },
        },
      },
    },
    "/login": {
      get: {
        summary: "Login page",
        tags: ["Pages"],
        responses: {
          "200": { description: "Login HTML" },
        },
      },
    },

    // --- Docs ------------------------------------------------------------------
    "/api": {
      get: {
        summary: "API reference (this page)",
        description: "Renders the interactive OpenAPI reference viewer (Scalar).",
        tags: ["Docs"],
        responses: {
          "200": { description: "HTML viewer" },
        },
      },
    },
    "/api/openapi.json": {
      get: {
        summary: "OpenAPI 3.1 spec",
        description: "Machine-readable OpenAPI 3.1 contract for this API.",
        tags: ["Docs"],
        responses: {
          "200": { description: "OpenAPI JSON document" },
        },
      },
    },

    // --- Auth ------------------------------------------------------------------
    "/api/login": {
      post: {
        summary: "Authenticate",
        description:
          "Exchange a Huckleberry email + password for a signed session cookie (`hb_sid`). " +
          "The cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and expires in 60 days.",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                  cid: {
                    type: "string",
                    description: "Preferred child ID to select after login; defaults to first child.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Success — sets `hb_sid` cookie",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    children: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          cid: { type: "string" },
                          name: { type: "string", nullable: true },
                        },
                      },
                    },
                    selected: {
                      type: "object",
                      nullable: true,
                      properties: {
                        cid: { type: "string" },
                        name: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Authentication failed" },
          "500": { description: "Server misconfiguration (missing SESSION_SECRET)" },
        },
      },
    },
    "/api/logout": {
      post: {
        summary: "Log out",
        description: "Deletes the server-side session and clears the `hb_sid` cookie.",
        tags: ["Auth"],
        responses: {
          "200": { description: "`{ ok: true }`" },
        },
      },
    },

    // --- Polling endpoint ------------------------------------------------------
    "/api/latest": {
      get: {
        summary: "Latest snapshot",
        description:
          "Returns a flat, render-ready JSON payload for any polling client " +
          "(TRMNL e-ink plugin, home dashboards, etc.).\n\n" +
          "**Auth:** `Authorization: Bearer <token>` header **or** `?token=<token>` query param.\n\n" +
          "Token issued by `POST /api/tokens`.",
        tags: ["Polling"],
        security: tokenSecurity,
        parameters: [
          {
            name: "token",
            in: "query",
            schema: { type: "string" },
            description: "Bearer token (alternative to the Authorization header)",
          },
          {
            name: "cid",
            in: "query",
            schema: { type: "string" },
            description: "Child ID; defaults to the cid stored with the token",
          },
          {
            name: "tz",
            in: "query",
            schema: { type: "string", example: "America/Chicago" },
            description: "IANA timezone for time display; defaults to the token's tz or UTC",
          },
        ],
        responses: {
          "200": { description: "Snapshot payload" },
          "401": { description: "Missing or invalid token" },
          "400": { description: "No child id available" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/trmnl": {
      get: {
        summary: "Latest snapshot (deprecated alias)",
        description:
          "Permanent backwards-compatibility alias for `/api/latest`. " +
          "Existing TRMNL plugin URLs continue to work here; new integrations should use `/api/latest`.",
        deprecated: true,
        tags: ["Polling"],
        security: tokenSecurity,
        parameters: [
          {
            name: "token",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "cid",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "tz",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Same response as /api/latest" },
          "401": { description: "Missing or invalid token" },
        },
      },
    },

    // --- Read API (cookie-authenticated) ---------------------------------------
    "/api/children": {
      get: {
        summary: "List children",
        description: "Returns all children linked to the account and the session's selected child.",
        tags: ["Read"],
        security: cookieSecurity,
        responses: {
          "200": {
            description: "Children list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    children: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          cid: { type: "string" },
                          name: { type: "string", nullable: true },
                        },
                      },
                    },
                    defaultCid: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/summary": {
      get: {
        summary: "Dashboard summary",
        description:
          "Returns the current tracking summary for a child (last feed, sleep, diaper, etc.) " +
          "as a `DashboardSummary` from `huckleberry-js`.",
        tags: ["Read"],
        security: cookieSecurity,
        parameters: [
          {
            name: "cid",
            in: "query",
            schema: { type: "string" },
            description: "Child ID; defaults to the session's selected child",
          },
        ],
        responses: {
          "200": { description: "DashboardSummary object" },
          "401": { description: "Not authenticated" },
          "400": { description: "No child id available" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/foods": {
      get: {
        summary: "Solids food catalog",
        description: "Returns curated foods plus this child's custom foods for the solids log UI.",
        tags: ["Read"],
        security: cookieSecurity,
        parameters: [
          {
            name: "cid",
            in: "query",
            schema: { type: "string" },
            description: "Child ID",
          },
        ],
        responses: {
          "200": {
            description: "Food catalog",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    foods: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          source: { type: "string", enum: ["curated", "custom"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Not authenticated" },
        },
      },
    },

    // --- Write / log endpoints (cookie-authenticated) --------------------------
    "/api/log/diaper": {
      post: {
        summary: "Log diaper",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mode"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean", description: "Preview without writing" },
                  mode: { type: "string", enum: ["pee", "poo", "both", "dry"] },
                  peeAmount: { type: "string", enum: ["little", "medium", "big"] },
                  pooAmount: { type: "string", enum: ["little", "medium", "big"] },
                  color: {
                    type: "string",
                    enum: ["yellow", "brown", "black", "green", "red", "gray"],
                  },
                  consistency: {
                    type: "string",
                    enum: ["solid", "loose", "runny", "mucousy", "hard", "pebbles", "diarrhea"],
                  },
                  diaperRash: { type: "boolean" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/potty": {
      post: {
        summary: "Log potty",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mode", "howItHappened"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  mode: { type: "string", enum: ["pee", "poo", "both", "dry"] },
                  howItHappened: {
                    type: "string",
                    enum: ["satButDry", "wentPotty", "accident"],
                  },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/bottle": {
      post: {
        summary: "Log bottle feed",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  amount: { type: "number", exclusiveMinimum: 0 },
                  units: { type: "string", enum: ["ml", "oz"] },
                  bottleType: {
                    type: "string",
                    enum: [
                      "Breast Milk",
                      "Formula",
                      "Tube Feeding",
                      "Cow Milk",
                      "Goat Milk",
                      "Soy Milk",
                      "Other",
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/nursing": {
      post: {
        summary: "Log nursing session",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["start", "end"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  end: timeParam,
                  dryRun: { type: "boolean" },
                  side: { type: "string", enum: ["left", "right", "none"] },
                  leftDuration: { type: "number", description: "Seconds on left breast" },
                  rightDuration: { type: "number", description: "Seconds on right breast" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error (start/end required, end must be after start)" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/sleep": {
      post: {
        summary: "Log sleep",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["start", "end"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  end: timeParam,
                  dryRun: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/pump": {
      post: {
        summary: "Log pump session",
        description: "Requires either `totalAmount` or both `leftAmount` and `rightAmount`.",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  totalAmount: { type: "number" },
                  leftAmount: { type: "number" },
                  rightAmount: { type: "number" },
                  units: { type: "string", enum: ["ml", "oz"] },
                  duration: { type: "number", description: "Session duration in seconds" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error (amount fields required)" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/growth": {
      post: {
        summary: "Log growth measurement",
        description: "At least one of `weight`, `height`, or `head` is required.",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  weight: { type: "number" },
                  height: { type: "number" },
                  head: { type: "number" },
                  units: { type: "string", enum: ["metric", "imperial"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error (at least one measurement required)" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/activity": {
      post: {
        summary: "Log activity",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mode"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  mode: {
                    type: "string",
                    enum: [
                      "bath",
                      "tummyTime",
                      "storyTime",
                      "screenTime",
                      "skinToSkin",
                      "outdoorPlay",
                      "indoorPlay",
                      "brushTeeth",
                    ],
                  },
                  duration: { type: "number", description: "Duration in seconds" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },
    "/api/log/solids": {
      post: {
        summary: "Log solids meal",
        description: "Fetch the food list from `GET /api/foods` to get valid `{ id, name, source }` values.",
        tags: ["Log"],
        security: cookieSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["foods"],
                properties: {
                  cid: { type: "string" },
                  start: timeParam,
                  dryRun: { type: "boolean" },
                  foods: {
                    type: "array",
                    description: "One or more foods from /api/foods",
                    items: {
                      type: "object",
                      required: ["id", "name", "source"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        source: { type: "string", enum: ["curated", "custom"] },
                        amount: {
                          oneOf: [{ type: "string" }, { type: "number" }],
                          description: "Optional portion amount",
                        },
                      },
                    },
                  },
                  reaction: {
                    type: "string",
                    enum: ["LOVED", "MEH", "HATED", "ALLERGIC"],
                  },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "`{ ok: true, ...WriteResult }`" },
          "400": { description: "Validation error (foods required)" },
          "401": { description: "Not authenticated" },
          "502": { description: "Upstream Huckleberry error" },
        },
      },
    },

    // --- Token management (cookie-authenticated) -------------------------------
    "/api/tokens": {
      post: {
        summary: "Mint a bearer token",
        description:
          "Creates a revocable 48-char hex token (180-day TTL, refreshed on use). " +
          "Use with TRMNL or MCP via `Authorization: Bearer <token>` or `?token=<token>`.",
        tags: ["Tokens"],
        security: cookieSecurity,
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Human-readable name" },
                  tz: {
                    type: "string",
                    example: "America/Chicago",
                    description: "IANA timezone stored with the token (used by TRMNL)",
                  },
                  cid: { type: "string", description: "Child ID to bind to this token" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "New token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string", description: "48-char hex bearer token" },
                    pollUrl: {
                      type: "string",
                      description: "Ready-to-use TRMNL polling URL (copy into plugin config)",
                    },
                    header: {
                      type: "string",
                      description: "Authorization header value to copy",
                      example: "authorization=Bearer abc123…",
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Not authenticated" },
        },
      },
      get: {
        summary: "List tokens",
        description: "Returns all tokens with values masked for display in the revocation UI.",
        tags: ["Tokens"],
        security: cookieSecurity,
        responses: {
          "200": {
            description: "Token list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tokens: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          masked: {
                            type: "string",
                            description: "First 6 + last 4 chars, e.g. `abc123…ef90`",
                          },
                          label: { type: "string", nullable: true },
                          createdAt: {
                            type: "number",
                            nullable: true,
                            description: "Unix ms timestamp",
                          },
                          cid: { type: "string", nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Not authenticated" },
        },
      },
    },
    "/api/tokens/{token}": {
      delete: {
        summary: "Revoke a token",
        description: "Deletes the token from KV. The token stops working immediately.",
        tags: ["Tokens"],
        security: cookieSecurity,
        parameters: [
          {
            name: "token",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Full token value (from the id field in GET /api/tokens)",
          },
        ],
        responses: {
          "200": { description: "`{ ok: true }`" },
          "401": { description: "Not authenticated" },
        },
      },
    },

    // --- MCP (raw fetch handler, not Hono) -------------------------------------
    "/mcp": {
      get: {
        summary: "MCP server — SSE",
        description:
          "Model Context Protocol endpoint for AI clients (Claude, etc.). " +
          "Handled before Hono by the raw fetch handler.\n\n" +
          "**Auth:** `Authorization: Bearer <token>` header **or** `?token=<token>` query param.",
        tags: ["MCP"],
        security: tokenSecurity,
        parameters: [
          { name: "token", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "MCP Streamable HTTP transport (SSE)" },
          "401": { description: "Invalid or missing bearer token" },
        },
      },
      post: {
        summary: "MCP server — POST",
        description:
          "Model Context Protocol endpoint (POST transport). " +
          "**Auth:** `Authorization: Bearer <token>` header **or** `?token=<token>` query param.",
        tags: ["MCP"],
        security: tokenSecurity,
        parameters: [
          { name: "token", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "MCP Streamable HTTP transport" },
          "401": { description: "Invalid or missing bearer token" },
        },
      },
    },
  },
};

export function docsHtml(): string {
  return `<!doctype html>
<html>
<head>
  <title>Huckleberry API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/api/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
