import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * Column inventory for the Admin Board table.
 *
 * The board is titled "Admin Board" over a "Verordnungen (VO) · N gesamt" summary, the identity
 * columns are "VO #" / "PATIENT" (the old separate "Name", "VO Nr." and "Geburtsdatum" columns were
 * merged into the patient cell), and most columns ship hidden — the "Spalten" chooser offers 37 and
 * turns 10 of them on by default. ("Rezepte-Sync" was withdrawn from both the chooser and the
 * Filter panel on staging, taking the inventory 38 → 37.)
 *
 * The chooser is now properly marked up: each row is a `[role="menuitem"]` wrapping a
 * `[role="checkbox"][aria-label="<column>"]`, so the whole inventory can be read off in one go
 * instead of being probed label by label. Note the checkbox carries no `aria-checked` — a column is
 * on iff its checkbox renders a "✓" glyph (`AdminDashboardPage.columnOptions()` handles that).
 */
test.describe('Admin Dashboard', () => {
  /** Every column the "Spalten" chooser offers, in the order it lists them. */
  const ALL_COLUMNS = [
    // ── on by default
    'Versicherungsart',
    'Heilmittel',
    'ICD',
    'Einrichtung',
    'Therapeut',
    'Ausst. Datum',
    'Beh. Status',
    'Folge-VO Status',
    'VO Status',
    'Abrechnungsvalidierungsstatus',
    // ── opt-in
    'Arzt',
    'Praxis',
    'Hono Status',
    'Hono Dok.',
    'Bemerkungen',
    'Protokolle',
    'Pat. Protokolle',
    'Doku',
    'Quelle',
    'Upload ID',
    'LHB/BVB',
    'IK-Nummer',
    'VO Bild',
    'Bildstatus',
    'TB',
    'Bestelldatum',
    'Bestellt Datum',
    'Nachverfolgen Datum',
    'Erhalten Datum',
    'Abgerechnet Datum',
    'Keine-Folge VO Datum',
    'Folge-VO',
    'Bestell Status',
    'Doppel-Beh.',
    'VA-Status',
    'Erstellungsvalidierungsstatus',
    'Letzte Notiz',
  ];

  test('Admin Dashboard Columns', { tag: ['@Admin', '@columns'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const dash = new AdminDashboardPage(page);
    // The checked set is a sticky localStorage preference, so the defaults are only observable on a
    // board whose preference has been cleared.
    await dash.open({ resetPreferences: true });

    await expect(page.locator('#root')).toContainText('Admin Board');
    await expect(dash.headerTotal(), 'the board summarises its own row count').toBeVisible();
    expect(
      await dash.headerTotalCount(),
      'the heading total and the pager total are the same number',
    ).toBe(await dash.totalCount());

    // ── the table's own headers, left to right
    const headers = await dash.headerLabels();
    console.log(`default headers: ${JSON.stringify(headers)}`);
    expect(headers, 'the identity columns lead the table and are never hideable').toEqual(
      expect.arrayContaining([...AdminDashboardPage.FIXED_COLUMNS]),
    );
    for (const col of AdminDashboardPage.DEFAULT_COLUMNS) {
      expect(headers, `default column "${col}" must be rendered`).toContain(col);
    }

    // ── the chooser's full inventory and its checked set
    const options = await dash.columnOptions();
    console.log(`chooser (${await dash.columnSummary()}): ${options.length} columns`);
    expect(
      options.map((o) => o.label),
      'the chooser offers every column the board knows about, in order',
    ).toEqual(ALL_COLUMNS);
    expect(
      options.filter((o) => o.checked).map((o) => o.label),
      'exactly the ten default columns are checked',
    ).toEqual([...AdminDashboardPage.DEFAULT_COLUMNS]);
    expect(await dash.columnSummary(), 'and the chooser reports that as 10 of 37').toBe('10/37');

    // The identity columns are not the chooser's to switch off.
    for (const fixed of AdminDashboardPage.FIXED_COLUMNS) {
      expect(
        options.map((o) => o.label),
        `"${fixed}" is a fixed column and must not be offered in the chooser`,
      ).not.toContain(fixed);
    }
    await dash.closeColumnChooser();

    // ── and the VO Status filter still narrows the table to the chosen status
    await dash.applyFilter('VO Status', 'Aktiv');
    await expect(page.locator('#root')).toContainText('Aktiv');
  });
});
