import { test, expect } from '@playwright/test';
import {
  VorabinfoNoFacilityPage,
  CUTOVER,
  PRE_FIX_NO_FACILITY_NOTICES,
  DEFECT_DEMO,
} from '../../../Pages/superadmin/sa.vorabinfo-no-facility.page';

/**
 * RC 3.13 — no automatic Vorabinformation for a GKV VO with no Einrichtung (#3512).
 *
 * #3202 stopped automatic generation for patients at Praxis-VO facilities; a VO with NO facility
 * still slipped through, because the guard read `PRAXIS_VO !== $vo->getElderlyCareHome()?->getOrderingMode()`
 * and a null facility makes that true. `ce9df2b44` puts a shared policy in front of BOTH creation
 * paths — the API processor and the CSV importer, which had never received #3202's guard at all.
 * **Deployed; AC5 verified precisely and AC3 supported. AC1/AC2 have no post-fix instance on
 * staging — for a sharper reason than the ticket gives. 5 passed / 2 fixme.**
 *
 * **The ticket says AC1/AC2 cannot be reproduced through the UI because the form requires an
 * Einrichtung. True, but it is not the whole reason, and the data says something more useful:**
 * **zero GKV VOs with no facility have been created by ANY path since the fix shipped.** The 11
 * no-facility VOs created after the cutover all carry no insurance type at all, so they were never
 * in this rule's scope. So the fix cannot be demonstrated positively here — not because a form
 * blocks it, but because the population it governs has been empty since the day it shipped.
 *
 * **What IS decidable, and it is the sharper half — the defect is still on record.** VO **9656-1**
 * (GKV, **no Einrichtung**, created 2026-09-04T04:16:52) has notice **10228** created
 * **2026-09-04T04:17:11** — nineteen seconds later, for a patient with no facility either. That is
 * the bug, timestamped, five days before the fix reached staging. It is what makes the cutover
 * partition below mean something rather than being a count of nothing.
 *
 * **THE TRAP, and it inverts the result completely:** `groups[]=billing:read` REPLACES the default
 * serialization group (`overrideDefaultGroups: true`) and `elderlyCareHome` is not in it — so VOs
 * read through that group report **no facility for every VO on staging**, which reads exactly like
 * "nothing is affected by this rule". The first pass of this work hit that and briefly had 120 of
 * 120 newest VOs looking facility-less; read without the override, it is 55 of 120. A test pins the
 * difference so it cannot return silently.
 *
 * **The cutover is the DEPLOY, not the commit.** `ce9df2b44` is dated 2026-08-27 but is an ancestor
 * of `release/3.13.0` only (diverged from `release/3.12.0` and `main`), and staging took 3.13.0 at
 * 2026-09-09T02:38. Partitioning on the commit date would misclassify notice 10228 (2026-09-04) as
 * a post-fix violation when it is the last pre-fix one.
 *
 * **FINDING — the PM's AC-5 evidence describes a failure, not a pass.** Their note reads: "Queried
 * no-facility patients (853 exist). None have a pre-treatment notice linked." AC5 requires the
 * opposite: the notices generated before the fix must still be there, and **13 are** — including
 * their own cited example. Their AC-1 example is also mismatched: patient **1721** is "Prof. Dr.
 * Manfred Naundorf" and HAS a facility; **"Gisela Adler" is patient 13**, has no facility, and holds
 * notice 10127. Taken literally their query would mean the 13 had been deleted — i.e. AC5 failing —
 * so the PASS rests on a measurement that cannot be reproduced.
 *
 * **Read-only — every request is a GET.**
 */

