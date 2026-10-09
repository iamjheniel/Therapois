import { test, expect } from '../../fixtures/session';
import { ProdPatientMergePage, type MergeLog } from '../../../Pages/superadmin/sa.prod-patient-merge.page';

/**
 * PRODUCTION — RC 3.14 #3804: the patient merge command runs a reviewed list given at run time.
 *
 * **READ-ONLY.** Every request is a GET; nothing here runs the command, which is console-only and
 * whose production run is the ticket's own post-deploy step.
 *
 * **NO PATIENT DATA.** A `patient_merged` log's `meta` carries a real person's name, birth date and
 * insurance number. The page object strips those at the boundary, so nothing below can assert on,
 * print or trace them — only patient NUMBERS, VO numbers, dates and counts.
 *
 * The AC6 tests are GATED on the run having happened rather than `fixme`'d, so the file starts
 * verifying the moment operations executes the command, with no edit.
 */

const P = ProdPatientMergePage;

test.describe('#3804 patient merge on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600_000);

  let sa: ProdPatientMergePage;
  let logs: MergeLog[];
  let since3131: MergeLog[];

  test.beforeAll(async () => {
    sa = new ProdPatientMergePage();
    await sa.connect();
    logs = await sa.mergeLogs();
    since3131 = P.mergesAfter(logs, P.BATCH_3131_DAY);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    "prerequisite 1: production runs an API where the command's <list> argument exists",
    { tag: ['@SuperAdmin', '@ProdPatientMerge', '@ReadOnly'] },
    async () => {
      // The ticket's own first prerequisite: "RC 3.14.0 is live on production. The <list> argument
      // does not exist in 3.13." That is the one half of the run-readiness a client can check.
      const { version } = await sa.status();
      console.log(`  production API: ${version}`);
      expect(version, 'production is on 3.14 or later').toMatch(/^3\.(1[4-9]|[2-9]\d)/);
    },
  );

  test(
    'the number-vs-id trap, pinned on production data',
    { tag: ['@SuperAdmin', '@ProdPatientMerge', '@ReadOnly'] },
    async () => {
      // The ticket, and the list CSV's own column name, say "patientId" — but that is the UI
      // NUMBER. Getting this wrong does not fail loudly: it silently reads a different real
      // patient. Pinned here so the mapping is on the record before any AC6 assertion uses it.
      const ignored = await sa.patientFilterIsHonoured(`patientId=${P.AC6.keep}`);
      console.log(`  /patients?patientId=${P.AC6.keep} -> ${ignored.hit} of ${ignored.all} (silently ignored)`);
      expect(ignored.hit, '?patientId= is accepted and ignored on /patients').toBe(ignored.all);

      const map = await sa.apiIdsByPatientNumber([P.AC6.keep, P.AC6.merge]);
      const keepIds = [...(map.get(P.AC6.keep) ?? [])];
      const mergeIds = [...(map.get(P.AC6.merge) ?? [])];
      console.log(`  patient NUMBER ${P.AC6.keep} -> api id(s) ${JSON.stringify(keepIds)}`);
      console.log(`  patient NUMBER ${P.AC6.merge} -> api id(s) ${JSON.stringify(mergeIds)}`);

      expect(keepIds.length, `patient ${P.AC6.keep} is reachable through its VO numbers`).toBeGreaterThan(0);
      expect(mergeIds.length, `patient ${P.AC6.merge} is reachable through its VO numbers`).toBeGreaterThan(0);
      // The trap itself: the number and the id are different values, so a /patients/{number} read
      // would land on somebody else entirely.
      expect(keepIds).not.toContain(Number(P.AC6.keep));
      expect(mergeIds).not.toContain(Number(P.AC6.merge));
    },
  );

  test(
    'AC6 has NOT been run on production yet — established two independent ways',
    { tag: ['@SuperAdmin', '@ProdPatientMerge', '@ReadOnly'] },
    async () => {
      // (1) The audit trail. Every merge production has ever recorded is #3131's one-off batch, and
      // none of them names AC6's pair.
      const days = [...new Set(logs.map((l) => l.createdAt.slice(0, 10)))].sort();
      console.log(`  ${logs.length} patient_merged logs, on ${JSON.stringify(days)}`);
      console.log(`  merges since #3131's batch (${P.BATCH_3131_DAY}): ${since3131.length}`);

      const named = logs.filter(
        (l) => [l.oldValue, l.newValue, l.removedPatientId].includes(P.AC6.merge) ||
               [l.oldValue, l.newValue].includes(P.AC6.keep),
      );
      console.log(`  logs naming keep ${P.AC6.keep} / merge ${P.AC6.merge}: ${named.length}`);
      expect(named, 'AC6 pair has no merge log').toHaveLength(0);

      // (2) The records themselves. If the merge had run, one number would no longer hold VOs of
      // its own and both would resolve to a single patient id.
      const map = await sa.apiIdsByPatientNumber([P.AC6.keep, P.AC6.merge]);
      const keepIds = [...(map.get(P.AC6.keep) ?? [])];
      const mergeIds = [...(map.get(P.AC6.merge) ?? [])];
      const overlap = keepIds.filter((id) => mergeIds.includes(id));
      console.log(`  the two records resolve to ${overlap.length ? 'THE SAME' : 'DIFFERENT'} patient id(s)`);
      expect(overlap, 'the two records are still separate').toHaveLength(0);

      // Both statements must agree, or one of the two readings is wrong.
      expect(since3131.length === 0 && overlap.length === 0, 'the run has not happened').toBe(true);
      console.log('  => the fix is deployed; the one-time operations run is still outstanding');
    },
  );

  test(
    'AC3/AC4: once a run happens, every new merge log has the shape the ticket specifies',
    { tag: ['@SuperAdmin', '@ProdPatientMerge', '@ReadOnly'] },
    async () => {
      // GATED, not fixme'd: this starts asserting the moment operations runs the command.
      test.skip(since3131.length === 0, 'no merge has run on production since #3131 — nothing to verify yet');

      console.log(`  verifying ${since3131.length} merge(s) since ${P.BATCH_3131_DAY}`);
      const perSurvivor = new Map<string, number>();
      for (const l of since3131) {
        // Written by the command, not a person.
        expect(l.author, 'a merge is system-written').toBeNull();
        // The meta records who was removed — key names only; the values are a real person's.
        expect(l.metaKeys, 'the removal is recorded').toEqual(
          expect.arrayContaining(['removedPatientId', 'removedName', 'removedBirthDate', 'removedInsuranceNumber']),
        );
        expect(l.oldValue, 'the merged number is recorded').toBeTruthy();
        expect(l.newValue, 'the survivor is recorded').toBeTruthy();
        expect(l.removedPatientId, 'meta names the same removed patient').toBe(l.oldValue);
        expect(l.oldValue).not.toBe(l.newValue);
        perSurvivor.set(l.newValue!, (perSurvivor.get(l.newValue!) ?? 0) + 1);
      }
      // One log per merged record, so a group of one keep + one merge writes exactly one.
      const merged = new Set(since3131.map((l) => l.oldValue));
      console.log(`  ${merged.size} distinct merged records across ${since3131.length} logs`);
      expect(merged.size, 'each merged record is logged exactly once').toBe(since3131.length);
    },
  );

  test(
    "AC6: the ticket's own pair is merged and its VOs move to the survivor",
    { tag: ['@SuperAdmin', '@ProdPatientMerge', '@ReadOnly'] },
    async () => {
      const named = logs.filter((l) => l.oldValue === P.AC6.merge || l.removedPatientId === P.AC6.merge);
      test.skip(named.length === 0, `patient ${P.AC6.merge} has not been merged yet — AC6's run is outstanding`);

      const log = named[named.length - 1];
      console.log(`  ${log.createdAt}: ${log.oldValue} -> ${log.newValue}`);
      expect(log.newValue, `AC6: ${P.AC6.merge} merges into ${P.AC6.keep}`).toBe(P.AC6.keep);

      // The merged record's VOs must now sit on the survivor, and its old numbers must no longer be
      // live VO numbers of their own.
      const map = await sa.apiIdsByPatientNumber([P.AC6.keep, P.AC6.merge]);
      const keepIds = [...(map.get(P.AC6.keep) ?? [])];
      const mergeIds = [...(map.get(P.AC6.merge) ?? [])];
      console.log(`  after the merge: keep -> ${JSON.stringify(keepIds)}, merged -> ${JSON.stringify(mergeIds)}`);
      expect(keepIds.length, 'the survivor still holds VOs').toBeGreaterThan(0);
      expect(mergeIds, 'the merged number no longer holds VOs of its own').toHaveLength(0);

      const vos = await sa.vosOfPatientNumber(P.AC6.keep);
      const ids = new Set(vos.map((v) => v.patientId));
      console.log(`  survivor's VOs: ${vos.length}, all on patient id(s) ${JSON.stringify([...ids])}`);
      expect(ids.size, "the survivor's VOs all sit on one record").toBe(1);
    },
  );
});
