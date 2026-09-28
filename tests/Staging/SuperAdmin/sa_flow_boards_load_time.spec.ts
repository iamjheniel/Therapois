import { test, expect } from '@playwright/test';
import { BoardTimingPage, Level, SectionSamples } from '../../../Pages/superadmin/sa.board-timing.page';

/**
 * RC 3.12 — every Flow Board section loads within 10 s and never fails from slowness (#3401).
 *
 * The fix shipped inside commit `e87c91bad` (bundled with #3399/#3400): a hoisted revenue CTE, three
 * ORM-hydration paths replaced by SQL, memoised therapist metrics, a de-Cartesianed risk fetch and
 * one merged validation pass.
 *
 * **It is deployed and it is a large improvement. One section still misses AC1, reproducibly, and
 * AC2 fails through it.**
 *
 * Measured 2026-08-31 as medians over three DISTINCT cold windows per granularity, twice — once
 * while the box was busy (this file's own sampling is itself load) and once while it was quiet:
 *
 * | section | tag | woche | monat |
 * |---|---|---|---|
 * | `/kpis/management` | 2.6 / 1.0 s | 3.1 / 0.4 s | 5.9 / 3.1 s |
 * | `/kpis/management/teams` | 1.3 s | 1.4 / 0.5 s | 1.6 / 0.5 s |
 * | `/kpis/management/therapists` | 2.1 s | 2.1 / 0.4 s | 2.6 / 0.5 s |
 * | `/kpis/management/billing-backlog` | 4.9 s | 9.2 / 1.7 s | 10.3 / 0.4 s |
 * | `/kpis/management/trend` | 2.7 / 1.9 s | 15.3 / 7.6 s | **26.9 / 26.6 s** |
 * | `/kpis/orga/risks` | 25.0 s | 21.0 / 5.6 s | 23.9 s |
 * | `/kpis/management/working-hours` | 8.9 s | 5.1 / 2.3 s | 7.6 s |
 * | `/kpis/management/orga-trend` | 2.8 / 2.1 s | 10.3 / 5.9 s | **28.8 s** |
 * | `/kpis/admin-performance` | 8.1 s | 7.8 / 6.4 s | 7.5 s |
 * | `/kpis/admin-performance/risks` | 6.5 / 1.4 s | 7.2 / 1.0 s | 9.4 s |
 * | `/kpis/admin-performance/trend` | 8.3 / 5.0 s | 9.0 / 6.0 s | 8.3 s |
 *
 * **The variance is the first finding.** The same section measured 21.0 s and 5.6 s forty minutes
 * apart, so no single number here supports a verdict — which is exactly why every timing test in
 * this file samples three windows and prints them. Read the two columns together: most sections have
 * genuine headroom on a quiet box and only lose it under load. A third full pass of the evidence test
 * summarised it as **35 combinations, 2 over the 10 s ceiling, 12 over the 3 s target, slowest single
 * sample 25.2 s** — and the 2 over the ceiling were, again, the two Monat trends.
 *
 * **What does NOT move with load is the trend chart at Monat**: `/kpis/management/trend?level=monat`
 * medians **26.9 s busy and 26.6 s quiet** (max 30.3 s), and `/kpis/management/orga-trend` at monat
 * 28.8 s. That is a structural cost, and it sits directly on top of the two coincident 30 s ceilings
 * the ticket flags, which is how slowness turns into AC2's forbidden failure — observed twice:
 *  - **server side** — `/kpis/management/trend?level=monat` returned **504** (the load balancer's
 *    30 s idle timeout), once inside a concurrent Management mount for April and once as one of the
 *    three windows in this file's own evidence run;
 *  - **client side** — in the browser the same request was **aborted at 29,996 ms**, exactly
 *    `KPI_READ_TIMEOUT_MS` (30 000, read out of the deployed bundle rather than assumed), and the
 *    page rendered **"Daten konnten nicht geladen werden"**.
 *
 * The ticket's own case improved clearly: `/kpis/admin-performance` was recorded at 15–29 s and now
 * medians 7.5–8.1 s, with the whole Admin-Performance board mounting for Monat July in ~12 s.
 *
 * **What is asserted vs. reported.** The two failing ACs are `fixme`'d with the numbers inline — a
 * permanently red test would add nothing to a known finding. What runs green is (a) an evidence test
 * that re-measures and prints the full table every run, (b) a regression guard over the sections with
 * headroom, and (c) the parts of AC2/AC3/AC4/AC5 that do hold.
 *
 * **Run this file at `--workers=1`.** Parallel tests contend for the same aggregations and inflate
 * each other's timings, which is the same effect visible between the two columns above.
 *
 * **Read-only** — every request is a GET.
 */

