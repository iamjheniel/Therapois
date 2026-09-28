import { test, expect } from '@playwright/test';
import {
  DeceasedCascadeScopePage,
  CANCELLABLE,
  PROTECTED,
  TERMINAL,
  ALL_STATUSES,
  CORRECTION_RUN,
  DIALOG_FIXTURES,
} from '../../../Pages/superadmin/sa.deceased-cascade-scope.page';

/**
 * RC 3.14 #3731 — marking a patient deceased must only cancel VOs still in progress, the follow-up
 * chain must obey the same rule, and the VOs the bug already mis-cancelled must be repaired.
 *
 * READ-ONLY — every request is a GET. Nothing here marks a patient deceased or cancels a VO; the
 * whole point of the ticket is what such a write would do, so it is verified from the surfaces that
 * describe the write and from the repair the command already made.
 */

const S = DeceasedCascadeScopePage;

test.describe('#3731 the deceased cascade only cancels VOs still in progress', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600_000);

  let api: DeceasedCascadeScopePage;

  test.beforeEach(({ request }) => {
    api = new DeceasedCascadeScopePage(request);
  });

  test(
    'AC1 deployment — both deceased dialogs now describe the CANCELLABLE set, not the old active set',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly'] },
    async () => {
      // The two endpoints are the only client surfaces that answer "which VOs would a deceased
      // marking terminate?", and the fix moved both from findActiveByPatient() (everything but
      // cancelled/archived) to findCancellableByPatient() (the four in-progress statuses). On a
      // patient holding both kinds the two rules disagree, so this is a dual oracle for a fix that
      // otherwise only runs inside a write nobody should make.
      for (const fixture of DIALOG_FIXTURES) {
        const { counts } = await api.patientVos(fixture.patient);
        const cancellable = Object.entries(counts)
          .filter(([s]) => (CANCELLABLE as readonly string[]).includes(s))
          .reduce((n, [, c]) => n + c, 0);
        const oldRule = Object.entries(counts)
          .filter(([s]) => !(TERMINAL as readonly string[]).includes(s))
          .reduce((n, [, c]) => n + c, 0);

        const [count, list] = [await api.activeVosCount(fixture.patient), await api.activeVosList(fixture.patient)];
        console.log(
          `#3731 patient ${fixture.patient} (${fixture.note}): cancellable=${cancellable}, old rule=${oldRule} → ` +
            `count endpoint ${count}, list endpoint ${list.length} [${list.map((v) => `${v.vo}:${v.status}`).join(', ')}]`,
        );

        // The fixture must still discriminate, or the assertion below proves nothing.
        expect(oldRule, `patient ${fixture.patient} no longer separates the two rules`).toBeGreaterThan(cancellable);
        expect(cancellable, `patient ${fixture.patient} lost its in-progress VO`).toBe(fixture.cancellable);

        expect(count, `the count endpoint is still using the old rule for patient ${fixture.patient}`).toBe(cancellable);
        expect(list.length, `the dialog list is still using the old rule for patient ${fixture.patient}`).toBe(cancellable);
        // Every VO the dialogs promise to terminate really is one the rule allows.
        for (const vo of list) expect(CANCELLABLE).toContain(vo.status);
      }
    },
  );

  test(
    'AC1 the status table — the ten statuses, and the NULL ones the rule deliberately never matches',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly'] },
    async () => {
      const counts: Record<string, number> = {};
      for (const status of ALL_STATUSES) counts[status] = await api.countByStatus(status);
      const total = await api.totalPrescriptions();
      const summed = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`#3731 status book: ${JSON.stringify(counts)} = ${summed} of ${total}`);

      // Every status the ticket's table names exists, and the four cancellable ones are a real
      // population rather than a theoretical set.
      for (const status of ALL_STATUSES) expect(counts[status], `${status} is not a live status`).toBeGreaterThan(0);
      const cancellable = (CANCELLABLE as readonly string[]).reduce((n, s) => n + counts[s], 0);
      const protectedCount = (PROTECTED as readonly string[]).reduce((n, s) => n + counts[s], 0);
      console.log(`#3731 cancellable ${cancellable} VOs | protected ${protectedCount} | terminal ${counts.Abgebrochen + counts.Archiviert}`);
      expect(cancellable).toBeGreaterThan(0);
      expect(protectedCount).toBeGreaterThan(0);

      // The ten do NOT sum to the book, and that gap is the rule's own safe direction: the callers
      // match with IN, which no NULL satisfies, so a VO with no status is never cancelled —
      // "nothing records what it would have to be restored to".
      const nullStatus = total - summed;
      console.log(`#3731 ${nullStatus} VOs carry no treatmentStatus at all — never cancellable, by construction`);
      expect(nullStatus).toBeGreaterThanOrEqual(0);
      expect(summed).toBeLessThanOrEqual(total);
    },
  );

  test(
    'AC5/AC6/AC8 — the repair run, re-derived from its own log block',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly'] },
    async () => {
      // The run wrote its restorations in one transaction, so they occupy a contiguous id range.
      // Reading the block is what makes all 76 checkable individually — including the follow-up
      // cascade ones, which cannot be found any other way from a client because the log's `reason`
      // column (the command's `Kaskade: …` signature) is not serialized.
      const logs = await api.correctionBlock(CORRECTION_RUN.firstLogId, CORRECTION_RUN.lastLogId);

      const byNew: Record<string, number> = {};
      for (const l of logs) byNew[String(l.newValue)] = (byNew[String(l.newValue)] ?? 0) + 1;
      console.log(
        `#3731 correction block ${CORRECTION_RUN.firstLogId}–${CORRECTION_RUN.lastLogId}: ${logs.length} entries, ` +
          `restored to ${JSON.stringify(byNew)}`,
      );

      // Every entry is the same shape: a system-written treatmentStatus change at one instant.
      for (const l of logs) {
        expect(l.type, `log ${l.id} type`).toBe('field_change');
        expect(l.meta?.field, `log ${l.id} field`).toBe('treatmentStatus');
        expect(l.meta?.type, `log ${l.id} is not an automatic write`).toBe('automatic');
        expect(l.author, `log ${l.id} has an author — the repair is system-written`).toBeNull();
        expect(l.createdAt, `log ${l.id} is outside the run`).toBe(CORRECTION_RUN.at);
        // AC8: the tool only ever touched a VO still sitting in Abgebrochen.
        expect(l.oldValue, `log ${l.id} restored a VO that was not cancelled`).toBe('Abgebrochen');
        // AC6: it restored to a protected status, never to another in-progress one.
        expect(PROTECTED, `log ${l.id} restored to ${l.newValue}`).toContain(l.newValue);
      }

      // One VO each — no VO was written twice.
      const vos = logs.map((l) => l.prescriptionId!);
      expect(new Set(vos).size, 'a VO was restored more than once').toBe(logs.length);

      // The split, re-derived rather than taken from the run report.
      expect(byNew).toEqual(CORRECTION_RUN.restoredTo);

      // AC6's real promise is that it STUCK. "Still holds the restored status" is NOT the right
      // test, though, and asserting it fails on a correct system: restoring a VO to Abgerechnet or
      // Abgelaufen makes it eligible for `AutoArchivePrescriptionCommand` (30 days / 90 days), so
      // the nightly run legitimately moves some on to Archiviert — AC7's own "acceptable resting
      // state". Measured: 21 of the 76 moved that same evening. What must hold is that none fell
      // back to Abgebrochen, and that every move away from the restored status was the archiver.
      const current = await api.statusOf(vos);
      const moved = logs.filter((l) => current.get(l.prescriptionId!)?.status !== l.newValue);
      const backToCancelled = logs.filter((l) => current.get(l.prescriptionId!)?.status === 'Abgebrochen');
      console.log(
        `#3731 of ${logs.length} restored VOs, ${logs.length - moved.length} still hold the restored status and ` +
          `${moved.length} have since moved on; ${backToCancelled.length} are back in Abgebrochen`,
      );
      expect(backToCancelled.map((l) => l.prescriptionId), 'a restored VO is cancelled again').toEqual([]);

      // Every mover must be Archiviert AND carry the auto-archive log that explains it, so a
      // silent re-write cannot hide inside the tolerance.
      const unexplained: string[] = [];
      for (const l of moved) {
        const now = current.get(l.prescriptionId!);
        if (now?.status !== 'Archiviert') {
          unexplained.push(`${now?.vo} restored to ${l.newValue}, now ${now?.status}`);
          continue;
        }
        const history = await api.logsFor(l.prescriptionId!);
        const archived = history.find(
          (h) =>
            h.newValue === 'Archiviert' &&
            h.createdAt > l.createdAt &&
            String((h.meta as any)?.reason ?? '').startsWith('Auto-archived'),
        );
        console.log(`#3731   ${now?.vo}: ${l.newValue} → Archiviert — ${archived ? String((archived.meta as any).reason) : 'NO auto-archive log'}`);
        if (!archived) unexplained.push(`${now?.vo} reached Archiviert with no auto-archive log`);
      }
      expect(unexplained, 'a restored VO moved for a reason other than the nightly auto-archive').toEqual([]);
    },
  );

  test(
    'AC7 — nothing archived was rewritten, and the block is bounded on both sides',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly'] },
    async () => {
      // "Archiviert is an acceptable resting state": no restoration may have produced one, and
      // none may have overwritten one.
      const logs = await api.correctionBlock(CORRECTION_RUN.firstLogId, CORRECTION_RUN.lastLogId);
      expect(logs.filter((l) => l.newValue === 'Archiviert')).toEqual([]);
      expect(logs.filter((l) => l.oldValue === 'Archiviert')).toEqual([]);

      // The boundaries matter as much as the contents: the entries either side belong to somebody
      // else, which is what makes "76 and no more" a measurement rather than an assumption.
      const before = await api.log(CORRECTION_RUN.firstLogId - 1);
      const after = await api.log(CORRECTION_RUN.lastLogId + 1);
      console.log(
        `#3731 block edges: ${before.id} ${before.type} ${before.createdAt} (${before.meta?.field ?? '—'}) | ` +
          `${after.id} ${after.type} ${after.createdAt} (${after.meta?.field ?? '—'})`,
      );
      for (const edge of [before, after]) {
        const sameRun =
          edge.createdAt === CORRECTION_RUN.at && edge.meta?.field === 'treatmentStatus' && edge.oldValue === 'Abgebrochen';
        expect(sameRun, `log ${edge.id} looks like part of the run — the block is wider than recorded`).toBe(false);
      }
    },
  );

  test(
    'AC6 the backlog is clear — no VO the deceased flow cancelled from a protected status is still Abgebrochen',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly', '@Slow'] },
    async () => {
      // The strongest statement available: rather than trusting the run's count, re-derive the
      // bug's own signature over the whole deceased population and require the residue to be empty.
      const terminations = await api.deceasedTerminations();
      const voIds = [...new Set(terminations.map((t) => t.voId))];
      const byVo = new Map<number, string[]>();
      for (const t of terminations) byVo.set(t.voId, [...(byVo.get(t.voId) ?? []), t.at]);
      const current = await api.statusOf(voIds);
      const stillCancelled = voIds.filter((id) => current.get(id)?.status === 'Abgebrochen');
      console.log(
        `#3731 ${terminations.length} deceased terminations over ${voIds.length} VOs; ` +
          `${stillCancelled.length} are still Abgebrochen and are the ones to examine`,
      );
      expect(voIds.length).toBeGreaterThan(0);

      // The direct signature: a status change into Abgebrochen within a few seconds of the
      // termination log on the same VO. Its oldValue is the status the bug overwrote.
      const wrong: string[] = [];
      let paired = 0;
      for (const voId of stillCancelled) {
        const logs = await api.logsFor(voId);
        const changes = logs.filter(
          (l) => (l.type === 'treatment_status_change' || l.type === 'field_change') && l.newValue === 'Abgebrochen',
        );
        const hit = changes.find((c) => (byVo.get(voId) ?? []).some((t) => S.secondsApart(c.createdAt, t) <= 5));
        if (!hit) continue;
        paired++;
        if ((PROTECTED as readonly string[]).includes(String(hit.oldValue))) {
          wrong.push(`${current.get(voId)?.vo} (id ${voId}) cancelled from ${hit.oldValue} at ${hit.createdAt}`);
        }
      }
      console.log(`#3731 ${paired} of ${stillCancelled.length} pair with a deceased termination; wrongly cancelled: ${wrong.length}`);
      for (const w of wrong) console.log(`#3731   ${w}`);
      expect(wrong, 'a VO is still sitting in Abgebrochen after the deceased flow overwrote a finished status').toEqual([]);
    },
  );

  test(
    'evidence — the deceased population, and the scope note the commit diverges from',
    { tag: ['@SuperAdmin', '@DeceasedCascade', '@ReadOnly', '@Slow'] },
    async () => {
      const terminations = await api.deceasedTerminations();
      const voIds = [...new Set(terminations.map((t) => t.voId))];
      const current = await api.statusOf(voIds);
      const byStatus: Record<string, number> = {};
      for (const v of current.values()) byStatus[String(v.status)] = (byStatus[String(v.status)] ?? 0) + 1;
      console.log(`#3731 deceased-terminated VOs today: ${JSON.stringify(byStatus)} (${voIds.length} VOs)`);

      // Reported, not failed. The ticket's "does NOT change" says the lookups used elsewhere to
      // count or list a patient's active VOs are not touched, and the Developer Reference says of
      // findActiveByPatient() "Do not change this method". The method itself is indeed untouched —
      // but BOTH of its dialog consumers were moved to the narrower rule, so the numbers those two
      // screens show did change. The commit argues it deliberately (the dialog copy promises every
      // listed VO is terminated, so listing one the action now leaves alone would make it lie), and
      // the third consumer, WaitlistPriorityCalculator, keeps the broad rule.
      console.log(
        '#3731 NOTE for the PM: the ticket scopes the active-VO lookups out of the change, but both ' +
          'deceased-dialog consumers (PatientActiveVosCountController, ActivePatientPrescriptionsProvider) ' +
          'now read the narrower cancellable set — deliberate per the commit, and it is what the AC1 test above ' +
          'measures, but it is a behaviour change on two screens the ticket says it does not touch.',
      );

      const stillCancelled = voIds.filter((id) => current.get(id)?.status === 'Abgebrochen');
      expect(stillCancelled.length).toBeGreaterThanOrEqual(0);
      expect(voIds.length).toBeGreaterThan(0);
    },
  );
});
