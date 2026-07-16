# huckleberry-dashboard

A complete, self-hostable **Cloudflare Worker** reference implementation showing how to build a private Huckleberry baby-tracker dashboard using the [`huckleberry-js`](https://www.npmjs.com/package/huckleberry-js) npm package.

Fork this repo to run your own — all you need is a Cloudflare account and your existing Huckleberry login.

> **Not affiliated with, endorsed by, or connected to Huckleberry Labs, Inc.** This is an independent open-source project that uses your own Huckleberry account credentials.

## What it does

- **Dashboard page** — shows your baby's latest activity (last feed, sleep, diaper, pump) on any home display, updating every 60 seconds.
- **Quick log** — log every event type (diaper, potty, bottle, nursing, sleep, pump, growth, activity, solids) directly from the browser with a dry-run preview mode.
- **Polling API** (`GET /api/latest`) — a token-authenticated endpoint returning a flat JSON snapshot, ready for any external display or integration (TRMNL e-ink plugins, home automation, etc.).
- **MCP server** (`/mcp`) — a remote [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI chat clients (Claude, etc.) can read and log your Huckleberry data in conversation.
- **OpenAPI docs** (`GET /api`) — interactive API reference (Scalar) auto-documenting every endpoint.
- **Application access codes** — revocable bearer tokens that authenticate both `/api/latest` and `/mcp`. Mint and revoke them from the dashboard.

## How it works

```
Browser ──login form──▶ Worker ──email/password──▶ Firebase (mint token)
   ▲                      │
   │  signed cookie       └─ session {idToken, refreshToken, uid} ──▶ KV
   │
   └──poll /api/summary──▶ Worker ──Firestore REST (auto-refresh)──▶ Huckleberry data

External app / AI client
   └──Bearer <code>──▶  /api/latest  or  /mcp
```

- Your password is **never stored** — only the Firebase tokens it mints, in KV.
- The browser holds an opaque session id in a **signed, HttpOnly** cookie (60-day TTL).
- The dashboard polls `/api/summary` every ~60 s (Cloudflare Workers can't hold the real-time gRPC listeners the Huckleberry mobile app uses).

## Prerequisites

- **Node 18+** and a [Cloudflare account](https://dash.cloudflare.com/).
- `wrangler` CLI: `npm install -g wrangler` then `wrangler login`.
- A Huckleberry account — you'll sign in with your own credentials.

## Setup

```bash
# 1. Install dependencies (pulls huckleberry-js + MCP SDK from npm)
npm install

# 2. Create the KV namespace for sessions and access codes
wrangler kv namespace create SESSIONS
wrangler kv namespace create SESSIONS --preview   # needed for wrangler dev
```

Paste the returned `id` and `preview_id` into the `kv_namespaces[0]` entry in `wrangler.jsonc`.

```bash
# 3. Set the cookie-signing secret (any long random string)
wrangler secret put SESSION_SECRET
```

For local dev, create a `.dev.vars` file (already git-ignored):

```ini
SESSION_SECRET="dev-only-long-random-string"
```

## Run locally

```bash
npm run dev
# open http://localhost:8787 and sign in with your Huckleberry account
```

The interactive API reference is available at `http://localhost:8787/api`.

## Deploy

```bash
npm run deploy
```

Wrangler bundles the Worker + `public/` assets and prints your `*.workers.dev` URL. Sign in once on your home display — the 60-day session keeps it logged in automatically.

Optional hardening: map a custom domain or put the dashboard behind [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) for an extra auth layer.

## Endpoints

For the full interactive contract, visit `GET /api` (Scalar viewer) or `GET /api/openapi.json` (machine-readable spec).

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | cookie | Dashboard page (redirects to `/login` if signed out) |
| `GET /login` | — | Login form |
| `GET /api` | — | Interactive API reference (Scalar) |
| `GET /api/openapi.json` | — | OpenAPI 3.1 spec |
| `POST /api/login` | — | `{ email, password, cid? }` → sets session cookie |
| `POST /api/logout` | — | Clears session |
| `GET /api/children` | cookie | List children + default cid |
| `GET /api/summary?cid=` | cookie | Heads-up rollup (last feed, sleep, diaper, etc.) |
| `GET /api/foods?cid=` | cookie | Solids food catalog (curated + custom) |
| `POST /api/log/diaper` | cookie | Log a diaper (`{ mode, peeAmount?, pooAmount?, color?, consistency?, notes? }`) |
| `POST /api/log/potty` | cookie | Log a potty event (`{ mode, howItHappened, notes? }`) |
| `POST /api/log/bottle` | cookie | Log a bottle feed (`{ amount, units?, bottleType? }`) |
| `POST /api/log/nursing` | cookie | Log a nursing session (`{ start, end, side? }`) |
| `POST /api/log/sleep` | cookie | Log a sleep/nap (`{ start, end }`) |
| `POST /api/log/pump` | cookie | Log a pump session (`{ totalAmount \| leftAmount+rightAmount, units?, duration?, notes? }`) |
| `POST /api/log/growth` | cookie | Log a growth measurement (`{ weight?, height?, head?, units? }`) |
| `POST /api/log/activity` | cookie | Log an activity (`{ mode, duration?, notes? }`) |
| `POST /api/log/solids` | cookie | Log a solids meal (`{ foods:[{id,name,source}], reaction?, notes? }`) |
| `GET /api/latest` | bearer code | Flat JSON snapshot for polling clients |
| `GET /api/trmnl` | bearer code | Alias for `/api/latest` (deprecated — kept for backwards compatibility) |
| `POST /api/tokens` | cookie | Mint a revocable application access code |
| `GET /api/tokens` | cookie | List active access codes |
| `DELETE /api/tokens/:token` | cookie | Revoke an access code |
| `ALL /mcp` | bearer code | MCP server (Streamable HTTP) |

Every `POST /api/log/*` route accepts `cid?` (defaults to the session child), `start?` (epoch seconds or ISO), and `dryRun?: true` to preview writes without committing.

## Application access codes

Access codes are revocable 48-char bearer tokens that authenticate the `/api/latest` polling endpoint and the `/mcp` server. Mint one from the **🔑 Application access codes** panel in the dashboard and revoke it anytime to immediately cut off access.

**Two ways to pass a code:**

```
Authorization: Bearer <code>     # recommended (request header)
?token=<code>                    # fallback for clients that can't set headers
```

Codes have a 180-day TTL that refreshes on each use.

## MCP server (AI chat clients)

The Worker exposes a remote **Model Context Protocol** endpoint at `/mcp` so AI clients (Claude, etc.) can read and log your Huckleberry data in conversation. Auth uses the same access codes as the polling endpoint.

Connect a client to `https://huckleberry-dashboard.<you>.workers.dev/mcp`:

```jsonc
{
  "mcpServers": {
    "huckleberry": {
      "url": "https://huckleberry-dashboard.<you>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your-code>" }
    }
  }
}
```

**Read tools** (always on): `get_dashboard_summary`, `list_children`, `list_sleep`, `list_feeds`, `list_diapers`, `list_pumps`, `list_activities`.

**Write tools** are gated by `vars.ENABLE_WRITES` in `wrangler.jsonc` (default `"1"` = enabled): `log_diaper`, `log_potty`, `log_bottle`, `log_nursing`, `log_sleep`, `log_pump`, `log_growth`, `log_activity`, `log_solids`, `list_foods`. Set to `"0"` and redeploy for a read-only MCP endpoint. Every write tool accepts `dryRun: true`. This flag does **not** affect the cookie-authenticated `POST /api/log/*` routes, which are always available behind the login.

## Testing

```bash
npm test   # vitest + @cloudflare/vitest-pool-workers
```

The test suite verifies that every registered Hono route has a matching path in `src/openapi.ts` and vice-versa. If you add a new endpoint, the test will fail until you update the spec — keeping the API docs in sync automatically.

## Using huckleberry-js in your own project

This dashboard is intentionally a thin layer over [`huckleberry-js`](https://www.npmjs.com/package/huckleberry-js). If you want to build something different, the library is published on npm:

```bash
npm install huckleberry-js
```

Browse `src/index.ts` to see how `HuckleberryClient` is constructed, how sessions are stored in KV, and how each log type maps to a client method. Bump the `^0.3.0` range in `package.json` to adopt new library releases.

## Notes

- Real writes hit your Huckleberry account immediately. There is no delete API — remove test entries in the Huckleberry mobile app.
- The live sleep/nursing **timer** state machine (start/pause/resume/complete) and solids custom-food creation are not yet exposed. Quick-log controls record completed events only.
