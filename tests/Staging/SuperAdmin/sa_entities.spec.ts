import { test, expect } from '@playwright/test';

test.describe('Super Admin Entitäten', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/entities');
  });

  test(
    'Entitäten page loads with table',
    { tag: ['@SuperAdmin', '@Entities'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Entitätsverwaltung', { timeout: 15000 });
      await expect(root).toContainText('Therapios');
      await expect(root).toContainText('Action');
    }
  );

  test(
    'Entitäten add button visible',
    { tag: ['@SuperAdmin', '@Entities'] },
    async ({ page }) => {
      await expect(page.locator('#root')).toContainText('Neue Entität', { timeout: 15000 });
    }
  );
});
