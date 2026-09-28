import { test, expect } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import {
  AC2_FIXTURES,
  AREA_LABEL,
  AREA_LESS_TREATMENTS,
  AREA_TO_THERAPY_TYPE,
  Area,
  CHECK_ID,
  CHECK_KEY,
  CrossAreaHit,
  CrossAreaValidationPage,
  PASSIV_FIXTURES,
  ValidationRow,
} from '../../../Pages/admin/admin.cross-area-validation.page';

/**
 * RC 3.13 #3576 — VO creation/edit validation must flag a fee or Heilmittel whose treatment area
 * differs from the VO's own Fachbereich.
 *
 * **Read-only: every request is a GET or a `preview-creation-validation` POST**, and that endpoint
 * evaluates a TRANSIENT prescription without touching a single `PrescriptionValidation` row. That is
 * what lets AC2's nine-row truth table be driven exactly — including combinations no VO on staging
 * has — instead of hunting for fixtures and reporting the rest as untestable.
 *
 * Deployed on staging: validation **id 54**, seeded by `Version20260901142128` on the RC that
 * reached staging 2026-09-09.
 *
 * See the page object for the trap that matters most here: `TherapyType` is **`ergotherapy`**, not
 * `occupational_therapy`, and the wrong value is accepted silently — which is why the first test
 * below proves the vocabulary before any zero is believed.
 */
