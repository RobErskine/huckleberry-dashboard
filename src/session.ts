/**
 * KV-backed session storage for the dashboard.
 *
 * We persist the Firebase session (ID token + refresh token + uid) in KV keyed
 * by an opaque random session id. The browser only holds that id inside a
 * signed, HttpOnly cookie (signing is done by Hono in `index.ts`). The user's
 * password is never stored — only the tokens minted from it.
 */

import { HuckleberryClient } from "huckleberry-js";

export interface StoredSession {
  idToken: string;
  refreshToken: string;
  uid: string;
  /** Epoch milliseconds the ID token expires. */
  expiresAt: number;
  /** Convenience copy of the default child's display name. */
  childName?: string | null;
  /** Default child id chosen at login. */
  cid?: string | null;
}

const PREFIX = "session:";
/** Sessions live 60 days (refreshed on each write) so the home display stays in. */
const TTL_SECONDS = 60 * 24 * 60 * 60;

export async function putSession(
  kv: KVNamespace,
  id: string,
  session: StoredSession,
): Promise<void> {
  await kv.put(PREFIX + id, JSON.stringify(session), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function getSession(
  kv: KVNamespace,
  id: string,
): Promise<StoredSession | null> {
  const raw = await kv.get(PREFIX + id);
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

export async function deleteSession(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(PREFIX + id);
}

// ---------------------------------------------------------------------------
// Revocable API tokens (for the TRMNL plugin / any headless poller).
//
// A token is an opaque random string mapped to its own copy of the refresh
// token + child selection, so polling works with no cookie/browser. Each poll
// refreshes the entry (re-extending its TTL), so an actively-used token stays
// alive indefinitely; an unused one expires. Revoke = delete the KV entry.
// ---------------------------------------------------------------------------

export interface StoredToken {
  refreshToken: string;
  uid: string;
  /** ID token cache so we don't refresh on every single poll. */
  idToken?: string;
  expiresAt?: number;
  /** Child this token reports on. */
  cid?: string | null;
  childName?: string | null;
  /** IANA timezone for formatting clock times (e.g. "America/New_York"). */
  tz?: string | null;
  /** Epoch ms the token was created (for display in the UI). */
  createdAt?: number;
  /** Short label so the user can tell tokens apart in the UI. */
  label?: string | null;
}

const TOKEN_PREFIX = "trmnl:";
/** Tokens live 180 days, refreshed on each poll. */
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export async function putToken(
  kv: KVNamespace,
  token: string,
  data: StoredToken,
): Promise<void> {
  await kv.put(TOKEN_PREFIX + token, JSON.stringify(data), {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
}

export async function getToken(
  kv: KVNamespace,
  token: string,
): Promise<StoredToken | null> {
  const raw = await kv.get(TOKEN_PREFIX + token);
  return raw ? (JSON.parse(raw) as StoredToken) : null;
}

export async function deleteToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(TOKEN_PREFIX + token);
}

/**
 * Build an authenticated `HuckleberryClient` from a stored API token, writing
 * any refreshed Firebase tokens back to the same KV entry. Shared by the TRMNL
 * endpoint and the MCP server so a single token powers both.
 */
export function clientFromToken(
  kv: KVNamespace,
  token: string,
  rec: StoredToken,
): HuckleberryClient {
  return new HuckleberryClient({
    session: {
      idToken: rec.idToken ?? "",
      refreshToken: rec.refreshToken,
      uid: rec.uid,
      // 0 → treated as expired so the first call mints a fresh ID token.
      expiresAt: rec.expiresAt ?? 0,
    },
    onSession: async (s) => {
      await putToken(kv, token, {
        ...rec,
        idToken: s.idToken,
        refreshToken: s.refreshToken,
        expiresAt: s.expiresAt,
      });
    },
  });
}

/** List token ids (without the prefix) for the revoke UI. */
export async function listTokens(kv: KVNamespace): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix: TOKEN_PREFIX, cursor });
    for (const key of res.keys) out.push(key.name.slice(TOKEN_PREFIX.length));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}
