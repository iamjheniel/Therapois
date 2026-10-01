import { test, expect } from '@playwright/test';
import { SearchVoSortPage as P } from '../../../Pages/admin/admin.search-vo-sort.page';

/**
 * RC 3.15 — #3872 (PR #3883, merged into `release/3.15.0` 2026-09-30): while a search is active on
 * the Admin Board the results sort by VO NUMBER, highest first, instead of by issue date.
 *
 * **Read-only** — every request is a GET; the board is navigated, searched, sorted and read.
 *
 * The ticket is a sort order, so the whole file turns on telling the SHIPPED order apart from the
 * one it replaces. Two of those are available and both are used:
 *
 *  - on the API, `order[voNumber]` against a LEXICOGRAPHIC sort of the same rows — disjoint
 *    wherever a patient has a two-digit sequence, since "9018-10" ranks between "-1" and "-2"
 *    lexicographically and above "-9" numerically;
 *  - on the board, the `order[...]` key in its OWN request, which IS `resolveSort()`'s output.
 */

/** Fixtures, each re-derived from the live population before use. */
const TWO_DIGIT = '7354';   // visible VOs -14 … -9: "-10 above -9" on one page
const BIG = '9634';         // 12 visible VOs, 99/17/16/15/13/11/10/5…1 — maximally discriminating
const MULTI_PATIENT = '901';// matches many patients; AC2 row 3 at scale, and the PM's own step
const TICKET = '9018';      // the ticket's own screenshot patient

