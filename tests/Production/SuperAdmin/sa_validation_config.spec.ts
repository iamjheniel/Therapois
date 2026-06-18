import { test, expect } from '@playwright/test';

test.describe('Super Admin Validierungskonfiguration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/validation-config', { waitUntil: 'domcontentloaded' });
  });

  test(
    'Validierungskonfiguration page loads',
    { tag: ['@SuperAdmin', '@ValidationConfig'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Validierungskonfiguration', { timeout: 15000 });
      await expect(root).toContainText('Zuletzt aktualisiert');
      await expect(root).toContainText('Erstellungsprüfungen');
    }
  );

  test(
    'Validierungskonfiguration rule table columns',
    { tag: ['@SuperAdmin', '@ValidationConfig'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Prüfung', { timeout: 15000 });
      await expect(root).toContainText('GKV Standard');
      await expect(root).toContainText('GKV LHB');
      await expect(root).toContainText('GKV BVB');
      await expect(root).toContainText('PKV');
      await expect(root).toContainText('UV/BG');
    }
  );

  test(
    'Validierungskonfiguration includes auto-validation rules',
    { tag: ['@SuperAdmin', '@ValidationConfig'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Pflichtfelder vollständig', { timeout: 15000 });
      await expect(root).toContainText('Heilmittelbereich');
    }
  );
});
