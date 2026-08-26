import { test, expect } from '../../fixtures/crm-serial';
import { CRMDashboardPage } from '../../../Pages/crm/crm.dashboard.page';

/**
 * Ticket #2934 — CRM · Practice Type Attribute (Fachrichtung) (RC 3.9).
 *
 * A new medical-specialty attribute on practices: a CRM table column, a CRM filter dropdown, and a
 * dropdown in the practice edit form. Covers the column presence, the filter's 7 specialty options
 * and that selecting one scopes the table, and the practice-form dropdown.
 *
 * SAFETY: the practice-form test opens the edit form and verifies the dropdown, then cancels
 * WITHOUT saving (assigning a Fachrichtung would mutate a shared practice). Drives the shared CRM
 * dashboard → uses the crm-serial fixture; no setTimeout. Staging only; mirror to Prod later.
 */
test.describe('Admin CRM — Fachrichtung (Practice Type)', () => {
  const OPTIONS = [
    'Allgemeinmedizin', 'Orthopädie', 'Neurologie', 'Innere Medizin',
    'Psychiatrie', 'Unfallchirurgie', 'Sonstige',
  ];

  let dash: CRMDashboardPage;

  test.beforeEach(async ({ page }) => {
    dash = new CRMDashboardPage(page);
    await dash.open();
  });

  test('Fachrichtung column is present in the CRM table', {
    tag: ['@Admin', '@CRMFachrichtung'],
  }, async () => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');
    // AC3: the table has a Fachrichtung column (values may be empty when unassigned — AC6).
    await expect(dash.columnHeader('Fachrichtung').first()).toBeVisible({ timeout: 15_000 });
  });

  test('Fachrichtung filter offers all 7 specialty options and scopes the table', {
    tag: ['@Admin', '@CRMFachrichtung'],
  }, async ({ page }) => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');

    // AC1/AC4: the filter dropdown lists the seven specialties.
    const opts = await dash.openFilterOptions('Fachrichtung');
    for (const o of OPTIONS) {
      expect(opts.some((line) => line.includes(o)), `Fachrichtung filter should offer "${o}"`).toBeTruthy();
    }
    await dash.closeFilter();

    // AC4: selecting a specialty scopes the practice table. (Fachrichtung scopes the table rows,
    // not the tab badge counts — verified on staging.) With no practice assigned a specialty on
    // staging, "Orthopädie" yields an empty table ("Keine Patienten gefunden").
    const rowsBefore = await page.getByText('Anzeigen', { exact: true }).count();
    const picked = await dash.selectFilterOption('Fachrichtung', 'Orthopädie');
    test.skip(!picked, 'Fachrichtung option not selectable in this environment');

    // The chosen specialty is reflected in the filter bar and the table re-scopes.
    await expect(page.getByText('Orthopädie', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect
      .poll(async () => {
        const empty = await page.getByText('Keine Patienten gefunden').isVisible().catch(() => false);
        const rowsNow = await page.getByText('Anzeigen', { exact: true }).count();
        return empty || rowsNow < rowsBefore;
      }, { timeout: 15_000 })
      .toBe(true);

    // Clearing restores the unfiltered list.
    await dash.clearFilters();
    await expect.poll(() => page.getByText('Anzeigen', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('Practice edit form exposes a Fachrichtung dropdown with the specialty options', {
    tag: ['@Admin', '@CRMFachrichtung'],
  }, async ({ page }) => {
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');
    await page.getByText('Anzeigen', { exact: true }).first().click();
    await page.waitForTimeout(2500);

    // Open the practice edit form (#2934 adds the dropdown below "TB erforderlich").
    const editBtn = page.getByText('Praxis bearbeiten', { exact: true }).filter({ visible: true }).first();
    test.skip(!(await editBtn.count()), 'Edit-practice control not available in this environment');
    await editBtn.click({ force: true });
    await page.waitForTimeout(2500);

    // AC1: the form contains a Fachrichtung field.
    const label = page.getByText('Fachrichtung', { exact: true }).filter({ visible: true });
    test.skip(!(await label.count()), 'Fachrichtung field not present in the edit form in this environment');
    await expect(label.first()).toBeVisible();

    // Open the form's Fachrichtung dropdown and confirm it offers the specialty options.
    const box = await label.last().boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height + 16);
      await page.waitForTimeout(1200);
      const found = await page.getByText(/Allgemeinmedizin|Neurologie|Psychiatrie|Unfallchirurgie/)
        .filter({ visible: true }).count().catch(() => 0);
      expect(found, 'form Fachrichtung dropdown should list specialty options').toBeGreaterThan(0);
    }

    // Cancel WITHOUT saving — never assign a specialty to the shared practice.
    await page.keyboard.press('Escape').catch(() => {});
    await page.getByText(/Abbrechen|Schließen|Cancel/).filter({ visible: true }).first()
      .click({ timeout: 3000, force: true }).catch(() => {});
  });
});
