import { test, expect } from '@playwright/test';

/**
 * Production mirror of the SuperAdmin "Daten" → "Export" (VO-Export) coverage. Replaces the removed
 * "Daten hochladen" import spec; see the Staging spec for the full rationale.
 */
test.describe('Super Admin VO-Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/prescriptionExport', { waitUntil: 'domcontentloaded' });
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
