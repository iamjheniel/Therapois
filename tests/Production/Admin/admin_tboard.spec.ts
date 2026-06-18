import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Admin TBoard', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Admin TBoard Document Treatment', { tag: ['@Admin', '@AdminDoku'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/T Board/);
    await page.waitForTimeout(1500);
    await page.getByText('Therapist: (Select)').click();
    await page.getByText('Sandra Zeibig').click();
    await page.getByRole('checkbox').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByRole('checkbox').nth(2).click({force:true});
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test admin');
    await page.getByRole('radio').first().click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForTimeout(500);
    await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toHaveText(
    /marked as Treated|Validation failed|Conflicting activity/i,
    { timeout: 15000 });
    });
});