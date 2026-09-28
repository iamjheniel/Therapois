import { test, expect } from '@playwright/test';
import { VoDeletionPage, FIXTURES, GERMAN, RESTORE_BLOCKED, RESTORE_WINDOW_DAYS } from '../../../Pages/superadmin/sa.vo-deletion.page';

/**
 * RC 3.14 — anonymize deleted VOs after 30 days (#3675, PR #3703, merged 2026-09-16).
 *
 * A nightly job (`app:prescription:anonymize-deleted`, EventBridge 03:15 UTC) permanently scrubs a
 * VO deleted more than 30 days ago: patient, doctor, practice, diagnosis, free text and the VO
 * number are nulled on the row, every related record is deleted outright with the blobs behind it,
 * and what remains is a non-identifying trace plus #3671's permanent deletion record.
 *
 * **This file was written on 2026-09-17 against an epic that had NEVER anonymized anything, and it
 * is now re-verified against a staging where the job has run twice — once by hand and once by
 * itself.** On 2026-09-22 the dev back-dated two QA VOs with raw SQL (the only way a `deletedAt`
 * older than the epic's own deploy can exist) and ran the command for one of them. That left three
 * fixtures on QA patient 8950, all deleted inside the same minute:
 *
 *  - **34978 / 99653-2** — anonymized by the hand-run command, 2026-09-22 10:22 UTC.
 *  - **34979 / 99653-3** — deleted, not back-dated. The control.
 *  - **34980 / 99653-4** — back-dated to 2026-08-22, left un-scrubbed, and therefore the first VO
 *    the NIGHTLY job ever had to find on its own.
 *
 * **It found it, and that is the one thing no PM evidence on this ticket could cover.** The Go-Live
 * Prerequisite calls scheduling "external infrastructure … a task for the infrastructure owner",
 * and every run on record was a human typing the command. Watched across the boundary on
 * 2026-09-23: `/prescriptions/34980` answered **200 at 03:16:02Z and 404 at 03:18:07Z**, with the
 * Gelöscht tab going 7 → 6 — the EventBridge rule firing unattended at its 03:15 UTC slot.
 *
 * **The controls are the whole method.** Every positive result here is a ZERO — no logs, no
 * activities, no row, no tab entry — and a zero means nothing on its own, because "scrubbed" and
 * "hidden from this reader" look identical from outside. Two VOs deleted in the same minute, on the
 * same patient, one anonymized and one not, is what separates them: 34979 answers 3 where 34978
 * answers 0, on a collection that demonstrably does not hide deleted VOs.
 *
 * **That is also the gap in the PM's own evidence, and it is worth stating plainly.** Their AC-1
 * and AC-2 rows read "Patient, doctor, practice, diagnosis, notes, and VO number all removed" and
 * "Documents and images removed", with the Surface recorded as *API* and the observation recorded
 * as a 404. A 404 is exactly what `PrescriptionNotDeletedExtension` produces for an anonymized row
 * whether or not a single field was cleared — it adds `anonymizedAt IS NULL` to both admin doors —
 * so the 404 establishes AC 4 and cannot, even in principle, establish AC 1. The field-level
 * evidence is Jarn's console output, not the API. What this file adds on top of the 404 is the
 * related-record half of AC 2, which IS client-visible and which nobody checked.
 *
 * **Still not reachable from any client, and the `fixme`s below say which is which:**
 *
 *  - **AC 1 / AC 3's positive half — the non-identifying trace that SURVIVES.** Every admin door
 *    carries `anonymizedAt IS NULL`, so the scrubbed row cannot be read back at all. "The patient
 *    is gone" and "the whole row is gone" are indistinguishable from here.
 *  - **AC 6 / AC 7 — batching, the per-VO record and preview mode.** Properties of the command's
 *    own output: the console log and one CSV per VO under
 *    `reports/AnonymizeDeletedPrescriptionsCommand/`. Covered upstream by
 *    `AnonymizeDeletedPrescriptionsCommandTest` and `PrescriptionAnonymizerServiceTest`.
 *
 * **The AC 3 detail worth flagging to the PM, from the implementation rather than the ticket:**
 * invoices are deliberately KEPT with their FK intact, and reported per VO as `invoicesKept`. AC 3
 * says "no patient-identifying information remains anywhere for that VO", and an invoice is a
 * statutory record under GDPR Art. 17(3)(b) — the same basis `InvoiceRetentionListener` already
 * encodes (#3492). A sound exception, but one the AC does not name, and a DPO reading AC 3
 * literally would expect nothing to survive. (Neither fixture carries one, so it is unexercised
 * here as well as unnamed there.)
 *
 * **Trap:** an anonymized VO stays `deletedAt IS NOT NULL` on purpose — anonymizing is not
 * undeleting — so every predicate #3672 and #3673 wrote keeps working and the VO number stays
 * reserved for nobody. A check written as "anonymized ⇒ no longer deleted" is backwards.
 *
 * **Second trap, and it is why the therapist leg is not used as evidence:** a therapist gets 404 on
 * a merely-deleted VO too (#3672). Only the ADMIN door tells the two states apart — 200 for
 * deleted, 404 for anonymized. Verified live on all three fixtures.
 *
 * **Read-only.** Nothing here deletes, restores or anonymizes: the anonymized VO cannot be written
 * to, and un-deleting the candidate would destroy the single live instance of the state under test.
 */

