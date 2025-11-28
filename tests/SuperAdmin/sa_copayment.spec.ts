import { test, expect } from '@playwright/test';

test.describe('Super Admin Copayment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Super Admin Copayment View and Add Note', { tag: ['@SuperAdmin', '@CopaymentAddNoteAdmin'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Zuzahlungsbefreiung' }).click();
    await page.getByTestId('button').nth(1).click({force: true, timeout:60000});
    await expect(page.getByTestId('modal-surface')).toContainText('Copayment Details');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('admin automation test');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('admin automation test');
    await page.getByRole('button', { name: '󰅖' }).click();
   
    });
    test('Super Admin Copayment Search', { tag: ['@SuperAdmin', '@CopaymentSearch'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Zuzahlungsbefreiung' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('sandra');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('S. Zeibig');
    await page.getByRole('button', { name: '' }).click();
    await page.getByText('').nth(5).click();
    await page.locator('div').filter({ hasText: /In Prüfung\s*\(\d+\)/ }).nth(3).click();
    await expect(page.locator('#root')).toContainText('In Prüfung');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('66-1');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText('66-1');
    await page.getByRole('button', { name: '' }).click();
    });

    test('Super Admin Copayment Update Status', { tag: ['@SuperAdmin', '@CopaymentUpdateStatus'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Zuzahlungsbefreiung' }).click();
    await page.getByTestId('button').nth(1).click({force: true});
    await page.locator('.css-146c3p1.r-13awgt0.r-18phcnl.r-11t4n93').click();
    await page.locator('div:nth-child(2) > .css-g5y9jx.r-lrvibr > div > .css-g5y9jx').click();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.locator('#root')).toContainText('Nicht lesbar');
    });
});
