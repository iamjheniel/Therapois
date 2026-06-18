import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Super Admin Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });


    test('Super Admin Upload Prescription View and Add Note', { tag: ['@SuperAdmin', '@AddNoteUploadVO'] }, async ({ page }) => {
    test.fixme(true, 'SA upload list shows "Keine Patienten gefunden" on staging — needs test data (an uploaded VO) before this can run');
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByTestId('button').nth(3).click({force: true});
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).fill('test automation');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('test automation');
    await page.getByRole('button', { name: '󰅖' }).click();
   
    });
    
    test('Super Admin Upload Prescription Search', { tag: ['@SuperAdmin', '@SearchUploadVO'] }, async ({ page }) => {
    test.fixme(true, 'SA upload search shows "Keine Patienten gefunden" for "sandra" on staging — needs test data');
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('Sa. Zeibig');
    });
});