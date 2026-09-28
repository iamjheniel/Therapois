import { test, expect } from '@playwright/test';
import {
  FORGOT_BODY_MESSAGE,
  PasswordResetPage,
  RATE_LIMIT,
  THROWAWAY,
} from '../../../Pages/superadmin/sa.password-reset.page';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.14 #3737 (SEC-07) — self-service password reset, and a flagged block on weak credentials.
 *
 * ## Run this file at `--workers=1`, and expect it to open with a 31-minute wait
 *
 * Every probe in it draws on ONE budget: 10 requests per 15 minutes, keyed on the client address and
 * shared between both endpoints. That is not incidental — it is one of the ACs — but it means the
 * file cannot simply fire what it likes, so it is built to need ONE window: five requests for the
 * enumeration test, three for the token test, and the ceiling test last, deliberately, so the budget
 * it exhausts is one the file has finished with. `PasswordResetPage.spent` counts across tests, so
 * the trip point is measured over the whole window rather than over one test's own requests.
 *
 * The timing FINDING costs nothing: its baseline is the unknown-address samples the enumeration test
 * already took, so it is arithmetic over data in hand rather than a second round of probing.
 *
 * The wait is a flat sleep of TWO intervals with no probe. Under a SLIDING window a successful probe
 * means one slot freed, not that the budget is clear, so a poll-until-it-works wait hands the next
 * test nine spent slots; and Symfony's sliding window carries a weighted share of the PREVIOUS
 * bucket, so one interval after a saturating run is not enough either — measured, 20 minutes after
 * reaching the ceiling the fifth request still 429'd. Both are failures this file actually had. The
 * duration IS the precondition; see `waitForQuietWindow`.
 */
