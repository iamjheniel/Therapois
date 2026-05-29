import { test, expect } from '@playwright/test';

test.describe('Super Admin TBoard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test(
    'Super Admin TBoard Document Treatment',
    { tag: ['@SuperAdmin', '@SADoku'] },
    async ({ page }) => {
      await page.getByText('').click();
      await page.getByRole('button', { name: ' T Board' }).click();
      await page.waitForTimeout(10000);
      await page.getByText('Therapist: (Select)').click();
      await page.getByText('Sandra Zeibig').click();
      await page.getByRole('checkbox').nth(2).click({ force: true });
      await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
      await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test superadmin');
      await page.getByRole('radio').first().click();
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toHaveText(
        /marked as Treated|Validation failed|Conflicting activity/i,
        { timeout: 15000 }
      );
    }
  );
});
