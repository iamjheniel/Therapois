import { test, expect } from '@playwright/test';

test.describe('Super Admin Copayment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Super Admin Document View and Add Note', { tag: ['@SuperAdmin', '@DocumentAddNoteAdmin'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByRole('button', { name: 'View' }).nth(3).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');
   
    });

    test('Super Admin Document Search by Therapist Name', { tag: ['@SuperAdmin', '@DocumentSearch'] }, async ({ page }) => {
    test.fixme(true, 'No documents matching "sandra" on staging — needs test data');
    //search by therapist name
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('Sa. Zeibig');
    });
    
    test('Super Admin Document Search by Document ID', { tag: ['@SuperAdmin', '@DocumentSearch'] }, async ({ page }) => {
    test.fixme(true, 'No documents matching "66" on staging — needs test data');
    //search by document id
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('66');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText(/66-/i);
    });


});
