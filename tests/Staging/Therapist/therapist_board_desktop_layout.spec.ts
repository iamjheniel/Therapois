import { test, expect } from '@playwright/test';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';

/**
 * Therapist Board v2 — desktop table layout.
 *
 * Originally written for RC 3.11 #3362 (narrower columns, six columns moved out of the default set,
 * reordered row actions, a lower table/card breakpoint). Re-verified against the board as it now
 * ships on staging, which moved on from the shape #3362 described:
 *
 *  - **The default set is down to five columns of seventeen** (was seven of eighteen). "Ausst. Datum"
 *    joined the opt-in group, and "Startfrist"/"Gültigkeitsfrist" became ONE picker entry
 *    ("Startfrist / Gültigkeitsfrist") rendering two table columns now headed **"Start"** and
 *    **"Gültig"** — the long header labels are gone.
 *  - **Five more columns became opt-in**: WB/Zi, Versicherungsart, Einrichtung, Bestell Status,
 *    Therapeut, on top of #3362's TB / BF / Frequenz / Beh. Status / VO Status / Folge-VO Status.
 *  - **The table is `data-testid`-tagged**, so columns and the scroll port are addressed directly
 *    instead of by geometry. Per-column width assertions keyed off the old label-anchored probing are
 *    replaced by the invariant the ticket actually cared about — the default set must not overflow —
 *    plus logged widths for the two columns #3362 gave numbers for.
 *
 * AC4 still half-fails: the long-form labels are gone, but a Physiotherapie Befund badges as "P"
 * rather than "PT". That half stays a `fixme`'d defect test.
 *
 * Read-only: this file changes no data. It does reset the board's own column preference
 * (`column-select-therapist-board-v2`) before each test, which is required to see the DEFAULT set at
 * all — that key is per-browser-profile UI state, not backend data.
 *
 * Note on surface: `/therapist/` serves the v2 board, but clicking a patient NAME navigates to the
 * legacy board that the rest of the therapist specs drive. Rows are therefore expanded by clicking a
 * data cell. See `Pages/therapist/therapist.board-v2.page.ts`.
 */

/** Widths #3362 targets for the two columns it named that are still in the default set. */
// #3362 put numbers against two columns. Neither is in the default set any more — v3.11.0 moved
// `medications` (HM) to opt-in and dropped `organizer` from the product entirely — so this guard
// only fires for whichever of them the board actually renders. Which ones were skipped is logged
// rather than passed over silently.
const TARGET_WIDTHS = { medications: 110, organizer: 110 } as const;

