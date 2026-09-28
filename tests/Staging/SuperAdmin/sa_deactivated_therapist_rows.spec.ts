import { test, expect } from '@playwright/test';
import {
  DeactivatedTherapistRowsPage,
  HISTORY_WINDOW,
  MANAGEMENT_BUCKET_LABELS,
  MONTH_FIXTURE,
  TherapistRow,
} from '../../../Pages/superadmin/sa.deactivated-therapist-rows.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.13 #3579 — the Management board's tiles count active therapists only, and the Detail table
 * drops deactivated therapists who have no data in the period.
 *
 * **Deployed on staging (API `3.13.0`), and the implementation is better than the ticket asked for.**
 * The Developer Reference offered two options and warned that the obvious one — filtering inside
 * `TrafficLightBuckets` — would silently change the Therapeuten-Orga board, which reuses that
 * component. What shipped instead is a separate two-function module with a single call site on the
 * Management board:
 *
 * ```js
 * activeTileRows   = rows => rows.filter(r => r.active)
 * visibleTableRows = rows => rows.filter(r => r.active || 'grau' !== r.bucket
 *                                          || 0 !== r.revenue || 0 !== r.validatedRevenue)
 * ```
 *
 * so the TO board is untouched and AC6 holds by construction — both arrays derive from the same
 * unfiltered `t.rows`, and the KPI cards read a different hook.
 *
 * **The trap that makes this ticket easy to "verify" vacuously:** with no period params the endpoint
 * returns 122 rows of which **zero are deactivated**, so every assertion here passes without touching
 * the subject. `HISTORY_WINDOW` (Q4 2025) is the fixture — 108 rows, **21 deactivated** — and the
 * tiles move visibly: `rot 28 / gelb 36 / gruen 33 / grau 11` over all rows becomes
 * `17 / 29 / 32 / 9` over active ones. AC2's own case needs one more turn of the screw: it appears
 * only once the board is narrowed by patient type, which splits a therapist's revenue and can leave
 * a departed one at 0/0.
 *
 * Read-only — every request is a GET.
 */

