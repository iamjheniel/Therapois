import { test, expect } from '@playwright/test';
import {
  INSURANCE,
  INSURANCE_LABEL,
  InsuranceReprisePage,
  VoSnapshot,
} from '../../../Pages/superadmin/sa.insurance-reprice.page';

/**
 * RC 3.12 — correcting a VO's Versicherungsart between PKV and Privat Basis (#3535).
 *
 * Two halves ship in one commit (`9a8dee2a`, 2026-08-29, `release/3.12.0`) and only one of them is
 * live on staging:
 *
 * - **The confirmation is deployed and correct.** Picking the other of PKV/Privat Basis on the VO
 *   edit form raises "Behandlungen neu bepreisen?" naming both types and the session count, and it
 *   is gated exactly as AC3–AC6 require — including the boundary AC3 words carefully: a VO whose
 *   only invoice is **cancelled** still gets the dialog, because `prescription.invoice` is
 *   `getActiveInvoice()` server-side and skips cancelled invoices and Stornos.
 * - **The repricing is not.** Confirming and saving leaves every session on the old type's tariff.
 *   Asserted in both directions, through the real form AND through the API, on Aktiv / Fertig
 *   Behandelt / Archiviert VOs → AC1 and AC2 are `fixme`'d with the numbers.
 *
 * **The trap that makes a false PASS easy, and why the PM's own note reports 6/6.** The ticket's QA
 * step is "check the VO's Behandlungsdetails or Preis view before and after", and that figure DOES
 * move: on fixture 4355-1 the form's Gesamtumsatz goes **257,85 → 224,65** when the type is
 * corrected. It moves for a reason that predates this ticket — a VO's revenue is the sum of the
 * *snapshotted* treatment lines plus a *live* calculation of the fee lines, and only the fee half
 * follows the current insurance type. Full repricing would give **178,33**; the €46,32 difference
 * is the three PNF sessions still billing the PKV tariff 61,95 instead of 47,69 / 45,92 / 45,92.
 * Anything asserting this ticket has to read the per-session rows, never the total.
 *
 * **`resolvedTariff` is the surface, and this file re-proves that every run.** The control test
 * adds a price entry with a past effective date and watches the same fixture's rows move
 * 61,95 → 61,96 (130 rows across staging) and back on delete — #3378's recompute, alive and well
 * against the same column. So the failure is specific to the insurance-correction path, not to the
 * mechanism, the column, or the environment.
 *
 * **Fixture design.** `PRIVAT` carries one flat entry per treatment (effective 2025-01-01) while
 * `PRIVAT_BASIS` carries a quarterly ladder at different prices, so a VO whose sessions straddle
 * one of those dates is what separates "repriced at each session's own date" from "repriced at
 * today's". 4355-1's three sessions straddle **2025-07-01**, which is why it is the AC1 fixture and
 * not one of the many same-quarter candidates.
 *
 * **Staging holds only four `privat_basis` VOs**, two of them with no sessions, so AC2 has exactly
 * one usable fixture (905301-2, one session, documented natively at the Basistarif 29,63).
 *
 * **Traps.** The dialog has no `role="dialog"`; "Speichern" is inert unless every creation-validation
 * check auto-passed (#3340), so the persisting route is "Zur Korrektur speichern" + its own
 * "Speichern bestätigen"; and one `openVoForm()` per test, since the form does not remount on a
 * second navigation. All three are handled in `Pages/superadmin/sa.insurance-reprice.page.ts`.
 */

/**
 * AC1's fixture: PKV, 3 documented sessions, **no invoice**, no billing batch, and — the reason a
 * fixture has to be chosen this carefully — its sessions straddle the **2025-04-01** price step, so
 * a reprice at each session's own date is distinguishable from a reprice at today's.
 *
 * Sessions: 2025-03-28 / 04-24 / 05-02, each KG-H (39,00 PKV) + HBH-PT (24,00 PKV).
 * Under Privat Basis they must become KG-H 27,80 / 30,03 / 30,03 and HBH-PT 12,28 / 13,26 / 13,26.
 *
 * **Was 4355-1 (id 5314)** — the VO the `be7b69c53` fix commit credits. It is deliberately left at
 * Privat Basis on staging now (correctly repriced: PNF 47,69 / 45,92 / 45,92, HBH-PT 13,26 / 12,77 /
 * 12,77, Gesamtumsatz 178,33), so it can no longer serve as the PKV-side fixture. 2805-2 is the
 * equivalent from the same 257-candidate sweep.
 */
