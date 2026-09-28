import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Self-service password reset and the weak-credential block — RC 3.14 #3737 (SEC-07),
 * commits `e21f4a7de` (PR #3748) and `c369d0709` (the SES task role, 2026-09-24).
 *
 * Password reset was console-only, and an account whose password is its own e-mail address got a
 * fully usable session plus a `weak_credentials` flag the CLIENT was trusted to honour.
 *
 * ## Both halves are reachable, but only one of them is switched on
 *
 * The reset endpoints are `PUBLIC_ACCESS` in `security.yaml` and answer on staging. The weak
 * credential block is behind **`WEAK_CREDENTIAL_ENFORCEMENT`, which the commit sets to `false` in
 * every deployed environment** — so the 403 `password_change_required` path cannot fire anywhere,
 * which is the ticket's own Verify step. That is an ops decision (the report command is meant to run
 * first), not a defect, and {@link enforcementFlag} re-reads it from the repo each run so the
 * `fixme` cannot go stale.
 *
 * ## What "no enumeration" can and cannot be checked on
 *
 * `POST /password/forgot` answers **202 with one body** for known, unknown, empty, malformed and
 * per-account-throttled addresses alike, so the response is enumeration-safe. The response *time* is
 * not: a first request for a real account mints a token and sends mail. {@link forgot} therefore
 * returns `ms` beside the status, and the baseline is taken from the 429s and the unknown-address
 * 202s rather than assumed.
 *
 * ## Traps
 *
 *  - **The rate limit is shared between the two endpoints and keyed on the CLIENT ADDRESS**, so
 *    every probe in the file draws on one 10-per-15-minute budget — `/password/reset` probes included.
 *    Start from a quiet window or a stray 429 will be scored as a verdict on something else, exactly
 *    as #3462 required.
 *  - **`/password/reset` validates the TOKEN BEFORE the payload.** A request with no `password` at
 *    all answers `400 invalid_reset_token`, so a payload-guard test written against a bogus token
 *    measures the token check and concludes the password policy is missing.
 *  - **A real address means a real e-mail.** Only accounts this QA suite owns are ever sent one, and
 *    the link is never used — an unused token changes no password. Every other probe uses
 *    `@example.invalid` (the #3462 etiquette).
 *  - The per-account throttle in `reset_password.yaml` means the same real address is fast on a
 *    second request, so a timing sample is only meaningful on the FIRST request for an account.
 */

export const FORGOT = '/password/forgot';
export const RESET = '/password/reset';

/** The one body `/password/forgot` returns for every address, whatever its state. */
export const FORGOT_BODY_MESSAGE =
  'If this address belongs to an account, a link to reset the password has been sent.';

/** The rate limiter's configured shape (`rate_limiter.yaml`, `password_reset`). */
export const RATE_LIMIT = { policy: 'sliding_window', limit: 10, interval: '15 minutes' } as const;

/** Addresses that must never receive a reset mail from this suite. */
export const THROWAWAY = (tag: string) => `qa-3737-${tag}@example.invalid`;

export type Probe = { status: number; body: string; json: Record<string, unknown> | null; ms: number; retryAfter: string | null };

export class PasswordResetPage {
  private bearer: string | null = null;

  constructor(private request: APIRequestContext) {}

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  // ─────────────────────────── the two endpoints ──────────────────────────

  private async post(path: string, data: unknown): Promise<Probe> {
    const started = Date.now();
    const res = await this.request.post(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      data: data as Record<string, unknown>,
      timeout: 60_000,
      failOnStatusCode: false,
    });
    const body = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      /* a non-JSON body is itself worth reporting */
    }
    return {
      status: res.status(),
      body,
      json,
      ms: Date.now() - started,
      retryAfter: res.headers()['retry-after'] ?? null,
    };
  }

  /** `POST /password/forgot`. Pass an `@example.invalid` address unless this suite owns the mailbox. */
  async forgot(email: unknown): Promise<Probe> {
    this.spent++;
    return await this.post(FORGOT, email === undefined ? {} : { email });
  }

  /** `POST /password/reset`. The token is checked first, so a bad token hides every payload guard. */
  async reset(token: unknown, password?: unknown): Promise<Probe> {
    this.spent++;
    return await this.post(RESET, password === undefined ? { token } : { token, password });
  }

  /** Requests this instance has spent on the shared budget, so a ceiling test can count honestly. */
  spent = 0;

  /**
   * Sleep until the shared 10-per-15-minute budget has certainly cleared.
   *
   * **A flat sleep with no probe, and of TWO intervals rather than one.** Both parts are the result
   * of a failed run rather than caution:
   *
   *  - *No probe.* The limiter is a SLIDING window, so a probe that comes back 202 means exactly one
   *    slot has freed — not that the budget is clear — and a "probe until it succeeds" wait returns
   *    with nine of ten slots still spent, so the next test 429s on its first real request. Probing
   *    is also self-defeating in a way it was not for #3462: each probe is itself one of the ten.
   *  - *Two intervals.* Symfony's `sliding_window` counts the current fixed bucket PLUS a weighted
   *    share of the previous one, so one interval after a run that saturated the limiter, roughly
   *    half of those requests still count. Measured: 20 minutes after a run that reached the ceiling,
   *    four requests succeeded and the fifth answered 429 — which reads exactly like the endpoint
   *    refusing a malformed address. After two full intervals both buckets are empty.
   *
   * The duration IS the precondition, so callers carry a timeout measured in minutes. A first run
   * against an already-quiet window over-waits; that is the price of not spending budget to find out.
   */
  async waitForQuietWindow(): Promise<number> {
    const nap = 2 * 15 * 60_000 + 45_000;
    await new Promise((r) => setTimeout(r, nap));
    this.spent = 0;
    return nap;
  }

  // ──────────────────────────── repo-side reads ───────────────────────────

  /**
   * `WEAK_CREDENTIAL_ENFORCEMENT` as the deployed parameter file sets it.
   *
   * Read from the repo rather than pinned, so the `fixme` on the enforcement ACs clears itself the
   * day someone flips it. Returns null when `gh` is unavailable.
   */
  static enforcementFlag(env: 'staging' | 'production' = 'staging'): string | null {
    const json = PasswordResetPage.repoFile(`api/aws/parameters/${env}-service.json`);
    if (!json) return null;
    try {
      const rows = JSON.parse(json) as { ParameterKey: string; ParameterValue: string }[];
      return rows.find((r) => r.ParameterKey === 'WeakCredentialEnforcement')?.ParameterValue ?? null;
    } catch {
      return null;
    }
  }

  static repoFile(path: string, ref = 'release/3.14.0'): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      return execFileSync(
        'gh',
        ['api', `repos/therapios/monorepo/contents/${path}?ref=${ref}`, '--jq', '.content'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .split('\n')
        .map((line) => Buffer.from(line, 'base64').toString('utf8'))
        .join('');
    } catch {
      return null;
    }
  }

  static ghAvailable(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync('gh', ['auth', 'status'], { timeout: 30_000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Median, so one slow sample cannot carry a timing claim. */
  static median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}
