import { test, expect } from '@playwright/test';
import { AbrechnungPage } from '../../../Pages/superadmin/sa.abrechnung.page';

// Ref: https://github.com/therapios/monorepo/issues/1371
// Feature: VO Validation — review VOs against validation checks,
// mark as Validated / For Fixing / Unable to Validate.
// Out of scope: Billing tab, Copayment tab, bulk operations.

test.describe('Super Admin - Abrechnung (VO Validation)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  // ────────────────────────────────────────────────────
  // Test 1: Page loads with expected columns and tabs
  // ────────────────────────────────────────────────────
  test(
    'SA Abrechnung page loads with table and tabs',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.expectTableVisible();

      // Verify all three tabs are present
      await expect(page.locator('#root')).toContainText(/All/i);
      await expect(page.locator('#root')).toContainText(/No Status/i);
      await expect(page.locator('#root')).toContainText(/For Fixing/i);
    }
  );

  // ────────────────────────────────────────────────────
  // Test 2: Switch to "For Fixing" tab
  // ────────────────────────────────────────────────────
  test(
    'SA Switch to For Fixing tab',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.clickTab('For Fixing');
      await ab.expectTabActive('For Fixing');
    }
  );

  // ────────────────────────────────────────────────────
  // Test 3: Switch to "No Status" tab
  // ────────────────────────────────────────────────────
  test(
    'SA Switch to No Status tab',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.clickTab('No Status');
      await ab.expectTabActive('No Status');
    }
  );

  // ────────────────────────────────────────────────────
  // Test 4: Filter by VO Status — Aktiv
  // ────────────────────────────────────────────────────
  test(
    'SA Filter Abrechnung by VO Status Aktiv',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.filterByVoStatus('Aktiv');
      await expect(page.locator('#root')).toContainText('Aktiv', {
        timeout: 10_000,
      });
    }
  );

  // ────────────────────────────────────────────────────
  // Test 5: Filter by VO Status — Fertig Behandelt
  // ────────────────────────────────────────────────────
  test(
    'SA Filter Abrechnung by VO Status Fertig Behandelt',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.filterByVoStatus('Fertig Behandelt');
      await expect(page.locator('#root')).toContainText('Fertig Behandelt', {
        timeout: 10_000,
      });
    }
  );

  // ────────────────────────────────────────────────────
  // Test 6: Filter by VO Status — Abgerechnet
  // ────────────────────────────────────────────────────
  test(
    'SA Filter Abrechnung by VO Status Abgebrochen',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.filterByVoStatus('Abgebrochen');
      await expect(page.locator('#root')).toContainText('Abgebrochen', {
        timeout: 10_000,
      });
    }
  );

  // ────────────────────────────────────────────────────
  // Test 7: Filter by Therapist
  // ────────────────────────────────────────────────────
  test(
    'SA Filter Abrechnung by Therapist',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      // The therapist filter lists the therapists available in the current view;
      // Sandra Zeibig is no longer offered, so filter by the first available option.
      await ab.filterByTherapist('Andreas Rosky');
      await expect(page.locator('#root')).toContainText('Andreas Rosky', {
        timeout: 10_000,
      });
    }
  );

  // ────────────────────────────────────────────────────
  // Test 8: Filter by Einrichtung (ER)
  // ────────────────────────────────────────────────────
  test(
    'SA Filter Abrechnung by Einrichtung',
    { tag: ['@SuperAdmin', '@Abrechnung'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.filterByEinrichtung('Alpenland Marzahn');
      await expect(page.locator('#root')).toContainText(
        'Alpenland Marzahn',
        { timeout: 10_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 9: Open VO validation detail
  // ────────────────────────────────────────────────────
  test(
    'SA Open VO validation detail',
    { tag: ['@SuperAdmin', '@Abrechnung', '@VOValidation'] },
    async ({ page }) => {
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();

      // Navigate to No Status tab where unvalidated VOs live
      await ab.clickTab('No Status');

      // Click Validate on the first available row
      await page
        .getByText('Validate', { exact: true })
        .first()
        .click();

      // Validation detail panel / checklist should open
      await expect(page.locator('#root')).toContainText(
        /Validation|Validierung|VO Nr/i,
        { timeout: 15_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 10: Mark VO as Validated
  // ────────────────────────────────────────────────────
  test(
    'SA Mark VO as Validated',
    { tag: ['@SuperAdmin', '@Abrechnung', '@VOValidation'] },
    async ({ page }) => {
      test.fixme(true, 'Validation checks API returns 403 for SA Jhen — action buttons never load');
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.clickTab('No Status');

      await page.getByText('Validate', { exact: true }).first().click();

      await expect(page.locator('#root')).toContainText(
        /Validation|Validierung/i,
        { timeout: 15_000 }
      );

      await ab.markAsValidated();
      await ab.confirmStatusChange();
      await ab.expectToast(/Validated|validiert/i);
    }
  );

  // ────────────────────────────────────────────────────
  // Test 11: Mark VO as For Fixing
  // ────────────────────────────────────────────────────
  test(
    'SA Mark VO as For Fixing',
    { tag: ['@SuperAdmin', '@Abrechnung', '@VOValidation'] },
    async ({ page }) => {
      test.fixme(true, 'Validation checks API returns 403 for SA Jhen — action buttons never load');
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.clickTab('No Status');

      await page.getByText('Validate', { exact: true }).first().click();

      await expect(page.locator('#root')).toContainText(
        /Validation|Validierung/i,
        { timeout: 15_000 }
      );

      await ab.markAsForFixing();
      await ab.confirmStatusChange();
      await ab.expectToast(/For Fixing|Korrigieren/i);
    }
  );

  // ────────────────────────────────────────────────────
  // Test 12: Mark VO as Unable to Validate
  // ────────────────────────────────────────────────────
  test(
    'SA Mark VO as Unable to Validate',
    { tag: ['@SuperAdmin', '@Abrechnung', '@VOValidation'] },
    async ({ page }) => {
      test.fixme(true, 'Validation checks API returns 403 for SA Jhen — action buttons never load');
      const ab = new AbrechnungPage(page);

      await ab.openAbrechnung();
      await ab.clickTab('No Status');

      await page.getByText('Validate', { exact: true }).first().click();

      await expect(page.locator('#root')).toContainText(
        /Validation|Validierung/i,
        { timeout: 15_000 }
      );

      await ab.markAsUnableToValidate();
      await ab.confirmStatusChange();
      await ab.expectToast(/Unable to Validate|Nicht validierbar/i);
    }
  );
});
