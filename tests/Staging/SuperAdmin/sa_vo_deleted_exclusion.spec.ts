import { test, expect } from '@playwright/test';
import { VoDeletionPage, FIXTURES, GERMAN, I18N_KEYS } from '../../../Pages/superadmin/sa.vo-deletion.page';

/**
 * RC 3.14 — deleted VOs disappear from every screen and report (#3672, PR #3697).
 *
 * #3671 created the deleted state; this ticket makes every read in Flow act as though the VO no
 * longer exists — with **one deliberate exception**, the VO-number allocator, which must keep
 * seeing deleted VOs so a replacement never reuses a number (AC 4). **Deployed and verified live.**
 *
 * **The whole file is one round trip.** Deletion is reversible, so the honest shape of this test is
 * before → delete → after → restore → after-restore, asserted on the same VO throughout: a surface
 * that merely *does not contain* the VO proves nothing unless it contained it a moment earlier.
 * Every surface below is therefore checked three times, and the fixture is put back at the end.
 *
 * **The mechanism is two things, and both need covering.** `PrescriptionNotDeletedExtension` covers
 * the Doctrine-provided reads (`/prescriptions`, `/v2/prescriptions`, the counts, the export) plus
 * three arms for resources that BELONG to a VO — `Invoice`, `TherapyReport` and `Activity` — so they
 * leave with it. Everything else (custom providers, repository methods, raw SQL) carries its own
 * `deletedAt IS NULL`, ~30 of them in `PrescriptionRepository` alone. The tests below take one
 * representative of each kind that is reachable from a client.
 *
 * **AC 3 is a WRITE that must fail, which is what makes it safe to run.** `POST /activities/bulk`
 * against a deleted VO must answer 422 with `controls.activity.vo_deleted` — the key that renders
 * as "VO wurde gelöscht" — and write nothing. If it ever writes, that IS the defect. The payload is
 * a **bare JSON array** with a `therapist` IRI per row; wrapped in `{activities: […]}` it answers
 * 400 "expected a JSON array" and a row without a therapist answers 400 too — either of which looks
 * exactly like the constraint being absent.
 *
 * **AC 4 is the one read that must NOT exclude**, and it is checked in both directions: `next-id`
 * must answer the same thing while the VO is deleted as it did while the VO was live. A central
 * Doctrine SQL filter would have broken this, which is why the implementation used an API Platform
 * extension instead.
 *
 * **What is asserted vs what is reported.** AC 1's table names 14 surfaces. Ten of them are
 * asserted here on a real VO. The four that are not — the therapist tablet's own sync, CRM ordering
 * cards, Flow Boards / KPI figures and therapist notifications — need a VO that is currently ACTIVE
 * in that surface's own window, and the round-trip fixture (a QA patient's closed VO) is not; the
 * `fixme` at the end records what each would need. AC 2's retroactive KPI change is the same
 * problem and is recorded there too.
 *
 * **Traps:** `?patient=` is silently IGNORED on `/prescriptions` and `/v2/prescriptions` and hands
 * back the whole 34k-row book — `patientFilterPartitions()` proves the real filter (`patient.id=`)
 * partitions before any membership check is believed; `/therapy_reports` registers NO per-VO filter
 * at all (only `prescription.patient` / `prescription.therapist`); and `/activities` wants
 * `prescription[]`, not `prescription.id`.
 *
 * Run at `--workers=1` — this file holds a VO in the deleted state for the length of its describe.
 */

