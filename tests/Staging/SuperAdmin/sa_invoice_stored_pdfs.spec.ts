import { test, expect } from '@playwright/test';
import { InvoicePdfsPage, PdfDownload } from '../../../Pages/superadmin/sa.invoice-pdfs.page';

/**
 * RC 3.11 — Invoices download instantly from stored PDFs (#3332, PR #3359).
 *
 * Copayment, PKV and Storno PDFs are now rendered once — when the invoice's content is created or
 * changed — and the single-invoice download endpoints serve that stored file. A one-time backfill
 * covered the invoices that already existed (518 of staging's 519 on 14 Aug 2026).
 *
 * **These tests do not use a stopwatch.** The PM's pass read AC1 off download timings (~1.2s vs a
 * 14–18s baseline), but timing does not separate the two cases: measured from here the same *stored*
 * files took 1.0s (142KB) to 14s (774KB) depending on size and network, straddling the old baseline.
 * What does separate them is inside the file — the PDF's `/CreationDate`, stamped by Ghostscript
 * when the file was rendered. A rebuilt-on-demand PDF carries *now*; a stored one carries the moment
 * it was stored. Byte-identity across two downloads is the second, independent check.
 *
 * Mutations: exactly one test writes — the AC2 draft regeneration, which is the ticket's own QA step
 * ("manually regenerates an invoice draft"). It runs against a `not_sent` draft only, where the
 * product's own dialog states the draft is replaced in place, the invoice number is preserved and no
 * Storno is created. Everything else is read-only.
 */

/**
 * A stored file must predate the test that fetched it, with this much slack for clock skew between
 * the renderer and the runner.
 */
const CLOCK_SKEW_MS = 30_000;

/** How many invoices the AC8 coverage sample spreads across the collection. */
const COVERAGE_SAMPLES = 10;

function describeDownload(label: string, dl: PdfDownload): string {
  return (
    `${label}: ${dl.status} ${dl.bytes}B in ${dl.ms}ms, rendered ` +
    `${dl.createdAt?.toISOString() ?? 'unknown'} (${Math.round(InvoicePdfsPage.ageMinutes(dl))} min ago), ` +
    `file "${dl.filename}"`
  );
}

/**
 * The two properties that prove a download came off disk rather than out of the renderer.
 *
 * `renderedBefore` is normally the moment the test started: the file has to have existed already.
 * An age *threshold* would be wrong — a file legitimately refreshed minutes ago (AC2) is still
 * stored — so what is asserted is "rendered before this run asked for it", plus byte-identity.
 */
function expectServedFromStorage(dl: PdfDownload, repeat: PdfDownload, label: string, renderedBefore: number) {
  expect(dl.status, `${label} must download`).toBe(200);
  expect(dl.contentType, `${label} must be a PDF`).toContain('application/pdf');
  expect(dl.createdAt, `${label} must carry a /CreationDate to reason about`).not.toBeNull();
  expect(
    dl.createdAt!.getTime(),
    `${label} was rendered ${Math.round(InvoicePdfsPage.ageMinutes(dl))} min ago, i.e. after this test ` +
      `asked for it — that is a build on demand, not a stored file`,
  ).toBeLessThan(renderedBefore - CLOCK_SKEW_MS);
  expect(
    repeat.sha256,
    `${label} must be byte-identical on a second download — two renders would differ in their timestamp`,
  ).toBe(dl.sha256);
}

