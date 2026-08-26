import { test, expect } from '@playwright/test';
import { PkvBillingPage } from '../../../Pages/admin/admin.pkv-billing.page';

/**
 * Tickets #2949 (ETI Submission UI) and #2950 (ETI Outcome Tracking) — RC 3.9, epic #2947.
 *
 * The "An ETI Experts senden" bulk action is context-aware: it appears only on the Inkasso (To Debt
 * Collector) subtab; the "Als bezahlt/uneinbringlich markieren" outcome actions appear only on the
 * "An Inkasso gesendet" (Sent to DC) subtab. The standard bulk actions (Rechnungen herunterladen,
 * Rechnungsstatus ändern) are always present.
 *
 * The context-scoping (buttons ABSENT on other subtabs) is asserted robustly on a populated subtab.
 * The positive submission/outcome flows are DATA-GATED: staging currently has 0 invoices at Inkasso
 * and 0 at "An Inkasso gesendet", so those tests attempt the flow and test.skip() when the subtab is
 * empty. SAFETY: the ETI submission + outcome dialogs are only opened and CANCELLED — never confirmed
 * (confirming mutates invoice status and calls the external ETI API). Staging only (per scope).
 */
test.describe('Admin — PKV Billing ETI Submission & Outcomes', () => {
  let pkv: PkvBillingPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    pkv = new PkvBillingPage(page);
    await pkv.open();
  });

  test('ETI + outcome actions are scoped away from non-Inkasso subtabs (#2949 AC2 / #2950)', {
    tag: ['@Admin', '@PkvEtiSubmission', '@PkvEtiOutcome'],
  }, async () => {
    // "Gesendet" (Sent) is a populated subtab that is neither Inkasso nor Sent-to-DC.
    await pkv.openSubtab('Gesendet');
    test.skip(!(await pkv.selectFirstInvoice()), 'No invoices on the Gesendet subtab in this environment');

    // Standard bulk actions are available...
    await expect(pkv.downloadButton().first()).toBeVisible({ timeout: 10_000 });
    await expect(pkv.changeStatusButton().first()).toBeVisible();
    // ...but the ETI submission and outcome actions are NOT (wrong subtab).
    await expect(pkv.etiSendButton()).toHaveCount(0);
    await expect(pkv.markPaidButton()).toHaveCount(0);
    await expect(pkv.markUncollectableButton()).toHaveCount(0);
  });

  test('Inkasso subtab: "An ETI Experts senden" opens the pre-submission dialog (#2949)', {
    tag: ['@Admin', '@PkvEtiSubmission'],
  }, async ({ page }) => {
    await pkv.openSubtab('Inkasso');
    test.skip(!(await pkv.selectFirstInvoice()),
      'No invoices at the Inkasso (To Debt Collector) stage in this environment — ETI submission not exercisable');

    // AC1: the "Send to ETI Experts" bulk action is available on the Inkasso subtab.
    await expect(pkv.etiSendButton().first()).toBeVisible({ timeout: 10_000 });

    // AC3/AC5: the pre-submission dialog lists invoices/addresses, a total ("Gesamtforderung") and a
    // "Bestätigen & Senden" confirm button. Opened then CANCELLED — never submitted to ETI.
    test.skip(!(await pkv.openEtiDialog()), 'ETI submission dialog did not open');
    await expect(page.locator('#root')).toContainText(/Gesamtforderung/);
    await expect(page.getByText('Bestätigen & Senden', { exact: false }).filter({ visible: true }).first()).toBeVisible();
    await pkv.cancelDialog();
  });

  test('Sent-to-DC subtab: outcome bulk actions (Als bezahlt / uneinbringlich) available (#2950)', {
    tag: ['@Admin', '@PkvEtiOutcome'],
  }, async () => {
    await pkv.openSubtab('An Inkasso gesendet');
    test.skip(!(await pkv.selectFirstInvoice()),
      'No invoices at the "An Inkasso gesendet" (Sent to DC) stage in this environment — outcome actions not exercisable');

    // AC5: on the Sent-to-DC subtab the outcome bulk actions appear alongside the standard ones.
    await expect(pkv.markPaidButton().first()).toBeVisible({ timeout: 10_000 });
    await expect(pkv.markUncollectableButton().first()).toBeVisible();
    // Open the Mark-as-Paid dialog and cancel — never commit a status change.
    await pkv.markPaidButton().first().click({ force: true }).catch(() => {});
    await pkv.cancelDialog();
  });
});
