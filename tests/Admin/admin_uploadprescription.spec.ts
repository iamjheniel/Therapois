import { test, expect } from '@playwright/test';

test.describe('Admin Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Upload Prescription View and Add Note', { tag: ['@Admin', '@AddNoteUploadVO'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept hochladen' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByTestId('button').nth(1).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Prescription Image Details');
    await page.getByRole('textbox', { name: 'Type your note here...' }).click();
    await page.getByRole('textbox', { name: 'Type your note here...' }).fill('automation admin test');
    await page.getByRole('button', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation admin test');
    await page.getByText('Close').click();
   
    });
    
    test('Admin Upload Prescription Search', { tag: ['@Admin', '@SearchUploadVO'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('S. Zeibig');

    });

    test('Admin Upload Prescription Update Status', { tag: ['@Admin', '@updateStatusUploadVO'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.locator('text=Anzeigen').nth(0).scrollIntoViewIfNeeded();
    await page.getByText('View').click({force: true});
    await page.getByTestId('modal-surface').getByText('In Prüfung').click();
    await page.getByText('Nicht lesbar').click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.locator('#root')).toContainText('Nicht lesbar');
    });
});