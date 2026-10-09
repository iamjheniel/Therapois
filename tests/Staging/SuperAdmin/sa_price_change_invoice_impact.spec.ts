import { test, expect } from '../../fixtures/session';
import {
  PriceChangeImpactPage,
  AC3_INCLUDED,
  KG_TREATMENT_ID,
  MAX_ENTRIES,
  NEVER_ISSUED,
} from '../../../Pages/superadmin/sa.price-change-impact.page';

/**
 * RC 3.13 — a back-dated price entry warns which issued invoices it would change (#3650).
 *
 * A back-dated Heilmittel price silently moved the amount on **65 already-issued copayment invoices**
 * earlier in 2026 (122,96 EUR, written off after the fact). The fix adds a non-blocking pre-save
 * warning listing every issued invoice whose amount would change, and refreshes Not Sent drafts
 * after the save. **Deployed; AC1, AC3 and AC4 verified live. 5 passed / 2 fixme.**
 *
 * **The preflight is an unusually good test surface: it is EXACT, not modelled, and it writes
 * nothing.** `POST /treatments/price-change-invoice-impact` inserts the candidate
 * `treatment_price_history` rows, runs the REAL `ActivityTreatmentSnapshotRecalculator`, reads the
 * new invoice amounts, and rolls the transaction back — so the numbers in the warning are the
 * numbers the save would produce, and a test can fire it freely. A test re-reads the price history
 * afterwards to prove the rollback.
 *
 * **FINDING — AC3's table is not the implemented rule, and the difference is real.** The AC lists
 * six statuses as included (Sent, Overdue, Reminded, To Debt Collector, Sent to DC, Paid) and two as
 * excluded. The code uses `InvoiceStatusEnum::issued()` = *everything except NOT_SENT and CANCELLED*,
 * which also covers statuses the table never mentions. Live proof: the warning returns **R426-64,
 * status `on_hold` (Pausiert)** — nowhere in AC3. Including it is defensible (an on-hold invoice has
 * been issued; pausing is a dunning state) but it is a decision the AC does not sanction, and a QA
 * checking the table literally would report it as a defect.
 *
 * **A second divergence, this one deliberate and worth keeping:** a **NOT_SENT invoice that HAS been
 * DATEV-synced** is included, though AC3 says Not Sent → No. The reason is that the after-save draft
 * refresh (AC5) is draft-tier only — NOT_SENT **and** never synced — so a synced draft would
 * otherwise fall between the two halves of this ticket and be silently repriced with no warning.
 * Staging has exactly one such invoice, **R126-86**, and the warning lists it.
 *
 * **Traps:** `tariffType` is the `TreatmentTariffType` enum (`GKV` / `PRIVAT` / `PRIVAT_BASIS` /
 * `BEIHILFE` / `BG`), NOT an insurance type — an unknown value is rejected with 400 rather than
 * silently ignored, which is a welcome change from most filters here; and the endpoint is a plain
 * Symfony route with `#[IsGranted('ROLE_ADMIN')]` rather than an API Platform `security:` expression,
 * because `use_symfony_listeners: false` means a custom controller never reaches the stage that
 * evaluates those (#3529).
 *
 * **Read-only in effect** — the one POST is the rehearsal, which always rolls back.
 */