test.describe('#3737 SEC-07 — self-service password reset', () => {
  test.describe.configure({ mode: 'serial' });

  /** The only real mailbox this file ever writes to, and the link is never opened. */
  const OWNED = STAGING_CREDENTIALS.superadmin.email;
  const ROUND_TIMEOUT = 40 * 60_000;

  let api: PasswordResetPage;
  /** Shared between the enumeration test and the timing finding, so the latter spends no budget. */
  let timings: { known: number; unknown: number[]; cold: number } | null = null;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(ROUND_TIMEOUT);
    const request = await playwright.request.newContext();
    api = new PasswordResetPage(request);
    const waited = await api.waitForQuietWindow();
    console.log(`  opened the window after ${Math.round(waited / 1000)}s`);
  });

  // ─────────────────────────────── round one ───────────────────────────────

  test('deployment + AC — a known address is indistinguishable from an unknown one', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@Slow', '@ReadOnly'],
  }, async ({ request, page }) => {
    // The API half is deployed: the route exists (405 on the wrong verb, not 404) and is public —
    // no Authorization header is sent anywhere in this file.
    const wrongVerb = await request.get('https://api.staging.therapios.de/password/forgot', {
      failOnStatusCode: false,
    });
    expect(wrongVerb.status(), 'GET on the forgot route is 405, so the route is registered').toBe(405);

    // A real address means a real e-mail, so the only one used is a mailbox this suite owns.
    //
    // The ORDER matters for the timing finding further down: the first request through this context
    // also pays TLS and connection setup, so it would look slow whatever address it carried. The
    // unknown one goes first and is spent as the warm-up, `known` is measured second, and the
    // baseline is taken from the three warm samples after it.
    const unknown = await api.forgot(THROWAWAY('enum-unknown'));
    const known = await api.forgot(OWNED);
    const empty = await api.forgot('');
    const missing = await api.forgot(undefined);
    const malformed = await api.forgot('not-an-email');

    const cases = { unknown, known, empty, missing, malformed };
    for (const [label, probe] of Object.entries(cases)) {
      console.log(`  ${label.padEnd(10)} -> ${probe.status} ${String(probe.ms).padStart(5)}ms ${probe.body.slice(0, 80)}`);
    }
    for (const [label, probe] of Object.entries(cases)) {
      expect(probe.status, `${label} answers 202`).toBe(202);
      expect(probe.json?.message, `${label} returns the one shared body`).toBe(FORGOT_BODY_MESSAGE);
      // Echoing the address back would re-open enumeration through the body itself.
      expect(probe.body, `${label} names no address`).not.toContain('@');
    }
    expect(known.body, 'known and unknown are byte-identical, not merely equivalent').toBe(unknown.body);

    // Handed to the timing test, which then costs no budget at all. `unknown.ms` is deliberately
    // left out of the baseline — it was the cold request.
    timings = { known: known.ms, unknown: [empty.ms, missing.ms, malformed.ms], cold: unknown.ms };

    // The frontend deploys independently of the API (#3705) and /status reports the release rather
    // than the commit (#3704), so the served bundle is the only thing that can answer for the screens.
    const { source } = await new TranslationsPage(page).loadDictionaries();
    const markers = {
      'the /forgot-password route': (source.match(/forgot-password/g) ?? []).length,
      'the /reset-password route': (source.match(/reset-password/g) ?? []).length,
      'the 403 handler': (source.match(/password_change_required/g) ?? []).length,
      invalid_reset_token: (source.match(/invalid_reset_token/g) ?? []).length,
    };
    console.log('  bundle markers:', markers);
    for (const [what, count] of Object.entries(markers)) {
      expect(count, `the deployed bundle carries ${what}`).toBeGreaterThan(0);
    }
  });

  test('AC — an invalid, empty or unusable token is refused alike, and the token is checked first', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@Slow', '@ReadOnly'],
  }, async () => {
    const strong = 'Xq7#mRv2Lp9!tW';
    const unknown = await api.reset('deadbeefdeadbeefdeadbeef', strong);
    const empty = await api.reset('', strong);
    const noPassword = await api.reset('deadbeefdeadbeefdeadbeef');

    for (const [label, probe] of Object.entries({ unknown, empty, noPassword })) {
      console.log(`  ${label.padEnd(11)} -> ${probe.status} ${probe.body.slice(0, 110)}`);
      expect(probe.status, `${label} is refused with 400`).toBe(400);
      expect(probe.json?.code, `${label} carries the one shared code`).toBe('invalid_reset_token');
    }
    // The ordering matters to anyone writing a payload-guard test later: a request with NO password
    // still answers `invalid_reset_token`, so the token check runs first and hides every payload
    // guard behind it. A 422 here would have meant the password was validated against a bogus token.
    expect(noPassword.json?.code, 'the token is validated before the payload').toBe('invalid_reset_token');
  });

  test('AC — both endpoints are rate-limited from one shared budget, with Retry-After', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@Slow'],
  }, async () => {
    test.setTimeout(ROUND_TIMEOUT);
    // Placed last in the file's budget order on purpose: it continues the window the two tests
    // above spent rather than opening a fresh one, so `api.spent` already counts their requests and
    // the trip point is measured over the whole window instead of over this test's own. Exhausting
    // the budget here costs nothing, because everything that needs it has already run.
    const before = api.spent;
    let limited: Awaited<ReturnType<typeof api.forgot>> | null = null;
    for (let i = 0; i <= RATE_LIMIT.limit + 4 && !limited; i++) {
      const probe = await api.forgot(THROWAWAY(`walk-${i}`));
      if (probe.status === 429) limited = probe;
    }
    console.log(`  window held ${before} requests before this test; 429 at request ${api.spent}`);
    expect(limited, 'the limiter trips').toBeTruthy();
    expect(api.spent, `it trips near the configured ${RATE_LIMIT.limit}/${RATE_LIMIT.interval}`).toBeLessThanOrEqual(
      RATE_LIMIT.limit + 4,
    );
    expect(limited!.json?.code, 'the refusal is machine-readable').toBe('too_many_requests');
    expect(limited!.body, 'and names no address').not.toContain('@');
    expect(Number(limited!.retryAfter), 'Retry-After is a positive number of seconds').toBeGreaterThan(0);

    // "the shared DBAL pool": a budget spent on /forgot must also refuse /reset, or an attacker
    // simply alternates between the two endpoints.
    const reset = await api.reset('deadbeefdeadbeefdeadbeef', 'Xq7#mRv2Lp9!tW');
    console.log(`  /password/reset while throttled -> ${reset.status} retry-after=${reset.retryAfter}`);
    expect(reset.status, '/password/reset draws on the same budget').toBe(429);
  });

  test('FINDING — the response is identical but the response TIME is not', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@ReadOnly'],
  }, async () => {
    expect(timings, 'the enumeration test must have run first').toBeTruthy();

    // No new requests: the baseline is the empty, missing-key and malformed samples the enumeration
    // test already took, all of which return without minting a token or sending mail, and all of
    // which ran on a warm connection. Its cold first request is reported but excluded — otherwise
    // connection setup would be indistinguishable from the server work being measured.
    // Only a FIRST request for a real account does that work, so one sample on the known side is the
    // honest maximum anyway — a second would mean mailing a second real account, and the per-account
    // throttle would make a repeat for the same one fast.
    const baseline = PasswordResetPage.median(timings!.unknown);
    const delta = timings!.known - baseline;
    console.log(`  cold first request (excluded): ${timings!.cold}ms`);
    console.log(`  warm unknown median ${baseline}ms over ${timings!.unknown.length}: ${timings!.unknown.join(', ')}`);
    console.log(`  known, first request for the account: ${timings!.known}ms — delta ${delta}ms`);

    // Reported rather than failed. The ACs ask for identical RESPONSES and it delivers those; the
    // timing is a separate channel, and a narrow one — ten probes per quarter-hour, and a repeat for
    // the same address is throttled. Whether it is in scope is a decision for the PM.
    if (delta > baseline * 0.5) {
      console.log(
        `\n  FINDING: a first POST /password/forgot for a REAL account takes ~${Math.round(delta)}ms ` +
          `longer than for an unknown one — it mints a token and sends mail, where an unknown address ` +
          `returns immediately. The body is byte-identical, so the response is enumeration-safe and ` +
          `the response time is not.`,
      );
    } else {
      console.log('  no timing gap measured on this run');
    }
  });

  // ────────────────────── no budget: configuration only ─────────────────────

  test('the weak-credential block is OFF in every deployed environment, by configuration', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@ReadOnly'],
  }, async ({ request }) => {
    test.skip(!PasswordResetPage.ghAvailable(), 'needs `gh` to read the deployed parameter files');

    const staging = PasswordResetPage.enforcementFlag('staging');
    const production = PasswordResetPage.enforcementFlag('production');
    console.log(`  WeakCredentialEnforcement: staging=${staging} production=${production}`);

    // This is the whole reason the enforcement ACs are fixme'd below, and it is re-read from the repo
    // every run — the moment somebody flips it, this fails and those fixmes get revisited.
    expect(staging, 'staging ships the block switched off').toBe('false');
    expect(production, 'production ships the block switched off').toBe('false');

    // And with it off, an ordinary session must be completely unaffected: no 403, no forced change.
    const token = await api.token();
    const me = await request.get('https://api.staging.therapios.de/me', {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(me.status(), 'a normal session is untouched while the flag is off').toBe(200);
  });

  test('AC — the shipped tests cover expiry, reuse and enumeration-safety', {
    tag: ['@SuperAdmin', '@PasswordReset', '@Security', '@ReadOnly'],
  }, async () => {
    test.skip(!PasswordResetPage.ghAvailable(), 'needs `gh` to read the shipped test file');

    // This AC is about test coverage, so the shipped test file IS its surface — and it is the right
    // place for the three properties a client cannot reach: single use and expiry both need a live
    // token, which only ever arrives by e-mail.
    const source = PasswordResetPage.repoFile('api/tests/Functional/PasswordResetTest.php');
    expect(source, 'PasswordResetTest.php is present').toBeTruthy();
    const cases = [...source!.matchAll(/public function (test\w+)/g)].map((m) => m[1]);
    console.log(`  ${cases.length} cases:`);
    for (const name of cases) console.log(`    ${name}`);

    const required = {
      'enumeration-safety': /KnownAndUnknownAddressesGetTheSameAnswer/,
      reuse: /TokenSetsANewPasswordExactlyOnce/,
      expiry: /ExpiredTokenIsRefusedLikeAnUnknownOne/,
    };
    for (const [property, pattern] of Object.entries(required)) {
      expect(cases.some((c) => pattern.test(c)), `a case covers ${property}`).toBe(true);
    }
    // Not required by the AC, but the two that make the others mean something: a rejected password
    // must NOT burn the link, and the per-account throttle must answer like everything else.
    expect(cases.some((c) => /WeakOrMismatchedPasswordIsRejectedAndTheTokenSurvives/.test(c))).toBe(true);
    expect(cases.some((c) => /ThrottleWindowIsAnsweredAlikeAndSendsNothing/.test(c))).toBe(true);
  });

  // ────────────────────────────── not reachable ─────────────────────────────

});
