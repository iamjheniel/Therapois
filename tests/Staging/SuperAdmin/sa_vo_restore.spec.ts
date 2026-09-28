import { test, expect } from '@playwright/test';
import {
  VoDeletionPage,
  FIXTURES,
  GERMAN,
  I18N_KEYS,
  RESTORE_BLOCKED,
  RESTORE_PARENT_CHOICES,
  RESTORE_WINDOW_DAYS,
  STAGING_WEB,
  type LogRow,
} from '../../../Pages/superadmin/sa.vo-deletion.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * The newest log row of a type.
 *
 * The Verlauf is permanent by design (#3671 AC 13), so a fixture that is deleted and restored once
 * per run accumulates a pair each time — a plain `find()` keeps returning the FIRST run's entry,
 * which is however old this file is, and every "who / when" assertion on it then fails for a reason
 * that has nothing to do with the code under test.
 */
function newestLog(logs: LogRow[], type: string): LogRow | undefined {
  return logs
    .filter((l) => l.type === type)
    .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0];
}

/**
 * RC 3.14 — restore a deleted VO within 30 days (#3674, PR #3702).
 *
 * #3671 made deletion reversible in principle; this ticket is the reversal, together with the
 * follow-up (F.VO) re-linking step that puts back the link the deletion removed. **Deployed and
 * verified live: AC 1, AC 2, AC 3 and AC 4 pass; AC 5 has no fixture and is `fixme`'d.**
 *
 * **The delete → restore round trip is the test, and it is genuinely lossless for a PARENT link.**
 * `PrescriptionDeletionService` snapshots `{parentId, parentFollowupStatus, parentReceivedDate,
 * childId}` into the deletion record BEFORE it unwires anything, and `relinkSnapshotParent()` puts
 * the first three back verbatim. It even suppresses `FollowUpStatusListener` for that one flush —
 * otherwise the listener would stamp the received date to NOW and overwrite the very field the
 * "keep" choice exists to restore. The AC 3 test below checks that date to the millisecond, because
 * a restore that re-links but re-dates looks correct on every other field.
 *
 * **`childId` is snapshotted and never read back — reported as a finding.** Restore only ever
 * re-links the PARENT. So an admin who deletes a VO that was itself a parent, then restores it,
 * silently loses the link to its follow-up child, and no dialog mentions it: #3671 AC 7 announces
 * the severing as informational ("the follow-up VO continues as a standalone VO") and #3674 says
 * nothing about putting it back, while the epic's End Goal says the VO "returns exactly as it was".
 * The field is written for a reason, which is what makes the omission look unintended.
 *
 * **AC 5 cannot be produced.** `window_expired` needs a VO deleted more than 30 days ago;
 * `deletedAt` is settable only by `PrescriptionDeletionService` (no write group, no Doctrine Delete
 * operation) and nothing can back-date it, so the earliest observable instance on staging is 30 days
 * after the first deletion anyone makes. What IS asserted is everything around it: the guard's other
 * two codes, the window arithmetic the guard compares against, and the German for all three blocked
 * states in the deployed dictionary.
 *
 * **Traps:** `restore-preflight` answers **200 with `blocked: {type: "not_deleted"}`** on a live VO
 * rather than 404 — so a status check alone reads as "restore is available for every VO"; the
 * restore payload's key is `parentChoice`, and `different` additionally needs `parentId` (a numeric
 * entity id, not an IRI); and a restore with no `parentChoice` at all defaults to `standalone`,
 * which silently drops a parent link — so a caller that omits it does not get "keep".
 *
 * Run at `--workers=1`: this file and #3671/#3672 share one fixture pool.
 */

