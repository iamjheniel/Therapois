import { test, expect } from '@playwright/test';
import {
  APRIL_2026,
  BucketKey,
  Dot,
  WorkingHoursDotPage,
} from '../../../Pages/superadmin/sa.working-hours-dot.page';

/**
 * RC 3.13 #3575 — a per-therapist traffic-light dot in the Arbeitszeiten table (PR #3606).
 *
 * **Everything here is on screen, deliberately.** All five ACs already have jest coverage in the PR,
 * and its author recorded that "visual QA on web and Android is still outstanding" — so the value
 * this file adds is the rendered dot on staging: its testid, its colour read back with
 * `getComputedStyle`, its position inside the name cell, and its absence where the ACs require it.
 *
 * Read-only. The one route interception (AC5) answers the buckets request locally and sends nothing.
 *
 * See the page object for the fixture reasoning — in short, **April 2026** is the period that puts
 * four of the five buckets on screen, and two AC cases have no live fixture on staging at all:
 * `gelb` (0 of 236 therapists are in it, in any period) and AC5's un-bucketed therapist (the buckets
 * endpoint returns every therapist, so the table's rows are always a subset). The second is
 * manufactured honestly by stubbing the buckets response empty.
 */
test.describe('#3575 per-therapist bucket dot in the Arbeitszeiten table', () => {
  test.describe.configure({ mode: 'serial' });

  let buckets: Map<number, BucketKey>;
  let rows: Array<{ therapistId: number; therapistName: string; teamName: string | null; efficiency: number | null }>;
  /** A team with enough members to make the Gruppen-view cases meaningful. */
  let teamWithMembers: string;
  let flatDots: Dot[];
  let managementColours: Map<string, Set<string>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(1_200_000);
    // No API reads of our own: the board is opened once and its OWN payloads are captured, so this
    // file depends on exactly the requests a user's page makes. `working-hours` and
    // `efficiency-buckets` are among the slowest reads on staging and flap between 200/500/504
    // under load, so issuing them a second time only widened the window for a failure that says
    // nothing about #3575.
    const page = await browser.newPage();
    const dotPage = new WorkingHoursDotPage(page);
    await dotPage.connect();
    await dotPage.openArbeitszeiten();
    await dotPage.setView('Therapeut:innen');
    await dotPage.waitForRows();
    // `waitForRows()` waits for a therapist NAME, which comes from `working-hours`; the dots are
    // painted from `efficiency-buckets`, a separate and slower read. So a name can be on screen
    // while the bucket map is still in flight, and this capture then takes ZERO dots — which every
    // test in the flat-view describe reports as "the table must paint dots", i.e. as the feature
    // being absent. Measured on 2026-09-23: 0 dots here, 102 from a probe moments later.
    await dotPage.waitForDots();
    // And the captured payload behind them: a response that parsed to no rows leaves an EMPTY map,
    // which `boardBuckets()` returns without complaint and every test then reads as "no buckets".
    await dotPage.waitForBucketCapture();
    flatDots = await dotPage.dots();
    buckets = dotPage.boardBuckets();
    rows = dotPage.boardRows();
    // AC2's reference surface, captured in the same session so the two are comparable.
    managementColours = await dotPage.managementColourByBucket(APRIL_2026);
    await page.close();

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const bucket = buckets.get(row.therapistId);
      if (bucket) counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const byTeam: Record<string, number> = {};
    for (const row of rows) if (row.teamName) byTeam[row.teamName] = (byTeam[row.teamName] ?? 0) + 1;
    teamWithMembers = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0][0];

    console.log(
      `#3575 ${APRIL_2026.label}: ${rows.length} Arbeitszeiten rows, ${buckets.size} therapists in the bucket map; ` +
        `dots expected by bucket ${JSON.stringify(counts)}; biggest team "${teamWithMembers}" (${byTeam[teamWithMembers]})`,
    );
    expect(rows.length, 'the table must have rows in this period').toBeGreaterThan(0);
    expect(Object.keys(counts).length, 'this period must put several buckets on screen').toBeGreaterThanOrEqual(3);
  });

  // ─────────────────────────────── the rolling-window basis ───────────────────────────────

  test(
    'the dot is coloured from a rolling window, not from the selected Periode',
    { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
    async ({ page }) => {
      // `useEfficiencyBuckets` strips from/to by design (#3242 AC2), so the dot's colour does not
      // move with the board's period while every other figure in the row does. The PR flags this as
      // a possible follow-up (the explanatory hint only appears when a bucket is selected) —
      // recorded here so the behaviour is on the record, not asserted as wrong.
      //
      // Read off the payload the BOARD itself fetched while showing April 2026: the request the app
      // issued for that period came back describing the rolling window, which is the claim.
      expect(buckets.size, 'the board fetched a bucket map').toBeGreaterThan(0);
      expect(
        [...new Set(buckets.values())].sort(),
        'the buckets that exist on staging at all — note gelb is absent',
      ).toEqual(['abwesend', 'grau', 'gruen', 'rot']);
      console.log(
        `#3575 rolling window: the April-2026 board fetched ${buckets.size} bucket rows for ` +
          `${rows.length} table rows — the map covers therapists the period does not`,
      );
      expect(buckets.size, 'the map is not period-scoped: it is wider than the table').toBeGreaterThan(rows.length);
    },
  );

  // ─────────────────────────────── the flat view ───────────────────────────────

  test.describe('Therapeut:innen view', () => {
    /** Captured once in the file-level `beforeAll` — see the note there. */
    let dots: Dot[];
    test.beforeAll(() => {
      dots = flatDots;
    });

    test(
      'AC1 every therapist row carries a dot, and it sits immediately left of the name',
      { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
      async () => {
        expect(dots.length, 'the table must paint dots').toBeGreaterThan(0);

        // The dot population is exactly the rows whose therapist the buckets endpoint places.
        const expected = rows.filter((r) => buckets.has(r.therapistId)).map((r) => r.therapistId).sort((a, b) => a - b);
        const painted = dots.map((d) => d.therapistId).sort((a, b) => a - b);
        console.log(`#3575 AC1: ${painted.length} dots painted, ${expected.length} expected`);
        expect(painted, 'one dot per bucketed therapist row, and no others').toEqual(expected);

        // "immediately to the left of the therapist's name" — asserted as position, not proximity.
        // Nothing else catches a dot rendered after the name.
        for (const dot of dots) {
          expect(dot.firstInNameCell, `${dot.testId} must be the first element in its name cell`).toBe(true);
          expect(dot.nameAfterDot, `${dot.testId} must be followed by the therapist's name`).not.toBe('');
        }
        const sample = dots[0];
        const row = rows.find((r) => r.therapistId === sample.therapistId)!;
        expect(sample.nameAfterDot, 'and that name is the row\'s own therapist').toContain(row.therapistName.split(' ')[0]);
      },
    );

    test(
      'the dot is the 10px circle the Management table uses',
      { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
      async () => {
        for (const dot of dots.slice(0, 10)) {
          expect(dot.width, `${dot.testId} width`).toBe('10px');
          expect(dot.height, `${dot.testId} height`).toBe('10px');
          expect(dot.borderRadius, `${dot.testId} radius`).toMatch(/^5px/);
        }
      },
    );

    test(
      'AC2 the colour is a function of the bucket alone',
      { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
      async () => {
        const byBucket = WorkingHoursDotPage.colourByBucket(dots, buckets);
        for (const [bucket, colours] of byBucket) {
          expect([...colours], `every ${bucket} therapist must get one and the same colour`).toHaveLength(1);
        }
        // And the buckets on screen must be told apart — one colour reused for two buckets would
        // satisfy "one colour per bucket" while making the dot useless.
        const distinct = new Set([...byBucket.values()].map((s) => [...s][0]));
        expect(distinct.size, 'each bucket on screen has its own colour').toBe(byBucket.size);
        console.log(`#3575 AC2 colours: ` + [...byBucket].map(([b, c]) => `${b}=${[...c][0]}`).join(', '));
        expect(byBucket.size, 'this period shows four of the five buckets').toBeGreaterThanOrEqual(3);
      },
    );

    test(
      'AC2 the colours match the Management detail table, bucket for bucket',
      { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
      async () => {
        // AC2 names the Management Detail table as the reference. Both surfaces now read one shared
        // `BUCKET_COLOR` module, which makes parity structural — this checks it is also true on
        // screen, which is the half a refactor can silently break.
        const here = WorkingHoursDotPage.colourByBucket(dots, buckets);
        console.log(
          `#3575 Management detail dots: ` +
            [...managementColours].map(([b, c]) => `${b}=${[...c].join('/')}`).join(', '),
        );

        const shared = [...here.keys()].filter((b) => managementColours.has(b));
        expect(shared.length, 'the two surfaces must share at least one bucket to compare').toBeGreaterThan(0);
        for (const bucket of shared) {
          expect([...managementColours.get(bucket)!], `the Management dot for ${bucket} must be one colour`).toHaveLength(1);
          expect(
            [...here.get(bucket)!][0],
            `${bucket}: the Arbeitszeiten dot must use the Management colour`,
          ).toBe([...managementColours.get(bucket)!][0]);
        }
      },
    );
  });

  // ─────────────────────────────── the Gruppen view ───────────────────────────────

  test.describe('Gruppen view', () => {
    test(
      'AC3/AC4 team headers carry no dot; expanded members carry the same dots as the flat view',
      { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(900_000);
        const dotPage = new WorkingHoursDotPage(page);
        await dotPage.connect();
        await dotPage.openArbeitszeiten();

        // Flat view first, so the same therapists can be compared across the two views.
        await dotPage.setView('Therapeut:innen');
        await dotPage.waitForRows();
        // The rows and the dots come from DIFFERENT reads (working-hours vs efficiency-buckets), so
        // a name being on screen does not mean a dot is — wait for the thing about to be read.
        await dotPage.waitForDots();
        const flat = new Map((await dotPage.dots()).map((d) => [d.therapistId, d.background]));
        expect(flat.size, 'the flat view must have painted').toBeGreaterThan(0);

        await dotPage.setView('Gruppen');
        await dotPage.waitForRows(teamWithMembers);

        // AC4: with every team collapsed, the only rows on screen are team headers — so the
        // COMPLETE dot population must be empty. Asserting the whole population rather than "the
        // header has no dot" is what makes this falsifiable.
        await expect
          .poll(async () => (await dotPage.dots()).length, { timeout: 60_000, intervals: [2_000] })
          .toBe(0);

        // AC3: expanding a team reveals its members, and their dots are the flat view's dots.
        await dotPage.expandTeam(teamWithMembers);
        const membersOfTeam = rows.filter((r) => teamWithMembers === r.teamName && buckets.has(r.therapistId));
        await expect
          .poll(async () => (await dotPage.dots()).length, { timeout: 60_000, intervals: [2_000] })
          .toBeGreaterThan(0);

        const expanded = await dotPage.dots();
        console.log(
          `#3575 AC3/AC4: team "${teamWithMembers}" expanded → ${expanded.length} dots, ` +
            `${membersOfTeam.length} bucketed members`,
        );

        // Every painted dot belongs to a member of the team just expanded — never to a header.
        const memberIds = new Set(membersOfTeam.map((r) => r.therapistId));
        for (const dot of expanded) {
          expect(memberIds.has(dot.therapistId), `${dot.testId} must be a member of ${teamWithMembers}`).toBe(true);
          expect(dot.firstInNameCell, 'a nested member row keeps the dot before the name').toBe(true);
          expect(
            dot.background,
            `${dot.testId}: the nested dot must match the flat view's colour`,
          ).toBe(flat.get(dot.therapistId));
        }
      },
    );
  });

  // ─────────────────────────────── AC5 ───────────────────────────────

  test(
    'AC5 a therapist with no bucket gets no dot, and the name renders unchanged',
    { tag: ['@SuperAdmin', '@WorkingHoursDot', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      // Staging has no un-bucketed therapist — `efficiency-buckets` returns all 236, so the table's
      // rows are always a subset — so the state is produced by answering that request with an empty
      // collection. That is the still-loading / not-placed render AC5 describes, and nothing reaches
      // the server: the response is fabricated locally.
      const dotPage = new WorkingHoursDotPage(page);
      await dotPage.connect();
      await dotPage.openArbeitszeiten({ stubEmptyBuckets: true });
      await dotPage.setView('Therapeut:innen');
      await dotPage.waitForRows();

      expect(await dotPage.dots(), 'no therapist is placed, so no dot renders').toEqual([]);

      // "the name displays exactly as it does today, with no visual change" — the rows are all still
      // there with their names, which is the half that would break if the dot were replaced by a
      // reserved-space placeholder.
      const names = await page.evaluate(() => ((document.querySelector('#root') as HTMLElement)?.innerText ?? ''));
      let present = 0;
      for (const row of rows.slice(0, 12)) if (names.includes(row.therapistName)) present += 1;
      console.log(`#3575 AC5: 0 dots, ${present}/12 sampled therapist names still rendered`);
      expect(present, 'the rows and their names are unaffected').toBeGreaterThan(6);
    },
  );

  // ─────────────────────────────── no fixture ───────────────────────────────
});
