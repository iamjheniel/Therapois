import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * VO-status filtering on the Super Admin board. Mirrors `admin_search`: the toolbar was redesigned
 * so every column filter now lives behind the "☰ Filter" slide-in panel, and this surface exposes
 * no `data-testid` (the old `getByTestId('dropdown-item-Aktiv')` / `getByTestId('Fertig Behandelt')`
 * hooks are gone). `AdminDashboardPage` drives the panel for both roles.
 */
test.describe('Super Admin Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Super Admin Search Active VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchActiveVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.selectFilter('VO Status', 'Aktiv');
    // The Therapeut filter is a searchable dropdown listing the therapists available in the
    // current view; pick the first offered option rather than a hard-coded name.
    await dash.selectFilter('Therapeut: (Auswählen)', 'Andreas Rosky');
    await expect(page.locator('#root')).toContainText('Aktiv');
    await expect(page.locator('#root')).toContainText('Andreas Rosky');
  });

  test('Super Admin Search Abgebrochen VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchAbgebrochenVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.selectFilter('VO Status', 'Abgebrochen');
    await expect(page.locator('#root')).toContainText('Abgebrochen');
  });

  test('Super Admin Search Fertig behandelt VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchFertigbehandeltVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.selectFilter('VO Status', 'Fertig Behandelt');
    await expect(page.locator('#root')).toContainText('Fertig Behandelt');
  });

  test('Super Admin Search Abgelaufen VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchAbgelaufenVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.selectFilter('VO Status', 'Abgelaufen');
    await expect(page.locator('#root')).toContainText('Abgelaufen');
  });
});
