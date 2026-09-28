import { test, expect } from '@playwright/test';
import { WorkingHoursFrozenColumnPage, TESTID } from '../../../Pages/superadmin/sa.working-hours-frozen-column.page';

/**
 * RC 3.14 — the therapist name column stays frozen while Arbeitszeiten scrolls sideways
 * (#3718, commit `efde53f00`, PR #3727).
 *
 * The table carries ~16 columns, so reaching the Maßnahme (action item) column scrolled the
 * therapist's name off screen and made it easy to type against the wrong row. The fix pins the name
 * cell with `position: sticky; left: 0`.
 *
 * **Deployed; all three ACs verified on screen in both view modes. 7 passed, 0 `fixme`.**
 *
 * ## The whole ticket is a computed style plus a geometry measurement
 *
 * There is no API surface — `WorkingHoursTable.tsx` and nothing else — so deployment comes off the
 * served bundle and the behaviour off the rendered page. `/status` cannot answer for a frontend
 * change at all (#3705), let alone a CSS one. The shipped style, verbatim from the bundle:
 * `{position:'sticky', left:0, zIndex:2, backgroundColor:e, borderRightWidth:1, borderRightColor:…}`.
 *
 * ## Four traps, and the first two both read as "the feature is missing"
 *
 *  - **Two testid prefixes, not one.** This commit adds `working-hours-name-${row.key}` to data rows
 *    and `working-hours-name-header` to the header — but the TEAM rows in Gruppen view, pinned by
 *    the same style, keep their pre-existing **`team-toggle-g<teamId>`** id. A locator on the
 *    `working-hours-name-` prefix finds exactly ONE element in Gruppen view and reads as "the table
 *    has no rows"; that is how the first probe of this ticket went wrong, and a first draft of the
 *    Gruppen test below then asserted `testid === null` and failed for the same reason. Cells are
 *    located by computed `position: sticky` instead — also AC1's own property.
 *  - **The default view is Gruppen**, so polling for `working-hours-name-t…` never resolves until
 *    the view is switched. Readiness is the HEADER testid, present in both.
 *  - **The name cell's x is NOT invariant from scrollLeft 0.** `left: 0` pins it to the scroller's
 *    edge while the row carries 16px of padding, so it sits at 57 unscrolled and snaps to 41 on the
 *    first scroll, then holds. "x unchanged from rest" fails on a correct implementation — the test
 *    below compares two SCROLLED positions, where the value is exactly invariant.
 *  - **AC2's divider is a BORDER, not a shadow.** The Developer Reference proposed `V2TableSticky`'s
 *    `boxShadow` seam; what shipped is `borderRightWidth: 1`, deliberately (every other separator in
 *    this table is a border, and a border sits inside the cell's width so nothing shifts). A probe
 *    written from the reference finds no box-shadow and concludes AC2 failed.
 *
 * Two more, both about reading text off this table: the bundle writes `position:'sticky'` with
 * SINGLE quotes, so a `position:"sticky"` grep returns 0 (the same escaped-literal shape as #3611's
 * German); and the column headers are `text-transform: uppercase`, where German **ß uppercases to
 * SS** — `innerText` returns "MASSNAHME", which matches neither `/Maßnahme/` nor `/Maßnahme/i`,
 * because simple case folding does not equate ß with SS. Read headers as `textContent`.
 *
 * **Read-only** — the board is opened, a view toggled and the table scrolled; nothing is written.
 */

