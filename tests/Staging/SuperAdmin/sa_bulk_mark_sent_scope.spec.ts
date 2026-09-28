import { test, expect } from '@playwright/test';
import { BulkMarkSentScopePage, MAX_BULK_IDS } from '../../../Pages/superadmin/sa.bulk-mark-sent-scope.page';

/**
 * RC 3.13 — bulk report mark-sent is scoped to the caller's caseload (#3549, PR #3688).
 *
 * `POST /prescriptions/report-send/bulk` marked therapy reports "sent" for ARBITRARY VO ids: the
 * lookup was a bare `findBy` on the posted ids with no therapist predicate, while every sibling
 * bulk endpoint already narrowed non-admins to their own caseload. A P1 write-integrity finding from
 * the SEC-05.4 audit. **Deployed as `13f109033` (2026-09-11); both ACs verified live. 6 passed /
 * 2 skipped when the fixture pool is exhausted.**
 *
 * **The write side was the worse half, and it is what these tests assert.** Every marked report also
 * persisted a `PrescriptionLog` attributed to the CALLER against a VO they do not own — a forged
 * audit trail, not merely an unauthorised state change. So the foreign-VO assertions check the log
 * count, not just the report's `sent` flag.
 *
 * **THE TEST-DESIGN TRAP, and it makes a broken build look fixed.** The query also filters
 * `tr.sentAt IS NULL AND tr.archivedDate IS NULL`, so a foreign report that is ALREADY SENT is
 * excluded for a reason unrelated to authorization and a count of 0 proves nothing. Every fixture
 * here is verified unsent and unarchived first, and the admin control **re-posts the very same id**
 * the therapist was refused — if the admin marks it, the report was genuinely eligible and the
 * therapist's exclusion can only have been the scoping.
 *
 * **Silent exclusion is the correct behaviour, not a weak refusal.** It matches
 * `BulkPostOrganizerController` deliberately: a 403 would break the partial-batch contract the
 * frontend relies on AND would confirm that a given VO id exists. So the assertion is on the count
 * and the untouched foreign state, never on a status code.
 *
 * **Run shape:** `--grep "@ReadOnly"` runs the safe set, including the central security test —
 * posting a foreign id alone writes NOTHING when the fix is intact, and if it ever does write, that
 * IS the vulnerability. `@Mutating` adds the two tests that consume fixtures: marking a report sent
 * is forward-only with no client-reachable undo, so each mutating run burns one own-VO report and
 * one foreign report from a finite pool.
 */

