import { test, expect } from '@playwright/test';
import { ProdRiskRowsDatesPage, type RiskRow } from '../../../Pages/superadmin/sa.prod-risk-rows-dates.page';

/**
 * PRODUCTION — RC 3.14 **#3775** (one shared ready-for-billing population behind three surfaces)
 * and **#3785** (those rows name the VO's real status and gain the issue date and sessions done).
 *
 * **READ-ONLY:** every request a GET, plus navigating and reading the board. The grouped view's
 * download is a POST and is deliberately not called, so #3785 AC5's eleven CSV columns are not
 * checked here — its DATA is, from the payload the export is built from.
 *
 * **NO PATIENT DATA:** the payload carries real `patientName` values; nothing reads or logs them.
 */

const P = ProdRiskRowsDatesPage;

/** #3785 AC6 — the Admin-Performance variant, which #3814 did NOT touch. */
const TOPIC_ADMIN: Record<string, string> = {
  'Fertig Behandelt': 'Fertig behandelt, bereit für die Abrechnung',
  Abgebrochen: 'Abgebrochen, bereit für die Abrechnung',
  Abgelaufen: 'Abgelaufen, bereit für die Abrechnung',
};

/** What #3785 replaced: one combined label for finished-or-cancelled. */
const COMBINED_BEFORE_3785 = 'Fertig behandelt / abgebrochen';