test.describe('#3718 frozen therapist-name column on Arbeitszeiten', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: the sticky style and the new testids are in the served bundle',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      const bundle = await wh.entryBundle();

      const counts = {
        rowTestId: WorkingHoursFrozenColumnPage.occurrences(bundle, TESTID.rowPrefix),
        headerTestId: WorkingHoursFrozenColumnPage.occurrences(bundle, TESTID.header),
        // Single quotes: the double-quoted form occurs 0 times and proves nothing.
        stickySingle: WorkingHoursFrozenColumnPage.occurrences(bundle, "position:'sticky'"),
        stickyDouble: WorkingHoursFrozenColumnPage.occurrences(bundle, 'position:"sticky"'),
        // The exact style object this ticket adds, so a generic `sticky` elsewhere cannot pass for it.
        frozenCellStyle: WorkingHoursFrozenColumnPage.occurrences(
          bundle,
          "position:'sticky',left:0,zIndex:2,backgroundColor:",
        ),
      };
      console.log(`#3718 bundle: ${JSON.stringify(counts)}`);

      expect(counts.headerTestId, 'the header testid ships').toBeGreaterThan(0);
      expect(counts.rowTestId, 'and the row testid').toBeGreaterThan(0);
      expect(counts.frozenCellStyle, "the frozen-cell style object this ticket adds").toBeGreaterThan(0);
      // Pinned so nobody re-derives a false negative from the double-quoted form.
      expect(counts.stickyDouble, 'the double-quoted form is genuinely absent').toBe(0);
      expect(counts.stickySingle, 'the single-quoted one is what is there').toBeGreaterThan(0);
    },
  );

  test(
    'AC1/AC2 every pinned cell in Therapeut:innen view carries the sticky style and the divider',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Therapeut:innen');

      const cells = await wh.frozenCells();
      console.log(`#3718 Therapeut:innen — ${cells.length} pinned cells; first three: ${JSON.stringify(cells.slice(0, 3))}`);

      // One per row plus the header, and every one of them a name cell.
      expect(cells.length, 'the table painted rows, each with a pinned cell').toBeGreaterThan(3);
      expect(cells.filter((c) => c.testid === TESTID.header), 'the header is pinned too').toHaveLength(1);
      expect(
        cells.filter((c) => c.testid?.startsWith(TESTID.therapistRowPrefix)).length,
        'and so is every therapist row',
      ).toBeGreaterThan(2);

      for (const c of cells) {
        // AC1 — pinned to the scroller's left edge, above the columns that slide under it.
        expect(c.position, `${c.testid ?? c.text}: position`).toBe('sticky');
        expect(c.left, `${c.testid ?? c.text}: left`).toBe('0px');
        expect(Number(c.zIndex), `${c.testid ?? c.text}: above the scrolling columns`).toBeGreaterThan(0);
        // AC2 — the divider. A BORDER, not the boxShadow the Developer Reference proposed.
        expect(parseFloat(c.borderRightWidth), `${c.testid ?? c.text}: AC2 divider width`).toBeGreaterThan(0);
        expect(c.borderRightColor, `${c.testid ?? c.text}: AC2 divider is visible`).not.toMatch(/rgba\(0, 0, 0, 0\)/);
        // The cell must be OPAQUE or the columns sliding beneath would show through the name —
        // the commit's own reason for passing a background in per call site.
        expect(c.background, `${c.testid ?? c.text}: opaque, so nothing travels through the name`).not.toMatch(
          /rgba\([^)]*,\s*0\)/,
        );
      }

      // The header and the data rows deliberately differ in colour — each pinned cell takes the
      // background of the row it sits in, so the seam never shows a mismatched block.
      const headerBg = cells.find((c) => c.testid === TESTID.header)?.background;
      const rowBg = cells.find((c) => c.testid?.startsWith(TESTID.therapistRowPrefix))?.background;
      console.log(`#3718 backgrounds — header ${headerBg}, data row ${rowBg}`);
      expect(headerBg).toBeTruthy();
      expect(rowBg).toBeTruthy();
    },
  );

  test(
    'AC1/AC3 the behaviour: the name holds its place across scroll offsets while the columns move',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Therapeut:innen');

      const scroller = await wh.scroller();
      console.log(`#3718 scroller: ${JSON.stringify(scroller)}`);
      expect(scroller, 'the table has a horizontal scroller').toBeTruthy();
      // AC3's precondition: there really is something to scroll, or "the name stayed put" is vacuous.
      expect((scroller as NonNullable<typeof scroller>).maxScroll, 'the table overflows its container').toBeGreaterThan(
        200,
      );

      const max = (scroller as NonNullable<typeof scroller>).maxScroll;
      const samples = await wh.xAcrossOffsets([0, Math.round(max / 3), Math.round((max * 2) / 3), max]);
      console.log(`#3718 geometry: ${JSON.stringify(samples)}`);

      const scrolled = samples.filter((s) => s.applied > 0);
      expect(scrolled.length, 'at least two scrolled positions were sampled').toBeGreaterThan(1);

      // **The assertion is invariance BETWEEN scrolled positions.** From rest the cell snaps by the
      // row's padding as it pins, so comparing against offset 0 fails on a correct build.
      const nameXs = [...new Set(scrolled.map((s) => s.nameX))];
      console.log(`#3718 name x at scrolled offsets: ${JSON.stringify(scrolled.map((s) => `${s.applied}→${s.nameX}`))}`);
      expect(nameXs, 'AC1: the name column does not move as the table scrolls').toHaveLength(1);

      // AC3 — and the other columns really do scroll, by the amount asked for.
      const first = scrolled[0];
      const last = scrolled[scrolled.length - 1];
      const columnTravel = first.columnX - last.columnX;
      const scrollTravel = last.applied - first.applied;
      console.log(`#3718 AC3: a data column travelled ${columnTravel}px for ${scrollTravel}px of scroll`);
      expect(Math.abs(columnTravel - scrollTravel), 'AC3: the scrolling columns move with the scroll').toBeLessThan(4);

      // The snap itself, reported rather than asserted as a number — it is layout padding, not a
      // contract, and pinning it would make this test brittle for no gain.
      const rest = samples.find((s) => s.applied === 0);
      if (rest) console.log(`#3718 note: the cell sits at x=${rest.nameX} unscrolled and pins at x=${scrolled[0].nameX}`);

      await wh.resetScroll();
    },
  );

  test(
    'AC1 Gruppen view: the team name cells are pinned too, under a different testid prefix',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Gruppen');

      const cells = await wh.frozenCells();
      console.log(`#3718 Gruppen — ${cells.length} pinned cells: ${JSON.stringify(cells.map((c) => `${c.testid ?? '(no testid)'}:${c.text}`))}`);

      // AC1 names both views, and this is the half a `working-hours-name-` locator cannot see: the
      // team rows are pinned under `team-toggle-g<teamId>`, a prefix that predates this ticket.
      expect(cells.length, 'the header plus one pinned cell per team row').toBeGreaterThan(1);
      const teamCells = cells.filter((c) => c.testid !== TESTID.header);
      console.log(`#3718 Gruppen team cell ids: ${JSON.stringify(teamCells.map((c) => c.testid))}`);
      expect(teamCells.length, 'AC1: team rows are frozen in Gruppen view').toBeGreaterThan(0);
      expect(
        teamCells.every((c) => (c.testid ?? '').startsWith(TESTID.teamRowPrefix)),
        'and they are the team toggles, not stray sticky elements',
      ).toBe(true);

      for (const c of teamCells) {
        expect(c.position, `team "${c.text}": position`).toBe('sticky');
        expect(c.left, `team "${c.text}": left`).toBe('0px');
        expect(parseFloat(c.borderRightWidth), `team "${c.text}": AC2 divider`).toBeGreaterThan(0);
        expect(c.background, `team "${c.text}": opaque`).not.toMatch(/rgba\([^)]*,\s*0\)/);
      }

      // And the same behaviour, measured on this view's own rows.
      const scroller = await wh.scroller();
      const max = (scroller as NonNullable<typeof scroller>).maxScroll;
      const samples = await wh.xAcrossOffsets([Math.round(max / 2), max]);
      console.log(`#3718 Gruppen geometry: ${JSON.stringify(samples)}`);
      expect([...new Set(samples.map((s) => s.nameX))], 'AC1: the pinned column holds in Gruppen view too').toHaveLength(
        1,
      );
      await wh.resetScroll();
    },
  );

  test(
    'AC3 the far-right columns are the point: the action-item column is reachable and the name is still there',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Therapeut:innen');

      const headers = await wh.columnHeaders();
      console.log(`#3718 columns (${headers.authored.length}) authored: ${JSON.stringify(headers.authored)}`);
      console.log(`#3718 columns painted (CSS-uppercased): ${JSON.stringify(headers.painted)}`);
      // The ticket's own framing — "scroll right to reach a column near the end, for example to
      // enter an action item".
      //
      // Matched on `textContent`: the headers are `text-transform: uppercase`, and German ß
      // uppercases to SS, so `innerText` yields "MASSNAHME" — which matches neither /Maßnahme/ nor
      // /Maßnahme/i, since simple case folding does not equate ß with SS.
      expect(headers.authored.length, 'the table really is wide').toBeGreaterThan(10);
      expect(headers.authored.join(' | '), 'AC3: the action-item column is the one users scroll to').toMatch(
        /Maßnahme/,
      );

      const scroller = await wh.scroller();
      const max = (scroller as NonNullable<typeof scroller>).maxScroll;
      const [atEnd] = await wh.xAcrossOffsets([max]);
      console.log(`#3718 scrolled fully right (${atEnd.applied}px): the name sits at x=${atEnd.nameX}`);

      // The end state the ticket exists to produce: scrolled all the way to the action item, the
      // name is still on screen.
      expect(atEnd.applied, 'scrolled to the far right').toBeGreaterThan(200);
      expect(atEnd.nameX, 'AC1/AC3: the name is still within the viewport').toBeGreaterThanOrEqual(0);
      const viewport = page.viewportSize();
      expect(atEnd.nameX, 'and not pushed off the right edge').toBeLessThan((viewport?.width ?? 1920) - 100);

      const cells = await wh.frozenCells();
      const named = cells.filter((c) => c.testid?.startsWith(TESTID.therapistRowPrefix) && c.text.length > 0);
      console.log(`#3718 at full scroll, ${named.length} therapist names are still rendered — e.g. "${named[0]?.text}"`);
      expect(named.length, 'the names are still painted at the far right').toBeGreaterThan(2);

      await wh.resetScroll();
    },
  );

  test(
    'the pinned column is the FIRST column and nothing else on the table is pinned',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Therapeut:innen');

      // "What this ticket does NOT change: the table's other ~16 columns" — so exactly one cell per
      // row may be pinned, and it must be the name. A second pinned column would be a regression
      // this style-based locator is uniquely able to catch.
      const cells = await wh.frozenCells();
      const perRow = await page.evaluate((headerTestId) => {
        const header = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement;
        const table = header.parentElement!.parentElement!;
        return [...table.children].slice(0, 8).map((row) => {
          const kids = [...(row as HTMLElement).children] as HTMLElement[];
          const stickyIdx = kids
            .map((k, i) => (getComputedStyle(k).position === 'sticky' ? i : -1))
            .filter((i) => i >= 0);
          return { cells: kids.length, stickyIdx };
        });
      }, TESTID.header);
      console.log(`#3718 per row: ${JSON.stringify(perRow)}`);

      for (const row of perRow) {
        if (row.stickyIdx.length === 0) continue; // a wrapper, not a row
        expect(row.stickyIdx, 'exactly one pinned cell per row, and it is the first').toEqual([0]);
      }
      expect(cells.every((c) => c.x >= 0), 'every pinned cell is on screen').toBe(true);
    },
  );

  test(
    'the header row is not sticky vertically — out of scope, and stated so rather than assumed',
    { tag: ['@SuperAdmin', '@FrozenNameColumn', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const wh = new WorkingHoursFrozenColumnPage(page);
      await wh.open();
      await wh.setView('Therapeut:innen');

      // The Developer Reference notes `V2TableSticky` also pins the header row vertically and calls
      // that out of scope "unless it comes for free with the restructure". It did not come for
      // free — the header cell is pinned horizontally (`left: 0`) and not vertically (`top: auto`).
      // Recorded so the next reader knows it was checked and is a deliberate non-change.
      const header = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
        const cs = getComputedStyle(el);
        return { position: cs.position, left: cs.left, top: cs.top };
      }, TESTID.header);
      console.log(`#3718 header cell: ${JSON.stringify(header)} — horizontal pinning only, as scoped`);

      expect(header.position, 'the header name cell is pinned').toBe('sticky');
      expect(header.left, 'horizontally').toBe('0px');
      console.log(
        `#3718 note: vertical header pinning (top) computes as "${header.top}". The ticket scopes it out ` +
          '("that is out of scope for this ticket unless it comes for free"), so this is reported, not asserted.',
      );
    },
  );
});