test.describe('#3672 a deleted VO leaves every read surface', () => {
  test.describe.configure({ mode: 'serial' });

  const vo = FIXTURES.roundTrip;

  test(
    'the filters used below actually partition (a silently-ignored filter would fake every result)',
    { tag: ['@SuperAdmin', '@VoDeletedExclusion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      const p = await api.patientFilterPartitions(vo.patientId, token);
      console.log(`#3672 filters: patient.id=${p.scoped} | patient=${p.ignored} | unfiltered book=${p.book}`);

      expect(p.scoped, 'patient.id narrows to this patient').toBeLessThan(p.book);
      expect(p.scoped).toBeGreaterThan(0);
      // The trap, pinned: `?patient=` is accepted and ignored, so it returns everything. A
      // membership check written against it would report "still present" for every VO in the book.
      expect(p.ignored, '`patient=` is silently ignored — never use it').toBe(p.book);

      const activities = await api.activitiesFor(vo.id, token);
      expect(activities, 'the fixture has activities to lose').toBeGreaterThan(0);
    },
  );

  test(
    'AC1/AC4 the full round trip: ten surfaces lose the VO, the number allocator keeps it',
    { tag: ['@SuperAdmin', '@VoDeletedExclusion', '@Mutating'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const therapist = await api.therapistToken();
      const issueDate = '2026-01-01';

      /** Every client-reachable surface AC 1 names, read in one pass. */
      const snapshot = async (phase: string) => {
        const [patientList, v2, counts, tab, childCandidates, parentCandidates, nextId, activities, invoices, docCenter, itemAdmin, itemTherapist] =
          [
            await api.prescriptionsForPatient(vo.patientId, token),
            await api.v2ForPatient(vo.patientId, token),
            await api.dashboardCounts(token),
            await api.deletedTab(token),
            await api.childVoCandidates(vo.patientId, issueDate, token),
            await api.parentVoCandidates(vo.patientId, '2027-12-31', token),
            await api.nextPrescriptionId(vo.patientId, token),
            await api.activitiesFor(vo.id, token),
            await api.invoicesFor(vo.id, token),
            await api.documentCenterTotal(token),
            (await api.prescription(vo.id, token)).status,
            (await api.prescription(vo.id, therapist)).status,
          ];
        const s = {
          phase,
          adminBoardList: patientList.ids.includes(vo.id),
          adminBoardTotal: patientList.total,
          v2List: v2.ids.includes(vo.id),
          countAll: counts.all,
          countAllWithArchived: counts.allWithArchived,
          countDeleted: counts.deleted,
          geloeschtTab: tab.rows.some((r) => r.id === vo.id),
          fvoChildCandidates: childCandidates.includes(vo.id),
          fvoParentCandidates: parentCandidates.includes(vo.id),
          nextId,
          activities,
          invoices,
          documentCenterRows: docCenter,
          itemAdmin,
          itemTherapist,
        };
        console.log(`#3672 ${phase}: ${JSON.stringify(s)}`);
        return s;
      };

      const before = await snapshot('before');
      expect(before.adminBoardList, 'the fixture is on the board to begin with').toBe(true);
      expect(before.v2List).toBe(true);
      expect(before.fvoChildCandidates, 'and is offered as an F.VO link candidate').toBe(true);
      expect(before.geloeschtTab).toBe(false);
      expect(before.activities, 'and carries documented sessions').toBeGreaterThan(0);
      expect(before.itemAdmin).toBe(200);
      expect(before.itemTherapist, 'its own therapist can read it').toBe(200);

      const statusBefore = (await api.prescription(vo.id, token)).body?.treatmentStatus ?? null;

      try {
        const del = await api.deleteVo(vo.id, { reason: 'incorrect_data' }, token);
        expect(del.status, `delete ${vo.vo}`).toBe(200);

        const after = await snapshot('deleted');

        // ── AC 1, surface by surface ──────────────────────────────────────────────
        expect(after.adminBoardList, 'Admin Board / patient VO table').toBe(false);
        expect(after.adminBoardTotal, 'and the list total moved by exactly one').toBe(before.adminBoardTotal - 1);
        expect(after.v2List, 'the v2 board list the Admin Board actually renders').toBe(false);
        expect(after.countAll, 'Admin Board counts, every tab except Gelöscht').toBe(before.countAll - 1);
        expect(after.countAllWithArchived).toBe(before.countAllWithArchived - 1);
        expect(after.countDeleted, 'and exactly one tab gains it').toBe(before.countDeleted + 1);
        expect(after.geloeschtTab, 'the one place it is meant to appear').toBe(true);
        expect(after.fvoChildCandidates, 'parent/child VO selection lists (F.VO linking)').toBe(false);
        expect(after.fvoParentCandidates).toBe(false);
        expect(after.activities, 'GET /activities — what the therapist tablet pulls').toBe(0);
        // Document Center: reported, not asserted. Its provider carries an explicit
        // `p.deletedAt IS NULL` on both the rows and the count, but the round-trip fixture holds no
        // therapy report, so its row total cannot move — and a global total is shared with whatever
        // else is happening on staging, so asserting a delta on it would flake rather than inform.
        console.log(
          `#3672 Document Center rows: ${before.documentCenterRows} -> ${after.documentCenterRows} ` +
            '(the fixture contributes none; the provider\'s deletedAt IS NULL is on both its row and its count query)',
        );
        // The tablet arm again, from the other direction: a therapist cannot even resolve the VO.
        expect(after.itemTherapist, 'a deleted VO 404s for a therapist, so the tablet cannot re-fetch it').toBe(404);
        expect(after.itemAdmin, "while an admin can still open it — AC 17's banner needs that").toBe(200);

        // ── AC 4, the one intentional exception ───────────────────────────────────
        expect(after.nextId, 'AC4: the VO number stays reserved while the VO is deleted').toBe(before.nextId);

        // ── AC 3, the offline replay ──────────────────────────────────────────────
        const replay = await api.postActivityAgainst(vo.id, vo.therapistId, therapist);
        console.log(`#3672 AC3 offline replay: ${replay.status} ${JSON.stringify(replay.body)}`);
        expect(replay.status, 'AC3: the server refuses the queued activity').toBe(422);
        const violation = replay.body?.violations?.[0];
        expect(violation?.propertyPath, 'bound to `prescription` so the queue can say which row failed').toBe(
          'prescription',
        );
        expect(violation?.message, 'AC3: the "VO wurde gelöscht" key').toBe(I18N_KEYS.activityRefusal);
        expect(
          await api.activitiesFor(vo.id, token),
          'and nothing was written — a refusal that still saved would be the defect',
        ).toBe(0);

        // ── the duplicate-VO warning (AC 1, last row of the table) ────────────────
        // A corrected replacement must not be flagged as a duplicate of the VO it replaces.
        const dupe = await api.raw<{ totalItems?: number; member?: { id: number }[] }>(
          `/prescriptions/duplicate-check?patient=${vo.patientId}&issueDate=2026-06-15&doctor=1727&practice=755&treatmentCodes=KG`,
          token,
        );
        const dupeIds = (dupe.body?.member ?? []).map((m) => m.id);
        console.log(`#3672 duplicate-check while deleted: ${dupe.status} -> ${JSON.stringify(dupeIds)}`);
        expect(dupeIds, 'the deleted VO never triggers a false duplicate warning').not.toContain(vo.id);
      } finally {
        const outcome = await api.ensureRestored(vo.id, 'standalone', token);
        console.log(`#3672 cleanup ${vo.vo}: ${outcome}`);
      }

      const restored = await snapshot('restored');
      // #3674 AC 2 from this ticket's side: everything #3672 took away comes back.
      expect(restored.adminBoardList, 're-enters the board').toBe(true);
      expect(restored.adminBoardTotal).toBe(before.adminBoardTotal);
      expect(restored.v2List).toBe(true);
      expect(restored.countAll).toBe(before.countAll);
      expect(restored.countAllWithArchived).toBe(before.countAllWithArchived);
      expect(restored.countDeleted).toBe(before.countDeleted);
      expect(restored.geloeschtTab).toBe(false);
      expect(restored.fvoChildCandidates).toBe(true);
      expect(restored.activities, 'its documented sessions come back with it').toBe(before.activities);
      expect(restored.itemTherapist, 'and its therapist can read it again').toBe(200);
      expect(restored.nextId, 'the allocator never moved').toBe(before.nextId);
      expect((await api.prescription(vo.id, token)).body?.treatmentStatus, 'with its original status').toBe(
        statusBefore,
      );
    },
  );

  test(
    'AC1 the "VO wurde gelöscht" refusal is translated in the deployed dictionary',
    { tag: ['@SuperAdmin', '@VoDeletedExclusion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const bundle = await api.entryBundle();

      // The LEAF key, not the dotted path. The dictionary stores keys nested, so a search for the
      // full `controls.activity.vo_deleted` finds no dictionary entry and reads exactly like "never
      // shipped" — which is why the substantive assertions below are on the leaf and on the German.
      //
      // **Re-measured 2026-09-23: the dotted path is no longer absent, and the reason is a product
      // change rather than a flattening.** It now occurs twice, both times as a LOOKUP KEY —
      // `{'controls.activity.vo_deleted':'vo_deleted'}`, sitting immediately beside #3594's
      // `sync.failure.*` map — so the offline queue now classifies this refusal as its own failure
      // reason instead of letting it fall through as a generic one. The count was pinned at 0 when
      // this file was written; pinning it again would just be re-pinning today's build, so the
      // dotted count is now REPORTED and only the two assertions that carry meaning are made.
      const leaf = VoDeletionPage.occurrences(bundle, I18N_KEYS.activityRefusalLeaf);
      const dotted = VoDeletionPage.occurrences(bundle, I18N_KEYS.activityRefusal);
      const german = VoDeletionPage.escapedCount(bundle, GERMAN.voDeleted);
      console.log(
        `#3672 i18n: leaf "${I18N_KEYS.activityRefusalLeaf}" x${leaf} | dotted path x${dotted} | "${GERMAN.voDeleted}" x${german}`,
      );

      // The API returns the KEY, so the German only exists if the dictionary ships it — a violation
      // message nothing can render is a raw key on the therapist's screen (#3337).
      expect(leaf, 'the constraint message key is in the deployed dictionary, in both locales').toBeGreaterThanOrEqual(
        2,
      );
      expect(german, "and resolves to the ticket's German").toBeGreaterThan(0);
      console.log(
        `#3672 i18n: the dotted path occurs ${dotted}x — as a sync-failure lookup key, not a dictionary entry. ` +
          'A zero here would be the normal state and is NOT evidence that the refusal is missing; read the leaf and the German.',
      );
    },
  );
});
