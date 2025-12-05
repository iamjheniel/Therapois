import { test, expect} from '@playwright/test';

test.describe('Therapist Doku Check', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Check Doku feature', { tag: ['@Therapist','@checkdoku'] }, async ({ page }) => {
    await expect(page.locator('#root')).toContainText('Dashboard');
    await page.getByTestId('icon-button').nth(1).click({ force: true });
    await page.locator('div').filter({ hasText: /^$/ }).nth(1).click({ force: true });
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentation (Behandlungsverlauf)');

  });

    test('Check Logs feature', { tag: ['@Therapist','@checklogs'] }, async ({ page }) => {
    await expect(page.locator('#root')).toContainText('Dashboard');
    await page.getByTestId('icon-button').nth(1).click({force: true });
    await page.locator('div').filter({ hasText: /^$/ }).nth(4).click({force: true });
    await expect(page.getByTestId('modal-surface')).toContainText(/Prescription logs/i);
    await page.locator('div').filter({ hasText: /^Close$/ }).nth(1).click();
  });

});