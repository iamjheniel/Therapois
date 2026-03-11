import {test , expect} from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Super Admin Pagination', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Pagination works correctly on Flow page', { tag: ['@SuperAdmin', '@pagination'] }, async ({ page }) => {
    // Wait until a row is rendered, so we know the list is loaded
    await page.getByRole('checkbox').first().waitFor();

    // Locate the range text: e.g. "1-10 of 13642" or "11-20 of 13642"
    const range = page.getByText(/of\s+\d+$/).first(); // regex: "of <number>"
    await expect(range).toBeVisible();

    // Go up to the container that also holds the pagination buttons
    // (span -> parent div -> row container)
    const paginationRow = range.locator('xpath=../..');

    // Find the icon buttons inside this row only (<<, <, >, >>)
    const buttons = paginationRow.locator('[data-testid="icon-button-container"]');
    const firstBtn = buttons.nth(0); // <<
    const prevBtn  = buttons.nth(1); // <
    const nextBtn  = buttons.nth(2); // >
    const lastBtn  = buttons.nth(3); // >>

    // Read current page range
    const firstPageRange = (await range.textContent())?.trim() || '';
    console.log('First page:', firstPageRange);

    // 👉 NEXT PAGE
    await nextBtn.click();
    await page.waitForTimeout(1200); // allow React Native list to re-render

    const secondPageRange = (await range.textContent())?.trim() || '';
    console.log('Second page:', secondPageRange);

    expect(secondPageRange).not.toBe(firstPageRange);

    // 👉 LAST PAGE
    await lastBtn.click();
    await page.waitForTimeout(1500);

    const lastPageRange = (await range.textContent())?.trim() || '';
   console.log('Last page:', lastPageRange);

    // 👉 BACK TO FIRST PAGE
    const backToFirstRange = (await range.textContent())?.trim() || '';
    console.log('Back to first:', backToFirstRange);

    // Validate only that it returned to page 1
    expect(backToFirstRange).toMatch(/^1\s*[-–]\s*\d+/);
    });
});
