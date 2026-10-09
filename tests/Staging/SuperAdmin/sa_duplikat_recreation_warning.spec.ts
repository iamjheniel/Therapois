import { test, expect } from '../../fixtures/session';
import {
  DUPLIKAT,
  DuplikatProcessPage,
  FIXTURES,
} from '../../../Pages/superadmin/sa.duplikat-process.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.13 #3506 — creating a VO that re-creates one already open in the Duplikat process must warn
 * (PR #3557).
 *
 * The bug it fixes is precise, and it is why the existing check never fired: `DuplicateVoCheckProvider`
 * required the SAME issue date, ICD code and diagnosis group, and a VO re-created from memory (or
 * from a duplicate the practice re-issued) differs in exactly those fields. `DuplikatReCreationMatcher`
 * adds a second, relaxed pass that ignores all three: same patient, same prescriber (doctor by LANR
 * or the same practice), at least one shared Heilmittel, and the candidate still in
 * `DuplikatStatusEnum::open()`.
 *
 * **The whole check is a GET.** `/prescriptions/duplicate-check` is the request the VO form issues
 * while someone types, so every match rule below is verified without creating a VO — the only write
 * this file makes is putting its own fixture into the process and dismissing it again.
 *
 * Fixture owned here: `RECREATION` (VO 6218-4), so this file never collides with the two other
 * Duplikat specs.
 */
test.describe('#3506 — VO re-creation warning for VOs in the Duplikat process', () => {
  test.describe.configure({ mode: 'serial' });

  const F = FIXTURES.RECREATION;
  /** Any date other than the fixture's own issue date: the field the old strict check keyed on. */
  const A_DIFFERENT_ISSUE_DATE = '2026-09-01';

  let duplikat: DuplikatProcessPage;

  test.beforeEach(async ({ page }) => {
    duplikat = new DuplikatProcessPage(page);
    await duplikat.connect();
  });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const setup = new DuplikatProcessPage(page);
    await setup.connect();
    await setup.enterProcess(F.id, DUPLIKAT.ANFORDERN);
    await setup.waitForWorklistRow(F.id, DUPLIKAT.ANFORDERN);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    const cleanup = new DuplikatProcessPage(page);
    await cleanup.connect();
    await cleanup.dismiss(F.id);
    await page.close();
  });

  test(
    'AC1/AC4 a VO with a different issue date now warns, naming the existing VO and its status',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@Mutating'] },
    async () => {
      const matches = await duplikat.duplicateCheck({
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: A_DIFFERENT_ISSUE_DATE,
      });

      const match = matches.find((m) => m.prescriptionId === F.vo);
      expect(match, `the open Duplikat VO ${F.vo} must be reported`).toBeTruthy();
      // The new match type is what tells the form to label the row "VO im Duplikat-Prozess" instead
      // of "Exakte Übereinstimmung", and the status is the new column beside it.
      expect(match!.matchType).toBe('duplikat');
      expect(match!.duplikatStatus).toBe(DUPLIKAT.ANFORDERN);
      expect(match!.id).toBe(F.id);

      // AC4 needs no separate case: a follow-up VO is the same patient, prescriber and Heilmittel at
      // a LATER date, and the matcher ignores the date by design — which is what the call above is.
      const asFollowUp = await duplikat.duplicateCheck({
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: new Date().toISOString().slice(0, 10),
      });
      expect(asFollowUp.map((m) => m.prescriptionId), 'a follow-up must warn too').toContain(F.vo);
    },
  );

  test(
    'the relaxed rule needs a shared Heilmittel and the same prescriber, and nothing else',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@Mutating'] },
    async () => {
      const base = {
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: A_DIFFERENT_ISSUE_DATE,
      };

      // No shared code → no match, however well everything else lines up.
      const noSharedCode = await duplikat.duplicateCheck({ ...base, treatmentCodes: 'MLD45' });
      expect(noSharedCode.map((m) => m.prescriptionId)).not.toContain(F.vo);

      // A different doctor AND a different practice → no match. Both arms have to miss:
      // `samePrescriber()` accepts either the LANR or the practice, and requires both practices to be
      // non-null precisely because `PracticeIdentityComparator` calls two nulls compatible.
      const otherPrescriber = await duplikat.duplicateCheck({
        ...base,
        doctor: FIXTURES.FAR.doctorId,
        practice: FIXTURES.FAR.practiceId,
      });
      expect(otherPrescriber.map((m) => m.prescriptionId)).not.toContain(F.vo);

      // The same practice with a different doctor DOES match — the practice arm on its own.
      const samePracticeOtherDoctor = await duplikat.duplicateCheck({
        ...base,
        doctor: FIXTURES.FAR.doctorId,
      });
      expect(
        samePracticeOtherDoctor.map((m) => m.prescriptionId),
        'the practice arm matches on its own',
      ).toContain(F.vo);
    },
  );

  test(
    'the relaxed pass runs on creation only, so editing a sibling VO does not re-warn',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@Mutating'] },
    async () => {
      // `currentId` is what the form sends when it is EDITING a VO. Without this gate every open of
      // a sibling VO of the same patient would raise the warning about its own family.
      const editing = await duplikat.duplicateCheck({
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: A_DIFFERENT_ISSUE_DATE,
        currentId: 99_999_999,
      });
      expect(
        editing.filter((m) => 'duplikat' === m.matchType),
        'no relaxed match while editing',
      ).toHaveLength(0);
    },
  );

  test(
    'a VO that has left the process stops warning',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@Mutating'] },
    async () => {
      // The matcher's candidate set is `DuplikatStatusEnum::open()`, so the two dismissals and the
      // billed status all stop the warning. PR #3557 flags that reading of "any status except
      // Billed" for the PM; it is the same reading #3503 applied to the identical phrase, and it is
      // what the ACs' "already in the Duplikat process" means in practice.
      const query = {
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: A_DIFFERENT_ISSUE_DATE,
      };
      expect(
        (await duplikat.duplicateCheck(query)).map((m) => m.prescriptionId),
        'precondition: the VO is open in the process',
      ).toContain(F.vo);

      for (const dismissal of [DUPLIKAT.ORIGINAL_LIEGT_VOR, DUPLIKAT.NICHT_MOEGLICH]) {
        await duplikat.setStatusOk(F.id, dismissal);
        expect(
          (await duplikat.duplicateCheck(query)).filter((m) => 'duplikat' === m.matchType),
          `"${dismissal}" must stop the warning`,
        ).toHaveLength(0);
      }

      await duplikat.setStatusOk(F.id, DUPLIKAT.ANFORDERN);
    },
  );

  test(
    'AC1/AC5 the warning row reuses the existing dialog, with one new column and one new label',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@ReadOnly'] },
    async ({ page }) => {
      // AC5 asks for the SAME visual treatment as the existing duplicate warning, and the change is
      // exactly that: `DuplicateVoMatchTable` was lifted out of `VoForm` unchanged and gained a
      // "Duplikat-Status" column plus the "VO im Duplikat-Prozess" match label. Both strings are
      // checked in the DEPLOYED dictionary, and both keys are checked to be referenced by the served
      // bundle — a translated string nothing reads is not shipped behaviour (#3337).
      const translations = new TranslationsPage(page);
      const { de } = await translations.loadDictionaries();
      expect(de['vo_management.form.duplicate_col_duplikat_status']).toBe('Duplikat-Status');
      expect(de['vo_management.form.match_type_duplikat']).toBe('VO im Duplikat-Prozess');
      expect(
        await translations.referenced('duplicate_col_duplikat_status'),
        'the new column head must be read by the bundle',
      ).toBe(true);
      expect(await translations.referenced('match_type_duplikat')).toBe(true);
    },
  );

  test(
    'the check is a read — a warning never creates or blocks anything by itself',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@Mutating'] },
    async () => {
      // Worth pinning because the ACs talk about a warning "before the new VO can be saved": the
      // gate is the form's own acknowledge/dismiss step, and the endpoint behind it is a plain
      // GetCollection that leaves the matched VO exactly as it was.
      const before = await duplikat.vo(F.id);
      await duplikat.duplicateCheck({
        patient: F.patientId,
        doctor: F.doctorId,
        practice: F.practiceId,
        treatmentCodes: F.code,
        issueDate: A_DIFFERENT_ISSUE_DATE,
      });
      const after = await duplikat.vo(F.id);
      expect(after.duplikatStatus).toBe(before.duplikatStatus);
      expect(after.duplikatStatusChangedAt).toBe(before.duplikatStatusChangedAt);
      expect(await duplikat.logCount(F.id)).toBe((await duplikat.logs(F.id)).length);
    },
  );

  test(
    'the endpoint stays admin-only',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@RecreationWarning', '@ReadOnly'] },
    async ({ page }) => {
      const therapist = await duplikat.tokenFor(STAGING_CREDENTIALS.therapist);
      const res = await page.request.get(
        'https://api.staging.therapios.de/prescriptions/duplicate-check' +
          `?patient=${F.patientId}&doctor=${F.doctorId}&treatmentCodes=${F.code}&issueDate=${A_DIFFERENT_ISSUE_DATE}`,
        { headers: { Authorization: `Bearer ${therapist}` }, timeout: 60_000 },
      );
      expect(res.status(), 'duplicate-check is ROLE_ADMIN').toBe(403);
    },
  );

  // ───────────────────────────────── what cannot be reached here ─────────────────────────────────

});
