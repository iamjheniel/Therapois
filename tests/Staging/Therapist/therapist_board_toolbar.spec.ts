import { test, expect } from '@playwright/test';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';

/**
 * Therapist Board v2 — the controls around the table.
 *
 * Covers the surfaces the layout spec (`therapist_board_desktop_layout.spec.ts`) doesn't: the board
 * header summary, the "Meine VOs" / "Geteilte VOs" / "Kalender" tabs with their badge counts, the
 * "Hinweise" reminder button, the "Filter" panel (Einrichtung / VO Status / Behandlungslücke, all
 * rendered inline as buttons rather than as dropdowns) and the collapsible
 * "Aktive Patienten" / "Inaktive Patienten" row groups.
 *
 * Read-only: nothing here documents a treatment, orders a VO or edits a patient. The only state it
 * touches is the board's own column preference, which `open()` resets, and its filter selection,
 * which is per-visit and cleared again before the test ends.
 *
 * Both the filter and the tab tests are data-gated — this therapist's board has to actually hold
 * shared VOs / an inactive group for those to mean anything — and skip cleanly when it doesn't.
 */
test.describe('Therapist Board v2 — toolbar and tabs', () => {
  test(
    'The board summarises its own VO counts and the tabs agree with it',
    { tag: ['@Therapist', '@TBoardV2', '@BoardToolbar'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      const summary = await board.summary();
      expect(summary, 'the board heading must summarise "N VOs · M aktiv"').not.toBeNull();
      console.log(`summary: ${JSON.stringify(summary)}`);
      expect(summary!.total, 'a therapist with a board has VOs on it').toBeGreaterThan(0);
      expect(summary!.active, 'and no more active ones than it has in total').toBeLessThanOrEqual(
        summary!.total,
      );

      // "Meine VOs" badges the ACTIVE count, not the total. (It used to badge the total; on the
      // current build the heading reads e.g. "69 VOs · 29 aktiv" and the tab badges 29 — which is
      // also exactly what the table paints, the inactive group shipping collapsed.)
      expect(
        await board.tabCount('Meine VOs'),
        'the "Meine VOs" tab badges the heading\'s ACTIVE count',
      ).toBe(summary!.active);

      // The active group holds exactly the "aktiv" count, and it is what the table paints. Polled
      // rather than read once: the counts land from separate renders, so under load a single read can
      // catch the board mid-update.
      const activeGroup = await board.groupCount('Aktive Patienten');
      console.log(`Aktive Patienten group: ${activeGroup}, rows painted: ${await board.rowCount()}`);
      expect(activeGroup, 'the active group badges the heading\'s active count').toBe(summary!.active);
      await expect
        .poll(() => board.rowCount(), {
          timeout: 20_000,
          message: 'the table paints one row per active VO',
        })
        .toBe(activeGroup);
    },
  );

  test(
    'The tabs and the Hinweise button are all reachable',
    { tag: ['@Therapist', '@TBoardV2', '@BoardToolbar'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      for (const label of TherapistBoardV2Page.TABS) {
        await expect(board.tab(label), `the "${label}" tab must be offered`).toBeVisible();
      }
      await expect(board.hinweise(), 'the "Hinweise" reminder button must be offered').toBeVisible();
      console.log(`Hinweise badge: ${await board.hinweiseCount()}`);

      // The offline queue reports its own state on this board — the therapist has to be able to see
      // whether their documentation has actually been sent.
      const sync = await board.syncStatus();
      console.log(`sync status: ${sync}`);
      expect(sync, 'the board must report the offline queue state').toMatch(/^Stand von/);

      // Switching to "Geteilte VOs" re-scopes the table to the shared ones.
      const shared = await board.tabCount('Geteilte VOs');
      console.log(`Geteilte VOs badge: ${shared}`);
      test.skip(!shared, 'no VO is shared with this therapist, so there is nothing to switch to');

      await board.openTab('Geteilte VOs');
      const sharedRows = await board.rowCount();
      console.log(`Geteilte VOs rows painted: ${sharedRows}`);
      // The badge counts every shared VO; the table paints only the expanded groups, so a collapsed
      // "Inaktive Patienten" group legitimately leaves fewer rows on screen than the badge.
      expect(sharedRows, 'the shared tab must paint rows, never more than its badge').toBeGreaterThan(0);
      expect(sharedRows).toBeLessThanOrEqual(shared);

      await board.openTab('Meine VOs');
      await expect
        .poll(async () => (await board.rowCount()) === (await board.groupCount('Aktive Patienten')), {
          timeout: 20_000,
          message: 'switching back restores the therapist\'s own VOs',
        })
        .toBe(true);
    },
  );

  test(
    'The Filter panel narrows the board and clears back',
    { tag: ['@Therapist', '@TBoardV2', '@BoardFilters'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      const unfiltered = await board.rowCount();
      expect(unfiltered, 'the board must hold rows to filter').toBeGreaterThan(0);

      const sections = await board.filterSections();
      console.log(`filter sections: ${JSON.stringify(sections)}`);
      // The section headings are CSS-uppercased but read out of `innerText`, so they arrive upper-case.
      for (const section of ['EINRICHTUNG', 'VO STATUS', 'BEHANDLUNGSLÜCKE']) {
        expect(sections, `the panel must offer a "${section}" section`).toContain(section);
      }
      expect(
        await board.filterResultCount(),
        'an unfiltered panel previews the whole board',
      ).toBeGreaterThan(0);
      await board.closeFilterPanel();

      // "Seit 14+ Tagen unbehandelt" is the treatment-gap filter — the reason a therapist opens this
      // panel at all. It can legitimately match everything or nothing, so assert it never widens.
      await board.applyFilter('Seit 14+ Tagen unbehandelt');
      const filtered = await board.rowCount();
      console.log(`rows: ${unfiltered} unfiltered → ${filtered} with the 14-day gap filter`);
      expect(filtered, 'a filter must never widen the board').toBeLessThanOrEqual(unfiltered);

      await board.clearFilters();
      await expect
        .poll(() => board.rowCount(), {
          timeout: 30_000,
          message: '"Alle löschen" restores the full board',
        })
        .toBe(unfiltered);
    },
  );

  test(
    'Rows are grouped into active and inactive patients',
    { tag: ['@Therapist', '@TBoardV2', '@BoardToolbar'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1440, 900);

      // The active group is always there; the inactive one only when the therapist has such VOs.
      await expect(board.group('Aktive Patienten'), 'the active group must be rendered').toBeVisible();
      const active = await board.groupCount('Aktive Patienten');
      expect(active, 'and it must badge how many VOs it holds').toBeGreaterThan(0);

      const inactiveVisible = await board
        .group('Inaktive Patienten')
        .isVisible()
        .catch(() => false);
      console.log(`Inaktive Patienten group present: ${inactiveVisible}`);
      test.skip(!inactiveVisible, 'this therapist has no inactive patients to group');

      // The inactive group ships collapsed — only the active rows are painted up front, which is the
      // point of the grouping.
      await expect
        .poll(() => board.rowCount(), {
          timeout: 20_000,
          message: 'only the active group is painted while the inactive one stays collapsed',
        })
        .toBe(active);
    },
  );
});