test.describe('#3675 anonymize deleted VOs after 30 days', () => {
  test.describe.configure({ mode: 'serial' });

  /** `deletedAt` → age in days, against one resolved "now" so two reads cannot disagree by a day. */
  const ageDays = (iso: string | null | undefined, now: number) =>
    iso ? (now - Date.parse(iso)) / 86_400_000 : null;

  test(
    'AC4 the anonymized VO is gone from the Gelöscht tab, its badge count and the admin item read — its control is not',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const { anonymized, anonymizeControl } = FIXTURES;

      const tab = await api.deletedTab(token, 200);
      const counts = await api.dashboardCounts(token);
      const ids = tab.rows.map((r) => r.id);
      console.log(`#3675 AC4: Gelöscht tab total=${tab.total} badge=${counts.deleted} ids=${JSON.stringify(ids)}`);

      // The tab and the badge are separate reads (`exists[deletedAt]` vs `DashboardCountsProvider`)
      // and AC 4 is about both — "no longer appears in the Gelöscht tab" is a count as much as a row.
      expect(counts.deleted, 'the badge agrees with the tab it labels').toBe(tab.total);
      expect(ids, `AC4: ${anonymized.vo} (anonymized) is off the tab`).not.toContain(anonymized.id);
      expect(counts.deleted, 'and therefore out of the badge count').toBe(ids.length);

      // Without this the line above is satisfied by an empty tab, a broken filter or a VO that was
      // never deleted. The control was deleted in the same minute, by the same admin, on the same
      // patient — the only difference between them is the anonymization.
      expect(ids, `and its control ${anonymizeControl.vo} IS still there`).toContain(anonymizeControl.id);

      const anon = await api.prescription(anonymized.id, token);
      const ctrl = await api.prescription(anonymizeControl.id, token);
      console.log(`#3675 AC4: admin item read — ${anonymized.vo}=${anon.status} ${anonymizeControl.vo}=${ctrl.status}`);
      expect(anon.status, 'AC4: nothing left for an admin to view or restore').toBe(404);
      expect(ctrl.status, 'while a merely-deleted VO stays openable by an admin (#3671 AC 15)').toBe(200);
    },
  );

  test(
    'AC2 the anonymized VO kept none of its related records — both same-minute controls kept theirs',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const { anonymized, anonymizeControl, anonymizedByNightly } = FIXTURES;

      // `prescription_logs` is the load-bearing one: it is NOT behind the not-deleted extension, so
      // it reports a DELETED VO's Verlauf perfectly well. That is what turns a zero into evidence —
      // the reader is demonstrably willing to show this data for a deleted VO, and shows none for
      // the anonymized one. `deleteRelatedRecords()` takes the whole Verlauf on purpose, the
      // `prescription_deleted` and `prescription_restored` entries included; the permanent
      // `PrescriptionDeletionRecord` (AC 3) is a separate table and is what survives.
      const [anonLogs, nightlyLogs, ctrlLogs] = await Promise.all([
        api.logs(anonymized.id, token),
        api.logs(anonymizedByNightly.id, token),
        api.logs(anonymizeControl.id, token),
      ]);
      console.log(
        `#3675 AC2 Verlauf: ${anonymized.vo}=${anonLogs.length} (manual run) | ` +
          `${anonymizedByNightly.vo}=${nightlyLogs.length} (nightly run) | ${anonymizeControl.vo}=${ctrlLogs.length} (control)`,
      );
      expect(ctrlLogs.length, 'the control keeps its Verlauf, so the collection does not hide deleted VOs').toBeGreaterThan(0);
      expect(anonLogs.length, `AC2: ${anonymized.vo}'s whole change history is gone`).toBe(0);
      // The nightly one matters separately: it is the only fixture whose scrub nobody supervised.
      expect(nightlyLogs.length, `AC2: and so is ${anonymizedByNightly.vo}'s, scrubbed unattended`).toBe(0);

      const [anonActs, anonInvs, patientReports] = await Promise.all([
        api.activitiesFor(anonymized.id, token),
        api.invoicesFor(anonymized.id, token),
        api.therapyReportsForPatient(anonymized.patientId, token),
      ]);
      console.log(
        `#3675 AC2 related: activities=${anonActs} therapyReports(patient ${anonymized.patientId})=${patientReports} invoices=${anonInvs}`,
      );
      expect(anonActs, 'AC2: no documented session survives').toBe(0);
      expect(patientReports, 'AC2: no therapy report survives on the patient these fixtures share').toBe(0);

      // NOT an AC 2 assertion — the opposite. Invoices are deliberately kept (`invoicesKept`), so
      // this records which case the fixture exercises rather than demanding a zero. It happens to
      // carry none, which is why the retained-invoice exception is unexercised on staging.
      console.log(`#3675 AC3 note: invoicesKept would be ${anonInvs} for this VO — the Art. 17(3)(b) exception is unexercised here.`);
    },
  );

  test(
    'AC4 the VO number is unfindable on the one door that still shows deleted numbers',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const { anonymized, anonymizeControl, anonymizedByNightly } = FIXTURES;

      // **A control killed the obvious version of this test, and the corrected version is worth
      // more than the one it replaced.** The first attempt searched `exact[prescriptionId]` on the
      // plain collection, found 0 for the anonymized number and read that as AC 1's nulling. But
      // the control answered 0 as well: the plain collection hides every deleted VO, so it is blind
      // to all three fixtures and can distinguish nothing. Measured: 99653-1 (live) → 1;
      // 99653-2, -3 and -4 → 0 alike.
      const plain = await Promise.all([
        api.findByNumber(anonymized.vo, token),
        api.findByNumber(anonymizeControl.vo, token),
      ]);
      console.log(`#3675: plain exact[prescriptionId] ${anonymized.vo}=${plain[0].length} ${anonymizeControl.vo}=${plain[1].length} (both 0 — the collection hides deleted VOs, not just anonymized ones)`);
      expect(plain[1], 'the control confirms the plain collection cannot discriminate here').toEqual([]);

      // The door that CAN see a deleted VO's number is the tab's own — and there the control
      // resolves while neither anonymized VO does.
      const [gone, nightlyGone, ctrlHit] = await Promise.all([
        api.findDeletedByNumber(anonymized.vo, token),
        api.findDeletedByNumber(anonymizedByNightly.vo, token),
        api.findDeletedByNumber(anonymizeControl.vo, token),
      ]);
      console.log(`#3675 AC4: tab-scoped exact[prescriptionId] ${anonymized.vo}=${JSON.stringify(gone)} ${anonymizedByNightly.vo}=${JSON.stringify(nightlyGone)} ${anonymizeControl.vo}=${JSON.stringify(ctrlHit)}`);
      expect(ctrlHit, 'a deleted VO IS findable by its number on the Gelöscht door').toEqual([anonymizeControl.id]);
      expect(gone, `AC4: ${anonymized.vo} is not, on any door`).toEqual([]);
      expect(nightlyGone, `AC4: nor is ${anonymizedByNightly.vo}`).toEqual([]);

      // **What this does NOT establish, and the distinction matters for the PM's AC-1 row.** The
      // zero above has two sufficient causes — `scrubRow()` NULLs `prescriptionId`, AND
      // `PrescriptionNotDeletedExtension` drops the row from this door on `anonymizedAt IS NULL`
      // regardless of what its number holds. Either alone produces it, so this is a third AC 4
      // door rather than evidence that the number was cleared. **AC 1's nulling is not separable
      // from the row being hidden by any client read** — except indirectly, through the allocator,
      // which is the next test.
      const live = await api.prescriptionsForPatient(anonymized.patientId, token);
      expect(live.ids, 'and it is off the patient it used to belong to').not.toContain(anonymized.id);
    },
  );

  test(
    'FINDING: anonymizing a VO RELEASES its number back to the allocator, against #3672 AC 4',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const { anonymizedByNightly, anonymizeControl } = FIXTURES;

      // **This is the one experiment that resolved AC 1's nulling from outside, and it only became
      // possible when the nightly job took a VO holding the HIGHEST suffix on its patient.** An
      // earlier version of this file asserted `next-id === '99653-5'` and noted in its own comment
      // that the result "does not isolate the anonymized row — a fixture whose number was the
      // highest would". On 2026-09-23 the nightly run produced exactly that fixture, and the
      // answer went the other way:
      //
      //   02:38 UTC, 99653-4 deleted but not yet scrubbed → next-id **99653-5**
      //   03:18 UTC, 99653-4 anonymized                   → next-id **99653-4**
      //
      // So the allocator maxes over the numbers that still EXIST, and #3675 AC 1 NULLs
      // `prescriptionId` — which hands the number straight back. That also settles AC 1 positively
      // by inference: the column really was cleared, because nothing else would move this figure.
      const next = await api.nextPrescriptionId(anonymizedByNightly.patientId, token);
      const stillVisible = await api.findDeletedByNumber(anonymizeControl.vo, token);
      console.log(
        `#3675 FINDING: next-id for patient ${anonymizedByNightly.patientId} = ${next}; ` +
          `${anonymizedByNightly.vo} was anonymized by the nightly run and its number is free again ` +
          `(the un-anonymized ${anonymizeControl.vo} is still held: ${JSON.stringify(stillVisible)}).`,
      );

      // #3672 AC 4 is explicit that the allocator must keep counting deleted VOs "so a replacement
      // never reuses a number", and #3672's own spec asserts that a delete/restore round trip
      // leaves `next-id` unmoved. Anonymization breaks it: the next VO created for this patient is
      // numbered 99653-4, which an earlier — now unidentifiable — VO already carried. The patient's
      // VO history then reads as continuous when it is not, and any external reference to that
      // number (a scanned paper VO, a retained Invoice row, an Optica line) becomes ambiguous.
      //
      // Retained invoices make this more than cosmetic in principle: AC 3 keeps Invoice rows with
      // their FK intact, so a surviving invoice can point at a VO whose number has since been
      // re-issued to a different one. Neither fixture carries an invoice, so that combination is
      // unexercised on staging — flagged as reachable, not as observed.
      //
      // Asserted as the CURRENT behaviour rather than the desired one, so the test reports the
      // finding and flips the day someone reconciles the two tickets.
      expect(next, 'the released number is handed out again — the finding this test exists to pin').toBe(
        anonymizedByNightly.vo,
      );
      expect(stillVisible, 'while a merely-deleted number is still reserved (#3672 AC 4 holding where it applies)').toEqual([
        anonymizeControl.id,
      ]);
    },
  );

  test(
    'AC5 every VO still on the tab is inside its window and still readable, and the boundary is deletedAt + 30d',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      const tab = await api.deletedTab(token, 200);
      const now = Date.now();
      const rows = tab.rows.map((r) => ({ id: r.id, vo: r.prescriptionId, deletedAt: r.deletedAt, age: ageDays(r.deletedAt, now) }));
      rows.sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
      console.log(`#3675 AC5: ${tab.total} deleted VO(s) — ${JSON.stringify(rows.map((r) => ({ vo: r.vo, age: Number((r.age ?? 0).toFixed(2)) })))}`);

      const inside = rows.filter((r) => (r.age as number) < RESTORE_WINDOW_DAYS);
      const overdue = rows.filter((r) => (r.age as number) >= RESTORE_WINDOW_DAYS);

      for (const r of rows) expect(r.age, `${r.vo} carries a deletion timestamp`).not.toBeNull();

      // AC 5 is about the ones the job must LEAVE, and every one of them is still on the tab and
      // still readable — which is the AC's own wording ("visible and restorable exactly as #3671
      // and #3674 describe"), not merely "not anonymized".
      for (const r of inside) {
        expect((await api.prescription(r.id, token)).status, `AC5: ${r.vo} is ${(r.age as number).toFixed(1)}d old — untouched and still readable`).toBe(200);
      }
      console.log(`#3675 AC5: ${inside.length} inside the ${RESTORE_WINDOW_DAYS}-day window (skipped as SKIPPED_WITHIN_RESTORE_WINDOW), ${overdue.length} past it`);

      // The boundary is ONE constant — `Prescription::DELETION_RESTORE_WINDOW_DAYS` — read by the
      // confirmation step, the restore guard and `resolveSkip()` alike, so "more than 30 days"
      // cannot mean two different things across them. Read it off a live row rather than trusting it.
      const probe = inside[0] ?? rows[0];
      const pf = await api.restorePreflight(probe.id, token);
      const span = Math.round((Date.parse(pf.summary.restorableUntil ?? '') - Date.parse(pf.summary.deletedAt ?? '')) / 86_400_000);
      console.log(`#3675 AC5 boundary on ${probe.vo}: deletedAt=${pf.summary.deletedAt} restorableUntil=${pf.summary.restorableUntil} window=${pf.restoreWindowDays}`);
      expect(pf.restoreWindowDays).toBe(RESTORE_WINDOW_DAYS);
      expect(span, 'exactly 30 days, not 29 and not 31').toBe(RESTORE_WINDOW_DAYS);
    },
  );

  test(
    'AC1/AC6 the nightly job runs unattended, and no overdue VO is left behind between runs',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const { anonymizedByNightly } = FIXTURES;

      // **The Go-Live Prerequisite is the one thing the PM's evidence could not cover.** It says
      // scheduling is "external infrastructure … a task for the infrastructure owner", and every
      // run on record until now was a human typing the command. The EventBridge rule was observed
      // firing on its own for the first time on 2026-09-23, watched across the boundary:
      //
      //   03:16:02Z  /prescriptions/34980 -> 200, Gelöscht tab 7
      //   03:18:07Z  /prescriptions/34980 -> 404, Gelöscht tab 6
      //
      // That is AC 1 end to end with nobody driving it, and AC 6's "every night" clause besides.
      expect((await api.prescription(anonymizedByNightly.id, token)).status, 'AC1: the nightly run scrubbed it and it stays scrubbed').toBe(404);

      // The standing form of the same check, which needs no fixture and cannot go stale: after the
      // job has run, nothing overdue may remain. A VO crossing the 30-day line at (say) 10:00 UTC
      // legitimately waits for the next 03:15, so the invariant is a CATCH-UP one — a VO may only
      // still be on the tab if it became overdue AFTER the last run — rather than a flat "nothing
      // is overdue", which would fail every day between noon and the small hours. (#3709's shape.)
      const tab = await api.deletedTab(token, 200);
      const now = Date.now();
      const lastRun = new Date(now);
      lastRun.setUTCHours(3, 15, 0, 0);
      if (lastRun.getTime() > now) lastRun.setUTCDate(lastRun.getUTCDate() - 1);

      const overdue = tab.rows
        .map((r) => ({ vo: r.prescriptionId, becameOverdue: Date.parse(r.deletedAt ?? '') + RESTORE_WINDOW_DAYS * 86_400_000 }))
        .filter((r) => r.becameOverdue < now);
      console.log(
        `#3675 AC1/AC6: last scheduled run ${lastRun.toISOString()}; ${tab.total} on the tab, ` +
          `${overdue.length} already past the window — ${JSON.stringify(overdue.map((r) => ({ vo: r.vo, since: new Date(r.becameOverdue).toISOString() })))}`,
      );
      for (const r of overdue) {
        expect(
          r.becameOverdue,
          `${r.vo} passed its window at ${new Date(r.becameOverdue).toISOString()}, before the ${lastRun.toISOString()} run, and is still on the tab`,
        ).toBeGreaterThan(lastRun.getTime());
      }
    },
  );

  test(
    'AC4 the refusal an anonymized VO produces ships, so a dialog open when the job ran says the right thing',
    { tag: ['@SuperAdmin', '@VoAnonymization', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const bundle = await api.entryBundle();

      const anonymizedMsg = VoDeletionPage.escapedCount(bundle, GERMAN.restoreAnonymized);
      const expiredMsg = VoDeletionPage.escapedCount(bundle, GERMAN.restoreWindowExpired);
      console.log(`#3675 bundle: anonymized="${GERMAN.restoreAnonymized}" x${anonymizedMsg} | window_expired x${expiredMsg}`);

      // `PrescriptionRestoreService::resolveBlocker()` checks `isAnonymized()` BEFORE the window,
      // deliberately: a VO is only ever anonymized after its window passed, so both hold, and "the
      // data is gone" is the more useful answer than "you are a day late". The preflight itself
      // 404s for an anonymized VO, so this message is only ever reached by a dialog that was
      // already open when the nightly job ran — which is exactly why it has to exist. Verified
      // live: `restore-preflight` on 34978 answers 404, not a blocker.
      expect(anonymizedMsg, 'the anonymized refusal ships in the deployed dictionary').toBeGreaterThan(0);
      expect(expiredMsg, 'and so does the expired-window one it takes precedence over').toBeGreaterThan(0);
      expect(Object.values(RESTORE_BLOCKED)).toContain('anonymized');
    },
  );

});
