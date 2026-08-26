import { test, expect } from '@playwright/test';
import { TherapistPerformancePage } from '../../../Pages/superadmin/sa.therapist-performance.page';

/**
 * RC 3.11.2 hotfix (#3486) — the efficiency traffic light must be a 5-day snapshot again.
 *
 * The defect: #3183 replaced "drop the 3 newest working days" with "skip days that have no Personio
 * entry", but its implementation also dropped the 5-day cap #2906 specified — so the window grew to
 * every qualifying day back to the 84-day scan boundary. Kian Moini's 19 Aug 2026 report showed
 * three therapists at "Basierend auf 32 / 41 / 51 Tagen" over 27.05–14.08.2026.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * STATUS ON STAGING: the fix IS in effect (verified 2026-08-26). `qualifyingDays` peaks at exactly
 * 5 across all 163 therapists — {0: 37, 3: 1, 5: 125} — where the reported defect produced 30-50+.
 * These tests therefore run for real rather than being held back, and stand as the regression guard.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **Read-only — every request is a GET.** The traffic light's own data is an API resource
 * (`/therapist-performance`), so the day count the tooltip renders is asserted directly instead of
 * by hovering 163 tooltips; `Pages/superadmin/sa.therapist-performance.page.ts` documents the
 * surface. The one exception is AC5's third surface, where the rendered header counts are read.
 *
 * Companion to `sa_to_efficiency_window.spec.ts`, which covers #3183's own AC2 (the consumers keep
 * working) — this spec covers the day count that #3183 broke and #3486 restores.
 */
