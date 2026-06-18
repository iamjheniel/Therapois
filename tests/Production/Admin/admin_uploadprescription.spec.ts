import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Admin Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Admin Upload Prescription View and Add Note', { tag: ['@Admin', '@AddNoteUploadVO'] }, async ({ page }) => {
      const app = new AppPage(page);
      test.fixme(true, 'VO Upload list is empty on Production ("In Pruefung (0)", "Keine Patienten gefunden", 0 of 0) - no uploaded VOs exist to view/search/update; needs test data.');
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: 'View' }).first().click({force: true});
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).fill('test automation');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('test automation');
    await page.getByRole('button', { name: '󰅖' }).click();
   
    });
    
    test('Admin Upload Prescription Search', { tag: ['@Admin', '@SearchUploadVO'] }, async ({ page }) => {
      const app = new AppPage(page);
      test.fixme(true, 'VO Upload list is empty on Production ("In Pruefung (0)", "Keine Patienten gefunden", 0 of 0) - no uploaded VOs exist to view/search/update; needs test data.');
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('Sa. Zeibig');
    });

    test('Admin Upload Prescription Update Status', { tag: ['@Admin', '@updateStatusUploadVO'] }, async ({ page }) => {
      const app = new AppPage(page);
      test.fixme(true, 'VO Upload list is empty on Production ("In Pruefung (0)", "Keine Patienten gefunden", 0 of 0) - no uploaded VOs exist to view/search/update; needs test data.');
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: 'View' }).first().click({force: true});
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').click();
    await page.locator('div:nth-child(2) > .css-g5y9jx.r-lrvibr > div > .css-g5y9jx').click();
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await page.getByText(/^In Prüfung\s*\(\d+\)$/).click();
    await page.getByText(/^Nicht lesbar\s*\(\d+\)$/).click();
    await expect(page.locator('#root')).toContainText('Nicht lesbar');
    await page.getByRole('button', { name: 'View' }).first().click({force: true});
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').click();
    await page.getByText('In Prüfung').click({force: true});
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    });
});