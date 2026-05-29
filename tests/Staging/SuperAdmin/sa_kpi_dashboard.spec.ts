import { test, expect } from '@playwright/test';

test.describe('Super Admin KPI Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/kpi');
    await page.waitForLoadState('networkidle');
  });

  test(
    'KPI Dashboard page loads',
    { tag: ['@SuperAdmin', '@KPIDashboard'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('KPI Dashboard', { timeout: 15000 });
      await expect(root).toContainText('Performance Chart');
      await expect(root).toContainText('Over Time Chart');
      await expect(root).toContainText('KPI Overview Tables');
    }
  );

  test(
    'KPI Dashboard period filters visible',
    { tag: ['@SuperAdmin', '@KPIDashboard'] },
    async ({ page }) => {
      const root = page.locator('#root');
      await expect(root).toContainText('This Month', { timeout: 15000 });
      await expect(root).toContainText('Last Month');
      await expect(root).toContainText('Last 7 Days');
    }
  );

  test(
    'KPI Dashboard switches to Last Month',
    { tag: ['@SuperAdmin', '@KPIDashboard'] },
    async ({ page }) => {
      await expect(page.locator('#root')).toContainText('Zeitraum:', { timeout: 15000 });
      await page.getByText('Last Month', { exact: true }).click();
      await expect(page.locator('#root')).toContainText('Zeitraum:');
    }
  );
});
