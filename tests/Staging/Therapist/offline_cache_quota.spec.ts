import { test, expect } from '@playwright/test';
import {
  cacheSnapshot,
  installBallast,
  installBallastAtBoot,
  persistAttempts,
  SentryTraffic,
} from '../../../Pages/util/query-cache';

/**
 * RC 3.11 — React Query offline cache exceeds localStorage quota (#3385).
 *
 * The persister serialized the whole dehydrated cache into one localStorage key and reported every
 * failed write to Sentry, once per ~3s throttle tick, for the rest of the session: 32,760 events in
 * nine days, 99.3% of them this one caught error. The fix (PR #3392) evicts queries under pressure,
 * retries, and reports at most once per session with a `persisted_cache` context.
 *
 * These tests shrink the free space rather than grow the cache — the QA plan's approach, since the
 * blob takes days to outgrow the quota naturally. Ballast lives in the Playwright context's own
 * localStorage and dies with it; nothing in the product is written.
 *
 * **GDPR:** the cache blob is Article 9 patient data. Sizes and counts are logged, contents never.
 *
 * Out of scope here, and why:
 *  - **W1 (offline mutations survive eviction)** — needs real treatments documented offline under
 *    quota pressure, i.e. writes to production-shaped staging data. `fixme`'d below; the PM took the
 *    22 unit tests in `persistPolicy.test.ts` as the authoritative cover.
 *  - **AC4 (4F back under 50/day) and the Sentry Stats page** — post-deploy monitoring against the
 *    Sentry UI, not a browser assertion. What *is* observable from here — whether ingest is dropping
 *    our categories — is asserted in the AC5 test below.
 *  - **W5 (upgrade path) and A1–A4 (Android)** — a device pass and a two-build sequence.
 *  - **AC6 for production** — `tests/Production/Therapist/sentry_environment.spec.ts`.
 */

/** Free characters left for the persister in the "moderate pressure" case (W2). */
const MODERATE_HEADROOM = 140_000;

