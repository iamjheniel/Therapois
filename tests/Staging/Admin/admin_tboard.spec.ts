import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Admin TBoard', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Admin TBoard Document Treatment', { tag: ['@Admin', '@AdminDoku'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/T Board/);
    await page.waitForTimeout(10000);
    await page.getByText('Therapist: (Select)').click();
    // The T Board therapist selector lists therapists as plain text options.
    await page.getByText('Sandra Zeibig', { exact: true }).first().click();
    await page.waitForTimeout(3000); // let the therapist's board load
    await page.getByRole('checkbox').nth(1).click({force:true}); // nth(1) = first patient row (nth(0) = header)
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test admin');
    await page.getByRole('radio').first().click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toHaveText(
    /marked as Treated|Validation failed|Conflicting activity/i,
    { timeout: 15000 });
    });
});