import { test, expect } from '@playwright/test';
import { InvoicePdfsPage } from '../../../Pages/superadmin/sa.invoice-pdfs.page';
import { LetterLayoutPage } from '../../../Pages/admin/admin.letter-layout.page';

/**
 * RC 3.11.3 (#3523) — the GKV copayment invoice's FAQ page must use the largest text size that
 * still keeps all 10 questions and answers on ONE page.
 *
 * **The fix IS deployed on staging** (verified 2026-08-27), and the numbers line up with the
 * ticket exactly: the FAQ body measured **6.75pt** on every stored render — which is the ticket's
 * "9px" (9px = 6.75pt at 96dpi) — and **9pt (12px)** on a copy regenerated today, a 33% increase.
 * The page still holds all 10 questions.
 *
 * **Runs as Super Admin**, because the regeneration endpoint does.
 *
 * **Why a regeneration is unavoidable.** `GET /invoices/{id}/download` is served from the STORED
 * PDF (#3332), so every existing invoice shows the size it was rendered with, not today's template.
 * The one mutating test uses the documented "Rechnung neu erstellen" → "Entwurf ersetzen" path
 * against a `not_sent` DRAFT only: it replaces the draft in place, keeps the invoice number and
 * creates no Storno — the same write `sa_invoice_stored_pdfs.spec.ts` AC2 already makes.
 *
 * **Trap: an old invoice can have a THIRD page.** Two of the 2026-08-13 renders are 3 pages, where
 * page 3 carries nothing but the footer. Counting "pages" alone would therefore mis-describe both
 * the before and the after; every assertion here is about the page that actually holds the
 * numbered questions, located by content rather than by index.
 */
