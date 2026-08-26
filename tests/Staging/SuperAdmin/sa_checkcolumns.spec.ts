import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * Column inventory for the Super Admin board table. Mirrors `admin_checkcolumns`.
 *
 * The board was redesigned: the page is titled "Admin Board" (was "Dashboard - Verwaltung"), the
 * identity columns are now "VO #" / "PATIENT" (the old separate "Name", "VO Nr." and "Geburtsdatum"
 * columns were merged into the patient cell), and most other columns ship hidden — they are offered
 * by the "▦ Spalten" chooser instead of all rendering at once.
 */
test.describe('Super Admin Dashboard Check all columns', () => {
  /** Columns rendered by default, left→right. */
  const DEFAULT_COLUMNS = [
    'VO #',
    'PATIENT',
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
  ];

  /** Columns available from the "▦ Spalten" chooser. */
  const OPTIONAL_COLUMNS = [
    'Arzt',
    'Praxis',
    'Bemerkungen',
    'Protokolle',
    'Doku',
    'TB',
    'Bestelldatum',
    'Bestellt Datum',
    'Nachverfolgen Datum',
    'Erhalten Datum',
    'Folge-VO',
    'Bestell Status',
    'Doppel-Beh.',
    'Letzte Notiz',
  ];

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Super Admin Dashbaord Columns', { tag: ['@SuperAdmin', '@columns'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await page.getByText('VO #', { exact: true }).first().waitFor({ timeout: 30_000 });

    await expect(page.locator('#root')).toContainText('Admin Board');
    for (const col of DEFAULT_COLUMNS) {
      await expect(page.locator('#root'), `default column "${col}"`).toContainText(col);
    }

    await dash.openColumnChooser();
    for (const col of OPTIONAL_COLUMNS) {
      await expect(
        dash.column(col).filter({ visible: true }).last(),
        `optional column "${col}" offered in the Spalten chooser`,
      ).toBeVisible();
    }
    await dash.closeColumnChooser();

    // The VO Status filter still narrows the table to the chosen status.
    await dash.selectFilter('VO Status', 'Aktiv');
    await expect(page.locator('#root')).toContainText('Aktiv');
  });
});
