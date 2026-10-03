import { test, expect } from '@playwright/test';
import {
  DotTooltipPage,
  COLOURED_BUCKETS,
  SILENT_BUCKETS,
  TOOLTIP_KEYS,
  BucketRow,
} from '../../../Pages/superadmin/sa.dot-tooltip.page';

/**
 * RC 3.15 #3729 — the Arbeitszeiten traffic-light dot explains its own calculation on
 * hover (commit `d1286327b`).
 *
 * The dot reflects a rolling 5-day window; the Effizienz column beside it reflects the
 * selected period. They legitimately disagree, and management read that as a defect
 * ("very confusing without the calculation"). The fix adds the info icon and tooltip the
 * TO Management dot already had.
 *
 * **Deployed; all four ACs verified as far as staging's data allows, 8 passed, 0
 * `fixme`. READ-ONLY** — every request a GET; the board is opened, a view toggled and
 * dots hovered.
 *
 * **WHAT MAKES THIS MORE THAN A SCREENSHOT TICKET:** the fix adds four pass-through
 * fields to `EfficiencyBucketRow`, so there is an API surface that both probes the
 * deployment and carries every number the tooltip prints — and **the ticket's own
 * developer check is a join**, done here on live data instead of as a snapshot.
 *
 * **AC1 AND AC3 ARE ONE CONDITION, READ FROM THE BUNDLE VERBATIM** rather than inferred
 * from the screen, so the rule is the deployed one.
 *
 * **COVERAGE STATED RATHER THAN IMPLIED:** staging carries only `rot`, `grau` and
 * `abwesend`, so AC1 is exercised on red alone and AC4's "two green percentages, two
 * different dot colours" pair cannot be built at all. Measured each run.
 */