test.describe('#3650 back-dated price entry warns about issued invoices', () => {
  test.describe.configure({ mode: 'serial' });

  const BACK_DATED = { treatmentId: KG_TREATMENT_ID, tariffType: 'PRIVAT', effectiveDate: '2026-01-01', price: 99 };

  test(
    'AC1 the warning lists each affected invoice with number, date, current and recomputed amount',
    { tag: ['@SuperAdmin', '@PriceChangeImpact', '@ReadOnly'] },
    async ({ request }) => {
      const api = new PriceChangeImpactPage(request);
      const res = await api.impact([BACK_DATED]);
      expect(res.status).toBe(200);
      expect(res.count, 'a large back-dated change must affect issued invoices, or the fixture is wrong').toBeGreaterThan(0);
      expect(res.invoices.length).toBe(res.count);

      console.log(`#3650 AC1: ${res.count} issued invoices would change under KG PRIVAT 99,00 from 2026-01-01`);
      for (const i of res.invoices.slice(0, 6)) {
        console.log(`   ${i.invoiceNumber.padEnd(10)} VO ${i.prescriptionNumber.padEnd(10)} ${i.date} ${i.currentAmount} -> ${i.recomputedAmount}`);
      }

      // AC1 names exactly four columns; all four must be usable, not merely present.
      for (const i of res.invoices) {
        expect(i.invoiceNumber, 'every row needs an invoice number').toBeTruthy();
        expect(i.date, `${i.invoiceNumber} needs an invoice date`).toBeTruthy();
        expect(typeof i.currentAmount, `${i.invoiceNumber} needs a current amount`).toBe('number');
        expect(typeof i.recomputedAmount, `${i.invoiceNumber} needs a recomputed amount`).toBe('number');
        // A row that does not change amount has no business in a warning about changed amounts.
        expect(Math.abs(i.currentAmount - i.recomputedAmount), `${i.invoiceNumber} is listed but its amount does not move`).toBeGreaterThan(0.001);
      }

      // GDPR: the #3325 pattern this mirrors returns no patient field. Nor may this.
      const serialized = JSON.stringify(res.invoices);
      for (const leak of ['patient', 'firstName', 'lastName', 'birthDate', 'insuranceNumber']) {
        expect(serialized.toLowerCase(), `the warning must not carry ${leak}`).not.toContain(leak.toLowerCase());
      }
    },
  );

  test(
    'AC3 nothing excluded is listed: no cancelled invoice, no Storno, and every row really is issued',
    { tag: ['@SuperAdmin', '@PriceChangeImpact', '@ReadOnly'] },
    async ({ request }) => {
      const api = new PriceChangeImpactPage(request);
      const [res, book] = await Promise.all([api.impact([BACK_DATED]), api.invoiceBook()]);

      const statuses = new Map<string, number>();
      for (const i of res.invoices) {
        const s = book.get(i.invoiceNumber)?.status ?? '?';
        statuses.set(s, (statuses.get(s) ?? 0) + 1);
      }
      console.log(`#3650 AC3: listed statuses — ${JSON.stringify(Object.fromEntries(statuses))}`);

      for (const i of res.invoices) {
        const s = book.get(i.invoiceNumber)?.status;
        expect(s, `${i.invoiceNumber} must exist in the book`).toBeTruthy();
        expect(NEVER_ISSUED as readonly string[]).not.toContain(s === 'not_sent' ? '__allowed_when_synced__' : s);
        expect(s, `${i.invoiceNumber}: a cancelled invoice must never be warned about`).not.toBe('cancelled');
        expect(i.invoiceNumber.startsWith('S'), `${i.invoiceNumber}: a Storno must never be listed`).toBe(false);
      }
    },
  );

  test(
    'FINDING — the rule is wider than AC3\'s table: on_hold is included, and so is a DATEV-synced draft',
    { tag: ['@SuperAdmin', '@PriceChangeImpact', '@ReadOnly'] },
    async ({ request }) => {
      const api = new PriceChangeImpactPage(request);
      const [res, book] = await Promise.all([api.impact([BACK_DATED]), api.invoiceBook()]);

      const outsideTable = res.invoices.filter((i) => {
        const s = book.get(i.invoiceNumber)?.status ?? '';
        return !(AC3_INCLUDED as readonly string[]).includes(s);
      });
      for (const i of outsideTable) {
        console.log(`   ${i.invoiceNumber} status ${book.get(i.invoiceNumber)?.status} — listed, but AC3's table does not name this status`);
      }
      expect(outsideTable.length, 'this finding stands while such an invoice is in the affected set').toBeGreaterThan(0);

      // The synced-draft case is deliberate, and staging has exactly one instance of it.
      const draft = res.invoices.find((i) => book.get(i.invoiceNumber)?.status === 'not_sent');
      if (draft) {
        const synced = await api.datevSyncedAt(draft.invoiceNumber);
        console.log(`   ${draft.invoiceNumber} is NOT_SENT but datevSyncedAt=${synced} — warned about rather than silently refreshed`);
        expect(synced, 'a NOT_SENT invoice may only be listed when it has reached DATEV').toBeTruthy();
      }
    },
  );

  test(
    'AC4 no warning when the entry is not back-dated, or when the price does not move',
    { tag: ['@SuperAdmin', '@PriceChangeImpact', '@ReadOnly'] },
    async ({ request }) => {
      const api = new PriceChangeImpactPage(request);
      const today = new Date().toISOString().slice(0, 10);

      const cases: [string, { treatmentId: number; tariffType: string; effectiveDate: string; price: number }][] = [
        ['effective today (not back-dated)', { ...BACK_DATED, effectiveDate: today }],
        ['effective in the future', { ...BACK_DATED, effectiveDate: '2027-01-01' }],
        ['back-dated but the same price as today', { ...BACK_DATED, price: 39 }],
      ];
      for (const [label, entry] of cases) {
        const res = await api.impact([entry]);
        console.log(`   ${label.padEnd(36)} -> count ${res.count}`);
        expect(res.status).toBe(200);
        expect(res.count, `${label}: the save must proceed with no warning`).toBe(0);
      }
    },
  );

  test(
    'the preflight writes nothing, and its payload guards reject before any work',
    { tag: ['@SuperAdmin', '@PriceChangeImpact', '@ReadOnly'] },
    async ({ request }) => {
      // The rehearsal inserts real price-history rows and runs the real recalculator; the only thing
      // standing between that and a live repricing is the rollback. So it is asserted, not assumed.
      const api = new PriceChangeImpactPage(request);
      const before = await api.priceHistory(KG_TREATMENT_ID);
      await api.impact([BACK_DATED]);
      const after = await api.priceHistory(KG_TREATMENT_ID);

      console.log(`#3650: price-history rows for treatment ${KG_TREATMENT_ID} — ${before.length} before, ${after.length} after`);
      expect(after.length, 'the rehearsal must leave no price-history row behind').toBe(before.length);
      expect(after.some((r) => r.tariffType === 'PRIVAT' && r.effectiveDate === '2026-01-01'), 'the candidate row must be gone').toBe(false);

      const bad = await api.impact([{ ...BACK_DATED, tariffType: 'PKV' }]);
      console.log(`   tariffType "PKV" (an insurance type, not a tariff) -> ${bad.status} "${bad.detail}"`);
      expect(bad.status, 'an unknown tariff type is rejected, not silently ignored').toBe(400);

      const oversized = Array.from({ length: MAX_ENTRIES + 1 }, () => BACK_DATED);
      const tooMany = await api.impact(oversized);
      console.log(`   ${oversized.length} entries (cap ${MAX_ENTRIES}) -> ${tooMany.status} "${tooMany.detail}"`);
      expect(tooMany.status).toBe(400);
    },
  );
});
