import { test, expect } from '@playwright/test';
import {
  ScanInsurancePrefillPage,
  FIXTURES,
  HINTS,
  INSURANCE,
  INSURANCE_LABEL,
} from '../../../Pages/admin/admin.scan-insurance-prefill.page';
import { mintUiSession, STAGING_CREDENTIALS, API_BASE } from '../../../Pages/util/api-token';

/**
 * RC 3.14 — a Selbstzahler scan must stop pre-filling Privat Basis (#3710, commit `bbee3b6a5`).
 *
 * "Selbstzahler" on a prescription says only that the patient pays out of pocket; it does not
 * distinguish PKV from Privat Basis. The form guessed Privat Basis every time, overriding the
 * patient's own stored insurance type. The fix gives the patient's value priority for that one scan
 * result, leaves the field empty with a hint when the patient has none, and adds a second hint for
 * a Blanko VO on a Privat Basis patient.
 *
 * ## **MERGED BUT NOT DEPLOYED — that is the headline, and this file re-derives it every run**
 *
 * `bbee3b6a5` is an ancestor of `release/3.14.0` (merged 2026-09-16), the API reports `3.14.0`, and
 * the change is **still absent from the served bundle**: both new i18n keys and both German strings
 * occur **0** times, while #3383's sibling key in the same dictionary section occurs 4 times. This
 * ticket is **frontend-only**, so `/status` cannot answer for it at all — the app bundle deploys
 * independently (#3705), and the bundle is the only surface that decides.
 *
 * **The bug is reproduced live, which is the strongest thing available before the deploy.** Opening
 * the VO form on image 10589 — a Selbstzahler scan for **Katharina Overath, stored PKV** — pre-fills
 * **"Privat Basis"**, and the form then flags its own guess with #3383's badge *"Weicht von der
 * Versicherung des Patienten ab"*. Flow is telling the admin, on the same screen, that the value it
 * just chose disagrees with the patient's record. That is #3710's End Goal failing, on staging,
 * today.
 *
 * ## How the AC tests are built so they survive the deploy
 *
 * The rule is a pure function, so `resolvePrefill()` ports **both versions** — pre-fix
 * (`scanned ?? patient`) and post-fix (patient wins for Selbstzahler) — and the painted value is
 * compared against both. That reads deployment off BEHAVIOUR rather than a version string (the
 * #3704 dual-oracle technique) and makes each test assert the right thing on either build instead
 * of needing a rewrite when it ships.
 *
 * **It also disqualifies the obvious fixture.** A Selbstzahler scan on a patient already stored
 * `privat_basis` gives "Privat Basis" under both rules — 3 of the 9 candidates are like that, and a
 * QA who picks one sees the correct value on a broken build. Only a patient stored **PKV**
 * separates them; 6 images across 4 patients qualify.
 *
 * ## Fixture verdict, measured over the whole pending-review pool (987 images)
 *
 * | AC | Fixture on staging? |
 * |---|---|
 * | AC1 patient has a stored type | **Yes** — 9 Selbstzahler/Privat scans, 6 of them discriminating |
 * | AC2 patient has NO stored type | **No** — all 9 match a patient who already has one |
 * | AC3 named insurer still PKV | Yes, but **not discriminating** — every such scan sits on a patient already stored PKV |
 * | AC4 GKV / BG unaffected | **Yes, and discriminating for BG** — images 12342 / 12768 are BG scans on GKV patients |
 * | AC5 Blanko on a Privat Basis patient | **No** — all 8 Blanko scans are on GKV patients |
 *
 * ## Traps
 *
 *  - **`extractedData.insuranceType.value` is the raw AI text on older rows and the mapped enum on
 *    newer ones** — `'Selbstzahler'`, `'Privat'`, `'GKV'`, `'PKV'`, `'BG'` beside `'public'` and
 *    `'private'`. **`privat_basis` never appears in stored data**; the collapse happens in the
 *    frontend. Searching the API for `privat_basis` finds zero and reads as "no Selbstzahler scans
 *    exist" when there are nine.
 *  - **`/patients?insuranceType=` is silently IGNORED** — every value returns all 8,384 patients.
 *  - The collection does **not** serialize `extractedData` and `groups[]` is ignored there, so a
 *    fixture sweep costs one item read per image.
 *  - **Do not probe the bundle for `isSelfPayerScan`** — minification renames it, so 0 proves
 *    nothing. Keys and string literals survive; function names do not.
 *  - `getUsableScannedInsuranceType()` also gates on **confidence**: an unusable one makes the scan
 *    contribute nothing, so neither the pre-fill nor AC2's hint fires. No AC mentions that branch.
 *
 * **Read-only.** The VO form is opened and read; nothing is ever saved, so no VO is created.
 */