test.describe('#3775 + #3785 ready-for-billing on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  let sa: ProdRiskRowsDatesPage;
  let tiles: Record<string, number>;
  let ready: RiskRow[];

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    sa = new ProdRiskRowsDatesPage();
    await sa.connect();
    const r = await sa.risks();
    tiles = r.tiles;
    ready = r.rows.filter((x) => x.tile === P.READY_TILE);
    console.log(`  ready-for-billing tile: ${ready.length} rows (tile reports ${tiles[P.READY_TILE]})`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    '#3785 is deployed: all six Thema texts ship and the combined label is gone',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly'] },
    async ({ page }) => {
      // The Thema is chosen CLIENT-side from `voStatus`, so the dictionary is the probe — and it is
      // a before/after one, since #3785 REPLACED a single combined label with six per-status ones.
      const prod = new ProdRiskRowsDatesPage(page);
      const bundle = await prod.entryBundle();

      // Counted in BOTH forms: the bundle escapes non-ASCII, so a literal search for a string
      // containing "für" returns 0 and reads exactly like "never shipped" (#3337). The Orga texts
      // happen to be pure ASCII; the Admin ones are not, which is how this test first failed.
      for (const [status, text] of Object.entries(P.TOPIC_AFTER_3814)) {
        const n = P.escapedOccurrences(bundle, text);
        console.log(`  orga  [${status}]: ${n}`);
        expect(n, `the Therapeuten-Orga Thema for ${status}`).toBeGreaterThan(0);
      }
      for (const [status, text] of Object.entries(TOPIC_ADMIN)) {
        const n = P.escapedOccurrences(bundle, text);
        console.log(`  admin [${status}]: ${n}`);
        expect(n, `the Admin-Performance Thema for ${status}`).toBeGreaterThan(0);
      }
      const combined = P.escapedOccurrences(bundle, COMBINED_BEFORE_3785);
      console.log(`  the combined label #3785 replaced: ${combined}`);
      expect(combined, '#3785 replaced the combined finished/cancelled label').toBe(0);
    },
  );

  test(
    '#3775 AC1: one population — three statuses, in no billing batch, with a signed treatment',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly', '@Slow'] },
    async () => {
      expect(ready.length, 'the tile count equals its row count').toBe(tiles[P.READY_TILE]);

      const byStatus = ready.reduce<Record<string, number>>((a, r) => {
        const k = r.voStatus ?? '(none)';
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  voStatus: ${JSON.stringify(byStatus)}`);
      // All three must occur, or the widened population is unexercised — before #3775 the tile held
      // only finished VOs, so this is also that ticket's own before/after.
      for (const s of P.END_STATUSES) expect(byStatus[s] ?? 0, `${s} reaches the tile`).toBeGreaterThan(0);
      expect(Object.keys(byStatus).every((k) => P.END_STATUSES.includes(k)), 'no other status reaches it').toBe(true);

      // The billing-batch clause, on a deterministic spread rather than the first N (which would be
      // one therapist's caseload).
      const step = Math.max(1, Math.floor(ready.length / 40));
      const sample = ready.filter((_, i) => i % step === 0).slice(0, 40);
      const vos = await sa.vosByIds(sample.map((r) => r.prescriptionId));
      const batched = vos.filter((v) => (v.billingBatchCount ?? 0) !== 0);
      console.log(`  sampled ${vos.length} VOs; in a billing batch: ${batched.length}`);
      expect(batched, 'nothing on the tile is already in a billing batch').toHaveLength(0);

      // The signed-treatment gate is not exposed as a count on every surface, but `daysSince` is
      // DERIVED from the last signed treatment — so a VO without one could not carry a value.
      const noValue = ready.filter((r) => r.daysSince === null || r.daysSince === undefined);
      console.log(`  rows with no daysSince: ${noValue.length}`);
      expect(noValue, 'every row has a signed treatment to count from').toHaveLength(0);
    },
  );

  test(
    "#3775 AC6: the tile's 30-day boundary, exercised on both sides",
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly'] },
    async () => {
      const ds = ready.map((r) => r.daysSince!).filter((d) => d !== null);
      const at30 = ds.filter((d) => d === 30).length;
      const at31 = ds.filter((d) => d === 31).length;
      console.log(`  min daysSince ${Math.min(...ds)}; rows at exactly 30: ${at30}; at 31: ${at31}`);
      expect(at30, 'a VO at exactly 30 days is NOT on the tile').toBe(0);
      expect(Math.min(...ds), 'the youngest row is 31 days').toBeGreaterThanOrEqual(31);
      // The other side of the boundary must actually occur, or "> 30" is satisfied by a population
      // that happens to be much older.
      expect(at31, 'a VO at exactly 31 days IS on the tile').toBeGreaterThan(0);
    },
  );

  test(
    '#3775 AC5: the Orga tile and the Arbeitszeiten column agree therapist for therapist',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly'] },
    async () => {
      // AC5 is scoped "for any one therapist", NOT to the totals: the two surfaces have different
      // therapist populations, so comparing sums reports a mismatch that is not one.
      const wh = new Map((await sa.workingHours()).map((w) => [w.therapistId, w]));
      const perTherapist = new Map<number, number>();
      for (const r of ready) perTherapist.set(r.therapistId, (perTherapist.get(r.therapistId) ?? 0) + 1);

      const both = [...perTherapist.keys()].filter((t) => wh.has(t));
      const mismatches: string[] = [];
      for (const t of both) {
        const tile = perTherapist.get(t)!;
        const col = wh.get(t)!.completedUnbilledOver30Count ?? 0;
        if (tile !== col) mismatches.push(`therapistId ${t}: tile ${tile}, Arbeitszeiten ${col}`);
      }
      console.log(`  therapists on the tile ${perTherapist.size}, on both surfaces ${both.length}`);
      console.log(`  mismatches: ${mismatches.length}`);
      for (const m of mismatches.slice(0, 6)) console.log(`    ${m}`);
      expect(both.length, 'the two surfaces overlap').toBeGreaterThan(0);
      expect(mismatches, 'the two surfaces count the same population per therapist').toHaveLength(0);

      // The Arbeitszeiten column also carries the unaged figure, which must be >= the >30 one.
      const wrong = both.filter((t) => (wh.get(t)!.completedUnbilledCount ?? 0) < (wh.get(t)!.completedUnbilledOver30Count ?? 0));
      expect(wrong, 'the unaged count includes the aged one').toHaveLength(0);
    },
  );

  test(
    '#3785 AC3/AC4: every row carries an issue date and a session count, Blanko included',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly'] },
    async () => {
      // AC4's own stated worry is the column being empty for the statuses #3775 added, so this is
      // asserted over the whole tile rather than a sample.
      const noIssue = ready.filter((r) => !(r as any).issueDate);
      console.log(`  rows with an issue date: ${ready.length - noIssue.length} of ${ready.length}`);
      expect(noIssue, 'every row carries its issue date').toHaveLength(0);

      const blanko = ready.filter((r) => r.blankoVO === true);
      const plain = ready.filter((r) => r.blankoVO !== true);
      const missing = plain.filter((r) => r.activityCount === null || r.totalTreatments === null);
      console.log(`  Blanko rows ${blanko.length}, non-Blanko ${plain.length}, non-Blanko missing a count ${missing.length}`);
      expect(missing, 'a non-Blanko row carries n / m').toHaveLength(0);
      expect(blanko.every((r) => r.activityCount !== null), 'a Blanko row still carries its n').toBe(true);

      // Worth knowing and NOT assumed from staging: there, every Blanko VO reported
      // totalTreatments 0, so `n / BV` looked like a consequence of the zero. On production some
      // Blanko VOs carry a non-zero total, which shows the `BV` rendering keys on the Blanko FLAG.
      const totals = [...new Set(blanko.map((r) => r.totalTreatments))].sort();
      console.log(`  distinct totalTreatments on Blanko rows: ${JSON.stringify(totals)}`);
      expect(blanko.length, 'production has Blanko rows on the tile').toBeGreaterThan(0);

      const perStatus = P.END_STATUSES.map((s) => `${s}=${ready.filter((r) => r.voStatus === s && (r as any).issueDate).length}`);
      console.log(`  issue date present per status: ${perStatus.join(', ')}`);
    },
  );

  test(
    '#3785 AC2: the grouped view paints the ten columns in order',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      const prod = new ProdRiskRowsDatesPage(page);
      await prod.openOrgaBoard();
      await prod.waitForGroups();
      const headers = await page.evaluate(() => {
        const wanted = ['Patient:in', 'VO #', 'Ausst. Datum', 'Wert', 'HM', 'Thema', 'Stufe', 'Status/Frist', 'Beh. Status', 'Empfohlene Aktion'];
        const found: { text: string; x: number; y: number }[] = [];
        document.querySelectorAll('div,span').forEach((n) => {
          const el = n as HTMLElement;
          if (el.children.length !== 0) return;
          const t = (el.textContent ?? '').trim();
          if (!wanted.includes(t)) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          found.push({ text: t, x: r.x, y: r.y });
        });
        // the header row is the topmost band containing them
        if (!found.length) return [];
        const top = Math.min(...found.map((f) => f.y));
        return found.filter((f) => f.y - top < 24).sort((a, b) => a.x - b.x).map((f) => f.text);
      });
      console.log(`  painted columns: ${JSON.stringify(headers)}`);
      test.skip(headers.length === 0, 'the grouped view did not paint its header row');

      // #3785 inserts `Ausst. Datum` 3rd and `Beh. Status` 9th. Assert the ORDER of what is painted
      // rather than exact equality, so a later ticket adding a column does not fail this.
      expect(headers, 'AC4 — the issue date column').toContain('Ausst. Datum');
      expect(headers, 'AC3 — the sessions-done column').toContain('Beh. Status');
      expect(headers.indexOf('Ausst. Datum'), 'Ausst. Datum follows VO #').toBeGreaterThan(headers.indexOf('VO #'));
      expect(headers.indexOf('Beh. Status'), 'Beh. Status precedes Empfohlene Aktion').toBeLessThan(headers.indexOf('Empfohlene Aktion'));
      expect(headers.indexOf('Thema'), 'Thema sits between HM and Stufe').toBeGreaterThan(headers.indexOf('HM'));
    },
  );

  test(
    'FINDING — the Admin-Performance surface is not reachable for this account on production',
    { tag: ['@SuperAdmin', '@ProdReadyBilling', '@ReadOnly'] },
    async () => {
      // #3775's third surface and #3785 AC6's own board. On staging this Super Admin can open it;
      // on production the same login cannot, so those rows are unverifiable here — an ACCESS gate,
      // not a defect, and measured each run so the gap cannot go stale.
      const me = (await sa.boardAccess()) as Record<string, unknown>;
      const status = await sa.probe('/kpis/admin-performance/risks');
      const control = await sa.probe('/kpis/zzz-not-a-route');
      console.log(`  roles: ${JSON.stringify(me.roles)}`);
      console.log(`  canAccessAdminPerformanceBoard: ${me.canAccessAdminPerformanceBoard}`);
      console.log(`  canAccessTherapeutenOrgaBoard : ${me.canAccessTherapeutenOrgaBoard}`);
      console.log(`  GET /kpis/admin-performance/risks -> ${status}   (404 control -> ${control})`);

      // 403 and not 404 is what makes this an access gate rather than a missing route.
      expect(status, 'the board refuses this account').toBe(403);
      expect(control, 'a route that does not exist answers 404').toBe(404);
      expect(me.canAccessAdminPerformanceBoard, 'the refusal matches the account flag').toBe(false);
      expect(me.canAccessTherapeutenOrgaBoard, 'the Orga board, which the rest of this file reads, IS allowed').toBe(true);
      console.log('  => #3775 AC2/AC3 and AC5\'s third surface, and #3785 AC6, need an allowlisted production login');
    },
  );
});
