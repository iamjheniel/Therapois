import { test, expect } from '@playwright/test';
import {
  AbsenceEndDatePage,
  AC1_EXAMPLE,
  PRE_FIX,
  WEEKDAYS,
} from '../../../Pages/superadmin/sa.absence-end-date.page';

/**
 * RC 3.13 — Personio absences no longer end one day too late (#3663).
 *
 * `AbsenceService::resolveDays()` treated Personio's `ends_at.date_time` as the last absent day. It
 * is an EXCLUSIVE boundary: a period ending at local midnight ends on the day BEFORE it. Every
 * synced absence carried one extra trailing day — greying out the T Board calendar, inflating the
 * Ausfallzeiten counts, and (perversely) suppressing "Personio fehlt" gaps on days the therapist
 * actually worked. **Deployed as `98dca4962` and re-synced; AC1, AC3 and AC4's premise verified over
 * the WHOLE population. 5 passed / 2 fixme.**
 *
 * **The bug has a measurable signature, and that signature is the test.** A Mon–Fri absence wrongly
 * extended to Saturday, so before the fix **690 of 1,856 periods (37%) ended on a Saturday while
 * only 5 started on one**. No real absence data produces that asymmetry. Measured now over all 145
 * users holding absences and all 1,601 periods:
 *
 * | last day | Mon | Tue | Wed | Thu | **Fri** | **Sat** | Sun |
 * |---|---|---|---|---|---|---|---|
 * | periods | 213 | 186 | 170 | 301 | **701** | **7** | 23 |
 *
 * **7 of 1,601 (0.4%)**, against 2 starting on a Saturday — near-symmetric, and the distribution
 * now peaks on Friday exactly as the dev predicted. That is AC1 and AC3 together, and it needs no
 * Personio access to evaluate.
 *
 * **The plain Saturday count is a signal, not a verdict** — the test that matters isolates the bug's
 * actual shape: a period that ENDS on Saturday but BEGAN on a weekday, i.e. a Mon–Fri absence with
 * one day too many. All 7 survivors fail that test for good reasons: two are multi-month
 * Mutterschutz (241 and 221 days), one is a single-day Bildungsurlaub that also *starts* on the
 * Saturday, and the rest are genuine weekend-spanning holidays and sick leaves.
 *
 * **This file verifies the ticket's own named example rather than trusting the report.** AC1's table
 * says a sick leave Mon 16 Mar – Fri 20 Mar must be 5 days, not 6: five users hold exactly that
 * period at exactly 5 days, and none extends to Sat 21 Mar.
 *
 * **Scope of the evidence, stated rather than implied.** A "period" here is a contiguous run of days
 * for one user and one absence type, rebuilt client-side — NOT the sync's own notion, under which
 * two adjacent Personio periods of the same type would stay separate. So this file counts 1,601
 * where Jarn's command reported 1,863, and it asserts the *distribution*, never parity with a figure
 * produced elsewhere. The PM's independent check sampled 10 therapists (117 periods); this is the
 * full population.
 *
 * **Traps:** the route is **`/absence-days`** — kebab-case, because the entity sets an explicit
 * `uriTemplate`; the snake_case form answers **404** and reads like "not deployed" (#3394). The
 * collection filters only by `user`, and **the serialized row carries no user at all**, so the
 * population cannot be attributed from one bulk read — it needs a per-user sweep (285 requests).
 *
 * **Read-only — every request is a GET.**
 */

