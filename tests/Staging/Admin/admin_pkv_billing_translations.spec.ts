import { test, expect } from '@playwright/test';
import { PkvBillingPage, PKV_STATUS_SUBTABS } from '../../../Pages/admin/admin.pkv-billing.page';

/**
 * Ticket #2951 — Invoice Status German Translations in the PKV-Abrechnung tab (RC 3.9, epic #2947).
 *
 * All invoice-status subtabs render German labels: Alle / Fehler / Nicht gesendet / Gesendet /
 * Überfällig / Gemahnt / Inkasso / An Inkasso gesendet / Bezahlt / Storniert / Pausiert. Staging
 * only (per scope); mirror to Production later.
 */
test.describe('Admin — PKV Billing German Status Subtabs', () => {
  test('All invoice-status subtabs display German labels', {
    tag: ['@Admin', '@PkvTranslations'],
  }, async ({ page }) => {
    test.setTimeout(120_000);
    const pkv = new PkvBillingPage(page);
    await pkv.open();

    // AC1: every status subtab shows its German label.
    for (const label of PKV_STATUS_SUBTABS) {
      await expect(pkv.subtab(label)).toBeVisible({ timeout: 15_000 });
    }

    // AC3 (inverse): the pre-3.9 English-only subtab labels are gone. (Only labels that don't also
    // occur as column/tooltip values elsewhere are asserted absent.)
    const root = page.locator('#root');
    for (const en of ['Not Sent', 'To Debt Collector', 'On Hold']) {
      await expect(root).not.toContainText(en);
    }
  });
});
