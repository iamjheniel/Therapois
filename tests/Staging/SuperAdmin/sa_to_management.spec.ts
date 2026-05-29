import { test, expect } from '@playwright/test';

test.describe('Super Admin TO Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/to-management');
    await page.waitForLoadState('networkidle');
  });

  test(
    'TO Management page loads with tabs',
    { tag: ['@SuperAdmin', '@TOManagement'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('TO Verwaltung', { timeout: 15000 });
      await expect(root).toContainText('Auslastung');
      await expect(root).toContainText('Abrechnung');
      await expect(root).toContainText('KPIs');
    }
  );

  test(
    'TO Management therapist health counters visible',
    { tag: ['@SuperAdmin', '@TOManagement'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Red Therapists', { timeout: 15000 });
      await expect(root).toContainText('Yellow Therapists');
      await expect(root).toContainText('Green Therapists');
      await expect(root).toContainText('Gray Therapists');
    }
  );

  test(
    'TO Management filter dropdowns visible',
    { tag: ['@SuperAdmin', '@TOManagement'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Problemtyp:', { timeout: 15000 });
      await expect(root).toContainText('Problemstatus:');
      await expect(root).toContainText('TO-Mitarbeiter:');
      await expect(root).toContainText('Therapeuten-Gesundheit:');
    }
  );
});
