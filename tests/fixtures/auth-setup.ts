import type { BrowserContext, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { seedRefreshToken } from '../../Pages/util/api-token';

/**
 * Shared body of `auth.setup.ts` / `production.auth.setup.ts`.
 *
 * WHY THIS SHAPE (2026-10-09): CI shards every role job across several runners and each shard runs
 * setup. Logging all three accounts in through the UI on every shard at once put ~30 logins on
 * `POST /auth` inside a minute; the throttle (#3462) refused them, setup failed, and a failed setup
 * cancels every test in the shard ("did not run"). So:
 *   - `AUTH_ONLY` (comma-separated auth-file basenames, e.g. `SuperAdmin`) limits setup to the
 *     account the job needs — unset, all accounts are logged in, as locally;
 *   - the login is an API call that honours `Retry-After` instead of a form that cannot;
 *   - a login that still fails writes an EMPTY state and warns instead of failing. Tests do not
 *     depend on it: the session fixture (`tests/fixtures/session.ts`) seeds its own valid token.
 */

export type SetupAccount = { name: string; email: string; password: string; authFile: string };

const EMPTY_STATE = { cookies: [], origins: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function wanted(account: SetupAccount): boolean {
  const only = (process.env.AUTH_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return !only.length || only.includes(path.basename(account.authFile, '.json'));
}

function writeEmpty(authFile: string) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(EMPTY_STATE));
}

async function apiLogin(context: BrowserContext, api: string, account: SetupAccount): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await context.request.post(`${api}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: account.email, password: account.password },
      timeout: 60_000,
    }).catch(() => null);
    if (res?.status() === 200) return (await res.json()).refresh_token as string;
    if (attempt >= 5) throw new Error(`POST ${api}/auth as ${account.email} -> ${res?.status() ?? 'network error'}`);
    const retryAfter = Number(res?.headers()['retry-after']);
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 10_000 * attempt);
  }
}

export async function createAuthState(
  { page, context }: { page: Page; context: BrowserContext },
  account: SetupAccount,
  env: { api: string; origin: string },
) {
  if (!wanted(account)) {
    // Another job's account: leave an empty file so a project pointing at it can still start.
    if (!fs.existsSync(account.authFile)) writeEmpty(account.authFile);
    console.log(`⏭️  ${account.name}: not needed by this job (AUTH_ONLY=${process.env.AUTH_ONLY})`);
    return;
  }
  try {
    const token = await apiLogin(context, env.api, account);
    await seedRefreshToken(context, token, { once: true });
    await page.goto(`${env.origin}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Signed in once the app has left the boot screen without showing the login form.
    const loginForm = page.getByText(/Bitte geben Sie Ihre Anmeldedaten ein/);
    await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 50, undefined, { timeout: 60_000 });
    if (await loginForm.count()) throw new Error('landed on the login form after seeding the token');
    await context.storageState({ path: account.authFile, indexedDB: true });
    console.log(`✅ Auth state saved for ${account.name} → ${account.authFile}`);
  } catch (e) {
    writeEmpty(account.authFile);
    console.warn(`⚠️  ${account.name}: setup login failed (${String(e).slice(0, 200)}); wrote an empty state — the session fixture logs in per test.`);
  }
}
