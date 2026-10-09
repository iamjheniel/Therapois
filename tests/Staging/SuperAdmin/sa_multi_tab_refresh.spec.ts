import { test, expect, type BrowserContext, type Page } from '../../fixtures/session';
import { STAGING_CREDENTIALS, seedRefreshToken } from '../../../Pages/util/api-token';

/**
 * RC 3.15 #3910 AC1 — two (or more) browser tabs refreshing the login at the same moment never
 * present the same single-use refresh token, and the user stays logged in.
 *
 * The PM FAILED this on 2026-10-06: with 3 tabs reloaded together, 3 of 20 rounds had two tabs
 * present the SAME token → the second 401'd → reuse detection revoked the family → every tab
 * logged out. Cause, from their lock trace: the Web Lock handed over in the same millisecond the
 * previous holder wrote the new token to localStorage, and the next holder still read the old one
 * (Chromium's per-tab localStorage copy syncs asynchronously). Fixed 2026-10-07 by
 *   - `5da96139d5`: the web refresh token lives in IndexedDB (`therapios-auth`), and `setTokens`
 *     resolves only after the write commits, so the next lock holder reads the committed token;
 *   - `bf85b72830`: a token revoked < 30 s ago that was its family's LAST rotation and whose
 *     successor is still live is rotated again instead of revoking the family (the "reload during
 *     an in-flight refresh" logout). It amends #3459 AC2 by user decision.
 *
 * This file re-runs the PM's experiment (Promise.all reloads, each round waiting for every refresh
 * to answer) and pins the API grace window and its limits. It touches only its own session.
 */
const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

type Refresh = { round: number; token: string; status: number | null };

async function signedInContext(browser: any): Promise<BrowserContext> {
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const res = await ctx.request.post(`${API}/auth`, {
    headers: { 'Content-Type': 'application/json' },
    data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
  });
  const refresh = (await res.json()).refresh_token as string;
  // Seed ONCE per token (#3761), into IndexedDB as well — the app reads it first since #3910.
  await seedRefreshToken(ctx, refresh, { once: true });
  return ctx;
}

async function onLoginForm(p: Page): Promise<boolean> {
  return (await p.getByText(/Bitte geben Sie Ihre Anmeldedaten ein/).count()) > 0;
}

async function waitSignedIn(p: Page) {
  await expect.poll(async () => (await onLoginForm(p)) ? 'login' : ((await p.getByText('Admin Board').count()) > 0 ? 'in' : 'loading'),
    { timeout: 120_000, intervals: [500] }).not.toBe('loading');
}

