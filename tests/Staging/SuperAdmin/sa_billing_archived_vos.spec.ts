import { test, expect } from '@playwright/test';
import {
  ARCHIVED,
  BillingArchivedPage,
  DEFAULT_STATUSES,
  INVOICE_STATUSES,
  looksArchived,
  TAB_COPAYMENT,
  TAB_PKV,
} from '../../../Pages/superadmin/sa.billing-archived.page';

/**
 * RC 3.11 #3277 — "Zuzahlungsverwaltung & PKV-Abrechnung: Find Invoices of Archived VOs".
 *
 * A VO archives automatically ~30 days after it is billed, and its row used to disappear from both
 * billing lists even though the invoice is untouched. #3277 adds "Archiviert" to the VO Status
 * filter on both tabs, and makes search return an archived row even when that filter is not set —
 * while leaving the default view excluding archived rows exactly as before.
 *
 * **Read-only: every request is a GET, and the UI half only opens a tab and a dropdown.**
 *
 * Fixture: **VO 7943-3** (Dr. Ernst Thomass), archived, GKV, invoice **R426-68**. The PM recorded
 * that invoice as "Gesendet" on 2026-08-12; it has since aged to `overdue`, which is the point of
 * AC3 — the row shows the *invoice's* own lifecycle, and the VO archiving never gives it a status of
 * its own. So nothing here pins a literal invoice status; it pins that the status is a real invoice
 * status and never "archived".
 *
 * **A ticket-level problem the developer already flagged, confirmed here:** the QA steps ask to
 * verify 7943-3 on *both* tabs, but Zuzahlungsverwaltung requires `insuranceType = public` and
 * PKV-Abrechnung requires `private` — one mutually exclusive column, so no VO can appear on both.
 * The PKV half is therefore checked against the PKV list's own archived population.
 */

const FIXTURE = {
  number: '7943-3',
  patientLastName: 'Thomass',
  invoiceNumber: 'R426-68',
  insuranceType: 'public',
};

