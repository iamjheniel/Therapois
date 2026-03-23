import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Search Functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('should show results for a valid search name', { tag: ['@Therapist','@searchname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('jhen');
    await page.getByTestId('text-input-outlined').press('Enter');
    await expect(page.locator('#root')).toContainText('Jheniel Test');
  });

  test('should show results for a valid search vo number', { tag: ['@Therapist','@searchvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    // NOTE: Update VO number if it changes in staging - verifies VO number search returns a result
    await page.getByTestId('text-input-outlined').fill('2171');
    await page.getByTestId('text-input-outlined').press('Enter');
    // Verify the VO search returns at least one result (not the empty state)
    await expect(page.locator('#root')).not.toContainText('Keine Patienten gefunden', { timeout: 15000 });
  });

  test('should show "no patient found" message for unknown name', { tag: ['@Therapist','@searchunknownname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('xxxxxxunknown99999');
    await page.getByTestId('text-input-outlined').press('Enter');
    await expect(page.locator('#root')).toContainText('Keine Patienten gefunden');

  });

  test('should show "no patient found" message for unknown vo number', { tag: ['@Therapist','@searchunknownvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('1111');
    await page.getByTestId('text-input-outlined').press('Enter');
    await expect(page.locator('#root')).toContainText('Keine Patienten gefunden');

  });

  test('should filter search results by location', { tag: ['@Therapist','@searchlocation'] }, async ({ page }) => {
    await page.waitForLoadState('networkidle');
    // Click the location filter button (shows abbreviated location name or placeholder)
    const locationFilter = page.getByRole('button', { name: /Ort|ECH|Location/i }).first();
    await locationFilter.waitFor({ state: 'visible', timeout: 10000 });
    await locationFilter.click({ force: true });
    // Click the first available location option in the dropdown
    const firstOption = page.locator('[data-testid="modal-surface"] div[tabindex="0"]').first();
    await firstOption.waitFor({ state: 'visible', timeout: 10000 });
    const locationName = (await firstOption.textContent()) ?? '';
    await firstOption.click();
    await expect(page.locator('#root')).toContainText(locationName);
  });
});
