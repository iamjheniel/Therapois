import { test, expect } from '@playwright/test';
import { ProdRiskRowsDatesPage, type RiskRow } from '../../../Pages/superadmin/sa.prod-risk-rows-dates.page';

/**
 * PRODUCTION — RC 3.14 #3814 (ready-for-billing dates count from the LAST SIGNED TREATMENT) and
 * #3803 (the risk table lists each VO ONCE with all its risks), both verified on staging first.
 *
 * **READ-ONLY.** Every request is a GET; the screen is navigated and read. `POST /kpis/orga/risks/export`
 * is deliberately NOT called — it persists nothing, but it is a POST, so on production it is left
 * for a human. What that costs is stated in the file rather than glossed.
 *
 * **NO PATIENT DATA.** The payload carries real `patientName` values; nothing here reads or logs
 * them. Every assertion is a count, a date or a VO number.
 */

const P = ProdRiskRowsDatesPage;

test.describe('#3814 + #3803 on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  let sa: ProdRiskRowsDatesPage;
  let tiles: Record<string, number>;
  let rows: RiskRow[];

  test.beforeAll(async () => {
    sa = new ProdRiskRowsDatesPage();
    await sa.connect();
    const r = await sa.risks();
    tiles = r.tiles;
    rows = r.rows;
    console.log(`  production /kpis/orga/risks: ${rows.length} rows, tiles ${JSON.stringify(tiles)}`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    'both tickets are deployed to production, decided from the bundle and the payload',
    { tag: ['@SuperAdmin', '@ProdRiskRows', '@ReadOnly'] },
    async ({ page }) => {
      const { version } = await sa.status();
      console.log(`  production API: ${version}`);
      expect(version, 'production serves a 3.14 API').toMatch(/^3\.1[4-9]/);

      // #3814's Thema texts are chosen CLIENT-side from `voStatus`, so the dictionary is the probe —
      // and it is a before/after one, because #3814 REPLACED #3785's wording rather than adding to it.
      const prod = new ProdRiskRowsDatesPage(page);
      const bundle = await prod.entryBundle();
      for (const [status, text] of Object.entries(P.TOPIC_AFTER_3814)) {
        const n = P.occurrences(bundle, text);
        console.log(`  after  #3814 [${status}]: ${n}`);
        expect(n, `#3814's corrected Thema for ${status} is in the production bundle`).toBeGreaterThan(0);
      }
      for (const [status, text] of Object.entries(P.TOPIC_BEFORE_3814)) {
        const n = P.occurrences(bundle, text);
        console.log(`  before #3814 [${status}]: ${n}`);
        expect(n, `#3785's superseded wording for ${status} is gone`).toBe(0);
      }

      // #3775 is the prerequisite for both — before it the tile held only finished VOs, so the
      // `voStatus` field and the two extra statuses arriving together is what makes #3814's AC2 and
      // #3803's multi-risk VOs possible at all.
      const ready = rows.filter((r) => r.tile === P.READY_TILE);
      const statuses = new Set(ready.map((r) => r.voStatus ?? ''));
      console.log(`  ready-for-billing rows ${ready.length}, statuses ${JSON.stringify([...statuses])}`);
      expect(ready.length, 'production has a ready-for-billing population').toBeGreaterThan(0);
      for (const s of P.END_STATUSES) {
        expect(statuses.has(s), `#3775: ${s} reaches the tile`).toBe(true);
      }
    },
  );

  test(
    '#3814: the ready-for-billing date counts from the last SIGNED treatment, not the end-status date',
    { tag: ['@SuperAdmin', '@ProdRiskRows', '@ReadOnly', '@Slow'] },
    async () => {
      // The column AC1 is about is `daysSince`, and `statusDate` is the date it counts from — so the
      // ticket reduces to: is `statusDate` the last SIGNED treatment? That is answered by reading
      // the VO's own activities, which is a GET, and it needs no export.
      const ready = rows.filter((r) => r.tile === P.READY_TILE);

      // Sample deterministically across the whole tile rather than taking the first N, which would
      // be one therapist's caseload.
      const step = Math.max(1, Math.floor(ready.length / 120));
      const sample = ready.filter((_, i) => i % step === 0).slice(0, 120);
      const acts = await sa.activitiesFor(sample.map((r) => r.prescriptionId));

      let signedMatch = 0;
      let naiveMatch = 0;
      let noSession = 0;
      const mismatches: string[] = [];

      for (const r of sample) {
        const a = acts.get(r.prescriptionId) ?? [];
        const lastSigned = P.lastSignedDate(a);
        if (!lastSigned) {
          noSession += 1;
          continue;
        }
        const sd = r.statusDate!.slice(0, 10);
        if (lastSigned === sd) signedMatch += 1;
        else mismatches.push(`${r.voNumber} (${r.voStatus}): statusDate ${sd}, last signed ${lastSigned}`);
        if (P.lastAnyDate(a) === sd) naiveMatch += 1;
      }

      console.log(`  sampled ${sample.length} of ${ready.length} ready VOs`);
      console.log(`  statusDate == last SIGNED treatment       : ${signedMatch} match, ${mismatches.length} mismatch`);
      console.log(`  statusDate == last treatment of ANY kind  : ${naiveMatch} match   <- the naive predicate`);
      for (const m of mismatches.slice(0, 6)) console.log(`    ${m}`);

      expect(noSession, '#3775 gates the tile on a signed treatment, so every row must have one').toBe(0);
      expect(mismatches, 'every sampled row counts from its last signed treatment').toHaveLength(0);

      // THE ANTI-VACUITY GUARD. If no sampled VO has a rejected or planned session after its last
      // signed one, the two predicates agree everywhere and the test above would pass against a
      // build that simply used "the last activity". The gap between them is what makes it evidence.
      console.log(`  discriminating VOs (the two predicates disagree): ${signedMatch - naiveMatch}`);
      expect(naiveMatch, 'the naive predicate must do WORSE, or the sample proves nothing').toBeLessThan(signedMatch);

      // AC2: the value is filled for all three end statuses, where before #3814 it was filled only
      // for finished VOs — asserted over the whole tile, not the sample.
      const byStatus: Record<string, { rows: number; withValue: number }> = {};
      for (const r of ready) {
        const k = r.voStatus ?? '(none)';
        byStatus[k] ??= { rows: 0, withValue: 0 };
        byStatus[k].rows += 1;
        if (r.daysSince !== null && r.daysSince !== undefined) byStatus[k].withValue += 1;
      }
      console.log(`  AC2 — daysSince filled per status: ${JSON.stringify(byStatus)}`);
      for (const s of P.END_STATUSES) {
        expect(byStatus[s]?.rows ?? 0, `${s} occurs`).toBeGreaterThan(0);
        expect(byStatus[s].withValue, `${s}: every row carries a value`).toBe(byStatus[s].rows);
      }

      // The tile's own rule, which is also the regression guard for the date moving: nothing on it
      // is 30 days or less since its last signed treatment.
      const under = ready.filter((r) => (r.daysSince ?? 99) <= 30);
      console.log(`  rows at <= 30 days: ${under.length}; min daysSince ${Math.min(...ready.map((r) => r.daysSince ?? 1e9))}`);
      expect(under, 'the > 30 day rule holds on the corrected date').toHaveLength(0);
    },
  );

  test(
    '#3803: the grouped view counts each VO once, and the screen agrees with the payload',
    { tag: ['@SuperAdmin', '@ProdRiskRows', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      // The provider is unchanged by #3803 — it still serves one row per VO PER TILE — so the
      // payload is the oracle and the change is the client-side grouping.
      const grouped = P.rowsFor(rows, null);
      const distinct = P.groupBy(grouped, 'distinct');
      const byRows = P.groupBy(grouped, 'rows');
      const distinctVos = new Set(grouped.map((r) => r.voNumber)).size;
      const disagreeing = [...distinct.keys()].filter((k) => distinct.get(k)!.count !== byRows.get(k)!.count);

      console.log(`  grouped view: ${grouped.length} rows, ${distinctVos} distinct VOs, ${distinct.size} groups`);
      console.log(`  groups where distinct-VO != row count: ${disagreeing.length} of ${distinct.size}`);
      console.log(`  Σ distinct ${[...distinct.values()].reduce((a, g) => a + g.count, 0)} vs Σ rows ${[...byRows.values()].reduce((a, g) => a + g.count, 0)}`);

      // ANTI-VACUITY: if no group's two counts differ, the screen would look right under either
      // rule and the comparison below would prove nothing.
      expect(disagreeing.length, 'production has groups the two counting rules disagree on').toBeGreaterThan(0);

      const prod = new ProdRiskRowsDatesPage(page);
      await prod.openOrgaBoard();
      await prod.waitForGroups();
      const painted = await prod.paintedGroups();
      console.log(`  painted groups: ${painted.length}`);
      expect(painted.length, 'the board paints groups').toBeGreaterThan(0);

      // Compare only the groups that are actually on screen — the view paginates, so a missing
      // group is not a failure; a WRONG count is.
      let checked = 0;
      let discriminating = 0;
      const wrong: string[] = [];
      for (const g of painted) {
        const key = P.normalizeName(g.name);
        const d = distinct.get(key);
        const r = byRows.get(key);
        if (!d || !r) continue;
        checked += 1;
        if (d.count !== r.count) discriminating += 1;
        if (g.count !== d.count) {
          wrong.push(`${key}: painted ${g.count}, distinct-VO ${d.count}, row-count ${r.count}`);
        }
      }
      console.log(`  matched ${checked} painted groups against the payload; ${discriminating} of them discriminate`);
      for (const w of wrong.slice(0, 8)) console.log(`    ${w}`);

      expect(checked, 'painted groups resolve against the payload').toBeGreaterThan(0);
      expect(wrong, 'every painted group counts DISTINCT VOs, not rows').toHaveLength(0);
      // ...and at least one of the groups checked must be one where the two rules differ, or the
      // screen comparison is satisfied by groups that look the same either way.
      expect(discriminating, 'at least one checked group would differ under the old row count').toBeGreaterThan(0);
    },
  );

  test(
    '#3803: with the ready-for-billing tile selected the two counting rules agree, as on staging',
    { tag: ['@SuperAdmin', '@ProdRiskRows', '@ReadOnly'] },
    async () => {
      // The complement of the test above, and the reason #3803's own AC8 could freeze the
      // tile-selected download: within ONE tile a VO appears once, so distinct-VO and row counting
      // cannot differ. If they ever do, the provider has started emitting duplicate rows.
      const ready = P.rowsFor(rows, P.READY_TILE);
      const d = P.groupBy(ready, 'distinct');
      const r = P.groupBy(ready, 'rows');
      const disagree = [...d.keys()].filter((k) => d.get(k)!.count !== r.get(k)!.count);
      console.log(`  ready tile: ${ready.length} rows, ${d.size} groups, ${disagree.length} disagreements`);
      expect(disagree, 'within one tile each VO appears exactly once').toHaveLength(0);
      expect(ready.length, 'the tile row count equals its reported figure').toBe(tiles[P.READY_TILE]);

      // The multi-risk population is what makes the no-tile view differ from this one — measured so
      // the difference between the two tests is a number rather than an assertion about nothing.
      const perVo = new Map<string, number>();
      for (const row of P.rowsFor(rows, null)) perVo.set(row.voNumber, (perVo.get(row.voNumber) ?? 0) + 1);
      const multi = [...perVo.values()].filter((n) => n > 1).length;
      console.log(`  VOs carrying more than one risk: ${multi}`);
      expect(multi, '#3803 has a real population on production').toBeGreaterThan(0);
    },
  );
});
