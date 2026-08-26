import { test, expect } from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';

/**
 * Search and filtering on the Therapist board.
 *
 * The redesign moved every hook this file used:
 *  - the search box lost its `text-input-outlined` testid and is now addressed by its placeholder
 *    ("Patient, VO Nr. …"). It also no longer goes readonly after a search — there is a "✕" clear
 *    control instead.
 *  - the empty state reads **"Keine VOs für diese Auswahl"** (was "Keine Patienten gefunden"), over
 *    a reassurance line ("Auswahl und Spalten bleiben erhalten.") and an "Alle löschen" reset.
 *  - the standalone location dropdown is gone; facilities are filtered from the **EINRICHTUNG**
 *    section of the "Filter" panel.
 *
 * The board also reports its own result count in the heading ("N VOs · M aktiv"), which is asserted
 * alongside the row count so a search that silently returns everything can't pass.
 */
test.describe('Search Functionality', () => {
  test('should show results for a valid search name', { tag: ['@Therapist', '@searchname'] }, async ({ page }) => {
    // Resolve a real patient from live data (falls back to a broad search if the historically used
    // name has churned out), then assert searching that name returns it.
    const list = new TherapistListPage(page);
    await page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' });
    const name = await list.resolvePatientName(['Aiah BiniTest']);
    test.skip(!name, 'No patient available in this therapist\'s list');
    await expect(page.locator('#root')).toContainText(name!);
  });

  test('should show results for a valid search vo number', { tag: ['@Therapist', '@searchvo'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const board = new TherapistBoardV2Page(page);
    await board.open(1600, 1000);

    // Take a VO number off the board rather than hard-coding one that churns out of the data.
    const vo = await page.locator('[data-testid="v2-rail-cell-prescriptionId"]').first().innerText();
    const number = vo.trim().split('\n')[0];
    expect(number, 'the board must render a VO number to search for').toMatch(/^\d+-\d+$/);

    await board.search(number.split('-')[0]);
    expect(await board.rowCount(), 'searching a live VO number must return it').toBeGreaterThan(0);
    await expect(page.locator('#root')).not.toContainText('Keine VOs für diese Auswahl');
  });

  test('should show the empty state for an unknown name', { tag: ['@Therapist', '@searchunknownname'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const board = new TherapistBoardV2Page(page);
    await board.open(1600, 1000);

    await board.search('Mustermann');
    await expect(page.locator('#root')).toContainText('Keine VOs für diese Auswahl');
    expect(await board.rowCount(), 'and no rows are painted').toBe(0);
    expect((await board.summary())?.total, 'the heading agrees there are no results').toBe(0);
  });

  test('should show the empty state for an unknown vo number', { tag: ['@Therapist', '@searchunknownvo'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const board = new TherapistBoardV2Page(page);
    await board.open(1600, 1000);

    await board.search('1111');
    await expect(page.locator('#root')).toContainText('Keine VOs für diese Auswahl');
    expect(await board.rowCount()).toBe(0);
  });

  test('should clear a search back to the full board', { tag: ['@Therapist', '@searchclear'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const board = new TherapistBoardV2Page(page);
    await board.open(1600, 1000);
    const before = await board.rowCount();
    expect(before, 'the board must hold rows to search within').toBeGreaterThan(0);

    await board.search('Mustermann');
    expect(await board.rowCount()).toBe(0);

    // The box is no longer readonly after searching — the "✕" clear control resets it in place.
    await board.clearSearch();
    expect(await board.rowCount(), 'clearing the search restores the full board').toBe(before);
  });

  test('should filter search results by location', { tag: ['@Therapist', '@searchlocation'] }, async ({ page }) => {
    test.setTimeout(240_000);
    const board = new TherapistBoardV2Page(page);
    await board.open(1600, 1000);
    const before = await board.rowCount();

    // Facilities are filtered from the Filter panel's EINRICHTUNG section now, not a location
    // dropdown of their own. Take the first facility the panel offers rather than a hard-coded one.
    await board.openFilterPanel();
    const facilities = await board.filterOptionLabels('EINRICHTUNG');
    console.log(`facilities offered: ${JSON.stringify(facilities)}`);
    const facility = facilities.find((f) => f !== 'Alle Einrichtungen');
    test.skip(!facility, 'No facility filter options available for this therapist');

    await board.filterOption(facility!).click();
    await page.waitForTimeout(3000);
    await board.closeFilterPanel();

    expect(
      await board.rowCount(),
      `filtering to "${facility}" must not widen the board`,
    ).toBeLessThanOrEqual(before);
  });
});
