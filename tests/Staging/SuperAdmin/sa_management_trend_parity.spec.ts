import { test, expect } from '@playwright/test';
import { TrendParityPage, TrendLevel } from '../../../Pages/superadmin/sa.trend-parity.page';

/**
 * RC 3.12 (#3398) — the Management board's KPI cards, Verlauf chart and Detail table must report
 * the same revenue for the same filters and period.
 *
 * **Deployed on both halves, and every AC that can be reached from a client passes.** The API half
 * is in `d10e8f075` (2026-08-19, `release/3.12.0`), the client half is in the served bundle:
 * `...l&&'zeitraum'===M&&{rangeFrom:o.from}` in `buildManagementFilter`, plus the trend hook's
 * Zeitraum branch. **Looking for a `task/3398` branch or a commit mentioning the number finds
 * nothing** — it rode in with the Personio absence work under a `Ref #3398` trailer.
 *
 * **The fix is not the one the ticket's Developer Reference describes, and that matters for how it
 * is tested.** That reference blamed the therapist POPULATION (cards resolve it over the single
 * period, the trend over the whole 12-period span) and proposed unifying them. What shipped leaves
 * that asymmetry alone and changes the WINDOW: in Zeitraum mode the board sends `rangeFrom` and the
 * series tiles `[rangeFrom..to]` instead of trailing 12 periods back from `to`. Before it, a card
 * totalling a custom range was being compared against a chart showing 12 full periods ending at
 * that range's end — two different windows. A test written to the reference's theory would have
 * been looking in the wrong place.
 *
 * **The population asymmetry is still observable, and it is harmless — measured, not assumed.**
 * The boundary test below moves a therapist's only activity to 00:00 Berlin and watches them
 * appear in the PREVIOUS day's detail table with revenue **0** (the population resolver widens to
 * whole UTC calendar days) while every card and trend total stays exactly where it was. The
 * revenue math converts the range properly, so a wider population adds rows worth nothing.
 *
 * **AC2 has no natural fixture on staging and is manufactured.** Every activity in the window is
 * stamped `00:00:00Z` or `10:00:00Z` — 02:00 or 12:00 Berlin — so no boundary-timestamped session
 * exists to observe. The test moves one (`PATCH /activities/{id}` with `date`, restored in a
 * `finally`); `KpiCacheInvalidationListener` watches `Activity`, so the KPI caches drop on the
 * write and the reads that follow are fresh rather than 5 minutes stale.
 *
 * **The PM note on the ticket verifies something else.** Its AC1 evidence compares the KPI card
 * against the **Umsatz-Realisierung** waterfall's "Erarbeitet" step — but those two are equal by
 * construction (#3177 asserts exactly that), so the check cannot fail. The ticket is about the
 * **Verlauf** chart, which the note never reads.
 *
 * **Traps**
 * - **Periode mode is not a mismatch.** Without `rangeFrom` the trend legitimately describes a
 *   different window from a card over a custom range; summing those buckets and comparing reports
 *   a bug that does not exist. Compare per-period, or compare a Zeitraum series against a card for
 *   the same range.
 * - `revenuePerHour` is **null** from the trend and **0** from the cards on some zero-revenue
 *   periods; null-coalesce or every empty day reads as a mismatch.
 * - KPI reads are cached 5 minutes (#3401) and the Monat trend is the slowest request on the board
 *   (~27 s, occasionally 504) — run this file at `--workers=1` and give it room.
 * - The CSV export, which #3398 also touched, answers **403** for anyone outside the Kian/Dennis
 *   allowlist (#3181), so its half of the fix is unreachable here.
 */

/** Windows with production-scale data on staging; the empty late-August days prove nothing. */
const RANGES: { from: string; to: string; level: TrendLevel; label: string }[] = [
  { from: '2026-06-15', to: '2026-07-01', level: 'woche', label: 'the ticket-report range, weekly' },
  { from: '2026-06-15', to: '2026-07-01', level: 'tag', label: 'the same range, daily' },
  { from: '2026-05-01', to: '2026-07-31', level: 'monat', label: 'three months' },
  { from: '2026-06-29', to: '2026-07-05', level: 'tag', label: 'one ISO week, daily' },
];

