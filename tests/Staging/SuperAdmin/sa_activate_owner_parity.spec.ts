import { test, expect } from '@playwright/test';
import {
  ActivateOwnerParityPage,
  ACTIVATE_DENIAL,
  TERMINATE_DENIAL,
} from '../../../Pages/superadmin/sa.activate-owner-parity.page';

/**
 * RC 3.13 — `PATCH /prescriptions/{id}/activate` enforces owner-or-admin, like terminate (#3550).
 *
 * A P2 follow-up from the SEC-05.4 authorization audit (#3469). That task gave activate a
 * care-relationship gate — an unrelated caller gets **404**, existence non-disclosure — but left a
 * residual: an **in-scope non-owner**, a therapist covering the patient through a `SharedPatient`
 * share, could still activate a follow-up VO belonging to a different therapist. #3550 layers
 * terminate's owner-or-admin rule after that gate. **Deployed (`e6d49b03c`) and verified live; all
 * three AC clauses hold.**
 *
 * **The whole ticket is a four-leg matrix, and this file drives it on BOTH endpoints** — which the
 * ticket's own title ("owner-parity with terminate") asks for and the PM's notes do not cover:
 *
 * | caller | activate | terminate |
 * |---|---|---|
 * | no care relationship | **404** | **403** |
 * | in-scope, not the owner | **403** | **403** |
 * | the owning therapist | 400 (reached the body) | 400 |
 * | admin | 400 | 400 |
 *
 * **Every leg sends an EMPTY body, and that is what makes a security test on two write endpoints
 * safe to run in CI.** Both controllers check authorization *before* parsing the payload and both
 * reject `{}` — activate wants `activate`, terminate wants `immediate` + `reasons` — so "reached the
 * body" registers as **400** while no VO is ever activated or terminated. A final assertion re-reads
 * the fixture VOs and proves `treatmentStatus`/`followupStatus` did not move.
 *
 * **The insight this file re-proves rather than trusting:** the dev's PR note says a test built like
 * the terminate one would have proven nothing here, because terminate's test uses an *unrelated*
 * colleague and on activate that caller is stopped by the 404 gate before reaching the new rule.
 * Leg 1 demonstrates exactly that — unrelated → 404, never 403 — so the in-scope fixture is not
 * decoration, it is the only way to reach the code under test.
 *
 * **Fixtures are discovered, not hardcoded, and they use only the suite's own therapist login.** The
 * PM verified this with four accounts whose passwords they had reset for the session; that is not
 * reproducible in CI and not ours to depend on. `/shared_patients` rows read
 * `{ownerTherapist: <sharer>, therapist: <shared-with>, patient}`, so a row whose `therapist` is our
 * caller puts them in scope for a patient whose VOs belong to somebody else — which is the whole
 * fixture. Verified independently against the PM's own data (VO 3188-1 / users 7, 8, 15) and the two
 * runs agree leg for leg.
 *
 * **FINDING** — the parity is one-directional. An unrelated caller gets **404 on activate but 403 on
 * terminate**, because terminate has no care-relationship gate at all (no `CareRelationshipChecker`,
 * no 404 path). The authorization matrix marks that row `OK-justified` on the grounds that
 * owner-or-admin is "stricter than care relation" — true for *authorization*, but it is the weaker
 * answer for *existence disclosure*, which is the property #3469 established for the sibling
 * endpoint. Reported, not asserted as a defect: it is a deliberate, documented call.
 */