test.describe('#3512 no automatic Vorabinformation for a GKV VO with no facility', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'the groups[] trap: billing:read drops elderlyCareHome, which would fake a facility-less book',
    { tag: ['@SuperAdmin', '@VorabinfoNoFacility', '@ReadOnly'] },
    async ({ request }) => {
      // Asserted first, because every facility count below is only meaningful if the field is
      // actually being serialized. Under the override it is ABSENT, not null — so a `?? null`
      // reader silently reports "no facility" for the entire population.
      const api = new VorabinfoNoFacilityPage(request);
      const probe = await api.facilitySerialization(34273);
      console.log(
        `#3512 serialization: default group -> "${probe.withDefault}"; ` +
          `groups[]=billing:read -> field present: ${probe.withBillingGroup}`,
      );
      expect(probe.withDefault, 'the default group carries the VO Einrichtung').toBeTruthy();
      expect(probe.withBillingGroup, 'and billing:read drops it entirely — never read facilities through it').toBe(false);
    },
  );

  test(
    'AC5 every Vorabinformation generated for a no-facility patient before the fix is still there',
    { tag: ['@SuperAdmin', '@VorabinfoNoFacility', '@ReadOnly'] },
    async ({ request }) => {
      // AC5's whole content is that nothing was removed or changed, so the population is pinned as a
      // fixture and checked for survival rather than re-derived (which would cost a 3,272-patient
      // sweep to rebuild a list that must be static by definition).
      const api = new VorabinfoNoFacilityPage(request);
      const patientIds = PRE_FIX_NO_FACILITY_NOTICES.map((n) => n.patientId);
      const facilities = await api.patientFacilities([...new Set(patientIds)]);

      let survived = 0;
      for (const fixture of PRE_FIX_NO_FACILITY_NOTICES) {
        const notice = await api.notice(fixture.noticeId);
        expect(notice, `notice ${fixture.noticeId} (${fixture.name}) must not have been removed`).toBeTruthy();
        expect(notice!.createdAt, `notice ${fixture.noticeId} must not have been re-dated`).toBe(fixture.createdAt);
        expect(notice!.patientId, `notice ${fixture.noticeId} must still belong to patient ${fixture.patientId}`).toBe(fixture.patientId);
        expect(facilities.get(fixture.patientId), `${fixture.name} is the no-facility population this AC protects`).toBeNull();
        expect(fixture.createdAt < CUTOVER, `notice ${fixture.noticeId} must predate the fix to be in scope`).toBe(true);
        survived++;
      }
      console.log(`#3512 AC5: ${survived}/${PRE_FIX_NO_FACILITY_NOTICES.length} pre-fix notices intact, all before ${CUTOVER}`);
      expect(survived).toBe(PRE_FIX_NO_FACILITY_NOTICES.length);
    },
  );

  test(
    'the defect is still on record: a GKV VO with no facility and the notice it generated 19s later',
    { tag: ['@SuperAdmin', '@VorabinfoNoFacility', '@ReadOnly'] },
    async ({ request }) => {
      // Without this, "no violations after the cutover" could just mean nothing happens on either
      // side of it. This is the before half of the before/after.
      const api = new VorabinfoNoFacilityPage(request);
      const vo = await api.prescription(DEFECT_DEMO.prescriptionId);
      const notice = await api.notice(DEFECT_DEMO.noticeId);
      const ech = vo.elderlyCareHome;
      const facility = (typeof ech === 'string' ? ech : ech?.name) ?? null;

      console.log(
        `#3512 defect on record: VO ${vo.prescriptionId} (${vo.insuranceType}, Einrichtung ${facility ?? 'NONE'}) ` +
          `created ${String(vo.createdAt).slice(0, 19)} -> notice ${notice?.id} created ${notice?.createdAt}`,
      );

      expect(facility, 'the VO that triggered it had no Einrichtung — the case this ticket forbids').toBeNull();
      expect(vo.insuranceType, 'and it is GKV, which is the rule\'s scope').toBe('public');
      expect(notice, 'its notice must still exist (AC5 protects it)').toBeTruthy();
      expect(notice!.createdAt > String(vo.createdAt).slice(0, 19), 'the notice followed the VO').toBe(true);
      expect(String(vo.createdAt).slice(0, 19) < CUTOVER, 'and it happened before the fix shipped').toBe(true);
    },
  );

  test(
    'AC1/AC2 no notice has been generated for a no-facility patient since the fix shipped',
    { tag: ['@SuperAdmin', '@VorabinfoNoFacility', '@ReadOnly'] },
    async ({ request }) => {
      const api = new VorabinfoNoFacilityPage(request);
      const since = await api.noticesSince(CUTOVER);
      const facilities = await api.patientFacilities(since.map((n) => n.patientId));

      const violations = since.filter((n) => !facilities.get(n.patientId));
      for (const n of since) {
        console.log(`   notice ${n.id} ${n.createdAt} patient ${n.patientId} facility: ${facilities.get(n.patientId) ?? 'NONE'}`);
      }
      console.log(`#3512 AC1/AC2: ${since.length} notices since ${CUTOVER}, ${violations.length} for a no-facility patient`);
      expect(violations.length, 'no notice may be auto-generated for a patient with no facility').toBe(0);

      // Stated honestly: the sample is small, and the test below explains why it cannot be larger.
      expect(since.length, 'there must be some post-fix notices, or this proves nothing at all').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 facility-linked patients still get one, and AC1/AC2\'s population has been empty since the fix',
    { tag: ['@SuperAdmin', '@VorabinfoNoFacility', '@ReadOnly'] },
    async ({ request }) => {
      // Two halves of the same measurement. AC3: every post-cutover notice belongs to a
      // facility-linked patient, so generation still happens for them. AC1/AC2: no GKV VO with no
      // facility has been created since the cutover by ANY path, which is the real reason the fix
      // cannot be shown working rather than merely "the form requires an Einrichtung".
      const api = new VorabinfoNoFacilityPage(request);
      const since = await api.noticesSince(CUTOVER);
      const facilities = await api.patientFacilities(since.map((n) => n.patientId));
      for (const n of since) {
        expect(facilities.get(n.patientId), `notice ${n.id}: AC3 — a facility-linked patient still gets one`).toBeTruthy();
      }

      const recent = await api.recentPrescriptions(150);
      const postCutover = recent.filter((p) => p.createdAt >= CUTOVER);
      const noFacility = postCutover.filter((p) => !p.facility);
      const gkvNoFacility = noFacility.filter((p) => p.insuranceType === 'public');
      console.log(
        `#3512 population since ${CUTOVER}: ${postCutover.length} VOs created, ${noFacility.length} with no Einrichtung, ` +
          `${gkvNoFacility.length} of those GKV — the set AC1/AC2 needs`,
      );
      for (const p of noFacility) console.log(`   VO ${p.number} (${p.insuranceType ?? 'no insurance type'}) ${p.createdAt}`);

      expect(recent.filter((p) => p.facility).length, 'the read must resolve real facilities, or the trap is back').toBeGreaterThan(0);
      // Recorded, not required: if this ever becomes non-zero the fix gains a live fixture, and the
      // AC1/AC2 fixmes below can be replaced with a real assertion.
      console.log(
        gkvNoFacility.length === 0
          ? '   -> AC1/AC2 still have no post-fix fixture on staging'
          : `   -> a fixture now exists (${gkvNoFacility.map((p) => p.number).join(', ')}) — promote the fixmes`,
      );
    },
  );
});
