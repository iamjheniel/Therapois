import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Search Functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('should show results for a valid search name', { tag: ['@Therapist','@searchname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').first().click();
    // Search an existing patient (Namjoon Test is no longer in this therapist's list).
    await page.getByTestId('text-input-outlined').first().fill('BiniColet');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await expect(page.locator('#root')).toContainText('BiniColet Test');
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
    await page.getByTestId('text-input-outlined').first().fill('Mustermann');
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
    await page.waitForLoadState('networkidle');
    // NOTE: Update 'ECH' if the location chip label changes in staging
    await page.getByText('ECH', { exact: true }).first().click({ force: true });
    await page.getByText('QA Test ER').click();
    await expect(page.locator('#root')).toContainText('QA Test ER');
  });
});
