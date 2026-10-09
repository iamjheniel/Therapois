import { test, expect } from '../../fixtures/session';
import {
  AuthRefreshPage,
  APP,
  AUTH_KEY,
  REFRESH_KEY,
  MIGRATION_FLAG,
} from '../../../Pages/superadmin/sa.auth-refresh.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — the auth-token security pass, WEB target: #3460 (SEC-01.4, transparent refresh + TTL
 * cut) and #3463 (SEC-04, token material out of plaintext storage).
 *
 * **Both are deployed** — #3460 as `857d30e19` + `4de74fd4a` + `ca9152701` (PR #3542), #3463 as
 * `4d6feab18`. Staging issues a **3600 s** access token on both the login and the refresh path, and
 * the served bundle carries `token/refresh`, `auth-refresh-token`, `auth-legacy-access-token` and
 * `_auth_token_migration_done`.
 *
 * **Both tickets ship on two platforms and this suite drives one.** iOS/Android Keychain/Keystore
 * storage — #3463's AC1, AC3, AC4, AC5, AC9 and #3460's Android half of AC5 — cannot be reached
 * from a browser at all. What IS decidable is the whole web contract, and
 * `packages/auth/README.md` states it precisely enough to test against:
 *
 *   web access token  → **in memory**, re-obtained via refresh on boot
 *   web refresh token → `localStorage` key `auth-refresh-token`, a documented accepted risk
 *                       (reviewed by 2026-11-30) resting on the 1 h TTL plus rotation and family
 *                       reuse detection
 *
 * That is the shape this file verifies: the TTL that bounds the risk, the rotation and reuse
 * detection the risk note leans on, and — #3463 AC3, which says explicitly "verified by inspecting
 * the stored value, not by reading the code" — that no access token is left in the persisted blob.
 *
 * **The finding is that the accepted risk understates itself**: the note argues the exposure is
 * bounded because the access token expires in an hour, but the refresh token sitting beside it in
 * localStorage mints a fresh access token on demand, and this suite's own `mintUiSession()` does
 * exactly that. See the fixme.
 *
 * **Traps**
 * - **Replaying a spent refresh token revokes the whole family**, including the live descendant —
 *   so a reuse test destroys the session it holds and must re-login afterwards, and two tests must
 *   never share one token chain. This file logs in fresh per case.
 * - `.auth/*.json` is single-use for the same reason; every UI test here calls `mintUiSession()`.
 * - The web client calls `/token/refresh` once on **every boot** by design (no persisted access
 *   token), so "a refresh happened" is not by itself evidence of the 401 path — count refreshes
 *   inside a window, not overall.
 */

const CREDENTIALS = STAGING_CREDENTIALS.superadmin;
/** #3460 AC1: no environment may issue a token living longer than an hour. */
const MAX_TTL_SECONDS = 3600;

