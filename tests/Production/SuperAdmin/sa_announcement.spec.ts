import { test, expect } from '@playwright/test';

test.describe('Super Admin Announcements', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Super Admin Announcement Creation', { tag: ['@SuperAdmin', '@announcement'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Announcements' }).click();
    await page.getByRole('textbox', { name: 'Enter announcement message...' }).click();
    await page.getByRole('textbox', { name: 'Enter announcement message...' }).fill('test automation');
    await page.getByRole('radio', { name: 'Never expire' }).click();
    await page.getByRole('button', { name: 'Create Announcement' }).click();
    await expect(page.getByTestId('surface')).toContainText('Announcement created successfully');
    // 1. Locate the correct announcement card
    const card = page
    .locator('div[data-testid="card-container"]', { hasText: 'test automation' })
    .first();

    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();

    // 2. Locate the toggle *inside this card only*
    const toggle = card.locator('input[role="switch"]');

    // Debug counts (optional)
    console.log('toggle count inside card:', await toggle.count());

    // 3. Click the toggle safely
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await toggle.click({ force: true });
    await page.getByText('').nth(1).click();
    await page.getByText('SJSA JhenSuper Admin').click();
    await page.getByRole('button', { name: ' Admin Board' }).click();
    await page.getByText('').first().click();
    await expect(page.locator('#root')).toContainText('General Announcement');
    await expect(page.locator('#root')).toContainText('test automation');
    await page.getByText('Notifications').click();
    await page.getByText('').click();
    });
});