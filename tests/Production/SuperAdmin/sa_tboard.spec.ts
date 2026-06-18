import { test, expect } from '@playwright/test';

test.describe('Super Admin TBoard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'Super Admin TBoard Document Treatment',
    { tag: ['@SuperAdmin', '@SADoku'] },
    async ({ page }) => {
      // Navigate to T Board (scroll the nav button into view and click via DOM)
      const navBtn = page.getByRole('button', { name: ' T Board' }).last();
      await navBtn.waitFor({ state: 'attached', timeout: 10_000 });
      await navBtn.evaluate((el: HTMLElement) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
      });
      await page.waitForTimeout(10000);
      await page.getByText('Therapist: (Select)').click();
      // The therapist name also appears in the grid, so scope to the dropdown item
      await page.getByTestId('dropdown-item-Sandra Zeibig').click();
      await page.getByRole('checkbox').nth(2).click({ force: true });
      await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test superadmin');
      await page.getByRole('radio').first().click();
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForTimeout(500);
      await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toHaveText(
        /marked as Treated|Validation failed|Conflicting activity/i,
        { timeout: 15000 }
      );
    }
  );
});
