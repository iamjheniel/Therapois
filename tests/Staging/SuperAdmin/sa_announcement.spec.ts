import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Super Admin Announcements', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Super Admin Announcement Creation', { tag: ['@SuperAdmin', '@announcement'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Announcements/);
    const messageBox = page
      .getByRole('textbox', { name: /announcement message|Ankündigungsnachricht/i })
      .first();
    await messageBox.click();
    await messageBox.fill('test automation');
    await page.getByRole('radio', { name: /Never expire|Niemals ablaufen/i }).click();
    await page.getByRole('button', { name: /Create Announcement|Ankündigung erstellen/i }).click();
    // No success snackbar in this build — the announcement card assertion below is the post-condition.
    // 1. Locate the correct announcement card
    const card = page
    .locator('div[data-testid="card-container"]', { hasText: 'test automation' })
    .first();

    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();

    // 2. Locate the toggle *inside this card only*
    const toggle = card.locator('input[role="switch"]');

    // 3. Click the toggle safely to publish the announcement
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await toggle.click({ force: true });

    // 4. Navigate to the Admin Board and verify the published announcement banner shows there.
    //    (The previous version relied on empty-text `getByText('')` icon clicks — brittle
    //    Codegen artifacts that matched multiple icon <div>s and threw a strict-mode violation.)
    await app.navTo(/Admin Board/);
    await expect(page.locator('#root')).toContainText(
      /General Announcement|Allgemeine Ankündigung/i,
      { timeout: 15000 },
    );
    await expect(page.locator('#root')).toContainText('test automation');
    });
});