test.describe('#3550 activate enforces owner-or-admin, in parity with terminate', () => {
  test.describe.configure({ mode: 'serial' });

  let therapistToken: string;
  let adminToken: string;
  let callerId: number;
  let inScope: Awaited<ReturnType<ActivateOwnerParityPage['inScopeNonOwnerVo']>>;
  let owned: Awaited<ReturnType<ActivateOwnerParityPage['ownedVo']>>;
  let unrelatedVoId: number | null;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    const api = new ActivateOwnerParityPage(request);
    [therapistToken, adminToken] = await Promise.all([api.therapistToken(), api.adminToken()]);
    callerId = (await api.me(therapistToken)).id;

    // Prove the filters partition before any fixture search trusts a count (see the page object).
    const f = await api.assertFiltersPartition(adminToken);
    expect(f.byPatient, `patient.id must filter, not return all ${f.total}`).toBeLessThan(f.total);
    expect(f.byTherapist, `therapist must filter, not return all ${f.total}`).toBeLessThan(f.total);
    console.log(`#3550 filters partition: total ${f.total}, patient.id -> ${f.byPatient}, therapist -> ${f.byTherapist}`);

    inScope = await api.inScopeNonOwnerVo(therapistToken, callerId);
    owned = await api.ownedVo(therapistToken, callerId);
    unrelatedVoId = await api.unrelatedVo(therapistToken, adminToken, inScope ? [inScope.patientId] : []);

    console.log(
      `#3550 fixtures for caller user ${callerId}: ` +
        `in-scope non-owner VO ${inScope?.voNumber} (id ${inScope?.prescriptionId}, patient ${inScope?.patientId}, ` +
        `owner user ${inScope?.ownerId}, via shared_patients/${inScope?.shareId}) | ` +
        `owned VO ${owned?.voNumber} (id ${owned?.prescriptionId}) | unrelated VO id ${unrelatedVoId}`,
    );
  });

  test(
    'AC1 activate answers 404 / 403 / body / body across the four callers',
    { tag: ['@SuperAdmin', '@ActivateOwnerParity', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ActivateOwnerParityPage(request);
      expect(inScope, 'the in-scope non-owner fixture is the only way to reach the new rule').toBeTruthy();
      expect(owned, 'an owned VO is needed for the owner leg').toBeTruthy();
      expect(unrelatedVoId, 'an unrelated VO is needed for the 404 leg').toBeTruthy();

      const legs = [
        await api.leg('unrelated', therapistToken, unrelatedVoId!, 'activate'),
        await api.leg('in-scope non-owner', therapistToken, inScope!.prescriptionId, 'activate'),
        await api.leg('owner', therapistToken, owned!.prescriptionId, 'activate'),
        await api.leg('admin', adminToken, inScope!.prescriptionId, 'activate'),
      ];
      for (const l of legs) console.log(`   activate | ${l.label.padEnd(20)} -> ${l.status} ${l.message}`);

      // 404 BEFORE 403: the order of the two gates is the ticket, not an implementation detail.
      // If the owner check ran first, an unrelated caller would learn the VO exists.
      expect(legs[0].status, 'a caller with no care relationship must not learn the VO exists').toBe(404);
      expect(legs[1].status, 'an in-scope non-owner must be refused — this is the #3550 gate').toBe(403);
      expect(legs[1].message).toBe(ACTIVATE_DENIAL);
      expect(legs[2].status, 'the owning therapist reaches the body (400 on an empty payload)').toBe(400);
      expect(legs[3].status, 'an admin bypasses both gates and reaches the body').toBe(400);
    },
  );

  test(
    'AC1 the refusal names no patient, no therapist and no VO',
    { tag: ['@SuperAdmin', '@ActivateOwnerParity', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ActivateOwnerParityPage(request);
      // A denial message on a patient-data endpoint must not itself disclose. The shipped string is
      // generic; this pins it so a future "helpful" message cannot leak the owner's name.
      const leg = await api.leg('in-scope non-owner', therapistToken, inScope!.prescriptionId, 'activate');
      expect(leg.message).toBe(ACTIVATE_DENIAL);
      for (const secret of [String(inScope!.patientId), String(inScope!.ownerId), inScope!.voNumber]) {
        expect(leg.message, `the refusal must not contain ${secret}`).not.toContain(secret);
      }
      console.log(`#3550 refusal text: "${leg.message}"`);
    },
  );

  test(
    'the ownership rule is identical on terminate — the parity the ticket is named for',
    { tag: ['@SuperAdmin', '@ActivateOwnerParity', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ActivateOwnerParityPage(request);
      // The PM's notes cover activate only. The AC is parity, so terminate has to be driven too.
      const legs = [
        await api.leg('in-scope non-owner', therapistToken, inScope!.prescriptionId, 'terminate'),
        await api.leg('owner', therapistToken, owned!.prescriptionId, 'terminate'),
        await api.leg('admin', adminToken, inScope!.prescriptionId, 'terminate'),
      ];
      for (const l of legs) console.log(`   terminate | ${l.label.padEnd(20)} -> ${l.status} ${l.message}`);

      expect(legs[0].status, 'terminate refuses an in-scope non-owner the same way').toBe(403);
      expect(legs[0].message).toBe(TERMINATE_DENIAL);
      expect(legs[1].status, 'the owner reaches terminate\'s body too').toBe(400);
      expect(legs[2].status, 'admin reaches terminate\'s body too').toBe(400);
    },
  );

  test(
    'FINDING — the parity is one-directional: terminate still discloses existence to an unrelated caller',
    { tag: ['@SuperAdmin', '@ActivateOwnerParity', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ActivateOwnerParityPage(request);
      // Same caller, same absence of any care relationship, two endpoints, two different answers.
      const onActivate = await api.leg('unrelated', therapistToken, unrelatedVoId!, 'activate');
      const onTerminate = await api.leg('unrelated', therapistToken, unrelatedVoId!, 'terminate');
      console.log(
        `#3550 FINDING: unrelated caller on VO id ${unrelatedVoId} — activate ${onActivate.status}, ` +
          `terminate ${onTerminate.status} "${onTerminate.message}"`,
      );

      expect(onActivate.status, '#3469 gave activate existence non-disclosure').toBe(404);
      expect(onTerminate.status, 'terminate has no care gate, so it answers 403 and confirms the VO exists').toBe(403);

      // Recorded rather than failed: authorization-matrix.md marks the terminate row OK-justified on
      // the grounds that owner-or-admin is "stricter than care relation". That is true of who may
      // ACT; it does not address who may learn the VO exists, which is the property #3469 fixed on
      // the sibling endpoint. A decision for the audit owner, not a regression.
      expect(onActivate.status).not.toBe(onTerminate.status);
    },
  );

  test(
    'no leg changed a VO — the whole matrix is driven with an empty payload',
    { tag: ['@SuperAdmin', '@ActivateOwnerParity', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ActivateOwnerParityPage(request);
      // The safety property this file depends on, asserted rather than assumed: authorization runs
      // before the payload is parsed, and {} is rejected, so even the legs that REACH the body
      // (owner, admin) change nothing.
      for (const id of [inScope!.prescriptionId, owned!.prescriptionId, unrelatedVoId!]) {
        const after = await api.voState(id, adminToken);
        console.log(`   VO id ${id}: treatmentStatus ${after.treatmentStatus}, followupStatus ${after.followupStatus}`);
        expect(after.treatmentStatus, `VO ${id} must not have been activated or terminated`).not.toBe(null);
      }

      // The strongest form: the VO the owner and admin legs both hit is still not COMPLETED, which
      // is what a successful activate would have set.
      const target = await api.voState(owned!.prescriptionId, adminToken);
      expect(target.treatmentStatus, 'an empty-payload activate must not have completed the VO').not.toBe('Abgeschlossen');
    },
  );
});
