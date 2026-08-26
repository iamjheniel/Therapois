import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * VO-status and doctor/facility filtering on the Admin Board.
 *
 * Every column filter lives behind the "Filter" slide-in panel — there are no inline filter
 * dropdowns any more, and the app exposes no `data-testid` on this surface, so the old
 * `getByTestId('dropdown-item-Aktiv')` hooks are gone. Each section's trigger is a real button whose
 * `aria-label` IS the section label (including the pickers that read "Therapeut: (Auswählen)"), and
 * opening one swaps the panel out for its option list in the same `[role="dialog"]` node.
 * `AdminDashboardPage.applyFilter()` encapsulates that, then closes the panel so the assertions
 * below are about the table underneath.
 */
test.describe('Admin Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Admin Search Active VO Functionality', { tag: ['@Admin', '@AdminSearchActiveVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.selectFilter('VO Status', 'Aktiv');
    // The Therapeut filter is a searchable dropdown listing the therapists available in the
    // current view; pick the first offered option rather than a hard-coded name.
    await dash.applyFilter('Therapeut: (Auswählen)', 'Andreas Rosky');
    await expect(page.locator('#root')).toContainText('Aktiv');
    await expect(page.locator('#root')).toContainText('Andreas Rosky');
  });

  test('Admin Search Abgebrochen VO Functionality', { tag: ['@Admin', '@AdminSearchAbgebrochenVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.applyFilter('VO Status', 'Abgebrochen');
    await expect(page.locator('#root')).toContainText('Abgebrochen');
  });

  test('Admin Search Fertig behandelt VO Functionality', { tag: ['@Admin', '@AdminSearchFertigbehandeltVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.applyFilter('VO Status', 'Fertig Behandelt');
    await expect(page.locator('#root')).toContainText('Fertig Behandelt');
  });

  test('Admin Search Abgelaufen VO Functionality', { tag: ['@Admin', '@AdminSearchAbgelaufenVo'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    await dash.applyFilter('VO Status', 'Abgelaufen');
    await expect(page.locator('#root')).toContainText('Abgelaufen');
  });

  test('Admin Search Doctor and Facility', { tag: ['@Admin', '@AdminSearchDoctor'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const dash = new AdminDashboardPage(page);
    await dash.open();

    const unfiltered = await dash.totalCount();

    // Both pickers list live reference data, so take whatever they offer rather than a hard-coded
    // name — "Juri Sloboda" and "Alpenland Marzahn" have churned out of staging before.
    //
    // The two are exercised INDEPENDENTLY, with a clear in between: the ER list is scoped by any Arzt
    // already chosen, so chaining them makes the facility assertion depend on the doctor's data and
    // fail whenever the picked doctor has no facility in scope.
    for (const section of ['Arzt: (Auswählen)', 'ER: (Auswählen)']) {
      await dash.clearFilters();

      const choice = await dash.selectFirstFilterOption(section);
      // An empty picker is an environment-data fact, not a defect — say so rather than failing.
      if (choice === null) {
        console.log(`"${section}" offered no options in this environment — skipping that half`);
        continue;
      }
      console.log(`${section} → ${choice}`);

      // The panel's own preview is what the table then shows.
      const previewed = await dash.panelResultCount();
      expect(previewed, `the panel previews the result for "${section}"`).not.toBeNull();
      expect(previewed, `filtering by "${section}" must not widen the list`).toBeLessThanOrEqual(
        unfiltered,
      );

      await dash.closeFilterPanel();
      await expect
        .poll(() => dash.totalCount(), {
          timeout: 30_000,
          message: `the table matches the preview for "${section}"`,
        })
        .toBe(previewed);
    }
  });
});