test.describe('Invoices of archived VOs on the billing lists (#3277)', () => {
  let billing: BillingArchivedPage;

  test.beforeEach(async ({ page }) => {
    billing = new BillingArchivedPage(page);
    await billing.open();
  });

  test(
    'AC5 — the default view on both tabs still excludes archived VOs',
    { tag: ['@SuperAdmin', '@BillingArchived', '@ReadOnly'] },
    async () => {
      test.setTimeout(240_000);

      for (const kind of ['copaymentBilling', 'pkvBilling'] as const) {
        const { total, rows } = await billing.list(kind);
        const statuses = [...new Set(rows.map((r) => r.treatmentStatus))].sort();
        console.log(`[#3277] ${kind} default view: ${total} rows, statuses ${JSON.stringify(statuses)}`);

        expect(rows.length, `${kind} default view must return rows to judge`).toBeGreaterThan(0);
        expect(
          rows.filter((r) => r.treatmentStatus === ARCHIVED).map((r) => r.number),
          `${kind} default view must not contain archived VOs`,
        ).toEqual([]);
        // The everyday list stays the closed set of active cases it has always been.
        expect(statuses.every((s) => DEFAULT_STATUSES.includes(s)), `${kind} statuses ⊆ ${DEFAULT_STATUSES}`).toBe(true);
        expect(rows.some((r) => r.number === FIXTURE.number), `${FIXTURE.number} must be absent by default`).toBe(false);
      }
    },
  );

  test(
    'AC3 — the Archiviert filter returns archived rows, each keeping its own invoice status',
    { tag: ['@SuperAdmin', '@BillingArchived', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      for (const kind of ['copaymentBilling', 'pkvBilling'] as const) {
        const { total, rows } = await billing.list(kind, { treatmentStatus: ARCHIVED });
        console.log(`[#3277] ${kind} + ${ARCHIVED}: ${total} rows`);

        expect(total, `${kind} must return archived rows when the filter is applied`).toBeGreaterThan(0);
        expect(
          [...new Set(rows.map((r) => r.treatmentStatus))],
          `every row returned under the ${ARCHIVED} filter is archived`,
        ).toEqual([ARCHIVED]);

        // AC3's second half: invoices have no archived state, so each row must still carry one of
        // the invoice's own nine statuses.
        const withInvoice = rows.filter((r) => r.invoice);
        const seen = [...new Set(withInvoice.map((r) => r.invoice!.status))];
        const undocumented = seen.filter((s) => !INVOICE_STATUSES.includes(s));
        console.log(`[#3277] ${kind} invoice statuses on archived rows: ${JSON.stringify(seen)}`);
        if (undocumented.length) {
          console.log(`[#3277] note — statuses outside the ticket's documented nine: ${JSON.stringify(undocumented)}`);
        }

        expect(withInvoice.length, `${kind} archived rows must carry invoices`).toBeGreaterThan(0);
        expect(
          withInvoice.filter((r) => !r.invoice!.status).map((r) => r.number),
          'every archived row still shows an invoice status',
        ).toEqual([]);
        expect(
          withInvoice.filter((r) => looksArchived(r.invoice!.status)).map((r) => `${r.number}=${r.invoice!.status}`),
          'an invoice must never inherit the VO\'s archived state — invoices have no archived status',
        ).toEqual([]);
      }

      // The fixture itself, found by walking the filtered copayment list.
      const found = await billing.findInList('copaymentBilling', ARCHIVED, FIXTURE.number);
      console.log(
        `[#3277] ${FIXTURE.number} found on page ${found.page} of the archived copayment list ` +
          `(${found.scanned} rows scanned) — invoice ${found.row?.invoice?.invoiceNumber} / ${found.row?.invoice?.status}`,
      );
      expect(found.row, `${FIXTURE.number} must be browsable under the ${ARCHIVED} filter`).not.toBeNull();
      expect(found.row!.invoice?.invoiceNumber, 'with its invoice').toBe(FIXTURE.invoiceNumber);
      expect(looksArchived(found.row!.invoice!.status), 'its invoice status is its own, not "archived"').toBe(false);
    },
  );

  test(
    'AC4 — search finds the archived row by VO number, patient and invoice number, with no filter applied',
    { tag: ['@SuperAdmin', '@BillingArchived', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const paths: { label: string; search: Record<string, string> }[] = [
        { label: 'VO number', search: { prescriptionId: FIXTURE.number } },
        { label: 'patient', search: { 'patient.lastName': FIXTURE.patientLastName } },
        { label: 'invoice number', search: { 'invoices.invoiceNumber': FIXTURE.invoiceNumber } },
      ];

      const missed: string[] = [];
      for (const path of paths) {
        // No `treatmentStatus` — this is the default view plus a search term, which is exactly the
        // state AC4 describes.
        const { total, rows, status, error } = await billing.list('copaymentBilling', { search: path.search });
        const hit = rows.find((r) => r.number === FIXTURE.number);
        console.log(`[#3277] search by ${path.label.padEnd(14)} → ${status} total=${total} found=${!!hit} ${error ?? ''}`);
        if (!hit) missed.push(`${path.label} (${JSON.stringify(path.search)}) → ${status} ${error ?? `${total} rows`}`);
      }

      expect(missed, 'each search path must return the archived VO even though Archiviert is not selected').toEqual([]);
    },
  );

  test(
    'AC1/AC2 — both billing tabs offer "Archiviert" in the VO Status dropdown',
    { tag: ['@SuperAdmin', '@BillingArchived', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      await billing.openBilling();

      const missing: string[] = [];
      for (const tab of [TAB_COPAYMENT, TAB_PKV]) {
        await billing.openTab(tab);
        const options = await billing.voStatusOptions();
        console.log(`[#3277] ${tab} VO Status options: ${JSON.stringify(options)}`);
        if (!options.includes(ARCHIVED)) missing.push(`${tab}: ${options.join(', ')}`);
      }

      // Read this off the right tab: /billing opens on Validierung, whose dropdown is a different
      // set (Pending / Bereit / Aktiv / …) and legitimately has no Archiviert.
      expect(missing, `both billing tabs must offer "${ARCHIVED}" as a VO Status option`).toEqual([]);
    },
  );

  test(
    'the two tabs are mutually exclusive by insurance type — the ticket\'s QA steps cannot be followed as written',
    { tag: ['@SuperAdmin', '@BillingArchived', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const copayment = await billing.list('copaymentBilling', { treatmentStatus: ARCHIVED });
      const pkv = await billing.list('pkvBilling', { treatmentStatus: ARCHIVED });

      const copaymentInsurance = [...new Set(copayment.rows.map((r) => r.insuranceType))];
      const pkvInsurance = [...new Set(pkv.rows.map((r) => r.insuranceType))];
      console.log(
        `[#3277] archived copayment rows are ${JSON.stringify(copaymentInsurance)}; ` +
          `archived PKV rows are ${JSON.stringify(pkvInsurance)}`,
      );

      expect(copaymentInsurance, 'Zuzahlungsverwaltung is GKV only').toEqual(['public']);
      expect(pkvInsurance, 'PKV-Abrechnung is private only').toEqual(['private']);

      // Which is why the fixture the ticket names can only ever be checked on one of the two tabs;
      // the PKV half needs the PKV list's own archived population, as asserted above.
      const fixture = copayment.rows.concat(pkv.rows).find((r) => r.number === FIXTURE.number);
      if (fixture) expect(fixture.insuranceType, `${FIXTURE.number} is GKV, so it can never appear on PKV`).toBe(FIXTURE.insuranceType);
      const overlap = copayment.rows.filter((c) => pkv.rows.some((p) => p.number === c.number));
      expect(overlap.map((r) => r.number), 'no VO can appear on both tabs').toEqual([]);
    },
  );
});