test.describe('#3872 Admin Board search results sort by VO number', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  const api = new P(null as any);

  test.beforeAll(async () => { await api.initApi(); });
  test.afterAll(async () => { await api.disposeApi(); });

  // ---------------------------------------------------------------- API half

  test(
    'DEPLOYED: order[voNumber] exists on /v2/prescriptions and on nothing else',
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      // An unknown `order` key is accepted and SILENTLY IGNORED by API Platform (#3449), so a
      // filter that does not exist is indistinguishable from one that does nothing — the probe has
      // to be that desc and asc genuinely differ, against the unknown-key control.
      const desc = await api.voNumbers('itemsPerPage=8&order%5BvoNumber%5D=desc');
      const asc = await api.voNumbers('itemsPerPage=8&order%5BvoNumber%5D=asc');
      const bogus = await api.voNumbers('itemsPerPage=8&order%5BzzzNotAFilter%5D=desc');
      const bogus2 = await api.voNumbers('itemsPerPage=8&order%5BzzzNotAFilter%5D=asc');
      console.log(`  voNumber desc: ${JSON.stringify(desc)}`);
      console.log(`  voNumber asc : ${JSON.stringify(asc)}`);
      console.log(`  unknown key  : ${JSON.stringify(bogus)}`);
      expect(desc, 'voNumber desc and asc are different orders').not.toEqual(asc);
      expect(bogus, 'an unknown order key is ignored, so both directions agree').toEqual(bogus2);
      expect(desc, 'voNumber is not merely the default order').not.toEqual(bogus);

      // The Out of Scope: only the Admin Board changes. The Billing Validation Queue and every
      // other list read the v1 resource, which never got the filter — so it CANNOT inherit VO
      // order, and that is checked rather than argued.
      const v1 = await api.get<any>('/prescriptions?itemsPerPage=6&order%5BvoNumber%5D=desc');
      const v1n = (v1.member ?? []).map((x: any) => x.prescriptionId);
      const v1c = (await api.get<any>('/prescriptions?itemsPerPage=6&order%5BzzzNotAFilter%5D=desc')
        ).member?.map((x: any) => x.prescriptionId);
      console.log(`  v1 /prescriptions voNumber: ${JSON.stringify(v1n)}`);
      expect(v1n, 'the v1 path ignores voNumber exactly like an unknown key').toEqual(v1c);
    },
  );

  test(
    'AC1/AC2: the order is NUMERIC, on fixtures where a lexicographic sort disagrees',
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      for (const q of [TWO_DIGIT, BIG]) {
        const served = await api.voNumbers(P.boardQuery({ search: q, perPage: 60 }));
        const natural = P.natural(served);
        const lex = P.lexicographic(served);
        console.log(`  search ${q}: ${JSON.stringify(served)}`);
        console.log(`    lexicographic would be: ${JSON.stringify(lex)}`);
        // Anti-vacuity: on a patient with no two-digit sequence the two rules agree and the
        // comparison proves nothing, so the fixture has to separate them.
        expect(lex, `${q} must be a fixture the two rules disagree on`).not.toEqual(served);
        expect(served, `${q} is served in natural VO order`).toEqual(natural);
        expect(P.isDescending(served), `${q} is monotonically descending`).toBe(true);
      }

      // AC2 row 2 stated as the ticket states it: "-10 sits above -9".
      const two = await api.voNumbers(P.boardQuery({ search: TWO_DIGIT, perPage: 60 }));
      const i10 = two.indexOf(`${TWO_DIGIT}-10`);
      const i9 = two.indexOf(`${TWO_DIGIT}-9`);
      console.log(`  ${TWO_DIGIT}-10 at ${i10}, ${TWO_DIGIT}-9 at ${i9}`);
      expect(i10, `${TWO_DIGIT}-10 is listed`).toBeGreaterThanOrEqual(0);
      expect(i9, `${TWO_DIGIT}-9 is listed`).toBeGreaterThanOrEqual(0);
      expect(i10, 'the two-digit sequence sorts above the single-digit one').toBeLessThan(i9);
    },
  );

  test(
    "AC2 row 3: each patient's VOs stay together, highest patient number first",
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      const served = await api.voNumbers(P.boardQuery({ search: MULTI_PATIENT, perPage: 60 }));
      const patients = served.map((v) => P.naturalKey(v)[1]);
      const distinct = [...new Set(patients)];
      console.log(`  search ${MULTI_PATIENT}: ${served.length} VOs across ${distinct.length} patients`);
      console.log(`  ${JSON.stringify(served.slice(0, 16))}`);
      expect(distinct.length, 'the search spans several patients, or grouping is vacuous')
        .toBeGreaterThan(3);
      // "stay together" = each patient number occupies one contiguous block.
      expect(distinct.length, "every patient's VOs form one contiguous block")
        .toBe(patients.filter((p, i) => i === 0 || p !== patients[i - 1]).length);
      expect(distinct, 'patients descend by number').toEqual([...distinct].sort((a, b) => b - a));
      expect(P.isDescending(served), 'the whole result descends').toBe(true);
    },
  );

  test(
    'AC1: the order covers the whole result, across page boundaries',
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      const total = await api.totalItems(P.boardQuery({ search: MULTI_PATIENT, perPage: 1 }));
      const perPage = 10;
      const pages = Math.min(3, Math.ceil(total / perPage));
      expect(pages, 'the fixture spans more than one page').toBeGreaterThan(1);
      const all: string[] = [];
      for (let p = 1; p <= pages; p++) {
        const n = await api.voNumbers(P.boardQuery({ search: MULTI_PATIENT, perPage, page: p }));
        console.log(`  page ${p}: ${JSON.stringify(n)}`);
        all.push(...n);
      }
      expect(new Set(all).size, 'no VO is repeated across pages').toBe(all.length);
      expect(P.isDescending(all), 'the order holds ACROSS the page boundaries, not only within a page')
        .toBe(true);
    },
  );

  test(
    'malformed VO numbers sort last in BOTH directions',
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      // No AC covers this; the PR decides it, and the ticket's Developer Reference asks for the
      // decision to be stated. Pinned so a later change to the CASE WHEN is visible.
      const total = await api.totalItems('itemsPerPage=1&order%5BvoNumber%5D=desc');
      const perPage = 10;
      const lastPage = Math.ceil(total / perPage);
      for (const dir of ['desc', 'asc']) {
        const head = await api.voNumbers(`itemsPerPage=${perPage}&order%5BvoNumber%5D=${dir}`);
        const tail = await api.voNumbers(
          `itemsPerPage=${perPage}&page=${lastPage}&order%5BvoNumber%5D=${dir}`);
        console.log(`  ${dir} head: ${JSON.stringify(head.slice(0, 4))}`);
        console.log(`  ${dir} tail: ${JSON.stringify(tail.slice(-4))}`);
        expect(head.filter(P.isMalformed), `no malformed number leads the ${dir} order`).toHaveLength(0);
        expect(tail.every(P.isMalformed), `the ${dir} tail is malformed numbers`).toBe(true);
      }
      console.log(`  book size ${total}`);
    },
  );

  test(
    'the joined-search 500 on order[orderingStatus] is fixed (collateral, #3749)',
    { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
    async () => {
      // PR #3883 also fixed a pre-existing crash: every real Admin Board search left-joins `patient`,
      // and API Platform's QueryChecker misparsed the inlined `CASE WHEN o.orderingStatus …` as the
      // alias "CASE WHEN o". So the combination below — a search AND that order — used to 500.
      const search = `search%5BprescriptionId%5D=${TICKET}&search%5Bpatient.fullName%5D=${TICKET}`;
      for (const order of ['orderingStatus', 'voNumber', 'date']) {
        const code = await api.status(
          `/v2/prescriptions?itemsPerPage=8&${search}&order%5B${order}%5D=desc`);
        console.log(`  joined search + order[${order}]=desc -> ${code}`);
        expect(code, `a joined search with order[${order}] does not crash`).toBe(200);
      }
      // ...and #3749's own ranked order still works without a search, so the alias fix did not
      // quietly disable it.
      const ranked = await api.get<any>(
        '/v2/prescriptions?itemsPerPage=1&order%5BorderingStatus%5D=asc&groups%5B%5D=prescription-list%3Aread');
      const first = (ranked.member ?? [])[0];
      console.log(`  order[orderingStatus]=asc first row: ${first?.prescriptionId}`);
      expect(first, 'the ranked ordering-status sort still returns rows').toBeTruthy();
    },
  );

  // ---------------------------------------------------------------- the board

  test.describe('on the Admin Board', () => {
    let board: P;

    test.beforeAll(async ({ browser }) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      board = new P(page);
      await board.open();
    });

    test(
      'AC1/AC7: a search requests VO order and moves the arrow onto "VO #"',
      { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
      async () => {
        // Without a search: issue date, newest first, with the arrow on "Ausst. Datum" (AC7's
        // second sentence, and #2213's default).
        const before = await board.arrows();
        console.log(`  no search  -> arrows ${JSON.stringify(before)}`);
        expect(before['Ausst. Datum'], 'the default sort marks Ausst. Datum').toBe('↓');
        expect(before['VO #'] ?? null, 'and leaves VO # unmarked').toBeNull();

        board.forget();
        await board.search(TWO_DIGIT);
        const req = board.lastRequest();
        console.log(`  request: ${req}`);
        expect(board.lastOrder(), 'the board asks for VO order while searching').toBe('voNumber:desc');
        expect(req, 'carrying the search it was given').toContain(`search[prescriptionId]=${TWO_DIGIT}`);

        const painted = await board.paintedVos();
        console.log(`  painted: ${JSON.stringify(painted)}`);
        expect(painted.length, 'the search painted rows').toBeGreaterThan(1);
        expect(painted, 'the painted rows are in natural VO order').toEqual(P.natural(painted));
        expect(P.lexicographic(painted), 'and NOT in the lexicographic order they replace')
          .not.toEqual(painted);

        const after = await board.arrows();
        console.log(`  searching  -> arrows ${JSON.stringify(after)}`);
        expect(after['VO #'], 'AC7: the active-sort arrow sits on VO #').toBe('↓');
        expect(after['Ausst. Datum'], 'AC7: and no longer on Ausst. Datum').not.toBe('↓');
      },
    );

    test(
      'AC3: clearing the search returns the list to issue date, newest first',
      { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
      async () => {
        board.forget();
        await board.clearSearchWithX();
        console.log(`  request: ${board.lastRequest() ?? 'NONE (cache hit)'}`);
        expect(await board.searchBox().inputValue(), 'the box is empty').toBe('');

        // Clearing usually fires NOTHING: the unfiltered issue-date query is the one the board
        // loaded with, so React Query serves it from cache. Asserting a request here fails on a
        // correct build — the arrow and the painted rows are the signals that survive a cache hit.
        const arrows = await board.arrows();
        console.log(`  arrows ${JSON.stringify(arrows)}`);
        expect(arrows['Ausst. Datum'], 'the arrow is back on Ausst. Datum').toBe('↓');
        expect(arrows['VO #'] ?? null, 'with VO # unmarked').toBeNull();
        if (board.lastOrder()) expect(board.lastOrder(), 'any request asks for issue date').toBe('date:desc');

        // ...and the rows really are the issue-date list, compared against what the API serves for
        // that order. Without this the test would pass on a board that kept VO order and merely
        // repainted the arrow.
        const painted = await board.paintedVos();
        const expected = await api.voNumbers(
          P.boardQuery({ order: 'order%5Bdate%5D=desc', perPage: 30 }));
        console.log(`  painted : ${JSON.stringify(painted.slice(0, 6))}`);
        console.log(`  API date: ${JSON.stringify(expected.slice(0, 6))}`);
        expect(painted.slice(0, 5), 'the list is back in issue-date order')
          .toEqual(expected.slice(0, 5));
        expect(P.isDescending(painted), 'and is NOT in VO order').toBe(false);
      },
    );

    test(
      'AC4: a column header wins, and its third click returns to VO order',
      { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
      async () => {
        await board.search(BIG);
        expect(board.lastOrder(), 'precondition: VO order').toBe('voNumber:desc');

        board.forget();
        await board.clickHeader('Therapeut');
        console.log(`  click 1 -> ${board.lastOrder()}`);
        expect(board.lastOrder(), 'the chosen column wins over the search default')
          .toBe('therapist.lastName:asc');

        board.forget();
        await board.clickHeader('Therapeut');
        console.log(`  click 2 -> ${board.lastOrder()}`);
        expect(board.lastOrder(), 'the second click flips the direction')
          .toBe('therapist.lastName:desc');

        // The third click clears the header sort. It fires NO request — the client already holds
        // that exact query from before the first click — so the ARROW is the signal here, not the
        // network. Asserting a request would fail on a correct build.
        board.forget();
        await board.clickHeader('Therapeut');
        const arrows = await board.arrows();
        console.log(`  click 3 -> request ${board.lastOrder() ?? 'NONE (cache hit)'}; arrows ${JSON.stringify(arrows)}`);
        expect(arrows['VO #'], 'the third click returns to VO order while the search is active')
          .toBe('↓');
        expect(arrows['Therapeut'], 'and releases the Therapeut column').toBe('↕');
        const painted = await board.paintedVos();
        console.log(`  painted: ${JSON.stringify(painted)}`);
        expect(painted, 'the rows are back in natural VO order').toEqual(P.natural(painted));
      },
    );

    test(
      'AC5: a chosen column survives typing a search and clearing it',
      { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
      async () => {
        board.forget();
        await board.clickHeader('Therapeut');
        console.log(`  chose Therapeut -> ${board.lastOrder() ?? 'NONE (cache hit)'}`);
        // The glyph follows the DIRECTION: an ascending sort paints "↑", a descending one "↓".
        // Asserting "↓" for an asc sort fails on a correct build (it did here).
        expect((await board.arrows())['Therapeut'], 'the column is now the active sort').toBe('↑');
        expect((await board.arrows())['VO #'] ?? null, 'and VO # is released').toBeNull();

        board.forget();
        await board.search(MULTI_PATIENT);
        console.log(`  typed a search -> ${board.lastOrder()}`);
        expect(board.lastOrder(), 'typing a search keeps the header sort')
          .toBe('therapist.lastName:asc');

        board.forget();
        await board.clearSearchWithX();
        console.log(`  cleared it     -> ${board.lastOrder()}`);
        expect(board.lastOrder(), 'and clearing it keeps the header sort too')
          .toBe('therapist.lastName:asc');
        expect((await board.arrows())['Therapeut'], 'the arrow stays on Therapeut, pointing up for asc')
          .toBe('↑');
        expect((await board.arrows())['VO #'] ?? null, 'and never moves to VO #').toBeNull();
      },
    );

    test(
      'AC6: the rule holds on every tab, and at phone width',
      { tag: ['@SuperAdmin', '@SearchVoSort', '@ReadOnly'] },
      async () => {
        // Release the header sort from the previous test, or every tab would carry it (correctly).
        await board.clickHeader('Therapeut');
        await board.clickHeader('Therapeut');
        await board.search(MULTI_PATIENT);
        expect(board.lastOrder(), 'precondition: VO order').toBe('voNumber:desc');

        const seen: Record<string, string> = {};
        let painted = 0;
        for (const tab of P.TABS) {
          if ((await board.ui.getByText(tab, { exact: true }).count()) === 0) {
            console.log(`  ${tab}: NOT OFFERED`);
            continue;
          }
          board.forget();
          await board.selectTab(tab);
          // A tab that is already active serves from cache and fires nothing; a tab the search
          // matches NOTHING on paints no table at all, so it has no header row and therefore no
          // arrow to read — which is not the feature failing. Assert the request where one fired,
          // the arrow where there is a table, and count how many of each.
          const order = board.lastOrder();
          const arrows = await board.arrows();
          const hasTable = 'VO #' in arrows;
          const arrow = arrows['VO #'] ?? null;
          console.log(`  ${tab.padEnd(22)} -> ${order ?? 'NONE (cache hit)'}  table ${hasTable}  VO# arrow ${arrow}`);
          seen[tab] = order ?? 'cache';
          if (order) expect(order, `${tab} keeps VO order`).toBe('voNumber:desc');
          if (hasTable) { expect(arrow, `${tab} shows the VO-order arrow`).toBe('↓'); painted++; }
        }
        expect(Object.keys(seen).length, 'all seven tabs were exercised').toBe(P.TABS.length);
        expect(Object.values(seen).filter((v) => v === 'voNumber:desc').length,
          'at least most tabs issued a real request').toBeGreaterThan(3);
        expect(painted, 'and several of them actually painted a table to read the arrow from')
          .toBeGreaterThan(2);

        // The phone card layout reads the same list through the same hook, so the request is the
        // assertion; the painted cards confirm it rendered.
        await board.ui.setViewportSize({ width: 400, height: 900 });
        await board.settle(45_000);
        board.forget();
        await board.selectTab('Alle VOs');
        const text = await board.ui.locator('#root').innerText();
        console.log(`  phone width -> ${board.lastOrder() ?? 'NONE (cache hit)'}`);
        expect(text, 'the phone layout still shows the searched VOs')
          .toMatch(new RegExp(`\\b\\d*${MULTI_PATIENT}-\\d+`));
        if (board.lastOrder()) expect(board.lastOrder()).toBe('voNumber:desc');
        await board.ui.setViewportSize({ width: 1920, height: 1080 });
      },
    );
  });
});
