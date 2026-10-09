import { Page, BrowserContext } from '@playwright/test';

/**
 * The API bearer token, for the page objects that drive the REST API directly.
 *
 * **The token is no longer in `localStorage`, and `.auth/*.json` no longer survives a run.** The
 * current staging build carries a `_auth_token_migration_done` flag: `auth-state` holds only
 * `{user, fetching}`, the access token lives in memory, and the one credential on disk is
 * `auth-refresh-token`. That refresh token is **rotated and single-use** — the app spends it on
 * boot (`POST /token/refresh`) and keeps the replacement in the browser it booted, so the value in
 * the saved storageState is spent by the first run and every later run gets
 * `401 {"code":401,"message":"JWT Refresh Token Not Found"}` and lands logged out.
 *
 * So a token is obtained in three escalating ways, cheapest first:
 *  1. `auth-state.token` in localStorage — the pre-migration shape, still what Production serves;
 *  2. the `Authorization` header off a live app request — free when the session did boot;
 *  3. `POST /auth {username, password}` — the endpoint the login form itself posts to, returning
 *     `{ token, refresh_token }`. Deterministic, and the only one that works from a spent
 *     storageState.
 */

export const API_BASE = 'https://api.staging.therapios.de';

/** The staging logins `tests/auth.setup.ts` uses, addressed by role. */
export const STAGING_CREDENTIALS = {
  superadmin: { email: 'sa.jhen@gmail.com', password: 'thera.rocks' },
  admin: { email: 'admin.jhen@gmail.com', password: '12345678' },
  therapist: { email: 'jhenqa@therapios.de', password: '12345678' },
} as const;

export type Credentials = { email: string; password: string };

export async function apiBearerToken(
  page: Page,
  opts: { credentials?: Credentials; api?: string; captureMs?: number } = {},
): Promise<string | null> {
  const api = opts.api ?? API_BASE;

  const stored = await page
    .evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '{}');
        return state.token || state.accessToken || state.access_token || null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (stored) return stored;

  const captured = await captureFromTraffic(page, opts.captureMs ?? 8_000);
  if (captured) return captured;

  if (!opts.credentials) return null;
  const res = await page.request.post(`${api}/auth`, {
    headers: { 'Content-Type': 'application/json' },
    // The field is `username`, not `email`, even though the value is an address — `{email, …}`
    // answers 400 "Bad Request".
    data: { username: opts.credentials.email, password: opts.credentials.password },
    timeout: 60_000,
  });
  if (res.status() !== 200) {
    // Reported rather than swallowed: a caller that cannot get a token fails on an assertion far
    // from here, and "which login failed, and how" is the only useful thing to know at that point.
    console.log(`POST ${api}/auth as ${opts.credentials.email} -> ${res.status()} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = await res.json().catch(() => null);
  return body?.token ?? null;
}

/** Watches the app's own requests for an `Authorization` header, without navigating anywhere. */
async function captureFromTraffic(page: Page, timeoutMs: number): Promise<string | null> {
  let token: string | null = null;
  const listener = (request: { headers(): Record<string, string> }) => {
    if (token) return;
    const header = request.headers()['authorization'];
    if (header?.startsWith('Bearer ') && header !== 'Bearer null') token = header.slice(7);
  };
  page.on('request', listener as never);
  try {
    const deadline = Date.now() + timeoutMs;
    while (!token && Date.now() < deadline) await page.waitForTimeout(250);
  } finally {
    page.off('request', listener as never);
  }
  return token;
}


/**
 * Mints a session the **browser** can use, for specs that drive a screen rather than the API.
 *
 * `storageState` alone no longer logs anyone in (see above): the saved refresh token is spent by the
 * first run. `POST /auth` hands back a fresh `refresh_token`, and writing that into
 * `localStorage['auth-refresh-token']` before the first navigation lets the app boot and exchange it
 * exactly as a real login would. Call it BEFORE `page.goto()` — `addInitScript` only applies to
 * navigations that follow it.
 */
export async function mintUiSession(
  page: Page,
  credentials: Credentials,
  opts: { api?: string } = {},
): Promise<string> {
  const api = opts.api ?? API_BASE;
  const res = await page.request.post(`${api}/auth`, {
    headers: { 'Content-Type': 'application/json' },
    data: { username: credentials.email, password: credentials.password },
    timeout: 60_000,
  });
  if (res.status() !== 200) {
    throw new Error(`POST ${api}/auth as ${credentials.email} -> ${res.status()} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  await seedRefreshToken(page, body.refresh_token);
  return body.token;
}

/**
 * Installs a refresh token where the web app will read it on boot.
 *
 * Since #3910 (`5da96139d5`, 2026-10-07) the app keeps the web refresh token in **IndexedDB**
 * (`therapios-auth` › store `tokens` › key `refresh`, a plain string) and reads it FIRST, falling
 * back to `localStorage['auth-refresh-token']` only when IndexedDB holds nothing
 * (`packages/auth/tokenStorage.ts::getRefreshToken`). The project's saved storageState now carries
 * setup's IndexedDB token (saved with `indexedDB: true`), which is single-use and spent after the
 * first test — so a token seeded into localStorage ALONE loses to it and the page lands on the login
 * form. Both stores are written here.
 *
 * IndexedDB serves requests on one origin in order, and a readonly transaction waits for an earlier
 * readwrite one on the same store, so the app's first read sees this put.
 *
 * `once: true` seeds a given token only on the first navigation (#3761's reload-safe seed) and leaves
 * the app's own rotated successor alone afterwards; the default re-seeds on every navigation, which
 * is the long-standing `mintUiSession` behaviour (a second `goto` then replays the spent token).
 */
export async function seedRefreshToken(
  target: Page | BrowserContext,
  refreshToken: string,
  opts: { once?: boolean } = {},
): Promise<void> {
  await target.addInitScript(({ token, once }: { token: string; once: boolean }) => {
    try {
      if (once && localStorage.getItem('__qaSeededRefresh') === token) return;
      localStorage.setItem('auth-refresh-token', JSON.stringify(token));
      if (once) localStorage.setItem('__qaSeededRefresh', token);
      const req = indexedDB.open('therapios-auth');
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('tokens')) req.result.createObjectStore('tokens');
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tokens')) { db.close(); return; }
        const tx = db.transaction('tokens', 'readwrite');
        tx.objectStore('tokens').put(token, 'refresh');
        tx.oncomplete = () => db.close();
      };
    } catch {
      /* a context that refuses storage cannot be signed in this way either */
    }
  }, { token: refreshToken, once: opts.once ?? false });
}