test.describe('#3576 cross-area fee/Heilmittel creation check', () => {
  let cross: CrossAreaValidationPage;
  let checks: ValidationRow[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await browser.newPage();
    cross = new CrossAreaValidationPage(page);
    await cross.connect(STAGING_CREDENTIALS.admin);
    checks = await cross.voCreationChecks();
  });

  test.beforeEach(async ({ page }) => {
    cross = new CrossAreaValidationPage(page);
    await cross.connect(STAGING_CREDENTIALS.admin);
  });

  // ─────────────────────────────── the vocabulary guard ───────────────────────────────

  test(
    'the therapyType vocabulary partitions — so a zero from this endpoint means something',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      test.setTimeout(180_000);
      const counts = await cross.assertTherapyTypeVocabulary();
      console.log(`#3576 therapyType vocabulary: ${JSON.stringify(counts)}`);

      for (const value of Object.values(AREA_TO_THERAPY_TYPE)) {
        expect(counts[value], `therapyType=${value} must select a real population`).toBeGreaterThan(0);
      }
      // The whole point: an unknown value is ACCEPTED and answers 0, indistinguishable from "no
      // such data". `occupational_therapy` is that: it is what `sa.cross-area-fees.page.ts` sent for
      // Ergotherapie, so every Ergo probe in the #3577 survey came back empty and the residual was
      // under-reported (5 combinations / 18 hits, against the corrected 13 / 34).
      expect(counts['occupational_therapy'], 'occupational_therapy is NOT a TherapyType value').toBe(0);
      expect(counts['definitely_not_a_therapy'], 'an unknown value is silently accepted').toBe(0);
    },
  );

  // ─────────────────────────────── AC1: the check is registered ───────────────────────────────

  test(
    'AC1 the check is registered beside the existing ones, as a warning',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      const row = checks.find((c) => CHECK_KEY === c.description);
      expect(row, `a vo_creation check named ${CHECK_KEY} must exist`).toBeTruthy();
      expect(row!.id, 'the id the panel and the results payload key on').toBe(CHECK_ID);
      // AC3 lives here as much as in behaviour: the severity is what makes it a warning rather than
      // an error, and it is stored on the check, not decided per evaluation.
      expect(row!.severity, 'AC3: a warning, not an error').toBe('warning');
      expect(row!.isAutoCheck, 'evaluated automatically, not a manual review row').toBe(true);
      expect(row!.category).toBe('remedy');
      expect(row!.sortOrder, 'it continues the vo_creation sequence').toBe(42);
      // "alongside the existing checks" — it must not have displaced any.
      expect(checks.length, 'the existing checks are all still registered').toBeGreaterThanOrEqual(21);
      expect(
        checks.filter((c) => 'warning' === c.severity).map((c) => c.description).sort(),
        'the two warning-severity creation checks',
      ).toEqual(['fee_area_matches_therapy_type', 'icd10_code_valid']);
    },
  );

  test(
    'AC1 the check is returned by the endpoint the VO form itself calls',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      // The create form posts to `preview-creation-validation`; the edit form posts to
      // `check-creation-validation`. Both run the same service, so "the panel shows the check" is
      // established by the check appearing in this payload for a normal VO shape.
      const { response, check } = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, [AC2_FIXTURES.heilmittel.PT.id]);
      expect(check, `check ${CHECK_ID} must be evaluated for a public PT VO`).toBeTruthy();
      expect(check!.isAutoCheck).toBe(true);
      expect(response.checked, 'it is one of a set of checks, not the only one').toBeGreaterThan(1);
    },
  );

  // ─────────────────────────────── AC2: the truth table ───────────────────────────────

  for (const [kindLabel, fixtures] of Object.entries(AC2_FIXTURES)) {
    test(
      `AC2 the nine-row truth table, driven on a ${kindLabel} per area`,
      { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
      async () => {
        test.setTimeout(300_000);
        const areas = Object.keys(AREA_TO_THERAPY_TYPE) as Area[];
        const table: string[] = [];

        for (const voArea of areas) {
          for (const itemArea of areas) {
            const item = (fixtures as Record<Area, { id: number; code: string }>)[itemArea];
            const { check } = await cross.checkFor(AREA_TO_THERAPY_TYPE[voArea], [item.id]);
            expect(check, `check ${CHECK_ID} must apply to a ${voArea} VO`).toBeTruthy();

            const shouldPass = voArea === itemArea;
            expect(
              check!.passed,
              `AC2: ${AREA_LABEL[voArea]} VO + ${item.code} (${AREA_LABEL[itemArea]}) must ` +
                `${shouldPass ? 'pass' : 'warn'}`,
            ).toBe(shouldPass);

            if (shouldPass) {
              expect(check!.autoNote, 'a passing check explains nothing').toBeNull();
            } else {
              // The note is compared to the ticket's own wording, rebuilt independently — a check
              // that flags the right rows but names the wrong ones is still wrong for the admin
              // who has to act on it.
              expect(check!.autoNote).toBe(
                CrossAreaValidationPage.expectedNote(voArea, [{ code: item.code, area: itemArea }]),
              );
            }
            table.push(`${AREA_LABEL[voArea]}+${item.code}=${shouldPass ? 'pass' : 'warn'}`);
          }
        }
        console.log(`#3576 AC2 (${kindLabel}): ${table.join(' | ')}`);
      },
    );
  }

  // ─────────────────────────────── AC5 and the edges ───────────────────────────────

  test(
    'AC5 a VO whose every fee and Heilmittel matches its Fachbereich warns about nothing',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      // Three PT rows of three different kinds — a Heilmittel, a one-time fee and a per-treatment
      // fee — so "no warning" is not just "nothing was looked at".
      const { check } = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, [4, 2, 14]);
      expect(check!.passed).toBe(true);
      expect(check!.autoNote).toBeNull();
    },
  );

  test(
    'every mismatched row is named, and the matching ones are left out',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      const { check } = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, [
        AC2_FIXTURES.fee.ERGO.id,
        AC2_FIXTURES.fee.SSSST.id,
        AC2_FIXTURES.fee.PT.id,
      ]);
      expect(check!.passed).toBe(false);
      expect(check!.autoNote).toBe(
        CrossAreaValidationPage.expectedNote('PT', [
          { code: AC2_FIXTURES.fee.ERGO.code, area: 'ERGO' },
          { code: AC2_FIXTURES.fee.SSSST.code, area: 'SSSST' },
        ]),
      );
      expect(check!.autoNote, 'the correctly-aread fee must not be listed').not.toContain(AC2_FIXTURES.fee.PT.code);
    },
  );

  test(
    'passiv rows are in scope in both directions',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      // The implementation deliberately covers EVERY PrescribedTreatment rather than only
      // TreatmentKind::TREATMENT as the sibling remedy checks do, because the ticket says "fee or
      // Heilmittel". `passiv` (#3603's manually-attachable assessments) is the kind most easily
      // missed by a `kind === 'treatment'` filter, so it is pinned here.
      const onPt = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, [PASSIV_FIXTURES.ERGO.id]);
      expect(onPt.check!.passed).toBe(false);
      expect(onPt.check!.autoNote).toContain(`${PASSIV_FIXTURES.ERGO.code} (${AREA_LABEL.ERGO})`);

      const onErgo = await cross.checkFor(AREA_TO_THERAPY_TYPE.ERGO, [PASSIV_FIXTURES.PT.id]);
      expect(onErgo.check!.passed).toBe(false);
      expect(onErgo.check!.autoNote).toContain(`${PASSIV_FIXTURES.PT.code} (${AREA_LABEL.PT})`);
    },
  );

  test(
    'a catalogue row with no area, and a VO with no Fachbereich, are not mismatches',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      // Staging's catalogue holds two area-less rows. Treating "unknown" as "different" would flag
      // every VO carrying one, which is not evidence of anything — the check passes them silently
      // and that decision is asserted rather than left to chance.
      const catalogue = await cross.treatments();
      const areaLess = catalogue.filter((t) => null === t.area);
      expect(areaLess.length, 'the area-less rows this case is about').toBeGreaterThan(0);

      for (const row of AREA_LESS_TREATMENTS) {
        expect(catalogue.find((t) => t.id === row.id)?.area, `${row.code} still has no area`).toBeNull();
        const { check } = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, [row.id]);
        expect(check!.passed, `${row.code} carries no area, so it cannot mismatch`).toBe(true);
      }

      // A VO with no Fachbereich yet — the state a half-filled create form is in — cannot mismatch.
      const noType = await cross.checkFor(null, [AC2_FIXTURES.fee.SSSST.id]);
      expect(noType.check!.passed, 'no therapyType, no mismatch').toBe(true);

      const noRows = await cross.checkFor(AREA_TO_THERAPY_TYPE.PT, []);
      expect(noRows.check!.passed, 'nothing prescribed, nothing to mismatch').toBe(true);
    },
  );

  test(
    'the catalogue has exactly the three areas the check compares',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      // The Developer Reference worried about specialty sub-areas (PT_ZAE, ET_NUT, PO) and asked for
      // a decision on whether they roll up to a parent area. They live in
      // `remedy_catalog.therapyArea`, a different column; `treatment.area` — the one the check reads
      // — has three values and no sub-areas, so there is no decision to make. Pinned so a future
      // sub-area in this column shows up as a failure here rather than as silent passes.
      const catalogue = await cross.treatments();
      const areas = [...new Set(catalogue.map((t) => t.area).filter((a): a is Area => null !== a))].sort();
      expect(areas).toEqual(['ERGO', 'PT', 'SSSST']);
      console.log(
        `#3576 catalogue: ${catalogue.length} rows — ` +
          areas.map((a) => `${a} ${catalogue.filter((t) => a === t.area).length}`).join(', ') +
          `, no area ${catalogue.filter((t) => null === t.area).length}`,
      );
    },
  );

  // ─────────────────────────────── against real data ───────────────────────────────

  test.describe('the live population', () => {
    let hits: CrossAreaHit[];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(900_000);
      const page = await browser.newPage();
      const survey = new CrossAreaValidationPage(page);
      await survey.connect();
      hits = await survey.crossAreaHits();
      await page.close();
    });

    test(
      'the check fires on the VOs that actually carry a cross-area row today',
      { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
      async () => {
        test.setTimeout(600_000);
        const byVo = new Map<number, CrossAreaHit[]>();
        for (const hit of hits) {
          byVo.set(hit.prescriptionId, [...(byVo.get(hit.prescriptionId) ?? []), hit]);
        }
        console.log(
          `#3576 live population: ${byVo.size} VOs, ${hits.length} offending rows — ` +
            `by VO Fachbereich ${JSON.stringify(count(hits.map((h) => h.voArea)))}, ` +
            `by kind ${JSON.stringify(count(hits.map((h) => h.kind ?? '?')))}, ` +
            `imported ${hits.filter((h) => true === h.imported).length}`,
        );
        expect(byVo.size, 'there must be real VOs for this to mean anything').toBeGreaterThan(0);

        // Every VO Fachbereich is represented — which is the check being exercised in all three
        // directions on real data, not only in the synthetic table above.
        expect(
          [...new Set(hits.map((h) => h.voArea))].sort(),
          'the live population spans all three Fachbereiche',
        ).toEqual(['ERGO', 'PT', 'SSSST']);

        // Re-evaluate a spread of them through the very endpoint the form uses, rebuilding each
        // payload from the VO's OWN Fachbereich and prescribed rows.
        const sample = [...byVo.keys()].slice(0, 8);
        for (const prescriptionId of sample) {
          const shape = await cross.voShape(prescriptionId);
          expect(shape.therapyType, `VO ${shape.vo} must carry a Fachbereich`).toBeTruthy();
          expect(shape.treatmentIds.length, `VO ${shape.vo} must have prescribed rows`).toBeGreaterThan(0);

          const { check } = await cross.checkFor(
            shape.therapyType,
            shape.treatmentIds,
            shape.insuranceType ?? 'public',
          );
          if (null === check) {
            // The one insurance type the check is not applicable to — see the finding.
            console.log(`  VO ${shape.vo}: check not applicable (insuranceType ${shape.insuranceType})`);
            continue;
          }
          expect(check.passed, `VO ${shape.vo} (${shape.codes.join(', ')}) must warn`).toBe(false);
          for (const offending of byVo.get(prescriptionId)!) {
            expect(check.autoNote, `VO ${shape.vo}'s note must name ${offending.code}`).toContain(offending.code);
          }
          console.log(`  VO ${shape.vo} [${shape.therapyType}] → ${check.autoNote}`);
        }
      },
    );

    test(
      'no VO carries a stored verdict for this check yet',
      { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
      async () => {
        // The check shipped after every stored verdict on staging was written, and a verdict is only
        // persisted when a VO is saved or re-checked through the form. So the whole affected
        // population currently shows the check as un-evaluated — which is the state a QA opening one
        // of these VOs will find, and the reason AC1 has to be verified through the endpoint rather
        // than by looking for existing amber rows.
        const ids = [...new Set(hits.map((h) => h.prescriptionId))].slice(0, 10);
        let withStored = 0;
        let withThisCheck = 0;
        for (const id of ids) {
          const verdicts = await cross.storedVerdicts(id);
          if (verdicts.size > 0) withStored += 1;
          if (verdicts.has(CHECK_ID)) withThisCheck += 1;
        }
        console.log(
          `#3576 stored verdicts across ${ids.length} affected VOs: ${withStored} have verdicts at all, ` +
            `${withThisCheck} carry check ${CHECK_ID}`,
        );
        expect(withStored, 'these VOs have been validated before').toBeGreaterThan(0);
        expect(withThisCheck, 'but never against the new check').toBe(0);
      },
    );
  });

  // ─────────────────────────────── findings ───────────────────────────────

  test(
    'FINDING — the check does not apply to a Privat Basis VO',
    { tag: ['@Admin', '@CrossAreaValidation', '@ReadOnly'] },
    async () => {
      test.setTimeout(180_000);
      // #3608 (`Version20260903140041`) gave EVERY check that applies to PKV the `privat_basis`
      // insurance type, "so the two types always evaluate the same set — mirrored by data rather
      // than a hard-coded list, so it stays 'same as PKV' on every environment". #3576's row was
      // seeded two days earlier and is the ONE check that did not get it.
      const withPrivate = checks.filter((c) => c.applicableInsuranceTypes.includes('private'));
      const missing = withPrivate.filter((c) => !c.applicableInsuranceTypes.includes('privat_basis'));
      console.log(
        `#3576: ${withPrivate.length} vo_creation checks apply to PKV; ` +
          `${missing.length} of them do not apply to Privat Basis: ${missing.map((c) => `${c.id} ${c.description}`).join(', ')}`,
      );

      // The behavioural half, live: the same VO shape that warns under public/private/accident is
      // not even evaluated under privat_basis.
      const shape: [string, number[]] = [AREA_TO_THERAPY_TYPE.PT, [AC2_FIXTURES.fee.SSSST.id]];
      for (const insuranceType of ['public', 'private', 'accident']) {
        const { check } = await cross.checkFor(shape[0], shape[1], insuranceType);
        expect(check, `insuranceType=${insuranceType} must evaluate the check`).toBeTruthy();
        expect(check!.passed, `and it must warn under ${insuranceType}`).toBe(false);
      }
      const basis = await cross.checkFor(shape[0], shape[1], 'privat_basis');
      expect(
        basis.check,
        'a Privat Basis VO can carry a Logopädie fee on a Physiotherapie VO and never be told',
      ).toBeNull();
      expect(basis.response.checked, 'other checks DO run for Privat Basis, so this is not an empty set').toBeGreaterThan(0);
    },
  );
});
