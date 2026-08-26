import { test, expect } from '@playwright/test';
import {
  ALL_EXCLUSIONS,
  BACKFILL_EXCLUSIONS,
  CONTROL_VO,
  CopaymentExclusionsPage,
  ELIGIBLE_UNINVOICED_VO,
  EXCLUDED_NUMBERS,
  FIX_SHIPPED_AT,
  FUTURE_EXCLUSIONS,
  MANUAL_DRAFT_VO,
  VoBilling,
} from '../../../Pages/superadmin/sa.copayment-exclusions.page';

/**
 * RC 3.11.1 #3426 — "Exclude TheOrg-Invoiced Blanko VOs from Copayment Invoice Generation".
 *
 * #3276 made imported Blanko VOs eligible for copayment invoicing. For 33 of them TheOrg had
 * already invoiced the copayment, so invoicing them again in Flow double-bills the patient. #3426
 * makes both automatic paths — the held one-time catch-up run and the ongoing eligibility check —
 * skip those 33 permanently, while leaving manual admin creation open for them.
 *
 * **How this is decided here.** Not from an invoice's timestamp: `GET /invoice_logs` carries an
 * `invoice_created` entry per invoice with `meta.type: "manual" | "automatic"`, so "did an
 * automatic path invoice this VO?" is a fact, not an inference. The exclusion shipped on staging on
 * 2026-08-20 07:14 UTC; a staging rehearsal of the catch-up run had already invoiced 16 of the 18
 * backfill-group VOs on 2026-08-12 (and 6891-1 on 2026-08-08), so what the fix has to hold is that
 * nothing automatic has been created for any of the 33 *since* that moment.
 *
 * Staging carries the same VO numbers as production, so the production exclusion list drives these
 * tests directly — the same way the PM verified the mechanism.
 *
 * Mutations are self-restoring: AC6 round-trips one VO's validation status back to the value it
 * found, and AC4 regenerates a draft that already exists (same invoice number, no Storno).
 */
