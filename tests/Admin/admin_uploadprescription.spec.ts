import { test, expect } from '@playwright/test';

test.describe('Admin Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Upload Prescription View and Add Note', { tag: ['@Admin', '@AddNoteUploadVO'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept hochladen' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await expect(page.locator('#root')).toContainText('66-1111-1S. Zeibig13.11.2025Fehlende Upload-ID-2 notesView');
    await page.getByTestId('button').nth(1).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Prescription Image Details');
    await page.getByRole('textbox', { name: 'Type your note here...' }).click();
    await page.getByRole('textbox', { name: 'Type your note here...' }).fill('automation admin test');
    await page.getByRole('button', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation admin test');
    await page.getByRole('button', { name: 'Save Changes' }).click();
   
    });
    
    // test('Admin Upload Prescription Search', { tag: ['@Admin', '@SearchUploadVO'] }, async ({ page }) => {
    // await page.getByText('').click();
    // await page.getByRole('button', { name: ' Rezept hochladen' }).click();
    // await expect(page.locator('#root')).toContainText('VO Upload');
    // // open dropdown
    // await page.getByRole('button', { name: 'Status' }).click();
    // // click the option
    // await page.getByRole('option', { name: 'In Prüfung (1)' }).click();
    // // assert the dropdown now shows the selected value
    // await expect(page.getByText('In Prüfung (1)')).toBeVisible();
    // await expect(page.locator('#root')).toContainText('In Prüfung');
    // await page.getByText('').click();
    // await page.locator('div').filter({ hasText: /^Status$/ }).nth(2).click({force: true });
    // await page.locator('div').filter({ hasText: 'All (5)In Prüfung (1)Nicht' }).nth(5).click();
    // await page.getByText('Status', { exact: true }).first().click();
    // await page.getByText('Angelegt (2)').click({force: true});
    // await expect(page.locator('#root')).toContainText('Angelegt');
    // await page.getByText('').click();
    // await page.getByRole('textbox', { name: 'Suchen' }).click();
    // await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    // await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    // await expect(page.locator('#root')).toContainText('S. Zeibig');

    // });

    // test('Admin Upload Prescription Update Status', { tag: ['@Admin', '@updateStatusUploadVO'] }, async ({ page }) => {
    // await page.getByText('').click();
    // await page.getByRole('button', { name: ' Rezept hochladen' }).click();
    // await expect(page.locator('#root')).toContainText('VO Upload');
    // await page.locator('text=Anzeigen').scrollIntoViewIfNeeded();
    // await page.getByText('View').click({force: true});
    // await page.getByTestId('modal-surface').getByText('In Prüfung').click();
    // await page.getByText('Nicht lesbar').click();
    // await page.getByRole('button', { name: 'Save Changes' }).click();
    // await expect(page.locator('#root')).toContainText('Nicht lesbar');
    // });
});