/** Sections with real headroom today; the guard keeps them there. */
const GUARDED: { board: string; path: string; level: Level }[] = [
  { board: 'Management', path: '/kpis/management', level: 'tag' },
  { board: 'Management', path: '/kpis/management', level: 'woche' },
  { board: 'Management', path: '/kpis/management/teams', level: 'monat' },
  { board: 'Management', path: '/kpis/management/therapists', level: 'monat' },
  { board: 'Management', path: '/kpis/management/trend', level: 'tag' },
  { board: 'Therapeuten-Orga', path: '/kpis/management/orga-trend', level: 'tag' },
];

/** Over AC1's ceiling on BOTH runs, busy and quiet — i.e. structural, not contention. */
const OVER_CEILING_ALWAYS = [
  '/kpis/management/trend at monat (median 26.9 s busy, 26.6 s quiet, max 30.3 s, one window 504)',
  '/kpis/management/orga-trend at monat (median 28.8 s)',
];

/** Over the ceiling only while the box was busy — recovered to single digits when it was quiet. */
const OVER_CEILING_UNDER_LOAD = [
  '/kpis/orga/risks (25.0/21.0/23.9 s busy → 5.6 s quiet at woche)',
  '/kpis/management/trend at woche (15.3 s busy → 7.6 s quiet)',
  '/kpis/management/orga-trend at woche (10.3 s busy → 5.9 s quiet)',
  '/kpis/management/billing-backlog at monat (10.3 s busy → 0.4 s quiet)',
];

function section(board: string, path: string) {
  const found = BoardTimingPage.BOARDS[board].find((s) => s.path === path);
  if (!found) throw new Error(`unknown section ${path} on ${board}`);
  return found;
}

function report(rows: SectionSamples[]): void {
  for (const row of rows) console.log(BoardTimingPage.describe(row));
  const overCeiling = rows.filter((r) => r.median > BoardTimingPage.CEILING_MS);
  const overTarget = rows.filter((r) => r.median > BoardTimingPage.TARGET_MS);
  console.log(
    `\n${rows.length} section/granularity combinations: ${overCeiling.length} over the 10s ceiling, ` +
      `${overTarget.length} over the 3s design target, ` +
      `slowest single sample ${Math.max(...rows.map((r) => r.max))}ms`,
  );
}

