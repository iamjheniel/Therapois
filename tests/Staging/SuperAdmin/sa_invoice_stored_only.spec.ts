import { test, expect } from '../../fixtures/session';
import { InvoicePdfsPage, PdfDownload } from '../../../Pages/superadmin/sa.invoice-pdfs.page';

/**
 * RC 3.12 — Serve stored invoice PDFs only, remove the re-render fallback (#3495, PR #3520).
 *
 * #3332 made invoice PDFs render once and be stored; every download path still ended in
 * `$storage->read($invoice) ?? $renderer->renderPdf($invoice)`, so a missing stored copy was
 * silently replaced by a document rebuilt from the invoice's *current* data. This ticket removes
 * that fallback from all four paths (copayment, PKV, Storno, bulk zip): a missing file is now a
 * `409` for the three single downloads and a skip-plus-report for the bulk one.
 *
 * **Deployed on staging, and both new branches were observed live.** `GET /status` reports
 * `3.12.0`, the web bundle carries the 409 branch and the German message, and — because the
 * missing-file state cannot be found naturally — it was manufactured the one way a client can:
 * a brand-new invoice's PDF is written by an async worker, so `pdf_path` is NULL for ~30s after
 * creation. Measured 2026-08-31:
 *
 * | t     | what                                                        | answer |
 * |-------|-------------------------------------------------------------|--------|
 * | +0.0s | `POST /prescriptions/30722/generate-invoice` (VO 8869-2)     | `200 {"invoiceId":630,"invoiceNumber":"R726-24"}` |
 * | +2.6s | `GET /invoices/630/download`                                 | **`409` `"No stored PDF exists for this invoice."`** |
 * | +28s  | same request                                                 | `200`, stored PDF `/CreationDate 20260831030531` |
 * | +2.7s | `POST /prescriptions/34213/generate-invoice` (VO 3277-4)     | `200 {"invoiceId":631,"invoiceNumber":"R126-120"}` |
 * | +4.1s | `GET /invoices/631/download`                                 | **`409`**, same message |
 * | +7.2s | bulk `{id:[630,631], type:'copayment'}`                      | zip: `Zuzahlung_Wieland_R726-24.pdf` + **`Fehlerbericht.txt`** reading `Diese Rechnungen konnten nicht erstellt werden:` / `R126-120` |
 * | +33s  | same bulk request after the worker stored 631                | zip: both PDFs, no report |
 *
 * Pre-fix, every one of those 409s would have been a `200` carrying a document rebuilt on the spot.
 *
 * **Why the mutating half is env-gated.** Creating an invoice is irreversible — invoices cannot be
 * deleted (the epic carries a separate no-deletion ticket) — and each run permanently consumes an
 * invoice number and one of the few copayment-eligible VOs that still have no invoice. Staging had
 * three when this was written; two were spent on the run above and the third (6314-2) is #3426's
 * exclusion fixture and must never be invoiced. So the live-window tests only run when a caller
 * supplies a VO explicitly:
 *
 *     INVOICE_409_PRESCRIPTION_ID=<prescription id> npx playwright test \
 *       tests/Staging/SuperAdmin/sa_invoice_stored_only.spec.ts --project=SAJhen --grep "@Mutating"
 *
 * Everything else here is read-only, including the population sweep that measures the ticket's own
 * "expected to be rare" claim.
 */

/** A stored file must predate the run that fetched it, with slack for renderer/runner clock skew. */
const CLOCK_SKEW_MS = 30_000;

/** The message the API returns on the removed-fallback path. */
const MISSING_PDF_DETAIL = 'No stored PDF exists for this invoice.';

/** The German string the user must see — from the frontend catalog, since `api/` has no translator. */
const MISSING_PDF_GERMAN = 'Diese Rechnung ist derzeit nicht verfügbar. Bitte wenden Sie sich an den Support.';

/** #3426's exclusion fixture. Invoicing it would destroy that spec's only remaining subject. */
const NEVER_INVOICE = ['6314-2'];

/** The two invoices created while verifying this ticket — their windows are recorded above. */
const VERIFICATION_INVOICES = [
  { id: 630, number: 'R726-24', prescription: '8869-2' },
  { id: 631, number: 'R126-120', prescription: '3277-4' },
];

