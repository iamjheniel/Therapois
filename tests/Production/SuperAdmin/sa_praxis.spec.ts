import { test, expect } from '@playwright/test';

test.describe('Super Admin Praxis', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/practice');
  });

  test(
    'Praxis page loads with table',
    { tag: ['@SuperAdmin', '@Praxis'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Praxis Nachverfolgung CRM', { timeout: 15000 });
      await expect(root).toContainText('BSNR');
      await expect(root).toContainText('Praxis Name');
      await expect(root).toContainText('Telefon');
      await expect(root).toContainText('Adresse');
      await expect(root).toContainText('Arzt');
    }
  );

  test(
    'Praxis add button visible',
    { tag: ['@SuperAdmin', '@Praxis'] },
    async ({ page }) => {
      await expect(page.locator('#root')).toContainText('+ Praxis hinzufügen', { timeout: 15000 });
    }
  );
});
