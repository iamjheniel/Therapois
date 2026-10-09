import { test, expect } from '../../fixtures/session';
import { WorkingHoursAbrechnungPage as W, type WhRow } from '../../../Pages/superadmin/sa.working-hours-abrechnung.page';

/**
 * RC 3.15 — #3725 (PR #3780, merged into `release/3.15.0` 2026-09-22): the Therapeuten-Orga
 * Arbeitszeiten table gains a third column mode, **Abrechnung**, with five per-therapist VO counts
 * and an expandable per-facility breakdown.
 *
 * **Read-only** — every request is a GET; the board is navigated, switched and expanded.
 *
 * **AC5 is the whole ticket** ("the facility sub-rows sum to the therapist row"), and it is exactly
 * checkable because the board's own `/kpis/management/working-hours` response carries both sides.
 * The spec captures that payload as the table loads (#3471) rather than re-issuing the query, so
 * the painted numbers are compared against the payload they were actually drawn from.
 */

test.describe('#3725 Arbeitszeiten Abrechnung mode with a per-facility split', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  let board: W;
  /** A therapist with several facilities AND a completedOnly ≠ union split — chosen live. */
  let target: WhRow;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    const ctx = await browser.newContext();
    board = new W(await ctx.newPage());
    await board.open();
    await board.selectMode('Abrechnung');
    await board.selectView('Therapeut:innen');
    const rows = board.rows();
    const multi = rows.filter((r) => (r.facilityBreakdown ?? []).length >= 2);
    // Prefer one that can also catch a binding to the WRONG completed field.
    target = multi.find(W.discriminatesOnCompleted)
      ?? multi.sort((a, b) => (b.facilityBreakdown!.length - a.facilityBreakdown!.length))[0];
    console.log(`  payload: ${rows.length} therapists, ${multi.length} with 2+ facilities`);
    console.log(`  target: ${target.therapistId} ${target.therapistName}` +
      ` (${target.facilityBreakdown!.length} facilities,` +
      ` completedOnly ${target.completedOnlyUnbilledCount} vs union ${target.completedUnbilledCount})`);
  });

  test(
    'DEPLOYED: the payload carries the new counts and a facilityBreakdown, and the mode is offered',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      const rows = board.rows();
      const first = rows[0];
      for (const f of ['cancelledUnbilledCount', 'expiredUnbilledCount', 'completedOnlyUnbilledCount', 'facilityBreakdown']) {
        expect(first, `the row carries ${f}`).toHaveProperty(f);
      }
      const withFb = rows.filter((r) => (r.facilityBreakdown ?? []).length > 0);
      console.log(`  ${rows.length} rows, ${withFb.length} with a facilityBreakdown`);
      expect(withFb.length, 'the breakdown is populated, not merely declared').toBeGreaterThan(10);

      // AC1 — a third mode beside the existing two. #3770 renamed "Standard" to "Details", so the
      // PR's own evidence line ("Standard · Operativ · Abrechnung") no longer matches verbatim.
      expect(await board.offersMode('Abrechnung'), 'Abrechnung is offered').toBe(true);
      expect(await board.offersMode('Operativ'), 'beside Operativ').toBe(true);
      expect(await board.offersMode('Details'), 'and Details (ex-Standard, #3770)').toBe(true);
      expect(await board.offersMode('Standard'), '"Standard" is gone after #3770').toBe(false);
    },
  );

  test(
    'AC5 over the WHOLE population, and the two fields that decide it',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      const rows = board.rows().filter((r) => (r.facilityBreakdown ?? []).length > 0);
      const bad: Record<string, number> = {};
      for (const key of W.COLUMN_KEYS) {
        bad[key] = rows.filter((r) => W.therapistValue(r, key) !== W.facilitySum(r, key)).length;
        console.log(`  ${key.padEnd(18)} therapist total vs Σ facilities: ${bad[key]} mismatches / ${rows.length}`);
        expect(bad[key], `${key} sums across the facility sub-rows`).toBe(0);
      }

      // The identity that explains WHY the right field matters: since #3775,
      // completedUnbilledCount is the union of all three end statuses.
      const union = rows.filter((r) =>
        (r.completedUnbilledCount ?? 0) ===
        (r.completedOnlyUnbilledCount ?? 0) + (r.cancelledUnbilledCount ?? 0) + (r.expiredUnbilledCount ?? 0));
      console.log(`  completedUnbilledCount == completedOnly + cancelled + expired on ${union.length}/${rows.length} rows`);
      expect(union.length, 'completedUnbilledCount is the union of the three end statuses').toBe(rows.length);

      // ...so binding the column to it would break AC5 on most therapists. Measured, not argued.
      const wrong = rows.filter((r) => (r.completedUnbilledCount ?? 0) !== W.facilitySum(r, 'completedUnbilled'));
      console.log(`  had the column bound to completedUnbilledCount, AC5 would fail on ${wrong.length}/${rows.length}`);
      expect(wrong.length, 'the wrong field genuinely disagrees, so this test can fail')
        .toBeGreaterThan(rows.length / 2);
    },
  );

  test(
    'AC2/AC3: the five columns are shown and "Fertig n. abger." is not',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      const headers = await board.headers();
      const painted = await board.headersPainted();
      console.log(`  headers (textContent): ${JSON.stringify(headers)}`);
      console.log(`  headers (as painted) : ${JSON.stringify(painted)}`);
      for (const h of W.COLUMN_HEADERS) {
        expect(headers, `the Abrechnung header "${h}"`).toContain(h);
      }
      // The ticket and the PR quote the PAINTED form, so both readings are pinned — a constant
      // written in one and read in the other fails on a correct build.
      for (const h of W.COLUMN_HEADERS_PAINTED) {
        expect(painted, `the painted header "${h}"`).toContain(h);
      }
      // ...and the ß survives the source reading, which is what makes `Maßnahme` matchable at all.
      expect(headers, 'the untouched note columns are still there').toContain('Maßnahme');
      // AC3's trap: the old column differs from the new one only by its PARENTHESES, so an
      // `includes` on the raw text matches both and AC3 passes on a build that still renders it.
      expect(headers, 'the Operativ column is not in this mode').not.toContain(W.OLD_COLUMN);
      expect(headers, 'only its parenthesised namesake is').toContain(W.NEW_COLUMN);

      // ...and it IS there in the mode that owns it, or the assertion above is satisfied by the
      // table simply having no columns.
      await board.selectMode('Operativ');
      const operativ = await board.headers();
      console.log(`  Operativ headers: ${JSON.stringify(operativ)}`);
      expect(operativ, 'Operativ still carries its own Fertig n. abger. column').toContain(W.OLD_COLUMN);
      expect(operativ, 'and not the Abrechnung one').not.toContain(W.NEW_COLUMN);
      await board.selectMode('Abrechnung');
    },
  );

  test(
    'AC2: a therapist row paints the five counts from the right fields',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      const painted = await board.paintedRow(target.therapistId);
      const expected = W.COLUMN_KEYS.map((k) => W.therapistValue(target, k));
      console.log(`  ${target.therapistName}: painted ${JSON.stringify(painted)} vs payload ${JSON.stringify(expected)}`);
      expect(painted, 'the row shows the payload values').toEqual(expected);

      // The discriminating half: on this therapist the two candidate fields differ, so a build
      // bound to completedUnbilledCount would paint the union instead.
      if (W.discriminatesOnCompleted(target)) {
        console.log(`  the wrong field would have painted ${target.completedUnbilledCount}`);
        expect(painted[2], 'the Fertig column reads completedOnlyUnbilledCount')
          .not.toBe(target.completedUnbilledCount);
      }

      // Every painted row agrees with the payload, not just the one under test.
      let checked = 0;
      for (const r of board.rows().slice(0, 12)) {
        if (!(await board.cell(r.therapistId, 'aktiveVos').count())) continue;
        const p = await board.paintedRow(r.therapistId);
        expect(p, `row ${r.therapistName}`).toEqual(W.COLUMN_KEYS.map((k) => W.therapistValue(r, k)));
        checked++;
      }
      console.log(`  ${checked} painted rows agree with the payload`);
      expect(checked, 'several rows were actually read').toBeGreaterThan(3);
    },
  );

  test(
    'AC4/AC5/AC6: expanding shows one sub-row per facility, they sum, and collapsing hides them',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      const fb = target.facilityBreakdown!;
      const before = await board.treeGlyphCount();
      await board.toggleExpand(target.therapistId);
      const ids = await board.facilityTestIds(target.therapistId);
      const after = await board.treeGlyphCount();
      console.log(`  expanded ${target.therapistName}: ${ids.length} sub-rows, tree glyphs ${before} -> ${after}`);
      expect(ids.length, 'one sub-row per facility in the payload').toBe(fb.length);
      expect(after - before, 'each sub-row carries a tree connector').toBe(fb.length);

      // Each sub-row shows that facility's own five counts.
      const seen: Record<string, number[]> = {};
      for (const tid of ids) {
        const row = await board.facilitySubRow(tid);
        const key = tid.replace(`working-hours-facility-t${target.therapistId}-`, '');
        seen[key] = row.numbers;
        console.log(`    ${key.padEnd(10)} ${JSON.stringify(row.name)} -> ${JSON.stringify(row.numbers)}`);
        const f = fb.find((x) => tid.endsWith(`fac-${x.facilityId}`) || (x.facilityId === null && /null|none|ohne/i.test(tid)));
        if (f) {
          expect(row.numbers, `sub-row ${f.facilityName ?? 'Ohne Einrichtung'}`)
            .toEqual([f.active, f.pending, f.completedUnbilled, f.cancelledUnbilled, f.expiredUnbilled]);
          if (f.facilityName) expect(row.name, 'the sub-row names its facility').toBe(f.facilityName);
        }
      }

      // AC5 on the PAINTED rows, column by column — iterated, so a sixth count added later cannot
      // quietly be left out of the invariant.
      const painted = await board.paintedRow(target.therapistId);
      for (let c = 0; c < W.COLUMN_KEYS.length; c++) {
        const sum = Object.values(seen).reduce((a, n) => a + (n[c] ?? 0), 0);
        console.log(`    Σ ${W.COLUMN_KEYS[c].padEnd(18)} = ${sum}  (row shows ${painted[c]})`);
        expect(sum, `the painted sub-rows sum to the painted ${W.COLUMN_KEYS[c]}`).toBe(painted[c]);
      }

      // AC6
      await board.toggleExpand(target.therapistId);
      expect(await board.facilityTestIds(target.therapistId), 'collapsing removes the sub-rows').toHaveLength(0);
      expect(await board.treeGlyphCount(), 'and their connectors').toBe(before);
    },
  );

  test(
    'facility-less VOs are their own bucket, or AC5 could not hold for anyone treating outside one',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      // `elderly_care_home_id` is nullable, so dropping those rows would silently break the sum.
      // Not an AC — a decision the PR records — and it is load-bearing for AC5.
      const rows = board.rows();
      const withNull = rows.filter((r) => (r.facilityBreakdown ?? []).some((f) => f.facilityId === null));
      console.log(`  ${withNull.length} of ${rows.length} therapists have a facility-less bucket`);
      test.skip(withNull.length === 0, 'no therapist on this board has a facility-less VO');

      const r = withNull.sort((a, b) =>
        (b.facilityBreakdown!.find((f) => f.facilityId === null)!.active)
        - (a.facilityBreakdown!.find((f) => f.facilityId === null)!.active))[0];
      const nullRow = r.facilityBreakdown!.find((f) => f.facilityId === null)!;
      console.log(`  ${r.therapistName}: facility-less ${JSON.stringify(nullRow)}`);
      await board.toggleExpand(r.therapistId);
      const ids = await board.facilityTestIds(r.therapistId);
      const labels: string[] = [];
      for (const tid of ids) labels.push((await board.facilitySubRow(tid)).name);
      console.log(`  sub-row labels: ${JSON.stringify(labels)}`);
      expect(ids.length, 'the facility-less bucket gets a sub-row of its own').toBe(r.facilityBreakdown!.length);
      expect(labels.some((l) => /ohne einrichtung/i.test(l)), 'labelled "Ohne Einrichtung"').toBe(true);
      await board.toggleExpand(r.therapistId);
    },
  );

  test(
    'FINDING: the two "Fertig" columns disagree, and the stale subset reads LARGER',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      // Reported, not failed: each column is correct under its own definition. But the ticket's
      // AC3 calls the new column "a different, therapist-level breakdown" of the old one, and PR
      // #3780 records the only difference as the >30-day staleness filter. They now differ on TWO
      // axes, because #3775 widened the OLD column's scope the day after this ticket merged:
      //   Operativ  "Fertig n. abger."   = completedUnbilledOver30Count — the >30-day subset of
      //                                    the UNION of Fertig + Abgebrochen + Abgelaufen
      //   Abrechnung "Fertig (n. abger.)" = completedOnlyUnbilledCount  — the WHOLE unbilled
      //                                    population of Fertig Behandelt alone
      // So the "subset" can exceed the "total", on two columns whose labels differ by one word.
      const rows = board.rows();
      const larger = rows.filter((r) =>
        (r.completedUnbilledOver30Count ?? 0) > (r.completedOnlyUnbilledCount ?? 0));
      const zero = larger.filter((r) => (r.completedOnlyUnbilledCount ?? 0) === 0);
      console.log(`  Operativ's "Fertig n. abger." exceeds Abrechnung's "Fertig (n. abger.)" on` +
        ` ${larger.length} of ${rows.length} therapists`);
      for (const r of larger.slice(0, 5)) {
        console.log(`    ${String(r.therapistName).padEnd(22)} Abrechnung ${r.completedOnlyUnbilledCount}` +
          ` | Operativ ${r.completedUnbilledOver30Count} | union ${r.completedUnbilledCount}`);
      }
      console.log(`  ...including ${zero.length} where Abrechnung reads 0 and Operativ does not`);
      // Pinned as an observation: if the columns are ever reconciled this test says so by failing.
      expect(larger.length, 'the two columns do diverge on this build').toBeGreaterThan(0);
      // The arithmetic behind it, so the report cannot be mistaken for a sampling artefact.
      for (const r of rows.filter((x) => (x.facilityBreakdown ?? []).length > 0).slice(0, 20)) {
        expect(r.completedUnbilledOver30Count,
          'the Operativ column is a subset of the UNION, not of the Fertig-only count')
          .toBeLessThanOrEqual(r.completedUnbilledCount ?? 0);
      }
    },
  );

  test(
    'the sub-row numbers line up with the therapist row (the PR\'s own browser-only defect)',
    { tag: ['@SuperAdmin', '@WorkingHoursAbrechnung', '@ReadOnly'] },
    async () => {
      // PR #3780 records fixing this during verification: the sub-row numbers rendered
      // left-aligned against right-aligned therapist numbers, so a CORRECT breakdown read as a
      // broken one. Its own unit tests assert values, not geometry, and passed throughout — which
      // is exactly why this is checked on the rendered page.
      await board.toggleExpand(target.therapistId);
      const ids = await board.facilityTestIds(target.therapistId);
      const rowEdges = await board.therapistNumberEdges(target.therapistId);
      console.log(`  therapist number right edges: ${JSON.stringify(rowEdges)}`);
      let compared = 0;
      for (const tid of ids.slice(0, 3)) {
        const sub = await board.facilitySubRow(tid);
        if (sub.boxes.length !== rowEdges.length) {
          console.log(`    ${tid}: ${sub.boxes.length} numbers vs ${rowEdges.length} — skipped`);
          continue;
        }
        console.log(`    ${tid} right edges: ${JSON.stringify(sub.boxes)}`);
        for (let i = 0; i < rowEdges.length; i++) {
          expect(Math.abs(sub.boxes[i] - rowEdges[i]),
            `column ${W.COLUMN_KEYS[i]} of ${tid} shares the therapist row's right edge`)
            .toBeLessThanOrEqual(4);
        }
        compared++;
      }
      expect(compared, 'at least one sub-row was compared').toBeGreaterThan(0);
      await board.toggleExpand(target.therapistId);
    },
  );
});