test.describe('Therapist Board v2 — desktop table layout', () => {
  test(
    'AC1 — the default column set fits a 1440px viewport with no horizontal scroll',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);
      expect(await board.isTableLayout(), 'the desktop board must render the table layout').toBe(true);

      const headers = await board.headerLabels();
      console.log(`default headers: ${JSON.stringify(headers)}`);
      expect(headers, 'the default column set renders these headers, left to right').toEqual([
        ...TherapistBoardV2Page.DEFAULT_HEADERS,
      ]);

      // The table owns its own horizontal scroll; the document never overflows, so asserting on the
      // window would pass even with the table clipped.
      const table = await board.tableScroll();
      expect(table, 'the table must expose a horizontal scroll container to measure').not.toBeNull();
      console.log(`table scroll: ${JSON.stringify(table)}`);
      expect(
        table!.scrollWidth,
        `the default column set must fit its container at 1440px — needs ${table!.scrollWidth}px, ` +
          `has ${table!.clientWidth}px`,
      ).toBeLessThanOrEqual(table!.clientWidth);

      const doc = await board.documentScroll();
      expect(doc.scrollWidth, 'the page itself must not scroll sideways either').toBeLessThanOrEqual(doc.clientWidth);

      // Per-column widths, logged rather than pinned: the columns are laid out as `flex: 1 0 <basis>`
      // and grow into whatever room the table has spare, so the rendered figure tracks the rail and
      // the row data rather than the column's declared width. The no-overflow assertion above is the
      // invariant #3362 was actually after; these two are the columns it put numbers against.
      const widths: Record<string, number | null> = {};
      for (const key of [...TherapistBoardV2Page.DEFAULT_COLUMN_KEYS, ...Object.keys(TARGET_WIDTHS)])
        widths[key] = await board.columnWidth(key);
      console.log(`column widths: ${JSON.stringify(widths)}`);
      for (const [key, target] of Object.entries(TARGET_WIDTHS)) {
        if (widths[key] == null) {
          console.log(`width target for "${key}" not checked — the board no longer renders it by default`);
          continue;
        }
        expect(
          widths[key],
          `${key} must not have regressed past twice its ${target}px target`,
        ).toBeLessThanOrEqual(target * 2);
      }
    },
  );

  test(
    'AC3 — nine columns are opt-in and stay available in the Spalten picker',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      const options = await board.columnOptions();
      const summary = await board.columnSummary();
      console.log(`picker (${summary}): ${JSON.stringify(options)}`);

      const checked = options.filter((o) => o.checked).map((o) => o.label);
      const unchecked = options.filter((o) => !o.checked).map((o) => o.label);

      expect(checked.sort(), 'the default set is the seven columns the board ships on').toEqual(
        [...TherapistBoardV2Page.DEFAULT_COLUMNS].sort(),
      );

      for (const column of TherapistBoardV2Page.OPT_IN_COLUMNS) {
        expect(
          options.map((o) => o.label),
          `"${column}" must still be offered in the Spalten picker — it is moved out of the default ` +
            `set, not removed from the product`,
        ).toContain(column);
        expect(unchecked, `"${column}" must be off by default`).toContain(column);
      }
      expect(summary, 'the picker reports seven of its sixteen columns on').toBe(
        TherapistBoardV2Page.DEFAULT_SUMMARY,
      );
      expect(
        options.map((o) => o.label),
        'the picker offers every column the board knows about, in order',
      ).toEqual([...TherapistBoardV2Page.ALL_COLUMNS]);

      // The identity columns are not the picker's to switch off.
      for (const fixed of TherapistBoardV2Page.FIXED_HEADERS) {
        expect(
          options.map((o) => o.label),
          `"${fixed}" is a fixed column and must not be offered in the picker`,
        ).not.toContain(fixed);
      }
    },
  );

  test(
    'AC3 — turning an opt-in column back on puts it in the table',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      // The opt-in path is the whole compensation for dropping columns from the default set, so it is
      // guarded rather than assumed: "available in the menu" only counts if checking it actually
      // restores the column.
      expect(await board.headerLabels(), '"Beh. Status" starts hidden').not.toContain('Beh. Status');
      await board.setColumn('Beh. Status', true);

      // Polled: enabling a column re-renders the table, and under load a single read can catch it
      // between renders and see NO headers at all.
      await expect
        .poll(() => board.headerLabels(), {
          timeout: 20_000,
          message: 'enabling an opt-in column must add it to the table',
        })
        .toContain('Beh. Status');
      console.log(`headers after enabling Beh. Status: ${JSON.stringify(await board.headerLabels())}`);
      expect(await board.columnSummary(), 'and the picker counts it').toBe('8/16');
    },
  );

  test(
    'AC3 — the picker writes the checked set to the board preference',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      // A freshly reset board holds no preference at all — the default set is code, not storage.
      expect(await board.storedColumnKeys(), 'a reset board carries no stored column preference').toBeNull();

      await board.setColumn('BF', true);
      const stored = await board.storedColumnKeys();
      console.log(`stored column keys: ${JSON.stringify(stored)}`);
      expect(stored, 'checking a column must persist the whole set by key').toEqual([
        ...TherapistBoardV2Page.DEFAULT_COLUMN_KEYS,
        'bfStatus',
      ]);

      // And it survives a reload — this is the preference the other tests have to reset.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(10_000);
      expect(await board.headerLabels(), 'the enabled column is still there after a reload').toContain('BF');
    },
  );

  test(
    'AC4 — no discipline badge keeps its long-form label',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      await board.setColumn('BF', true);
      expect(await board.headerLabels(), 'the BF column must be on for this assertion').toContain('BF');

      const values = await board.columnCellValues('bfStatus');
      console.log(`BF column values: ${JSON.stringify(values)}`);

      for (const longForm of TherapistBoardV2Page.DISCIPLINE_LONG_FORMS) {
        expect(
          values,
          `the BF column must badge disciplines as PT/ET/L, never as "${longForm}"`,
        ).not.toContain(longForm);
      }
    },
  );

  test(
    'AC4 — a Physiotherapie badge reads "PT"',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.fixme(
        true,
        'DEFECT (found 2026-08-18 on staging v3.11.0, still reproducing 2026-08-20): a Physiotherapie ' +
          'Befund badges as "P", not the "PT" AC4 requires. Not a truncation: the badge text node is ' +
          'the single character "P". Ergotherapie rows do render "ET" correctly, which is why the PM ' +
          'sign-off on 2026-08-16 missed it — it only exercised Ergotherapie rows. Un-fixme once the ' +
          'mapping emits "PT".',
      );
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);
      await board.setColumn('BF', true);

      const badges = await board.bfBadges();
      console.log(`BF badges: ${JSON.stringify(badges)}`);
      test.skip(badges.length === 0, 'no VO on this board carries a Befund badge, so nothing to read');

      for (const { badge, vo } of badges) {
        expect(
          TherapistBoardV2Page.DISCIPLINE_ABBREVIATIONS as readonly string[],
          `VO ${vo} badges its discipline as "${badge}" — AC4 allows only PT / ET / L`,
        ).toContain(badge);
      }
    },
  );

  test(
    'AC5/AC6 — the expanded row leads with the three most-used actions and keeps the rest under Weitere',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      // Expanded by a data cell, not the patient name — the name leaves the v2 board (class docs).
      await board.expandFirstRow();

      const buttons = await board.detailButtons();
      console.log(`expanded-row action bar: ${JSON.stringify(buttons)}`);

      // AC5 — the visible buttons lead with the three most-used actions, in order. The third is
      // spelled out as "Infoblatt" on v3.11.0 (it was the abbreviation "IB"); Production still
      // serves "IB", so both are accepted.
      const [first, second, third] = buttons;
      expect(
        [first, second],
        'the expanded row must lead with Doku erfassen / Aktivität erfassen',
      ).toEqual(['Doku erfassen', 'Aktivität erfassen']);
      expect(
        third,
        'and the Initialbefund action must be the third, as "Infoblatt" or the older "IB"',
      ).toMatch(/^(Infoblatt|IB)$/);
      for (const moved of ['Doku öffnen', 'Protokolle', 'Patienten-Protokolle']) {
        expect(buttons, `"${moved}" must no longer be one of the visible buttons`).not.toContain(moved);
      }
      expect(buttons, 'and the overflow menu closes out the bar').toContain('Weitere');

      // AC6 — and nothing that was possible before is gone; the three moved actions live in Weitere.
      const menu = await board.openWeitere();
      console.log(`Weitere menu: ${JSON.stringify(menu)}`);
      for (const moved of ['Doku öffnen', 'Protokolle', 'Patienten-Protokolle']) {
        expect(menu, `"${moved}" must still be reachable from the Weitere menu`).toContain(moved);
      }
    },
  );

  test(
    'AC7 — a landscape tablet gets the table',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);

      await board.open(1000, 800);
      expect(
        await board.isTableLayout(),
        'a landscape tablet at 1000px must get the table layout, not the card list',
      ).toBe(true);
    },
  );

  // FINDING (live regression, not a spec drift): the responsive CARD LIST is gone. AC7's portrait
  // half required the table/card cutoff to sit between 810px and 900px. Measured on the current
  // staging build the scroll port (`v2-table-scroll-port`, which only the table layout renders) is
  // present at EVERY width probed — 1440, 1000, 900, 850, 810, 760, 700, 620, 600, 560, 480 and
  // 390px — each painting the same 29 rows. There is no width at which the board falls back to
  // cards, so a phone/portrait-tablet therapist now gets a horizontally-scrolling table.
  //
  // Note when re-checking: a bare `isTableLayout()` read is NOT enough. Below 900px `open()` stops
  // waiting for the table (there is meant to be none), so a slow paint reports `false` with
  // `rowCount() === 0` — which is how this first read as "cards at 660px". Gate on rows > 0.
  test.fixme(
    'AC7 — a portrait tablet keeps the card list',
    { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);

      await board.open(810, 1080);
      expect(await board.rowCount(), 'the board must have painted before the layout is read').
        toBeGreaterThan(0);
      expect(
        await board.isTableLayout(),
        'a portrait tablet at 810px must still get the card list',
      ).toBe(false);
    },
  );

  test('AC2 — the other-VO count on the patient cell', { tag: ['@Therapist', '@TBoardV2', '@BoardLayout'] }, async () => {
    test.fixme(
      true,
      'Withdrawn from this ticket by the PM on 2026-08-14: #3386 (same epic) relocates the past-VO ' +
        'count to sit under the VO NUMBER as "N v. VOs" and removes the "#" and expand-chevron rail ' +
        'columns, so a second count on the birth-date line would reintroduce the redundancy the epic ' +
        'is removing. Staging already renders the #3386 form ("▸ 1 v. VO" beneath VO Nr.), so ' +
        'asserting AC2 as written would fail against intended behaviour. Coverage belongs on #3386.',
    );
  });
});