test.describe('Copayment invoicing — TheOrg-invoiced Blanko exclusions (#3426)', () => {
  test.describe.configure({ mode: 'serial' });

  let billing: CopaymentExclusionsPage;

  test.beforeEach(async ({ page }) => {
    billing = new CopaymentExclusionsPage(page);
    await billing.open();
  });

  test(
    'all 33 excluded VOs exist on staging and are the imported Blanko VOs the rule targets',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(240_000);

      const missing: string[] = [];
      const notImportedBlanko: string[] = [];
      const statuses: Record<string, number> = {};

      for (const excluded of ALL_EXCLUSIONS) {
        const vo = await billing.voByNumber(excluded.number);
        if (!vo) {
          missing.push(excluded.number);
          continue;
        }
        if (!vo.imported || !vo.blankoVO) notImportedBlanko.push(`${vo.number} imported=${vo.imported} blanko=${vo.blankoVO}`);
        statuses[vo.treatmentStatus] = (statuses[vo.treatmentStatus] ?? 0) + 1;
      }

      console.log(`[#3426] treatment statuses across the 33: ${JSON.stringify(statuses)}`);

      expect(missing, 'every VO on the exclusion list must resolve on staging').toEqual([]);
      expect(
        notImportedBlanko,
        'the exclusion only makes sense for imported Blanko VOs — #3276 is what made those eligible',
      ).toEqual([]);
      expect(ALL_EXCLUSIONS.length, 'the ticket lists 18 backfill + 15 future exclusions').toBe(33);
      expect(BACKFILL_EXCLUSIONS.length).toBe(18);
      expect(FUTURE_EXCLUSIONS.length).toBe(15);

      // AC6 is about the exclusion not depending on a status snapshot; the list spanning several
      // statuses at once is what makes the next test's result meaningful.
      expect(
        Object.keys(statuses).length,
        'the excluded VOs sit in more than one treatment status, so a status-independent rule is what is under test',
      ).toBeGreaterThan(1);
    },
  );

  test(
    'AC3/AC6 — no excluded VO has been invoiced automatically since the exclusion shipped',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const violations: string[] = [];
      const preFix: string[] = [];
      const manual: string[] = [];

      for (const excluded of ALL_EXCLUSIONS) {
        const vo = await billing.voByNumber(excluded.number);
        expect(vo, `VO ${excluded.number} must resolve`).not.toBeNull();

        const creations = await billing.invoiceCreations(vo!.id);
        for (const creation of creations) {
          const stamp = `${vo!.number} ${creation.invoiceNumber ?? creation.invoice} ${creation.createdAt.toISOString()}`;
          if (creation.type === 'manual') manual.push(`${stamp} by ${creation.createdBy}`);
          else if (creation.createdAt < FIX_SHIPPED_AT) preFix.push(stamp);
          else violations.push(`${stamp} (${creation.type}, by ${creation.createdBy})`);
        }
      }

      console.log(
        `[#3426] invoice_created on the 33: ${preFix.length} automatic pre-fix, ` +
          `${manual.length} manual, ${violations.length} automatic since ${FIX_SHIPPED_AT.toISOString()}`,
      );
      if (preFix.length) console.log(`[#3426] pre-fix automatic (staging catch-up rehearsal): ${preFix.join(' | ')}`);
      if (manual.length) console.log(`[#3426] manual creations (allowed by AC4): ${manual.join(' | ')}`);

      expect(
        violations,
        'no VO on the exclusion list may be invoiced by the catch-up run or the ongoing generation after the fix',
      ).toEqual([]);
    },
  );

  test(
    'AC3 — the only copayment candidate left uninvoiced is on the exclusion list',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(180_000);

      const candidates = await billing.copaymentCandidates();
      const importedBlanko = candidates.filter((c) => c.imported && c.blankoVO);
      const wouldInvoice = importedBlanko.filter(CopaymentExclusionsPage.wouldInvoiceToday);
      const uninvoiced = wouldInvoice.filter((c) => !c.invoice);

      const describe = (c: VoBilling) =>
        `${c.number} (${c.treatmentStatus}, ${c.validationStatus}, ${c.copaymentAmount}€, ` +
        `${c.invoice ? c.invoice.invoiceNumber : 'no invoice'})`;

      console.log(
        `[#3426] copayment candidates: ${candidates.length} total, ${importedBlanko.length} imported Blanko, ` +
          `${wouldInvoice.length} in the would-invoice-today profile, ${uninvoiced.length} of those uninvoiced`,
      );
      console.log(`[#3426] would-invoice-today: ${wouldInvoice.map(describe).join(' | ')}`);

      expect(
        uninvoiced.length,
        'the exclusion must be visible: at least one eligible imported Blanko VO sits uninvoiced',
      ).toBeGreaterThan(0);

      const notExcluded = uninvoiced.filter((c) => !EXCLUDED_NUMBERS.has(c.number));
      expect(
        notExcluded.map(describe),
        'every eligible imported Blanko VO without an invoice must be one of the 33 — anything else is #3276 failing',
      ).toEqual([]);
    },
  );

  test(
    'AC5 — automatic generation still runs for an imported Blanko VO that is not on the list',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(120_000);

      const control = await billing.voByNumber(CONTROL_VO);
      expect(control, `the control VO ${CONTROL_VO} must resolve`).not.toBeNull();
      expect(EXCLUDED_NUMBERS.has(CONTROL_VO), 'the control VO must not be on the exclusion list').toBe(false);
      expect(control!.imported && control!.blankoVO, 'the control must be an imported Blanko VO, like the 33').toBe(true);
      expect(
        CopaymentExclusionsPage.wouldInvoiceToday(control!),
        'the control must sit in the same would-invoice-today profile as the excluded fixtures',
      ).toBe(true);

      expect(control!.invoice, 'a non-excluded eligible imported Blanko VO must carry a copayment invoice').not.toBeNull();

      const creations = await billing.invoiceCreations(control!.id);
      const automaticSinceFix = CopaymentExclusionsPage.automaticSince(creations, FIX_SHIPPED_AT);
      console.log(
        `[#3426] control ${CONTROL_VO}: ${control!.invoice!.invoiceNumber}, creations = ` +
          creations.map((c) => `${c.type}@${c.createdAt.toISOString()} by ${c.createdBy}`).join(', '),
      );

      // This is what separates "the exclusion works" from "generation is switched off": the very
      // path that must skip the 33 produced this invoice AFTER the exclusion shipped.
      expect(
        automaticSinceFix.length,
        'the ongoing automatic generation must still fire for non-excluded imported Blanko VOs after the fix',
      ).toBeGreaterThan(0);
    },
  );

  test(
    'AC6 — re-validating an excluded VO re-fires the eligibility check and still creates nothing',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@Mutating'] },
    async () => {
      test.setTimeout(180_000);

      const before = await billing.voByNumber(ELIGIBLE_UNINVOICED_VO);
      expect(before, `the AC6 fixture ${ELIGIBLE_UNINVOICED_VO} must resolve`).not.toBeNull();
      expect(EXCLUDED_NUMBERS.has(before!.number), 'the fixture must be on the exclusion list').toBe(true);
      expect(
        CopaymentExclusionsPage.wouldInvoiceToday(before!),
        'the fixture must be fully eligible — otherwise "no invoice" proves nothing',
      ).toBe(true);
      expect(before!.invoice, 'the fixture starts with no copayment invoice').toBeNull();

      const original = before!.validationStatus as 'validated';
      const creationsBefore = await billing.invoiceCreations(before!.id);

      try {
        // The ongoing check runs on a validation write. Two full round trips — four writes, landing
        // back on the value found — cover AC6's "however many times its status changes afterward".
        for (let round = 1; round <= 2; round++) {
          expect(await billing.setValidationStatus(before!.id, 'for_fixing'), `round ${round}: PATCH for_fixing`).toBe(200);
          expect(await billing.setValidationStatus(before!.id, original), `round ${round}: PATCH ${original}`).toBe(200);
        }
      } finally {
        // Never leave the fixture off `validated`, whatever failed above.
        await billing.setValidationStatus(before!.id, original);
      }

      const after = await billing.vo(before!.id);
      const creationsAfter = await billing.invoiceCreations(before!.id);
      console.log(
        `[#3426] ${ELIGIBLE_UNINVOICED_VO} after 4 validation writes: status=${after.validationStatus}, ` +
          `invoice=${after.invoice ? after.invoice.invoiceNumber : 'none'}, creations=${creationsAfter.length}`,
      );

      expect(after.validationStatus, 'the fixture is restored to the status it was found in').toBe(original);
      expect(after.invoice, 'a re-evaluated excluded VO must still hold no copayment invoice').toBeNull();
      expect(creationsAfter.length, 'no invoice_created entry may appear from re-evaluation').toBe(creationsBefore.length);
    },
  );

  test(
    'AC4 — an admin can still create a copayment invoice manually on an excluded VO',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@Mutating'] },
    async () => {
      test.setTimeout(180_000);

      const before = await billing.voByNumber(MANUAL_DRAFT_VO);
      expect(before, `the AC4 fixture ${MANUAL_DRAFT_VO} must resolve`).not.toBeNull();
      expect(EXCLUDED_NUMBERS.has(before!.number), 'the fixture must be on the exclusion list').toBe(true);
      expect(
        before!.invoice,
        `${MANUAL_DRAFT_VO} must already hold the manually created draft this test regenerates`,
      ).not.toBeNull();
      expect(
        before!.invoice!.status,
        'only a not_sent draft is regenerated — an issued invoice would raise a Storno',
      ).toBe('not_sent');

      const result = await billing.generateInvoice(before!.id);
      console.log(`[#3426] manual generate-invoice on excluded ${MANUAL_DRAFT_VO}: ${result.status} ${result.body}`);

      expect(result.status, 'the manual action must not be blocked by the exclusion').toBe(200);
      expect(result.success, 'the manual action reports success').toBe(true);
      expect(result.invoiceNumber, 'the draft is replaced in place — the invoice number is preserved').toBe(
        before!.invoice!.invoiceNumber,
      );

      const after = await billing.vo(before!.id);
      expect(after.invoice, 'the VO still carries its copayment invoice').not.toBeNull();
      expect(after.invoice!.id, 'the same invoice, not a second one').toBe(before!.invoice!.id);

      const creations = await billing.invoiceCreations(before!.id);
      expect(
        creations.every((c) => c.type === 'manual'),
        'every invoice this excluded VO has ever had must have been created by hand',
      ).toBe(true);
      expect(
        CopaymentExclusionsPage.automaticSince(creations, FIX_SHIPPED_AT),
        'manual creation must not open a door for the automatic path',
      ).toEqual([]);
    },
  );

  test(
    'AC4 (read-only) — the one invoice an excluded VO holds since the fix was created by hand',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const manualSinceFix: string[] = [];
      const automaticSinceFix: string[] = [];

      for (const excluded of ALL_EXCLUSIONS) {
        const vo = await billing.voByNumber(excluded.number);
        expect(vo, `VO ${excluded.number} must resolve`).not.toBeNull();
        for (const creation of await billing.invoiceCreations(vo!.id)) {
          if (creation.createdAt < FIX_SHIPPED_AT) continue;
          const stamp = `${vo!.number} ${creation.invoiceNumber} by ${creation.createdBy}`;
          if (creation.type === 'manual') manualSinceFix.push(stamp);
          else automaticSinceFix.push(`${stamp} (${creation.type})`);
        }
      }

      console.log(`[#3426] since the fix — manual: ${manualSinceFix.join(' | ') || 'none'}`);
      console.log(`[#3426] since the fix — automatic: ${automaticSinceFix.join(' | ') || 'none'}`);

      // AC4 says the exclusion blocks automatic generation and nothing else. The standing evidence
      // that manual creation still reaches an excluded VO is an `invoice_created` entry that is
      // `manual` and carries a real person as its author — the write-based test re-proves this live.
      expect(
        manualSinceFix.length,
        'at least one excluded VO carries a hand-made invoice created after the exclusion shipped',
      ).toBeGreaterThan(0);
      expect(automaticSinceFix, 'and none of the 33 was reached by an automatic path').toEqual([]);
    },
  );

  test(
    'AC6 (read-only) — the exclusion holds across every status and validation state the 33 are in',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const byStatus: Record<string, number> = {};
      const byValidation: Record<string, number> = {};
      const eligibleUninvoiced: string[] = [];
      const violations: string[] = [];

      for (const excluded of ALL_EXCLUSIONS) {
        const vo = await billing.voByNumber(excluded.number);
        expect(vo, `VO ${excluded.number} must resolve`).not.toBeNull();
        byStatus[vo!.treatmentStatus] = (byStatus[vo!.treatmentStatus] ?? 0) + 1;
        const validation = vo!.validationStatus ?? '(none)';
        byValidation[validation] = (byValidation[validation] ?? 0) + 1;
        if (CopaymentExclusionsPage.wouldInvoiceToday(vo!) && !vo!.invoice) eligibleUninvoiced.push(vo!.number);

        const automatic = CopaymentExclusionsPage.automaticSince(await billing.invoiceCreations(vo!.id), FIX_SHIPPED_AT);
        for (const creation of automatic) violations.push(`${vo!.number} ${creation.invoiceNumber}`);
      }

      console.log(`[#3426] statuses ${JSON.stringify(byStatus)} · validation ${JSON.stringify(byValidation)}`);
      console.log(`[#3426] excluded, eligible today, still uninvoiced: ${eligibleUninvoiced.join(', ') || 'none'}`);

      // AC6's point is that the exclusion is keyed to the VO number, not to a status snapshot taken
      // when the fix shipped. Read-only, the evidence is coverage: the 33 sit in several treatment
      // statuses and several validation states at once, and not one of them has been invoiced
      // automatically in any of them.
      expect(Object.keys(byStatus).length, 'the 33 span more than one treatment status').toBeGreaterThan(1);
      expect(Object.keys(byValidation).length, 'and more than one validation state').toBeGreaterThan(1);
      expect(
        eligibleUninvoiced.length,
        'at least one excluded VO is fully eligible right now and still uninvoiced',
      ).toBeGreaterThan(0);
      expect(violations, 'no excluded VO was invoiced automatically in any of those states').toEqual([]);
    },
  );

  /**
   * AC1 and AC2 are the one-time catch-up run: `CopaymentInvoiceBackfillService`, executed as a
   * console command against production with a preview mode that reports
   * "136 would-create / 18 excluded / 9 skipped (no billing date)" out of 163 candidates.
   *
   * There is no HTTP surface for it — not a route, not a job the UI can start — and the split is
   * measured against the 20 August 2026 production dump, a dataset staging does not hold. The
   * excluded-18 half of AC1 is covered from the data side by the "no excluded VO has been invoiced
   * automatically" test above, which is what the run's exclusion group has to produce.
   */
  test.fixme(
    'AC1/AC2 — catch-up preview reports 136 would-create / 18 excluded / 9 skipped',
    { tag: ['@SuperAdmin', '@CopaymentExclusions', '@TheOrgBlanko', '@ReadOnly'] },
    async () => {
      // Console-only command against production data; no browser or API surface exists to drive it.
    },
  );
});