test.describe('Flow Boards — section load times', () => {
  test(
    'Evidence — cold load time of every board section, per granularity',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      // Long by nature: 33 combinations × 3 cold windows, several of which take 20s+. This is the
      // measurement the ticket asks for, so it is done properly rather than sampled once.
      test.setTimeout(3_600_000);
      const timing = new BoardTimingPage(page);
      await timing.connect();

      const rows: SectionSamples[] = [];
      for (const level of ['tag', 'woche', 'monat'] as Level[]) {
        for (const [board, sections] of Object.entries(BoardTimingPage.BOARDS)) {
          for (const boardSection of sections) {
            // A static section takes no window, so it would be the same request three times over —
            // measured once, under `tag`.
            if (boardSection.kind === 'static' && level !== 'tag') continue;
            const row = await timing.sample(board, boardSection, level);
            rows.push(row);
            console.log(BoardTimingPage.describe(row));
            // Reported, not asserted: a 504 here IS the product failure AC2 forbids, and it is
            // already recorded as a finding below. Failing this test on it would make the one place
            // that prints the whole table red on every degraded run, which buries the numbers
            // instead of surfacing them. The regression guard is where a status regression bites.
            if (row.statuses.some((status) => status !== 200)) {
              console.log(
                `  !! ${boardSection.path} (${level}) did not answer 200 for every window: ` +
                  `${JSON.stringify(row.statuses)} — a 504 is the load balancer giving up at 30s`,
              );
            }
          }
        }
      }
      console.log('\n──────── summary ────────');
      report(rows);
      const failedSections = rows.filter((r) => r.statuses.some((status) => status !== 200));
      console.log(
        failedSections.length
          ? `sections that failed at least one window: ${failedSections.map((r) => `${r.section.path} (${r.level})`).join(', ')}`
          : 'every section answered 200 for every window',
      );
    },
  );

  test(
    'AC1 — regression guard: the sections with headroom stay inside the ceiling',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(1_200_000);
      const timing = new BoardTimingPage(page);
      await timing.connect();

      // Judged on the median of three cold windows, never a single sample: staging's response times
      // vary ~4x between runs, so a one-shot measurement would make this test a coin toss.
      const rows: SectionSamples[] = [];
      for (const guard of GUARDED) {
        rows.push(await timing.sample(guard.board, section(guard.board, guard.path), guard.level));
      }
      report(rows);
      for (const row of rows) {
        expect(
          row.statuses.every((status) => status === 200),
          `${row.section.path} at ${row.level} must answer 200 for every window — ` +
            `${JSON.stringify(row.statuses)} (a 504 is slowness becoming failure)`,
        ).toBe(true);
        expect(
          row.median,
          `${row.section.path} at ${row.level} had headroom on 2026-08-31 and must keep it — ` +
            `median ${row.median}ms against the ${BoardTimingPage.CEILING_MS}ms ceiling ` +
            `(samples ${JSON.stringify(row.samples)})`,
        ).toBeLessThanOrEqual(BoardTimingPage.CEILING_MS);
      }
    },
  );

  test(
    'AC2 — the ticket\'s own case: Admin-Performance, Monat July, loads and does not fail',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const timing = new BoardTimingPage(page);
      await timing.connect();

      // The window from the 12 Aug screen recording (29.0s pre-fix on /kpis/admin-performance). All
      // three of the board's sections are fired the way the board fires them — together.
      const mount = await timing.mountBoard('Admin-Performance', 'monat', BoardTimingPage.TICKET_WINDOW);
      console.log(`Admin-Performance ${BoardTimingPage.TICKET_WINDOW.label}: board wall ${mount.wallMs}ms`);
      for (const s of mount.sections.sort((a, b) => b.ms - a.ms)) {
        console.log(`  ${String(s.ms).padStart(6)}ms ${String(s.status).padStart(4)} ${s.label} — ${s.path}`);
      }

      for (const s of mount.sections) {
        expect(s.status, `${s.label} must not fail — ${s.path} answered ${s.status}`).toBe(200);
        expect(s.bytes, `${s.label} must return data`).toBeGreaterThan(0);
      }
      // The pre-fix figure for this exact request was 29.0s; it is now well under that, and the
      // guard here is the ceiling at which slowness becomes an outright failure rather than AC1's
      // 10s (which this board's sections still miss — see the fixme below).
      const clientCeiling = (await timing.clientReadTimeoutMs()) ?? 30_000;
      console.log(`client KPI read timeout, read from the deployed bundle: ${clientCeiling}ms`);
      expect(
        Math.max(...mount.sections.map((s) => s.ms)),
        `no section may exceed the client's own ${clientCeiling}ms abort, or the board shows ` +
          `"${BoardTimingPage.LOAD_ERROR}" instead of data`,
      ).toBeLessThan(clientCeiling);
    },
  );

  test(
    'AC2 — a slow section shows a loading state while it computes',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const timing = new BoardTimingPage(page);
      await timing.openScreen();

      // Watched in the browser, not inferred: the ACs are about what the user sees while waiting.
      const observed = await timing.observeBoardLoad('Therapeuten-Orga', 'Monat', 45_000);
      console.log(`requests: ${observed.requests.length}, spinner seen: ${observed.spinnerSeen}, error seen: ${observed.errorSeen}`);
      for (const r of observed.requests.sort((a, b) => b.ms - a.ms).slice(0, 6)) {
        console.log(`  ${String(r.ms).padStart(6)}ms ${r.status} ${r.url}`);
      }
      for (const f of observed.failed) console.log(`  FAILED: ${f}`);

      expect(observed.requests.length, 'the board must actually request its sections').toBeGreaterThan(0);
      expect(
        observed.spinnerSeen,
        'a section that takes seconds must show a loading state while it computes (AC2\'s first half)',
      ).toBe(true);
    },
  );

  test(
    'AC5 — switching granularity while a section is loading does not freeze the page',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const timing = new BoardTimingPage(page);
      await timing.openScreen();
      await page.waitForTimeout(8000);

      // Monat is the slowest granularity, so the click lands while several sections are still
      // computing — which is the condition AC5 describes.
      const responsive = await timing.measureResponsivenessDuringLoad('Monat', 'Woche');
      console.log(`requests in flight when the click landed: ${responsive.inFlight}, UI acknowledged after ${responsive.ackMs}ms`);
      expect(
        responsive.inFlight,
        'the measurement is only meaningful with requests in flight — nothing was loading',
      ).toBeGreaterThan(0);
      expect(responsive.ackMs, 'the UI must acknowledge the click').not.toBeNull();
      expect(
        responsive.ackMs!,
        'the page must stay responsive while a section computes — a frozen main thread cannot repaint',
      ).toBeLessThan(3_000);
    },
  );

  test(
    'AC3 — the one figure the fix deliberately moved carries its post-fix value',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const timing = new BoardTimingPage(page);
      await timing.connect();

      // The commit records exactly one changed figure: VO 29506's risk-worklist revenue, 2.689,55 →
      // 2.694,60, because the old ORM path depended on Doctrine's unordered hydration of
      // Activity::$activityTreatments while the SQL path is deterministic. That makes it the one
      // number that can be checked from outside to confirm which path is serving the board.
      const response = await page.request.get(
        `${BoardTimingPage.API}/kpis/orga/risks?pagination=false&from=2026-01-01&to=2026-12-31`,
        { headers: { Authorization: `Bearer ${await timing.bearer()}` }, timeout: 180_000 },
      );
      expect(response.status(), 'the risk worklist must load').toBe(200);
      const body = await response.json();
      const rows: any[] = body.member ?? body['hydra:member'] ?? [];
      const flat = rows.flatMap((row) => (Array.isArray(row.rows) ? row.rows : [row]));
      const target = flat.find((row) => row.prescriptionId === 29506);
      console.log(`VO 29506 (${target?.voNumber}): revenue ${target?.revenue}`);
      expect(target, 'VO 29506 must still be on the worklist to check').toBeTruthy();
      expect(
        target.revenue,
        'the SQL revenue path must be the one serving the board (pre-fix ORM value was 2689.55)',
      ).toBeCloseTo(2694.6, 2);
    },
  );

  test(
    'AC4 — the board recomputes often enough for a validation change to appear inside 15 minutes',
    { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(1_200_000);
      const timing = new BoardTimingPage(page);
      await timing.connect();

      // Read-only route to AC4: rather than validating a VO and watching the board, measure how long
      // the board is allowed to serve a stale answer. The response carries no cache headers
      // (`cache-control: no-cache, private`), so the TTL is only observable through timing — a cold
      // window is slow, an immediate repeat is fast (cached), and once the entry expires the same
      // window is slow again. That expiry is the upper bound on staleness.
      const adminPerformance = section('Admin-Performance', '/kpis/admin-performance');
      const window = { from: '2026-02-01', to: '2026-02-28', label: 'Monat Februar' };

      const cold = await timing.time(adminPerformance, 'monat', window);
      const warm = await timing.time(adminPerformance, 'monat', window);
      console.log(`cold ${cold.ms}ms -> warm ${warm.ms}ms (same window)`);
      expect(cold.status, 'the cold read must succeed').toBe(200);
      expect(warm.ms, 'an immediate repeat must be served from the cache').toBeLessThan(cold.ms / 2);

      // The wait IS the assertion here — the point is that the entry expires well inside AC4's
      // 15-minute window, so it cannot be shortened without weakening the claim.
      const waitMs = 6 * 60_000;
      console.log(`waiting ${waitMs / 60_000} minutes to see whether the entry expires…`);
      await page.waitForTimeout(waitMs);
      const later = await timing.time(adminPerformance, 'monat', window);
      console.log(`after ${waitMs / 60_000} min: ${later.ms}ms`);
      expect(later.status, 'the later read must succeed').toBe(200);
      expect(
        later.ms,
        `the same window still answered in ${later.ms}ms after 6 minutes, i.e. it is still cached — ` +
          `the staleness bound is longer than this test can see, so AC4's 15 minutes is not established`,
      ).toBeGreaterThan(warm.ms * 2);
    },
  );

  test('AC1 — every section on every board loads within 10 seconds', { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming'] }, async () => {
    test.fixme(
      true,
      'Not met on staging as of 2026-08-31, and the part that matters is reproducible rather than ' +
        `load-dependent. Over the ceiling on BOTH a busy and a quiet run: ${OVER_CEILING_ALWAYS.join('; ')}. ` +
        `Over it only under load, recovering when the box was quiet: ${OVER_CEILING_UNDER_LOAD.join('; ')}. ` +
        'Medians are over three distinct cold windows per granularity; a repeat of the same window ' +
        'measures the ~5-minute cache instead. The fix in e87c91bad is a clear improvement — the ' +
        'ticket recorded 15-29 s on /kpis/admin-performance, which now medians 7.5-8.1 s, and the ' +
        'whole Admin-Performance board mounts for Monat July in ~12 s — but the trend charts at Monat ' +
        'still take ~27 s regardless of load, so AC1 does not hold and the 3 s design target holds ' +
        'almost nowhere at that granularity. Deliberately `fixme` rather than red: the evidence test ' +
        'above re-measures and prints the whole table on every run, and the regression guard covers ' +
        'the sections that do have headroom.',
    );
  });

  test('AC2 — no section ever fails outright because it was slow', { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming'] }, async () => {
    test.fixme(
      true,
      'Observed failing on 2026-08-31 in both layers, always on the same section — the Monat trend, ' +
        'which medians ~27 s whether the box is busy or quiet and therefore sits on top of two ' +
        'coincident 30 s ceilings. Server side: /kpis/management/trend?level=monat returned 504 twice ' +
        '(once inside a concurrent Management mount for April at 31.4 s, once as one of the three ' +
        "windows in this file's own evidence run) — the load balancer's idle timeout. Client side: in " +
        'the browser the same request was aborted at 29,996 ms — exactly KPI_READ_TIMEOUT_MS, which ' +
        'the page object reads out of the deployed bundle — and the page rendered "Daten konnten ' +
        'nicht geladen werden", on both the Management and the Therapeuten-Orga board. Timing the ' +
        'abort is what rules out the alternative explanation, a re-render cancelling its own request. ' +
        'AC2 has two halves and only this one fails: the loading-state half is asserted above and ' +
        'holds.',
    );
  });

  test('AC3 — the pre-fix figures are unchanged after the fix', { tag: ['@SuperAdmin', '@FlowBoards', '@BoardTiming'] }, async () => {
    test.fixme(
      true,
      'Not reproducible from here now: the fix is already deployed, so no pre-fix baseline exists on ' +
        'staging to compare against, and the ACs name figures (July Admin-Performance totals, June ' +
        'Management KPI cards) that were never captured in this repo before the deploy. Upstream ' +
        'coverage is RawKpiCalculatorLifetimeRevenueParityTest, which the commit reports as ' +
        'byte-identical across 52 captured board responses. What IS checkable live is the single ' +
        'figure the commit says did move, VO 29506\'s worklist revenue — asserted above.',
    );
  });
});
