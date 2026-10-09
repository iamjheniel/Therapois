import { test, expect } from '../../fixtures/session';
import { ProdDischargePage, type Vo, type ExpiryLog } from '../../../Pages/superadmin/sa.prod-discharge.page';

/**
 * PRODUCTION — RC 3.14 **#3830** (a discharge VO SHOWS day 7 / day 12) and **#3800** (it EXPIRES on
 * those days). Both verified on staging first.
 *
 * **READ-ONLY:** every request is a GET. The nightly command is never run, and #3830's AC6 preview
 * is skipped here because it is a POST.
 *
 * **The headline is a split:** the display is live on production and the expiry is not firing.
 */

const P = ProdDischargePage;
const TODAY = new Date().toISOString().slice(0, 10);
/**
 * Issue-date floor for the population walk, which is the file's whole runtime: production paginates
 * `/prescriptions` at ~10 s per 100 rows and `?isDischargeManagement=` is silently ignored, so the
 * flag has to be read per row. 2026-08-01 is ~46 pages (~8 min) and holds every OPEN discharge VO
 * by construction — an open one is inside or just past a 12-day window — plus enough closed ones
 * for AC2. Widening it only adds older closed VOs.
 */
const SINCE = '2026-08-01';

test.describe('#3830 + #3800 discharge window on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(2_400_000);

  let sa: ProdDischargePage;
  let discharge: Vo[];
  let scanned: number;
  let inScope: Vo[];
  let firstBeh: Map<number, string | null>;
  let tail: ExpiryLog[];

  test.beforeAll(async () => {
    // `describe.configure({ timeout })` does NOT reach a beforeAll, and neither does the
    // `test.setTimeout` above — the hook needs its own, or the walk is killed mid-flight and every
    // later request fails with "Request context disposed", which reads like an auth problem.
    test.setTimeout(2_400_000);
    sa = new ProdDischargePage();
    await sa.connect();
    const walk = await sa.dischargeVosSince(SINCE);
    scanned = walk.scanned;
    discharge = walk.discharge;
    inScope = discharge.filter((v) => P.inScope(v));
    firstBeh = await sa.firstTreatmentDates(discharge.map((v) => v.id));
    tail = await sa.expiryLogTail();
    console.log(`  scanned ${scanned} VOs issued since ${SINCE}; discharge ${discharge.length} (in scope ${inScope.length})`);
    console.log(`  expiry-log tail: ${tail.length} entries, ${tail[0]?.createdAt.slice(0, 10)} .. ${tail.at(-1)?.createdAt.slice(0, 10)}`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    '#3830 IS deployed: every in-scope discharge VO shows issue+7 and issue+12',
    { tag: ['@SuperAdmin', '@ProdDischarge', '@ReadOnly', '@Slow'] },
    async () => {
      const { version } = await sa.status();
      console.log(`  production API: ${version}`);

      const byIns = discharge.reduce<Record<string, number>>((a, v) => {
        const k = v.insuranceType ?? 'unset';
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  discharge VOs by insurance type: ${JSON.stringify(byIns)}`);

      const wrong: string[] = [];
      for (const v of inScope) {
        if (P.iso(v.treatmentStartDeadline) !== P.addDays(v.date, P.START_DAYS)) {
          wrong.push(`${v.prescriptionId}: start ${P.iso(v.treatmentStartDeadline)} != issue+7`);
        }
        if (P.iso(v.validityDate) !== P.addDays(v.date, P.VALIDITY_DAYS)) {
          wrong.push(`${v.prescriptionId}: validity ${P.iso(v.validityDate)} != issue+12`);
        }
      }
      for (const w of wrong.slice(0, 8)) console.log(`    ${w}`);
      expect(inScope.length, 'production has an in-scope discharge population').toBeGreaterThan(0);
      expect(wrong, 'every in-scope discharge VO shows the new window').toHaveLength(0);

      // AC3's excluded row, and the control that stops the above being "everything gets +7/+12":
      // a PKV discharge VO is excluded from expiry entirely (#3709) and so carries neither date.
      const pkv = discharge.filter((v) => v.insuranceType === 'private');
      console.log(`  PKV discharge VOs: ${pkv.length}`);
      for (const v of pkv) {
        expect(v.treatmentStartDeadline ?? null, `${v.prescriptionId}: PKV keeps no start deadline`).toBeNull();
        expect(v.validityDate ?? null, `${v.prescriptionId}: PKV keeps no validity`).toBeNull();
      }
      expect(pkv.length, "AC3's PKV row has a live fixture").toBeGreaterThan(0);

      // #3830's own forecast: "No BG, Privat Basis or no-insurance-type discharge VOs exist."
      // Reported rather than asserted — it is a statement about today's data, not a rule.
      for (const t of ['accident', 'privat_basis', 'unset']) {
        console.log(`  ${t} discharge VOs: ${byIns[t] ?? 0}${(byIns[t] ?? 0) === 0 ? '  (as the ticket forecast)' : ''}`);
      }
    },
  );

  test(
    '#3830 AC2: the dates do not move once the VO closes',
    { tag: ['@SuperAdmin', '@ProdDischarge', '@ReadOnly'] },
    async () => {
      // AC2's rows overlap, so the session axis and the closed axis are counted separately — a
      // single-label classifier files a closed VO that started late under "closed" and reports a
      // coverage gap that is not there.
      const closed = inScope.filter((v) => !P.OPEN.includes(v.treatmentStatus ?? ''));
      const statuses = [...new Set(closed.map((v) => v.treatmentStatus ?? ''))].sort();
      console.log(`  closed in-scope discharge VOs: ${closed.length}, statuses ${JSON.stringify(statuses)}`);

      const wrong = closed.filter(
        (v) =>
          P.iso(v.treatmentStartDeadline) !== P.addDays(v.date, P.START_DAYS) ||
          P.iso(v.validityDate) !== P.addDays(v.date, P.VALIDITY_DAYS),
      );
      expect(closed.length, 'production has closed discharge VOs').toBeGreaterThan(0);
      expect(statuses.length, 'more than one closed status is exercised').toBeGreaterThan(1);
      expect(wrong, 'a closed discharge VO still shows issue+7 / issue+12').toHaveLength(0);

      const started = inScope.filter((v) => firstBeh.get(v.id));
      const late = started.filter((v) => P.daysBetween(v.date, firstBeh.get(v.id)!) > P.START_DAYS);
      console.log(`  with a session: ${started.length}; first session AFTER day 7: ${late.length}`);
      expect(started.length, 'AC2 row 2/3 have instances').toBeGreaterThan(0);
    },
  );

  test(
    'the nightly expiry job IS running on production, and writes #3651 German reasons',
    { tag: ['@SuperAdmin', '@ProdDischarge', '@ReadOnly'] },
    async () => {
      // This is the control that turns the finding below into evidence: without it, "no discharge
      // expiry" would be equally explained by the job not running at all.
      const auto = tail.filter((l) => l.type === 'automatic');
      const newest = auto.map((l) => l.createdAt).sort().at(-1) ?? null;
      console.log(`  automatic expiries in the tail: ${auto.length}, newest ${newest}`);
      expect(auto.length, 'the job expires VOs automatically').toBeGreaterThan(0);

      // Recent, not merely present: the job must have run within the last few days.
      const ageDays = newest ? P.daysBetween(newest.slice(0, 10), TODAY) : 999;
      console.log(`  newest automatic expiry is ${ageDays} day(s) old`);
      expect(ageDays, 'the nightly job ran recently').toBeLessThanOrEqual(3);

      // #3651 is live too, so German reasons are what a working discharge expiry would join.
      const german = auto.filter((l) => /Behandlungsbeginn nicht innerhalb von \d+ Tagen/.test(l.reason));
      console.log(`  automatic expiries carrying #3651's German start-deadline reason: ${german.length}`);
      expect(german.length, '#3651 is deployed on production').toBeGreaterThan(0);
    },
  );

  test(
    'FINDING — #3800 is NOT firing on production, although #3830 shows its dates',
    { tag: ['@SuperAdmin', '@ProdDischarge', '@ReadOnly'] },
    async () => {
      // A green evidence test: it measures the split and prints it, and asserts only the parts that
      // are facts about the rule rather than about the defect, so it keeps reporting once fixed.
      const withMarker = tail.filter((l) => P.isDischargeReason(l.reason));
      console.log(`  discharge expiry reasons in a ${tail.length}-entry tail: ${withMarker.length}`);

      const overdue: string[] = [];
      for (const v of inScope) {
        const due = P.dueExpiry(v, firstBeh.get(v.id) ?? null, TODAY);
        if (!due) continue;
        const logs = await sa.expiryLogsFor(v.id);
        const hasDischarge = logs.some((l) => P.isDischargeReason(l.reason));
        if (!hasDischarge) {
          overdue.push(`${v.prescriptionId} (${v.treatmentStatus}) due ${due.kind} since ${due.boundary}, ${P.daysBetween(due.boundary, TODAY)} d ago`);
        }
      }
      console.log(`  OPEN in-scope discharge VOs past their window with no discharge expiry: ${overdue.length}`);
      for (const o of overdue) console.log(`    ${o}`);

      // The rule itself is asserted, because it must hold whatever the job does: a VO that is NOT
      // yet past its window must not be reported as overdue.
      const notYet = inScope.filter(
        (v) => P.OPEN.includes(v.treatmentStatus ?? '') && !P.dueExpiry(v, firstBeh.get(v.id) ?? null, TODAY),
      );
      console.log(`  OPEN discharge VOs correctly still inside their window: ${notYet.length}`);
      for (const v of notYet) {
        expect(P.iso(v.validityDate)! >= TODAY || P.iso(v.treatmentStartDeadline)! >= TODAY, `${v.prescriptionId} is genuinely still open`).toBe(true);
      }

      if (withMarker.length === 0 && overdue.length > 0) {
        console.log('  => SPLIT: the board and the VO form show day 7 / day 12 (verified above),');
        console.log('     the nightly job runs (verified above) and writes German reasons,');
        console.log('     but no discharge expiry has ever been written and VOs are sitting overdue.');
        console.log('     Cause needs a developer: both commits are on release/3.14.0 and the shared');
        console.log('     DischargeWindow is demonstrably in the build, since the dates come from it.');
      }
    },
  );

  test.fixme(
    'AC1/AC6: an overdue discharge VO is expired by the nightly job with the Entlassmanagement reason',
    { tag: ['@SuperAdmin', '@ProdDischarge', '@ReadOnly'] },
    async () => {
      // Blocked by the finding above, not by a missing fixture: production has had overdue
      // discharge VOs for days and the job has run nightly without touching them. Measured
      // 2026-09-29 — 10469-2 (window12 due 2026-09-23), 10786-1 (start7 due 09-23), 10807-1
      // (window12 due 09-27) were all due BEFORE the 2026-09-28T20:02 run and were not expired.
      //
      // The catch-up invariant this should assert once the rule fires: a discharge VO may only
      // still be open if it became due AFTER the last run.
      const withMarker = tail.filter((l) => P.isDischargeReason(l.reason));
      expect(withMarker.length, 'production has written at least one discharge expiry').toBeGreaterThan(0);
    },
  );
});
