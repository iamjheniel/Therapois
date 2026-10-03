import { test, expect } from '@playwright/test';
import {
  PracticeWriteRolesPage,
  DENIAL,
  ABSENT_ID,
  REPRO_PRACTICE,
} from '../../../Pages/superadmin/sa.practice-write-roles.page';

/**
 * RC 3.15 #3869 — "Practices: Only Admins Can Create or Change a Practice"
 * (fix `ff7f527bf`).
 *
 * Deleting a practice and editing its BSNRs already needed Admin; creating or changing
 * one needed only a login, so a therapist token was accepted. The exposure is concrete
 * rather than theoretical: `Practice::setPracticeId()` renumbers the main `PracticeBsnr`
 * row and removes others holding that number, so a therapist PATCH of `practiceId`
 * reached exactly the rows the BSNR endpoints protect.
 *
 * **Deployed; all four ACs verified, 7 passed, 0 `fixme`.**
 *
 * **VERIFIED AS A MATRIX OF STATUS CODES, NEVER BY WRITING.** Every probe is one of:
 *   - refused, which by definition writes nothing — and a refusal that ever stops being
 *     one IS the vulnerability this ticket closes;
 *   - aimed at an id matching nothing, so there is nothing to write even when
 *     authorization passes;
 *   - an empty merge-patch whose no-change is asserted by a full body diff.
 *
 * No practice is created, renamed, renumbered or deleted. That is also why the admin
 * legs look indirect: showing "an admin may still save" by actually saving would mutate
 * a real practice, so the proof is that authorization lets the admin reach a handler
 * (404 on an absent id; 200 with a byte-identical body on an empty patch). The ticket's
 * AC3 — that the practice form and the CRM notes still save — is a UI claim the PM
 * verified by saving; it is recorded in the manual-test notes rather than driven here.
 *
 * **Run at `--workers=1`:** three tokens per run, and #3462 throttles `/auth` at 5/min
 * per username.
 */

