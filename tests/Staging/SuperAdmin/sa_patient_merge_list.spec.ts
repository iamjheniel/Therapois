import { test, expect } from '@playwright/test';
import { FT, PatientMergeListPage, REAL_RUN_AT } from '../../../Pages/superadmin/sa.patient-merge-list.page';

/**
 * RC 3.14 #3804 — the patient merge command runs a reviewed list given at run time. Commit
 * `16a321f7f`, extending #3131's `app:patient:merge-duplicates`.
 *
 * The command is console-only, but its OUTCOME is fully readable, and the dev team ran it on
 * staging on 2026-09-25 (preview ~14:07 UTC, apply 14:10:22) against purpose-built fixtures. This
 * file verifies that run's footprint rather than re-running anything: nothing here writes.
 *
 * Read-only: every request is a GET.
 */
test.describe('#3804 the patient merge command runs a reviewed list', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  let api: PatientMergeListPage;
  /** Resolved once: the ticket's numbers are UI patient NUMBERS, not API ids. */
  let keepId: number;
  let skipKeepId: number;
  let skipMergeId: number;

  test.beforeAll(async ({ playwright }) => {
    api = new PatientMergeListPage(await playwright.request.newContext());
    const keep = await api.patientIdForVo(`${FT.keep}-1`);
    const sk = await api.patientIdForVo(`${FT.skipKeep}-1`);
    const sm = await api.patientIdForVo(`${FT.skipMerge}-1`);
    expect(keep && sk && sm, 'the FT fixtures are still on staging').toBeTruthy();
    keepId = keep!.patientId;
    skipKeepId = sk!.patientId;
    skipMergeId = sm!.patientId;
    console.log(`#3804 fixtures: keep ${FT.keep}->id ${keepId}, skip ${FT.skipKeep}->id ${skipKeepId}, ${FT.skipMerge}->id ${skipMergeId}`);
  });

  test('THE TRAP: the ticket\'s "patient 99693" is a UI patient NUMBER, not the API id', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    // Pinned in its own test because getting it wrong is silent. Here the number 404s; on #3790's
    // fixtures the same mistake resolved to a DIFFERENT REAL PATIENT, which is worse.
    const asId = await api.patient(FT.keep);
    console.log(`  GET /patients/${FT.keep} (the NUMBER) -> ${asId.status}`);
    expect(asId.status, 'the patient number is not an API id here').not.toBe(200);

    const real = await api.patient(keepId);
    expect(real.status, 'the resolved id is').toBe(200);
    expect(Number(real.body?.patientId), 'and it carries the number as `patientId`').toBe(FT.keep);
    console.log(`  /patients/${keepId}.patientId = ${real.body?.patientId} (${real.body?.fullName})`);
  });

  test('AC4 the merged group: VOs moved, renumbered in creation order, old numbers still findable', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    const vos = await api.vosFor(keepId);
    const summary = vos.map((v) => ({
      id: Number(v.id),
      number: String(v.prescriptionId),
      created: String(v.createdAt).slice(0, 19),
      former: PatientMergeListPage.formerNumbers(v).map((f) => f.number),
    }));
    for (const s of summary) console.log(`  ${s.number.padEnd(10)} id=${s.id} created=${s.created} former=${JSON.stringify(s.former)}`);

    // Every VO now belongs to the surviving record and is numbered in ITS numbering.
    expect(vos.length, 'the survivor holds both records\' VOs').toBeGreaterThan(2);
    for (const s of summary) expect(s.number.startsWith(`${FT.keep}-`), `${s.number} uses the survivor's numbering`).toBe(true);

    // AC4's "in the order the VOs were created": sort by creation, and the suffixes must ascend.
    const byCreation = [...summary].sort((a, b) => a.created.localeCompare(b.created));
    const suffixes = byCreation.map((s) => Number(s.number.split('-')[1]));
    expect(suffixes, 'renumbered in creation order').toEqual([...suffixes].sort((a, b) => a - b));

    // The old numbers stay findable as former numbers — and only on the VOs that actually moved.
    const moved = summary.filter((s) => s.former.length > 0);
    console.log(`  VOs carrying a former number: ${moved.length} of ${summary.length}`);
    expect(moved.length, 'the merged record\'s VOs carry their old numbers').toBeGreaterThan(0);
    for (const m of moved) {
      for (const f of m.former) {
        expect(f.startsWith(`${FT.merged}-`), `${m.number}'s former number ${f} is from the merged record`).toBe(true);
      }
    }
    // And the old numbers no longer resolve as live VO numbers — they were renumbered, not copied.
    for (const m of moved) {
      for (const f of m.former) {
        const still = await api.patientIdForVo(f);
        expect(still, `${f} no longer resolves as a live VO number`).toBeNull();
      }
    }
  });

  test('AC4 the merged record is removed, and the merge is in the survivor\'s history', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    const logs = await api.logsFor(keepId);
    const merged = logs.filter((l) => l.type === 'patient_merged');
    console.log(`  logs on the survivor: ${JSON.stringify(logs.map((l) => l.type))}`);
    expect(merged.length, 'exactly one merge is recorded').toBe(1);
    const m = merged[0];
    console.log(`  ${m.createdAt} ${m.oldValue} -> ${m.newValue} meta=${JSON.stringify(m.meta)}`);

    // The log names the records by their UI numbers, which is what the PM's note quotes.
    expect(String(m.oldValue), 'the removed record').toBe(String(FT.merged));
    expect(String(m.newValue), 'the record kept').toBe(String(FT.keep));
    expect((m.meta ?? {}).type, 'written by an automatic run, not a person').toBe('automatic');
    expect(Number((m.meta ?? {}).removedPatientId), 'meta names the removed record').toBe(FT.merged);

    // The merged record itself is gone.
    const removedId = keepId + 1; // ids are consecutive for these purpose-built fixtures
    const gone = await api.patient(removedId);
    console.log(`  the removed record's id ${removedId} -> ${gone.status}`);
    expect(gone.status, 'the merged record is removed').toBe(404);

    // AC4: "the patient history of the record kept shows the merge" AND the merged record's own
    // history moved over — visible as two `patient_created` entries on one surviving patient.
    const created = logs.filter((l) => l.type === 'patient_created');
    console.log(`  patient_created entries on the survivor: ${created.length} (the merged record's history moved over)`);
    expect(created.length, "the merged record's own history came with it").toBeGreaterThan(1);
  });

  test('AC1 a group needs no shared insurance number — which is what #3131 could not do', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    // #3131 keyed groups on a shared insurance number, so this group was unmergeable before. The
    // removed record's number survives in the merge log's meta, so the difference is still provable
    // after the fact — the only place it remains readable once the record is gone.
    const survivor = await api.patient(keepId);
    const merged = (await api.logsFor(keepId, 'patient_merged'))[0];
    const survivorNumber = String(survivor.body?.insuranceNumber ?? '');
    const removedNumber = String((merged.meta ?? {}).removedInsuranceNumber ?? '');
    console.log(`  survivor insuranceNumber=${survivorNumber} removed=${removedNumber}`);
    expect(survivorNumber, 'the survivor has an insurance number').not.toBe('');
    expect(removedNumber, 'and so did the removed record').not.toBe('');
    expect(removedNumber, 'AC1: they DIFFER — no shared insurance number was needed').not.toBe(survivorNumber);
  });

  test('AC2 the preview wrote nothing — proven by the timestamps', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    // The only way to show this after the fact: the dev team previewed at ~14:07 and applied at
    // 14:10:22. Every trace the merge left carries the APPLY instant, so the preview three minutes
    // earlier demonstrably changed nothing.
    const merged = (await api.logsFor(keepId, 'patient_merged'))[0];
    const vos = await api.vosFor(keepId);
    const formerStamps = vos.flatMap((v) => PatientMergeListPage.formerNumbers(v)).map((f) => f.createdAt);
    console.log(`  merge log at ${merged.createdAt}; former numbers at ${JSON.stringify(formerStamps)}`);

    expect(merged.createdAt, 'the merge log carries the apply instant').toBe(REAL_RUN_AT);
    for (const s of formerStamps) {
      expect(s, 'every renumbering carries the apply instant, not the preview').toBe(REAL_RUN_AT);
    }
    // All of it in one transaction — one instant, not a spread.
    expect(new Set(formerStamps).size, 'the group was applied atomically').toBe(1);
  });

  test('AC3 the skipped group is untouched, and the reason for the skip is visible', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    // FT2 was skipped because the `keep` record's last name was changed after the list was written.
    for (const [label, id, number] of [
      ['keep', skipKeepId, FT.skipKeep],
      ['merge', skipMergeId, FT.skipMerge],
    ] as [string, number, number][]) {
      const p = await api.patient(id);
      const vos = await api.vosFor(id);
      const logs = await api.logsFor(id);
      console.log(
        `  ${label} ${number} (id ${id}): ${p.body?.fullName} VOs=${JSON.stringify(vos.map((v) => v.prescriptionId))} logs=${JSON.stringify(logs.map((l) => l.type))}`,
      );
      expect(p.status, `${label} record still exists`).toBe(200);
      expect(logs.some((l) => l.type === 'patient_merged'), `${label} record was NOT merged`).toBe(false);
      expect(vos.length, `${label} record keeps its own VOs`).toBeGreaterThan(0);
      for (const v of vos) {
        expect(String(v.prescriptionId).startsWith(`${number}-`), 'under its own numbering').toBe(true);
        expect(PatientMergeListPage.formerNumbers(v), 'and nothing was renumbered').toEqual([]);
      }
    }
    // The cause: the `keep` record carries the field_change that made its snapshot stale.
    const changed = await api.logsFor(skipKeepId, 'field_change');
    console.log(`  field_change entries on the renamed record: ${changed.length}`);
    expect(changed.length, 'the record was changed after the list was written — the skip reason').toBeGreaterThan(0);
  });

  test('AC5 the report is NOT client-reachable — measured against the whole entrypoint', {
    tag: ['@SuperAdmin', '@PatientMergeList', '@ReadOnly'],
  }, async () => {
    // #3783 taught that a console command CAN have a report resource, so this is listed rather than
    // guessed from a few 404s. Here there genuinely is none: the report is console + S3 only.
    const reports = await api.reportResources();
    console.log(`  report resources in the API: ${JSON.stringify(reports)}`);
    expect(reports.some((r) => /merge/i.test(r)), 'no merge report resource exists').toBe(false);
    for (const path of ['/patient_merge_reports', '/merge_reports', '/patient_merges']) {
      const r = await api.raw(`${path}?itemsPerPage=1`);
      expect(r.status, `${path} is absent`).toBe(404);
    }

    // What IS the client-side audit trail: the merge logs. Partitioned, they separate #3131's July
    // batch from this ticket's runs — so the new engine's work is distinguishable from the old.
    const all = await api.allMergeLogs();
    const july = all.filter((l) => l.createdAt < '2026-08-01');
    const recent = all.filter((l) => l.createdAt >= '2026-09-01');
    console.log(`  patient_merged logs: ${all.length} total, ${july.length} from #3131's July run, ${recent.length} since September`);
    expect(all.length, 'the merge audit trail is queryable').toBeGreaterThan(0);
    expect(recent.length, "this ticket's run left its own entries").toBeGreaterThan(0);
  });
});
