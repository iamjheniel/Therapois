import { test as base, type BrowserContext } from '@playwright/test';
import { seedRefreshToken } from '../../Pages/util/api-token';

/**
 * A working login for every test that opens a browser.
 *
 * WHY: the refresh token in a project's saved storageState is SINGLE-USE (#3460). The first test of
 * a run spends it, the API's 30 s grace window (#3910, bf85b72830) forgives a replay only briefly,
 * and every later test that loads the same file lands on the login form — then waits out its 90 s
 * timeout and its retry. On CI that turned whole jobs into a queue of login-form timeouts and ran
 * them past the 60-minute limit.
 *
 * HOW: the `context` fixture is overridden to seed a valid token before the first navigation
 * (reload-safe, `once`). The token is CHAINED through the worker rather than minted per test,
 * because `POST /auth` is throttled at 5/min per username+IP (#3462): at teardown the context's
 * CURRENT token — the app's own rotated successor — is read back and handed to the next test. Only a
 * test that passed and did not end on the login form contributes its token; otherwise the next test
 * logs in fresh. API-only tests never create a context, so they cost nothing.
 *
 * Specs that mint their own session (`mintUiSession`, `seedSession`) keep working: their init script
 * runs after this one and wins.
 *
 * USAGE: specs import `test`/`expect` from this module instead of '@playwright/test'.
 */

type Account = { api: string; origin: string; email: string; password: string };

const STAGING = { api: 'https://api.staging.therapios.de', origin: 'https://staging.therapios.de' };
const PRODUCTION = { api: 'https://api.app.therapios.de', origin: 'https://app.therapios.de' };

const ACCOUNTS: Record<string, Account> = {
  AdminJhen: { ...STAGING, email: 'admin.jhen@gmail.com', password: '12345678' },
  SAJhen: { ...STAGING, email: 'sa.jhen@gmail.com', password: 'thera.rocks' },
  SandraZeibig: { ...STAGING, email: 'jhenqa@therapios.de', password: '12345678' },
  'AdminJhen-Prod': { ...PRODUCTION, email: 'admin.jhen@gmail.com', password: '12345678' },
  'SAJhen-Prod': { ...PRODUCTION, email: 'sa.jhen@gmail.com', password: 'thera.rocks' },
  'JhenQA-Prod': { ...PRODUCTION, email: 'jhenqa@therapios.de', password: '12345678' },
};

/** The token the previous test of this worker left behind, per project. */
const chained = new Map<string, string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(context: BrowserContext, acct: Account): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await context.request.post(`${acct.api}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: acct.email, password: acct.password },
      timeout: 60_000,
    }).catch(() => null);
    if (res?.status() === 200) return (await res.json()).refresh_token as string;
    if (attempt >= 4) throw new Error(`session fixture: POST /auth as ${acct.email} -> ${res?.status() ?? 'network error'}`);
    // 429 carries Retry-After; anything else (5xx, a dropped socket) gets a short backoff.
    const retryAfter = Number(res?.headers()['retry-after']);
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 5_000 * attempt);
  }
}

/** The refresh token the app currently holds, or null when it is signed out / unreadable. */
async function currentToken(context: BrowserContext, origin: string): Promise<string | null> {
  const page = context.pages().find((p) => !p.isClosed() && p.url().startsWith(origin));
  if (!page) return null;
  return page.evaluate(async () => {
    if (/Bitte geben Sie Ihre Anmeldedaten ein/.test(document.body?.innerText ?? '')) return null;
    const fromIdb = await new Promise<string | null>((resolve) => {
      try {
        const req = indexedDB.open('therapios-auth');
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('tokens')) { db.close(); resolve(null); return; }
          const get = db.transaction('tokens', 'readonly').objectStore('tokens').get('refresh');
          get.onsuccess = () => { db.close(); resolve(typeof get.result === 'string' ? get.result : null); };
          get.onerror = () => { db.close(); resolve(null); };
        };
      } catch { resolve(null); }
    });
    if (fromIdb) return fromIdb;
    try { return JSON.parse(localStorage.getItem('auth-refresh-token') ?? 'null'); } catch { return null; }
  }).catch(() => null);
}

export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const project = testInfo.project.name;
    const acct = ACCOUNTS[project];
    if (!acct) { await use(context); return; }
    const token = chained.get(project) ?? (await login(context, acct));
    chained.delete(project);
    await seedRefreshToken(context, token, { once: true });
    await use(context);
    if (testInfo.status !== testInfo.expectedStatus) return;
    const next = await currentToken(context, acct.origin);
    if (next) chained.set(project, next);
  },
});

export * from '@playwright/test';
