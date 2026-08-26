import { test, expect } from '@playwright/test';
import { CopaymentExclusionsPage, VoBilling } from '../../../Pages/superadmin/sa.copayment-exclusions.page';

/**
 * RC 3.11 #3276 — "Copayment Invoices for TheOrg-Imported Blanko VOs".
 *
 * Imported VOs were excluded from copayment invoicing wholesale, on the grounds that TheOrg had
 * already billed the copayment. That is untrue for **Blanko** VOs, so #3276 carves them back in:
 * they become eligible going forward, they become visible on the Zuzahlungsverwaltung list, and a
 * one-time catch-up run creates the invoices already owed since 17 June 2026.
 *
 * **Read-only — every request is a GET.** The catch-up command has already been run on staging in
 * apply mode (2026-08-12, 82 invoices), so its *outcome* is readable even though the command
 * itself is not; AC5 and AC6 (preview mode and the CSV report) are `fixme`'d at the bottom.
 *
 * **The trap this spec is built around.** The Zuzahlungsverwaltung filter's `allWithInvoice` mode
 * returns 520 rows, of which **108 are imported non-Blanko VOs holding an invoice** — which reads
 * like AC1's third row failing. It is not: all 108 are `insuranceType: 'private'`, copayment-exempt
 * with a €0 copayment. They hold **PKV** invoices. #3276 is about GKV copayments only, so every
 * assertion here is scoped to `insuranceType === 'public'`.
 *
 * The same care applies to the regression VO: 9136-1's invoice shows an `issueDate` of 2026-08-19,
 * *after* the catch-up, which would suggest the run touched it. Its `invoice_created` log says
 * otherwise — created automatically on 2026-07-14. Provenance comes from the log, never the date.
 */

/** The catch-up run's staging execution: one command, one day, one batch. */
const CATCHUP_DAY = '2026-08-12';
const CATCHUP_SIZE = 82;

/** GKV copayment invoicing began here — the catch-up's candidate cutoff (AC4). */
const CUTOFF = new Date('2026-06-17T00:00:00Z');

/** The staging VOs the ticket names, with the invoice the catch-up gave each one. */
const CATCHUP_FIXTURES = [
  { number: '3210-4', invoice: 'R126-93' },
  { number: '6314-1', invoice: 'R326-45' },
  { number: '6504-1', invoice: 'R326-46' },
  { number: '5580-2', invoice: 'R426-73' },
  { number: '6536-1', invoice: 'R226-53' },
];

/** Blanko, but created in Flow rather than imported — must be untouched by all of this. */
const FLOW_BLANKO = { number: '9136-1', invoice: 'R526-27', createdOn: '2026-07-14' };

