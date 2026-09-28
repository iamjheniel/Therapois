import { APIRequestContext, expect } from '@playwright/test';

/**
 * Login throttling on the `/auth` firewall (RC 3.12 #3462, SEC-03).
 *
 * `POST /auth` used to accept unlimited credential attempts. The fix adds Symfony's
 * `login_throttling` to the `login` firewall — `max_attempts: 5`, `interval: '1 minute'`, state in
 * the DoctrineDbal-backed `login_throttling_cache_pool` — plus a listener that turns the throttled
 * failure into **429 + `Retry-After`** instead of Lexik's indistinguishable 401.
 *
 * Symfony's `DefaultLoginRateLimiter` is a **compound** limiter, and both halves matter here:
 *  - a **primary** limiter keyed on `hmac(username) + client IP`, at `max_attempts` (5/min);
 *  - a **secondary** limiter keyed on the client IP alone, at `5 × max_attempts` (25/min).
 *
 * **Everything in this file is a login attempt against staging, so it is written to be a good
 * citizen:**
 *  - Bad-password loops use throwaway `@example.invalid` usernames. A real account is only ever
 *    sent its CORRECT password, except in the one test that has to prove what a successful login
 *    does to the counter — and that test is `serial` and ends by logging in again.
 *  - Every measurement starts from a **quiet window** (`waitForQuietWindow()`), because the 25/min
 *    per-IP ceiling is shared by every test in this file and by any suite running beside it. Without
 *    that wait a 429 cannot be attributed to the limiter under test, which is exactly how a
 *    "threshold = 3" reading appears out of nowhere.
 *
 * **The measurement trap that matters most:** the threshold you measure depends on how the requests
 * are sent. Over one keep-alive connection it is exactly 5. Over a fresh TCP connection per request
 * it is 6. Fired **simultaneously**, 15 of 20 get through — the counter is read-modify-written with
 * no lock (`login_throttling` limiters are built with `lock_factory: null`), so a burst reads the
 * same value repeatedly. Any test that sends attempts in parallel and asserts "exactly 5" will be
 * flaky; any test that only sends them one at a time will miss the finding.
 */

export type Attempt = {
  status: number;
  retryAfter: string | null;
  message: string;
  hasToken: boolean;
};

export class LoginThrottlingPage {
  static readonly API = 'https://api.staging.therapios.de';
  static readonly MAX_ATTEMPTS = 5;
  /** Symfony's compound limiter puts the per-IP ceiling at 5x the per-username one. */
  static readonly IP_CEILING = LoginThrottlingPage.MAX_ATTEMPTS * 5;
  static readonly THROTTLED_MESSAGE = 'Too many failed login attempts, please try again later.';
  static readonly INVALID_MESSAGE = 'Invalid credentials.';
  /** `interval: '1 minute'`, plus a margin for the window to roll over. */
  static readonly QUIET_WINDOW_MS = 70_000;

  constructor(private request: APIRequestContext) {}

  /** A username nothing can authenticate as, unique per call so it starts with a fresh counter. */
  static throwawayUsername(tag = 'probe'): string {
    return `qa-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
  }

  /**
   * Waits out the per-IP window so the next measurement starts from zero.
   *
   * Deliberately a flat sleep: the duration IS the assertion's precondition, there is no readable
   * signal for "the limiter window has rolled", and polling would itself consume the budget being
   * waited for.
   */
  async waitForQuietWindow(reason: string): Promise<void> {
    console.log(`waiting ${LoginThrottlingPage.QUIET_WINDOW_MS / 1000}s for a quiet per-IP window — ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, LoginThrottlingPage.QUIET_WINDOW_MS));
  }

  async attempt(username: string, password: string): Promise<Attempt> {
    const response = await this.request.post(`${LoginThrottlingPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: { username, password },
      timeout: 60_000,
      failOnStatusCode: false,
    });
    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    return {
      status: response.status(),
      retryAfter: response.headers()['retry-after'] ?? null,
      message: String((body as { message?: string }).message ?? ''),
      hasToken: typeof (body as { token?: string }).token === 'string',
    };
  }

  /**
   * Sends failed attempts ONE AT A TIME until the throttle answers, and reports how many were let
   * through. Sequential on purpose — see the class docs on why a parallel version measures something
   * else entirely.
   */
  async attemptsAllowedBeforeThrottle(username: string, cap = 10): Promise<{ allowed: number; throttled: Attempt | null }> {
    for (let i = 1; i <= cap; i++) {
      const result = await this.attempt(username, 'definitely-not-the-password');
      if (result.status === 429) return { allowed: i - 1, throttled: result };
      expect(result.status, `attempt ${i} below the threshold must be a plain 401`).toBe(401);
    }
    return { allowed: cap, throttled: null };
  }

  /** Fires `count` attempts for one username simultaneously and tallies the statuses. */
  async simultaneousAttempts(username: string, count: number): Promise<Record<number, number>> {
    const results = await Promise.all(
      Array.from({ length: count }, () => this.attempt(username, 'definitely-not-the-password')),
    );
    const tally: Record<number, number> = {};
    for (const { status } of results) tally[status] = (tally[status] ?? 0) + 1;
    return tally;
  }

  /**
   * How many DISTINCT usernames can fail from this IP before the secondary limiter answers — the
   * per-IP ceiling, measured without any single username reaching its own limit.
   */
  async distinctUsernamesAllowedBeforeThrottle(cap = 40): Promise<number> {
    for (let i = 1; i <= cap; i++) {
      const result = await this.attempt(LoginThrottlingPage.throwawayUsername(`ip${i}`), 'definitely-not-the-password');
      if (result.status === 429) return i - 1;
    }
    return cap;
  }

  /** Polls a throttled username until it stops answering 429; returns the seconds elapsed. */
  async secondsUntilThrottleClears(username: string, maxSeconds = 150, everySeconds = 10): Promise<number | null> {
    const startedAt = Date.now();
    for (let waited = 0; waited < maxSeconds; waited += everySeconds) {
      await new Promise((resolve) => setTimeout(resolve, everySeconds * 1000));
      const result = await this.attempt(username, 'definitely-not-the-password');
      if (result.status !== 429) return Math.round((Date.now() - startedAt) / 1000);
    }
    return null;
  }
}