test.describe('#3579 deactivated therapists in the Management tiles and table', () => {
  let dt: DeactivatedTherapistRowsPage;
  let history: TherapistRow[];
  let current: TherapistRow[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await browser.newPage();
    dt = new DeactivatedTherapistRowsPage(page);
    await dt.connect();
    history = await dt.therapistRows({ from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to });
    current = await dt.therapistRows();
  });

  test(
    'the fixture is real — and the default period would prove nothing',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      const staff = await dt.deactivatedTherapistCount();
      console.log(`therapist accounts: ${staff.total}, deactivated: ${staff.deactivated}`);
      expect(staff.deactivated, 'staging has deactivated therapists at all').toBeGreaterThan(0);

      const inCurrent = current.filter((r) => !r.active);
      const inHistory = history.filter((r) => !r.active);
      console.log(`default period: ${current.length} rows, ${inCurrent.length} deactivated`);
      console.log(`${HISTORY_WINDOW.from}..${HISTORY_WINDOW.to}: ${history.length} rows, ${inHistory.length} deactivated`);

      // The guard: without a historical window there is nothing to exclude, so a test written against
      // the default period is green whether or not the fix exists.
      expect(inHistory.length, 'the history window actually contains deactivated therapists').toBeGreaterThan(5);
    },
  );

  test(
    'deployment — the two filters shipped as their own module, wired only to the Management board',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);
      const bundle = await dt.entryBundle();

      // The shipped predicates, character for character.
      expect(bundle, 'activeTileRows is the AC1 filter').toContain(
        'activeTileRows=function(t){return t.filter(t=>t.active)}',
      );
      expect(bundle, 'visibleTableRows is AC2/AC3, as the De Morgan complement of "hide"').toContain(
        "visibleTableRows=function(t){return t.filter(t=>t.active||'grau'!==t.bucket||0!==t.revenue||0!==t.validatedRevenue)}",
      );

      // Wired into the board — a definition nobody calls would be just as invisible as no fix.
      expect(bundle, 'the tiles consume activeTileRows').toMatch(/useMemo\)\(\(\)=>\(0,\w+\.activeTileRows\)\(\w+\.rows\)/);
      expect(bundle, 'the table consumes visibleTableRows').toMatch(/useMemo\)\(\(\)=>\(0,\w+\.visibleTableRows\)\(\w+\.rows\)/);

      // AC6 / the shared-component risk: exactly one call site each (definition + use), so the
      // Therapeuten-Orga board's reuse of TrafficLightBuckets is not affected.
      const tileUses = DeactivatedTherapistRowsPage.occurrences(bundle, 'activeTileRows');
      const tableUses = DeactivatedTherapistRowsPage.occurrences(bundle, 'visibleTableRows');
      console.log(`activeTileRows occurrences: ${tileUses}, visibleTableRows: ${tableUses} (1 definition + 1 use each)`);
      expect(tileUses, 'one definition and one call site — the TO board is untouched').toBe(2);
      expect(tableUses).toBe(2);
    },
  );

  test(
    'AC1 — the tiles count active therapists only, and that visibly changes the numbers',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      const all = DeactivatedTherapistRowsPage.tileCounts(history);
      const activeOnly = DeactivatedTherapistRowsPage.tileCounts(DeactivatedTherapistRowsPage.activeTileRows(history));
      console.log(`tiles over ALL rows   : ${JSON.stringify(all)}`);
      console.log(`tiles over ACTIVE only: ${JSON.stringify(activeOnly)}`);

      // Every bucket must shrink or hold, never grow.
      for (const k of ['rot', 'gelb', 'gruen', 'grau', 'abwesend'] as const) {
        expect(activeOnly[k], `${k} cannot grow when rows are removed`).toBeLessThanOrEqual(all[k]);
      }
      // And the change must be real, or the assertion above is vacuous.
      const deactivated = history.filter((r) => !r.active).length;
      const shrink = (Object.keys(all) as (keyof typeof all)[]).reduce((n, k) => n + (all[k] - activeOnly[k]), 0);
      console.log(`deactivated rows: ${deactivated}, total tile shrinkage: ${shrink}`);
      expect(shrink, 'the tiles drop exactly the deactivated therapists').toBe(deactivated);
      expect(shrink, 'and that is a visible change, not a no-op').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 — a deactivated therapist with activity stays in the table',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      const visible = DeactivatedTherapistRowsPage.visibleTableRows(history);
      const keptDeactivated = visible.filter((r) => !r.active);
      console.log(`table rows: ${history.length} → ${visible.length}; deactivated kept: ${keptDeactivated.length}`);
      for (const r of keptDeactivated.slice(0, 6)) {
        console.log(`  kept: ${r.therapistName} bucket=${r.bucket} revenue=${r.revenue} validated=${r.validatedRevenue}`);
      }
      expect(keptDeactivated.length, 'deactivated therapists with activity remain visible').toBeGreaterThan(0);

      // Every one of them must have a reason to be kept — otherwise the filter is simply not firing.
      for (const r of keptDeactivated) {
        const hasReason = 'grau' !== r.bucket || 0 !== r.revenue || 0 !== r.validatedRevenue;
        expect(hasReason, `${r.therapistName} is kept because it has data, not by accident`).toBe(true);
      }
    },
  );

  test(
    'AC2 — the hide rule, checked against its own truth table',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      // In an UNFILTERED window every deactivated therapist on staging carries revenue, so none meets
      // AC2's four-way condition — which is why this test pins the shipped predicate against the AC's
      // own truth table rather than relying on the data. It is not the only coverage: narrowing by
      // patient type does produce real AC2 rows, and the "AC2 (live)" test below exercises those.
      const live = DeactivatedTherapistRowsPage.hiddenByAc2(history);
      console.log(`live AC2 rows in ${HISTORY_WINDOW.from}..${HISTORY_WINDOW.to}: ${live.length} (none expected on staging)`);

      const row = (over: Partial<TherapistRow>): TherapistRow => ({
        therapistId: 1, therapistName: 'x', teamId: null, teamName: null,
        bucket: 'grau', revenue: 0, validatedRevenue: 0, active: false, ...over,
      });
      const cases: [string, TherapistRow, boolean][] = [
        ['AC2: deactivated, grau, 0 revenue, 0 validated → hidden', row({}), false],
        ['AC3: deactivated, grau, has revenue → visible', row({ revenue: 5386 }), true],
        ['AC3: deactivated, grau, has validated → visible', row({ validatedRevenue: 120 }), true],
        ['AC3: deactivated, gruen (has Personio hours) → visible', row({ bucket: 'gruen' }), true],
        ['AC3: deactivated, rot → visible', row({ bucket: 'rot' }), true],
        ['AC4: ACTIVE, grau, no data → visible (untouched)', row({ active: true }), true],
      ];
      for (const [label, r, expected] of cases) {
        const visible = 1 === DeactivatedTherapistRowsPage.visibleTableRows([r]).length;
        console.log(`  ${visible === expected ? 'ok  ' : 'FAIL'} ${label}`);
        expect(visible, label).toBe(expected);
      }
    },
  );

  test(
    'AC4 — active therapists are untouched by either filter',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      const activeRows = history.filter((r) => r.active);
      const visible = DeactivatedTherapistRowsPage.visibleTableRows(history).filter((r) => r.active);
      const tiles = DeactivatedTherapistRowsPage.activeTileRows(history);
      console.log(`active rows: ${activeRows.length}; kept in table: ${visible.length}; counted in tiles: ${tiles.length}`);

      // Including the ones the ticket is careful about: an ACTIVE therapist with no data at all.
      const activeGreyNoData = activeRows.filter((r) => 'grau' === r.bucket && 0 === r.revenue && 0 === r.validatedRevenue);
      console.log(`active + grau + no data (must survive): ${activeGreyNoData.length}`);
      expect(visible.length, 'no active row is dropped from the table').toBe(activeRows.length);
      expect(tiles.length, 'every active row is counted in the tiles').toBe(activeRows.length);
    },
  );

  test(
    'AC5 — the same rule holds under the board’s filters',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // The board narrows by team, patient type and location. The rule is a client-side filter over
      // whatever the endpoint returns, so it must behave identically for every filtered population.
      const windows: Record<string, string>[] = [
        { from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to },
        { from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to, patientType: 'gkv' },
        { from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to, patientType: 'pkv' },
        { from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to, location: 'einrichtung' },
      ];
      let checked = 0;
      for (const q of windows) {
        const rows = await dt.therapistRows(q).catch(() => null);
        if (!rows) {
          console.log(`  ${JSON.stringify(q)} → unavailable`);
          continue;
        }
        const tiles = DeactivatedTherapistRowsPage.activeTileRows(rows);
        const table = DeactivatedTherapistRowsPage.visibleTableRows(rows);
        const deact = rows.filter((r) => !r.active).length;
        console.log(`  ${JSON.stringify(q)} → rows=${rows.length} deactivated=${deact} tiles=${tiles.length} table=${table.length}`);
        // The invariants, whatever the population: no deactivated row in the tiles, and every hidden
        // row is one AC2 names.
        expect(tiles.every((r) => r.active), 'no deactivated therapist reaches the tiles').toBe(true);
        const hidden = rows.filter((r) => !table.includes(r));
        expect(
          hidden.every((r) => !r.active && 'grau' === r.bucket && 0 === r.revenue && 0 === r.validatedRevenue),
          'only AC2 rows are hidden',
        ).toBe(true);
        checked++;
      }
      expect(checked, 'at least two filter combinations were exercised').toBeGreaterThan(1);
    },
  );

  test(
    'AC6 — the underlying population is untouched, so the other surfaces still see everyone',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      // The fix is two `useMemo`s over `t.rows`; nothing narrows the endpoint. The check that matters
      // is that the API still hands back deactivated therapists — if it had been fixed server-side,
      // AC3 would be broken and the KPI cards would silently lose history.
      const deactivated = history.filter((r) => !r.active);
      console.log(`API still returns ${deactivated.length} deactivated therapists for the window`);
      expect(deactivated.length, 'the population still includes deactivated therapists (#3210)').toBeGreaterThan(0);

      // And their revenue is still in the payload the KPI surfaces aggregate from.
      const withRevenue = deactivated.filter((r) => r.revenue > 0);
      const total = withRevenue.reduce((n, r) => n + r.revenue, 0);
      console.log(`  of those, ${withRevenue.length} carry revenue totalling ${total.toFixed(2)}`);
      expect(withRevenue.length, 'departed therapists’ historical revenue is still exposed').toBeGreaterThan(0);
    },
  );

  test(
    'AC2 (live) — narrowing by patient type produces the rows the AC exists to hide',
    { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // My first pass concluded AC2 had no fixture, having only looked at UNFILTERED windows where
      // every deactivated therapist carries revenue. The AC5 test disproved that: narrowing by
      // patient type splits a therapist's revenue, and a deactivated therapist whose whole
      // contribution sat on the other insurance type becomes grau with 0/0 — exactly AC2's case.
      let found = 0;
      for (const patientType of ['gkv', 'pkv']) {
        const rows = await dt.therapistRows({ from: HISTORY_WINDOW.from, to: HISTORY_WINDOW.to, patientType });
        const hidden = DeactivatedTherapistRowsPage.hiddenByAc2(rows);
        const visible = DeactivatedTherapistRowsPage.visibleTableRows(rows);
        console.log(`patientType=${patientType}: ${rows.length} rows → ${visible.length} shown, ${hidden.length} hidden by AC2`);
        for (const r of hidden.slice(0, 4)) {
          console.log(`  hidden: ${r.therapistName} active=${r.active} bucket=${r.bucket} revenue=${r.revenue} validated=${r.validatedRevenue}`);
        }
        // Each hidden row must meet all four conditions, and the arithmetic must close.
        for (const r of hidden) {
          expect(r.active, `${r.therapistName} is deactivated`).toBe(false);
          expect(r.bucket, `${r.therapistName} is grau (no Personio hours)`).toBe('grau');
          expect(r.revenue, `${r.therapistName} has no revenue`).toBe(0);
          expect(r.validatedRevenue, `${r.therapistName} has no validated revenue`).toBe(0);
        }
        expect(visible.length + hidden.length, 'shown + hidden accounts for every row').toBe(rows.length);
        // And an active therapist is never among them (AC4).
        expect(hidden.every((r) => !r.active), 'no active therapist is hidden').toBe(true);
        found += hidden.length;
      }
      console.log(`AC2 rows exercised live: ${found}`);
      expect(found, 'the AC2 branch is exercised on real data, not only on a truth table').toBeGreaterThan(0);
    },
  );
  // ═══════════════════════════════ the board on screen ═══════════════════════════════

  /**
   * The tests above check the two shipped predicates against the rows the API serves. These check
   * the two SURFACES the ticket is about — the rendered tiles and the rendered table — which is what
   * the PM's own QA script and the admin's screenshot are about.
   *
   * April 2026 is the fixture, and it is the only period the board's stepper can reach where both
   * ACs bite at once: 116 rows, 4 deactivated, 2 of them grau/€0/€0.
   */
  test.describe('rendered on the Management board (April 2026)', () => {
    test.describe.configure({ mode: 'serial' });

    /** The 4 deactivated therapists in April, split by what the ACs say must happen to each. */
    const HIDDEN_BY_AC2 = ['Celina Faßmann', 'Lena Aufderheide'] as const;
    const KEPT_BY_AC3 = ['Jacqueline Kusche', 'Dominik Au'] as const;
    /** Celina Faßmann's team — the row hidden from it is what makes the header count differ. */
    const TEAM_WITH_A_HIDDEN_MEMBER = 'Kerstin Müller';

    let month: TherapistRow[];

    /**
     * Waits until the detail table has actually painted therapist rows.
     *
     * `FlowBoardsPage.detailRowNames()` slices the board's flattened text after the last column
     * header, so while the table is still fetching it returns whatever renders BELOW it — on this
     * board the #3394 Ausfallzeiten cards ("Krankenquote", "Aktive Therapeut:innen", …). That is a
     * non-empty array of plausible-looking labels, so a bare `length > 0` check passes on an
     * unpainted table and the assertions that follow report a product bug that is not there. The
     * readiness condition is therefore a row that must be present in this period, not a count.
     */
    const waitForDetailRows = async (boards: FlowBoardsPage): Promise<string[]> => {
      const anchor = DeactivatedTherapistRowsPage.normalizeName(
        month.find((r) => r.active && (r.revenue ?? 0) > 0)!.therapistName,
      );
      await expect
        .poll(
          async () => DeactivatedTherapistRowsPage.plainNames(await boards.detailRowNames()).includes(anchor),
          { timeout: 240_000, intervals: [2_000] },
        )
        .toBe(true);
      return boards.detailRowNames();
    };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(300_000);
      const page = await browser.newPage();
      const api = new DeactivatedTherapistRowsPage(page);
      await api.connect();
      month = await api.therapistRows({ from: MONTH_FIXTURE.from, to: MONTH_FIXTURE.to });
      await page.close();

      // The whole describe is worthless if the fixture has drifted, so it is proven, not assumed.
      const deactivated = month.filter((r) => !r.active);
      expect(deactivated.length, `${MONTH_FIXTURE.label} must still hold deactivated therapists`).toBeGreaterThan(0);
      expect(
        DeactivatedTherapistRowsPage.hiddenByAc2(month).map((r) => r.therapistName).sort(),
        'AC2 must still have a live fixture in this month',
      ).toEqual([...HIDDEN_BY_AC2].sort());
      console.log(
        `${MONTH_FIXTURE.label}: ${month.length} rows, ${deactivated.length} deactivated, ` +
          `${DeactivatedTherapistRowsPage.hiddenByAc2(month).length} hidden by AC2`,
      );
    });

    test(
      'AC1 — the tiles on screen carry the active-only counts, which are not the all-rows counts',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        const dtUi = new DeactivatedTherapistRowsPage(page);
        await dtUi.connect();
        const boards = await dtUi.openManagementMonth();
        expect(await boards.periodLabel()).toBe(MONTH_FIXTURE.label);

        const activeOnly = DeactivatedTherapistRowsPage.tileCounts(
          DeactivatedTherapistRowsPage.activeTileRows(month),
        );
        const allRows = DeactivatedTherapistRowsPage.tileCounts(month);
        const rendered = await dtUi.renderedTileCounts();
        console.log(`rendered tiles: ${JSON.stringify(rendered)}`);
        console.log(`active-only: ${JSON.stringify(activeOnly)}  all-rows: ${JSON.stringify(allRows)}`);

        for (const key of Object.keys(activeOnly) as (keyof typeof activeOnly)[]) {
          expect(
            rendered[key],
            `the ${MANAGEMENT_BUCKET_LABELS[key]} tile must count active therapists only`,
          ).toBe(activeOnly[key]);
        }

        // The assertion that makes AC1 falsifiable: the two count sets genuinely differ in this
        // period, so a build without the fix would render `allRows` and fail above. Without this,
        // AC1's test would pass on any period where nobody is deactivated.
        expect(
          JSON.stringify(activeOnly),
          `${MONTH_FIXTURE.label} must be a period where the fix changes the numbers`,
        ).not.toBe(JSON.stringify(allRows));
      },
    );

    test(
      'AC2/AC3 — the zero-data deactivated rows are gone; the ones with data stay, labeled "(Inaktiv)"',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        const dtUi = new DeactivatedTherapistRowsPage(page);
        await dtUi.connect();
        const boards = await dtUi.openManagementMonth();

        // The Therapeut:innen view lists every therapist flat, so it is where a row's absence means
        // "hidden" rather than "inside a collapsed team".
        await boards.setDetailView('Therapeut:innen');
        // A deactivated row paints as one line, "<name> (Inaktiv)", so the suffix comes off before
        // any name comparison — matching on the raw lines makes AC3 look broken when it holds.
        const painted = DeactivatedTherapistRowsPage.plainNames(await waitForDetailRows(boards));

        for (const name of HIDDEN_BY_AC2) {
          expect(painted, `AC2: ${name} is deactivated with no data and must not be listed`)
            .not.toContain(DeactivatedTherapistRowsPage.normalizeName(name));
        }
        for (const name of KEPT_BY_AC3) {
          expect(painted, `AC3: ${name} is deactivated WITH data and must stay listed`)
            .toContain(DeactivatedTherapistRowsPage.normalizeName(name));
          const row = await dtUi.tableRowFor(name);
          expect(row?.inaktiv, `AC3: ${name}'s row must still carry "(Inaktiv)"`).toBe(true);
        }

        // The painted set covers exactly the rows the shipped predicate keeps. Asserted as
        // membership, not as a count: the flattened table also yields a handful of non-name lines
        // ("Ohne TO-Team", warnings), so a length comparison would be measuring the parser.
        for (const row of DeactivatedTherapistRowsPage.visibleTableRows(month)) {
          expect(painted, `${row.therapistName} passes visibleTableRows and must be painted`)
            .toContain(DeactivatedTherapistRowsPage.normalizeName(row.therapistName));
        }
        for (const row of DeactivatedTherapistRowsPage.hiddenByAc2(month)) {
          expect(painted, `${row.therapistName} fails visibleTableRows and must not be painted`)
            .not.toContain(DeactivatedTherapistRowsPage.normalizeName(row.therapistName));
        }
      },
    );

    test(
      'AC2/AC5 — the same row stays hidden inside its expanded team in the Gruppen view',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        const dtUi = new DeactivatedTherapistRowsPage(page);
        await dtUi.connect();
        const boards = await dtUi.openManagementMonth();
        await boards.setDetailView('Gruppen');
        // The team rows must be there before the expand diff, or `before` and `after` are both the
        // section below the table and the diff comes back empty.
        await expect
          .poll(async () => (await boards.detailRowNames()).includes(TEAM_WITH_A_HIDDEN_MEMBER), {
            timeout: 240_000,
            intervals: [2_000],
          })
          .toBe(true);

        const members = DeactivatedTherapistRowsPage.plainNames(
          await boards.expandTeamAndListMembers(TEAM_WITH_A_HIDDEN_MEMBER),
        );
        expect(members.length, `team "${TEAM_WITH_A_HIDDEN_MEMBER}" must reveal members`).toBeGreaterThan(0);

        const teamRows = month.filter((r) => TEAM_WITH_A_HIDDEN_MEMBER === r.teamName);
        const hiddenInTeam = DeactivatedTherapistRowsPage.hiddenByAc2(teamRows).map((r) => r.therapistName);
        expect(hiddenInTeam.length, 'the fixture team must contain a hidden member').toBeGreaterThan(0);

        for (const name of hiddenInTeam) {
          expect(members, `AC2 in the Gruppen view: ${name} must not be listed under its team`)
            .not.toContain(DeactivatedTherapistRowsPage.normalizeName(name));
        }

        // AC5 is "the same rule in every view", so the visible half is checked here too: the team's
        // deactivated member WITH data is still listed.
        const keptInTeam = teamRows
          .filter((r) => !r.active && !hiddenInTeam.includes(r.therapistName))
          .map((r) => r.therapistName);
        for (const name of keptInTeam) {
          expect(members, `AC3 in the Gruppen view: ${name} has data and must be listed`)
            .toContain(DeactivatedTherapistRowsPage.normalizeName(name));
        }

        // Reported, not asserted as correct: the team HEADER's member count is a backend #3210
        // figure, so it keeps counting the row the table no longer paints.
        const headerCount = teamRows.length;
        console.log(
          `team "${TEAM_WITH_A_HIDDEN_MEMBER}": header counts ${headerCount} members, ` +
            `the table paints ${headerCount - hiddenInTeam.length} (${hiddenInTeam.length} hidden by AC2)`,
        );
      },
    );

    test(
      'AC6 — the KPI card still includes the deactivated therapists it no longer counts',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        const dtUi = new DeactivatedTherapistRowsPage(page);
        await dtUi.connect();
        const boards = await dtUi.openManagementMonth();

        const shown = await boards.treatedRevenue();
        const parsed = shown ? Number(shown.replace(/[^\d,]/g, '').replace(/\./g, '').replace(',', '.')) : null;
        const overAll = month.reduce((total, r) => total + (r.revenue ?? 0), 0);
        const overActive = DeactivatedTherapistRowsPage.activeTileRows(month)
          .reduce((total, r) => total + (r.revenue ?? 0), 0);

        // The card must be the full #3210 population, NOT the tiles' active-only one — and in this
        // period those two differ by a real amount, so the check cannot pass by coincidence.
        expect(overAll - overActive, 'the fixture must have deactivated revenue for this to bite').toBeGreaterThan(1);
        expect(parsed, `"Umsatz (behandelt)" reads ${shown}`).toBeCloseTo(overAll, 0);
        console.log(
          `AC6: card ${shown} = sum over all ${month.length} rows (${overAll.toFixed(2)}), ` +
            `which is ${(overAll - overActive).toFixed(2)} more than the active-only sum`,
        );
      },
    );

    test(
      'the tile count and the drill-down it opens are allowed to disagree — by how much',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async () => {
        // AC1 governs the tile counts and AC3 governs the rows, so on this board the two numbers
        // cannot both be satisfied by one figure: a bucket whose deactivated members carry data
        // shows a count LOWER than the number of rows clicking it lists. PR #3584 pre-answers this
        // as by design; it is measured here so the size of the gap is on record rather than
        // discovered by a PM reading the board.
        //
        // Derived from the rows both surfaces are built from rather than by clicking the tile: the
        // rendered counts are already asserted by the AC1 test and the rendered row set by the
        // AC2/AC3 test, so a click here would re-verify neither — and with `actionTimeout` at 0 a
        // click that lands on a mid-repaint board hangs for the whole test budget.
        const gaps: string[] = [];
        for (const key of ['rot', 'gelb', 'gruen', 'grau'] as const) {
          const counted = DeactivatedTherapistRowsPage.activeTileRows(month).filter((r) => key === r.bucket).length;
          const listed = DeactivatedTherapistRowsPage.visibleTableRows(month).filter((r) => key === r.bucket).length;
          if (counted !== listed) {
            gaps.push(`${MANAGEMENT_BUCKET_LABELS[key]}: tile ${counted}, rows ${listed}`);
            // Every gap must be explained by AC3 keeping a deactivated row the tile refuses to
            // count — never by an active therapist going missing from one side.
            const unexplained = DeactivatedTherapistRowsPage.visibleTableRows(month).filter(
              (r) => key === r.bucket && r.active,
            ).length;
            expect(unexplained, `the ${MANAGEMENT_BUCKET_LABELS[key]} gap must be deactivated rows only`).toBe(counted);
            expect(listed, `the ${MANAGEMENT_BUCKET_LABELS[key]} drill-down lists more than its tile counts`)
              .toBeGreaterThan(counted);
          }
        }
        console.log(gaps.length ? `tile-vs-rows gaps: ${gaps.join(' | ')}` : 'no tile-vs-rows gap in this period');
        expect(gaps.length, 'April 2026 has deactivated therapists with data, so a gap must exist')
          .toBeGreaterThan(0);
      },
    );

    test(
      '#3580 regression — the Grau tile on this board reads "keine Personio-Stunden" on both lines',
      { tag: ['@SuperAdmin', '@DeactivatedTherapists', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        // #3580 is stacked on the same call site as #3579 (PR #3584 was based on PR #3583), so a
        // regression in either shows up here. The override is board-local — `labelKeys` AND
        // `rangeKeys` — so the Therapeuten-Orga pill must keep the old wording, which is why
        // `FlowBoardsPage.BUCKETS` still carries it and must not be "fixed" globally.
        const dtUi = new DeactivatedTherapistRowsPage(page);
        await dtUi.connect();
        await dtUi.openManagementMonth();

        const pill = await dtUi.grauPillText();
        expect(pill, 'the Grau pill must be on screen').toBeTruthy();
        expect(pill).toContain('Grau — keine Personio-Stunden');
        expect(pill, 'the sub-label must be relabelled too, not just the title').toContain('keine Personio-Stunden');
        expect(pill, '#3580 removed this wording from the Management board').not.toContain('keine Aktivität');
      },
    );
  });

});