test.describe('Copayment invoicing for imported Blanko VOs (#3276)', () => {
  let billing: CopaymentExclusionsPage;

  test.beforeEach(async ({ page }) => {
    billing = new CopaymentExclusionsPage(page);
    await billing.open();
  });

  test(
    'AC1 — the origin × Blanko truth table holds across the whole copayment population',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      test.setTimeout(300_000);

      const rows = await billing.copaymentInvoicePopulation();
      const gkv = rows.filter(CopaymentExclusionsPage.isCopaymentRow);
      const pkv = rows.filter((r) => !CopaymentExclusionsPage.isCopaymentRow(r));

      const quadrant = (pool: VoBilling[], imported: boolean, blanko: boolean) =>
        pool.filter((r) => r.imported === imported && r.blankoVO === blanko);

      const importedBlanko = quadrant(gkv, true, true);
      const importedPlain = quadrant(gkv, true, false);
      const flowBlanko = quadrant(gkv, false, true);
      const flowPlain = quadrant(gkv, false, false);

      console.log(
        `[#3276] ${rows.length} rows with an invoice — ${gkv.length} GKV / ${pkv.length} PKV\n` +
          `        GKV by quadrant: imported+Blanko=${importedBlanko.length} (new behaviour) ` +
          `imported+non-Blanko=${importedPlain.length} (must be 0) ` +
          `Flow+Blanko=${flowBlanko.length} Flow+non-Blanko=${flowPlain.length}`,
      );
      console.log(
        `[#3276] the ${pkv.length} PKV rows include ${quadrant(pkv, true, false).length} imported non-Blanko VOs — ` +
          'private invoices, not copayment invoices, and out of this ticket\'s scope',
      );

      // Row 4 of AC1's table: the new behaviour. Without the carve-out this set would be empty.
      expect(importedBlanko.length, 'imported Blanko VOs must now hold copayment invoices').toBeGreaterThan(0);

      // Row 3: TheOrg already invoiced these, so Flow must never add a copayment invoice.
      expect(
        importedPlain.map((r) => `${r.number} (${r.invoice?.invoiceNumber})`),
        'no imported non-Blanko GKV VO may hold a copayment invoice',
      ).toEqual([]);

      // Rows 1 and 2: VOs created in Flow are invoiced regardless of Blanko, as before.
      expect(flowPlain.length, 'Flow-created VOs keep being invoiced').toBeGreaterThan(0);
    },
  );

  test(
    'AC2/AC3 — imported Blanko VOs are on the Zuzahlungsverwaltung list and imported non-Blanko VOs are not',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      test.setTimeout(180_000);

      const candidates = await billing.copaymentCandidates();
      const importedBlanko = candidates.filter((c) => c.imported && c.blankoVO);
      const importedPlain = candidates.filter((c) => c.imported && !c.blankoVO);

      console.log(
        `[#3276] Zuzahlungsverwaltung list: ${candidates.length} rows — ` +
          `${importedBlanko.length} imported Blanko, ${importedPlain.length} imported non-Blanko`,
      );
      console.log(`[#3276] imported Blanko on the list: ${importedBlanko.map((c) => c.number).join(', ')}`);

      // AC2 — previously hidden because they were imported.
      expect(importedBlanko.length, 'imported Blanko VOs must appear on the list').toBeGreaterThan(0);

      // AC3 — the list filter carried its own `imported = false` clause; the carve-out must be
      // exactly as narrow as the eligibility one, or non-Blanko imports leak onto the list.
      expect(
        importedPlain.map((c) => c.number),
        'imported non-Blanko VOs must stay off the Zuzahlungsverwaltung list',
      ).toEqual([]);
    },
  );

  test(
    'AC4 — the catch-up run created one batch of 82 invoices, including every VO the ticket names',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      test.setTimeout(300_000);

      const byDay = await billing.invoiceCreationsByDay();
      const batch = byDay[`${CATCHUP_DAY}/automatic`] ?? 0;
      const neighbours = Object.entries(byDay)
        .filter(([key]) => key.startsWith('2026-08'))
        .sort()
        .map(([key, count]) => `${key}=${count}`)
        .join(' ');
      console.log(`[#3276] invoice_created in August: ${neighbours}`);

      // A one-time run leaves one unmistakable spike; ordinary days sit in the single digits.
      expect(batch, `the catch-up run's ${CATCHUP_DAY} batch`).toBe(CATCHUP_SIZE);

      for (const fixture of CATCHUP_FIXTURES) {
        const vo = await billing.voByNumber(fixture.number);
        expect(vo, `${fixture.number} must resolve`).not.toBeNull();
        expect(vo!.imported && vo!.blankoVO, `${fixture.number} is an imported Blanko VO`).toBe(true);
        expect(vo!.invoice?.invoiceNumber, `${fixture.number} carries its catch-up invoice`).toBe(fixture.invoice);
        console.log(`[#3276] ${fixture.number} → ${vo!.invoice!.invoiceNumber} (${vo!.invoice!.status})`);
      }
    },
  );

  test(
    'AC4 — no VO billed before the 17 June 2026 cutoff was picked up',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      test.setTimeout(300_000);

      const rows = await billing.copaymentInvoicePopulation();
      const importedBlanko = rows.filter(
        (r) => CopaymentExclusionsPage.isCopaymentRow(r) && r.imported && r.blankoVO && r.invoice,
      );

      const dated = importedBlanko.filter((r) => r.invoice!.issueDate);
      const tooEarly = dated.filter((r) => new Date(r.invoice!.issueDate) < CUTOFF);
      const earliest = dated
        .map((r) => r.invoice!.issueDate.slice(0, 10))
        .sort()[0];

      console.log(
        `[#3276] ${importedBlanko.length} imported Blanko VOs hold a copayment invoice; ` +
          `earliest invoice date ${earliest}, cutoff ${CUTOFF.toISOString().slice(0, 10)}`,
      );

      // The invoice date is the run date, not the billing date (the generator always stamps "now"),
      // so this is a one-way check: nothing may predate the cutoff. The billing date the cutoff
      // actually filters on is not exposed on the VO once auto-archive clears it, which is why the
      // stricter "every candidate was billed on or after 17 June" is not asserted here.
      expect(tooEarly.map((r) => `${r.number} ${r.invoice!.issueDate}`), 'no copayment invoice may predate the cutoff').toEqual([]);
    },
  );

  test(
    'regression — the Flow-created Blanko VO keeps the invoice it already had',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      test.setTimeout(120_000);

      const vo = await billing.voByNumber(FLOW_BLANKO.number);
      expect(vo, `${FLOW_BLANKO.number} must resolve`).not.toBeNull();
      expect(vo!.imported, 'the regression VO is created in Flow, not imported').toBe(false);
      expect(vo!.blankoVO, 'the regression VO is Blanko').toBe(true);
      expect(vo!.invoice?.invoiceNumber, 'it keeps its original invoice').toBe(FLOW_BLANKO.invoice);

      const creations = await billing.invoiceCreations(vo!.id);
      console.log(
        `[#3276] ${FLOW_BLANKO.number} → ${vo!.invoice!.invoiceNumber}, created ` +
          creations.map((c) => `${c.type}@${c.createdAt.toISOString().slice(0, 10)}`).join(', ') +
          `, issueDate now ${vo!.invoice!.issueDate.slice(0, 10)}`,
      );

      // Its issueDate reads 2026-08-19 — after the catch-up — because a later regeneration restamped
      // it. Creation provenance is the log, and the log puts it a month before the run.
      expect(creations.length, 'exactly one creation — the catch-up did not add a second invoice').toBe(1);
      expect(creations[0].createdAt.toISOString().slice(0, 10), 'created well before the catch-up ran').toBe(
        FLOW_BLANKO.createdOn,
      );
      expect(creations[0].createdAt < new Date(`${CATCHUP_DAY}T00:00:00Z`)).toBe(true);
    },
  );

  /**
   * AC5 (the catch-up runs in preview mode first, listing candidates without writing) and AC6 (the
   * confirmed run produces a report of VO number / invoice number / patient) are properties of the
   * console command and its CSV output. Neither the mode switch nor the report is reachable over
   * HTTP; the PM's evidence is the two CSVs from the 2026-08-10 preview and the 2026-08-12 apply run.
   *
   * The apply run's outcome — one automatic batch of exactly 82 on 2026-08-12 — is asserted above,
   * which is as close as a browser gets to AC6's report.
   */
  test.fixme(
    'AC5/AC6 — preview mode lists candidates without writing, and the confirmed run reports what it created',
    { tag: ['@SuperAdmin', '@CopaymentBlanko', '@ImportedBlanko'] },
    async () => {
      // Console-only: `preview` is the command's default mode and the report is a CSV artefact.
    },
  );
});