test.describe('Auth token security on the web target (#3460, #3463)', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  let auth: AuthRefreshPage;

  test.beforeEach(async ({ request }) => {
    auth = new AuthRefreshPage(request);
  });

  // ──────────────────────────── #3460 — the TTL cut ───────────────────────────

  test(
    'AC1 both the login and the refresh path issue a one-hour access token',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async () => {
      const pair = await auth.login(CREDENTIALS.email, CREDENTIALS.password);
      const loginTtl = AuthRefreshPage.ttlSeconds(pair.token);

      const refreshed = await auth.refresh(pair.refresh_token);
      expect(refreshed.status, 'the refresh path must work').toBe(200);
      const refreshTtl = AuthRefreshPage.ttlSeconds(refreshed.body.token);

      console.log(`  login TTL ${loginTtl}s, refresh TTL ${refreshTtl}s`);
      // The yaml reads `%env(int:JWT_TOKEN_TTL)%` in every block, so the grep AC1 describes can
      // only ever show a variable — the deployed value is what the issued token says.
      expect(loginTtl, 'the login path issues at most one hour').toBeLessThanOrEqual(MAX_TTL_SECONDS);
      expect(refreshTtl, 'and so does the refresh path — the one that runs hourly forever').toBeLessThanOrEqual(
        MAX_TTL_SECONDS,
      );
      expect(loginTtl, 'and it is the full hour, not something shorter that would churn').toBe(MAX_TTL_SECONDS);
    },
  );

  test(
    'the refresh token rotates on every use, and a spent one is refused',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async () => {
      const pair = await auth.login(CREDENTIALS.email, CREDENTIALS.password);
      let current = pair.refresh_token;
      const seen = new Set<string>([current]);

      // A chain, not a single hop: a client on a 1 h TTL refreshes for as long as the user stays
      // signed in, so rotation has to survive repetition rather than work once.
      for (let i = 1; i <= 4; i++) {
        const result = await auth.refresh(current);
        expect(result.status, `refresh #${i}`).toBe(200);
        expect(result.body.refresh_token, `refresh #${i} must rotate the token`).not.toBe(current);
        expect(seen.has(result.body.refresh_token), `refresh #${i} must not reissue an earlier token`).toBe(false);
        current = result.body.refresh_token;
        seen.add(current);
      }
      console.log(`  4 consecutive refreshes, ${seen.size} distinct tokens`);

      const spent = [...seen][0];
      const replay = await auth.refresh(spent);
      console.log(`  replay of the original token -> ${replay.status} ${replay.body?.message ?? ''}`);
      expect(replay.status, 'a spent refresh token is refused').toBe(401);
    },
  );

  test(
    'replaying a spent token revokes the whole family, not just that token',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async () => {
      // This is the property the #3463 accepted-risk note leans on ("rotation + family reuse
      // detection bound the damage of a stolen refresh token"), so it is worth proving rather than
      // citing. The ordering matters: the live token is checked BEFORE the replay, or a failure
      // afterwards could not be attributed to it.
      const pair = await auth.login(CREDENTIALS.email, CREDENTIALS.password);
      const first = await auth.refresh(pair.refresh_token);
      expect(first.status).toBe(200);

      const live = await auth.refresh(first.body.refresh_token);
      expect(live.status, 'the descendant works before any replay').toBe(200);
      const stillLive = live.body.refresh_token;

      const replay = await auth.refresh(pair.refresh_token);
      expect(replay.status, 'the long-spent ancestor is refused').toBe(401);

      const after = await auth.refresh(stillLive);
      console.log(`  live descendant after the replay -> ${after.status}`);
      expect(after.status, 'and the reuse takes the live descendant down with it').toBe(401);
    },
  );

  test(
    'a bogus refresh token is refused without disclosing anything',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async () => {
      const result = await auth.refresh('not-a-real-refresh-token');
      console.log(`  bogus token -> ${result.status} ${JSON.stringify(result.body)}`);
      expect(result.status).toBe(401);
      expect(JSON.stringify(result.body ?? {}), 'the error names no user').not.toContain(CREDENTIALS.email);
    },
  );

  // ─────────────────── #3463 — what the browser actually stores ────────────────

  test(
    'AC3 the persisted auth blob carries no access token, and the web strategy matches the README',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async ({ page }) => {
      // AC3 is explicit that this is verified by inspecting the stored value rather than the code.
      await mintUiSession(page, CREDENTIALS);
      await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () => (await AuthRefreshPage.storedAuth(page)).authState !== null, { timeout: 90_000 })
        .toBe(true);

      const stored = await AuthRefreshPage.storedAuth(page);
      console.log(`  localStorage keys: ${stored.keys.filter((k) => /auth|token/i.test(k)).join(', ')}`);
      console.log(`  auth-state fields: ${Object.keys(stored.authState ?? {}).join(', ')}`);
      console.log(`  migration flag: ${stored.migrationFlag ?? '(absent)'}`);

      // The whole point of #3463: no token material under AUTH_KEY.
      expect(stored.authState?.token ?? null, `${AUTH_KEY} must carry no access token`).toBeNull();
      expect(
        AuthRefreshPage.containsJwt(stored.authState),
        `${AUTH_KEY} must contain no JWT anywhere in its payload`,
      ).toBe(false);
      // And the documented web strategy: the refresh token IS here, deliberately.
      expect(stored.refreshToken, `the refresh token lives under ${REFRESH_KEY} on web, per the README`).toBeTruthy();
      expect(
        AuthRefreshPage.containsJwt(stored.refreshToken),
        'the refresh token is opaque, not a second JWT',
      ).toBe(false);
      expect(stored.migrationFlag, `the one-shot migration flag ${MIGRATION_FLAG} is set`).toBeTruthy();
    },
  );

  test(
    'the web client has no persisted access token, so it refreshes once on boot',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async ({ page }) => {
      const refreshes: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/token/refresh')) refreshes.push(request.url());
      });

      await mintUiSession(page, CREDENTIALS);
      await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => refreshes.length, { timeout: 90_000, intervals: [500] }).toBeGreaterThan(0);
      await page.waitForTimeout(8_000);

      console.log(`  boot refresh calls: ${refreshes.length}`);
      // Exactly one: the in-memory strategy needs a token, and the single-flight guard means the
      // several requests a booting board fires must not each trigger their own refresh.
      expect(refreshes.length, 'the boot obtains its access token with a single refresh').toBe(1);
      expect(page.url(), 'and the user is not bounced to a login screen').not.toMatch(/login|signin/i);
    },
  );

  test(
    'AC5/AC6 concurrent 401s trigger exactly one refresh and the user stays signed in',
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async ({ page }) => {
      const refreshes: number[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/token/refresh')) refreshes.push(Date.now());
      });

      await mintUiSession(page, CREDENTIALS);
      await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(20_000);

      // Expire the access token from the client's point of view. A real expiry cannot be forced
      // (the token is in memory and lives an hour), and the client cannot tell an injected 401
      // from a genuine one — which is exactly the substitution AC6 describes.
      let forcing = false;
      const forced: string[] = [];
      await page.route('**/api.staging.therapios.de/**', async (route) => {
        const url = route.request().url();
        if (forcing && !url.includes('/token/refresh') && !url.includes('/auth')) {
          forced.push(url.split('?')[0]);
          if (forced.length >= 5) forcing = false; // one round of 401s, then let the replays through
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ code: 401, message: 'Expired JWT Token' }),
          });
          return;
        }
        await route.continue();
      });

      // Load the board FULLY first, then force the 401s and fire a burst from inside the loaded
      // app. Navigating with 401s already injected does not test concurrency: the boot bails after
      // its first couple of requests, so only two are ever in flight.
      await page.goto(`${APP}/flow-boards`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(45_000);

      const before = refreshes.length;
      forcing = true;
      // A granularity change re-fires every aggregation on the board at once (#3401 measured five
      // in flight), which is the concurrency AC6 describes.
      for (const label of ['Monat', 'Woche', 'Tag']) {
        const control = page.getByText(label, { exact: true }).first();
        if ((await control.count()) === 0) continue;
        await control.click({ force: true, timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
      }
      await page.waitForTimeout(20_000);

      // Fallback trigger: if the in-app burst produced nothing (the granularity controls are not
      // always reachable), reload a data screen. That yields only the couple of requests the boot
      // gets through before it stops — real, but below AC6's bar, which the skip below enforces.
      if (forced.length === 0) {
        await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(20_000);
      }
      forcing = false;
      await page.waitForTimeout(15_000);

      const during = refreshes.length - before;
      console.log(`  forced 401s: ${forced.length} (${[...new Set(forced)].length} distinct endpoints)`);
      console.log(`  refresh calls in that window: ${during}`);
      console.log(`  final url: ${page.url()}`);

      // AC6 asks for 5+. If the burst did not produce them the test must say so rather than pass
      // on a pair — two requests do not demonstrate a stampede guard.
      test.skip(forced.length < 5, `only ${forced.length} requests were in flight to 401 — AC6 needs 5+`);
      // The regression the ticket calls the highest-risk in the epic: N concurrent 401s must queue
      // behind ONE refresh, not stampede.
      expect(during, 'concurrent 401s must collapse into a single refresh').toBeLessThanOrEqual(1);
      // AC5: and the user is not returned to the login screen.
      expect(page.url(), 'the user stays signed in').not.toMatch(/login|signin/i);
    },
  );

  // ─────────────────── #3516 — useRoles resolves for anonymous users ──────────

  test(
    "#3516 useRoles resolves its loading flag even with no user",
    { tag: ['@SuperAdmin', '@AuthTokenSecurity', '@ReadOnly'] },
    async ({ page }) => {
      // `useRoles.ts` only called `setLoading(false)` when `state.user` was truthy, so an anonymous
      // consumer saw `loading: true` forever. Fixed in `cefde109d` (PR #3605); the ticket required
      // the characterisation test that pinned the old behaviour to be updated with it, and it was
      // (`packages/auth/__tests__/useRoles.test.tsx`: "user null → roles empty and loading resolves
      // to false (#3516)").
      //
      // A hook has no endpoint, so the deployed bundle is the surface: the effect body must call
      // the loading setter UNCONDITIONALLY, not behind a truthiness check on the user.
      const index = await page.request.get(`${APP}/`, { timeout: 120_000 });
      const entry = (await index.text()).match(/src="([^"]*entry-[^"]*\.js)"/)?.[1];
      expect(entry, 'the entry bundle must be locatable').toBeTruthy();
      const bundle = await (await page.request.get(`${APP}${entry}`, { timeout: 180_000 })).text();

      // The minified hook: two useState calls, then an effect that sets roles AND clears loading.
      const hook = bundle.match(
        /useState\)\(\w\.user\?\.roles\|\|\[\]\),\[(\w),(\w)\]=\(0,\w\.useState\)\(!0\);return\(0,\w\.useEffect\)\(\(\)=>\{([^}]*)\}/,
      );
      expect(hook, 'useRoles must be present in the bundle').toBeTruthy();
      const effectBody = hook![3];
      console.log(`  useRoles effect body: ${effectBody}`);
      // Post-fix this is `setRoles(...), setLoading(false)`. Pre-fix the setter sat behind a guard
      // such as `e.user&&(...)`, so the anonymous case never resolved.
      expect(effectBody, 'the effect must clear loading with no user check').toMatch(/,\s*\w\(!1\)\s*$/);
      expect(effectBody, 'and must not gate the whole body on the user').not.toMatch(/\w\.user\s*&&/);
    },
  );
});
