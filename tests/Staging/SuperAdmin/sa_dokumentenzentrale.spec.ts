import { test, expect } from '@playwright/test';

test.describe('Super Admin Dokumentenzentrale', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/document-center');
    await page.waitForLoadState('networkidle');
  });

  test(
    'Dokumentenzentrale page loads with stat cards',
    { tag: ['@SuperAdmin', '@Dokumentenzentrale'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Dokumentenzentrale', { timeout: 15000 });
      await expect(root).toContainText('Therapieberichte');
      await expect(root).toContainText('Honorarvereinbarungen');
      await expect(root).toContainText('Vorabinformationen');
      await expect(root).toContainText('Infoblätter');
    }
  );

  test(
    'Dokumentenzentrale document table columns',
    { tag: ['@SuperAdmin', '@Dokumentenzentrale'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Patient', { timeout: 15000 });
      await expect(root).toContainText('VO Nr.');
      await expect(root).toContainText('VO-Status');
      await expect(root).toContainText('Arzt / Praxis');
      await expect(root).toContainText('Therapeut');
      await expect(root).toContainText('Erstellt am');
    }
  );

  test(
    'Dokumentenzentrale ZIP download button visible',
    { tag: ['@SuperAdmin', '@Dokumentenzentrale'] },
    async ({ page }) => {
      await expect(page.locator('#root')).toContainText('ZIP herunterladen', { timeout: 15000 });
    }
  );
});
