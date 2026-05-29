import { test, expect } from '@playwright/test';

test.describe('Super Admin VO Rückseite Upload', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/back-of-vo');
  });

  test(
    'VO Rückseite page loads',
    { tag: ['@SuperAdmin', '@VORueckseite'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('VO Rückseite Upload', { timeout: 15000 });
      await expect(root).toContainText('Massen-Upload von VO-Rückseitenbildern');
      await expect(root).toContainText('VO-Rückseitenbilder hierher ziehen');
      await expect(root).toContainText('Upload Batch-Verlauf');
    }
  );

  test(
    'VO Rückseite batch history columns',
    { tag: ['@SuperAdmin', '@VORueckseite'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Batch #', { timeout: 15000 });
      await expect(root).toContainText('Datum');
      await expect(root).toContainText('Bilder');
      await expect(root).toContainText('Status');
    }
  );
});
