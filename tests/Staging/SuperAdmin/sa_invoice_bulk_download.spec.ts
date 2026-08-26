import { test, expect } from '@playwright/test';
import { join } from 'path';
import { InvoicePdfsPage } from '../../../Pages/superadmin/sa.invoice-pdfs.page';

/**
 * RC 3.11 — Bulk invoice download uses stored PDFs, cap removed (#3333, PR #3376).
 *
 * The bulk zip on Zuzahlungsverwaltung and PKV-Abrechnung used to render every invoice from scratch,
 * which is why it was capped at 50 invoices. It now assembles from the stored PDFs #3332 introduced,
 * and the user-facing cap is gone — only a generous abuse guard remains.
 *
 * The request behind "Rechnungen herunterladen" is
 * `POST /invoices/bulk/download?disposition=inline` with `{"id": [...], "type": "copayment"|"pkv"}`.
 *
 * **Timing is not evidence here** (same reasoning as `sa_invoice_stored_pdfs.spec.ts`). A 6.5MB zip
 * took 14s of wall clock from this runner but its response headers arrived in 697ms — the zip is
 * streamed, so wall clock measures the pipe, not the assembly. What proves AC3 is opening the zip:
 * every PDF inside carries the `/CreationDate` it was stored with, days before the request.
 *
 * Read-only: bulk download is a GET-shaped action behind a POST body. Nothing here writes.
 */

/** More than the old 50-invoice cap — the number AC1 and AC2 are actually about. */
const OVER_THE_OLD_CAP = 61;

/** The abuse guard the ticket says replaces the cap, measured against a bogus-id request. */
const ABUSE_GUARD_LIMIT = 2000;

