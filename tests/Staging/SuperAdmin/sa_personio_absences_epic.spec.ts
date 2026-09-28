import { test, expect } from '@playwright/test';
import { AbsencesPage } from '../../../Pages/superadmin/sa.absences.page';

/**
 * RC 3.12 epic #3394 — therapist absences from Personio, across all three boards.
 *
 * **An epic has no ACs of its own.** It has SHARED RULES every sub-ticket must obey (#3395 sync +
 * T Board Kalender, #3396 Therapeuten-Orga, #3397 Management) and one sequencing rule — "E2 owns
 * the [absence-rate] definition, E3 matches it". All three shipped together in `d10e8f075`, and
 * each carries its own PM note claiming near-complete verification. So this file deliberately does
 * NOT re-test the sub-tickets: it tests the rules that cut across them, which is the part no
 * sub-ticket's own ACs cover and no per-board check can catch.
 *
 * **Deployed and consistent.** Measured on staging 2026-09-03: **9,481 absence days over
 * 2026-01-01 … 2027-09-03**, in exactly three buckets (KRANK 3,182 / URLAUB 4,198 / SONSTIGE
 * 2,101). The date range is the epic's history-and-horizon rule to the day — backfilled from
 * 1 January 2026, pulled 12 months ahead of today — with **0 rows on either side of it**.
 *
 * **The formula agrees on three surfaces, and it is reconstructed rather than compared to itself.**
 * For 2026-06-29 … 07-05 the Management card, the Orga trend's bucket for the same week, and a
 * recomputation from `/kpis/management/working-hours` all give krankenquote **0.0983866964507322**
 * and fehlquote **0.21752295855050882** — 23,784 Krank + 28,800 Urlaub minutes over 241,740 Soll.
 * `sonstigeAbwesenheitMinutes` (12,396) is reported separately and excluded from Fehlquote, exactly
 * as the epic requires.
 *
 * **Traps**
 * - **The route is `/absence-days`, not `/absence_days`** — the entity sets an explicit
 *   `uriTemplate`, so the snake_case form every other collection uses answers 404.
 * - The collection filters only by `user`; there is no date filter, so a window means walking all
 *   ~9.5k rows.
 * - **`/kpis/management/orga-trend` ignores `rangeFrom`** and always returns 12 trailing periods,
 *   so pick the bucket you want by date rather than expecting a tiled range (see the finding).
 * - Absence quotas are ratios in 0..1, not percentages.
 */

/** A week with dense absence data on staging; also #3398's fixture week, so the two files align. */
const WEEK = { from: '2026-06-29', to: '2026-07-05' };

/** Measured 2026-09-03. Asserted as bounds and identities, not as frozen totals. */
const EXPECTED = { minRows: 5_000, backfillFrom: '2026-01-01' };

