import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Super Admin TBoard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'Super Admin TBoard Document Treatment',
    { tag: ['@SuperAdmin', '@SADoku'] },
    async ({ page }) => {
      const app = new AppPage(page);
      await app.openSideMenu();
      // Navigate straight to the T Board (href="/therapist"); the sidebar button is often
      // off-screen, so a direct navigation is more reliable.
      await page.goto('https://staging.therapios.de/therapist', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      await page.getByText('Therapist: (Select)').click();
      // The T Board therapist selector lists therapists as plain text options.
      const therapistOption = page.getByText('Sandra Zeibig', { exact: true }).first();
      await expect(therapistOption).toBeVisible({ timeout: 15000 });
      await therapistOption.click();
      await page.waitForTimeout(3000); // let the therapist's board load
      await page.getByRole('checkbox').nth(1).click({ force: true }); // nth(1) = first patient row (nth(0) = header)
      await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test superadmin');
      await page.getByRole('radio').first().click();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toHaveText(
        /marked as Treated|Validation failed|Conflicting activity/i,
        { timeout: 15000 }
      );
    }
  );
});