async function runRounds(browser: any, tabs: number, rounds: number) {
  const ctx = await signedInContext(browser);
  const log: Refresh[] = [];
  let round = 0;
  const pending = new Set<string>();
  ctx.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/token/refresh')) {
      let token = '';
      try { token = JSON.parse(r.postData() ?? '{}').refresh_token ?? ''; } catch { /* noop */ }
      const entry: Refresh = { round, token: token.slice(-10), status: null };
      log.push(entry);
      pending.add(r.url() + log.length);
      const key = r.url() + log.length;
      r.response().then((resp) => { entry.status = resp?.status() ?? -1; pending.delete(key); }).catch(() => { entry.status = -1; pending.delete(key); });
    }
  });
  const pages: Page[] = [];
  const consoleErrors: string[][] = [];
  for (let i = 0; i < tabs; i++) {
    const p = await ctx.newPage();
    const errs: string[] = [];
    consoleErrors.push(errs);
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(`${new Date().toISOString().slice(11, 23)} ${m.text().slice(0, 200)}`); });
    p.on('pageerror', (e) => errs.push(`pageerror ${String(e).slice(0, 200)}`));
    await p.goto(`${WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    await waitSignedIn(p);
    pages.push(p);
  }
  for (const p of pages) expect(await onLoginForm(p), 'signed in before the rounds').toBe(false);

  const bad: string[] = [];
  for (round = 1; round <= rounds; round++) {
    // Fire every reload from inside its page in the same tick (truer to "the same moment" than
    // awaiting Playwright's navigation, which a slow staging load can time out on), then wait for
    // the new documents.
    await Promise.all(pages.map((p) => p.evaluate(() => { setTimeout(() => location.reload(), 0); }).catch(() => {})));
    await Promise.all(pages.map((p) => p.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {})));
    await pages[0].waitForTimeout(1_500); // let each new document start its boot refresh
    // Gate the next round on every refresh having answered (the PM's protocol), then on every tab
    // having settled on either the board or the login form.
    await expect.poll(() => log.filter((l) => l.round === round && l.status === null).length, { timeout: 60_000 }).toBe(0);
    {
      const early = log.filter((l) => l.round === round);
      console.log(`    round ${round} refreshes so far: ${JSON.stringify(early.map((m) => `${m.token.slice(-4)}:${m.status}`))}`);
    }
    for (const [i, p] of pages.entries()) {
      try {
        await waitSignedIn(p);
      } catch (e) {
        // A tab that never leaves the boot spinner: dump what it is waiting on.
        const diag = await p.evaluate(async () => {
          const locks = await (navigator as any).locks?.query?.().catch(() => null);
          const dbs = await (indexedDB as any).databases?.().catch(() => null);
          return { url: location.href, locks, dbs, ls: localStorage.getItem('auth-refresh-token')?.slice(-12) ?? null };
        }).catch((err) => ({ evalError: String(err) }));
        console.log(`  ✘ round ${round}: tab ${i} stuck. ${JSON.stringify(diag)}`);
        console.log(`    tab ${i} console errors: ${JSON.stringify(consoleErrors[i].slice(-8))}`);
        throw e;
      }
    }
    const mine = log.filter((l) => l.round === round);
    const tokens = mine.map((l) => l.token);
    const dupes = tokens.filter((t, i) => tokens.indexOf(t) !== i);
    const refused = mine.filter((l) => l.status !== 200);
    const loggedOut = (await Promise.all(pages.map(onLoginForm))).filter(Boolean).length;
    console.log(`    round ${round}: ${mine.length} refreshes ${JSON.stringify(mine.map((m) => `${m.token.slice(-4)}:${m.status}`))} logged out ${loggedOut}`);
    if (dupes.length || refused.length || loggedOut) {
      bad.push(`round ${round}: ${mine.length} refreshes, duplicate tokens ${dupes.length}, refused ${refused.map((r) => r.status).join(',') || 0}, tabs logged out ${loggedOut}`);
      if (loggedOut) break;
    }
  }
  const total = log.length;
  console.log(`  ${tabs} tabs × ${round - 1 >= rounds ? rounds : round} rounds: ${total} refreshes, ${new Set(log.map((l) => l.token)).size} distinct tokens, statuses ${JSON.stringify([...new Set(log.map((l) => l.status))])}`);
  for (const b of bad) console.log(`  ✘ ${b}`);
  await ctx.close();
  return { bad, total };
}

test.describe('#3910 AC1 — tabs refreshing together never share a refresh token', () => {
  test.describe.configure({ mode: 'serial' });

  test('deployment: the refresh token store is IndexedDB (therapios-auth) in the served bundle', {
    tag: ['@SuperAdmin', '@MultiTabRefresh', '@ReadOnly'],
  }, async ({ request }) => {
    const html = await (await request.get(`${WEB}/`)).text();
    const entry = /\/_expo\/static\/js\/web\/entry-[^"]+\.js/.exec(html)![0];
    const js = await (await request.get(`${WEB}${entry}`, { timeout: 120_000 })).text();
    expect(js.includes('therapios-auth'), 'the IndexedDB store of 5da96139d5').toBe(true);
    expect(js.includes('therapios-token-refresh'), 'the cross-tab Web Lock').toBe(true);
  });

  test('API grace window (bf85b72830): a just-spent LAST rotation is rotated again; its limits still refuse', {
    tag: ['@SuperAdmin', '@MultiTabRefresh', '@ReadOnly'],
  }, async ({ request }) => {
    test.setTimeout(120_000);
    const login = async () => (await (await request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
    })).json()).refresh_token as string;
    const refresh = async (t: string) => {
      const r = await request.post(`${API}/token/refresh`, { headers: { 'Content-Type': 'application/json' }, data: { refresh_token: t } });
      return { status: r.status(), token: r.ok() ? (await r.json()).refresh_token as string : null };
    };
    // 1. The lost-rotation case: T0 → T1, T1 never used, T0 presented again at once → rotated again.
    const t0 = await login();
    const t1 = await refresh(t0);
    expect(t1.status).toBe(200);
    const again = await refresh(t0);
    expect(again.status, 'a reload that lost its refresh answer is rotated again, not logged out').toBe(200);
    expect((await refresh(t1.token!)).status, 'and the successor that was issued still works').toBe(200);
    // 2. Limit: once the successor has been EXCHANGED, the old token is a real replay → family revoked.
    const u0 = await login();
    const u1 = await refresh(u0);
    const u2 = await refresh(u1.token!);
    expect(u2.status).toBe(200);
    expect((await refresh(u0)).status, 'a token whose successor was already exchanged is refused').toBe(401);
    expect((await refresh(u2.token!)).status, 'and the reuse takes the family down').toBe(401);
    // 3. Limit: after the 30 s window the lost rotation is no longer forgiven.
    const v0 = await login();
    expect((await refresh(v0)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 33_000)); // the duration IS the condition under test
    expect((await refresh(v0)).status, 'outside the 30 s window the spent token is refused').toBe(401);
  });

  test('3 tabs reloaded together, 20 rounds: distinct tokens, every refresh 200, nobody logged out', {
    tag: ['@SuperAdmin', '@MultiTabRefresh', '@ReadOnly'],
  }, async ({ browser }) => {
    test.setTimeout(1_200_000);
    const { bad, total } = await runRounds(browser, 3, 20);
    expect(total, 'the rounds actually refreshed').toBeGreaterThan(20);
    expect(bad, 'the PM saw 3 failing rounds of 20 here before the fix').toEqual([]);
  });

  test('2 tabs reloaded together, 20 rounds: the AC\'s own case', {
    tag: ['@SuperAdmin', '@MultiTabRefresh', '@ReadOnly'],
  }, async ({ browser }) => {
    test.setTimeout(1_200_000);
    const { bad } = await runRounds(browser, 2, 20);
    expect(bad).toEqual([]);
  });
});