test.describe('#3729 the Arbeitszeiten dot explains itself on hover', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600_000);

  let dt: DotTooltipPage;

  test.beforeEach(async ({ page }) => {
    dt = new DotTooltipPage(page);
    // the API reads mint their own token; the UI tests open the board themselves
  });

  test(
    'deployed — the four pass-through fields exist, and exactly on the rows that get a tooltip',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      const rows = (await dt.rawBuckets()) as BucketRow[];
      expect(rows.length, 'the buckets endpoint answers with the roster').toBeGreaterThan(50);

      const coloured = rows.filter((r) => (COLOURED_BUCKETS as readonly string[]).includes(r.bucket));
      const silent = rows.filter((r) => (SILENT_BUCKETS as readonly string[]).includes(r.bucket));
      expect(coloured.length, 'there are coloured dots to explain').toBeGreaterThan(0);
      expect(silent.length, 'and silent ones to leave alone').toBeGreaterThan(0);

      // The deployment probe: before the fix the DTO carried only therapistId, bucket,
      // active and absenceTypeName, so these three fields could not appear at all.
      for (const row of coloured) {
        expect(typeof row.efficiencyPercent, `t${row.therapistId} carries a percentage`).toBe('number');
        expect(typeof row.qualifyingDays, `t${row.therapistId} carries a day count`).toBe('number');
        expect(row.windowStart, `t${row.therapistId} carries a window start`).toBeTruthy();
        expect(row.windowEnd, `t${row.therapistId} carries a window end`).toBeTruthy();
      }

      // AC3 by construction: the icon's condition is `efficiencyPercent != null`, and
      // grau/abwesend never carry one — so no second branch is needed to suppress it.
      for (const row of silent) {
        expect(row.efficiencyPercent ?? null, `t${row.therapistId} (${row.bucket}) carries no percentage`).toBeNull();
      }

      console.log(
        `[#3729] ${rows.length} rows: ${coloured.length} coloured (all four fields present), ` +
          `${silent.length} grau/abwesend (no percentage). Buckets: ` +
          JSON.stringify(rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.bucket]: (a[r.bucket] ?? 0) + 1 }), {})),
      );
    },
  );

  test(
    "the ticket's own developer check — both screens receive the same four values",
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      // "verify that the Arbeitszeiten table's dot shows the tooltip using the same
      // underlying values the TO Management screen's dot already receives for the same
      // therapist". TO Management reads /therapist-performance (#3486).
      const buckets = (await dt.rawBuckets()) as BucketRow[];
      const perf = await dt.therapistPerformance();
      const byId = new Map(perf.map((p) => [p.id, p]));

      let bothPopulated = 0;
      const mismatches: string[] = [];
      for (const row of buckets) {
        const other = byId.get(row.therapistId);
        if (!other) continue;
        if (typeof row.efficiencyPercent === 'number' && typeof other.efficiencyPercent === 'number') {
          bothPopulated++;
        }
        for (const field of ['efficiencyPercent', 'qualifyingDays', 'windowStart', 'windowEnd'] as const) {
          const a = (row as Record<string, unknown>)[field] ?? null;
          const b = (other as Record<string, unknown>)[field] ?? null;
          if (String(a) !== String(b)) mismatches.push(`t${row.therapistId} ${field}: ${a} vs ${b}`);
        }
      }

      // ANTI-VACUITY, and it is essential here: both endpoints OMIT these fields when
      // null, so comparing two absent values passes while testing nothing. The run only
      // means something if a large number of rows carried a real percentage on BOTH.
      expect(bothPopulated, 'rows where both endpoints carry a real percentage').toBeGreaterThan(20);
      expect(mismatches, `the two screens disagree: ${mismatches.slice(0, 5).join(' | ')}`).toEqual([]);

      console.log(
        `[#3729] ${byId.size} therapists on /therapist-performance, ${bothPopulated} rows populated on both, ` +
          `0 mismatches across efficiencyPercent / qualifyingDays / windowStart / windowEnd`,
      );
    },
  );

  test(
    'AC2 — the limited-data case has live fixtures, found by the rule rather than by name',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      // The PM's named therapist (3 qualifying days) has since moved — staging data
      // drifts — so the fixture is derived from the condition the tooltip branches on.
      const rows = (await dt.rawBuckets()) as BucketRow[];
      const limited = rows.filter((r) => typeof r.efficiencyPercent === 'number' && (r.qualifyingDays ?? 0) < 5);
      const full = rows.filter((r) => typeof r.efficiencyPercent === 'number' && r.qualifyingDays === 5);

      expect(limited.length, 'at least one therapist is below five qualifying days').toBeGreaterThan(0);
      expect(full.length, 'and others are at five, so the note is not shown to everyone').toBeGreaterThan(0);

      // Every limited row still carries a window, so the tooltip has all three parts
      // plus the note rather than the note alone.
      for (const row of limited) {
        expect(row.windowStart, `t${row.therapistId} limited row still has a window`).toBeTruthy();
        expect(row.qualifyingDays!).toBeGreaterThan(0);
      }

      console.log(
        `[#3729] AC2: ${limited.length} rows under 5 days — ` +
          limited.map((r) => `t${r.therapistId} ${r.efficiencyPercent}% over ${r.qualifyingDays}d (${r.windowStart}..${r.windowEnd})`).join(', ') +
          `; ${full.length} rows at exactly 5`,
      );
    },
  );

  test(
    'AC4 — the window is per-therapist and rolling, which is what the tooltip exists to explain',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      // The endpoint strips from/to (#3242 AC2), so the dot cannot follow the selected
      // period — that is the mismatch management reported, and the reason a tooltip is
      // the fix rather than a recalculation.
      const plain = (await dt.rawBuckets()) as BucketRow[];
      const scoped = (await dt.rawBuckets({ from: '2026-07-13', to: '2026-07-17' })) as BucketRow[];
      const signature = (rows: BucketRow[]) =>
        JSON.stringify(rows.map((r) => [r.therapistId, r.bucket, r.windowStart, r.windowEnd]).sort());
      expect(signature(scoped), 'a period narrows nothing — the window is rolling').toBe(signature(plain));

      // ...and it is per THERAPIST, not one window for everyone, which is why the
      // tooltip has to print the range rather than the board showing it once.
      const windows = new Set(
        plain.filter((r) => r.windowStart).map((r) => `${r.windowStart}..${r.windowEnd}`),
      );
      expect(windows.size, 'therapists have different windows').toBeGreaterThan(1);

      console.log(`[#3729] AC4: identical with and without from/to; ${windows.size} distinct per-therapist windows`);
    },
  );

  test(
    'AC1 + AC3 — the shipped render condition gates the icon AND the tooltip together',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      // Read from the bundle rather than inferred from the screen, so this is the
      // deployed rule: one flag decides the icon and the tooltip, and it keys off
      // `efficiencyPercent != null` — which grau and abwesend never have.
      const js = await dt.bundle();
      const anchor = js.indexOf('bucket-marker-');
      expect(anchor, 'the marker testid is in the bundle').toBeGreaterThan(-1);
      const source = js.slice(Math.max(0, anchor - 400), anchor + 500);

      expect(source, 'the icon is conditional on a percentage existing').toContain('efficiencyPercent');
      expect(source, 'the info icon is the TO Management one').toContain('information-circle-outline');
      expect(source, 'the tooltip body comes from the shared wording module').toContain('efficiencyTooltipBody');
      expect(source, 'and the dot keeps its own testid').toContain('bucket-dot-');

      // The wording has ONE source, which is the drift-prevention the ticket asks for:
      // each key is referenced exactly once, by that shared module.
      for (const key of TOOLTIP_KEYS) {
        expect(DotTooltipPage.occurrences(js, key), `${key} is referenced once`).toBe(1);
      }
      expect(DotTooltipPage.occurrences(js, 'efficiencyTooltipBody'), 'defined once and used once').toBeGreaterThan(1);

      console.log(`[#3729] shipped render condition: ${source.replace(/\s+/g, ' ').slice(source.indexOf('de.includes') > -1 ? source.indexOf('de.includes') : 0, 320)}`);
    },
  );

  test(
    'AC1 on screen — a coloured dot carries the info icon and a tooltip with all three parts',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      await dt.openForDots();

      const rows = (await dt.rawBuckets()) as BucketRow[];
      const byId = new Map(rows.map((r) => [r.therapistId, r]));
      const markers = await dt.markers();
      expect(markers.length, 'markers are painted').toBeGreaterThan(10);

      const coloured = markers.filter((m) => {
        const row = byId.get(m.therapistId);
        return row && typeof row.efficiencyPercent === 'number';
      });
      expect(coloured.length, 'the board shows coloured dots').toBeGreaterThan(0);

      // Every coloured marker carries the icon — the PM observed it is always visible,
      // not only on hover, matching TO Management.
      const withoutIcon = coloured.filter((m) => !m.hasIcon);
      expect(withoutIcon, `coloured dots missing the info icon: ${withoutIcon.map((m) => m.therapistId).join(', ')}`).toEqual([]);

      // And the tooltip prints the percentage, the day count and the range.
      const target = coloured[0];
      const row = byId.get(target.therapistId)!;
      const tooltip = await dt.hoverTooltip(target.therapistId);
      expect(tooltip, `hovering t${target.therapistId} shows a tooltip`).toBeTruthy();
      expect(tooltip!, 'the percentage').toContain(`${Math.round(row.efficiencyPercent as number)}`);
      expect(tooltip!, 'the day count').toContain(String(row.qualifyingDays));
      // The range is printed DD.MM.YYYY, so compare on the day and year of each end.
      for (const iso of [row.windowStart!, row.windowEnd!]) {
        const [y, m, d] = iso.split('-');
        expect(tooltip!, `the window end ${d}.${m}.${y}`).toContain(`${d}.${m}.${y}`);
      }

      console.log(
        `[#3729] AC1: ${coloured.length} coloured markers, all with the icon. ` +
          `t${target.therapistId} tooltip = ${JSON.stringify(tooltip)}`,
      );
    },
  );

  test(
    'AC3 on screen — a grau or Abwesend dot gets no icon and no tooltip',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      await dt.openForDots();

      const rows = (await dt.rawBuckets()) as BucketRow[];
      const byId = new Map(rows.map((r) => [r.therapistId, r]));
      const markers = await dt.markers();

      const silent = markers.filter((m) => {
        const row = byId.get(m.therapistId);
        return row && (SILENT_BUCKETS as readonly string[]).includes(row.bucket);
      });
      expect(silent.length, 'the board shows grau or Abwesend dots').toBeGreaterThan(0);

      const wronglyIconed = silent.filter((m) => m.hasIcon);
      expect(wronglyIconed, `silent dots that gained an icon: ${wronglyIconed.map((m) => m.therapistId).join(', ')}`).toEqual([]);

      // ...and hovering one produces nothing, which is the half an icon check alone
      // would miss if the tooltip were wired separately.
      const tooltip = await dt.hoverTooltip(silent[0].therapistId);
      expect(tooltip, `hovering t${silent[0].therapistId} (${byId.get(silent[0].therapistId)!.bucket}) shows no tooltip`).toBeNull();

      console.log(
        `[#3729] AC3: ${silent.length} silent markers, 0 with an icon; hovering t${silent[0].therapistId} ` +
          `(${byId.get(silent[0].therapistId)!.bucket}) produced no tooltip`,
      );
    },
  );

  test(
    'coverage — which dot colours staging can actually exercise',
    { tag: ['@SuperAdmin', '@DotTooltip', '@ReadOnly'] },
    async () => {
      // Reported rather than asserted, because it is a property of the data and not of
      // the fix: AC1 names rot, gelb and gruen, and AC4 wants two therapists with green
      // percentages whose dots differ. Measured each run so the gap cannot go stale.
      const rows = (await dt.rawBuckets()) as BucketRow[];
      const split = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.bucket]: (a[r.bucket] ?? 0) + 1 }), {});
      const missing = COLOURED_BUCKETS.filter((b) => !(split[b] > 0));

      expect(split['rot'] ?? 0, 'at least one coloured bucket exists, or AC1 is untestable here').toBeGreaterThan(0);

      console.log(
        `[#3729] bucket coverage on staging: ${JSON.stringify(split)}. ` +
          (missing.length
            ? `NOT exercised: ${missing.join(', ')} — AC1 is verified on ${COLOURED_BUCKETS.filter((b) => split[b] > 0).join(', ')} only, ` +
              `and AC4's "two green percentages, two dot colours" pair cannot be built with one colour available.`
            : 'every coloured bucket is present.'),
      );
    },
  );
});
