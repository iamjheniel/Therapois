import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Admin Reports', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
    // Use the robust sidebar nav helper (waits for + opens the menu, glyph-agnostic) instead of
    // a raw nerd-font glyph click, which flakes when the sidebar hasn't painted yet.
    const app = new AppPage(page);
    await app.navTo(/Berichte/);
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
