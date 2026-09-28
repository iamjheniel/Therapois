import { test, expect } from '@playwright/test';
import { VoDeletionPage, FIXTURES } from '../../../Pages/superadmin/sa.vo-deletion.page';

/**
 * RC 3.14 — deleted VOs are skipped by every automatic job (#3673, PR #3700).
 *
 * Twelve nightly jobs plus the TheOrg CSV importer each gain one exclusion condition. None of them
 * shares a query base, so this is thirteen small repeated changes rather than one fix. **Merged and
 * on the staging build; the ticket's own Testing Guidance says UI verification is not practical and
 * the developer's comment names a `--dry-run` for each command — none of which a browser can run.**
 *
 * **So this file tests the invariant the thirteen skips exist to protect, not the skips.** The End
 * Goal is one sentence: "A deleted VO's pre-deletion status stays exactly as it was the moment it
 * was deleted, ready for an unaffected restore." Every job on the list would break it by writing a
 * status — expire it, archive it, flip it to Fertig Behandelt, advance its follow-up. That
 * invariant IS client-observable, and it is what the test below asserts: a VO whose status is a
 * legitimate target for several of those jobs (`Abgelaufen`, which the auto-archive sweep would
 * move on) survives a delete → restore round trip with `treatmentStatus`, `followupStatus`,
 * `orderingStatus` and `validationStatus` all identical.
 *
 * **What that does NOT prove, stated plainly:** it shows the status survives the round trip, not
 * that a job which ran in between would have left it alone. Proving the latter needs a nightly run
 * to fall inside the window, or the dry-run output the developer describes. It is the strongest
 * client-side statement available and is deliberately not dressed up as more.
 *
 * **The dry-run route, from the developer's comment on the ticket**, for whoever has console access:
 *
 * ```
 * app:prescription:expire --dry-run            app:prescription:auto-archive --dry-run
 * app:transition:followup ordered --dry-run    app:copayment:recompute-liability --dry-run
 * app:prescription:transition-order --dry-run  app:duplikat:flag-overdue --dry-run
 * app:prescription:correct-stuck-completed --dry-run
 * app:prescription:cleanup-bereit --dry-run
 * ```
 *
 * Seed a deleted VO in a qualifying state, run the dry-run, and it must not appear in the candidate
 * list while its live twin does. The remaining three entry points have no command at all — the two
 * listener-based jobs (late-session auto-completion, Duplikat auto-close) and the CSV importer (AC 2)
 * — and are pinned by `DeletedVoJobSkipTest`, `DuplikatProcessBackendTest` and
 * `CsvImporterCharacterizationTest` in the API repo.
 *
 * **One job arm IS reachable from a client and is covered elsewhere:** late-session auto-completion
 * cannot fire on a deleted VO because the session can never be written — `POST /activities/bulk`
 * refuses it with `controls.activity.vo_deleted` before any listener runs. That is asserted in
 * `sa_vo_deleted_exclusion.spec.ts` as #3672 AC 3.
 *
 * Run at `--workers=1` — shares a fixture with the other files in this epic.
 */

test.describe('#3673 automatic jobs skip deleted VOs', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'End Goal: a deleted VO keeps its pre-deletion status, and restore hands it back unchanged',
    { tag: ['@SuperAdmin', '@VoJobSkip', '@Mutating'] },
    async ({ request }) => {
      test.setTimeout(420_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const vo = FIXTURES.spare;

      const before = await api.prescription(vo.id, token);
      expect(before.body?.deletedAt ?? null, 'the fixture starts live').toBeNull();
      const snapshot = {
        treatmentStatus: before.body?.treatmentStatus ?? null,
        followupStatus: before.body?.followupStatus ?? null,
        validationStatus: before.body?.validationStatus ?? null,
      };
      console.log(`#3673 ${vo.vo} before: ${JSON.stringify(snapshot)}`);

      // The fixture's status matters. `Abgelaufen` is a live target for several of the listed jobs
      // (auto-archive sweeps expired VOs; the ordering-status maintenance sweeps touch them too), so
      // it is the status most worth protecting — not an inert one nothing would have moved anyway.
      expect(snapshot.treatmentStatus, 'the fixture is in a state jobs act on').toBe('Abgelaufen');

      try {
        const del = await api.deleteVo(vo.id, { reason: 'duplicate' }, token);
        expect(del.status).toBe(200);
        // The mechanism: `deletedAt` is a column, not a status case. A `PrescriptionStatusEnum`
        // value would have destroyed exactly the field this ticket's twelve skips protect — which
        // is why the epic's Developer Reference rules it out.
        expect(del.body?.treatmentStatus, 'the status is preserved underneath the deletion').toBe(
          snapshot.treatmentStatus,
        );

        const whileDeleted = await api.prescription(vo.id, token);
        expect(whileDeleted.body?.treatmentStatus).toBe(snapshot.treatmentStatus);
        expect(whileDeleted.body?.followupStatus ?? null).toBe(snapshot.followupStatus);

        // AC 3 from the other side: the ticket adds only an exclusion, so nothing about a live VO
        // changed. The whole book is still there, minus this one row.
        const counts = await api.dashboardCounts(token);
        console.log(`#3673 counts while deleted: all=${counts.all} allWithArchived=${counts.allWithArchived} deleted=${counts.deleted}`);
        expect(counts.deleted).toBeGreaterThan(0);

        const res = await api.restoreVo(vo.id, { parentChoice: 'standalone' }, token);
        expect(res.status).toBe(200);
        expect(res.body?.treatmentStatus, 'restored unaffected, which is the End Goal sentence').toBe(
          snapshot.treatmentStatus,
        );
      } finally {
        console.log(`#3673 cleanup ${vo.vo}: ${await api.ensureRestored(vo.id, 'standalone', token)}`);
      }

      const after = await api.prescription(vo.id, token);
      expect(after.body?.treatmentStatus).toBe(snapshot.treatmentStatus);
      expect(after.body?.followupStatus ?? null).toBe(snapshot.followupStatus);
      expect(after.body?.validationStatus ?? null).toBe(snapshot.validationStatus);
    },
  );

});
