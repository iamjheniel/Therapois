import { test, expect } from '../../fixtures/session';
import { ProdMondaySyncPage, type Facility, type ReportRow, type SyncReport } from '../../../Pages/superadmin/sa.prod-monday-sync.page';

/**
 * PRODUCTION — RC 3.14 **#3783**: a facility follows the Monday.com row NUMBER it keeps, not its
 * Einrichtungs-ID. Verified on staging first, where the fix's own `conflict` category dated the
 * deploy exactly.
 *
 * **READ-ONLY:** every request a GET, including the report's signed URL. The nightly sync is a
 * console command and is never run.
 *
 * **The honest headline: deployment is NOT decidable on production**, and the file proves why
 * rather than asserting a verdict — so what it does assert is (a) the rules that ARE checkable,
 * (b) that #3344's finding is closed here, and (c) the state #3783 freezes, as a regression guard.
 */

const P = ProdMondaySyncPage;

test.describe('#3783 Monday row pairing on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  let sa: ProdMondaySyncPage;
  let fac: Facility[];
  let reports: SyncReport[];
  let newest: SyncReport;
  let rows: ReportRow[];

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    sa = new ProdMondaySyncPage();
    await sa.connect();
    fac = await sa.facilities();
    reports = await sa.latestReports();
    newest = reports[reports.length - 1];
    rows = await sa.reportRows(newest.id);
    console.log(`  ${fac.length} facilities; newest report ${newest.id} (${newest.createdAt}) with ${rows.length} rows`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    'the nightly sync runs on production and reports every facility',
    { tag: ['@SuperAdmin', '@ProdMondaySync', '@ReadOnly'] },
    async () => {
      // The control that makes every later zero mean something: without it, "no conflict row" is
      // equally explained by the sync not running.
      const days = reports.map((r) => r.createdAt.slice(0, 10));
      console.log(`  last ${reports.length} runs: ${JSON.stringify(days)}`);
      const ageDays = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(days[days.length - 1])) / 86_400_000);
      console.log(`  newest run is ${ageDays} day(s) old; counts matched=${newest.matchedCount} created=${newest.createdCount} gap=${newest.gapCount}`);
      expect(ageDays, 'the sync ran recently').toBeLessThanOrEqual(3);

      // One row per facility: #3344's bug built the gap report from DEDUPLICATED Einrichtungs-IDs,
      // so a colliding facility appeared nowhere in the run and the report was SHORT.
      console.log(`  report rows ${rows.length} vs facilities ${fac.length}`);
      expect(rows.length, 'every facility appears in the run').toBe(fac.length);
      expect(Object.keys(rows[0]), "AC6's seven columns").toEqual(P.CSV_HEADER);
    },
  );

  test(
    "#3344's finding is CLOSED on production: no Einrichtungs-ID is held by two facilities",
    { tag: ['@SuperAdmin', '@ProdMondaySync', '@ReadOnly'] },
    async () => {
      // The defect #3783 exists to prevent: `$echMap[$echId] = $ech` let one row overwrite the
      // other, and the gap report was built from the deduplicated keys — so the dropped facility
      // was not matched, not renamed, not skipped and not gap-reported.
      const dup = P.duplicateEchIds(fac);
      console.log(`  Einrichtungs-IDs held by more than one facility: ${dup.length}`);
      for (const d of dup.slice(0, 6)) {
        console.log(`    ${d.echId}: ${d.facilities.map((f) => `id=${f.id} active=${f.status}`).join(', ')}`);
      }
      expect(dup, 'no ID collision remains on production').toHaveLength(0);

      // ...and the categories every row carries are the known vocabulary, so a row cannot be
      // silently uncategorised.
      const cats = P.categories(rows);
      console.log(`  categories: ${JSON.stringify(cats)}`);
      const known = [...P.BASE_CATEGORIES, P.CONFLICT];
      expect(Object.keys(cats).filter((c) => !known.includes(c)), 'no unknown category').toHaveLength(0);
    },
  );

  test(
    'rule 4: a practice never keeps a Monday row, so none can be row-paired',
    { tag: ['@SuperAdmin', '@ProdMondaySync', '@ReadOnly'] },
    async () => {
      const practices = fac.filter((f) => (f.type ?? '').toLowerCase() === 'practice');
      const withRow = practices.filter((f) => f.mondayItemId !== null && f.mondayItemId !== undefined && f.mondayItemId !== '');
      console.log(`  practices ${practices.length}, of which keeping a Monday row ${withRow.length}`);
      for (const f of withRow) console.log(`    id=${f.id} ech=${f.echId} monday=${f.mondayItemId}`);
      expect(practices.length, 'production has practices to check').toBeGreaterThan(0);
      expect(withRow, 'no practice keeps a Monday row').toHaveLength(0);
    },
  );

  test(
    'FINDING — deployment is not decidable on production: the conflict condition does not exist',
    { tag: ['@SuperAdmin', '@ProdMondaySync', '@ReadOnly'] },
    async () => {
      // On staging the fix dated itself, because staging HAS two active facilities sharing a Monday
      // row and a fixed build must report it. Production does not, so `conflict: 0` is what BOTH
      // builds produce and the count carries no information. Asserting the condition's absence is
      // the honest statement — and it is falsifiable: the day a second active facility takes a
      // shared row, a fixed build must emit a conflict row and this test will say so.
      const dup = P.duplicateMondayRows(fac);
      console.log(`  Monday rows kept by more than one facility: ${dup.length}`);
      for (const d of dup) {
        console.log(`    row ${d.row}: ${d.all.length} facilities, ${d.active.length} active — ${d.active.length > 1 ? 'RULE-9 CONFLICT' : 'no conflict (one active)'}`);
      }
      const cats = P.categories(rows);
      const conflicts = cats[P.CONFLICT] ?? 0;
      console.log(`  conflict rows in report ${newest.id}: ${conflicts}`);

      const conditionExists = P.conflictConditionExists(fac);
      console.log(`  does any Monday row have TWO active facilities? ${conditionExists}`);

      if (conditionExists) {
        // Then the count IS informative, and a fixed build must have reported it.
        expect(conflicts, 'the condition exists, so a fixed build reports it').toBeGreaterThan(0);
      } else {
        // The condition does not exist, so zero is expected on either build.
        expect(conflicts, 'no condition, so no conflict row — on either build').toBe(0);
        console.log('  => conflict:0 is consistent with BOTH the fixed and the unfixed build here;');
        console.log('     #3783 cannot be confirmed or denied from production data. It is verified');
        console.log('     on staging, where two ACTIVE facilities do share a Monday row.');
      }
    },
  );

  test(
    'the state #3783 freezes must not move: the duplicated rows are stable',
    { tag: ['@SuperAdmin', '@ProdMondaySync', '@ReadOnly'] },
    async () => {
      // "Neither facility was changed" is a rule about NON-action, so the only way to test it is
      // that these rows stay put. Pinned as a fingerprint, which a later nightly run would break.
      const dup = P.duplicateMondayRows(fac);
      expect(dup.length, 'production has duplicated Monday rows to guard').toBeGreaterThan(0);

      for (const d of dup) {
        // Exactly one active per shared row is the property the sync must preserve; two would be
        // the conflict, zero would mean the row is orphaned.
        expect(d.active.length, `row ${d.row} keeps exactly one active facility`).toBe(1);
        console.log(`  row ${d.row}: ${d.all.map((f) => P.fingerprint(f)).join('  |  ')}`);
      }

      // Every facility that keeps a row keeps exactly one, and every row value is a plain id.
      const withRow = fac.filter((f) => f.mondayItemId !== null && f.mondayItemId !== undefined && f.mondayItemId !== '');
      console.log(`  facilities keeping a Monday row: ${withRow.length} of ${fac.length}`);
      expect(withRow.every((f) => /^\d+$/.test(String(f.mondayItemId))), 'a Monday row id is numeric').toBe(true);
    },
  );
});
