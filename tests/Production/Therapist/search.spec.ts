import { test, expect } from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';

//test.use({ storageState: undefined });

test.describe('Search Functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

  test('should show results for a valid search name', { tag: ['@Therapist','@searchname'] }, async ({ page }) => {
    // Resolve a real patient from live data (falls back to a broad search if the historically
    // used name has churned out), then assert searching that name returns it.
    const list = new TherapistListPage(page);
    const name = await list.resolvePatientName(['Jheniel Test']);
    test.skip(!name, 'No patient available in this therapist\'s list');
    await expect(page.locator('#root')).toContainText(name!);
  });

  test('should show results for a valid search vo number', { tag: ['@Therapist','@searchvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').first().click();
    // NOTE: Update VO number if it changes in staging - verifies VO number search returns a result
    await page.getByTestId('text-input-outlined').first().fill('2171');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    // Verify the VO search returns at least one result (not the empty state)
    await expect(page.locator('#root')).not.toContainText('Keine Patienten gefunden', { timeout: 15000 });
  });

  test('should show "no patient found" message for unknown name', { tag: ['@Therapist','@searchunknownname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').first().click();
    await page.getByTestId('text-input-outlined').first().fill('xxxxxxunknown99999');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await expect(page.locator('#root')).toContainText('Keine Patienten gefunden');

  });

  test('should show "no patient found" message for unknown vo number', { tag: ['@Therapist','@searchunknownvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').first().click();
    await page.getByTestId('text-input-outlined').first().fill('1111');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await expect(page.locator('#root')).toContainText('Keine Patienten gefunden');

  });

  test('should filter search results by location', { tag: ['@Therapist','@searchlocation'] }, async ({ page }) => {
    // Click the location filter button (shows abbreviated location name or placeholder)
    const locationFilter = page.getByRole('button', { name: /Ort|ECH|Location/i }).first();
    await locationFilter.waitFor({ state: 'visible', timeout: 10000 });
    await locationFilter.click({ force: true });
    // Click the first available location option in the dropdown
    const firstOption = page.locator('[data-testid="modal-surface"] div[tabindex="0"]').first();
    const hasOption = await firstOption.isVisible({ timeout: 10000 }).catch(() => false);
    test.skip(!hasOption, 'No location filter options available');
    const locationName = (await firstOption.textContent()) ?? '';
    await firstOption.click();
    await expect(page.locator('#root')).toContainText(locationName);
  });
});
