import { test, expect } from '@playwright/test';

/**
 * SuperAdmin "Daten" → "Export" feature: the VO-Export page (/prescriptionExport).
 *
 * This replaces the former "Daten hochladen" (data-import) coverage — that import page was removed
 * from the app: the "Daten" top-nav dropdown now contains only "Export", which opens VO-Export
 * (a filter panel + "Exportverlauf" export-history table). The old spec navigated to /uploads,
 * which now just renders the dashboard, so it failed on both Staging and Production.
 */
test.describe('Super Admin VO-Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/prescriptionExport', { waitUntil: 'domcontentloaded' });
  });

  test(
    'VO-Export page loads with filter and export controls',
    { tag: ['@SuperAdmin', '@Export'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('VO-Export', { timeout: 15000 });
      await expect(root).toContainText('Filter');
      await expect(root).toContainText('Exportieren');
      await expect(root).toContainText('Exportverlauf');
    }
  );

  test(
    'VO-Export history table shows expected columns',
    { tag: ['@SuperAdmin', '@Export'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Exportverlauf', { timeout: 15000 });
      await expect(root).toContainText('Erstellt am');
      await expect(root).toContainText('# VOs');
      await expect(root).toContainText('Erstellt von');
      await expect(root).toContainText('Status');
      await expect(root).toContainText('Aktion');
    }
  );
});
