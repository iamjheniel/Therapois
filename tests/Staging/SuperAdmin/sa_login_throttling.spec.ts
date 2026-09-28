import { test, expect } from '@playwright/test';
import { LoginThrottlingPage } from '../../../Pages/superadmin/sa.login-throttling.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — SEC-03: login throttling on the `/auth` firewall (#3462).
 *
 * `POST /auth` accepted unlimited credential attempts; the fix adds Symfony's `login_throttling`
 * (`max_attempts: 5`, `interval: '1 minute'`, DoctrineDbal-backed pool) plus a listener that returns
 * **429 + `Retry-After`** rather than a 401 indistinguishable from a wrong password.
 *
 * **Deployed on staging and working — with one AC that does not hold and one weakness no AC covers.**
 *
 * - **AC6 fails.** A successful login does not clear the accumulated failure budget. Reproduced on
 *   two accounts: 2 failures → a successful login (200) → only **3** further failures before the
 *   429, i.e. the counter ran straight through the success at 5. A user who mistypes, logs in, then
 *   mistypes again inside the same minute is locked out despite having authenticated.
 * - **The limiter has no lock, so a burst walks through it.** Sequentially the ceiling is exactly 5.
 *   Fired simultaneously, **15 of 20** guesses for one username came back 401 on one run and 10 of
 *   20 on the next — two to three times the configured limit — and an **already-throttled** username
 *   leaked 10 of 20 the same way, so even the 429 state does not hold under a burst. The per-IP
 *   ceiling softens identically (25 sequential, but 40 of 40 accepted in batches of 10 concurrent). Against a ticket whose stated purpose is "stopping
 *   automated spraying", the attacker's natural request pattern is the one the control handles
 *   worst.
 *
 * **What does hold:** 5 → 429 with `Retry-After: 60` and a body carrying no username (AC2, AC9); a
 * second username from the same IP still reaches 401 and a real account still logs in while the
 * first is throttled (AC4); the per-IP secondary sits at exactly 25/min, i.e. `5 × max_attempts`;
 * 20 simultaneous fresh TCP connections against an exhausted username all answered 429, so the
 * state is shared across whatever tasks those connections reached (AC3); and the window clears at
 * t+68s with the full budget of 5 restored (AC5).
 *
 * **Every test here is a login attempt against a shared environment, so the file is deliberately
 * frugal and polite:** throwaway `@example.invalid` usernames for all bad-password work, real
 * accounts only ever sent their correct password (except the one `serial` AC6 test, which logs in
 * again at the end), and a quiet-window wait before any measurement — the 25/min per-IP ceiling is
 * shared with anything else running, and without that wait a 429 cannot be attributed to the
 * limiter under test. That makes the file slow by construction; it is tagged `@Slow` and is not
 * meant for every CI run.
 */