test.describe('#3674 restore a deleted VO within its 30-day window', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1/AC5 the restore guard: its three codes, and the window it measures against',
    { tag: ['@SuperAdmin', '@VoRestore', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // A live VO is not 404 — it is 200 with a blocker, which is how the dialog knows to say
      // "Diese VO ist nicht gelöscht" rather than failing to open.
      const live = await api.restorePreflight(FIXTURES.spare.id, token);
      console.log(`#3674 live VO restore-preflight: blocked=${JSON.stringify(live.blocked)} window=${live.restoreWindowDays}`);

      expect(live.blocked?.type, 'AC5: a VO that is not deleted cannot be restored').toBe(RESTORE_BLOCKED.notDeleted);
      expect(live.restoreWindowDays, 'the window comes from Prescription::DELETION_RESTORE_WINDOW_DAYS').toBe(
        RESTORE_WINDOW_DAYS,
      );
      expect(live.summary.deletedAt, 'nothing to show for a live VO').toBeNull();
      expect(live.summary.restorableUntil).toBeNull();
      // AC 2's "Status returning to" — present even before deletion, because it is just the VO's
      // own status, which the deletion never touches.
      expect(live.summary.treatmentStatus).toBeTruthy();
    },
  );

  test(
    'AC1 restore is Admin/Super-Admin only',
    { tag: ['@SuperAdmin', '@VoRestore', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const therapist = await api.therapistToken();

      const pre = await api.restorePreflightRaw(FIXTURES.spare.id, therapist);
      // Empty body: `RestorePrescriptionController` denies access as its first statement, so this
      // can never restore anything even if the guard were missing (#3550's technique).
      const restore = await api.restoreVo(FIXTURES.spare.id, {}, therapist);
      console.log(`#3674 AC1 therapist: restore-preflight ${pre.status} | PATCH /restore ${restore.status}`);

      expect(pre.status).toBe(403);
      expect(restore.status).toBe(403);
      expect(JSON.stringify(restore.body)).toContain('Only Admins can restore VOs.');
    },
  );

  test(
    'AC2/AC4 a standalone VO returns with its exact pre-deletion status, and the Verlauf records it',
    { tag: ['@SuperAdmin', '@VoRestore', '@Mutating'] },
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

      try {
        expect((await api.deleteVo(vo.id, { reason: 'duplicate' }, token)).status).toBe(200);

        const pf = await api.restorePreflight(vo.id, token);
        console.log(`#3674 preflight while deleted: ${JSON.stringify(pf)}`);
        expect(pf.blocked, 'AC1: inside the window, restore is on offer').toBeNull();
        expect(pf.summary.treatmentStatus, 'AC2: "Status returning to" is the preserved status').toBe(
          snapshot.treatmentStatus,
        );
        expect(pf.previousParent, 'this fixture had no parent, so there is no re-link step').toBeNull();

        const at = Date.now();
        const res = await api.restoreVo(vo.id, { parentChoice: 'standalone' }, token);
        console.log(`#3674 restore: ${res.status} deletedAt=${res.body?.deletedAt} status=${res.body?.treatmentStatus}`);

        expect(res.status).toBe(200);
        expect(res.body?.deletedAt ?? null, 'AC2: no longer deleted').toBeNull();
        expect(res.body?.deletionReason ?? null, 'and the reason is cleared with it').toBeNull();
        expect(res.body?.treatmentStatus, 'AC2: the EXACT pre-deletion status').toBe(snapshot.treatmentStatus);

        const after = await api.prescription(vo.id, token);
        expect(after.body?.followupStatus ?? null, 'restore touches no other field').toBe(snapshot.followupStatus);
        expect(after.body?.validationStatus ?? null).toBe(snapshot.validationStatus);

        // AC 4 — one Verlauf entry for the restore, carrying who and when, plus the choice as a
        // code and an internal id (never a VO number — the deletion record holds ids only).
        //
        // The Verlauf is permanent, so this fixture accumulates one pair per run: take the NEWEST
        // entry, or a `find()` keeps returning the first run's.
        const entry = newestLog(await api.logs(vo.id, token), I18N_KEYS.logRestored);
        console.log(`#3674 AC4: ${JSON.stringify(entry)}`);
        expect(entry, 'AC4: a prescription_restored entry').toBeTruthy();
        expect(entry?.createdByName, 'AC4: who restored it').toBeTruthy();
        expect(Date.parse(entry?.createdAt ?? ''), 'AC4: when').toBeGreaterThanOrEqual(at - 120_000);
        expect(entry?.meta?.parentChoice, 'the choice is recorded').toBe('standalone');

        // Restoring twice is refused rather than writing a second entry.
        const again = await api.restoreVo(vo.id, { parentChoice: 'standalone' }, token);
        expect(again.status, 'a live VO cannot be restored').toBe(409);
        expect((again.body as { blocked?: { type: string } } | null)?.blocked?.type).toBe(RESTORE_BLOCKED.notDeleted);
      } finally {
        console.log(`#3674 cleanup ${vo.vo}: ${await api.ensureRestored(vo.id, 'standalone', token)}`);
      }
    },
  );

  test(
    'AC3 "keep" puts the parent link back exactly — status AND received date, not re-dated to today',
    { tag: ['@SuperAdmin', '@VoRestore', '@Mutating'] },
    async ({ request }) => {
      test.setTimeout(420_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const child = FIXTURES.childWithParent;

      const parentBefore = await api.prescription(child.parentId, token);
      const childBefore = await api.prescription(child.id, token);
      const parentSnapshot = {
        followupStatus: parentBefore.body?.followupStatus ?? null,
        receivedDate: parentBefore.body?.receivedDate ?? null,
      };
      console.log(`#3674 AC3 parent ${child.parentVo} before: ${JSON.stringify(parentSnapshot)}`);
      expect(childBefore.body?.deletedAt ?? null, 'the fixture starts live').toBeNull();
      expect(parentSnapshot.followupStatus, 'the parent really claims this VO as its follow-up').toBeTruthy();

      try {
        // "unchanged" is the choice that keeps the parent closest to where it was — and it is also
        // the one that exposes #2539's reverse reset: a parent sitting at "Erhalten" is a statement
        // about a follow-up that is about to stop existing, so the service resets it to null.
        const del = await api.deleteVo(child.id, { reason: 'duplicate', parentChoice: 'unchanged' }, token);
        expect(del.status, `delete ${child.vo}`).toBe(200);

        const parentAfterDelete = await api.prescription(child.parentId, token);
        console.log(
          `#3674 AC6(#3671) parent after delete: followupStatus=${parentAfterDelete.body?.followupStatus ?? 'null'} receivedDate=${parentAfterDelete.body?.receivedDate ?? 'null'}`,
        );
        expect(
          parentAfterDelete.body?.followupPrescription ?? null,
          '#3671 AC6: the link is removed from the parent',
        ).toBeNull();

        // AC 3 — the preflight shows the pre-deletion link and whether putting it back is possible.
        const pf = await api.restorePreflight(child.id, token);
        console.log(`#3674 AC3 previousParent: ${JSON.stringify(pf.previousParent)}`);
        expect(pf.previousParent, 'AC3: the link the deletion removed is shown').toBeTruthy();
        expect(pf.previousParent?.id).toBe(child.parentId);
        expect(pf.previousParent?.prescriptionId, "resolved from the parent row — the snapshot holds ids only").toBe(
          child.parentVo,
        );
        expect(pf.previousParent?.snapshotFollowupStatus, 'the parent status as it stood at deletion').toBe(
          parentSnapshot.followupStatus,
        );
        expect(pf.previousParent?.keepAvailable, 'AC3: "keep the same parent" is on offer').toBe(true);
        expect(pf.previousParent?.keepUnavailableReason ?? null).toBeNull();

        const res = await api.restoreVo(child.id, { parentChoice: 'keep' }, token);
        expect(res.status, 'AC3: restore with "keep"').toBe(200);

        const parentAfter = await api.prescription(child.parentId, token);
        const restoredLink =
          typeof parentAfter.body?.followupPrescription === 'object'
            ? (parentAfter.body?.followupPrescription as { prescriptionId?: string })?.prescriptionId
            : parentAfter.body?.followupPrescription;
        console.log(
          `#3674 AC3 parent after restore: link=${restoredLink} followupStatus=${parentAfter.body?.followupStatus} receivedDate=${parentAfter.body?.receivedDate}`,
        );

        expect(restoredLink, 'AC3: the parent claims this VO again').toBe(child.vo);
        expect(parentAfter.body?.followupStatus ?? null, 'AC3: with the status it had before').toBe(
          parentSnapshot.followupStatus,
        );
        // The sharp one. `FollowUpStatusListener` stamps the received date to NOW on any
        // followupStatus change, which would quietly replace the date this choice exists to
        // restore; the service disables it for exactly this flush. Equal to the millisecond, not
        // "recent".
        expect(parentAfter.body?.receivedDate ?? null, 'AC3: and the ORIGINAL received date, not today').toBe(
          parentSnapshot.receivedDate,
        );

        const entry = newestLog(await api.logs(child.id, token), I18N_KEYS.logRestored);
        expect(entry?.meta?.parentChoice, 'AC4: the choice is recorded').toBe('keep');
        expect(entry?.meta?.parentId, 'as an internal id').toBe(child.parentId);
      } finally {
        const outcome = await api.ensureRestored(child.id, 'keep', token);
        console.log(`#3674 cleanup ${child.vo}: ${outcome}`);
        const parentBack = await api.prescription(child.parentId, token);
        expect(parentBack.body?.followupStatus ?? null, 'the parent is left as it was found').toBe(
          parentSnapshot.followupStatus,
        );
        expect(parentBack.body?.receivedDate ?? null).toBe(parentSnapshot.receivedDate);
      }
    },
  );

  test(
    'AC3 the "different parent" choice refuses what it must, and nothing is written either way',
    { tag: ['@SuperAdmin', '@VoRestore', '@Mutating'] },
    async ({ request }) => {
      test.setTimeout(420_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const vo = FIXTURES.spare;

      // **The order inside the service matters and is easy to get wrong.** `restore()` resolves the
      // BLOCKER first and only then validates the payload, so on a live VO every one of these
      // answers 409 `not_deleted` — a test written against a live VO measures the blocker, not the
      // payload guards, and concludes the vocabulary is open. They are only reachable on a VO that
      // really is deleted.
      const onLiveVo = await api.restoreVo(vo.id, { parentChoice: 'sideways' }, token);
      console.log(`#3674 AC3: a nonsense choice on a LIVE VO -> ${onLiveVo.status} (the blocker runs first)`);
      expect(onLiveVo.status).toBe(409);
      expect((onLiveVo.body as { blocked?: { type: string } } | null)?.blocked?.type).toBe(RESTORE_BLOCKED.notDeleted);

      try {
        expect((await api.deleteVo(vo.id, { reason: 'duplicate' }, token)).status).toBe(200);

        const unknownChoice = await api.restoreVo(vo.id, { parentChoice: 'sideways' }, token);
        const missingParent = await api.restoreVo(vo.id, { parentChoice: 'different' }, token);
        const deletedParent = await api.restoreVo(vo.id, { parentChoice: 'different', parentId: vo.id }, token);
        const missingParentRow = await api.restoreVo(vo.id, { parentChoice: 'different', parentId: 999_000_001 }, token);
        console.log(
          `#3674 AC3 payload guards: unknown choice -> ${unknownChoice.status}; "different" with no parentId -> ${missingParent.status}; ` +
            `itself as parent -> ${deletedParent.status}; nonexistent parent -> ${missingParentRow.status}`,
        );

        expect(unknownChoice.status, 'the choice vocabulary is closed').toBe(422);
        expect(JSON.stringify(unknownChoice.body)).toContain('Unknown parent choice');
        expect(missingParent.status, 'AC3: "different" needs a parent').toBe(422);
        expect(JSON.stringify(missingParent.body)).toContain('parent VO is required');
        // Two guards the edit form gets for free from its candidate list and this endpoint has to
        // state for itself, because the linker resolves its parent with a plain `find()`.
        expect(deletedParent.status, 'a VO cannot be its own follow-up parent').toBe(422);
        expect(missingParentRow.status, 'and the chosen parent has to exist').toBe(422);

        expect(RESTORE_PARENT_CHOICES, 'the three AC3 options').toEqual(['keep', 'different', 'standalone']);
        const stillDeleted = await api.prescription(vo.id, token);
        expect(stillDeleted.body?.deletedAt, 'every refusal left the VO deleted — none of them restored it').toBeTruthy();
      } finally {
        console.log(`#3674 cleanup ${vo.vo}: ${await api.ensureRestored(vo.id, 'standalone', token)}`);
      }
    },
  );

  test(
    'AC1/AC5 the restore dialog and its three blocked states ship in the deployed dictionary',
    { tag: ['@SuperAdmin', '@VoRestore', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const bundle = await api.entryBundle();

      const counts = {
        title: VoDeletionPage.escapedCount(bundle, GERMAN.restoreTitle),
        action: VoDeletionPage.escapedCount(bundle, GERMAN.restoreAction),
        keepKey: VoDeletionPage.occurrences(bundle, I18N_KEYS.keepChoice),
        standalone: VoDeletionPage.escapedCount(bundle, GERMAN.restoreStandalone),
        different: VoDeletionPage.escapedCount(bundle, GERMAN.restoreDifferent),
        windowExpired: VoDeletionPage.escapedCount(bundle, GERMAN.restoreWindowExpired),
        anonymized: VoDeletionPage.escapedCount(bundle, GERMAN.restoreAnonymized),
        pendingTooltip: VoDeletionPage.occurrences(bundle, 'restore_pending_tooltip'),
      };
      console.log(`#3674 bundle: ${JSON.stringify(counts)}`);

      expect(counts.title, 'the restore dialog ships').toBeGreaterThan(0);
      expect(counts.action, 'AC1: the "Wiederherstellen" action').toBeGreaterThan(0);
      expect(counts.keepKey, "AC3: the keep-the-same-parent option").toBeGreaterThan(0);
      expect(counts.standalone, 'AC3: restore standalone').toBeGreaterThan(0);
      expect(counts.different, 'AC3: search for a different parent').toBeGreaterThan(0);
      // AC 5's message, and #3675's — the two states the guard reports that this suite cannot
      // manufacture. They ship, which is the half that is decidable from here.
      expect(counts.windowExpired, 'AC5: the expired-window message').toBeGreaterThan(0);
      expect(counts.anonymized, "#3675's message, for a dialog that was open when the job ran").toBeGreaterThan(0);
      // #3671 shipped the banner with an INERT restore button behind
      // `restore_pending_tooltip` ("Das Wiederherstellen wird mit einem folgenden Release
      // verfügbar."). Its absence is how you can tell #3674 actually landed on top of #3671 rather
      // than the epic having stopped at the placeholder.
      expect(counts.pendingTooltip, "#3671's placeholder tooltip is gone — #3674 replaced it").toBe(0);
    },
  );

  test(
    'AC1 the Wiederherstellen action on a deleted VO, on screen',
    { tag: ['@SuperAdmin', '@VoRestore', '@Mutating'] },
    async ({ page, request }) => {
      test.setTimeout(420_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const vo = FIXTURES.spare;

      try {
        expect((await api.deleteVo(vo.id, { reason: 'incorrect_data' }, token)).status).toBe(200);
        const pf = await api.restorePreflight(vo.id, token);

        await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
        await page.goto(`${STAGING_WEB}/vo-management/${vo.id}/edit?id=${vo.id}`, { waitUntil: 'domcontentloaded' });

        // #3671 AC 17's banner, now carrying #3674's live action.
        await expect(page.getByText(GERMAN.restoreAction, { exact: true }).first()).toBeVisible({ timeout: 150_000 });
        const body = await page.locator('body').innerText();
        const i = body.indexOf('Gelöscht am');
        console.log(`#3674 banner: ${body.slice(i, i + 300).replace(/\n+/g, ' | ')}`);

        expect(body, "#3671 AC17: the read-only banner").toContain('Gelöscht am');
        expect(body, 'naming the reason').toContain(GERMAN.reasonIncorrect);
        expect(body, 'and the date it stays restorable until').toContain('wiederherstellbar bis');
        expect(pf.blocked, 'the action is live, not the #3671 placeholder').toBeNull();
      } finally {
        console.log(`#3674 cleanup ${vo.vo}: ${await api.ensureRestored(vo.id, 'standalone', token)}`);
      }
    },
  );

  test(
    'FINDING: a restored VO never regains its follow-up CHILD link, though the snapshot records it',
    { tag: ['@SuperAdmin', '@VoRestore', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // Read-only on purpose: demonstrating the loss means deleting a VO that IS a parent, and the
      // link would not come back — which is the finding. So the asymmetry is shown from the shapes
      // instead: the deletion preflight reports BOTH directions, the restore preflight only one.
      const parentSide = await api.deletionPreflight(FIXTURES.withChildLink.id, token);
      const childSide = await api.deletionPreflight(FIXTURES.childWithParent.id, token);
      console.log(
        `#3674 FINDING: deletion-preflight reports childLink=${JSON.stringify(parentSide.childLink)} and parentLink=${JSON.stringify(childSide.parentLink)};` +
          ' restore-preflight exposes previousParent only.',
      );

      expect(parentSide.childLink, '#3671 AC7 knows about the child link').toBeTruthy();
      expect(childSide.parentLink, 'and about the parent link').toBeTruthy();

      const restorePf = await api.restorePreflight(FIXTURES.childWithParent.id, token);
      // 200 with `not_deleted` — the shape is still readable on a live VO, which is the point here.
      expect(restorePf.blocked?.type).toBe(RESTORE_BLOCKED.notDeleted);
      expect(
        Object.keys(restorePf),
        'the restore step has no child-link field at all: `previousParent` is the only link it offers',
      ).not.toContain('previousChild');

      console.log(
        '#3674 FINDING (for the PM): PrescriptionDeletionService snapshots `childId` into the deletion record ' +
          'alongside parentId/parentFollowupStatus/parentReceivedDate, but PrescriptionRestoreService never reads it. ' +
          'So deleting a VO that is a PARENT and restoring it leaves its follow-up permanently detached, with nothing ' +
          'in either dialog saying so. #3671 AC7 announces the severing as informational and #3674 AC3 covers only the ' +
          'parent direction, while the epic\'s End Goal says the VO "returns exactly as it was" — the snapshot field ' +
          'being written and never read is what makes this look like an oversight rather than a decision.',
      );
    },
  );
});