test.describe('Copayment invoice FAQ font size (#3523)', () => {
  test.describe.configure({ mode: 'serial' });

  /** The FAQ font size the ticket is replacing: 9px == 6.75pt. */
  const OLD_SIZE_PT = 6.75;

  test(
    'Deployment probe — the FAQ page size across stored renders',
    { tag: ['@SuperAdmin', '@CopaymentFaq', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();
      const letters = new LetterLayoutPage(page);

      const drafts = await invoices.draftCopaymentInvoices(8);
      expect(drafts.length, 'staging must expose copayment invoices').toBeGreaterThan(0);

      let withFaq = 0;
      const sizes: number[] = [];
      for (const d of drafts) {
        const doc = await letters.invoicePdf(d.invoice.id, `${d.invoice.invoiceNumber} (VO ${d.prescriptionNumber})`);
        if (!doc.buffer) continue;
        const faq = LetterLayoutPage.faqPage(doc);
        const created = LetterLayoutPage.creationDate(doc);
        if (!faq) {
          console.log(`  ${doc.label} created=${created}: ${doc.pages.length}p — no FAQ page`);
          continue;
        }
        withFaq++;
        const dominant = LetterLayoutPage.dominantSize(faq);
        sizes.push(dominant);
        const extent = LetterLayoutPage.contentExtent(faq);
        console.log(
          `  ${doc.label} created=${created}: ${doc.pages.length}p, FAQ body ${dominant}pt, ` +
            `${LetterLayoutPage.faqQuestions({ ...doc, pages: [faq] }).length} questions, ` +
            `content spans ${extent.span}pt of ${faq.height.toFixed(0)}`,
        );
      }
      expect(withFaq, 'at least one invoice must carry an FAQ page').toBeGreaterThan(0);

      const enlarged = sizes.filter((s) => s > OLD_SIZE_PT + 0.5);
      console.log(
        enlarged.length
          ? `#3523 IS deployed — ${enlarged.length} of ${withFaq} FAQ pages render above ${OLD_SIZE_PT}pt.`
          : `#3523 is NOT deployed on stored renders — all ${withFaq} FAQ pages are still at ${OLD_SIZE_PT}pt ` +
            '(expected: stored PDFs keep their original size; the mutating test below regenerates one).',
      );
    },
  );

  // ── AC1 / AC2 ────────────────────────────────────────────────────────────────────────────────
  test(
    'AC1/AC2 — a freshly rendered FAQ is one page at a larger size, with all 10 questions',
    { tag: ['@SuperAdmin', '@CopaymentFaq', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();
      const letters = new LetterLayoutPage(page);

      const drafts = await invoices.draftCopaymentInvoices(8);
      const target = drafts[0];
      expect(target, 'a not_sent copayment draft is required to regenerate').toBeTruthy();

      const before = await letters.invoicePdf(target.invoice.id, `${target.invoice.invoiceNumber} before`);
      const beforeFaq = before.buffer ? LetterLayoutPage.faqPage(before) : null;
      console.log(
        `before: created=${LetterLayoutPage.creationDate(before)} pages=${before.pages.length} ` +
          `faqSize=${beforeFaq ? LetterLayoutPage.dominantSize(beforeFaq) : 'n/a'}`,
      );

      const status = await invoices.regenerateDraft(target.prescriptionId);
      console.log(`POST /prescriptions/${target.prescriptionId}/generate-invoice (VO ${target.prescriptionNumber}) -> ${status}`);
      expect([200, 201, 202, 204], 'the regeneration must be accepted').toContain(status);

      // The store is refreshed by a worker, so the new file lands a moment later.
      let after = before;
      let current = target.invoice;
      for (let attempt = 0; attempt < 12; attempt++) {
        await page.waitForTimeout(5000);
        current = (await invoices.invoiceOfPrescription(target.prescriptionId)) ?? target.invoice;
        after = await letters.invoicePdf(current.id, `${current.invoiceNumber} after`);
        if (after.buffer && LetterLayoutPage.creationDate(after) !== LetterLayoutPage.creationDate(before)) break;
      }
      expect(after.buffer, 'the regenerated invoice must be downloadable').not.toBeNull();
      console.log(`after:  created=${LetterLayoutPage.creationDate(after)} pages=${after.pages.length}`);

      const faq = LetterLayoutPage.faqPage(after);
      expect(faq, 'the regenerated invoice must carry an FAQ page').not.toBeNull();

      // AC1 — exactly one FAQ page, all 10 questions on it.
      const questions = LetterLayoutPage.faqQuestions({ ...after, pages: [faq!] });
      questions.forEach((q) => console.log(`    ${q.slice(0, 78)}`));
      expect(questions.length, `all 10 FAQ questions must be on the FAQ page, found ${questions.length}`).toBe(10);
      const faqPages = after.pages.filter((p) => LetterLayoutPage.faqQuestions({ ...after, pages: [p] }).length > 0);
      expect(faqPages.length, 'the FAQ must occupy exactly one page').toBe(1);

      // AC2 — noticeably larger than the 9px (6.75pt) it replaces.
      const size = LetterLayoutPage.dominantSize(faq!);
      const extent = LetterLayoutPage.contentExtent(faq!);
      console.log(`FAQ body size ${size}pt (was ${OLD_SIZE_PT}pt = 9px); content spans ${extent.span}pt of ${faq!.height.toFixed(0)}`);
      expect(size, `the FAQ body must be larger than the ${OLD_SIZE_PT}pt it replaces`).toBeGreaterThan(OLD_SIZE_PT + 0.5);

      // AC2's "one step larger would overflow" cannot be produced from a client — the size is not
      // parameterisable — so the headroom left is reported instead of asserted.
      console.log(
        `headroom: the FAQ now fills ${((extent.span / faq!.height) * 100).toFixed(0)}% of the page height ` +
          `(before this change it filled about ${((434 / 842) * 100).toFixed(0)}%).`,
      );
    },
  );

  // ── AC3 ──────────────────────────────────────────────────────────────────────────────────────
  test(
    'AC3 — the invoice page itself is unchanged',
    { tag: ['@SuperAdmin', '@CopaymentFaq', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const invoices = new InvoicePdfsPage(page);
      await invoices.open();
      const letters = new LetterLayoutPage(page);

      // Compare the FIRST page of an invoice rendered before the change against one rendered after.
      // Both are stored files, so each shows its own era's template.
      const drafts = await invoices.draftCopaymentInvoices(8);
      const measured: { label: string; created: string | null; sizes: string; footer: number[] }[] = [];
      for (const d of drafts) {
        const doc = await letters.invoicePdf(d.invoice.id, d.invoice.invoiceNumber);
        if (!doc.buffer || !doc.pages.length) continue;
        measured.push({
          label: doc.label,
          created: LetterLayoutPage.creationDate(doc),
          sizes: JSON.stringify(Object.keys(LetterLayoutPage.sizeHistogram(doc.pages[0])).map(Number).sort((a, b) => a - b)),
          footer: LetterLayoutPage.footerOffsetsPct(doc),
        });
      }
      measured.forEach((m) => console.log(`  ${m.label} created=${m.created} page1Sizes=${m.sizes} footer%=${JSON.stringify(m.footer)}`));
      expect(measured.length, 'need invoices to compare').toBeGreaterThan(1);

      // The invoice page's own type scale must be the same set on every render, old and new.
      const distinct = [...new Set(measured.map((m) => m.sizes))];
      console.log(`distinct page-1 type scales: ${JSON.stringify(distinct)}`);
      // Different invoices legitimately differ (a long address wraps, a Storno adds a line), so the
      // assertion is on the BODY size — the one the ticket must not have touched.
      for (const m of measured) {
        const sizes = JSON.parse(m.sizes) as number[];
        expect(sizes, `${m.label} page 1 must still render its 8.25pt body`).toContain(8.25);
      }
    },
  );
});