test.describe('Bulk invoice download — stored PDFs, no cap', () => {
  test(
    'AC1 — more than 50 copayment invoices download as one zip',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@BulkDownload'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const ids = (await invoices.copaymentInvoiceIds(1, 100)).slice(0, OVER_THE_OLD_CAP);
      expect(ids.length, `staging must offer more than the old cap of 50 invoices`).toBe(OVER_THE_OLD_CAP);

      const zip = await invoices.bulkDownload(ids, 'copayment');
      console.log(
        `${ids.length} copayment invoices: ${zip.status} ${(zip.bytes / 1e6).toFixed(1)}MB in ${zip.ms}ms, ` +
          `${zip.entries.length} entries`,
      );
      expect(zip.status, `a ${ids.length}-invoice selection must be accepted — the 50 cap is removed`).toBe(200);
      expect(zip.contentType, 'the response must be a zip').toContain('application/zip');
      expect(
        zip.entries.length,
        `every selected invoice must be in the zip — asked for ${ids.length}, got ${zip.entries.length}`,
      ).toBe(ids.length);
      expect(zip.entries.every((e) => e.toLowerCase().endsWith('.pdf')), 'the zip holds one PDF per invoice').toBe(true);
    },
  );

  test(
    'AC1 — the removed cap is replaced by an abuse guard far above the invoice population',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@BulkDownload'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // Bogus ids: the batch-size check runs before any lookup, so the bound can be probed without
      // asking the server to build anything.
      const bogus = (count: number) => Array.from({ length: count }, (_, i) => 900_000 + i);

      const belowGuard = await invoices.bulkDownload(bogus(600), 'copayment');
      console.log(`600 ids: ${belowGuard.status} (${belowGuard.bytes}B) ${belowGuard.error ?? ''}`);
      expect(
        belowGuard.status,
        'a 600-invoice request — 12× the old cap and above anything an admin can select today — must ' +
          'be accepted',
      ).toBe(200);

      const aboveGuard = await invoices.bulkDownload(bogus(ABUSE_GUARD_LIMIT + 1), 'copayment');
      console.log(`${ABUSE_GUARD_LIMIT + 1} ids: ${aboveGuard.status} ${aboveGuard.error}`);
      expect(aboveGuard.status, 'the abuse guard must still reject an absurd request').toBe(400);
      expect(
        aboveGuard.error,
        'and it must say so as a batch-size limit, not as the old user-facing 50-invoice cap',
      ).toContain(`${ABUSE_GUARD_LIMIT}`);

      // The guard has to sit above the whole invoice population for the ticket's claim to hold.
      const { total } = await invoices.invoices(1, 1);
      console.log(`invoices on staging: ${total}; abuse guard: ${ABUSE_GUARD_LIMIT}`);
      expect(
        total,
        `the guard (${ABUSE_GUARD_LIMIT}) must exceed every invoice in the system (${total}) — otherwise ` +
          `it is still a user-facing cap`,
      ).toBeLessThan(ABUSE_GUARD_LIMIT);
    },
  );

  test(
    'AC2 — the PKV tab downloads in bulk on the same terms',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@BulkDownload'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const pkv = await invoices.pkvInvoices(100);
      const ids = pkv.map((row) => row.invoice.id);
      console.log(`PKV invoices on staging: ${ids.length}`);
      expect(ids.length, 'the PKV tab must have invoices to download').toBeGreaterThan(0);

      const zip = await invoices.bulkDownload(ids, 'pkv');
      console.log(`PKV bulk: ${zip.status} ${(zip.bytes / 1e6).toFixed(1)}MB in ${zip.ms}ms, ${zip.entries.length} entries`);
      expect(zip.status, 'the PKV bulk download must succeed').toBe(200);
      expect(zip.entries.length, 'every selected PKV invoice must be in the zip').toBe(ids.length);

      // PKV has only ~16 invoices on staging, so ">50 selected" cannot be built from real ones. The
      // cap lived in the request handler, so what is asserted is that a >50 PKV request is accepted
      // rather than refused — the ids beyond the real ones simply contribute nothing.
      const padded = [...ids, ...Array.from({ length: 60 }, (_, i) => 900_000 + i)];
      const overCap = await invoices.bulkDownload(padded, 'pkv');
      console.log(`PKV with ${padded.length} ids: ${overCap.status}, ${overCap.entries.length} entries`);
      expect(
        overCap.status,
        `a ${padded.length}-id PKV request must not be refused for its size — the cap is gone on this ` +
          `tab too`,
      ).toBe(200);
      expect(overCap.entries.length, 'and the real PKV invoices still come back in it').toBe(ids.length);
    },
  );

  test(
    'AC3 — the zip is assembled from the stored PDFs, not rebuilt',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@BulkDownload'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const ids = (await invoices.copaymentInvoiceIds(1, 10)).slice(0, 5);
      const zip = await invoices.bulkDownload(ids, 'copayment');
      expect(zip.status, 'the zip must download').toBe(200);
      expect(zip.entries.length, 'one PDF per invoice').toBe(ids.length);

      const dates = InvoicePdfsPage.zipPdfCreationDates(join(zip.dir!, 'invoices.zip'), join(zip.dir!, 'extracted'));
      for (const [name, created] of Object.entries(dates)) {
        console.log(`  ${name}: rendered ${created?.toISOString() ?? 'unknown'}`);
        expect(created, `${name} must carry a /CreationDate`).not.toBeNull();
        expect(
          created!.getTime(),
          `${name} was rendered after this test asked for the zip — that file was built on the spot, ` +
            `not taken from storage`,
        ).toBeLessThan(startedAt - 30_000);
      }

      // Supporting evidence, and the reason the wall clock above is not the measure: the server
      // starts answering long before the last byte lands.
      const timing = await invoices.bulkDownloadTiming(ids, 'copayment');
      console.log(`timing split: headers after ${timing.headersMs}ms, ${(timing.size / 1e6).toFixed(1)}MB complete after ${timing.totalMs}ms`);
      expect(timing.status, 'the browser-side request must succeed too').toBe(200);
      expect(
        timing.headersMs,
        `the server must start answering promptly — ${timing.headersMs}ms to first byte suggests the ` +
          `zip is being rendered rather than assembled`,
      ).toBeLessThan(15_000);
    },
  );

  test(
    'AC5 — cancelled (Storno) invoices stay out of the zip',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@BulkDownload'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const regular = (await invoices.copaymentInvoiceIds(1, 10)).slice(0, 2);
      const cancelled = (await invoices.cancelledInvoices(2)).map((i) => i.id);
      expect(cancelled.length, 'staging must have cancelled invoices for this assertion').toBeGreaterThan(0);

      const zip = await invoices.bulkDownload([...regular, ...cancelled], 'copayment');
      console.log(`selected ${regular.length} regular + ${cancelled.length} cancelled → ${JSON.stringify(zip.entries)}`);
      expect(zip.status, 'the mixed selection must still download').toBe(200);
      expect(
        zip.entries.length,
        `only the ${regular.length} regular invoices belong in the zip; the cancelled ones are excluded`,
      ).toBe(regular.length);
      expect(
        zip.entries.some((name) => name.startsWith('Stornorechnung_')),
        'no Stornorechnung may be included in a bulk download',
      ).toBe(false);
    },
  );

  test('AC4 — an invoice without a stored file is rendered on the spot for the zip', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'Needs an invoice with no stored PDF, which requires deleting one from S3 — no API or UI ' +
        'surface does that, and #3332\'s backfill left none in that state on staging (its AC8 sample ' +
        'confirms). Same limitation as #3332 AC6.',
    );
  });

  test('AC6 — the skipped-invoice error report still appears', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'No fixture on staging can produce a per-invoice failure. Scanned 500 copayment rows: every one ' +
        'has an empty `invoiceErrors` and an entity with no `missingBillingFields`, and the single ' +
        '"Fehler (1)" row (VO 8869-2) has no invoice at all, so it cannot be part of a bulk selection. ' +
        'The two skip cases that CAN be produced are dropped silently — a bulk request mixing valid ' +
        'ids with a nonexistent one (999999) returns a zip holding only the valid PDFs, and the ' +
        'Storno-exclusion case likewise (AC5 above) — with no report file of any name in either zip. ' +
        'Both are arguably correct (an unknown id is not an invoice; Storno exclusion is documented as ' +
        'silent), but it means the report path has no live evidence on this environment. The PM pass ' +
        'reached the same point and verified AC6 by code inspection only.',
    );
  });
});