/** AC1 anchors — 12 trailing periods each, at every granularity the board offers. */
const PERIODE_ANCHORS: { level: TrendLevel; to: string }[] = [
  { level: 'tag', to: '2026-07-01' },
  { level: 'woche', to: '2026-07-01' },
  { level: 'monat', to: '2026-07-31' },
];

/** AC4's sample: a week start (Mon), a week end (Sun), a month start, a month end, a mid-period day. */
const AC4_DAYS = ['2026-06-29', '2026-07-05', '2026-07-01', '2026-06-30', '2026-07-15'];

/**
 * AC2's manufactured fixture: on 2026-06-30 this therapist documented exactly ONE countable
 * activity, so moving it to a Berlin day edge moves their whole contribution with it.
 */
const BOUNDARY = {
  activityId: 272303,
  therapistId: 268,
  therapistName: 'Jamena Strege',
  day: '2026-06-30',
  previousDay: '2026-06-29',
  nextDay: '2026-07-01',
  originalDate: '2026-06-30T00:00:00+00:00',
  /** `/activities/{id}` is 404 — the resource has no item Get, so the row is read by VO. */
  prescriptionId: 32949,
  vo: '7460-5',
};

const EUR = (n: number | null) => (n === null ? 'null' : `${n.toFixed(2)} EUR`);