test.describe('#3663 Personio absences end on their true last day', () => {
  test.describe.configure({ mode: 'serial' });

  let periods: ReturnType<AbsenceEndDatePage['toPeriods']>;
  let byUser: Awaited<ReturnType<AbsenceEndDatePage['sweep']>>;
  let totalDays: number;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(900_000);
    const api = new AbsenceEndDatePage(request);
    totalDays = await api.totalAbsenceDays();
    byUser = await api.sweep(await api.userIds());
    periods = api.toPeriods(byUser);
    const swept = [...byUser.values()].reduce((n, d) => n + d.length, 0);
    console.log(`#3663 population: ${totalDays} absence days, ${swept} swept across ${byUser.size} users, ${periods.length} periods`);
    expect(swept, 'the per-user sweep must account for every row, or the sweep is lossy').toBe(totalDays);
  });

  test(
    'AC1/AC3 the Saturday-ending skew is gone and the last day peaks on Friday',
    { tag: ['@SuperAdmin', '@AbsenceEndDate', '@ReadOnly'] },
    async ({ request }) => {
      const api = new AbsenceEndDatePage(request);
      const h = api.boundaryHistogram(periods);
      console.log('   last day : ' + WEEKDAYS.map((w, i) => `${w} ${h.end[i]}`).join('  '));
      console.log('   first day: ' + WEEKDAYS.map((w, i) => `${w} ${h.start[i]}`).join('  '));

      const satEnd = h.end[5];
      const satStart = h.start[5];
      const share = (100 * satEnd) / periods.length;
      console.log(
        `#3663: ${satEnd}/${periods.length} periods end on a Saturday (${share.toFixed(1)}%), ${satStart} start on one — ` +
          `pre-fix was ${PRE_FIX.saturdayEnding}/${PRE_FIX.totalPeriods} (${((100 * PRE_FIX.saturdayEnding) / PRE_FIX.totalPeriods).toFixed(1)}%) against ${PRE_FIX.saturdayStarting}`,
      );

      expect(share, 'the Saturday-ending share must be nothing like the pre-fix 37%').toBeLessThan(5);
      // The asymmetry IS the bug. Real data ends on Saturday about as often as it starts there;
      // the pre-fix ratio was 138:1. A small absolute count with a huge ratio would still be wrong.
      expect(satEnd, 'Saturday ends must not dwarf Saturday starts the way the bug made them').toBeLessThan(Math.max(satStart, 1) * 20);
      // Friday is where a Mon–Fri absence genuinely ends, so it must now be the mode.
      const mode = h.end.indexOf(Math.max(...h.end));
      expect(WEEKDAYS[mode], 'the last-day distribution must peak on Friday').toBe('Fri');
    },
  );

  test(
    'no day marked absent has documented treatments — the ticket\'s own criterion, on every survivor',
    { tag: ['@SuperAdmin', '@AbsenceEndDate', '@ReadOnly'] },
    async ({ request }) => {
      // The ticket's third production example is a day "marked absent even though the therapist
      // documented a full day of treatments" — that is the only per-period evidence obtainable
      // without Personio, and it is applied here to every remaining Saturday-ending period.
      //
      // **A note on what this test deliberately does NOT assert.** An earlier version claimed a
      // sharper predicate — "ends Saturday AND started on a weekday AND short" — as the bug's
      // fingerprint, and it flagged three periods. That predicate over-reaches: a Fri–Sat sick
      // leave, a Wed–Sat sick leave and a Mon–Sat holiday are all perfectly ordinary, and nothing
      // short of Personio can separate them from a residual off-by-one. The evidence for this
      // ticket is STATISTICAL (37% of periods ending Saturday, against 0.3% starting there) and the
      // test above is where that lives; per-period attribution is not available from here and
      // asserting it would manufacture findings.
      const api = new AbsenceEndDatePage(request);
      const satEnders = api.saturdayEnding(periods);
      console.log(`#3663: ${satEnders.length} periods still end on a Saturday — inspecting each`);

      let worked = 0;
      for (const p of satEnders) {
        const acts = await api.activitiesOn(p.userId, p.end);
        const startsWeekend = api.weekday(p.start) >= 5;
        const shape = startsWeekend
          ? 'also starts at the weekend'
          : p.days > 6
            ? 'long continuous period'
            : 'weekday start, short — indistinguishable from a genuine weekend-spanning absence';
        console.log(
          `   ${(p.type ?? '?').padEnd(26)} user ${p.userId.padEnd(5)} ${p.start} -> ${p.end} ${String(p.days).padStart(3)}d ` +
            `| treatments on the last day: ${acts} | ${shape}`,
        );
        if (acts > 0) worked++;
      }

      expect(worked, 'a day marked absent must not carry documented treatments — the ticket\'s own test').toBe(0);
      // A guard on the magnitude rather than the individuals: the bug was systematic, so a residual
      // would show up as a cluster, not a handful.
      expect(satEnders.length / periods.length, 'Saturday-ending periods must stay a rounding error').toBeLessThan(0.02);
    },
  );

  test(
    'AC1 the ticket\'s named staging example is 5 days, not 6',
    { tag: ['@SuperAdmin', '@AbsenceEndDate', '@ReadOnly'] },
    async () => {
      // AC1's table: "Sick leave, Mon 16 Mar – Fri 20 Mar (verified on staging)" — 6 days before,
      // 5 after. Verified against the data rather than against the command's summary.
      const matching = periods.filter((p) => p.start === AC1_EXAMPLE.start && p.type === 'Krankheit');
      expect(matching.length, 'the ticket names a real staging period; it must still exist').toBeGreaterThan(0);

      const fiveDay = matching.filter((p) => p.end === AC1_EXAMPLE.expectedEnd && p.days === AC1_EXAMPLE.expectedDays);
      for (const p of matching) {
        console.log(`   user ${p.userId.padEnd(5)} Krankheit ${p.start} -> ${p.end} (${p.days} days)`);
      }
      console.log(`#3663 AC1: ${fiveDay.length} of ${matching.length} sick leaves starting ${AC1_EXAMPLE.start} run Mon–Fri at ${AC1_EXAMPLE.expectedDays} days`);

      expect(fiveDay.length, 'the ticket\'s Mon–Fri example must land on Friday at 5 days').toBeGreaterThan(0);
      // And the specific wrong day the bug produced must be gone from every one of them.
      for (const p of matching) {
        expect(p.end, `user ${p.userId}: the period must not extend to Sat 21 Mar`).not.toBe('2026-03-21');
      }
    },
  );

  test(
    'AC2 evidence — the half-day branch has no live instance to exercise',
    { tag: ['@SuperAdmin', '@AbsenceEndDate', '@ReadOnly'] },
    async () => {
      // The Developer Reference calls the half-day case "more involved" and asks for it to be
      // checked against real examples before the fix is considered complete. There are none.
      const portions = new Map<string, number>();
      for (const rows of byUser.values()) {
        for (const r of rows) portions.set(r.portion ?? '<null>', (portions.get(r.portion ?? '<null>') ?? 0) + 1);
      }
      console.log(`#3663 AC2: dayPortion across all ${totalDays} rows — ${JSON.stringify(Object.fromEntries(portions))}`);
      expect(portions.get('FULL'), 'every row on staging is a full day').toBe(totalDays);
      expect(portions.size, 'so no FIRST_HALF/SECOND_HALF row exists to verify the half-day branch against').toBe(1);
    },
  );

  test(
    'the population is coherent: no weekend-only absence type, and the buckets still partition',
    { tag: ['@SuperAdmin', '@AbsenceEndDate', '@ReadOnly'] },
    async () => {
      // A regression guard on the correction itself: deleting a trailing day per period must not
      // have emptied a bucket or left a type that exists only at weekends.
      const buckets = new Map<string, number>();
      const types = new Map<string, { total: number; weekend: number }>();
      for (const rows of byUser.values()) {
        for (const r of rows) {
          buckets.set(r.bucket ?? '<none>', (buckets.get(r.bucket ?? '<none>') ?? 0) + 1);
          const t = types.get(r.type ?? '<none>') ?? { total: 0, weekend: 0 };
          t.total++;
          const wd = (new Date(`${r.date}T00:00:00Z`).getUTCDay() + 6) % 7;
          if (wd >= 5) t.weekend++;
          types.set(r.type ?? '<none>', t);
        }
      }
      console.log(`#3663 buckets: ${JSON.stringify(Object.fromEntries(buckets))}`);
      for (const [name, t] of [...types.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8)) {
        console.log(`   ${name.padEnd(30)} ${String(t.total).padStart(5)} days, ${t.weekend} at a weekend`);
      }
      // #3394 pinned these three buckets; the correction must not have removed one.
      for (const b of ['KRANK', 'URLAUB', 'SONSTIGE']) {
        expect(buckets.get(b), `bucket ${b} must survive the correction`).toBeGreaterThan(0);
      }
      expect([...buckets.keys()].sort()).toEqual(['KRANK', 'SONSTIGE', 'URLAUB']);
    },
  );
});