const PKV_FIXTURE = { id: 2684, vo: '2805-2', sessions: 3, treatment: 'KG-H', fee: 'HBH-PT' };

/** AC2's fixture: the only `privat_basis` VO with a documented session and no invoice. */
const PRIVAT_BASIS_FIXTURE = { id: 30497, vo: '905301-2', sessions: 1, treatment: 'KG' };

/** AC3: a PKV VO carrying a live (overdue) invoice over 20 documented sessions. */
const INVOICED_FIXTURE = { id: 12629, vo: '2900-3', invoice: '126-7' };

/** AC3's boundary: a PKV VO whose only invoice is cancelled — `invoice` is null, so it qualifies. */
const CANCELLED_ONLY_FIXTURE = { id: 27870, vo: '2898-6' };

/** AC4, both directions. */
const NO_SESSION_FIXTURES = [
  { id: 180, vo: '3847-2', from: INSURANCE.PKV, to: 'Privat Basis' },
  { id: 31089, vo: '4946-8', from: INSURANCE.PRIVAT_BASIS, to: 'PKV' },
];

/** AC6: the corrections this ticket deliberately leaves alone. */
const OUT_OF_SCOPE_CORRECTIONS = [
  { id: 51, vo: '2695-12', to: 'PKV', why: 'GKV → PKV' },
  { id: 51, vo: '2695-12', to: 'BG', why: 'GKV → BG' },
  { id: 2684, vo: '2805-2', to: 'GKV', why: 'PKV → GKV' },
];