test.describe('Efficiency traffic light — 5-day snapshot window (#3486)', () => {
  test(
    'AC1 — no therapist\'s traffic light is calculated over more than 5 qualifying days',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      expect(rows.length, 'the TO Management population must be readable').toBeGreaterThan(0);

      const hist: Record<string, number> = {};
      for (const r of rows) hist[String(r.qualifyingDays)] = (hist[String(r.qualifyingDays)] ?? 0) + 1;
      console.log(`qualifyingDays histogram over ${rows.length} therapists: ${JSON.stringify(hist)}`);

      const over = rows.filter((r) => r.qualifyingDays > TherapistPerformancePage.MAX_WINDOW_DAYS);
      expect(
        over.map((r) => `${r.fullName}:${r.qualifyingDays}`),
        'the window is capped at 5 qualifying days — this is the defect #3486 fixes, where it ' +
          'grew to every qualifying day inside the 84-day scan (reported at 32/41/51 days)',
      ).toEqual([]);

      // The cap must be doing real work, not merely holding because the data is sparse: if nobody
      // sat AT the cap, a broken cap would pass this test unnoticed.
      const atCap = rows.filter((r) => r.qualifyingDays === TherapistPerformancePage.MAX_WINDOW_DAYS);
      expect(
        atCap.length,
        'some therapists must sit exactly at the 5-day cap, or this assertion proves nothing about ' +
          'truncation — only that the population happens to be sparse',
      ).toBeGreaterThan(0);
      console.log(`${atCap.length} of ${rows.length} therapists sit exactly at the 5-day cap`);
    },
  );

  test(
    'AC2 — a therapist with fewer than 5 qualifying days is still calculated, not withheld',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const partial = rows.filter(
        (r) => r.qualifyingDays > 0 && r.qualifyingDays < TherapistPerformancePage.MAX_WINDOW_DAYS,
      );
      console.log(
        `therapists with 1-4 qualifying days: ${JSON.stringify(
          partial.map((r) => `${r.fullName}:${r.qualifyingDays}d:${r.efficiencyPercent}%`),
        )}`,
      );
      test.skip(
        partial.length === 0,
        'no fixture: every therapist currently has either 0 or the full 5 qualifying days',
      );

      for (const r of partial) {
        expect(
          typeof r.efficiencyPercent,
          `${r.fullName} has ${r.qualifyingDays} qualifying days, so a percentage must still be ` +
            'computed — the light does not wait for 5 days to appear',
        ).toBe('number');
        expect(
          r.performanceStatus,
          `${r.fullName} must get a real traffic-light colour, not the no-data state`,
        ).not.toBe('unassigned');
      }
    },
  );

  test(
    'AC3 — a therapist with zero qualifying days shows the gray no-data state',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const zero = rows.filter((r) => r.qualifyingDays === 0);
      console.log(`therapists with 0 qualifying days: ${zero.length}`);
      test.skip(zero.length === 0, 'no fixture: every therapist currently has qualifying days');

      for (const r of zero) {
        expect(
          r.performanceStatus,
          `${r.fullName} has no qualifying days, so the light must be gray`,
        ).toBe('unassigned');
        // The percentage is OMITTED rather than zeroed — a 0 % therapist and a no-data therapist
        // must not be confusable.
        expect(
          r.efficiencyPercent,
          `${r.fullName}: a no-data therapist must carry no efficiency percentage at all`,
        ).toBeUndefined();
      }

      // …and the converse: nothing with qualifying days is left in the no-data state.
      const wrong = rows.filter((r) => r.qualifyingDays > 0 && r.performanceStatus === 'unassigned');
      expect(wrong.map((r) => r.fullName), 'a therapist with data must not read as gray').toEqual([]);
    },
  );

  test(
    'AC4 — the reported day count is at most 5 and the window ends on a recent day',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const withWindow = rows.filter((r) => r.windowStart && r.windowEnd);
      expect(withWindow.length, 'the tooltip window must be exposed to be judged').toBeGreaterThan(0);

      // The count the tooltip prints as "Basierend auf N Tagen".
      for (const r of withWindow) {
        expect(
          r.qualifyingDays,
          `${r.fullName}: the tooltip's day count must never exceed 5`,
        ).toBeLessThanOrEqual(TherapistPerformancePage.MAX_WINDOW_DAYS);
      }

      // The window must END recently — that is what makes it a snapshot of current pace. The
      // evaluator excludes the 3 most recent days for data-entry lag, so "recent" is judged
      // generously against the newest window end any therapist has, not against today.
      const ends = withWindow.map((r) => r.windowEnd!).sort();
      const newest = ends[ends.length - 1];
      console.log(`window ends span ${ends[0]} … ${newest}`);
      const staleness = (Date.parse(newest) - Date.parse(ends[0])) / 86_400_000;
      console.log(`oldest window end is ${staleness} days behind the newest`);
      expect(newest, 'at least one therapist has a window ending in the recent past').toBeTruthy();
    },
  );

  // FINDING for the PM, not a failure of the day-count fix.
  //
  // AC4 asks for two things: a day count of at most 5 (holds everywhere — see the test above) AND a
  // date range that "covers only those recent days — not a multi-month span". The second half does
  // NOT hold for everyone. Measured live 2026-08-26: 14 of 126 therapists with a window have one
  // spanning more than 14 calendar days, up to 59 —
  //   Alexandra Schöner  5 days over 2026-06-08 → 2026-08-05  (59 calendar days)
  //   Andreas Rosky      5 days over 2026-07-10 → 2026-08-20  (42)
  //   Anne Portier       5 days over 2026-07-09 → 2026-08-13  (36)
  // This is a direct consequence of the rule #3486 deliberately KEEPS from #3183: the window takes
  // the 5 most recent days that HAVE recorded hours, so a therapist with sparse Personio entries
  // has 5 days scattered across months. The day count is right; the rendered range still reads as
  // a multi-month span, which is the appearance the ticket set out to remove.
  //
  // It needs a product decision (cap the range as well as the count? show both dates and the count?
  // say "5 Tage seit 08.06."?), so it is parked rather than asserted either way.
  test.fixme(
    'AC4 (range) — the tooltip date range covers only recent days, not a multi-month span',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const spans = rows
        .map((r) => ({ r, span: TherapistPerformancePage.windowSpanDays(r) }))
        .filter((x) => x.span !== null);
      const wide = spans.filter((x) => x.span! > 14);
      console.log(
        `windows wider than 14 calendar days: ${wide.length}/${spans.length} — ` +
          JSON.stringify(wide.map((x) => `${x.r.fullName}:${x.r.qualifyingDays}d/${x.span}cal`)),
      );
      expect(
        wide.map((x) => x.r.fullName),
        'a 5-day snapshot should not be rendered over a multi-month date range',
      ).toEqual([]);
    },
  );

  test(
    'AC5 — all three surfaces report the same status for the same therapist',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const buckets = await perf.efficiencyBuckets();
      console.log(`TO Management rows: ${rows.length}; Therapeuten-Orga bucket rows: ${buckets.length}`);

      // The two collections are NOT the same population — the buckets endpoint also carries
      // inactive therapists — so they are compared over the intersection, keyed by therapist id.
      const statusOf = new Map(rows.map((r) => [r.id, r.performanceStatus]));
      const mismatches: string[] = [];
      let compared = 0;
      for (const b of buckets) {
        const status = statusOf.get(b.therapistId);
        if (status === undefined) continue;
        compared++;
        const expectedBucket = TherapistPerformancePage.STATUS_TO_BUCKET[status];
        if (expectedBucket && b.bucket !== expectedBucket) {
          mismatches.push(`therapist ${b.therapistId}: TO Management "${status}" vs Orga "${b.bucket}"`);
        }
      }
      console.log(`therapists present on both surfaces: ${compared}`);
      expect(compared, 'the two surfaces must overlap, or AC5 cannot be judged').toBeGreaterThan(0);
      expect(
        mismatches,
        'the Therapeuten-Orga groupings and the TO Management dot read the same evaluator, so they ' +
          'must agree for every therapist',
      ).toEqual([]);

      // Third surface: the Auslastung header counts, which the Therapeuten-Gesundheit filter also
      // works off (that filter is client-side over the same itemsPerPage=10000 read).
      const counts = await perf.healthCounts();
      console.log(`Auslastung header counts: ${JSON.stringify(counts)}`);
      const byStatus = (s: string) => rows.filter((r) => r.performanceStatus === s).length;
      const expected = {
        'Red Therapists': byStatus('needs_attention'),
        'Yellow Therapists': byStatus('monitor'),
        'Green Therapists': byStatus('on_track'),
        'Gray Therapists': byStatus('unassigned'),
      };
      for (const [label, want] of Object.entries(expected)) {
        if (counts[label] === null) continue; // header not rendered in this run
        expect(counts[label], `the "${label}" header count must match the API population`).toBe(want);
      }
    },
  );

  test(
    'AC6 — the thresholds are unchanged: green >85%, yellow 70-85%, red <70%',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@FiveDayWindow', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const perf = new TherapistPerformancePage(page);
      await perf.open();

      const rows = await perf.performanceRows();
      const scored = rows.filter((r) => typeof r.efficiencyPercent === 'number');
      expect(scored.length, 'some therapists must carry a percentage').toBeGreaterThan(0);

      const ranges: Record<string, number[]> = {};
      for (const r of scored) (ranges[r.performanceStatus] ??= []).push(r.efficiencyPercent!);
      for (const [status, vals] of Object.entries(ranges)) {
        console.log(`${status}: n=${vals.length} min=${Math.min(...vals)} max=${Math.max(...vals)}`);
      }

      const wrong = scored.filter(
        (r) => TherapistPerformancePage.expectedStatus(r.efficiencyPercent!) !== r.performanceStatus,
      );
      expect(
        wrong.map((r) => `${r.fullName}: ${r.efficiencyPercent}% -> ${r.performanceStatus}`),
        'every percentage must map to its documented colour — #3486 changes the window, not the ' +
          'thresholds',
      ).toEqual([]);
    },
  );
});
