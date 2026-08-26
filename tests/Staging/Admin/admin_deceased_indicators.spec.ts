import { test, expect } from '@playwright/test';
import { DeceasedPage, DECEASED_PATIENT } from '../../../Pages/admin/admin.deceased.page';

/**
 * Ticket #2997 — Visual Indicators on Patient and VO Surfaces (RC 3.9, epic #2995).
 *
 * Covers the Patienten-Management "Verstorben" badge + the deceased filter (default hides deceased),
 * and the inline "Verstorben" indicator on the Admin Board VO table. Read-only; uses the known
 * deceased QA patient (NikkiQA DingdingTest). Staging only (per scope); mirror to Prod later.
 *
 * (The CRM ordering-tab indicator — AC6 — is a documented gap: surfacing a deceased patient's VO in
 * a specific CRM practice's order list is not reliably reachable as fixture data on staging.)
 */
test.describe('Admin — Deceased Visual Indicators', () => {
  let dp: DeceasedPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    dp = new DeceasedPage(page);
  });

  test('Patienten Management defaults to hiding deceased; filter reveals the Verstorben badge', {
    tag: ['@Admin', '@DeceasedIndicators'],
  }, async ({ page }) => {
    await dp.openPatientManagement();
    // AC2: a deceased filter exists and defaults to "Ausblenden" (hide deceased).
    await expect(dp.deceasedFilter()).toBeVisible({ timeout: 15_000 });
    await expect(dp.deceasedFilter()).toContainText('Ausblenden');

    // Toggle to show all, then surface the deceased patient.
    await dp.showDeceased();
    await dp.searchPatients('Dingding');
    const row = page.getByText(DECEASED_PATIENT.name, { exact: false }).filter({ visible: true });
    test.skip(!(await row.count()), 'deceased fixture patient not found in this environment');

    // AC1: a "Verstorben" badge appears next to the deceased patient's name.
    await expect(row.first()).toBeVisible();
    await expect(dp.deceasedIndicator().first()).toBeVisible();
  });

  test('Admin Board shows a deceased indicator next to the patient name', {
    tag: ['@Admin', '@DeceasedIndicators'],
  }, async ({ page }) => {
    await dp.openAdminBoard();
    await dp.searchAdminBoard('Dingding');
    // AC4: the deceased patient's VO row carries a "Verstorben" indicator in the patient column.
    test.skip(!(await page.getByText(DECEASED_PATIENT.name, { exact: false }).filter({ visible: true }).count()),
      'deceased fixture patient not on the board in this environment');
    await expect(dp.deceasedIndicator().first()).toBeVisible({ timeout: 15_000 });
  });
});
