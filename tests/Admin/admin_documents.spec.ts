import { test, expect } from '@playwright/test';

test.describe('Admin Documents', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Copayment View and Add Note', { tag: ['@Admin', '@DocumentAddNoteAdmin'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByRole('button', { name: 'View' }).nth(3).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await expect(page.getByTestId('modal-surface')).toContainText('Zuzahlungsbefreiung');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');
   
    });
    
    test('Admin Patient Info View and Add Note', { tag: ['@Admin', '@DocumentAddNoteAdmin'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByTestId('button').nth(5).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await expect(page.getByTestId('modal-surface')).toContainText('Patienteninformationsbogen');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');
   
    });

    test('Admin Honorarvereinbarung View and Add Note', { tag: ['@Admin', '@DocumentAddNoteAdmin'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByTestId('button').nth(4).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await expect(page.getByTestId('modal-surface')).toContainText('Honorarvereinbarung');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');
   
    });

    test('Admin Andere View and Add Note', { tag: ['@Admin', '@DocumentAddNoteAdminAndere'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByTestId('button').nth(3).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await expect(page.getByTestId('modal-surface')).toContainText('Andere');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');
   
    });    

    test('Admin Document Search by Therapist Name', { tag: ['@Admin', '@DocumentSearch'] }, async ({ page }) => {
    //search by therapist name
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('Sa. Zeibig');
    });
    test('Admin Document Search by Document ID', { tag: ['@Admin', '@DocumentSearch'] }, async ({ page }) => {
    //search by document id
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('66');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText(/66-/i);
    });

    test('Admin Document Update Status', { tag: ['@Admin', '@DocumentStatusChange'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument'  }).click();
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