test.describe('Management board KPI cards vs trend chart (#3398)', () => {
  test.describe.configure({ mode: 'serial' });

  let board: TrendParityPage;

  test.beforeEach(async ({ page }) => {
    board = new TrendParityPage(page);
    await board.connect();
  });

  // ─────────────────────────── the shipped fix ────────────────────────────

  test(
    'AC1 a Zeitraum series tiles the custom range and sums to the KPI card',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      for (const range of RANGES) {
        const card = await board.cards(range.from, range.to);
        const zeitraum = await board.trend({ level: range.level, to: range.to, rangeFrom: range.from });

        expect(
          TrendParityPage.tiles(zeitraum, range.from, range.to),
          `${range.label}: the series must tile ${range.from}..${range.to} exactly`,
        ).toBe(true);
        expect(TrendParityPage.sumRevenue(zeitraum), `${range.label}: Σ buckets == the card's treated revenue`).toBeCloseTo(
          card.treatedRevenue,
          2,
        );
        expect(TrendParityPage.sumValidated(zeitraum), `${range.label}: and the validated figure too`).toBeCloseTo(
          card.validatedRevenue,
          2,
        );

        console.log(
          `  ${range.label.padEnd(30)} ${range.from}..${range.to} ${String(zeitraum.length).padStart(3)} bucket(s)` +
            `  Σ ${EUR(TrendParityPage.sumRevenue(zeitraum))} == card ${EUR(card.treatedRevenue)}`,
        );
      }
    },
  );

  test(
    'AC1 without rangeFrom the chart describes a different window — the shape of the bug',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      // Periode mode is correct behaviour, not a defect: this test pins WHAT THE FIX CHANGED, so
      // that a regression removing `rangeFrom` handling is visible as the two series converging on
      // the wrong shape rather than as a silent number change.
      for (const range of RANGES) {
        const periode = await board.trend({ level: range.level, to: range.to });
        const zeitraum = await board.trend({ level: range.level, to: range.to, rangeFrom: range.from });

        expect(periode.length, `${range.label}: Periode mode is always 12 trailing periods`).toBe(12);
        expect(
          periode[0].periodStart === zeitraum[0].periodStart && periode.length === zeitraum.length,
          `${range.label}: the two modes must not describe the same window`,
        ).toBe(false);
        console.log(
          `  ${range.label.padEnd(30)} Periode ${periode[0].periodStart}..${periode[11].periodEnd} (12)` +
            `  vs Zeitraum ${zeitraum[0].periodStart}..${zeitraum[zeitraum.length - 1].periodEnd} (${zeitraum.length})`,
        );
      }
    },
  );

  // ───────────────────────────── AC1 per period ───────────────────────────

  for (const anchor of PERIODE_ANCHORS) {
    test(
      `AC1 every ${anchor.level} bucket equals a KPI card over that bucket's own dates`,
      { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
      async () => {
        test.setTimeout(900_000);

        const periods = await board.trend({ level: anchor.level, to: anchor.to });
        expect(periods.length, '12 trailing periods').toBe(12);

        let compared = 0;
        for (const period of periods) {
          const card = await board.cards(period.periodStart, period.periodEnd);
          expect(period.gesamt.revenue, `${period.periodStart}..${period.periodEnd}: Umsatz (behandelt)`).toBeCloseTo(
            card.treatedRevenue,
            2,
          );
          expect(period.gesamt.validatedRevenue, `${period.periodStart}: Umsatz validiert`).toBeCloseTo(
            card.validatedRevenue,
            2,
          );
          // The third card AC1 names. Null-coalesced deliberately — see the file docs.
          expect(period.gesamt.revenuePerHour ?? 0, `${period.periodStart}: €/Stunde`).toBeCloseTo(
            card.revenuePerHour ?? 0,
            2,
          );
          compared++;
        }
        console.log(`  ${anchor.level}: ${compared} periods compared, 0 mismatches`);
      },
    );
  }

  // ──────────────────────────────── AC4 ───────────────────────────────────

  test(
    'AC4 the cards, the Therapeut:innen table and the Gruppen table agree',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      for (const day of AC4_DAYS) {
        const card = await board.cards(day, day);
        const therapists = await board.therapistRows(day, day);
        const teams = await board.teamRows(day, day);

        const therapistSum = TrendParityPage.sum(therapists.map((r) => r.revenue));
        const teamSum = TrendParityPage.sum(teams.map((r) => r.revenue));
        const therapistValidated = TrendParityPage.sum(therapists.map((r) => r.validatedRevenue));

        expect(therapistSum, `${day}: Σ therapist rows == the card`).toBeCloseTo(card.treatedRevenue, 2);
        expect(teamSum, `${day}: Σ team rows == the card`).toBeCloseTo(card.treatedRevenue, 2);
        expect(therapistValidated, `${day}: and the validated column too`).toBeCloseTo(card.validatedRevenue, 2);

        console.log(
          `  ${day}  card ${EUR(card.treatedRevenue).padStart(14)}  ${therapists.length} therapist rows,` +
            ` ${teams.length} team rows — all equal`,
        );
      }
    },
  );

  // ──────────────────────────────── AC3 ───────────────────────────────────

  test(
    'AC3 a filtered view still matches, for every filter the board offers',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      const from = '2026-06-29';
      const to = '2026-07-05';
      const rows = (await board.therapistRows(from, to)).filter((r) => r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
      expect(rows.length, 'the window must carry revenue for this to mean anything').toBeGreaterThan(5);

      const teamIds = [...new Set(rows.map((r) => r.teamId).filter((id): id is number => id !== null))];
      const cases: { label: string; filters: Parameters<typeof board.cards>[2] }[] = [
        ...rows.slice(0, 3).map((r) => ({ label: `Therapeut:in ${r.therapistName}`, filters: { therapist: r.therapistId } })),
        ...teamIds.slice(0, 2).map((id) => ({ label: `Team ${id}`, filters: { team: id } })),
        { label: 'Ohne TO-Team', filters: { team: 'none' as const } },
        { label: 'GKV', filters: { patientType: 'gkv' as const } },
        { label: 'PKV', filters: { patientType: 'pkv' as const } },
      ];

      for (const testCase of cases) {
        const card = await board.cards(from, to, testCase.filters);
        const zeitraum = await board.trend({ level: 'tag', to, rangeFrom: from }, testCase.filters);
        expect(TrendParityPage.sumRevenue(zeitraum), `${testCase.label}: card and chart must still agree`).toBeCloseTo(
          card.treatedRevenue,
          2,
        );
        console.log(`  ${testCase.label.padEnd(34)} ${EUR(card.treatedRevenue)}`);
      }
    },
  );

  // ──────────────────────────────── AC2 ───────────────────────────────────

  test(
    'AC2 an activity at the very start or end of a Berlin day counts on that day in both surfaces',
    { tag: ['@SuperAdmin', '@TrendParity', '@Mutating'] },
    async () => {
      test.setTimeout(900_000);

      const solo = await board.countableActivitiesOnBerlinDay(BOUNDARY.therapistId, BOUNDARY.day);
      expect(solo.length, `${BOUNDARY.therapistName} must have exactly one countable session that day`).toBe(1);
      expect(solo[0].id, 'and it must be the pinned fixture').toBe(BOUNDARY.activityId);
      expect(solo[0].date, 'starting timestamp').toBe(BOUNDARY.originalDate);

      const days = [BOUNDARY.previousDay, BOUNDARY.day, BOUNDARY.nextDay];
      const readAll = async (label: string) => {
        const trend = await board.trend({
          level: 'tag',
          to: BOUNDARY.nextDay,
          rangeFrom: BOUNDARY.previousDay,
        });
        const out: Record<string, { card: number; trend: number; row: number | null }> = {};
        for (const day of days) {
          const card = await board.cards(day, day);
          const bucket = trend.find((p) => p.periodStart === day);
          const row = (await board.therapistRows(day, day)).find((r) => r.therapistId === BOUNDARY.therapistId);
          out[day] = { card: card.treatedRevenue, trend: bucket?.gesamt.revenue ?? NaN, row: row ? row.revenue : null };
          // AC1 restated at every step: whatever the timestamp, the two surfaces agree.
          expect(out[day].trend, `${label} — ${day}: card and trend must agree`).toBeCloseTo(out[day].card, 2);
        }
        console.log(
          `  ${label}: ` +
            days.map((d) => `${d} card ${out[d].card} row ${out[d].row === null ? 'absent' : out[d].row}`).join(' | '),
        );
        return out;
      };

      const before = await readAll('baseline (02:00 Berlin)');
      expect(before[BOUNDARY.day].row, 'the fixture must contribute revenue on its own day').toBeGreaterThan(0);

      try {
        for (const [label, value] of [
          ['23:59 Berlin (end of the day)', TrendParityPage.berlinDayEndUtc(BOUNDARY.day)],
          ['00:00 Berlin (start of the day)', TrendParityPage.berlinDayStartUtc(BOUNDARY.day)],
        ] as const) {
          const patched = await board.setActivityDate(BOUNDARY.activityId, value);
          expect(patched.status, `PATCH date=${value}`).toBe(200);
          expect(patched.date, 'stored verbatim').toBe(value);

          const after = await readAll(label);
          for (const day of days) {
            expect(after[day].card, `${label} — ${day}: the card total must not move`).toBeCloseTo(before[day].card, 2);
            expect(after[day].trend, `${label} — ${day}: nor the trend bucket`).toBeCloseTo(before[day].trend, 2);
          }
          expect(after[BOUNDARY.day].row, `${label}: the therapist still counts on ${BOUNDARY.day}`).toBeCloseTo(
            before[BOUNDARY.day].row!,
            2,
          );
          // The population asymmetry, made visible: at 00:00 Berlin the therapist is resolved into
          // the PREVIOUS day's population too — with revenue 0, which is why no total moves.
          expect(after[BOUNDARY.previousDay].row ?? 0, `${label}: and contributes nothing to the neighbour`).toBeCloseTo(
            0,
            2,
          );
        }
      } finally {
        const restored = await board.setActivityDate(BOUNDARY.activityId, BOUNDARY.originalDate);
        expect(restored.status, 'the activity must go back to its own timestamp').toBe(200);
        expect(await board.activityDate(BOUNDARY.activityId, BOUNDARY.prescriptionId)).toBe(BOUNDARY.originalDate);
      }
    },
  );

  // ───────────────────────── edges around the fix ─────────────────────────

  test(
    'the rangeFrom contract: single point, inverted, empty, and the tiling cap',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      const to = '2026-07-01';

      const single = await board.trend({ level: 'tag', to, rangeFrom: to });
      expect(single.length, 'rangeFrom == to yields a one-bucket series').toBe(1);
      expect(single[0].periodStart, 'covering that day').toBe(to);

      // The provider documents both of these as "ignored (Periode behaviour)".
      for (const [label, rangeFrom] of [
        ['inverted (rangeFrom after to)', '2026-08-01'],
        ['empty string', ''],
      ] as const) {
        const ignored = await board.trend({ level: 'woche', to, rangeFrom: rangeFrom || undefined });
        expect(ignored.length, `${label} falls back to 12 trailing periods`).toBe(12);
      }

      // MAX_RANGE_PERIODS = 400: a hand-crafted daily series over years is refused rather than
      // silently building thousands of windows. The board itself never gets near it.
      const overCap = await board.raw(`/kpis/management/trend?pagination=false&level=tag&to=${to}&rangeFrom=2025-01-01`);
      expect(overCap.status, 'a 546-day daily series is refused').toBe(400);

      const underCap = await board.trend({ level: 'tag', to, rangeFrom: '2025-09-05' });
      expect(underCap.length, 'while 300 buckets are served').toBe(300);

      // An unknown level falls back to woche rather than erroring.
      const unknownLevel = await board.raw(
        `/kpis/management/trend?pagination=false&level=quartal&to=${to}&rangeFrom=2026-06-15`,
      );
      expect(unknownLevel.status).toBe(200);
      console.log('  single point, inverted, empty, 400-period cap and unknown level all behave as documented');
    },
  );

  test(
    'evidence: both halves of the fix are deployed',
    { tag: ['@SuperAdmin', '@TrendParity', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);

      // The API half: Zeitraum mode exists at all.
      const from = '2026-06-29';
      const to = '2026-07-05';
      const zeitraum = await board.trend({ level: 'tag', to, rangeFrom: from });
      expect(TrendParityPage.tiles(zeitraum, from, to), 'the API tiles a custom range').toBe(true);

      // The client half: the served bundle must actually SEND rangeFrom, and only for the trend
      // caller in Zeitraum mode — five other consumers share `buildManagementFilter` and one
      // spreads its result, so an ungated key would leak into unrelated requests.
      const index = await page.request.get('https://staging.therapios.de/', { timeout: 120_000 });
      const entry = (await index.text()).match(/src="([^"]*entry-[^"]*\.js)"/)?.[1];
      expect(entry, 'the entry bundle must be locatable').toBeTruthy();
      const bundle = await (await page.request.get(`https://staging.therapios.de${entry}`, { timeout: 180_000 })).text();
      expect(bundle, 'buildManagementFilter emits rangeFrom, gated on Zeitraum').toContain(
        "'zeitraum'===M&&{rangeFrom:",
      );
      expect(bundle, 'and the trend hook passes it through').toContain('rangeFrom:E.rangeFrom');
      console.log(`  bundle ${entry} carries the gated rangeFrom emission`);

      // The CSV export half of #3398 (a Zeitraum export tiles the range instead of always
      // emitting 12 buckets) cannot be reached by this account: the export is gated to an
      // allowlist (#3181), so it answers 403 while the list endpoint beside it answers 200.
      const exportRes = await page.request.post(`${TrendParityPage.API}/kpis/management/export`, {
        headers: { ...board.authHeader(), 'Content-Type': 'application/json' },
        data: { from, to, level: 'tag', rangeFrom: from },
        timeout: 120_000,
        failOnStatusCode: false,
      });
      expect(exportRes.status(), 'the export stays allowlisted — its half of #3398 is unverifiable here').toBe(403);
      console.log(`  POST /kpis/management/export -> ${exportRes.status()} (allowlisted, see #3181)`);
    },
  );
});
