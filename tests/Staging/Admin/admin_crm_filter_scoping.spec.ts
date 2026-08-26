import { test, expect } from '../../fixtures/crm-serial';
import { CRMDashboardPage } from '../../../Pages/crm/crm.dashboard.page';

/**
 * Tickets #2931 (Region filter scopes the 5 summary cards) and #2936 (new ER / "Einrichtung"
 * filter scoping table, cards and tab counts) — RC 3.9.
 *
 * Both verify that applying a filter re-scopes the dashboard: the "Alle" tab total changes and at
 * least one of the 5 summary cards changes vs the unfiltered baseline, then clearing restores it.
 * (Exact per-region/per-ER counts are backend-derived and data-dependent, so the tests assert the
 * scoping *behaviour* rather than specific numbers.)
 *
 * Drives the shared CRM dashboard → uses the crm-serial fixture; no setTimeout. Staging only.
 */
test.describe('Admin CRM — Filter Scoping (Region & ER)', () => {
  let dash: CRMDashboardPage;

  test.beforeEach(async ({ page }) => {
    dash = new CRMDashboardPage(page);
    await dash.open();
  });

  /** Picks the first plausible option label from an opened filter's option lines. */
  function firstRealOption(lines: string[]): string | undefined {
    return lines.find(
      (o) => /[A-Za-zÄÖÜäöü]/.test(o) && o.length >= 3 && o.length <= 60 && !/Filter löschen|Suchen/.test(o),
    );
  }

  test('Region filter scopes the summary cards (#2931)', {
    tag: ['@Admin', '@CRMRegionScope'],
  }, async () => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');

    const cardsBefore = await dash.allCardValues();
    const alleBefore = await dash.tabCount('Alle');
    test.skip(alleBefore == null, 'Alle tab count not readable in this environment');

    const region = firstRealOption(await dash.openFilterOptions('Region'));
    await dash.closeFilter();
    test.skip(!region, 'no region options available in this environment');

    test.skip(!(await dash.selectFilterOption('Region', region!)), 'region option not selectable');

    // The table/tab total re-scopes to the region...
    await expect.poll(() => dash.tabCount('Alle'), { timeout: 15_000 }).not.toBe(alleBefore);
    // ...and so do the summary cards (the point of #2931): at least one card value changes.
    await expect
      .poll(async () => {
        const now = await dash.allCardValues();
        return CRMDashboardPage.CARDS.some((c) => now[c] !== cardsBefore[c]);
      }, { timeout: 15_000 })
      .toBe(true);

    // Clearing the region restores the company-wide totals (AC3).
    await dash.clearFilters();
    await expect.poll(() => dash.tabCount('Alle'), { timeout: 15_000 }).toBe(alleBefore);
  });

  test('ER ("Einrichtung") filter scopes the dashboard (#2936)', {
    tag: ['@Admin', '@CRMErFilter'],
  }, async ({ page }) => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');

    // AC1: the ER dropdown sits alongside Region/Therapist and lists elderly-care-home options
    // (with its own search box).
    const erOptions = await dash.openFilterOptions('Einrichtung');
    const er = firstRealOption(erOptions);
    expect(er, 'Einrichtung filter should list at least one ER').toBeTruthy();
    await expect(page.getByRole('textbox').filter({ visible: true })).not.toHaveCount(0);
    await dash.closeFilter();

    const cardsBefore = await dash.allCardValues();
    const alleBefore = await dash.tabCount('Alle');
    test.skip(alleBefore == null, 'Alle tab count not readable in this environment');

    test.skip(!(await dash.selectFilterOption('Einrichtung', er!)), 'ER option not selectable');

    // AC2/AC3/AC4: table, cards and tab counts scope to the selected ER.
    await expect.poll(() => dash.tabCount('Alle'), { timeout: 15_000 }).not.toBe(alleBefore);
    await expect
      .poll(async () => {
        const now = await dash.allCardValues();
        return CRMDashboardPage.CARDS.some((c) => now[c] !== cardsBefore[c]);
      }, { timeout: 15_000 })
      .toBe(true);

    // AC6: clearing the ER filter returns to unfiltered totals.
    await dash.clearFilters();
    await expect.poll(() => dash.tabCount('Alle'), { timeout: 15_000 }).toBe(alleBefore);
  });
});
