import { test, expect } from '@playwright/test';

test.describe('Super Admin Announcements', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Super Admin Announcement Creation', { tag: ['@SuperAdmin', '@announcement'] }, async ({ page }) => {
    // Unique message so the created card can be located unambiguously
    const message = `test automation ${Date.now()}`;

    // The Announcements nav button can sit below the fold; scroll it into view
    // and click via the DOM so RNW's scroll container cooperates.
    const navBtn = page.getByRole('button', { name: ' Announcements' }).last();
    await navBtn.waitFor({ state: 'attached', timeout: 10_000 });
    await navBtn.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
    const messageBox = page
      .getByRole('textbox', { name: /announcement message|Ankündigungsnachricht/i })
      .first();
    await messageBox.click();
    await messageBox.fill(message);
    await page.getByRole('radio', { name: /Never expire|Niemals ablaufen/i }).click();
    await page.getByRole('button', { name: /Create Announcement|Ankündigung erstellen/i }).click();
    await expect(page.getByTestId('surface')).toContainText(/Announcement created successfully|Ankündigung erfolgreich erstellt/i);

    // 1. Locate the correct announcement card by its unique message text
    const card = page
      .locator('div[data-testid="card-container"]', { hasText: message })
      .first();

    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();

    // 2. Locate the toggle *inside this card only* (role="switch")
    const toggle = card.locator('input[role="switch"]');
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await toggle.click({ force: true });

    // Verify the announcement appears on the Admin Board.
    // Navigate via the nav button (scroll into view + DOM click) rather than
    // the fragile user-menu glyph icons.
    const adminBoard = page.getByRole('button', { name: ' Admin Board' }).last();
    await adminBoard.waitFor({ state: 'attached', timeout: 10_000 });
    await adminBoard.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
    await expect(page.locator('#root')).toContainText(
      /General Announcement|Allgemeine Ankündigung/i,
      { timeout: 15_000 }
    );
    await expect(page.locator('#root')).toContainText(message, { timeout: 15_000 });
    });
});