test.describe('Offline cache — localStorage quota recovery', () => {
  test(
    'AC1/W2 — under storage pressure the persister evicts and keeps persisting',
    { tag: ['@Therapist', '@OfflineCache', '@QuotaRecovery'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const sentry = new SentryTraffic();
      sentry.attach(page);

      await page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(12_000);
      const baseline = await cacheSnapshot(page);
      console.log(`unconstrained cache: ${JSON.stringify(baseline)}`);
      expect(baseline.chars, 'the board must persist a cache before pressure is applied').toBeGreaterThan(0);

      const resident = await installBallast(page, MODERATE_HEADROOM);
      console.log(`ballast installed: ${resident} chars resident, ~${MODERATE_HEADROOM} free`);

      // Three page loads, each re-running the dashboard queries the ticket blames for the growth.
      let snapshot = baseline;
      for (const path of ['/dashboard', '/therapist/', '/dashboard']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(9_000);
        snapshot = await cacheSnapshot(page);
        console.log(`after ${path}: ${JSON.stringify(snapshot)}`);
      }

      // The AC in one line: it recovers by evicting *and continues persisting successfully*.
      expect(snapshot.chars, 'the cache must still be written under pressure, not abandoned').toBeGreaterThan(0);
      expect(
        snapshot.chars,
        `the persisted blob must fit the ${MODERATE_HEADROOM} characters left free — it wrote ${snapshot.chars}`,
      ).toBeLessThanOrEqual(MODERATE_HEADROOM);
      expect(
        snapshot.chars,
        `eviction must have shrunk the blob below its unconstrained ${baseline.chars} characters`,
      ).toBeLessThan(baseline.chars);
      expect(snapshot.queries ?? 0, 'eviction must leave a usable cache, not an empty one').toBeGreaterThan(0);

      expect(
        await page.locator('#root').innerText(),
        'the board must stay usable while the cache is being evicted',
      ).toContain('Tage seit Beh.');
      expect(
        sentry.quotaErrors().length,
        'a session that recovers by evicting must not report a storage failure at all',
      ).toBe(0);
    },
  );

  test(
    'W3/AC3 — with no room at all the session reports once and stays usable',
    { tag: ['@Therapist', '@OfflineCache', '@QuotaRecovery'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const sentry = new SentryTraffic();
      sentry.attach(page);

      // Ballast before boot, so the session's very first persist already fails.
      await installBallastAtBoot(page);
      await page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(60_000);

      const attempts = await persistAttempts(page);
      console.log(`persist attempts: ${JSON.stringify(attempts)}`);
      expect(
        attempts.length,
        'the persister must retry after a quota failure — a single attempt means it gave up instead ' +
          'of evicting',
      ).toBeGreaterThan(1);
      expect(attempts.every((a) => !a.ok), 'with a full store every attempt is expected to fail').toBe(true);
      // Within one persist round each retry carries less than the one before it, and that shrinking
      // ladder *is* the eviction. A session makes several rounds (a round restarts at full size when
      // the query cache changes again), so the attempts are split on every step back up.
      const ladders: number[][] = [];
      for (const attempt of attempts) {
        const current = ladders[ladders.length - 1];
        if (!current || attempt.chars >= current[current.length - 1]) ladders.push([attempt.chars]);
        else current.push(attempt.chars);
      }
      console.log(`eviction ladders: ${JSON.stringify(ladders)}`);
      expect(
        ladders.some((ladder) => ladder.length > 1),
        `at least one persist round must retry at a smaller size — a round of one attempt means the ` +
          `persister reported and gave up instead of evicting. Rounds: ${JSON.stringify(ladders)}`,
      ).toBe(true);

      const quota = sentry.quotaErrors();
      console.log(`quota events this session: ${quota.length} of ${sentry.errors.length} error events`);
      expect(
        quota.length,
        `a quota-bound session must emit at most one Sentry event — the pre-fix build emitted one per ` +
          `3s throttle tick. Saw ${quota.length} across ${attempts.length} failed writes.`,
      ).toBeLessThanOrEqual(1);

      expect(
        await page.locator('#root').innerText(),
        'persistence is a cache, not a requirement — the app must work with none of it',
      ).toContain('Dashboard');
    },
  );

  test(
    'W3/W4 — the report explains itself and carries no patient data',
    { tag: ['@Therapist', '@OfflineCache', '@QuotaRecovery'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const sentry = new SentryTraffic();
      sentry.attach(page);

      await installBallastAtBoot(page);
      await page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(45_000);

      const quota = sentry.quotaErrors();
      test.skip(
        quota.length === 0,
        'no storage failure was reported this run, so there is no event to inspect — the ballast did ' +
          'not bite (browsers differ on whether the quota counts characters or bytes)',
      );

      const [event] = quota;
      console.log(`event: ${event.type} / context ${JSON.stringify(event.context)}`);
      expect(event.context, 'the event must carry the persisted_cache context the fix adds').not.toBeNull();
      const context = event.context as Record<string, unknown>;
      for (const field of ['bytes', 'queryCount', 'evictedQueries']) {
        expect(context, `persisted_cache must report "${field}" so the next occurrence explains itself`).toHaveProperty(
          field,
        );
      }
      expect(
        Number(context.evictedQueries),
        'the report must show eviction was attempted before it gave up',
      ).toBeGreaterThan(0);
      expect(event.environment, 'staging events must be tagged as staging').toBe('staging');

      // W4 — GDPR. Query keys carry patient ids and filter params; only the resource segment and a
      // byte size may leave the browser. Scanned over the context's STRING values only: `bytes` and
      // the counts are numbers and are meant to be there, so a blanket digit check on the serialized
      // object would flag the fix's own telemetry. The surrounding event body is left out too — it
      // legitimately holds the staging URL and the SDK's redacted breadcrumbs.
      const strings: string[] = [];
      const walk = (value: unknown) => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(context);
      console.log(`persisted_cache string values: ${JSON.stringify(strings)}`);
      for (const value of strings) {
        expect(value, 'no query-key filter params may appear in telemetry').not.toMatch(/filter|pagination|exclude/i);
        expect(value, 'no patient or prescription ids may appear — digits must be masked').not.toMatch(/\d{4,}/);
      }
      const boardNames = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="v2-rail-cell-patient"]')]
          .map((e) => (e.textContent || '').split(/\d/)[0].trim())
          .filter(Boolean)
          .slice(0, 20),
      );
      for (const name of boardNames) {
        for (const value of strings) {
          expect(value, `patient name "${name}" must never reach Sentry`).not.toContain(name);
        }
      }
    },
  );

  test(
    'W3 — the report names its largest cache entries',
    { tag: ['@Therapist', '@OfflineCache', '@QuotaRecovery'] },
    async () => {
      test.fixme(
        true,
        'DEFECT (found 2026-08-18 on staging v3.11.0): the `largest` array in the persisted_cache ' +
          'context arrives at Sentry as ["[Object]", "[Object]"] — the SDK\'s normalizeDepth collapses ' +
          'the {resource, bytes} entries before they are sent, so the per-entry breakdown point 4 of ' +
          'the fix adds ("total bytes, query count, and the top ~10 entries by size") is not readable ' +
          'in the event. bytes / queryCount / evictedQueries do come through. W4 is unaffected — ' +
          'nothing readable means nothing leaked — but W4\'s positive check ("resource values look ' +
          'like prescriptions, activities/bulk, prescriptions/#") cannot be performed at all. Fix by ' +
          'flattening each entry to a string (`prescriptions:12480`) or raising normalizeDepth for ' +
          'this context.',
      );
    },
  );

  test(
    'AC5 — Sentry ingest is not dropping our error events',
    { tag: ['@Therapist', '@OfflineCache', '@QuotaRecovery'] },
    async ({ page }) => {
      test.fixme(
        true,
        'AC5 ANSWERED, AND IT IS THE BAD ANSWER (measured 2026-08-18 from staging). Sentry ingest ' +
          'replies 429 to the app\'s envelopes with two org-scoped rules: ' +
          '"60:default;error;security;attachment:organization:error_usage_exceeded" and ' +
          '"60:transaction;profile;transaction_indexed;span;span_indexed:organization:span_usage_exceeded". ' +
          'Error events are in the first list, so the 13 Aug silence is a suppressed project, not a ' +
          'quiet one, and genuine errors are being discarded alongside the quota noise — exactly the ' +
          'case the ticket says matters more than the noise. AC4 cannot be measured until this is ' +
          'cleared. Un-fixme once the org quota has headroom; the assertion below then guards it.',
      );
      test.setTimeout(300_000);
      const sentry = new SentryTraffic();
      sentry.attach(page);

      await installBallastAtBoot(page);
      await page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(45_000);

      console.log(`ingest replies: ${JSON.stringify(sentry.statuses)}`);
      console.log(`rate-limit headers: ${JSON.stringify(sentry.rateLimits)}`);
      expect(sentry.statuses.length, 'production must be sending envelopes to read a reply from').toBeGreaterThan(0);

      const limited = sentry.limitedCategories();
      console.log(`categories currently rate-limited: ${JSON.stringify(limited)}`);
      expect(
        limited,
        `Sentry is dropping error events — genuine errors are being discarded, not just the noise. ` +
          `Headers seen: ${JSON.stringify(sentry.rateLimits)}`,
      ).not.toContain('error');
    },
  );

  test('W1 — offline-queued mutations survive eviction', { tag: ['@Therapist', '@OfflineCache'] }, async () => {
    test.fixme(
      true,
      'Cannot be exercised read-only. It needs 5–7 treatments documented while offline and under ' +
        'quota pressure, then a tab kill and a replay — real writes against staging patients, and the ' +
        'failure mode under test is silent data loss, so a half-completed run leaves phantom ' +
        'documentation behind. The PM reached the same conclusion on 2026-08-16 and accepted the 10 ' +
        'new unit tests in packages/api-hydra/__tests__/persistPolicy.test.ts (eviction skips entries ' +
        "with state === 'paused') as the authoritative cover for this AC.",
    );
  });
});
