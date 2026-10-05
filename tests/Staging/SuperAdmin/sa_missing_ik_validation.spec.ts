import { test, expect } from '@playwright/test';
import {
  MissingIkValidationPage,
  Vo,
  Entity,
  MESSAGE_KEYS,
  GERMAN_SINGLE,
  GERMAN_SINGLE_CLAUSE,
  GERMAN_BULK,
  ENGLISH_SINGLE,
  ENGLISH_BULK,
  ESCAPING_CONTROL,
  SUBMITTED_INSURANCE_TYPES,
} from '../../../Pages/superadmin/sa.missing-ik-validation.page';

/**
 * RC 3.15 #3822 — billing validation is refused, with a message, when the VO's Gesellschaft
 * has no IK number for its therapy type. Commit `23089bebf` (`Ref #3822`, no PR) ships both
 * halves; `0eae51982` (4 Oct) follows up on the one FAIL the PM recorded on 3 Oct.
 *
 * **Every write this file makes is one the fix must REFUSE**, so a passing run changes
 * nothing: the check runs before the flush, and AC3 makes the bulk path all-or-nothing, so
 * even the has-IK control VO riding along in a batch is left untouched. The POSITIVE paths
 * (AC4, AC5) create a submission and a copayment invoice and are therefore read from the
 * PM's own footprint instead of being re-run.
 */

const FIXTURES = {
  /** GKV, speech therapy, Curano Berlin-Brandenburg 2 (no Logopädie IK), NOT validated. */
  REFUSED: { id: 35438, number: '99969-1' },
  /** BG (accident) at the same Gesellschaft — AC1's second insurance type. */
  REFUSED_BG: { id: 35433, number: '99964-1' },
  /** A DIFFERENT Gesellschaft and therapy type — proves the message is built from the VO. */
  REFUSED_OTHER: { id: 35658, number: '100302-1' },
  /** GKV, unvalidated, at a Gesellschaft that HAS the IK — the bulk discriminator. */
  HAS_IK: { id: 6619, number: '4363-2' },
  /** Validated GKV whose Gesellschaft has the IK — AC5 bullet 1. */
  VALIDATED_WITH_IK: { id: 35437, number: '99968-1' },
  /** Speech-therapy VO with a PHYSIOTHERAPY therapist — AC1's resolution rule. */
  CROSS_THERAPY: { id: 35436, number: '99967-1' },
  /** PKV and Privat Basis at the missing-IK Gesellschaft — AC5 bullet 2. */
  PKV: { id: 35434, number: '99965-1' },
  PRIVAT_BASIS: { id: 35435, number: '99966-1' },
  /** The other statuses at the missing-IK Gesellschaft — AC5 bullet 3. */
  FOR_FIXING: { id: 35430, number: '99961-1' },
  CANNOT_VALIDATE: { id: 35432, number: '99963-1' },
  /** AC4: the IK was saved, then the VO validated and joined a submission. */
  IK_SAVED_THEN_VALIDATED: { id: 35439, number: '99970-1' },
  /** The one PRE-fix stuck VO — Out of Scope here, #3821's subject. */
  PRE_FIX_STUCK: { id: 34219, number: '965112-2' },
} as const;

/** The fix reached staging between the commit (25 Sep) and the PM's refused run (2 Oct 23:3x UTC). */
const DEPLOY_NOT_BEFORE = '2026-09-25T00:00:00Z';

