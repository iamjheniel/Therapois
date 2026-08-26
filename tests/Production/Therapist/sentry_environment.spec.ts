import { test, expect } from '@playwright/test';
import { SentryTraffic } from '../../../Pages/util/query-cache';

/**
 * RC 3.11 — #3385 AC6: production web builds must report `environment: production`.
 *
 * The second finding in the ticket: every React Native event is tagged `staging`, including ones
 * whose `url` is `https://app.therapios.de/…`, so the environment tag is unusable as an alert filter
 * and `tracesSampler` applies staging's 1.0 sample rate to production traffic. The fix is commit
 * `01093e047` (`EXPO_PUBLIC_APP_ENV`), which ships with 3.11.
 *
 * Read-only: it reads the tag off the envelopes the app sends by itself, and never provokes an error
 * in production to do it.
 *
 * The test self-activates. While production still serves a pre-3.11 build it skips with the tag it
 * observed (the mislabelling, recorded rather than asserted); once 3.11 is deployed it asserts.
 */
test.describe('Sentry telemetry — production environment tagging', () => {
  test(
    'AC6 — events from app.therapios.de are tagged environment: production',
    { tag: ['@Therapist', '@OfflineCache', '@SentryEnvironment'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const sentry = new SentryTraffic();
      const envelopes: { environment: string | null; release: string | null }[] = [];
      sentry.attach(page);
      // Transactions carry the same trace header as errors, and production sends them unprompted —
      // no need to trigger a real error on the live system to read the tag.
      page.on('request', (request) => {
        if (!/ingest\.[a-z]+\.sentry\.io/.test(request.url())) return;
        try {
          const header = JSON.parse((request.postData() || '').split('\n')[0]);
          envelopes.push({ environment: header?.trace?.environment ?? null, release: header?.trace?.release ?? null });
        } catch {
          /* an envelope without a parseable header tells us nothing about the tag */
        }
      });

      await page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(25_000);

      const appVersion = ((await page.locator('#root').innerText()) || '').match(/v(\d+\.\d+\.\d+)/)?.[1] ?? null;
      console.log(`production build: v${appVersion}; envelopes: ${JSON.stringify(envelopes)}`);
      expect(envelopes.length, 'production must be sending telemetry at all').toBeGreaterThan(0);

      const tags = [...new Set(envelopes.map((e) => e.environment))];
      const [major, minor] = (appVersion ?? '0.0.0').split('.').map(Number);
      test.skip(
        major < 3 || (major === 3 && minor < 11),
        `Production still serves v${appVersion}, which predates the EXPO_PUBLIC_APP_ENV fix ` +
          `(01093e047, RC 3.11). Its events are tagged ${JSON.stringify(tags)} — the mislabelling the ` +
          `ticket describes, still live. This test asserts automatically once 3.11 reaches production.`,
      );

      expect(tags, 'production events must be tagged production, not staging').toEqual(['production']);
      expect(
        [...new Set(envelopes.map((e) => e.release))],
        'the release on the events must match the deployed build',
      ).toEqual([appVersion]);
    },
  );
});