test.describe('Versicherungsart correction between PKV and Privat Basis', () => {
  test(
    'AC5 — the confirmation names both types and the session count, and nothing is applied until it is confirmed',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const form = new InsuranceReprisePage(page);
      await form.openVoForm(PKV_FIXTURE.id);

      expect(await form.insuranceValue(), `${PKV_FIXTURE.vo} must start as PKV`).toBe('PKV');
      const revenueBefore = await form.gesamtumsatz();

      const options = await form.insuranceOptions();
      console.log(`Versicherungsart options: ${options.join(' | ')}`);
      expect(options, 'Privat Basis must be offered as a correction target').toContain('Privat Basis');

      await form.chooseInsurance('Privat Basis');
      const dialog = await form.repriceDialog();
      expect(dialog, 'the correction must raise the reprice confirmation').not.toBeNull();
      console.log(`dialog: ${dialog!.message}`);

      expect(dialog!.from, 'the dialog must name the CURRENT type').toBe('PKV');
      expect(dialog!.to, 'and the NEW one').toBe('Privat Basis');
      expect(dialog!.count, 'and the number of sessions to be repriced').toBe(PKV_FIXTURE.sessions);

      // "the admin must actively confirm before anything is saved". Declining is asserted on the
      // form VALUE, not on the label: `POST /prescriptions/detect-lhb-bvb` is driven by the Formik
      // insuranceType and fires on every real change (it does on the confirm path), so its absence
      // is the evidence that nothing was staged. The label itself does NOT go back — see the
      // `fixme` below.
      const lhbCalls: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('detect-lhb-bvb')) {
          try {
            lhbCalls.push(JSON.parse(request.postData() || '{}').insuranceType);
          } catch {
            /* the count alone answers "did the form value change" */
          }
        }
      });
      await form.cancelReprice();
      await page.waitForTimeout(5_000);
      expect(lhbCalls, 'declining must leave the form value untouched').toHaveLength(0);
      expect(await form.gesamtumsatz(), 'and change nothing about the VO').toBe(revenueBefore);

      const stored = await form.snapshot(PKV_FIXTURE.id);
      expect(stored.insuranceType, 'and nothing may be saved').toBe(INSURANCE.PKV);
    },
  );

  test(
    'AC5 — declining the confirmation puts the Versicherungsart field back',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        'The screen and the form value disagree after "Abbrechen". Picking Privat Basis on a PKV VO ' +
          'raises the confirmation; declining it correctly leaves the form value at PKV — no ' +
          '`detect-lhb-bvb` fires, and a save from that state writes `private` — but the dropdown goes ' +
          'on displaying "Privat Basis". The gate calls `Be(e)` (stage the pending value) instead of ' +
          '`setFieldValue`, so the controlled `value` prop never changes, and the dropdown keeps its own ' +
          'internal selection regardless. An admin who declines is left looking at a corrected field ' +
          'that will silently save uncorrected — the same wrong-tariff outcome the ticket exists to ' +
          'prevent, reached from the opposite direction.',
      );

      const form = new InsuranceReprisePage(page);
      await form.openVoForm(PKV_FIXTURE.id);
      expect(await form.insuranceValue()).toBe('PKV');
      await form.chooseInsurance('Privat Basis');
      expect(await form.repriceDialog()).not.toBeNull();
      await form.cancelReprice();
      expect(await form.insuranceValue(), 'declining must restore the shown type').toBe('PKV');
    },
  );

  test(
    'AC3 — a VO with a non-cancelled invoice raises no confirmation',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const form = new InsuranceReprisePage(page);
      await form.connect();
      const vo = await form.snapshot(INVOICED_FIXTURE.id);
      expect(vo.activeInvoice?.number, `${INVOICED_FIXTURE.vo} must still carry its invoice`).toBe(
        INVOICED_FIXTURE.invoice,
      );
      expect(InsuranceReprisePage.pricedRows(vo).length, 'and have documented sessions to reprice').toBeGreaterThan(0);

      await form.openVoForm(INVOICED_FIXTURE.id);
      expect(await form.insuranceValue()).toBe('PKV');
      await form.chooseInsurance('Privat Basis');
      expect(
        await form.repriceDialog(6_000),
        'an invoiced VO must not offer to reprice — that correction is a storno matter',
      ).toBeNull();
      expect(await form.insuranceValue(), 'the correction itself still applies to the field').toBe('Privat Basis');
    },
  );

  test(
    'AC3 boundary — a VO whose only invoice is cancelled still qualifies',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const form = new InsuranceReprisePage(page);
      await form.connect();
      const vo = await form.snapshot(CANCELLED_ONLY_FIXTURE.id);
      // The AC says "non-cancelled invoice", and the payload's `invoice` is `getActiveInvoice()` —
      // it skips cancelled invoices and Stornos, so this VO reads as uninvoiced. Asserting the
      // fixture's shape here is what makes the dialog below evidence rather than a coincidence.
      expect(vo.activeInvoice, `${CANCELLED_ONLY_FIXTURE.vo} must have no live invoice`).toBeNull();
      expect(vo.cancelledInvoiceCount, 'but it must carry a cancelled one').toBeGreaterThan(0);

      await form.openVoForm(CANCELLED_ONLY_FIXTURE.id);
      await form.chooseInsurance('Privat Basis');
      const dialog = await form.repriceDialog();
      expect(dialog, 'a cancelled invoice must not freeze the prices').not.toBeNull();
      console.log(`cancelled-invoice VO ${CANCELLED_ONLY_FIXTURE.vo}: ${dialog!.message}`);
      await form.cancelReprice();
    },
  );

  for (const fixture of NO_SESSION_FIXTURES) {
    test(
      `AC4 — ${fixture.vo} has no documented session, so ${INSURANCE_LABEL[fixture.from]} → ${fixture.to} saves without a confirmation`,
      { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(180_000);
        const form = new InsuranceReprisePage(page);
        await form.connect();
        const vo = await form.snapshot(fixture.id);
        expect(vo.insuranceType, `${fixture.vo} must be ${fixture.from}`).toBe(fixture.from);
        expect(InsuranceReprisePage.pricedRows(vo), 'and must have nothing documented').toHaveLength(0);

        await form.openVoForm(fixture.id);
        await form.chooseInsurance(fixture.to);
        expect(
          await form.repriceDialog(6_000),
          'with nothing to reprice there is nothing to confirm',
        ).toBeNull();
        expect(await form.insuranceValue(), 'and the correction applies straight away').toBe(fixture.to);
      },
    );
  }

  for (const correction of OUT_OF_SCOPE_CORRECTIONS) {
    test(
      `AC6 — ${correction.why} is out of scope and raises no confirmation`,
      { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
      async ({ page }) => {
        test.setTimeout(180_000);
        const form = new InsuranceReprisePage(page);
        await form.openVoForm(correction.id);
        const before = await form.insuranceValue();
        await form.chooseInsurance(correction.to);
        expect(
          await form.repriceDialog(6_000),
          `${correction.why} keeps today's behaviour — no dialog from this ticket`,
        ).toBeNull();
        expect(await form.insuranceValue(), 'the field still takes the new value').toBe(correction.to);
        console.log(`${correction.vo}: ${before} → ${correction.to}, no confirmation (correct)`);
      },
    );
  }

  test(
    'Control — resolvedTariff is the per-session price, and the recalculator moves it on this environment today',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const api = new InsuranceReprisePage(page);
      await api.connect();

      const before = await api.snapshot(PKV_FIXTURE.id);
      const priced = InsuranceReprisePage.pricedRows(before).filter((r) => r.code === PKV_FIXTURE.treatment);
      expect(priced.length, `${PKV_FIXTURE.vo} must hold its ${PKV_FIXTURE.treatment} sessions`).toBe(
        PKV_FIXTURE.sessions,
      );
      const standing = priced[0].resolvedTariff!;

      // A cent above the standing PKV price, effective on the fixture's FIRST session date — not a
      // hardcoded one. #3378's recompute only rewrites snapshots dated on or after the entry, so a
      // fixed date silently stops covering the fixture the moment the fixture changes, and the
      // control then reports "the recalculator does not move these rows" when nothing is wrong.
      const effectiveDate = priced.map((r) => r.date).sort()[0];
      const entry = await api.repriceControl({
        code: PKV_FIXTURE.treatment,
        tariffType: 'PRIVAT',
        effectiveDate,
        price: Number((standing + 0.01).toFixed(2)),
      });
      console.log(`control entry ${entry.entryId}: repriced ${entry.created} snapshots across staging`);

      try {
        expect(entry.created, 'a retroactive price entry must reprice already-documented sessions').toBeGreaterThan(0);
        const during = await api.snapshot(PKV_FIXTURE.id);
        const moved = InsuranceReprisePage.repricedRows(before, during);
        expect(
          moved.map((r) => r.activityTreatmentId).sort(),
          "and the fixture's own rows must be among them — so this file is reading the right column",
        ).toEqual(priced.map((r) => r.activityTreatmentId).sort());
      } finally {
        const undone = await api.deletePriceEntry(entry.entryId!);
        console.log(`control entry deleted: ${undone} snapshots recomputed back`);
      }

      const after = await api.snapshot(PKV_FIXTURE.id);
      expect(
        InsuranceReprisePage.repricedRows(before, after),
        'and the fixture must be left exactly as it was found',
      ).toHaveLength(0);
    },
  );

  test(
    'Evidence — what a PKV → Privat Basis correction actually changes, end to end through the form',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new InsuranceReprisePage(page);
      await form.connect();
      const before = await form.snapshot(PKV_FIXTURE.id);
      const priced = InsuranceReprisePage.pricedRows(before);

      const expected: Record<number, number | null> = {};
      for (const row of priced) {
        expected[row.activityTreatmentId] = await form.expectedTariff(row.code, INSURANCE.PRIVAT_BASIS, row.date);
      }

      await form.openVoForm(PKV_FIXTURE.id);
      await form.chooseInsurance('Privat Basis');
      expect(await form.repriceDialog(), 'the confirmation must appear before the save').not.toBeNull();
      await form.confirmReprice();

      // "Speichern" sends nothing here — see #3340 — so the save goes through the For-Fixing route,
      // whose PATCH carries the whole form payload including the corrected insuranceType.
      const inert = await form.trySaveDirect();
      console.log(`"Speichern": validation checked=${inert.checkedValidation}, PATCH sent=${inert.patched}`);
      let saved: { status: number | null; sentInsuranceType: string | null } = {
        status: inert.patched ? 200 : null,
        sentInsuranceType: inert.patched ? INSURANCE.PRIVAT_BASIS : null,
      };
      // The direct route can succeed while its 12 s listener window misses the PATCH under load, so
      // "not patched" is a hint, not a verdict — and For-Fixing simply does not exist on a VO whose
      // checks all pass. Either way the API below is what decides whether the save landed.
      if (!inert.patched) saved = await form.saveViaForFixing();
      expect(saved.status, 'the form must have saved the correction').toBe(200);
      expect(saved.sentInsuranceType, 'and sent the corrected type').toBe(INSURANCE.PRIVAT_BASIS);

      try {
        const after = await form.snapshot(PKV_FIXTURE.id);
        expect(after.insuranceType, 'the correction itself is persisted').toBe(INSURANCE.PRIVAT_BASIS);

        const moved = InsuranceReprisePage.repricedRows(before, after);
        console.log(
          `Gesamtumsatz ${before.totalRevenue} → ${after.totalRevenue}; ` +
            `${moved.length} of ${priced.length} documented sessions repriced`,
        );
        for (const row of priced) {
          const now = after.rows.find((r) => r.activityTreatmentId === row.activityTreatmentId)!;
          console.log(
            `  ${row.date} ${row.code.padEnd(8)} PKV ${row.resolvedTariff} → now ${now.resolvedTariff}` +
              ` (Privat Basis price on that date: ${expected[row.activityTreatmentId]})`,
          );
        }
        const shouldTotal = priced.reduce((sum, r) => sum + (expected[r.activityTreatmentId] ?? 0), 0);
        console.log(`sum of the correct Privat-Basis prices for these sessions: ${shouldTotal.toFixed(2)}`);
      } finally {
        // Self-restoring: put back both fields the form save touched.
        expect(await form.setInsuranceType(PKV_FIXTURE.id, before.insuranceType!)).toBe(200);
        if (before.creationValidationStatus) {
          expect(await form.setCreationValidationStatus(PKV_FIXTURE.id, before.creationValidationStatus)).toBe(200);
        }
      }

      const restored = await form.snapshot(PKV_FIXTURE.id);
      expect(restored.insuranceType, 'the fixture is left as it was found').toBe(before.insuranceType);
      expect(restored.creationValidationStatus).toBe(before.creationValidationStatus);
      expect(InsuranceReprisePage.repricedRows(before, restored)).toHaveLength(0);
    },
  );

  test(
    'AC1 — a PKV → Privat Basis correction reprices every documented session at its own treatment date',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@Mutating'] },
    async ({ page }) => {
      // The form flow plus TWO real repricings (the correction and its restore) does not fit the
      // 90 s default — which nobody noticed while this test was `fixme`'d and never ran.
      test.setTimeout(420_000);

      // WAS `fixme`'d here as "NOT REPRICED on staging (2026-09-01)" — 0 of 3 sessions moved on
      // every route tried. Root cause found and fixed in `be7b69c53` (2026-09-02), which credits
      // this VO: the guard required both sides of the insuranceType changeset to be
      // InsuranceTypeEnum instances, but Doctrine reports an `enumType` column's changeset as its
      // BACKING STRINGS, so the condition was false on every correction and the pass was skipped
      // with no error and no log line. Both sides now normalise through toInsuranceType().
      //
      // Re-verified live 2026-09-04: all 6 rows repriced, each at its own treatment date across the
      // 2025-07-01 step — PNF 61,95 → 47,69 / 45,92 / 45,92 and HBH-PT 24,00 → 13,26 / 12,77 /
      // 12,77 — and Gesamtumsatz 224,65 → 178,33, the figure this file predicted as the correct
      // full-reprice value while the feature was broken.

      const form = new InsuranceReprisePage(page);
      await form.connect();
      const before = await form.snapshot(PKV_FIXTURE.id);
      const priced = InsuranceReprisePage.pricedRows(before);
      expect(before.insuranceType).toBe(INSURANCE.PKV);
      expect(before.activeInvoice, 'AC1 requires a VO with no non-cancelled invoice').toBeNull();
      expect(priced.length).toBe(PKV_FIXTURE.sessions * 2);

      await form.openVoForm(PKV_FIXTURE.id);
      await form.chooseInsurance('Privat Basis');
      expect(await form.repriceDialog()).not.toBeNull();
      await form.confirmReprice();
      // Which save route the form offers depends on the VO: "Speichern" is inert unless every
      // creation-validation check auto-passed (#3340), and "Zur Korrektur speichern" only renders
      // when one did not. 2805-2 passes all of them, so it has no For-Fixing button — calling it
      // unconditionally hangs. Try the direct route, fall back only if nothing was sent.
      const direct = await form.trySaveDirect();
      const saved = direct.patched ? { status: 200 } : await form.saveViaForFixing();
      expect(saved.status, `save route: ${direct.patched ? 'Speichern' : 'Zur Korrektur speichern'}`).toBe(200);

      try {
        const after = await form.snapshot(PKV_FIXTURE.id);
        for (const row of priced) {
          const expectedPrice = await form.expectedTariff(row.code, INSURANCE.PRIVAT_BASIS, row.date);
          const now = after.rows.find((r) => r.activityTreatmentId === row.activityTreatmentId)!;
          expect(
            now.resolvedTariff,
            `${row.date} ${row.code} must bill the Privat-Basis price in force on that date`,
          ).toBe(expectedPrice);
        }
      } finally {
        await form.setInsuranceType(PKV_FIXTURE.id, before.insuranceType!);
        await form.setCreationValidationStatus(PKV_FIXTURE.id, before.creationValidationStatus);
      }
    },
  );

  test(
    'AC2 — the same correction in the opposite direction reprices at the PKV rate',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(420_000);

      // WAS `fixme`'d on the same defect as AC1 (`be7b69c53`). Re-verified live 2026-09-04 on
      // 905301-2, the only privat_basis VO with a session documented natively at the Basistarif:
      // correcting it to PKV moved all 3 rows — KG 29,63 → 39,00, HBH-PT 13,09 → 24,00,
      // AB-P 1,40 → 0,00, each the PKV price at that date — and the reverse correction restored
      // every one of them, so the test is self-restoring as written.

      const form = new InsuranceReprisePage(page);
      await form.connect();
      const before = await form.snapshot(PRIVAT_BASIS_FIXTURE.id);
      const priced = InsuranceReprisePage.pricedRows(before);
      expect(before.insuranceType).toBe(INSURANCE.PRIVAT_BASIS);
      expect(before.activeInvoice).toBeNull();
      expect(priced.length).toBeGreaterThan(0);

      expect(await form.setInsuranceType(PRIVAT_BASIS_FIXTURE.id, INSURANCE.PKV)).toBe(200);
      try {
        const after = await form.snapshot(PRIVAT_BASIS_FIXTURE.id);
        for (const row of priced) {
          const expectedPrice = await form.expectedTariff(row.code, INSURANCE.PKV, row.date);
          const now = after.rows.find((r) => r.activityTreatmentId === row.activityTreatmentId)!;
          expect(now.resolvedTariff, `${row.date} ${row.code} must bill the PKV price`).toBe(expectedPrice);
        }
      } finally {
        await form.setInsuranceType(PRIVAT_BASIS_FIXTURE.id, before.insuranceType!);
      }
    },
  );

  test(
    'AC5 — the confirmation counts the sessions it will actually reprice',
    { tag: ['@SuperAdmin', '@InsuranceReprice', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        'The dialog prints `prescription.activityCount`, which is not the number of documented sessions. ' +
          'Over 30 uninvoiced PKV VOs with at least one session, 3 disagree: 4207-2 says 10 against 14 ' +
          'documented sessions (28 priced rows), 4637-2 says 12 against 6, 3187-3 says 4 against 5 (one of ' +
          'its 6 activities carries no treatment). AC1\'s fixture and 27 of the 30 agree, so this shows up ' +
          'only on VOs treated beyond their prescribed count or carrying a non-treatment activity. ' +
          'Cosmetic while AC1/AC2 do not reprice at all, but it is the number the admin is asked to ' +
          'confirm against, so it should be raised with the repricing fix rather than after it.',
      );

      const form = new InsuranceReprisePage(page);
      await form.connect();
      const vo = await form.snapshot(PKV_FIXTURE.id);
      const documented = new Set(InsuranceReprisePage.pricedRows(vo).map((r) => r.activityId)).size;

      await form.openVoForm(PKV_FIXTURE.id);
      await form.chooseInsurance('Privat Basis');
      const dialog = await form.repriceDialog();
      expect(dialog!.count, 'the count must be the documented sessions, not activityCount').toBe(documented);
      await form.cancelReprice();
    },
  );
});

/** Kept for the reader: the shape a snapshot has, so the console lines above are self-explaining. */
export type { VoSnapshot };
