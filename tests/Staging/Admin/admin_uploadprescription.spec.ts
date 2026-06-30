import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Admin Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Admin Upload Prescription View and Add Note', { tag: ['@Admin', '@AddNoteUploadVO'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: 'View' }).nth(3).click({force: true});
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).fill('test automation');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('test automation');
    await page.getByRole('button', { name: '󰅖' }).click();
   
    });
    
    test('Admin Upload Prescription Search', { tag: ['@Admin', '@SearchUploadVO'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    // Data-robust: the set of uploaders/IDs in this view changes over time, so
    // derive the search term from a value actually present in the live list
    // (the first row's Upload ID, formatted NNN-NN) instead of a hard-coded name.
    await expect(page.getByRole('button', { name: 'View' }).first()).toBeVisible({ timeout: 15000 });
    const firstId = (await page.locator('#root').innerText()).match(/\b\d{2,4}-\d{1,4}\b/)?.[0];
    expect(firstId, 'expected at least one uploaded VO with an Upload ID').toBeTruthy();
    const search = page.getByRole('textbox', { name: 'Suchen' });
    await search.click();
    await search.fill(firstId!);
    await search.press('Enter');
    await expect(page.locator('#root')).not.toContainText('Keine Patienten gefunden', { timeout: 15000 });
    await expect(page.locator('#root')).toContainText(firstId!);
    });

    test('Admin Upload Prescription Update Status', { tag: ['@Admin', '@updateStatusUploadVO'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    // The VO Upload page only exposes the default "In Prüfung" view (there is NO
    // "Nicht lesbar" filter tab here, unlike the Dokument page). Verify a status
    // change by marking the first row "Nicht lesbar": it then leaves the
    // In-Prüfung view, so the row (View-button) count drops by one.
    const rowCount = () => page.getByRole('button', { name: 'View' }).count();
    await expect.poll(rowCount, { timeout: 15000 }).toBeGreaterThan(0);
    // The row list streams in, so capture the baseline only once the count settles (two equal
    // reads). A too-early baseline is the flake source: rows that finish loading after the
    // status change keep the count at/above `before`, so the "< before" check races and fails.
    let before = await rowCount();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(700);
      const c = await rowCount();
      if (c === before) break;
      before = c;
    }
    await page.getByRole('button', { name: 'View' }).first().click({ force: true });
    // Clicking the status field opens a dropdown (rendered in a portal OUTSIDE
    // modal-surface). "Nicht lesbar" is unique on the page, so target it directly.
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').first().click();
    await page.getByText('Nicht lesbar', { exact: true }).first().click({ force: true });
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    // The marked row drops out of the In-Prüfung view.
    await expect.poll(rowCount, { timeout: 20000 }).toBeLessThan(before);
    });
});