import { test, expect } from '@playwright/test';

test.describe('Home page', () => {
    test.beforeEach(async ({page}) => {
    await page.goto('https://staging.therapios.de/');
   });
  test('Login as therapist', async ({ page }) => {

    await page.getByTestId('text-input-outlined').first().click();
    await page.getByTestId('text-input-outlined').first().fill('sandra.zeibig.66@therapios.com');
    await page.getByTestId('text-input-outlined').first().press('Tab');
    await page.locator('input[type="password"]').fill('12345678');
    await page.getByRole('checkbox').check();
    await page.locator('div').filter({ hasText: /^Proceed$/ }).first().click();
    await expect(page.locator('#root')).toContainText('Deine Übersicht');
    await page.goto('https://staging.therapios.de/therapist');
    await expect(page.locator('#root')).toContainText('Sandra Zeibig');


  });

 
});