test.describe('Personio absences across the boards (#3394)', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  let auth: string;
  let absences: AbsencesPage;
  let days: AbsencesPage['absenceDays'] extends () => Promise<infer T> ? T : never;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(900_000);
    const response = await request.post(`${AbsencesPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
      timeout: 120_000,
    });
    expect(response.status(), 'POST /auth').toBe(200);
    auth = (await response.json()).token;
    days = await new AbsencesPage(request, auth).absenceDays();
    expect(days.length, 'the sync must have produced absence days').toBeGreaterThan(EXPECTED.minRows);
  });

  test.beforeEach(async ({ request }) => {
    absences = new AbsencesPage(request, auth);
  });

  // ───────────────────── shared rule: history and horizon ─────────────────────

  test(
    'absences are backfilled from 2026-01-01 and pulled 12 months ahead, and nothing outside',
    { tag: ['@SuperAdmin', '@PersonioAbsences', '@ReadOnly'] },
    async () => {
      const dates = days.map((d) => d.date).sort();
      const earliest = dates[0];
      const latest = dates[dates.length - 1];

      // "12 months ahead" is relative to the run, so the bound is computed, not pinned.
      const horizon = new Date();
      horizon.setFullYear(horizon.getFullYear() + 1);
      const horizonDate = horizon.toISOString().slice(0, 10);

      console.log(`  ${days.length} absence days, ${earliest} .. ${latest} (horizon ${horizonDate})`);
      const early = days.filter((d) => d.date < EXPECTED.backfillFrom);
      const late = days.filter((d) => d.date > horizonDate);
      console.log(`  before the backfill start: ${early.length}; beyond the horizon: ${late.length}`);

      expect(early, 'nothing predates the 1 January 2026 backfill start').toEqual([]);
      expect(late, 'and nothing is pulled beyond 12 months ahead').toEqual([]);
      // Both ends must actually be populated, or the bounds above are vacuously true.
      expect(earliest, 'the backfill reaches its start').toBe(EXPECTED.backfillFrom);
      expect(latest > new Date().toISOString().slice(0, 10), 'and planned future absences are present').toBe(true);
    },
  );

  // ────────────────────────── shared rule: categories ─────────────────────────

  test(
    'every absence falls in exactly one of the three defined buckets',
    { tag: ['@SuperAdmin', '@PersonioAbsences', '@ReadOnly'] },
    async () => {
      const byBucket = days.reduce<Record<string, number>>((acc, day) => {
        acc[day.bucket] = (acc[day.bucket] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  buckets: ${JSON.stringify(byBucket)}`);

      const namesByBucket = new Map<string, Set<string>>();
      for (const day of days) {
        if (!namesByBucket.has(day.bucket)) namesByBucket.set(day.bucket, new Set());
        namesByBucket.get(day.bucket)!.add(day.typeName);
      }
      for (const [bucket, names] of namesByBucket) console.log(`    ${bucket}: ${[...names].join(' | ')}`);

      expect(Object.keys(byBucket).sort(), 'only the epic\'s three categories exist').toEqual(
        [...AbsencesPage.BUCKETS].sort(),
      );
      for (const bucket of AbsencesPage.BUCKETS) {
        expect(byBucket[bucket], `${bucket} must be populated`).toBeGreaterThan(0);
      }
      // Home Office is a working day, not an absence — it must never have been bucketed at all.
      const homeOffice = days.filter((d) => /home\s*office|offsite/i.test(d.typeName));
      expect(homeOffice, 'Home Office is excluded from the sync').toEqual([]);
    },
  );

  // ───────────────────── shared rule: the absence-rate formula ────────────────

  test(
    'Fehlquote is Krank + Urlaub over Soll, with Sonstige reported separately',
    { tag: ['@SuperAdmin', '@PersonioAbsences', '@ReadOnly'] },
    async () => {
      const quotas = await absences.managementQuotas(WEEK.from, WEEK.to);
      const rows = await absences.workingHours(WEEK.from, WEEK.to);
      expect(rows.length, 'therapist rows must be present').toBeGreaterThan(10);

      const krank = AbsencesPage.sum(rows, 'krankMinutes');
      const urlaub = AbsencesPage.sum(rows, 'urlaubMinutes');
      const sonstige = AbsencesPage.sum(rows, 'sonstigeAbwesenheitMinutes');
      const soll = AbsencesPage.sum(rows, 'sollMinutes');
      expect(soll, 'target minutes must be non-zero for a ratio to mean anything').toBeGreaterThan(0);

      console.log(
        `  ${WEEK.from}..${WEEK.to}: Krank ${krank}, Urlaub ${urlaub}, Sonstige ${sonstige}, Soll ${soll}`,
      );
      console.log(
        `  served: krankenquote ${quotas.krankenquote}, urlaubsquote ${quotas.urlaubsquote}, fehlquote ${quotas.fehlquote}`,
      );

      // Reconstructed from the minutes rather than compared against the board's own ratio.
      expect(quotas.krankenquote!, 'krankenquote is Krank ÷ Soll').toBeCloseTo(krank / soll, 10);
      expect(quotas.urlaubsquote!, 'urlaubsquote is Urlaub ÷ Soll').toBeCloseTo(urlaub / soll, 10);
      expect(quotas.fehlquote!, 'fehlquote is (Krank + Urlaub) ÷ Soll').toBeCloseTo((krank + urlaub) / soll, 10);
      // The identity the DTO states outright — and the reason Sonstige has its own field.
      expect(quotas.fehlquote!, 'so fehlquote is exactly krankenquote + urlaubsquote').toBeCloseTo(
        quotas.krankenquote! + quotas.urlaubsquote!,
        10,
      );
      expect(quotas.sonstigeAbwesenheitMinutes!, 'Sonstige is carried as minutes, not folded in').toBeCloseTo(
        sonstige,
        6,
      );
      expect(sonstige, 'and it is non-zero here, so its exclusion is actually exercised').toBeGreaterThan(0);
    },
  );

  test(
    'E2 and E3 report the same absence rates for the same week — the epic\'s sequencing rule',
    { tag: ['@SuperAdmin', '@PersonioAbsences', '@ReadOnly'] },
    async () => {
      const management = await absences.managementQuotas(WEEK.from, WEEK.to);
      const trend = await absences.orgaTrend('woche', WEEK.to);
      const bucket = trend.find((period) => period.periodStart === WEEK.from && period.periodEnd === WEEK.to);
      expect(bucket, `the Orga trend must carry a bucket for ${WEEK.from}..${WEEK.to}`).toBeTruthy();

      console.log(`  Management card: krankenquote ${management.krankenquote}, fehlquote ${management.fehlquote}`);
      console.log(`  Orga trend      : krankenquote ${bucket!.krankenquote}, fehlquote ${bucket!.fehlquote}`);

      // "E2 owns the definition, E3 matches it" — asserted to full precision, because the two are
      // computed by different providers and a shared formula should leave no daylight.
      expect(bucket!.krankenquote!, 'the two boards must agree on Krankenquote').toBeCloseTo(
        management.krankenquote!,
        12,
      );
      expect(bucket!.fehlquote!, 'and on Fehlquote').toBeCloseTo(management.fehlquote!, 12);
    },
  );

  // ────────────────────────────── route shape ────────────────────────────────

  test(
    'the absence collection is served at /absence-days and is filterable by user only',
    { tag: ['@SuperAdmin', '@PersonioAbsences', '@ReadOnly'] },
    async () => {
      // Worth pinning: every other collection in this API is snake_case, and the 404 that the
      // snake_case form returns here reads exactly like "the feature is not deployed".
      expect(await absences.status('/absence_days?page=1&itemsPerPage=1'), 'the snake_case form is not the route').toBe(
        404,
      );
      expect(await absences.status('/absence-days?page=1&itemsPerPage=1'), 'the kebab-case one is').toBe(200);
    },
  );

  // ─────────────────────────────── findings ──────────────────────────────────
});