test.describe('Invoice PDFs — served from storage', () => {
  test(
    'AC1 — a single copayment/PKV download is served from the stored file',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredPdf'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const drafts = await invoices.draftCopaymentInvoices(5);
      expect(drafts.length, 'staging must have a copayment invoice to download').toBeGreaterThan(0);
      const target = drafts[0].invoice;

      const first = await invoices.downloadInvoice(target.id);
      const second = await invoices.downloadInvoice(target.id);
      console.log(describeDownload(`invoice ${target.id} (${target.invoiceNumber})`, first));
      console.log(`repeat: ${second.bytes}B in ${second.ms}ms`);

      expectServedFromStorage(first, second, `invoice ${target.invoiceNumber}`, startedAt);
      expect(first.filename, 'the copayment file keeps its Zuzahlung name').toMatch(/\.pdf$/i);

      // The ticket covers PKV invoices as well as copayment ones, and they are a separate service
      // and a separate download controller upstream — worth its own fixture rather than assuming.
      const pkv = await invoices.pkvInvoices(8);
      test.skip(pkv.length === 0, 'no PKV invoice on staging to download');
      const pkvTarget = pkv[0].invoice;
      const pkvFirst = await invoices.downloadInvoice(pkvTarget.id);
      const pkvSecond = await invoices.downloadInvoice(pkvTarget.id);
      console.log(describeDownload(`PKV invoice ${pkvTarget.id} (${pkvTarget.invoiceNumber})`, pkvFirst));
      expectServedFromStorage(pkvFirst, pkvSecond, `PKV invoice ${pkvTarget.invoiceNumber}`, startedAt);
    },
  );

  test(
    'AC5 — Storno downloads are served from stored files too',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredPdf'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const cancelled = await invoices.cancelledInvoices(3);
      expect(cancelled.length, 'staging must have a cancelled invoice with a Storno').toBeGreaterThan(0);

      for (const invoice of cancelled) {
        const first = await invoices.downloadStorno(invoice.id);
        const second = await invoices.downloadStorno(invoice.id);
        console.log(describeDownload(`storno of ${invoice.invoiceNumber}`, first));
        expectServedFromStorage(first, second, `Storno of ${invoice.invoiceNumber}`, startedAt);
        expect(
          first.filename,
          'the cancellation document must be served as a Stornorechnung, not the invoice itself',
        ).toMatch(/^Stornorechnung_/);
      }
    },
  );

  test(
    'AC8 — every existing invoice has a stored PDF, the backfill included the oldest',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredPdf'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // The catch-up run itself is a console command, but its outcome is observable: every invoice
      // that already existed must now serve a stored file. Sampled across the whole collection
      // rather than the newest page, because the backfill's job was the *old* ones.
      const { total, rows } = await invoices.invoices(1, 30);
      expect(total, 'the invoice collection must be populated').toBeGreaterThan(100);
      const pageSize = 30;
      const lastPage = Math.ceil(total / pageSize);
      const sampled: { id: number; number: string }[] = [];
      for (let i = 0; i < COVERAGE_SAMPLES; i++) {
        const pageNumber = 1 + Math.floor((i * (lastPage - 1)) / Math.max(1, COVERAGE_SAMPLES - 1));
        const batch = pageNumber === 1 ? { rows } : await invoices.invoices(pageNumber, pageSize);
        const row = batch.rows[i % Math.max(1, batch.rows.length)];
        if (row && !sampled.some((s) => s.id === row.id)) sampled.push({ id: row.id, number: row.invoiceNumber });
      }
      console.log(`sampling ${sampled.length} of ${total} invoices: ${JSON.stringify(sampled.map((s) => s.id))}`);

      const rendered: Date[] = [];
      for (const { id, number } of sampled) {
        const download = await invoices.downloadInvoice(id);
        console.log(describeDownload(`invoice ${id} (${number})`, download));
        expect(download.status, `invoice ${number} must download`).toBe(200);
        expect(
          download.createdAt!.getTime(),
          `invoice ${number} has no stored PDF — it was rendered on the spot, so the catch-up run ` +
            `missed it (AC6's fallback still works, but AC8 says nothing should need it)`,
        ).toBeLessThan(startedAt - CLOCK_SKEW_MS);
        if (download.createdAt) rendered.push(download.createdAt);
      }
      const sorted = rendered.map((d) => d.toISOString()).sort();
      console.log(`stored-PDF render window across the sample: ${sorted[0]} … ${sorted[sorted.length - 1]}`);
    },
  );

  test(
    'AC2 — regenerating a draft refreshes the stored file',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredPdf'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // The one mutating test in this file. A `not_sent` draft is replaced in place — the product's
      // own confirmation dialog states the invoice number is kept and no Storno is created.
      const drafts = await invoices.draftCopaymentInvoices(5);
      expect(drafts.length, 'a draft copayment invoice is needed to regenerate').toBeGreaterThan(0);
      const { prescriptionId, prescriptionNumber, invoice } = drafts[0];
      expect(invoice.status, 'only a not_sent draft may be regenerated by this test').toBe('not_sent');

      const before = await invoices.downloadInvoice(invoice.id);
      console.log(describeDownload(`before regeneration — invoice ${invoice.invoiceNumber}`, before));
      expect(before.status, 'the draft must have a stored PDF before the regeneration').toBe(200);

      const status = await invoices.regenerateDraft(prescriptionId);
      console.log(`POST /prescriptions/${prescriptionId}/generate-invoice (VO ${prescriptionNumber}) -> ${status}`);
      expect([200, 201, 202, 204], 'the regeneration must be accepted').toContain(status);

      // The store is refreshed by a messenger worker, so the new file lands a moment later.
      let after = before;
      let current = invoice;
      for (let attempt = 0; attempt < 12; attempt++) {
        await page.waitForTimeout(5000);
        current = (await invoices.invoiceOfPrescription(prescriptionId)) ?? invoice;
        after = await invoices.downloadInvoice(current.id);
        if (after.sha256 !== before.sha256) break;
      }
      console.log(describeDownload(`after regeneration — invoice ${current.invoiceNumber} (id ${current.id})`, after));

      expect(
        after.sha256,
        `the stored file must be refreshed by the regeneration — it is still byte-identical to the ` +
          `one stored before it`,
      ).not.toBe(before.sha256);
      expect(
        after.createdAt!.getTime(),
        'the refreshed file must have been rendered after the one it replaced',
      ).toBeGreaterThan(before.createdAt!.getTime());
      expect(
        InvoicePdfsPage.ageMinutes(after),
        'and the refreshed file must itself be stored, not rebuilt per download',
      ).toBeLessThan(60);

      const repeat = await invoices.downloadInvoice(current.id);
      expect(
        repeat.sha256,
        'after the refresh the download must still be byte-identical on repeat — served from storage',
      ).toBe(after.sha256);
    },
  );

  test('AC3 — regenerating an issued invoice refreshes its stored file', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'Not exercisable read-only, and not safely on staging either: regenerating an *issued* invoice ' +
        'cancels it, creates a Storno document and issues a replacement invoice number, all of which ' +
        'feed DATEV sync state. Unlike the draft path (AC2, covered above) there is no in-place ' +
        'replacement and nothing to undo afterwards. Covered by the PR\'s automated tests and the ' +
        "developer's live run on staging (comment 2026-08-14).",
    );
  });

  test('AC4 — an automatic draft refresh updates the stored file', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'Needs a VO content change that re-triggers draft invoice generation (the ' +
        'CopaymentInvoiceListener postUpdate → refreshDraftOnRevalidation path) — i.e. editing ' +
        'treatment or validation data on a billed VO, which rewrites real staging billing records. ' +
        'The invoice API exposes no read-only trigger for it. AC2 above proves the same storage ' +
        'refresh on the manual path.',
    );
  });

  test('AC6 — a missing stored file falls back to building on the spot', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'Requires deleting a stored PDF from S3 to create the missing-file condition; there is no API ' +
        'or UI surface that removes one. Post-backfill no invoice on staging is in that state — the ' +
        'AC8 sample above confirms every invoice sampled serves a stored file, which is the same ' +
        'measurement from the other side.',
    );
  });

  test('AC7 — the catch-up run reports its count in preview mode', { tag: ['@SuperAdmin', '@InvoicePdfs'] }, async () => {
    test.fixme(
      true,
      'The catch-up is a console command (`app:invoice:backfill-pdfs`, preview then --force) with no ' +
        'HTTP surface. Its staging run is evidenced by the preview/apply CSVs in the PM notes ' +
        '(518 rows WOULD_GENERATE, then 518 GENERATED, 0 errors) and by the AC8 coverage sample here.',
    );
  });
});