test.describe('SEC-03 — login throttling on /auth', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC2/AC9 — the sixth failed attempt is 429 with Retry-After, and the body names no user',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('so a 429 can only come from this username');

      const username = LoginThrottlingPage.throwawayUsername('ac2');
      const { allowed, throttled } = await auth.attemptsAllowedBeforeThrottle(username);
      console.log(`failed attempts allowed before the throttle: ${allowed}`);

      expect(allowed, 'the configured max_attempts is 5').toBe(LoginThrottlingPage.MAX_ATTEMPTS);
      expect(throttled, 'the next attempt must be refused').not.toBeNull();
      expect(throttled!.status).toBe(429);
      expect(throttled!.retryAfter, "interval is '1 minute', so the client is told 60 seconds").toBe('60');
      expect(throttled!.message).toBe(LoginThrottlingPage.THROTTLED_MESSAGE);

      // AC9: the response is the one place a throttling implementation is tempted to echo the
      // credential back. It must not — and the local part alone would be enough to leak it.
      expect(throttled!.message, 'the throttled response must not echo the attempted username').not.toContain(
        username.split('@')[0],
      );
      expect(throttled!.hasToken, 'a throttled attempt must never issue a token').toBe(false);
    },
  );

  test(
    'AC4 — a throttled username does not lock out anyone else behind the same IP',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('AC4 needs the per-IP budget free so only the username limit can fire');

      const victim = LoginThrottlingPage.throwawayUsername('ac4');
      const { allowed } = await auth.attemptsAllowedBeforeThrottle(victim);
      expect(allowed).toBe(LoginThrottlingPage.MAX_ATTEMPTS);
      expect((await auth.attempt(victim, 'nope')).status, 'the first username stays throttled').toBe(429);

      // The shared-NAT clinic guarantee, in both directions: a colleague's wrong password still
      // reaches a plain 401, and a colleague with the right password still gets in.
      const colleague = await auth.attempt(LoginThrottlingPage.throwawayUsername('ac4-colleague'), 'nope');
      expect(colleague.status, 'a second username from the same IP must still reach 401').toBe(401);

      const real = await auth.attempt(STAGING_CREDENTIALS.superadmin.email, STAGING_CREDENTIALS.superadmin.password);
      expect(real.status, 'and a real account on the same IP must still log in').toBe(200);
      expect(real.hasToken).toBe(true);
      console.log('throttled username stayed 429 while another username got 401 and a real login got 200');
    },
  );

  test(
    'AC4 (secondary) — the per-IP ceiling is 5x the per-username limit',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('the per-IP ceiling can only be measured from an empty window');

      // Every attempt uses a DIFFERENT username, so no username limiter can reach 5 — whatever
      // answers 429 here is necessarily the IP-keyed secondary.
      const allowed = await auth.distinctUsernamesAllowedBeforeThrottle(40);
      console.log(`distinct usernames allowed from one IP before the 429: ${allowed}`);
      expect(allowed, 'Symfony sets the global limiter at 5 x max_attempts').toBe(LoginThrottlingPage.IP_CEILING);
    },
  );

  test(
    'AC3 — the effective limit does not multiply by the task count',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('AC3 compares a measured ceiling against the configured one');

      // AC3's failure mode is per-container state, and it has an arithmetic signature: with the
      // 2-4 tasks the migration note describes, a per-container store makes the effective limit
      // 5 x task_count, i.e. 10-20. Measuring the ceiling is therefore the demonstration — and it
      // has to be measured SEQUENTIALLY, because a burst is dominated by the missing lock (see the
      // `fixme` below) and would confound the two defects.
      const username = LoginThrottlingPage.throwawayUsername('ac3');
      const { allowed } = await auth.attemptsAllowedBeforeThrottle(username, 25);
      console.log(`per-username ceiling measured sequentially: ${allowed} (configured max_attempts is 5)`);
      expect(
        allowed,
        'a per-container store would show 5 x task_count here; anything at the configured limit means one shared counter',
      ).toBeLessThanOrEqual(LoginThrottlingPage.MAX_ATTEMPTS + 1);

      // The same argument on the per-IP limiter, which has a 5x larger and therefore more sensitive
      // ceiling: 25 exactly, not 50 or 100.
      await auth.waitForQuietWindow('re-measuring the per-IP ceiling for the same argument');
      const perIp = await auth.distinctUsernamesAllowedBeforeThrottle(40);
      console.log(`per-IP ceiling measured sequentially: ${perIp} (configured 5 x max_attempts = 25)`);
      expect(perIp, 'the IP ceiling is the more sensitive of the two and lands exactly on the configured value').toBe(
        LoginThrottlingPage.IP_CEILING,
      );

      // And once exhausted, sequential attempts stay refused however many connections they use.
      for (let i = 1; i <= 5; i++) {
        expect((await auth.attempt(username, 'nope')).status, `follow-up attempt ${i}`).toBe(429);
      }
    },
  );

  test(
    'AC5 — the throttle is a delay, and the full budget comes back',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(400_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('the decay is timed from the 429, so nothing may precede it');

      const username = LoginThrottlingPage.throwawayUsername('ac5');
      const { allowed, throttled } = await auth.attemptsAllowedBeforeThrottle(username);
      expect(allowed).toBe(LoginThrottlingPage.MAX_ATTEMPTS);
      expect(throttled!.retryAfter).toBe('60');

      const seconds = await auth.secondsUntilThrottleClears(username);
      console.log(`throttle cleared ${seconds}s after the 429 (Retry-After promised 60)`);
      expect(seconds, 'the lockout must end on its own, with no support intervention').not.toBeNull();
      expect(seconds!, 'and within a reasonable margin of the advertised 60s').toBeLessThanOrEqual(120);

      // "A delay, not a lockout" also means the budget is whole again, not one grudging attempt:
      // the probe above consumed 1 of the new window, so 4 more must be accepted.
      const { allowed: afterDecay } = await auth.attemptsAllowedBeforeThrottle(username, 8);
      console.log(`further failed attempts allowed right after recovery: ${afterDecay}`);
      expect(afterDecay, 'the window resets whole (5 minus the one that proved recovery)').toBe(
        LoginThrottlingPage.MAX_ATTEMPTS - 1,
      );
    },
  );

  test(
    'AC6 — a successful login clears the failure budget',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.fixme(
        true,
        'FAILS on staging (2026-09-01): the successful login does not reset the counter. ' +
          'Sequence on admin.jhen@gmail.com — 2 failed attempts (401, 401), a SUCCESSFUL login (200), ' +
          'then failures: 401, 401, 401, 429. The 429 lands on the 6th failure counted from before the ' +
          'success, so the success neither consumed nor cleared anything; the budget ran straight ' +
          'through it. Reproduced on sa.jhen@gmail.com with 4 failures first: 401 then 429 immediately ' +
          'after the successful login. ' +
          'Symfony ships the reset (LoginThrottlingListener::onSuccessfulLogin -> limiter->reset()), so ' +
          'this looks like the reset not reaching the same limiter key rather than a missing feature — ' +
          'worth checking against the stateless firewall and Lexik success handler. ' +
          'User-visible effect: mistype 4 times, log in, mistype twice more inside the same minute and ' +
          'you are locked out for up to a minute despite having authenticated in between — exactly the ' +
          '"residual limiter budget that penalises normal use" this AC forbids. ' +
          'The functional test cannot catch it: LoginThrottlingTest::testSuccessfulLoginUnaffectedBy' +
          'SubThresholdFailures only asserts that 2 sub-threshold failures still allow a correct login, ' +
          'never that the success reset the counter. Add a case that fails 2x, logs in, then asserts ' +
          '5 more failures are allowed.',
      );

      test.setTimeout(400_000);
      const auth = new LoginThrottlingPage(request);
      const { email, password } = STAGING_CREDENTIALS.admin;
      await auth.waitForQuietWindow('AC6 counts attempts around a success, so it must start clean');

      for (let i = 1; i <= 2; i++) {
        expect((await auth.attempt(email, 'wrong-password')).status, `sub-threshold failure ${i}`).toBe(401);
      }
      expect((await auth.attempt(email, password)).status, 'the correct password must still work').toBe(200);

      const { allowed } = await auth.attemptsAllowedBeforeThrottle(email, 8);
      console.log(`failed attempts allowed after the successful login: ${allowed}`);
      expect(allowed, 'a successful login must leave a full budget behind').toBe(LoginThrottlingPage.MAX_ATTEMPTS);

      // Leave the account usable regardless of how the assertion went.
      await auth.waitForQuietWindow('clearing the throttle this test just created');
      expect((await auth.attempt(email, password)).status).toBe(200);
    },
  );

  test(
    'The limit holds when the attempts arrive at once, not only one at a time',
    { tag: ['@SuperAdmin', '@LoginThrottling', '@Security', '@Slow'] },
    async ({ request }) => {
      test.fixme(
        true,
        'FAILS on staging (2026-09-01): 20 simultaneous bad-password attempts on ONE fresh username are ' +
          'not capped at 5. Two runs from a quiet window: **15 x 401 / 5 x 429**, then **10 x 401 / ' +
          '10 x 429** — two to three times the configured max_attempts, and the excess varies with how ' +
          'tightly the burst lands. Worse, the same happens to an ALREADY-EXHAUSTED counter: 20 ' +
          'simultaneous attempts on a username that had just been throttled came back **10 x 401 / ' +
          '10 x 429**, so the 429 state itself does not hold under concurrency — 10 further password ' +
          'guesses were answered after the limit had already been reached. ' +
          'Sequentially the same username allows exactly 5 (keep-alive) or 6 (fresh TCP connection ' +
          'per request); the difference is concurrency. The per-IP ceiling behaves the same way: 25 ' +
          'sequential distinct usernames trip it exactly, but 40 sent in batches of 10 concurrent were ' +
          'all accepted. ' +
          'Cause: Symfony builds the login-throttling limiters with `lock_factory: null`, so ' +
          'consume() is a read-modify-write with no mutual exclusion, and a burst reads the same ' +
          'counter value repeatedly. The DoctrineDbal pool shares the value across tasks (AC3 holds) ' +
          'but does not serialise updates to it. ' +
          'Why it matters here rather than in general: the ticket\'s stated goal is "stopping automated ' +
          'spraying", and a script sprays concurrently by default — so the control is weakest under ' +
          'precisely the traffic it exists to stop. It is a real reduction of the attack cost, not a ' +
          'bypass: 15 guesses per burst per username is still bounded, and the window still applies. ' +
          'Fix would be a lock_factory on the limiters (needs a shared lock store, the same ' +
          'cross-task question #3459 answered for the cache) — worth a follow-up rather than a ' +
          'blocker on this ticket.',
      );

      test.setTimeout(300_000);
      const auth = new LoginThrottlingPage(request);
      await auth.waitForQuietWindow('the burst must start from an empty per-IP window');

      const username = LoginThrottlingPage.throwawayUsername('burst');
      const tally = await auth.simultaneousAttempts(username, 20);
      console.log(`20 simultaneous attempts on a fresh username: ${JSON.stringify(tally)}`);
      expect(tally[401] ?? 0, 'no more guesses may be answered than max_attempts, however they arrive').toBeLessThanOrEqual(
        LoginThrottlingPage.MAX_ATTEMPTS,
      );
    },
  );
});
