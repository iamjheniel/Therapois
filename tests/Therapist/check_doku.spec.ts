import { test, expect} from '@playwright/test';

test.describe('Therapist Doku Check', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Check Doku feature', { tag: ['@Therapist','@checkdoku'] }, async ({ page }) => {
    await page.getByTestId('icon-button').nth(1).click({ force: true });
    await page.getByText('').first().click();
    await expect(page.getByTestId('surface')).toContainText('Documentation (Treatment History)');

  });

    test('Check Logs feature', { tag: ['@Therapist','@checklogs'] }, async ({ page }) => {
    await page.getByTestId('icon-button').nth(1).click({ force: true });   
    await page.locator('div').filter({ hasText: /^$/ }).nth(4).click({ force: true });
    await expect(page.getByTestId('modal-surface')).toContainText('Prescription Logs - Franz Abitz');
    await page.getByText('Close').click();
  });

});