test.describe('#3869 only admins may create or change a practice', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let api: PracticeWriteRolesPage;

  test.beforeEach(async ({ request }) => {
    api = new PracticeWriteRolesPage(request);
  });

  test(
    'the three tokens carry the three roles this ticket distinguishes',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // AC1's table separates Admin from Super Admin, so a run that used one account for
      // both would leave half the table unexercised. ROLE_SUPER_ADMIN inherits ROLE_ADMIN
      // in security.yaml, so `is_granted('ROLE_ADMIN')` is expected to cover both — which
      // is a claim about the hierarchy, and these two tokens are what test it.
      const therapist = await api.rolesOf('therapist');
      const admin = await api.rolesOf('admin');
      const superadmin = await api.rolesOf('superadmin');

      expect(therapist).toContain('ROLE_THERAPIST');
      expect(therapist, 'the therapist must NOT already be an admin, or every leg is vacuous').not.toContain('ROLE_ADMIN');
      expect(admin).toContain('ROLE_ADMIN');
      expect(admin, 'a plain admin, not a super admin').not.toContain('ROLE_SUPER_ADMIN');
      expect(superadmin).toContain('ROLE_SUPER_ADMIN');

      console.log(
        `[#3869] therapist ${JSON.stringify(therapist)} | admin ${JSON.stringify(admin)} | ` +
          `super admin ${JSON.stringify(superadmin)}`,
      );
    },
  );

  test(
    'AC1 — create and change are refused for a therapist and reach the handler for both admin roles',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // The deployment probe and the AC are the same reading: before the fix this PATCH
      // answered 200 for a therapist, so 403-vs-200 are disjoint outcomes.
      const createByTherapist = await api.call('therapist', 'POST', '/practices', {});
      PracticeWriteRolesPage.expectRefused(createByTherapist, DENIAL.create, 'therapist create');

      const changeByTherapist = await api.call('therapist', 'PATCH', `/practices/${REPRO_PRACTICE.id}`, {});
      PracticeWriteRolesPage.expectRefused(changeByTherapist, DENIAL.change, 'therapist change');

      // Delete was already Admin-only and must stay so (AC1's "unchanged" row).
      const deleteByTherapist = await api.call('therapist', 'DELETE', `/practices/${ABSENT_ID}`);
      PracticeWriteRolesPage.expectRefused(deleteByTherapist, DENIAL.delete, 'therapist delete');
      expect(
        deleteByTherapist.status,
        'the gate answers before the row is looked up, so an absent id is still 403',
      ).toBe(403);

      // Both admin roles: the absent id is what makes "allowed" checkable without writing.
      for (const role of ['admin', 'superadmin'] as const) {
        const create = await api.call(role, 'POST', '/practices', {});
        PracticeWriteRolesPage.expectAllowedThrough(create, `${role} create`);
        expect(create.status, `${role} create reached VALIDATION, so nothing was written`).toBe(422);

        const change = await api.call(role, 'PATCH', `/practices/${ABSENT_ID}`, {});
        PracticeWriteRolesPage.expectAllowedThrough(change, `${role} change`);
        expect(change.status, `${role} change reached the lookup, which found nothing`).toBe(404);

        const remove = await api.call(role, 'DELETE', `/practices/${ABSENT_ID}`);
        PracticeWriteRolesPage.expectAllowedThrough(remove, `${role} delete`);
        expect(remove.status, `${role} delete reached the lookup, which found nothing`).toBe(404);

        console.log(`[#3869] ${role}: create ${create.status}, change ${change.status}, delete ${remove.status}`);
      }
    },
  );

  test(
    'AC1 — the BSNR rows and the practice list keep the rules they already had',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // "Add, edit or remove a BSNR: refused (unchanged)". Their refusal is Symfony's
      // generic one, which is exactly what makes it distinguishable from the new rule.
      for (const [method, path] of [
        ['POST', '/practice_bsnrs'],
        ['PATCH', `/practice_bsnrs/${ABSENT_ID}`],
        ['DELETE', `/practice_bsnrs/${ABSENT_ID}`],
      ] as const) {
        const probe = await api.call('therapist', method, path, method === 'DELETE' ? undefined : {});
        PracticeWriteRolesPage.expectRefused(probe, DENIAL.generic, `therapist ${method} ${path}`);
      }

      // "See the practice list and a practice's details: allowed (unchanged)" — for every
      // role, which is the clause a blunt resource-level lock would have broken.
      for (const role of ['therapist', 'admin', 'superadmin'] as const) {
        const list = await api.call(role, 'GET', '/practices?itemsPerPage=1');
        const detail = await api.call(role, 'GET', `/practices/${REPRO_PRACTICE.id}`);
        expect(list.status, `${role} may list practices`).toBe(200);
        expect(detail.status, `${role} may read a practice`).toBe(200);
      }

      console.log('[#3869] BSNR writes still refused generically; reads still open to every role');
    },
  );

  test(
    "AC2 — a refused change answers like the refused delete and leaves the practice byte-identical",
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      const before = await api.practice('admin', REPRO_PRACTICE.id);
      expect((before as { practiceId: string }).practiceId, "the ticket's own fixture").toBe(
        REPRO_PRACTICE.practiceId,
      );

      // The ticket's Steps to Reproduce, field by field — each sent at its CURRENT value,
      // so even a build whose gate had failed would write nothing. The status is the
      // assertion; the diff below is the safety net.
      const attempts: Record<string, number> = {};
      for (const [label, body] of [
        ['notes', { notes: (before as { notes?: string }).notes ?? null }],
        // The concrete exposure: setPracticeId() renumbers the main BSNR row and removes
        // others holding the number, so this is the field that reaches admin-only rows.
        ['practiceId', { practiceId: (before as { practiceId: string }).practiceId }],
        ['name', { name: (before as { name: string }).name }],
      ] as const) {
        const probe = await api.call('therapist', 'PATCH', `/practices/${REPRO_PRACTICE.id}`, body);
        PracticeWriteRolesPage.expectRefused(probe, DENIAL.change, `therapist change ${label}`);
        attempts[label] = probe.status;
      }

      // AC2's own words: "the practice stays exactly as it was".
      const after = await api.practice('admin', REPRO_PRACTICE.id);
      expect(after, 'the practice is unchanged after every refused attempt').toEqual(before);

      // ...and the refusal names no caller, which an access-denied reply should not.
      const sample = await api.call('therapist', 'PATCH', `/practices/${REPRO_PRACTICE.id}`, {});
      for (const leak of ['jhenqa', 'therapist', 'ROLE_']) {
        expect(sample.message, `the refusal must not name the caller (${leak})`).not.toContain(leak);
      }

      console.log(
        `[#3869] AC2: notes/practiceId/name all ${JSON.stringify(attempts)}, practice ` +
          `${REPRO_PRACTICE.practiceId} byte-identical before and after; refusal = "${sample.message}"`,
      );
    },
  );

  test(
    'AC3 — an admin still reaches the save path, and an empty change writes nothing',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // The closest to AC3 that writes nothing: the admin's PATCH reaches the handler and
      // returns 200 on a real practice, with the whole body unchanged. It shows the gate
      // passes and the write path is live; it does NOT show a field-changing save, which
      // would mutate a real practice and is covered in the manual notes instead.
      const before = await api.practice('admin', REPRO_PRACTICE.id);
      const count = await api.totalPractices('admin');

      for (const role of ['admin', 'superadmin'] as const) {
        const probe = await api.call(role, 'PATCH', `/practices/${REPRO_PRACTICE.id}`, {});
        expect(probe.status, `${role}: the empty change is accepted`).toBe(200);
      }

      const after = await api.practice('admin', REPRO_PRACTICE.id);
      expect(after, 'an empty merge-patch changed nothing').toEqual(before);
      expect(await api.totalPractices('admin'), 'and created nothing').toBe(count);

      console.log(`[#3869] AC3: admin and super admin PATCH {} -> 200, practice unchanged, still ${count} practices`);
    },
  );

  test(
    'AC4 — every read a therapist needs behind a practice picker still works',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // AC4 says "the Practice field in the VO form", a screen therapists cannot open on
      // the web (the VO form is admin-only by route). What a therapist genuinely reaches
      // are the reads behind any picker, so those are what is checked.
      const dropdown = await api.call(
        'therapist',
        'GET',
        '/v2/practices?groups%5B%5D=practice:dropdown&search%5Bname%5D=Vantis',
      );
      const list = await api.call('therapist', 'GET', '/practices?itemsPerPage=3');
      const detail = await api.call('therapist', 'GET', `/practices/${REPRO_PRACTICE.id}`);
      const count = await api.call('therapist', 'GET', '/practices/count');

      for (const [label, probe] of [
        ['dropdown search', dropdown],
        ['list', list],
        ['detail', detail],
        ['count', count],
      ] as const) {
        expect(probe.status, `therapist ${label}`).toBe(200);
      }

      // Non-vacuity: the list must actually hold practices, or "the reads still work"
      // would be satisfied by an empty collection.
      expect(await api.totalPractices('therapist'), 'the therapist sees a populated list').toBeGreaterThan(10);

      console.log('[#3869] AC4: therapist dropdown/list/detail/count all 200');
    },
  );

  test(
    'Out of Scope — the gate landed on /practices and did not leak onto its neighbours',
    { tag: ['@SuperAdmin', '@PracticeWriteRoles', '@Security', '@ReadOnly'] },
    async () => {
      // One probe shape across three sibling resources, which is what makes the three
      // answers comparable: an id that matches nothing, so nothing can be written.
      const practice = await api.call('therapist', 'PATCH', `/practices/${ABSENT_ID}`, {});
      const contact = await api.call('therapist', 'PATCH', `/practice_contacts/${ABSENT_ID}`, {});
      const activity = await api.call('therapist', 'PATCH', `/practice_activities/${ABSENT_ID}`, {});

      // The new rule, with its own wording.
      PracticeWriteRolesPage.expectRefused(practice, DENIAL.change, 'practice');
      // "Contacts of a practice: already admin-only" — refused, but generically, so this
      // is demonstrably the pre-existing gate rather than the one shipped here.
      PracticeWriteRolesPage.expectRefused(contact, DENIAL.generic, 'practice contact');
      // "Practice activities ... Their rules stay as they are" — no role gate at all, and
      // the therapist reaches the same 404 an admin does.
      expect(activity.status, 'a therapist is NOT refused on practice activities').toBe(404);
      expect(
        (await api.call('admin', 'PATCH', `/practice_activities/${ABSENT_ID}`, {})).status,
        'and an admin sees the same answer, so no role gate was added there',
      ).toBe(activity.status);

      console.log(
        `[#3869] Out of Scope: /practices "${practice.message}" | /practice_contacts ` +
          `"${contact.message}" | /practice_activities ${activity.status} for both roles`,
      );
    },
  );
});
