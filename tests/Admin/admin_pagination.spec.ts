import {test , expect} from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Admin Pagination', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Check Pagination', { tag: ['@Admin', '@pagination'] }, async ({ page }) => {
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝101-10 of 12658󰘀󰅁󰅂󰘁');
    await page.getByRole('button', { name: 'chevron-right' }).click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝1011-20 of 12658󰘀󰅁󰅂󰘁');
    await page.getByRole('button', { name: 'chevron-left' }).click();
    await page.getByLabel('pagination-container').click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝101-10 of 12658󰘀󰅁󰅂󰘁');
    await page.getByRole('button', { name: 'page-last' }).click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝1012651-12658 of 12658󰘀󰅁󰅂󰘁');
    await page.getByRole('button', { name: 'page-first' }).click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝101-10 of 12658󰘀󰅁󰅂󰘁');
    await page.getByTestId('button').click();
    await page.locator('div').filter({ hasText: /^15$/ }).nth(1).click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝151-15 of 12658󰘀󰅁󰅂󰘁');
    await page.getByTestId('button').click();
    await page.locator('div').filter({ hasText: /^25$/ }).nth(1).click();
    await expect(page.getByLabel('pagination-container')).toContainText('Zeilen pro Seite󰍝251-25 of 12658󰘀󰅁󰅂󰘁');
    });
});