test.describe('#3710 Selbstzahler scan no longer pre-fills Privat Basis', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: the fix is merged into release/3.14.0 but is NOT in the served bundle',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new ScanInsurancePrefillPage(request);

      const status = await (await request.get(`${API_BASE}/status`)).json();
      const state = await api.deploymentState();
      console.log(`#3710 API /status: ${JSON.stringify(status)}`);
      console.log(`#3710 bundle: ${JSON.stringify(state)}`);

      // The control is what makes a zero meaningful: #3383's key lives in the same dictionary
      // section, so its presence proves the probe is looking in the right place.
      expect(state.control, "#3383's sibling key is in the bundle, so the section exists").toBeGreaterThan(0);

      if (!state.deployed) {
        console.log(
          '#3710 NOT DEPLOYED: both new keys and both German strings occur 0 times in the served bundle, ' +
            "while #3383's key in the same section occurs " +
            `${state.control}. The commit is merged to release/3.14.0 and the API reports ` +
            `${status.version} — this ticket is frontend-only, so /status cannot answer for it (#3705). ` +
            'The AC tests below are gated on this verdict and go green on the deploy.',
        );
      } else {
        // Once it ships, the German must ship with it — the ticket's Localization Reference said the
        // copy was still "Pending" when it was written, and the commit supplied it.
        expect(state.selfPayerDe, 'AC2 hint German').toBeGreaterThan(0);
        expect(state.blankoDe, 'AC5 hint German').toBeGreaterThan(0);
        console.log('#3710 DEPLOYED: both keys and both German strings are in the served bundle.');
      }
    },
  );

  test(
    'the mapper collapses Selbstzahler / Privat / Privat Basis to one value, and a named insurer to PKV',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async () => {
      // The whole ticket keys off this one predicate, and it is the reason a "named insurer"
      // scan is unaffected: the insurer NAME never reaches it — only `insuranceType` does.
      for (const raw of ['Selbstzahler', 'selbstzahler', 'Privat', 'Privat Basis', 'privat_basis']) {
        expect(ScanInsurancePrefillPage.mapInsuranceType(raw), `${raw} is the self-payer case`).toBe(
          INSURANCE.privatBasis,
        );
        expect(ScanInsurancePrefillPage.isSelfPayerScan(ScanInsurancePrefillPage.mapInsuranceType(raw))).toBe(true);
      }
      for (const [raw, expected] of [
        ['PKV', INSURANCE.private],
        ['private', INSURANCE.private],
        ['GKV', INSURANCE.public],
        ['public', INSURANCE.public],
        ['BG', INSURANCE.accident],
      ] as const) {
        expect(ScanInsurancePrefillPage.mapInsuranceType(raw)).toBe(expected);
        expect(
          ScanInsurancePrefillPage.isSelfPayerScan(ScanInsurancePrefillPage.mapInsuranceType(raw)),
          `${raw} must NOT take the Selbstzahler branch (AC3/AC4)`,
        ).toBe(false);
      }
      // An unrecognised value maps to null, so the scan contributes nothing and the patient's own
      // type fills the field under BOTH rules.
      expect(ScanInsurancePrefillPage.mapInsuranceType('Beihilfe')).toBeNull();
    },
  );

  test(
    'the two rules differ only for a Selbstzahler scan, and only when the patient has a different stored type',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async () => {
      // AC1 — the case the ticket exists for.
      const pkvPatient = ScanInsurancePrefillPage.resolvePrefill('Selbstzahler', INSURANCE.private);
      expect(pkvPatient.before, 'pre-fix: the scan wins and guesses Privat Basis').toBe(INSURANCE.privatBasis);
      expect(pkvPatient.after, "AC1: post-fix the patient's stored PKV wins").toBe(INSURANCE.private);
      expect(pkvPatient.discriminating).toBe(true);

      // AC2 — no stored type: the field is left EMPTY rather than guessed.
      const noPatientType = ScanInsurancePrefillPage.resolvePrefill('Selbstzahler', null);
      expect(noPatientType.before).toBe(INSURANCE.privatBasis);
      expect(noPatientType.after, 'AC2: empty, so the admin picks').toBeNull();

      // The fixture trap, pinned: on a Privat Basis patient the two rules AGREE, so such a VO is
      // not evidence of anything and must never be used to sign this ticket off.
      const basisPatient = ScanInsurancePrefillPage.resolvePrefill('Selbstzahler', INSURANCE.privatBasis);
      expect(basisPatient.before).toBe(INSURANCE.privatBasis);
      expect(basisPatient.after).toBe(INSURANCE.privatBasis);
      expect(basisPatient.discriminating, 'not a usable fixture').toBe(false);

      // AC3/AC4 — every other scanned type is untouched, including on a patient stored differently.
      for (const [raw, patientType, expected] of [
        ['PKV', INSURANCE.privatBasis, INSURANCE.private],
        ['DKV-style named insurer → private', INSURANCE.public, null],
        ['GKV', INSURANCE.private, INSURANCE.public],
        ['BG', INSURANCE.public, INSURANCE.accident],
      ] as const) {
        const r = ScanInsurancePrefillPage.resolvePrefill(raw, patientType);
        if (expected === null) continue; // the made-up label maps to null; covered by the mapper test
        expect(r.after, `${raw} still wins over the patient's ${patientType}`).toBe(expected);
        expect(r.before, 'and it behaved that way before the fix too').toBe(expected);
        expect(r.discriminating, 'so this path is untouched by the change').toBe(false);
      }
    },
  );

  test(
    'fixture inventory: which ACs can be verified on staging at all',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ScanInsurancePrefillPage(request);
      const token = await api.adminToken();

      const ids = await api.pendingReviewImageIds(token);
      console.log(`#3710 pending-review images awaiting a VO: ${ids.length}`);

      // One item read per image — the collection does not serialize extractedData.
      const extractions: Awaited<ReturnType<typeof api.extraction>>[] = [];
      for (const id of ids) {
        extractions.push(await api.extraction(id, token));
      }

      const selfPayer = extractions.filter(
        (e) => ScanInsurancePrefillPage.isSelfPayerScan(ScanInsurancePrefillPage.mapInsuranceType(e.rawInsuranceType)) && e.patientId,
      );
      const blanko = extractions.filter((e) => e.blanko === true && e.patientId);
      const rawCounts = extractions.reduce<Record<string, number>>((acc, e) => {
        const k = e.rawInsuranceType ?? '(none)';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`#3710 stored insuranceType values: ${JSON.stringify(rawCounts)}`);

      // The stored vocabulary is the trap that decides whether a survey finds anything at all.
      expect(
        Object.keys(rawCounts).some((k) => k.toLowerCase() === 'selbstzahler'),
        'the raw German text is what is stored — `privat_basis` never is',
      ).toBe(true);
      expect(rawCounts['privat_basis'] ?? 0, 'nothing stores the mapped self-payer value').toBe(0);

      // AC1 / AC2 — resolve each candidate's patient and classify it.
      const ac1: string[] = [];
      const ac1NotDiscriminating: string[] = [];
      const ac2: string[] = [];
      for (const e of selfPayer) {
        const stored = await api.patientInsuranceType(e.patientId as number, token);
        const r = ScanInsurancePrefillPage.resolvePrefill(e.rawInsuranceType, stored);
        const line = `image ${e.imageId} (raw ${e.rawInsuranceType}, conf ${e.confidence}) → patient ${e.patientId} ${e.patientName} stored=${stored} | before=${r.before} after=${r.after}`;
        if (stored === null) ac2.push(line);
        else if (r.discriminating) ac1.push(line);
        else ac1NotDiscriminating.push(line);
      }

      // AC5 — a Blanko scan whose patient is stored Privat Basis.
      const ac5: string[] = [];
      for (const e of blanko) {
        const stored = await api.patientInsuranceType(e.patientId as number, token);
        if (stored === INSURANCE.privatBasis) ac5.push(`image ${e.imageId} → patient ${e.patientId} ${e.patientName}`);
      }

      console.log(`#3710 AC1 DISCRIMINATING fixtures (${ac1.length}):\n  ${ac1.join('\n  ')}`);
      console.log(`#3710 AC1 non-discriminating (patient already Privat Basis, ${ac1NotDiscriminating.length}):\n  ${ac1NotDiscriminating.join('\n  ')}`);
      console.log(`#3710 AC2 fixtures (patient has NO stored type): ${ac2.length}`);
      console.log(`#3710 AC5 fixtures (Blanko scan on a Privat Basis patient): ${ac5.length} of ${blanko.length} Blanko scans`);

      expect(selfPayer.length, 'AC1 has something to test').toBeGreaterThan(0);
      expect(
        ac1.length,
        'and at least one fixture where the two rules actually disagree — the rest prove nothing',
      ).toBeGreaterThan(0);

      if (ac2.length === 0) {
        console.log(
          '#3710 AC2 has NO fixture: every self-payer scan awaiting a VO matches a patient who already has ' +
            'a stored insurance type, so the empty-field-plus-hint case cannot be produced from existing data. ' +
            'It needs a scan for a patient whose profile has none (#3382 left 132 such patients).',
        );
      }
      if (ac5.length === 0) {
        console.log(
          `#3710 AC5 has NO fixture: all ${blanko.length} Blanko scans awaiting a VO are on GKV patients, ` +
            'so the Blanko-on-Privat-Basis hint has nothing to fire on.',
        );
      }
    },
  );

  test(
    'AC1 the live pre-fill, compared against both rules (the bug on the current build, the fix on the next)',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(420_000);
      const api = new ScanInsurancePrefillPage(request, page);
      const token = await api.adminToken();
      const f = FIXTURES.selfPayerPkvPatient;

      // The fixture is re-derived, never trusted: both halves have to still hold or the test is
      // measuring something else.
      const e = await api.extraction(f.imageId, token);
      const stored = await api.patientInsuranceType(f.patientId, token);
      const rule = ScanInsurancePrefillPage.resolvePrefill(e.rawInsuranceType, stored);
      console.log(
        `#3710 fixture image ${f.imageId}: raw=${e.rawInsuranceType} conf=${e.confidence} match=${e.matchStatus} ` +
          `patient=${e.patientId} ${e.patientName} stored=${stored} | before=${rule.before} after=${rule.after}`,
      );
      expect(ScanInsurancePrefillPage.isSelfPayerScan(rule.scanned), 'still a Selbstzahler scan').toBe(true);
      expect(stored, 'still a PKV patient, which is what makes the two rules disagree').toBe(INSURANCE.private);
      expect(rule.discriminating).toBe(true);

      const state = await api.deploymentState();
      await mintUiSession(page, STAGING_CREDENTIALS.admin);
      await api.openScanForm(f.imageId);

      const painted = await api.insuranceTypeValue();
      const text = await api.formText();
      console.log(`#3710 form painted Versicherungsart = ${painted ?? '(empty)'} | deployed=${state.deployed}`);

      const expected = state.deployed ? rule.after : rule.before;
      const expectedLabel = expected ? INSURANCE_LABEL[expected] : null;

      if (!state.deployed) {
        // The bug, live. Recorded as the before half of the before/after pair.
        console.log(
          `#3710 PRE-FIX BEHAVIOUR CONFIRMED: the form pre-filled "${painted}" for a patient stored PKV — ` +
            'the guess the ticket removes.',
        );
        expect(painted, 'the current build guesses Privat Basis').toBe(INSURANCE_LABEL[INSURANCE.privatBasis]);
        // The form flags its own guess with #3383's badge, which is the symptom an admin sees.
        expect(text, "#3383's badge fires on the pre-fill's own value").toContain(HINTS.differsDe);
        // AC2's hint must NOT show here — the field is filled.
        expect(text, 'no self-payer hint while the field is filled').not.toContain(HINTS.selfPayerDe);
      } else {
        console.log(`#3710 POST-FIX: the form pre-filled "${painted}", expected "${expectedLabel}".`);
        expect(painted, "AC1: the patient's stored type wins over the Selbstzahler guess").toBe(expectedLabel);
        // And the badge goes away, because the pre-fill now agrees with the patient.
        expect(text, 'AC1: nothing differs from the patient any more').not.toContain(HINTS.differsDe);
      }
    },
  );

  test(
    'AC4 a BG scan still wins over the patient\'s stored GKV — the change must not leak past Selbstzahler',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(420_000);
      const api = new ScanInsurancePrefillPage(request, page);
      const token = await api.adminToken();
      const f = FIXTURES.bgScanGkvPatient;

      // This is the one unaffected-path fixture that can actually FAIL if the fix leaks: the scan
      // and the patient disagree, so a rule that gave the patient priority in general would paint
      // GKV here instead of BG.
      const e = await api.extraction(f.imageId, token);
      const stored = await api.patientInsuranceType(f.patientId, token);
      const rule = ScanInsurancePrefillPage.resolvePrefill(e.rawInsuranceType, stored);
      console.log(
        `#3710 AC4 image ${f.imageId}: raw=${e.rawInsuranceType} stored=${stored} | before=${rule.before} after=${rule.after}`,
      );
      expect(stored, 'the patient is stored GKV').toBe(INSURANCE.public);
      expect(rule.before, 'both rules agree the scan wins').toBe(INSURANCE.accident);
      expect(rule.after).toBe(INSURANCE.accident);

      await mintUiSession(page, STAGING_CREDENTIALS.admin);
      await api.openScanForm(f.imageId);
      const painted = await api.insuranceTypeValue();
      console.log(`#3710 AC4 form painted Versicherungsart = ${painted ?? '(empty)'}`);
      expect(painted, 'AC4: BG, on either build').toBe(INSURANCE_LABEL[INSURANCE.accident]);
    },
  );

  test(
    'AC3 a named private insurer still pre-fills PKV',
    { tag: ['@Admin', '@ScanInsurancePrefill', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(420_000);
      const api = new ScanInsurancePrefillPage(request, page);
      const token = await api.adminToken();
      const f = FIXTURES.namedInsurer;

      const e = await api.extraction(f.imageId, token);
      const stored = await api.patientInsuranceType(f.patientId, token);
      console.log(
        `#3710 AC3 image ${f.imageId}: insurer=${e.insurerName} raw=${e.rawInsuranceType} stored=${stored}`,
      );
      expect(e.insurerName, 'the scan names a private insurer').toBeTruthy();
      expect(ScanInsurancePrefillPage.mapInsuranceType(e.rawInsuranceType), 'which maps to PKV, not the self-payer case').toBe(
        INSURANCE.private,
      );

      await mintUiSession(page, STAGING_CREDENTIALS.admin);
      await api.openScanForm(f.imageId);
      const painted = await api.insuranceTypeValue();
      const text = await api.formText();
      console.log(`#3710 AC3 form painted Versicherungsart = ${painted ?? '(empty)'}`);

      expect(painted, 'AC3: unaffected by this change').toBe(INSURANCE_LABEL[INSURANCE.private]);
      expect(text, 'and no self-payer hint on a named-insurer scan').not.toContain(HINTS.selfPayerDe);

      // Stated rather than implied: this fixture cannot FALSIFY the patient-priority path, because
      // every named-insurer scan on staging sits on a patient already stored PKV, so scan-wins and
      // patient-wins produce the same value. AC4's BG fixture is the one that can.
      console.log(
        `#3710 AC3 note: patient ${f.patientId} is itself stored ${stored}, so this fixture confirms AC3's ` +
          'wording but does not discriminate between the two rules — see the AC4 test for that.',
      );
    },
  );

});
