import { test, expect } from '@playwright/test';

test.describe('Super Admin Entitäten', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/entities', { waitUntil: 'domcontentloaded' });
  });

  test(
    'Entitäten page loads with table',
    { tag: ['@SuperAdmin', '@Entities'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('Entitätsverwaltung', { timeout: 15000 });
      await expect(root).toContainText('Action');

      // The list used to be asserted by naming one of its rows ("Therapios"). No such entity
      // exists any more — staging now holds seven Curano companies — so pinning a row name made
      // this a data fixture rather than a page-loads check. Gate on the pager reporting a
      // non-empty list instead, which is what "loads with table" actually means.
      await expect
        .poll(
          async () => {
            const m = (await root.innerText()).match(/1-(\d+)\s+of\s+(\d+)/);
            return m ? parseInt(m[2], 10) : 0;
          },
          { timeout: 20_000, message: 'the entity table must list at least one entity' },
        )
        .toBeGreaterThan(0);
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
