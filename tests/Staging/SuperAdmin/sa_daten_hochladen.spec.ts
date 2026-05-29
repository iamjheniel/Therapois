import { test, expect } from '@playwright/test';

test.describe('Super Admin Daten Hochladen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/uploads');
    await page.waitForLoadState('networkidle');
  });

  test(
    'Daten hochladen page loads',
    { tag: ['@SuperAdmin', '@DatenHochladen'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Datei hochladen', { timeout: 15000 });
      await expect(root).toContainText('Import-Verlauf');
    }
  );

  test(
    'Daten hochladen import history columns',
    { tag: ['@SuperAdmin', '@DatenHochladen'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Import-Verlauf', { timeout: 15000 });
      await expect(root).toContainText('Verarbeitet am');
      await expect(root).toContainText('Ursprünglicher Name');
      await expect(root).toContainText('Hochgeladen von');
      await expect(root).toContainText('Status');
    }
  );
});
