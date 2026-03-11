import { test, expect } from '@playwright/test';

test.describe('Admin Reports', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard');
    // \uF451 is the private-use icon character that renders as the hamburger menu
    await page.getByText('\uF451').click();
    await page.getByRole('button', { name: /Berichte/ }).click();
    await expect(page.locator('#root')).toContainText('Reports', { timeout: 15000 });
  });

  test(
    'Reports page loads with expected content',
    { tag: ['@Admin', '@Reports'] },
    async ({ page }) => {
      await expect(page.locator('#root')).toContainText('Reports');
      await expect(page.locator('#root')).toContainText('Behandelte Patienten');
      await expect(page.locator('#root')).toContainText('Behandlungen durchgeführt');
      await expect(page.locator('#root')).toContainText('Zeitraum');
      await expect(page.locator('#root')).toContainText('PDF exportieren');
    }
  );

  test(
    'Reports filter by date range',
    { tag: ['@Admin', '@Reports', '@ReportsDateFilter'] },
    async ({ page }) => {
      await page.getByRole('button', { name: /Zeitraum/i }).click();
      await expect(page.locator('#root')).toContainText('Zeitraum', { timeout: 10000 });
    }
  );

  test(
    'Reports filter by Therapieform',
    { tag: ['@Admin', '@Reports', '@ReportsTherapieformFilter'] },
    async ({ page }) => {
      await page.getByText('Therapieform').click();
      await page.getByText('Physiotherapie').click();
      await expect(page.locator('#root')).toContainText('Physiotherapie');
    }
  );

  test(
    'Reports PDF export',
    { tag: ['@Admin', '@Reports', '@ReportsExport'] },
    async ({ page }) => {
      // Therapieform must be selected before export
      await page.getByText('Therapieform').click();
      await page.getByText('Physiotherapie').click();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByText('PDF exportieren').click(),
      ]);
      expect(download.suggestedFilename()).toBeTruthy();
    }
  );
});
