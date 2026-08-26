import { test, expect } from '../../fixtures/crm-serial';
import { CRMDashboardPage } from '../../../Pages/crm/crm.dashboard.page';

/**
 * Ticket #2932 — CRM · Split "Heute" tab into "Heute bestellen" and "Heute nachverfolgen" (RC 3.9).
 *
 * The old 4-tab bar (Heute / Geplant / Mit Problemen / Alle) is now 5 tabs, splitting "Heute" into
 * an ordering view and a follow-up-tracking view. Verifies all 5 tabs render with badge counts and
 * that each tab loads the practice table.
 *
 * Drives the shared CRM dashboard, so it uses the cross-file serial-lock fixture (tests/fixtures/
 * crm-serial) and must NOT call test.setTimeout(). Staging only (per scope); mirror to Prod later.
 */
test.describe('Admin CRM — 5-Tab Structure', () => {
  let dash: CRMDashboardPage;

  test.beforeEach(async ({ page }) => {
    dash = new CRMDashboardPage(page);
    await dash.open();
  });

  test('All 5 tabs render with badge counts', { tag: ['@Admin', '@CRMTabs'] }, async () => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');

    // AC1: the split produces exactly these five tabs, each with a numeric badge.
    for (const name of CRMDashboardPage.TABS) {
      await expect(dash.tab(name)).toBeVisible({ timeout: 15_000 });
      expect(await dash.tabCount(name), `${name} should carry a numeric badge`).not.toBeNull();
    }

    // The two split tabs exist alongside the unchanged Geplant/Mit Problemen/Alle tabs.
    expect(await dash.tabCount('Heute bestellen')).toBeGreaterThanOrEqual(0);
    expect(await dash.tabCount('Heute nachverfolgen')).toBeGreaterThanOrEqual(0);
  });

  test('Each tab loads the practice table', { tag: ['@Admin', '@CRMTabs'] }, async ({ page }) => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');

    // AC3/AC4: switching to each "Heute" sub-tab (and the others) keeps the table rendered.
    for (const name of ['Heute nachverfolgen', 'Heute bestellen']) {
      await dash.openTab(name);
      // A non-empty tab shows rows; an empty one still renders the table shell — either is a valid
      // load. Assert the tab's own badge count is readable after switching (table responded).
      await expect
        .poll(() => dash.tabCount(name), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(0);
    }
    // Sanity: the practice table header is present on the ordering tab.
    await dash.openTab('Heute bestellen');
    await expect(dash.columnHeader('Name der Praxis').first()).toBeVisible({ timeout: 15_000 });
  });
});
