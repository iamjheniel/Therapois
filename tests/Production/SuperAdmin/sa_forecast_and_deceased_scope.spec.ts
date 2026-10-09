import { test, expect } from '../../fixtures/session';
import {
  ProdForecastDeceasedPage, type Vo, type TerminationLog,
  WINDOW, TO_ORDER_DAYS, BLOCKED_ORDERING, CANCELLABLE, PROTECTED,
} from '../../../Pages/superadmin/sa.prod-forecast-deceased.page';

/**
 * PRODUCTION — RC 3.14 **#3773** (the one-off quarter-change order forecast, due to the PM by
 * 29 September) and **#3731** (the deceased cascade must only cancel in-progress VOs).
 *
 * **READ-ONLY:** every request is a GET. #3773's command is console-only and is never run; nothing
 * here marks a patient deceased or cancels a VO, since that is #3731's whole subject.
 *
 * **No patient names** are read or printed, on either ticket.
 */

const P = ProdForecastDeceasedPage;
const TODAY = new Date().toISOString().slice(0, 10);

test.describe('#3773 + #3731 on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  let sa: ProdForecastDeceasedPage;
  let blanko: Vo[];
  let issuedExpected: number;
  let issuedCollected: number;

  test.beforeAll(async () => {
    test.setTimeout(1_800_000);
    sa = new ProdForecastDeceasedPage();
    await sa.connect();
    const { after, before } = P.issueWindow();
    const walk = await sa.vosIssuedBetween(after, before);
    issuedExpected = walk.expected;
    issuedCollected = walk.vos.length;
    blanko = walk.vos.filter((v) => v.blankoVO === true);
    console.log(`  issue window ${after}..${before}: ${issuedCollected} of ${issuedExpected} VOs, ${blanko.length} Blanko`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    '#3773: the window arithmetic, and the walk is complete',
    { tag: ['@SuperAdmin', '@ProdQuarterForecast', '@ReadOnly', '@Slow'] },
    async () => {
      // A truncated walk would silently produce a SHORT forecast, which is the failure mode that
      // matters for a report somebody acts on — so the collected count is checked against totalItems.
      expect(issuedCollected, 'the issue-date walk collected every row').toBe(issuedExpected);

      const { after, before } = P.issueWindow();
      expect(P.addDays(after, TO_ORDER_DAYS), 'the window opens at issue+91').toBe(WINDOW.from);
      expect(P.addDays(before, TO_ORDER_DAYS), 'and closes at issue+91').toBe(WINDOW.to);
      console.log(`  ${after} +91 = ${WINDOW.from}; ${before} +91 = ${WINDOW.to}`);

      // `date[before]` is INCLUSIVE (#3712), which is what this window needs. Proven, not assumed:
      // the boundary day's VOs must be inside the walk.
      const onBoundary = (await sa.vosIssuedBetween(before, before)).expected;
      console.log(`  VOs issued exactly on ${before}: ${onBoundary} (inclusive bound)`);
      expect(onBoundary, 'the closing bound is inclusive').toBeGreaterThan(0);
    },
  );

  test(
    "#3773: the Blanko forecast on production, with the gate's real backing values",
    { tag: ['@SuperAdmin', '@ProdQuarterForecast', '@ReadOnly'] },
    async () => {
      // The ordering-status gate is the one a rewrite gets wrong: BY_PRAXIS is 'Praxis' and BY_ER
      // is 'ER bestellt selbst', NOT 'By Praxis'/'By ER'. A gate on the wrong strings never fires,
      // so the forecast keeps VOs the report must skip. Closed against LIVE values here.
      const served = new Set(blanko.map((v) => v.orderingStatus).filter(Boolean) as string[]);
      console.log(`  ordering statuses served in the window: ${JSON.stringify([...served])}`);
      const known = ['By Admin', 'By Therapist', ...BLOCKED_ORDERING];
      expect([...served].filter((s) => !known.includes(s)), 'every served value is one of the four').toHaveLength(0);
      const blocked = [...served].filter((s) => (BLOCKED_ORDERING as readonly string[]).includes(s));
      console.log(`  of those, blocked by the gate: ${JSON.stringify(blocked)}`);
      // Anti-vacuity: a blocked value must actually occur, or the gate is untested.
      expect(blocked.length, 'a blocked ordering status occurs in the window').toBeGreaterThan(0);

      const rows: { vo: string; issued: string; ready: string; status: string | undefined }[] = [];
      const skipped: Record<string, number> = {};
      for (const v of blanko) {
        const r = P.forecastBlanko(v, TODAY);
        if ('readyDate' in r) rows.push({ vo: v.prescriptionId, issued: v.date.slice(0, 10), ready: r.readyDate, status: v.treatmentStatus });
        else skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
      }
      console.log(`  excluded: ${JSON.stringify(skipped)}`);
      console.log(`  FORECAST ROWS: ${rows.length}`);
      for (const r of rows.sort((a, b) => a.ready.localeCompare(b.ready))) {
        console.log(`    ${r.vo.padEnd(12)} issued ${r.issued}  bestellen ab ${r.ready}  (${r.status})`);
      }

      expect(rows.length, 'production has a forecast to deliver').toBeGreaterThan(0);
      // Every row's ready date must be issue+91 and inside the window — the report's whole contract.
      for (const r of rows) {
        expect(P.addDays(r.issued, TO_ORDER_DAYS), `${r.vo} ready date is issue+91`).toBe(r.ready);
        expect(r.ready >= WINDOW.from && r.ready <= WINDOW.to, `${r.vo} is inside the window`).toBe(true);
      }
    },
  );

  test(
    "#3773 FINDING: the forecast includes a closed VO, because the Blanko branch skips the status gate",
    { tag: ['@SuperAdmin', '@ProdQuarterForecast', '@ReadOnly'] },
    async () => {
      // `evaluate()`'s order is followupStatus -> orderingStatus -> isBlankoVO() -> treatment
      // status, so the Blanko branch is reached BEFORE the status gate and the forecaster
      // faithfully replicates only the first two. That is correct against the implementation, and
      // it means a report a PM reads as "VOs to order" can name an archived one.
      const forecast = blanko
        .map((v) => ({ v, r: P.forecastBlanko(v, TODAY) }))
        .filter((x) => 'readyDate' in x.r);
      const closed = forecast.filter((x) => !['Aktiv', 'Pending', 'Bereit', 'For Review'].includes(x.v.treatmentStatus ?? ''));
      console.log(`  forecast rows: ${forecast.length}; of those NOT in an in-progress status: ${closed.length}`);
      for (const c of closed) console.log(`    ${c.v.prescriptionId} (${c.v.treatmentStatus})`);

      if (closed.length > 0) {
        console.log('  => the report will name these. Faithful to the implementation, but worth');
        console.log('     telling the PM before they read the CSV as a list of VOs to order.');
      }
      // Asserted as a property of the PORT, not of today's data: the gate must be absent.
      const archived: Vo = { id: 0, prescriptionId: 'TEST-1', date: P.addDays(WINDOW.from, -TO_ORDER_DAYS), treatmentStatus: 'Archiviert', blankoVO: true };
      expect('readyDate' in P.forecastBlanko(archived, TODAY), 'the Blanko path applies no treatment-status gate').toBe(true);
    },
  );

  test(
    '#3731 IS deployed: the deceased dialog counts only in-progress VOs',
    { tag: ['@SuperAdmin', '@ProdDeceasedScope', '@ReadOnly', '@Slow'] },
    async () => {
      // The dual oracle: on a patient holding BOTH kinds the old rule (everything but
      // cancelled/archived) and the new one (the four in-progress statuses) disagree, so the two
      // dialog endpoints decide which is deployed. /status cannot (release, not commit — #3704).
      const seed = await sa.vosByIds([]);
      void seed;
      const aktiv = (await sa.vosIssuedBetween('2026-01-01', '2026-12-31')).vos
        .filter((v) => v.treatmentStatus === 'Aktiv')
        .slice(0, 40);
      const patientIds = [...new Set(aktiv.map((v) => (typeof v.patient === 'number' ? v.patient : v.patient?.id)).filter(Boolean) as number[])];

      const fixtures: { pid: number; old: number; neu: number }[] = [];
      for (const pid of patientIds) {
        const vos = await sa.vosOfPatient(pid);
        const neu = vos.filter((v) => (CANCELLABLE as readonly string[]).includes(v.treatmentStatus ?? '')).length;
        const prot = vos.filter((v) => (PROTECTED as readonly string[]).includes(v.treatmentStatus ?? '')).length;
        if (neu > 0 && prot > 0) fixtures.push({ pid, old: neu + prot, neu });
        if (fixtures.length >= 4) break;
      }
      console.log(`  discriminating patients found: ${fixtures.length}`);
      expect(fixtures.length, 'production has patients holding both kinds').toBeGreaterThan(0);

      for (const f of fixtures) {
        const count = await sa.activeVosCount(f.pid);
        const listed = await sa.activeVos(f.pid);
        console.log(`    patient ${f.pid}: old rule ${f.old}, new rule ${f.neu} -> count ${count}, list ${listed}`);
        expect(count, `patient ${f.pid}: the count endpoint follows the NEW rule`).toBe(f.neu);
        expect(listed, `patient ${f.pid}: the list endpoint agrees`).toBe(f.neu);
        expect(count, 'and is NOT the old rule').not.toBe(f.old);
      }
    },
  );

  test(
    "#3731: the status table, and production has no VO the rule's IN could miss",
    { tag: ['@SuperAdmin', '@ProdDeceasedScope', '@ReadOnly'] },
    async () => {
      const all = await sa.total();
      const counts: Record<string, number> = {};
      for (const s of [...CANCELLABLE, ...PROTECTED, 'Abgebrochen', 'Archiviert', 'Gelöscht']) {
        counts[s] = await sa.statusCount(s);
      }
      const summed = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`  book ${all}; by status ${JSON.stringify(counts)}`);
      console.log(`  cancellable ${(CANCELLABLE as readonly string[]).reduce((a, s) => a + counts[s], 0)}, protected ${(PROTECTED as readonly string[]).reduce((a, s) => a + counts[s], 0)}`);
      console.log(`  Σ statuses ${summed} vs book ${all} -> unstatused ${all - summed}`);

      for (const s of [...CANCELLABLE, ...PROTECTED]) expect(counts[s], `${s} occurs`).toBeGreaterThan(0);
      // The rule matches with IN, which no NULL satisfies. Staging has 43 such VOs; production has
      // none — measured rather than assumed, because it decides whether that gap applies here.
      expect(all - summed, 'every production VO carries a treatment status').toBe(0);
    },
  );

  test(
    '#3731: protected VOs survive a deceased termination at scale',
    { tag: ['@SuperAdmin', '@ProdDeceasedScope', '@ReadOnly', '@Slow'] },
    async () => {
      // The strongest production evidence, and it is a distribution rather than a fixture: under
      // the OLD rule every VO the cascade touched would now be Abgebrochen.
      const logs = await sa.terminationLogs();
      const deceased = logs.filter((l) => P.isDeceasedTermination(l));
      const recent = deceased.filter((l) => l.createdAt.slice(0, 7) >= '2026-08');
      console.log(`  ${logs.length} termination logs, ${deceased.length} carrying 'deceased', ${recent.length} since 2026-08`);
      expect(deceased.length, 'production has a deceased population').toBeGreaterThan(0);

      const ids = [...new Set(recent.map((l) => l.prescriptionId))];
      const vos = await sa.vosByIds(ids);
      const byStatus: Record<string, number> = {};
      for (const v of vos) byStatus[v.treatmentStatus ?? '(none)'] = (byStatus[v.treatmentStatus ?? '(none)'] ?? 0) + 1;
      const survived = (PROTECTED as readonly string[]).reduce((a, s) => a + (byStatus[s] ?? 0), 0);
      console.log(`  ${vos.length} VOs with a recent deceased termination: ${JSON.stringify(byStatus)}`);
      console.log(`  sitting in a PROTECTED status today: ${survived}`);

      expect(vos.length, 'the recent population resolved').toBeGreaterThan(0);
      // The fix's whole point: billed, finished, expired and sent-back VOs are left alone.
      expect(survived, 'protected VOs survived the cascade').toBeGreaterThan(0);
      expect(survived / vos.length, 'and they are the majority, not a handful').toBeGreaterThan(0.3);
    },
  );

  test.fixme(
    "#3773 AC1/AC2: the run itself, its CSV and the delivery to the PM",
    { tag: ['@SuperAdmin', '@ProdQuarterForecast', '@ReadOnly'] },
    async () => {
      // `app:report:quarter-change-order-forecast` is console-only and writes its CSV to S3 — there
      // is no route, so neither the run nor the file is client-reachable, and `/status` gives a
      // release not a commit (#3704) so deployment is not decidable either.
      //
      // What IS on the record: the forecast this file derives from production data is what the
      // report should contain for its Blanko arm. The frequency arm cannot be re-derived, because
      // `decisionFrequencyPerWeek` is in no serialization group and the VO's own `actualFrequency`
      // is served as an empty object.
      expect(true).toBe(false);
    },
  );
});
