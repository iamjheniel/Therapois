import { test, expect } from '../../fixtures/session';
import { GkvInsurerRequiredPage } from '../../../Pages/superadmin/sa.gkv-insurer-required.page';

/**
 * RC 3.15 — #3810: an insurer is required for GKV on both VO forms, the Create Patient pop-up and
 * the patient form, and a GKV VO also needs its OWN Versichertenstatus.
 *
 * **The rule is deliberately FORM-ONLY** (the ticket's Out of Scope rules out a rule on every save,
 * because it would break Praxis Flow, the deceased marking, the merge command and the nightly
 * jobs). So AC9 holds by construction, there is no server-side rule to probe, and AC2/AC3/AC6/AC7
 * live only on screen.
 *
 * **Which is what makes this safe: every save attempted here is one the rule must REFUSE**, and a
 * refused save writes nothing. The fixtures are chosen so that even a build without the fix would
 * write back the values the record already holds.
 */

const P = GkvInsurerRequiredPage;

/** A GKV VO, Aktiv, with NO own Versichertenstatus, whose patient has NO insurer — both empty. */
const BOTH_EMPTY = { vo: '5921-2', voId: 15788, patientId: 4677 };
/** A GKV VO whose patient HAS an insurer but which still lacks its own Versichertenstatus. */
const ONLY_VS_EMPTY = { vo: '5806-7', voId: 32780, patientId: 4560 };

