import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * Admin Board (Flow) — the top-bar and pager controls that the other dashboard specs
 * (admin_checkcolumns / admin_search / admin_pagination) don't cover:
 *   - the free-text search box ("Patient, VO-Nr. suchen …"), by VO number and by patient name
 *   - the summary status pills that double as quick filters
 *   - the "Filter" panel: its live "N VOs anzeigen" preview, its applied-filter badge, "Filter löschen"
 *   - the "Folge-VO Status" filter, which lives inside that panel
 *   - the "Spalten" column chooser (hide/show a column)
 *   - the "Zeilen pro Seite" page-size selector
 *
 * Staging only. Uses live data captured from the first row rather than hard-coded patients so it
 * survives data churn.
 */
test.describe('Admin Dashboard Controls', () => {
  test.describe.configure({ mode: 'serial' });

  let dash: AdminDashboardPage;

  test.beforeEach(async ({ page }) => {
    dash = new AdminDashboardPage(page);
    await dash.open();
  });

  test('Free-text search by VO number narrows the list to the matching VO', {
    tag: ['@Admin', '@DashboardSearch'],
  }, async ({ page }) => {
    const before = await dash.totalCount();
    expect(before).toBeGreaterThan(0);

    const vo = await dash.firstRowVoNumber();
    expect(vo, 'expected at least one VO number in the first row').not.toBeNull();
    // Search on the numeric core (before the "-suffix"), which the box matches.
    const query = vo!.split('-')[0];

    await dash.search(query);

    const after = await dash.totalCount();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    await expect(page.locator('#root')).toContainText(query);
  });

  test('Free-text search by patient name narrows the list to that patient', {
    tag: ['@Admin', '@DashboardSearch'],
  }, async ({ page }) => {
    const before = await dash.totalCount();

    const name = await dash.firstRowPatientName();
    expect(name, 'expected a patient name in the first row').not.toBeNull();
    // Search a distinctive token from the name (last word — usually the surname).
    const token = name!.trim().split(/\s+/).pop()!;

    await dash.search(token);

    const after = await dash.totalCount();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    await expect(page.locator('#root')).toContainText(token);
  });

  test('Summary status pills filter the table to their own badge count', {
    tag: ['@Admin', '@DashboardQuickFilter'],
  }, async () => {
    // Each pill carries a badge count; clicking it filters the table to exactly that many rows.
    for (const label of ['Fertig behandelt', 'Keine Folge-VO', 'Zur Prüfung']) {
      const badge = await dash.pillCount(label);
      expect(badge, `pill "${label}" should expose a badge count`).not.toBeNull();

      await dash.clickPill(label);

      // Polled, not read once: the table refetches after the pill is applied, and under parallel load
      // a single read can still hold the previous filter's total.
      await expect
        .poll(() => dash.totalCount(), {
          timeout: 30_000,
          message: `total after "${label}" should equal its badge`,
        })
        .toBe(badge);
    }

    // "Alle VOs" restores the full (unfiltered) list.
    const alleBadge = await dash.pillCount('Alle VOs');
    await dash.clickPill('Alle VOs');
    await expect
      .poll(() => dash.totalCount(), { timeout: 30_000, message: '"Alle VOs" restores the full list' })
      .toBe(alleBadge);
  });

  test('Folge-VO Status dropdown filters the list', {
    tag: ['@Admin', '@DashboardFolgeVoFilter'],
  }, async ({ page }) => {
    const before = await dash.totalCount();

    await dash.selectFolgeVoStatus('Erhalten');
    await dash.closeFilterPanel();

    const after = await dash.totalCount();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    // The chosen Folge-VO status is reflected in the table (Erhalten rows).
    await expect(page.locator('#root')).toContainText('Erhalten');
  });

  test('The Filter panel previews its own result count and clears back to the full list', {
    tag: ['@Admin', '@DashboardFilterPanel'],
  }, async () => {
    const unfiltered = await dash.totalCount();

    // With nothing applied the panel's preview is the whole list and the chip carries no badge.
    await dash.openFilterPanel();
    expect(
      await dash.panelResultCount(),
      'an unfiltered panel previews the whole list',
    ).toBe(unfiltered);

    // Every section the panel offers, so a dropped filter shows up as a failure here.
    const sections = await dash.filterSections();
    console.log(`filter sections: ${JSON.stringify(sections)}`);
    for (const section of [
      'ICD',
      'Praxis',
      'Heilmittel',
      'VO Status',
      'Folge-VO Status',
      'ER: (Auswählen)',
      'Therapeut: (Auswählen)',
      'Arzt: (Auswählen)',
      'Versicherungsart',
      'Erstellungsvalidierungsstatus',
      'Abrechnungsvalidierungsstatus',
      // "Rezepte-Sync" was withdrawn from the panel (and from the Spalten chooser) on staging;
      // "Ausst. Datum" is the section that now closes the list.
      'Ausst. Datum',
    ]) {
      expect(sections, `the panel must still offer a "${section}" filter`).toContain(section);
    }

    // Applying one narrows the preview, and the preview is what the table then shows.
    await dash.selectFilter('VO Status', 'Aktiv');
    const previewed = await dash.panelResultCount();
    expect(previewed, 'applying a filter must narrow the preview').toBeLessThan(unfiltered);
    expect(await dash.chipBadge('Filter'), 'the chip badges how many filters are applied').toBe(1);

    await dash.closeFilterPanel();
    expect(await dash.totalCount(), 'the table shows exactly what the panel previewed').toBe(previewed);

    // And clearing restores the full list. Polled, not read once: clearing re-fetches the table and
    // the old count stays painted for a moment.
    await dash.clearFilters();
    await dash.closeFilterPanel();
    await expect
      .poll(() => dash.totalCount(), {
        timeout: 30_000,
        message: '"Filter löschen" must restore the unfiltered list',
      })
      .toBe(unfiltered);
  });

  test('Spalten chooser hides and restores a table column', {
    tag: ['@Admin', '@DashboardColumnToggle'],
  }, async () => {
    // Use a column that ships VISIBLE — most columns are hidden by default and only offered in the
    // chooser, so a hidden one (e.g. "IK-Nummer") can't be "hidden then restored".
    const COL = 'Ausst. Datum';

    // Column is present in the header to begin with.
    expect(await dash.headerLabels(), `"${COL}" ships visible`).toContain(COL);

    // Hide it via the column chooser.
    await dash.setColumn(COL, false);
    await dash.closeColumnChooser();
    expect(await dash.headerLabels(), `"${COL}" must be gone from the table`).not.toContain(COL);

    // Restore it.
    await dash.setColumn(COL, true);
    await dash.closeColumnChooser();
    expect(await dash.headerLabels(), `"${COL}" must be back in the table`).toContain(COL);
  });

  test('Zeilen pro Seite changes how many rows the table renders', {
    tag: ['@Admin', '@DashboardPageSize'],
  }, async () => {
    // The page size is a sticky preference, so start from a known one rather than whatever the last
    // test left behind.
    await dash.open({ resetPreferences: true });
    expect(await dash.rowsPerPage(), 'the board ships at 30 rows a page').toBe(30);

    const total = await dash.totalCount();
    await expect(dash.totalRange()).toHaveText(/^1\s*[–-]\s*30\s/, { timeout: 20_000 });

    await dash.setRowsPerPage(10);
    expect(await dash.rowsPerPage(), 'the selector reports the size it was set to').toBe(10);
    await expect(dash.totalRange(), 'and the range shrinks to match').toHaveText(/^1\s*[–-]\s*10\s/, {
      timeout: 20_000,
    });
    expect(await dash.renderedRowCount(), 'the table paints exactly a page of rows').toBe(10);
    expect(await dash.totalCount(), 'changing the page size does not change the total').toBe(total);

    // Restore the default so the sticky preference doesn't leak into the next run.
    await dash.setRowsPerPage(30);
    expect(await dash.rowsPerPage()).toBe(30);
  });
});
