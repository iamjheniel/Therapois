import { test, expect } from '@playwright/test';

test.describe('Super Admin Copayment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard'); // already logged in due to storageState
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
    //search by therapist name
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('Sa. Zeibig');
    });
    
    test('Super Admin Document Search by Document ID', { tag: ['@SuperAdmin', '@DocumentSearch'] }, async ({ page }) => {
    //search by document id
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('66');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText(/66-/i);
    });

    test('Super Admin Document Update Status', { tag: ['@SuperAdmin', '@DocumentStatusChange'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByTestId('button').nth(3).click({force: true});
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').click();
    await page.locator('div:nth-child(2) > .css-g5y9jx.r-lrvibr > div > .css-g5y9jx').click();
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await page.getByText(/^In Prüfung\s*\(\d+\)$/).click();
    await page.getByText(/^Nicht lesbar\s*\(\d+\)$/).click();
    await expect(page.locator('#root')).toContainText('Nicht lesbar');
    await page.getByTestId('button').nth(3).click({force: true});
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').click();
    await page.getByText('In Prüfung').click({force: true});
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    });

});