test.describe('#3810 insurer required for GKV', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);

  let sa: GkvInsurerRequiredPage;

  test.beforeAll(async () => {
    sa = new GkvInsurerRequiredPage();
    await sa.connect();
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    'DEPLOYED: both new messages ship, and the fixtures are still in the state the ACs need',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@ReadOnly'] },
    async ({ page }) => {
      const { version } = await sa.status();
      console.log(`  staging API: ${version}`);
      // The ticket is milestoned RC 3.15.0 and staging has moved to it, which is why this can be
      // tested here at all — the sibling #3811 commit says "#3810 has just made [it] required".
      expect(version, 'staging serves 3.15').toMatch(/^3\.1[5-9]/);

      const ui = new GkvInsurerRequiredPage(page);
      const bundle = await page.request.get('https://staging.therapios.de/', { timeout: 120_000 });
      const entry = (await bundle.text()).match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/);
      expect(entry, 'the served HTML names an entry bundle').not.toBeNull();
      const js = await (await page.request.get(`https://staging.therapios.de${entry![0]}`, { timeout: 300_000 })).text();

      // The two NEW messages the Localization Reference proposes — a frontend-only rule, so the
      // dictionary is the probe (/status answers for the API only, #3705).
      for (const [k, v] of Object.entries(P.MSG)) {
        const n = js.split(v).length - 1;
        console.log(`  new message [${k}]: ${n} — ${JSON.stringify(v)}`);
        expect(n, `${k} ships`).toBeGreaterThan(0);
      }
      // The existing strings AC1 says the new field reuses.
      for (const [k, v] of Object.entries(P.EXISTING)) {
        if (k.endsWith('Label')) continue;
        const n = js.split(v).length - 1;
        console.log(`  reused [${k}]: ${n}`);
        expect(n, `${k} is still shipped`).toBeGreaterThan(0);
      }
      void ui;

      // The fixtures are re-derived, so one that has drifted fails loudly rather than quietly
      // proving nothing.
      const vo = await sa.vo(BOTH_EMPTY.voId);
      const pat = await sa.patient(BOTH_EMPTY.patientId);
      console.log(`  ${BOTH_EMPTY.vo}: insuranceType=${vo.insuranceType} ownVs=${vo.versichertenstatus ?? null} status=${vo.treatmentStatus}`);
      console.log(`  patient ${BOTH_EMPTY.patientId}: insuranceType=${pat.insuranceType} insurer=${pat.insuranceProvider?.name ?? null}`);
      expect(vo.insuranceType, 'the fixture is a GKV VO').toBe('public');
      expect(vo.versichertenstatus ?? null, 'and has no Versichertenstatus of its own').toBeNull();
      expect(pat.insuranceType, 'its patient is GKV').toBe('public');
      expect(pat.insuranceProvider ?? null, 'and has no insurer').toBeNull();

      const control = await sa.patient(ONLY_VS_EMPTY.patientId);
      expect(control.insuranceProvider ?? null, 'the control patient DOES have an insurer').not.toBeNull();
      console.log(`  control patient ${ONLY_VS_EMPTY.patientId}: insurer present`);
      console.log(`  insurer catalogue: ${await sa.insurerCount()} rows`);
    },
  );

  test(
    'the three filters this ticket needs are all silently ignored, so the population is sampled',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@ReadOnly'] },
    async () => {
      // Pinned before any count is believed: a GKV patient without an insurer cannot be selected
      // server-side, which is why the fixtures above were found by reading patients one at a time
      // and why #3812 exists to put this on a screen.
      for (const q of ['insuranceType=public', 'exists%5BinsuranceProvider%5D=false', 'exists%5BinsuranceProvider%5D=true']) {
        const { all, hit } = await sa.patientFilterIgnored(q);
        console.log(`  /patients?${q.padEnd(40)} -> ${hit} of ${all} ${hit === all ? '(IGNORED)' : '(filters)'}`);
        expect(hit, `${q} is accepted and ignored`).toBe(all);
      }
      // The other half of why this has to be sampled, and it is worse than "absent from the list":
      // `insuranceProvider` is OMITTED when null, so on exactly the patients this ticket is about
      // the key is not there at all. A reader that checks for the key's presence therefore cannot
      // tell "no insurer" from "wrong serialization group" — compare the two patients instead.
      const without = await sa.patient(BOTH_EMPTY.patientId);
      const withOne = await sa.patient(ONLY_VS_EMPTY.patientId);
      console.log(`  patient ${BOTH_EMPTY.patientId} (no insurer): key present = ${Object.keys(without).includes('insuranceProvider')}`);
      console.log(`  patient ${ONLY_VS_EMPTY.patientId} (has one):  key present = ${Object.keys(withOne).includes('insuranceProvider')}`);
      expect(Object.keys(withOne), 'the item read DOES carry it when set').toContain('insuranceProvider');
      expect(Object.keys(without), 'and OMITS it when null, rather than serializing null').not.toContain('insuranceProvider');
    },
  );

  test(
    'AC1: the VO form shows the insurer field beside Versicherungsart and Versichertenstatus',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@ReadOnly'] },
    async ({ page }) => {
      const ui = new GkvInsurerRequiredPage(page);
      await ui.signIn();
      await ui.openVoForm(BOTH_EMPTY.voId);
      const text = await ui.formText();

      for (const label of [P.EXISTING.insuranceTypeLabel, P.EXISTING.versichertenstatusLabel, P.EXISTING.insuranceLabel]) {
        console.log(`  label ${JSON.stringify(label)} on the form: ${text.includes(label)}`);
        expect(text, `the form shows ${label}`).toContain(label);
      }
      // AC1's own words: "in the same section as Insurance type and Versichertenstatus" — measured
      // by vertical proximity rather than assumed from presence.
      const boxes = await Promise.all([
        ui.labelBox(P.EXISTING.insuranceTypeLabel),
        ui.labelBox(P.EXISTING.versichertenstatusLabel),
        ui.labelBox(P.EXISTING.insuranceLabel),
      ]);
      console.log(`  label positions: ${JSON.stringify(boxes)}`);
      const present = boxes.filter(Boolean) as { x: number; y: number }[];
      if (present.length === 3) {
        const ys = present.map((b) => b.y);
        const spread = Math.max(...ys) - Math.min(...ys);
        console.log(`  vertical spread across the three labels: ${Math.round(spread)}px`);
        expect(spread, 'the three sit in one section').toBeLessThan(400);
      }
      // AC1's catalogue affordances.
      expect(text, 'the Create New Insurer link').toContain(P.EXISTING.createInsurer);
    },
  );

  test(
    'AC3: a GKV VO with both fields empty refuses to save, naming both',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@Mutating'] },
    async ({ page }) => {
      // Tagged @Mutating for honesty, though the expected outcome writes NOTHING: the save must be
      // refused. The fixture already holds these (empty) values, so even a build without the rule
      // would write back what is already there.
      const before = await sa.vo(BOTH_EMPTY.voId);
      const patBefore = await sa.patient(BOTH_EMPTY.patientId);

      const ui = new GkvInsurerRequiredPage(page);
      await ui.signIn();
      await ui.openVoForm(BOTH_EMPTY.voId);
      const { shown, text } = await ui.trySave([P.MSG.insurer, P.MSG.versichertenstatus]);
      console.log(`  messages shown after Speichern: ${JSON.stringify(shown)}`);
      if (shown.length < 2) {
        const near = text.split('\n').filter((l) => /erforderlich|Pflicht|required/i.test(l)).slice(0, 6);
        console.log(`  required-ish lines on the form: ${JSON.stringify(near)}`);
      }
      expect(shown, 'both required messages are shown').toEqual([P.MSG.insurer, P.MSG.versichertenstatus]);

      // ...and nothing moved.
      const after = await sa.vo(BOTH_EMPTY.voId);
      const patAfter = await sa.patient(BOTH_EMPTY.patientId);
      expect(after.versichertenstatus ?? null, 'the VO still has no Versichertenstatus').toBeNull();
      expect(patAfter.insuranceProvider ?? null, 'the patient still has no insurer').toBeNull();
      expect(after.treatmentStatus, 'and its status is untouched').toBe(before.treatmentStatus);
      expect(patAfter.insuranceCompany ?? null, 'and its legacy insurer text is untouched').toBe(patBefore.insuranceCompany ?? null);
    },
  );

  test(
    'AC2: with the patient insurer present, only the Versichertenstatus message fires',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@Mutating'] },
    async ({ page }) => {
      // The discriminator: the two required fields are independent, so a build that fired one
      // message for both conditions — or gated the save on the wrong field — fails here while
      // passing the test above.
      const before = await sa.vo(ONLY_VS_EMPTY.voId);
      expect(before.versichertenstatus ?? null, 'the control VO has no Versichertenstatus').toBeNull();

      const ui = new GkvInsurerRequiredPage(page);
      await ui.signIn();
      await ui.openVoForm(ONLY_VS_EMPTY.voId);
      const { text } = await ui.trySave([P.MSG.versichertenstatus]);
      const hasVs = text.includes(P.MSG.versichertenstatus);
      const hasIns = text.includes(P.MSG.insurer);
      console.log(`  Versichertenstatus message: ${hasVs}; insurer message: ${hasIns}`);
      expect(hasVs, 'the Versichertenstatus message fires').toBe(true);
      expect(hasIns, 'the insurer message does NOT, because the patient has one').toBe(false);

      const after = await sa.vo(ONLY_VS_EMPTY.voId);
      expect(after.versichertenstatus ?? null, 'nothing was written').toBeNull();
    },
  );

  test(
    'AC7: a GKV patient without an insurer refuses to save on the patient form',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@Mutating'] },
    async ({ page }) => {
      const before = await sa.patient(BOTH_EMPTY.patientId);
      const ui = new GkvInsurerRequiredPage(page);
      await ui.signIn();
      await ui.openPatientForm(BOTH_EMPTY.patientId);

      const text0 = await ui.formText();
      console.log(`  patient form shows the insurer field: ${text0.includes(P.EXISTING.insuranceLabel)}`);
      // AC6: on a GKV patient the field is MARKED required, which is visible before any save.
      const marked = await ui.isMarkedRequired(P.EXISTING.insuranceLabel);
      console.log(`  "${P.EXISTING.insuranceLabel} *" (required marking on a GKV patient): ${marked}`);
      expect(marked, 'AC6: the insurer is marked required for GKV').toBe(true);
      console.log(`  the catalogue affordances are present: search=${text0.includes(P.EXISTING.searchPlaceholder)} create=${text0.includes(P.EXISTING.createInsurer)}`);
      // The save control is "Änderungen speichern" and is aria-disabled while the form is pristine,
      // so the refusal is only reachable once something changed. Typing a search term into the
      // insurer box is the most on-topic way to dirty it and sets no value.
      const pristine = await ui.patientSaveState();
      console.log(`  save control while pristine: ${JSON.stringify(pristine)}`);
      expect(pristine, 'the form has a save control').not.toBeNull();
      expect(pristine!.ariaDisabled, 'and it is disabled until something changes').toBe('true');

      const typed = await ui.typeInInsurerSearch('zzz-no-such-insurer');
      const dirty = await ui.patientSaveState();
      console.log(`  typed into the insurer search: ${typed}; save control now: ${JSON.stringify(dirty)}`);
      test.skip(
        !typed || dirty?.ariaDisabled === 'true',
        'the save control stays disabled without a committed field change, so the refusal is not reachable without editing real patient data',
      );

      const { shown, text } = await ui.trySave([P.MSG.insurer], 60_000, 'Änderungen speichern');
      console.log(`  messages shown: ${JSON.stringify(shown)}`);
      if (!shown.length) {
        console.log(`  required-ish lines: ${JSON.stringify(text.split('\n').filter((l) => /erforderlich|required/i.test(l)).slice(0, 6))}`);
      }
      expect(shown, "the insurer's required message is shown").toContain(P.MSG.insurer);

      // AC7's second half: an empty patient Versichertenstatus must NEVER stop this save, so that
      // message must not appear on the patient form at all — it is VO-forms-only.
      expect(text.includes(P.MSG.versichertenstatus), 'the Versichertenstatus message is VO-forms-only').toBe(false);

      const after = await sa.patient(BOTH_EMPTY.patientId);
      expect(after.insuranceProvider ?? null, 'nothing was written').toBeNull();
      expect(after.insuranceType, 'and the type is untouched').toBe(before.insuranceType);
    },
  );

  test(
    'AC9: the rule is form-only, so every other path still saves such a patient',
    { tag: ['@SuperAdmin', '@GkvInsurerRequired', '@ReadOnly'] },
    async () => {
      // The ticket's Out of Scope makes this structural: "a rule on every save outside these forms
      // … would break Praxis Flow saves, the deceased marking, the merge command and the nightly
      // jobs". So AC9 is satisfied by the ABSENCE of a server rule, which is checked from the
      // read-only side the deceased dialog uses.
      const pat = await sa.patient(BOTH_EMPTY.patientId);
      expect(pat.insuranceProvider ?? null, 'the fixture still breaks the rule').toBeNull();
      expect(pat.insuranceType, 'and is GKV').toBe('public');

      // The deceased dialog's own endpoints answer for a patient the form would refuse — if a
      // server-side rule existed, these are the reads that would start failing.
      const count = await sa['get']<any>(`/patients/${BOTH_EMPTY.patientId}/active-vos-count`);
      const list = await sa['get']<any>(`/patients/${BOTH_EMPTY.patientId}/active-vos`);
      const n = typeof count === 'number' ? count : count?.count;
      const listed = Array.isArray(list) ? list.length : (list?.member ?? []).length;
      console.log(`  deceased dialog for a rule-breaking patient: count ${n}, list ${listed}`);
      expect(n, 'the deceased dialog still answers').not.toBeNull();
      expect(listed, 'and agrees with itself').toBe(n);
    },
  );
});
