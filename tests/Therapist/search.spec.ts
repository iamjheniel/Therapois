import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Search Functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('should show results for a valid search name', { tag: ['@Therapist','@searchname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('bloch');
    await page.getByTestId('text-input-outlined').press('Enter');
    await expect(page.locator('#root')).toContainText('Andreas Bloch');
    await expect(page.locator('#root')).toContainText('5158-1');
  });

  test('should show results for a valid search vo number', { tag: ['@Therapist','@searchvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('2155');
    await page.getByTestId('text-input-outlined').press('Enter');
    await expect(page.locator('#root')).toContainText('2155-9');
  });

  test('should show “no patient found" message for unknown name', { tag: ['@Therapist','@searchunknownname'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('test');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('No patients found');

  });

  test('should show “no patient found" message for unknown vo number', { tag: ['@Therapist','@searchunknownvo'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('1111');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('No patients found');

  });

});
