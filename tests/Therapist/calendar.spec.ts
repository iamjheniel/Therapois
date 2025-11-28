import { test, expect } from '@playwright/test';

test.describe('Calendar', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });


  // ----------------------------
  // Test 1: Open calendar + verify page
  // ----------------------------
  test('Calendar document treatment', { tag : ['@Therapist', '@calendar'] }, async ({ page }) => {

    // Open Kalender
    await page.getByText('Kalender', { exact: true }).click();


    // Open "Doku erfassen"
    await page.getByRole('button', { name: 'Doku erfassen' }).click();

    // Validate page content
    const root = page.locator('#root');
    await expect(root).toContainText('Offene VOs');
    await expect(page.locator('div[tabindex="0"]').first()).toBeVisible();

  });


  // ----------------------------
  // Test 2: Edit calendar entry (flexible version, no brittle selectors)
  // ----------------------------
  test('Calendar edit document treatment', { tag : ['@Therapist', '@editcalendar'] }, async ({ page }) => {
    
    // Go to calendar
    await page.getByText('Kalender', { exact: true }).click();

    // Wait for day columns to load
    await page.waitForSelector('div.css-g5y9jx[id]', { timeout: 30000 });

    // Wait for at least 1 appointment card to appear inside any day column
    await page.waitForSelector(
    'div.css-g5y9jx[id] div[tabindex="0"] div[dir="auto"]',
    { timeout: 15000 }
    );

    // Build the locator
    const firstAppointment = page
    .locator('div.css-g5y9jx[id]')
    .locator('div[tabindex="0"] div[dir="auto"]')
    .first();

    // Ensure visibility (VERY important)
    await expect(firstAppointment).toBeVisible({ timeout: 15000 });
    // Scroll into view (helps with dynamic rendering)
    await firstAppointment.scrollIntoViewIfNeeded();
    // Click the card
    await firstAppointment.click({ trial: false });
    // Now wait for modal
    const input = page.getByTestId('text-input-outlined');
    const uniqueValue = `automation update ${Date.now()}`;
    await input.waitFor({ state: 'visible' });
    await input.fill('');
    await input.fill(uniqueValue);

    // Save
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
    await page.getByRole('button', { name: 'Save' }).click();

    // Verify success toast
    await expect(page.getByTestId('surface')).toContainText('Activity updated');

  });

});
