import { test, expect } from '@playwright/test';

test.use({ storageState: undefined });

test.describe('Search Functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('should show results for a valid search name', async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('bloch');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('Andreas Bloch');
    await expect(page.locator('#root')).toContainText('5158-1');
  });

  test('should show results for a valid search vo number', async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('3569-4');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('Ingrid Elsner');
    await expect(page.locator('#root')).toContainText('3569-4');
  });

  test('should show “no patient found" message for unknown name', async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('test');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('No patients found');

  });

  test('should show “no patient found" message for unknown vo number', async ({ page }) => {
    await page.getByTestId('text-input-outlined').click();
    await page.getByTestId('text-input-outlined').fill('1111');
    await page.getByTestId('text-input-outlined').press('Enter');
    
    await expect(page.locator('#root')).toContainText('No patients found');

  });

});