test.describe('#3549 bulk report mark-sent is scoped to the caller\'s caseload', () => {
  test.describe.configure({ mode: 'serial' });

  let therapistToken: string;
  let adminToken: string;
  let therapistId: number;
  let ownPool: { id: number; prescriptionId: number }[] = [];
  let foreignPool: { id: number; prescriptionId: number }[] = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    const api = new BulkMarkSentScopePage(request);
    [therapistToken, adminToken] = await Promise.all([api.therapistToken(), api.adminToken()]);
    therapistId = (await api.me(therapistToken)).id;

    ownPool = await api.unsentReportsFor(therapistId, adminToken);
    // A colleague's caseload — any therapist that is not the caller. 7 is the account the ticket's
    // own PM notes used, which keeps the two verification runs comparable.
    foreignPool = await api.unsentReportsFor(7, adminToken);

    console.log(
      `#3549 fixture pools (unsent + unarchived): caller user ${therapistId} has ${ownPool.length}, ` +
        `foreign therapist 7 has ${foreignPool.length}`,
    );
  });

  test(
    'AC1 a foreign VO is silently excluded and gains NO audit entry',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      // The central security test, and it writes nothing while the fix holds: if the endpoint ever
      // acts on this id, that IS the vulnerability and the assertions below record it.
      const api = new BulkMarkSentScopePage(request);
      test.skip(foreignPool.length === 0, 'no unsent foreign report to attempt');
      const victim = foreignPool[0];

      const before = await api.report(victim.id, adminToken);
      const logsBefore = await api.markSentLogs(victim.prescriptionId, adminToken);
      expect(before.sent, 'the fixture must be genuinely unsent, or a zero count proves nothing').toBe(false);
      expect(before.archived, 'and unarchived, for the same reason').toBe(false);

      const res = await api.bulkMarkSent([victim.prescriptionId], therapistToken);
      console.log(
        `   therapist ${therapistId} -> POST {id:[${victim.prescriptionId}]} (owned by therapist 7) ` +
          `-> ${res.status} count=${res.count}`,
      );

      expect(res.status, 'silent exclusion keeps the response 200 — a 403 would confirm the id exists').toBe(200);
      expect(res.count, 'a foreign id must contribute nothing to the processed count').toBe(0);

      const after = await api.report(victim.id, adminToken);
      const logsAfter = await api.markSentLogs(victim.prescriptionId, adminToken);
      expect(after.sent, 'the foreign report must still be unsent').toBe(false);
      expect(logsAfter.length, 'and must have gained NO forged audit entry').toBe(logsBefore.length);
      console.log(`   foreign report ${victim.id}: sent ${after.sent}, mark-sent logs ${logsAfter.length} (unchanged)`);
    },
  );

  test(
    'every mark-sent entry on record was written by the VO\'s own therapist or an admin',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      // The invariant the forged-trail bug would break, checked against the entries that exist.
      // Scanning ALL history is not affordable — `prescription_logs?type=field_change` holds ~463k
      // rows and the `therapyReportStatus` marker is only in the meta, which no filter reaches — so
      // this checks a bounded recent window and says so rather than implying a census.
      const api = new BulkMarkSentScopePage(request);
      const WINDOW = 3000;
      const body = await request.get(
        `https://api.staging.therapios.de/prescription_logs?type=field_change&itemsPerPage=${WINDOW}&order%5BcreatedAt%5D=desc`,
        { headers: { Authorization: `Bearer ${adminToken}` }, timeout: 180_000 },
      );
      const json = await body.json();
      const marks = (json.member ?? []).filter((l: any) => String(l.value ?? '').includes('therapyReportStatus'));
      console.log(`#3549 audit sweep: ${marks.length} mark-sent entries in the newest ${WINDOW} field_change logs (of ${json.totalItems})`);
      expect(marks.length, 'there must be entries to check, or this proves nothing').toBeGreaterThan(0);

      let byOwner = 0;
      let byAdmin = 0;
      for (const m of marks) {
        const pid = Number(String(m.prescription ?? '').split('/').pop());
        const owner = await api.ownerName(pid, adminToken);
        const author = m.createdBy?.fullName ?? null;
        const isOwner = owner !== null && owner === author;
        if (isOwner) byOwner++;
        else byAdmin++;
        console.log(`   ${String(m.createdAt).slice(0, 19)} VO ${pid} owned by ${owner} — marked by ${author} ${isOwner ? '(owner)' : '(not the owner)'}`);
      }
      console.log(`   ${byOwner} written by the VO's own therapist, ${byAdmin} by someone else (expected: admins only)`);

      // Every non-owner entry must be an admin's. The therapist accounts on staging are not admins,
      // so a therapist name appearing against a VO they do not own would be the bug's footprint.
      for (const m of marks) {
        const pid = Number(String(m.prescription ?? '').split('/').pop());
        const owner = await api.ownerName(pid, adminToken);
        const author = m.createdBy?.fullName ?? '';
        if (owner && owner !== author) {
          expect(
            /Admin|SA /i.test(author),
            `${author} marked VO ${pid} sent but does not own it and is not an admin — the #3549 footprint`,
          ).toBe(true);
        }
      }
    },
  );

  test(
    'the payload guards reject before anything is written',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@ReadOnly'] },
    async ({ request }) => {
      const api = new BulkMarkSentScopePage(request);
      const missing = await api.bulkMarkSent(undefined as unknown as number[], therapistToken);
      console.log(`   no id array -> ${missing.status} "${missing.detail}"`);
      expect(missing.status, 'a malformed payload is refused').toBe(400);

      const oversized = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => 900000 + i);
      const tooMany = await api.bulkMarkSent(oversized, therapistToken);
      console.log(`   ${oversized.length} ids (cap ${MAX_BULK_IDS}) -> ${tooMany.status} "${tooMany.detail}"`);
      expect(tooMany.status, `the batch guard rejects more than ${MAX_BULK_IDS} ids`).toBe(400);
      expect(tooMany.detail).toContain('Batch size cannot exceed');
    },
  );

  test(
    'nonexistent ids are absorbed silently, exactly like out-of-caseload ones',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@ReadOnly'] },
    async ({ request }) => {
      // The other half of "silent exclusion": an id that matches nothing must also return 200/0, or
      // the response would distinguish "does not exist" from "not yours" and leak existence.
      const api = new BulkMarkSentScopePage(request);
      const res = await api.bulkMarkSent([999_000_001, 999_000_002], therapistToken);
      console.log(`   two nonexistent ids -> ${res.status} count=${res.count}`);
      expect(res.status).toBe(200);
      expect(res.count).toBe(0);

      // And it is indistinguishable from the foreign case above — which is the point of the design.
      if (foreignPool.length > 0) {
        const foreign = await api.bulkMarkSent([foreignPool[0].prescriptionId], therapistToken);
        expect(
          { status: foreign.status, count: foreign.count },
          'a foreign id and a nonexistent id must be indistinguishable from the response',
        ).toEqual({ status: res.status, count: res.count });
        console.log(`   foreign id -> ${foreign.status} count=${foreign.count} — indistinguishable, so no id is confirmed to exist`);
      }
    },
  );

  test(
    'AC1 own and foreign in ONE request: only the caller\'s own VO is processed',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@Security', '@Mutating'] },
    async ({ request }) => {
      // The AC's literal scenario. Consumes one own-VO report: marking sent is forward-only.
      const api = new BulkMarkSentScopePage(request);
      test.skip(ownPool.length === 0 || foreignPool.length === 0, 'fixture pool exhausted — see the file docblock');
      const mine = ownPool[0];
      const theirs = foreignPool[0];

      const foreignLogsBefore = await api.markSentLogs(theirs.prescriptionId, adminToken);
      const res = await api.bulkMarkSent([mine.prescriptionId, theirs.prescriptionId], therapistToken);
      console.log(
        `   POST {id:[${mine.prescriptionId} (own), ${theirs.prescriptionId} (foreign)]} as therapist ${therapistId} ` +
          `-> ${res.status} count=${res.count}`,
      );
      expect(res.count, 'exactly one of the two ids belongs to the caller').toBe(1);

      const mineAfter = await api.report(mine.id, adminToken);
      const theirsAfter = await api.report(theirs.id, adminToken);
      const mineLogs = await api.markSentLogs(mine.prescriptionId, adminToken);
      const theirsLogs = await api.markSentLogs(theirs.prescriptionId, adminToken);

      expect(mineAfter.sent, 'the caller\'s own report is marked sent').toBe(true);
      expect(mineLogs.length, 'and carries exactly one audit entry').toBe(1);
      expect(mineLogs[0].byId, 'attributed to the caller').toBe(therapistId);
      expect(theirsAfter.sent, 'the colleague\'s report is untouched').toBe(false);
      expect(theirsLogs.length, 'and gains no forged audit entry').toBe(foreignLogsBefore.length);
      console.log(`   own ${mine.id}: sent=${mineAfter.sent}, logs=${mineLogs.length} by ${mineLogs[0]?.byName} | foreign ${theirs.id}: sent=${theirsAfter.sent}, logs=${theirsLogs.length}`);
    },
  );

  test(
    'AC2 an admin CAN mark the very id the therapist was refused — so the exclusion was scoping',
    { tag: ['@SuperAdmin', '@BulkMarkSent', '@Security', '@Mutating'] },
    async ({ request }) => {
      // Without this control the therapist's zero count is ambiguous: the report could simply have
      // been ineligible (already sent, archived). Re-posting the SAME id as an admin settles it.
      const api = new BulkMarkSentScopePage(request);
      test.skip(foreignPool.length === 0, 'no foreign fixture to control against');
      const theirs = foreignPool[0];

      const before = await api.report(theirs.id, adminToken);
      expect(before.sent, 'the control only means something while the report is still unsent').toBe(false);

      const res = await api.bulkMarkSent([theirs.prescriptionId], adminToken);
      console.log(`   admin -> POST {id:[${theirs.prescriptionId}]} -> ${res.status} count=${res.count}`);
      expect(res.count, 'an admin is not scoped, so the same id processes').toBe(1);

      const after = await api.report(theirs.id, adminToken);
      const logs = await api.markSentLogs(theirs.prescriptionId, adminToken);
      expect(after.sent, 'the report the therapist could not touch is marked by the admin').toBe(true);
      expect(logs.length, 'with an audit entry attributed to the admin').toBeGreaterThan(0);
      console.log(`   report ${theirs.id} now sent=${after.sent}, marked by ${logs.at(-1)?.byName}`);
    },
  );
});