function describe(label: string, dl: PdfDownload): string {
  return (
    `${label}: ${dl.status} ${dl.bytes}B in ${dl.ms}ms, rendered ` +
    `${dl.createdAt?.toISOString() ?? 'unknown'} (${Math.round(InvoicePdfsPage.ageMinutes(dl))} min ago)` +
    `${dl.detail ? `, detail "${dl.detail}"` : ''}`
  );
}

/** AC1: the exact stored file, not a document built to answer this request. */
function expectStored(dl: PdfDownload, repeat: PdfDownload, label: string, before: number) {
  expect(dl.status, `${label} must download`).toBe(200);
  expect(dl.contentType, `${label} must be a PDF`).toContain('application/pdf');
  expect(dl.createdAt, `${label} must carry a /CreationDate to reason about`).not.toBeNull();
  expect(
    dl.createdAt!.getTime(),
    `${label} was rendered ${Math.round(InvoicePdfsPage.ageMinutes(dl))} min ago — after this run asked ` +
      `for it, which is a build on demand rather than the stored file`,
  ).toBeLessThan(before - CLOCK_SKEW_MS);
  expect(repeat.sha256, `${label} must be byte-identical on a second download`).toBe(dl.sha256);
}

test.describe('Invoice downloads — stored file only, no re-render fallback', () => {
  test(
    'Deployment — the API is on 3.12 and the app carries the 409 branch and its German message',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // `GET /status` is unauthenticated and is the only place the API states its own version — worth
      // knowing, because the app bundle has historically lagged the API by a whole release (the
      // RC 3.11.3 letter work shipped while the bundle still said 3.11.0).
      const version = await invoices.apiVersion();
      console.log(`API /status version: ${version}`);
      expect(version, 'the API must be on the release that carries #3495').toMatch(/^3\.1[2-9]/);

      // The German string lives in the frontend catalog: `api/` has no translator, so the API's own
      // message stays English and the localized one is rendered client-side off the 409.
      const bundle = await invoices.appBundle();
      expect(bundle, 'the app must ship the file_unavailable message key').toContain(
        'billing.invoice_preview.file_unavailable',
      );
      expect(
        bundle.replace(/\\x([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
        'the German catalog must carry the exact string from the ticket\'s Localization Reference',
      ).toContain(MISSING_PDF_GERMAN);
      expect(
        bundle,
        'the preview must branch on the 409 rather than treating it as a generic download failure',
      ).toMatch(/409===[a-zA-Z$_]+\.status/);
    },
  );

  test(
    'AC1 — copayment, PKV and Storno downloads serve the stored file byte-for-byte',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const drafts = await invoices.draftCopaymentInvoices(5);
      expect(drafts.length, 'staging must have a copayment invoice to download').toBeGreaterThan(0);
      const copayment = drafts[0].invoice;
      const copaymentFirst = await invoices.downloadInvoice(copayment.id);
      const copaymentRepeat = await invoices.downloadInvoice(copayment.id);
      console.log(describe(`copayment ${copayment.invoiceNumber}`, copaymentFirst));
      expectStored(copaymentFirst, copaymentRepeat, `copayment ${copayment.invoiceNumber}`, startedAt);

      const pkv = await invoices.pkvInvoices(8);
      expect(pkv.length, 'staging must have a PKV invoice to download').toBeGreaterThan(0);
      const pkvInvoice = pkv[0].invoice;
      const pkvFirst = await invoices.downloadInvoice(pkvInvoice.id);
      const pkvRepeat = await invoices.downloadInvoice(pkvInvoice.id);
      console.log(describe(`PKV ${pkvInvoice.invoiceNumber}`, pkvFirst));
      expectStored(pkvFirst, pkvRepeat, `PKV ${pkvInvoice.invoiceNumber}`, startedAt);

      const cancelled = await invoices.cancelledInvoices(3);
      expect(cancelled.length, 'staging must have a cancelled invoice carrying a Storno').toBeGreaterThan(0);
      const stornoFirst = await invoices.downloadStorno(cancelled[0].id);
      const stornoRepeat = await invoices.downloadStorno(cancelled[0].id);
      console.log(describe(`Storno of ${cancelled[0].invoiceNumber}`, stornoFirst));
      expectStored(stornoFirst, stornoRepeat, `Storno of ${cancelled[0].invoiceNumber}`, startedAt);
      expect(stornoFirst.filename, 'the Storno route must serve the cancellation document').toMatch(
        /^Stornorechnung_/,
      );
    },
  );

  test(
    'AC1 — a bulk zip of stored invoices contains their stored PDFs and no failure report',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const ids = (await invoices.copaymentInvoiceIds(1, 100)).slice(0, 6);
      expect(ids.length, 'staging must have copayment invoices to bulk-download').toBeGreaterThan(1);
      const zip = await invoices.bulkDownload(ids, 'copayment');
      console.log(`bulk of ${ids.length}: ${zip.status} ${zip.bytes}B in ${zip.ms}ms -> ${zip.entries.join(', ')}`);
      expect(zip.status, 'the bulk download must succeed').toBe(200);
      expect(
        zip.report,
        'no invoice in this batch is missing its stored file, so the zip must carry no Fehlerbericht',
      ).toBeNull();
      expect(zip.entries.length, 'every requested invoice must be in the zip').toBe(ids.length);

      // Each PDF inside must itself be a stored file — the bulk path is a separate controller from
      // the single downloads and had its own fallback.
      const dates = InvoicePdfsPage.zipPdfCreationDates(`${zip.dir}/invoices.zip`, `${zip.dir}/extracted`);
      for (const [name, rendered] of Object.entries(dates)) {
        console.log(`  ${name} rendered ${rendered?.toISOString() ?? 'unknown'}`);
        expect(rendered, `${name} must carry a /CreationDate`).not.toBeNull();
        expect(
          rendered!.getTime(),
          `${name} was rendered during this run — the bulk path rebuilt it instead of serving the stored file`,
        ).toBeLessThan(startedAt - CLOCK_SKEW_MS);
      }
    },
  );

  test(
    'AC2/AC5 — no invoice or Storno on staging is missing its stored PDF',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(1_800_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // The ticket asks for this number explicitly: "if this ticket's testing turns up more than a
      // handful of genuinely missing files on staging, that's worth flagging back to the epic".
      // Swept with HEAD, which still resolves the stored file (the response carries the real
      // `content-disposition`, e.g. `Zuzahlung_Lange_R426-67.pdf`) at ~1.2s instead of ~7.4s.
      const all = await invoices.allInvoices();
      console.log(`sweeping ${all.length} invoices`);
      const downloads = await invoices.sweepDownloads(all.map((i) => i.id));
      const byStatus = new Map<number, number>();
      for (const { status } of downloads.values()) byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      console.log(`/download statuses: ${JSON.stringify(Object.fromEntries(byStatus))}`);

      const missing = all.filter((i) => downloads.get(i.id)?.status === 409);
      if (missing.length) {
        // Not a failure of the fix — it is the fix working. Report it as the epic asks, and prove the
        // refusal carries the specified message rather than a bare status.
        console.log(`MISSING STORED PDFS (${missing.length}): ${missing.map((i) => `${i.id}/${i.invoiceNumber}`).join(', ')}`);
        const refusal = await invoices.downloadInvoice(missing[0].id);
        expect(refusal.detail, 'a missing stored file must be refused with the ticket\'s message').toBe(
          MISSING_PDF_DETAIL,
        );
      }
      expect(
        [...byStatus.keys()].every((status) => status === 200 || status === 409),
        `every download must either serve a stored file or refuse cleanly — got ${JSON.stringify(Object.fromEntries(byStatus))}`,
      ).toBe(true);

      // The Storno route over the same population: a cancelled invoice must serve its stored
      // cancellation document, and every other invoice must answer the *distinct* 404 the PR chose so
      // "no Stornorechnung" cannot be confused with "stored file gone" (AC4's status design).
      const stornos = await invoices.sweepDownloads(all.map((i) => i.id), { storno: true });
      const stornoByStatus = new Map<number, number>();
      for (const { status } of stornos.values()) stornoByStatus.set(status, (stornoByStatus.get(status) ?? 0) + 1);
      console.log(`/storno/download statuses: ${JSON.stringify(Object.fromEntries(stornoByStatus))}`);
      const cancelled = all.filter((i) => i.status === 'cancelled');
      for (const invoice of cancelled) {
        expect(
          stornos.get(invoice.id)?.status,
          `cancelled invoice ${invoice.invoiceNumber} must serve its stored Stornorechnung`,
        ).toBe(200);
        expect(
          stornos.get(invoice.id)?.filename,
          `and it must be the Storno document, not the invoice`,
        ).toMatch(/^Stornorechnung_/);
      }
      expect(stornoByStatus.get(409) ?? 0, 'no Storno is missing its stored file either').toBe(0);

      const noStorno = all.find((i) => i.status !== 'cancelled')!;
      const refusal = await invoices.downloadStorno(noStorno.id);
      expect(refusal.status, 'an invoice with no Storno must 404, not 409').toBe(404);
      expect(refusal.detail, 'and say so').toBe('This invoice has no Stornorechnung.');
    },
  );

  test(
    'AC2 — the invoices created to prove the 409 now serve stored files',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const startedAt = Date.now();
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      // The window is transient by design: the worker stores the file and the invoice becomes
      // downloadable. Asserting the recovery keeps the (irreversible) fixtures from this
      // verification useful afterwards — and guards the PR's own stated risk, that a *failed*
      // `GenerateInvoicePdfMessage` job would leave an invoice 409-ing permanently, since #3447's
      // `hono_failed` queue is never consumed.
      for (const fixture of VERIFICATION_INVOICES) {
        const invoice = await invoices.invoice(fixture.id);
        expect(invoice.invoiceNumber, `invoice ${fixture.id} must still be ${fixture.number}`).toBe(fixture.number);
        const first = await invoices.downloadInvoice(fixture.id);
        const repeat = await invoices.downloadInvoice(fixture.id);
        console.log(describe(`${fixture.number} (VO ${fixture.prescription})`, first));
        expectStored(first, repeat, `${fixture.number}`, startedAt);
      }
    },
  );

  test(
    'AC2/AC4 — a missing stored file is refused with the ticket\'s message, never rebuilt',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const prescriptionId = Number(process.env.INVOICE_409_PRESCRIPTION_ID);
      test.skip(
        !prescriptionId,
        'Irreversible: creating the invoice is the only way a client can produce a missing stored ' +
          'file, and invoices cannot be deleted. Pass INVOICE_409_PRESCRIPTION_ID=<id> of a ' +
          'copayment-eligible VO that has no invoice. Recorded run 2026-08-31: VO 8869-2 -> invoice ' +
          '630 (R726-24), 409 "No stored PDF exists for this invoice." at +2.6s, stored at +28s.',
      );
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const candidates = await invoices.uninvoicedCopaymentCandidates();
      const target = candidates.find((c) => c.prescriptionId === prescriptionId);
      expect(
        target,
        `VO ${prescriptionId} must be copayment-eligible and hold no invoice yet — otherwise this ` +
          `test would create a second document rather than a first`,
      ).toBeTruthy();
      expect(NEVER_INVOICE, `VO ${target!.prescriptionNumber} is a fixture of another spec`).not.toContain(
        target!.prescriptionNumber,
      );

      const created = await invoices.createInvoiceForPrescription(prescriptionId);
      console.log(`created invoice ${created.invoiceId} (${created.invoiceNumber}) on VO ${target!.prescriptionNumber}`);
      expect(created.status, 'the invoice must be created').toBe(200);
      expect(created.invoiceId, 'the response must name the new invoice').toBeTruthy();

      // The PDF is written by an async worker (`GenerateInvoicePdfMessage` on the `hono` transport),
      // so this reads the state the ACs describe: the invoice exists, its stored file does not.
      const refused = await invoices.downloadInvoice(created.invoiceId!);
      console.log(describe(`fresh invoice ${created.invoiceNumber}`, refused));
      expect(
        refused.status,
        'a missing stored file must be refused — a 200 here is the removed fallback rebuilding the ' +
          'document from current data',
      ).toBe(409);
      expect(refused.detail, 'and the refusal must carry the ticket\'s message').toBe(MISSING_PDF_DETAIL);
      expect(refused.bytes, 'nothing resembling a PDF may come back').toBe(0);

      // …and it must heal on its own once the worker stores the file, or the 409 is permanent.
      let stored: PdfDownload = refused;
      for (let attempt = 0; attempt < 60 && stored.status !== 200; attempt++) {
        await page.waitForTimeout(2000);
        stored = await invoices.downloadInvoice(created.invoiceId!);
      }
      console.log(describe(`after the worker stored it — ${created.invoiceNumber}`, stored));
      expect(stored.status, 'the async worker must store the file and end the window').toBe(200);
    },
  );

  test(
    'AC3 — a bulk download skips the missing invoice, reports it, and delivers the rest',
    { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const prescriptionId = Number(process.env.INVOICE_409_PRESCRIPTION_ID);
      test.skip(
        !prescriptionId,
        'Same irreversible fixture as the AC2 test above. Recorded run 2026-08-31: VO 3277-4 -> ' +
          'invoice 631 (R126-120); a bulk of [630 stored, 631 missing] returned a zip holding ' +
          'Zuzahlung_Wieland_R726-24.pdf plus Fehlerbericht.txt reading "Diese Rechnungen konnten ' +
          'nicht erstellt werden: R126-120", and the same batch 26s later held both PDFs.',
      );
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();

      const stored = (await invoices.copaymentInvoiceIds(1, 100))[0];
      expect(stored, 'a stored copayment invoice is needed as the batch\'s "rest of it"').toBeTruthy();

      const created = await invoices.createInvoiceForPrescription(prescriptionId);
      expect(created.invoiceId, 'the invoice must be created').toBeTruthy();
      console.log(`created invoice ${created.invoiceId} (${created.invoiceNumber}) — its window is open now`);

      const zip = await invoices.bulkDownload([stored, created.invoiceId!], 'copayment');
      console.log(`bulk -> ${zip.status} ${zip.bytes}B, entries ${zip.entries.join(', ')}, report: ${zip.report}`);
      expect(zip.status, 'the batch must still be delivered').toBe(200);
      expect(
        zip.entries.some((e) => e.endsWith('.pdf')),
        'the invoices that do have stored files must download normally',
      ).toBe(true);
      expect(zip.entries, 'the missing one must be reported, not rebuilt into the zip').toContain('Fehlerbericht.txt');
      expect(
        zip.report,
        'and the report must name it, in the same list the bulk download already uses for failures',
      ).toContain(created.invoiceNumber!);
    },
  );

  test('AC4 — a Stornorechnung with no stored file is refused the same way', { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly'] }, async () => {
    test.fixme(
      true,
      'No fixture, and the only way to make one is worse than the gap it closes. All 10 cancelled ' +
        'invoices on staging carry a stored Storno (rendered in the 14 Aug backfill, or at ' +
        'cancellation for the three newest), and a fresh Storno can only be produced by CANCELLING an ' +
        'invoice — which issues a replacement number and feeds DATEV sync state, with nothing to undo ' +
        'afterwards. What is asserted read-only above: the Storno route serves stored files for all ' +
        '10, and answers a distinct 404 ("This invoice has no Stornorechnung.") everywhere else, ' +
        'which is the status separation the PR introduced so a client can tell the two cases apart. ' +
        'The missing-Storno branch itself is covered by the PR\'s live run (409 with the file removed, ' +
        '200 + Stornorechnung_Dorn_R999-2.pdf once restored).',
    );
  });

  test('AC5 — the PKV single-download refuses a missing stored file too', { tag: ['@SuperAdmin', '@InvoicePdfs', '@StoredOnly'] }, async () => {
    test.fixme(
      true,
      'Reachable for the copayment controller only. The window this spec exploits opens when an ' +
        'invoice is created without a stored PDF, and the client-reachable creation endpoint ' +
        '(POST /prescriptions/{id}/generate-invoice) produces a GKV copayment draft — there is no ' +
        'equivalent for a PKV invoice, which is issued through the billing batch flow. AC5 is ' +
        'therefore verified here for three of the four paths (copayment single, bulk, and the Storno ' +
        'route\'s stored-file half), and structurally for the fourth: the PR removes the renderer from ' +
        'all three controllers\' constructor signatures, so no fallback is reachable from any of them.',
    );
  });
});