test.describe('#3822 billing validation refused when the Gesellschaft has no IK', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  let p: MissingIkValidationPage;
  let entities: Map<number, Entity>;
  let validated: Vo[];
  let fixtures: Map<string, Vo>;

  test.beforeAll(async ({ playwright }) => {
    // `test.setTimeout()` in the describe body does NOT reach a beforeAll (#3375) — it has to
    // be called INSIDE the hook, or the 2,020-row walk below dies at the 90 s default and
    // every test reports "did not run".
    test.setTimeout(1_200_000);
    const request = await playwright.request.newContext();
    p = new MissingIkValidationPage(request);
    entities = await p.entities();
    fixtures = await p.byNumber(Object.values(FIXTURES).map((f) => f.number));
    validated = await p.validatedSubmittable();
    console.log(
      `[#3822] ${entities.size} Gesellschaften, ${fixtures.size}/${Object.keys(FIXTURES).length} fixtures, ` +
        `${validated.length} validated GKV/BG VOs`,
    );
  });

  test('DEPLOYED — both halves of `23089bebf`, with the escaping control', async () => {
    // The app half: the two keys, both locales' strings, and the keys REFERENCED by the code
    // (a translated string nothing reads is not shipped behaviour, #3337).
    for (const key of MESSAGE_KEYS) {
      const n = await p.escapedOccurrences(key);
      console.log(`[#3822]   ${key}: ${n.total}`);
      expect(n.total, `${key} referenced in the served bundle`).toBeGreaterThan(0);
    }
    for (const literal of [GERMAN_SINGLE, GERMAN_BULK, ENGLISH_SINGLE, ENGLISH_BULK]) {
      expect((await p.escapedOccurrences(literal)).total, `shipped: ${literal}`).toBeGreaterThan(0);
    }

    // THE ESCAPING CONTROL. The German clause is plain=0 / escaped=1 — a plain grep returns
    // zero and reads exactly like "never shipped". Prove the helper finds a German literal
    // this ticket does not touch, or every zero below is for the wrong reason.
    const clause = await p.escapedOccurrences(GERMAN_SINGLE_CLAUSE);
    console.log(`[#3822]   "${GERMAN_SINGLE_CLAUSE}": plain=${clause.plain} escaped=${clause.escaped}`);
    expect(clause.plain, 'the German clause is escaped in the bundle, not plain').toBe(0);
    expect(clause.escaped).toBeGreaterThan(0);
    expect((await p.escapedOccurrences(ESCAPING_CONTROL)).total, 'escaping control').toBeGreaterThan(0);

    // The client reads `missingIk` off the body, NOT the type URI — a probe on
    // `/errors/missing-ik` finds 0 and reads as not-deployed.
    expect((await p.escapedOccurrences('missingIk')).total).toBeGreaterThan(0);

    // The API half: the brand-new error resource, reachable only through a refused write.
    const refusal = await p.patchValidationStatus(FIXTURES.REFUSED.id, 'validated');
    expect(refusal.status, 'PATCH validationStatus=validated on a missing-IK GKV VO').toBe(422);
    expect(refusal.body['@type']).toBe('MissingIkException');
    expect(refusal.body.type).toBe('/errors/missing-ik');
    expect(refusal.body.title).toBe('Missing IK number');
    expect(refusal.body.status).toBe(422);
  });

  test('the port of getMissingIk() agrees with the API own ikNumber on every validated VO', async () => {
    // `ikNumber` IS `PrescriptionPresenter::getIkNumber()`, the value the check tests, and it
    // is OMITTED when null — so for a GKV/BG VO with an entity and a therapy type,
    // "no ikNumber" must be exactly "the port refuses it". Validating the port this way is
    // what licenses using it over the whole book below.
    let agree = 0;
    const disagreements: string[] = [];
    let refusedByPort = 0;
    for (const vo of validated) {
      if (!vo.entity?.id || !p.resolvedTherapyType(vo)) continue; // deliberately out of scope
      const missing = p.missingIk(vo, entities);
      if (missing) refusedByPort += 1;
      if ((vo.ikNumber == null) === (missing !== null)) agree += 1;
      else disagreements.push(`${vo.prescriptionId} served=${vo.ikNumber} port=${JSON.stringify(missing)}`);
    }
    console.log(`[#3822] port vs served ikNumber: ${agree} agree, ${disagreements.length} disagree`);
    if (disagreements.length) console.log(`[#3822]   ${disagreements.slice(0, 5).join('\n[#3822]   ')}`);
    expect(disagreements, 'the port must reproduce getIkNumber() exactly').toEqual([]);
    expect(agree, 'a meaningful population').toBeGreaterThan(500);
    // Anti-vacuity: both outcomes must occur, or "agrees" is satisfied by one of them alone.
    expect(refusedByPort, 'the port must refuse at least one real VO').toBeGreaterThan(0);
    expect(agree - refusedByPort, 'and allow most of them').toBeGreaterThan(0);
  });

  test('AC1 row 1 + AC2 — the single-VO save is refused and writes NOTHING', async () => {
    const { id, number } = FIXTURES.REFUSED;
    const vo = fixtures.get(number)!;
    // The fixture must still be in the state the ticket is about, or the refusal is vacuous.
    expect(vo.insuranceType, `${number} is GKV`).toBe('public');
    expect(vo.validationStatus ?? null, `${number} is not already validated`).not.toBe('validated');
    expect(p.missingIk(vo, entities), `${number} has no IK for its therapy type`).not.toBeNull();

    const before = await p.billingState(id);
    const refusal = await p.patchValidationStatus(id, 'validated');
    const after = await p.billingState(id);

    expect(refusal.status).toBe(422);
    // AC2 bullet 1 — the body carries the Gesellschaft and the therapy type, so the client
    // can render the German message. The SERVER detail is English by design; the German
    // comes from `billing.missing_ik.single` (asserted in the deployment test).
    expect(p.refusedNumbers(refusal)).toEqual([number]);
    const row = (refusal.body.missingIk as { entity: string; therapyType: string }[])[0];
    expect(row.entity).toBe(vo.entity?.name);
    expect(row.therapyType).toBe(p.resolvedTherapyType(vo));
    expect(String(refusal.body.detail)).toContain(row.entity);
    expect(String(refusal.body.detail)).toContain('Speech therapy');
    console.log(`[#3822] AC2 refusal: ${refusal.body.detail}`);

    // AC2 bullets 2 and 3 — status unchanged, no submission, no copayment invoice, and
    // `updatedAt` not even touched, so the refusal happened before any flush.
    expect(after.validationStatus, 'validation status unchanged').toBe(before.validationStatus);
    expect(after.updatedAt, 'nothing was written').toBe(before.updatedAt);
    expect(after.submissions, 'no submission').toBe(0);
    expect(after.invoices, 'no copayment invoice').toBe(0);
    expect(after.logs, 'no new change-log entry').toBe(before.logs);
    console.log(`[#3822] AC2 after refusal: ${JSON.stringify(after)}`);

    // A SECOND fixture at a different Gesellschaft and a different therapy type. Without it
    // a message naming one hardcoded pair would pass the assertions above.
    const other = fixtures.get(FIXTURES.REFUSED_OTHER.number)!;
    expect(other.entity?.name, 'a different Gesellschaft').not.toBe(vo.entity?.name);
    expect(p.resolvedTherapyType(other), 'and a different therapy type').not.toBe(p.resolvedTherapyType(vo));
    const otherRefusal = await p.patchValidationStatus(FIXTURES.REFUSED_OTHER.id, 'validated');
    expect(otherRefusal.status).toBe(422);
    const otherRow = (otherRefusal.body.missingIk as { entity: string; therapyType: string }[])[0];
    expect(otherRow.entity).toBe(other.entity?.name);
    expect(otherRow.therapyType).toBe(p.resolvedTherapyType(other));
    expect(String(otherRefusal.body.detail)).toContain('Physiotherapy');
    expect(await p.submissionCount(FIXTURES.REFUSED_OTHER.id)).toBe(0);
    console.log(`[#3822] AC2 second refusal: ${otherRefusal.body.detail}`);
  });

  test('AC1 — both insurance types the check covers, and the refusal is role-independent', async () => {
    // AC1 names GKV and BG. The BG fixture is in a different treatment status, which the
    // check deliberately does not read — so it exercises the insurance arm on its own.
    const bg = fixtures.get(FIXTURES.REFUSED_BG.number)!;
    expect(bg.insuranceType, 'the BG fixture').toBe('accident');
    expect(p.missingIk(bg, entities)).not.toBeNull();
    const bgRefusal = await p.patchValidationStatus(FIXTURES.REFUSED_BG.id, 'validated');
    expect(bgRefusal.status, 'BG is refused exactly like GKV').toBe(422);
    expect(p.refusedNumbers(bgRefusal)).toEqual([FIXTURES.REFUSED_BG.number]);

    // The PM recorded AC1 row 3 FAILING for a regular Admin. That was the CLIENT stripping
    // the status out of the payload — the server refuses a regular Admin identically, which
    // is what makes the follow-up fix a one-line client change.
    const asAdmin = await p.patchValidationStatus(FIXTURES.REFUSED.id, 'validated', 'admin');
    expect(asAdmin.status, 'a regular Admin gets the same refusal, not a 403').toBe(422);
    expect(p.refusedNumbers(asAdmin)).toEqual([FIXTURES.REFUSED.number]);
    const adminBulk = await p.bulkValidationStatus(
      [FIXTURES.REFUSED.id, FIXTURES.HAS_IK.id],
      'validated',
      'admin',
    );
    expect(adminBulk.status, 'and on the bulk path too').toBe(422);
  });

  test('AC3 — one missing IK refuses the WHOLE bulk, and only it is listed', async () => {
    const missing = fixtures.get(FIXTURES.REFUSED.number)!;
    const control = fixtures.get(FIXTURES.HAS_IK.number)!;

    // The control must be a VO the bulk WOULD have validated: GKV, not yet validated, and
    // holding an IK. Without that, "it was not validated" proves nothing.
    expect(control.insuranceType).toBe('public');
    expect(control.validationStatus ?? null, 'the control is unvalidated').not.toBe('validated');
    expect(control.ikNumber, 'the control HAS an IK').toBeTruthy();
    expect(p.missingIk(control, entities), 'so the port does not refuse it').toBeNull();
    expect(p.missingIk(missing, entities)).not.toBeNull();

    const beforeControl = await p.billingState(FIXTURES.HAS_IK.id);
    const beforeMissing = await p.billingState(FIXTURES.REFUSED.id);
    const refusal = await p.bulkValidationStatus([FIXTURES.REFUSED.id, FIXTURES.HAS_IK.id], 'validated');
    const afterControl = await p.billingState(FIXTURES.HAS_IK.id);
    const afterMissing = await p.billingState(FIXTURES.REFUSED.id);

    expect(refusal.status).toBe(422);
    expect(String(refusal.body.detail)).toContain('No VOs were validated.');
    // The discriminator: the has-IK VO is NOT named.
    expect(p.refusedNumbers(refusal)).toEqual([FIXTURES.REFUSED.number]);
    expect(String(refusal.body.detail)).not.toContain(FIXTURES.HAS_IK.number);
    console.log(`[#3822] AC3 bulk refusal: ${refusal.body.detail}`);

    // "none of the selected VOs is validated" — including the one that could have been.
    expect(afterControl.validationStatus, 'the has-IK control was NOT validated').not.toBe('validated');
    expect(afterControl.updatedAt, 'and was not touched at all').toBe(beforeControl.updatedAt);
    expect(afterControl.submissions).toBe(beforeControl.submissions);
    expect(afterControl.invoices).toBe(beforeControl.invoices);
    expect(afterMissing.updatedAt).toBe(beforeMissing.updatedAt);
  });

  test('AC1 — the therapy type is the THERAPIST department, else the VO own', async () => {
    // The rule is `therapist.therapyDepartment ?? vo.therapyType`, and the API's own
    // `ikNumber` shows which one it resolved — so this needs no write.
    const cross = fixtures.get(FIXTURES.CROSS_THERAPY.number)!;
    expect(cross.therapyType, 'a SPEECH-therapy VO').toBe('speech_therapy');
    expect(cross.therapist?.therapyDepartment, 'with a PHYSIOTHERAPY therapist').toBe('physiotherapy');
    const entity = entities.get(cross.entity!.id!)!;
    expect(entity.ikSpeechtherapy ?? null, 'whose Gesellschaft has NO Logopädie IK').toBeFalsy();
    expect(entity.ikPhysiotherapy, 'but DOES have a Physiotherapie IK').toBeTruthy();
    // So a rule reading the VO's own therapy type would have refused it; the shipped rule
    // resolved the therapist's department and let it through to the physiotherapy IK.
    expect(cross.ikNumber, 'resolved to the PHYSIOTHERAPIE IK').toBe(entity.ikPhysiotherapy);
    expect(p.missingIk(cross, entities), 'and the port agrees').toBeNull();
    expect(cross.validationStatus).toBe('validated');
    expect(await p.submissionCount(FIXTURES.CROSS_THERAPY.id), 'and it joined a submission').toBeGreaterThan(0);

    // At scale, over every validated VO whose two therapy types differ.
    const differing = validated.filter(
      (v) => v.therapist?.therapyDepartment && v.therapyType && v.therapist.therapyDepartment !== v.therapyType,
    );
    const byDepartment = differing.filter((v) => {
      const e = entities.get(v.entity?.id ?? -1);
      const col = v.therapist!.therapyDepartment === 'physiotherapy' ? e?.ikPhysiotherapy
        : v.therapist!.therapyDepartment === 'ergotherapy' ? e?.ikErgotherapy : e?.ikSpeechtherapy;
      return v.ikNumber === col;
    });
    console.log(`[#3822] therapist dept != VO therapyType: ${differing.length}, resolved by DEPARTMENT: ${byDepartment.length}`);
    expect(differing.length, 'the rule must actually be exercised').toBeGreaterThan(0);
    expect(byDepartment.length, 'every one resolves by the therapist department').toBe(differing.length);

    // COVERAGE GAP, measured rather than assumed: the rule is only ever exercised in the
    // ALLOWED direction. Its mirror — a therapist whose department has NO IK on a VO whose
    // own therapy type DOES, which a rule reading the VO's type would wrongly let through —
    // has no staging fixture at all (0 of the 1,261 unvalidated GKV Fertig Behandelt VOs).
    const refusedByDepartmentOnly = validated.filter((v) => {
      const dept = v.therapist?.therapyDepartment;
      const own = v.therapyType;
      if (!dept || !own || dept === own) return false;
      const e = entities.get(v.entity?.id ?? -1);
      const ikOf = (t: string) => (t === 'physiotherapy' ? e?.ikPhysiotherapy : t === 'ergotherapy' ? e?.ikErgotherapy : e?.ikSpeechtherapy);
      return !ikOf(dept) && !!ikOf(own);
    });
    console.log(
      `[#3822] COVERAGE: the refused direction (therapist dept missing an IK the VO own type has) ` +
        `has ${refusedByDepartmentOnly.length} instances — reported, not asserted`,
    );
  });

  test('AC5 — PKV, Privat Basis and the other statuses need no IK', async () => {
    // Bullet 2: the SAME Gesellschaft and therapy type, so the only difference is the
    // insurance type — which is exactly the gate the check opens with.
    for (const f of [FIXTURES.PKV, FIXTURES.PRIVAT_BASIS]) {
      const vo = fixtures.get(f.number)!;
      expect(SUBMITTED_INSURANCE_TYPES).not.toContain(vo.insuranceType as never);
      expect(vo.ikNumber ?? null, `${f.number} has no IK`).toBeFalsy();
      expect(p.missingIk(vo, entities), 'and is not refused').toBeNull();
      expect(vo.validationStatus, `${f.number} is validated anyway`).toBe('validated');
      expect(await p.submissionCount(f.id), 'and joins no submission, as always').toBe(0);
      expect((await p.invoices(f.id)).length, 'but does get its PKV invoice').toBeGreaterThan(0);
    }

    // Bullet 3: the refusal is gated on the TARGET status being `validated`, so the three
    // other outcomes work with no IK. Both live at the missing-IK Gesellschaft.
    for (const f of [FIXTURES.FOR_FIXING, FIXTURES.CANNOT_VALIDATE]) {
      const vo = fixtures.get(f.number)!;
      expect(p.missingIk(vo, entities), `${f.number} has no IK`).not.toBeNull();
      expect(['for_fixing', 'cannot_validate']).toContain(vo.validationStatus);
      expect(await p.submissionCount(f.id)).toBe(0);
    }

    // Bullet 1: a GKV VO whose Gesellschaft HAS the IK validates and joins a submission.
    const withIk = fixtures.get(FIXTURES.VALIDATED_WITH_IK.number)!;
    expect(withIk.insuranceType).toBe('public');
    expect(withIk.ikNumber).toBeTruthy();
    expect(withIk.validationStatus).toBe('validated');
    expect(await p.submissionCount(FIXTURES.VALIDATED_WITH_IK.id)).toBeGreaterThan(0);
  });

  test('AC4 — the IK saved, then the VO validated and joined its submission', async () => {
    // Saving an IK and validating creates a submission and a copayment invoice, so this is
    // read from the footprint the PM's 3 Oct run left rather than re-run.
    const vo = fixtures.get(FIXTURES.IK_SAVED_THEN_VALIDATED.number)!;
    expect(vo.insuranceType).toBe('public');
    expect(p.resolvedTherapyType(vo)).toBe('ergotherapy');
    const entity = entities.get(vo.entity!.id!)!;
    expect(entity.ikErgotherapy, 'the Ergotherapie IK is now saved on the Gesellschaft').toBeTruthy();
    expect(vo.ikNumber, 'and the VO resolves to it').toBe(entity.ikErgotherapy);
    expect(p.missingIk(vo, entities), 'so it is no longer refused').toBeNull();
    expect(vo.validationStatus).toBe('validated');
    const submissions = await p.submissionIds(FIXTURES.IK_SAVED_THEN_VALIDATED.id);
    expect(submissions.length, 'it joined a submission').toBeGreaterThan(0);
    const invoices = await p.invoices(FIXTURES.IK_SAVED_THEN_VALIDATED.id);
    expect(invoices.length, 'and got its copayment invoice').toBeGreaterThan(0);
    console.log(
      `[#3822] AC4 ${vo.prescriptionId}: IK ${vo.ikNumber}, submission(s) ${submissions.join(',')}, ` +
        `invoice(s) ${invoices.map((i) => i.invoiceNumber).join(',')}`,
    );
  });

  test('END GOAL — no GKV or BG VO has been validated without an IK since the fix', async () => {
    // This is the invariant the ticket exists to enforce, over the whole book rather than a
    // fixture — and it is readable because `ikNumber` is served.
    const stuck = validated.filter((v) => p.missingIk(v, entities));
    console.log(`[#3822] validated GKV/BG VOs with NO IK: ${stuck.length} of ${validated.length}`);
    for (const v of stuck) {
      const m = p.missingIk(v, entities)!;
      console.log(`[#3822]   ${v.prescriptionId} ${m.entity} / ${m.therapyType} updated=${v.updatedAt}`);
    }

    // Out of Scope: "VOs already validated without a submission" are left alone, so this is
    // a PARTITION at the fix, not a count of zero (#3651/#3709's rule).
    for (const v of stuck) {
      const logs = await p.logs(v.id);
      const validatedAt = logs
        .filter((l) => String(l.type).includes('validation') && String(l.newValue) === 'validated')
        .map((l) => String(l.createdAt))
        .sort()
        .pop();
      expect(validatedAt, `${v.prescriptionId} must carry a validation entry`).toBeTruthy();
      expect(
        validatedAt! < DEPLOY_NOT_BEFORE,
        `${v.prescriptionId} was validated at ${validatedAt} — a POST-fix VO must never be here`,
      ).toBe(true);
      console.log(`[#3822]   ${v.prescriptionId} was validated ${validatedAt} (pre-fix, Out of Scope)`);
    }
  });

  test('the stuck population is #3821 subject, and only one of it is this ticket fault', async () => {
    // The sibling correction ticket's population is "validated GKV/BG in no submission".
    // Splitting it on the missing-IK predicate separates the two causes exactly.
    const unbatched = validated.filter((v) => (v.billingBatchCount ?? 0) === 0);
    const missingIk = unbatched.filter((v) => p.missingIk(v, entities));
    const other = unbatched.filter((v) => !p.missingIk(v, entities));
    console.log(`[#3822] validated GKV/BG in NO submission: ${unbatched.length} — missing-IK ${missingIk.length}, has-IK ${other.length}`);
    for (const v of other) {
      console.log(`[#3822]   has IK ${v.ikNumber} but no submission: ${v.prescriptionId} (${v.entity?.name}) — #3821's second cause`);
    }
    expect(unbatched.length, 'the #3821 population is non-empty').toBeGreaterThan(0);
    // Every VO this ticket could ever have caused must be pre-fix; everything else is the
    // second, unexplained cause reported on #3821.
    expect(missingIk.map((v) => v.prescriptionId)).toContain(FIXTURES.PRE_FIX_STUCK.number);
    expect(other.length, 'VOs stuck for a reason this ticket does not address').toBeGreaterThan(0);
  });

  test('the regular-Admin edit-form FAIL the PM reported has since been fixed', async () => {
    // The PM's 3 Oct run recorded AC-1 row 3 and AC-2 bullet 1 FAILING for a regular Admin:
    // the edit form stripped the payload to an admin whitelist keyed on the NEW validation
    // status, so the status never reached the server, no refusal could be shown, and the save
    // reported success. `0eae51982` (4 Oct) keys the strip on the STORED status instead.
    const bundle = await p.bundle();
    const whitelist = /\[['"]therapist['"],['"]doctor['"],['"]elderlyCareHome['"],['"]followupStatus['"],['"]followupPrescription['"]\]/.exec(bundle);
    expect(whitelist, 'the admin whitelist is in the served bundle').toBeTruthy();
    const before = bundle.slice(Math.max(0, whitelist!.index - 220), whitelist!.index);
    console.log(`[#3822] guard: ...${before.slice(-150)}`);
    // Post-fix the guard reads an OPTIONAL-CHAINED property of a variable that is not the
    // callback's own argument — `prescriptionData?.validationStatus`. Pre-fix it read
    // `values.validationStatus`, with no `?.` because the parameter is never optional.
    expect(before, 'the strip is keyed on the STORED validation status').toMatch(
      /'validated'===[A-Za-z_$][\w$]*\?\.validationStatus/,
    );
    // And the edit form renders the missing-IK message instead of the generic save error.
    expect((await p.escapedOccurrences('missingIkMessage')).total).toBeGreaterThan(0);
  });
});
