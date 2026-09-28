import { test, expect } from '@playwright/test';
import {
  GRAU_TOOLTIPS,
  TO_BUCKET_LABELS,
  ToBoardActiveTilesPage,
} from '../../../Pages/superadmin/sa.to-board-active-tiles.page';

/**
 * RC 3.13 #3705 — the Therapeuten-Orga board's traffic-light tiles must count ACTIVE therapists
 * only, and the Grau pill/tooltip must be reworded for this board's rolling window.
 *
 * See `Pages/superadmin/sa.to-board-active-tiles.page.ts` for the mechanism, the numbers and the
 * traps. In short: `activeTileRows` gains a second call site on this board, feeding the tiles, while
 * `bucketByTherapistId` keeps every row so a deactivated therapist still has a colour and is still
 * reachable by the bucket filter.
 *
 * **Deployment note.** The fix (`74b35a757`) was merged to `release/3.13.0` days before it was
 * visible: the first check of this ticket found it absent from the served bundle
 * (`activeTileRows` at 2 occurrences, the new tooltip key at 0) although `GET /status` already
 * reported 3.13.0 on both halves. **The frontend bundle deploys independently of the API**, so
 * `/status` says nothing about whether a frontend change is live — the bundle is the only surface
 * that does. The first test here re-derives that verdict on every run.
 */
test.describe('#3705 Therapeuten-Orga tiles count active therapists only', () => {
  test.describe.configure({ mode: 'serial' });

  test('the fix is in the served bundle — activeTileRows has a second call site', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(240_000);
    const to = new ToBoardActiveTilesPage(page);
    const bundle = await to.entryBundle();

    const calls = ToBoardActiveTilesPage.occurrences(bundle, 'activeTileRows');
    console.log(`activeTileRows occurrences: ${calls} (1 definition + Management + Therepeuten-Orga)`);
    expect(calls, '#3579 shipped 2 (definition + Management); #3705 adds the TO board').toBeGreaterThanOrEqual(3);

    // The TO board's own tile config, which is what routes the reworded keys to this board only.
    expect(ToBoardActiveTilesPage.occurrences(bundle, 'flowBoards.bucketGrauWindowTooltip')).toBeGreaterThan(0);
    expect(ToBoardActiveTilesPage.occurrences(bundle, 'flowBoards.bucketGrauKeinePersonioStundenRange')).toBeGreaterThan(0);

    // Both German tooltips ship, as distinct strings — AC3's new one and AC4's untouched one.
    expect(ToBoardActiveTilesPage.escapedCount(bundle, GRAU_TOOLTIPS.to), 'AC3 wording').toBeGreaterThan(0);
    expect(ToBoardActiveTilesPage.escapedCount(bundle, GRAU_TOOLTIPS.management), 'AC4 wording, unchanged').toBeGreaterThan(0);

    // The Developer Reference's proposed name is NOT what shipped; a probe using it finds nothing.
    expect(
      ToBoardActiveTilesPage.occurrences(bundle, 'bucketGrauPersonioTooltipRollingWindow'),
      'the reference suggests this name; the commit uses bucketGrauWindowTooltip',
    ).toBe(0);
  });

  test('the payload discriminates — active-only and all-rows counts differ', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(180_000);
    const to = new ToBoardActiveTilesPage(page);
    await to.connect();

    const rows = await to.bucketRows();
    expect(rows.length, 'efficiency-buckets serves a BARE ARRAY — an empty result here means it was unwrapped as Hydra').toBeGreaterThan(0);

    const active = ToBoardActiveTilesPage.activeTileRows(rows);
    const all = ToBoardActiveTilesPage.tileCounts(rows);
    const act = ToBoardActiveTilesPage.tileCounts(active);
    console.log(`rows ${rows.length} | active ${active.length} | deactivated ${rows.length - active.length}`);
    console.log(`all rows   : ${JSON.stringify(all)}`);
    console.log(`active only: ${JSON.stringify(act)}`);

    expect(active.length, 'no deactivated therapists ⇒ every tile assertion below would pass vacuously')
      .toBeLessThan(rows.length);
    // The two columns must disagree somewhere, or the on-screen test cannot falsify anything.
    expect(JSON.stringify(act), 'active-only and all-rows tile counts are identical — no fixture')
      .not.toBe(JSON.stringify(all));
  });

  test('AC1 — the rendered tiles equal the ACTIVE-only counts, not the all-rows counts', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(600_000);
    const to = new ToBoardActiveTilesPage(page);
    await to.connect();
    const rows = await to.bucketRows();
    const expected = ToBoardActiveTilesPage.tileCounts(ToBoardActiveTilesPage.activeTileRows(rows));
    const preFix = ToBoardActiveTilesPage.tileCounts(rows);

    await to.openToBoard();
    const painted = await to.renderedTileCounts();
    console.log(`painted    : ${JSON.stringify(painted)}`);
    console.log(`active only: ${JSON.stringify(expected)}`);
    console.log(`all rows   : ${JSON.stringify(preFix)}`);

    for (const key of ['rot', 'gelb', 'gruen', 'grau', 'abwesend'] as const) {
      expect(painted[key], `${key} tile did not paint a number`).not.toBeNull();
      expect(painted[key], `${key}: expected the active-only count`).toBe(expected[key]);
    }

    const paintedTotal = Object.values(painted).reduce<number>((s, n) => s + (n ?? 0), 0);
    expect(paintedTotal, 'the five tiles must partition the ACTIVE therapists').toBe(
      ToBoardActiveTilesPage.activeTileRows(rows).length,
    );
    expect(paintedTotal, 'a build without the fix would total every row').toBeLessThan(rows.length);
  });

  test('AC2 — bucketByTherapistId keeps every row, deactivated included', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(240_000);
    const to = new ToBoardActiveTilesPage(page);
    await to.connect();
    const rows = await to.bucketRows();

    // The map the dots and the bucket filter read is built from the UNFILTERED rows.
    const map = ToBoardActiveTilesPage.bucketByTherapistId(rows);
    expect(Object.keys(map).length).toBe(new Set(rows.map((r) => r.therapistId)).size);
    const deactivated = rows.filter((r) => !r.active);
    expect(deactivated.length, 'no deactivated rows ⇒ nothing to prove').toBeGreaterThan(0);
    for (const row of deactivated) {
      expect(map[row.therapistId], `therapist ${row.therapistId} lost its bucket`).toBe(row.bucket);
    }

    // And in the bundle, the asymmetry itself: on the TO board the map reduces over `<src>.rows`
    // while the tiles read `activeTileRows(<src>.rows)`. The back-reference is the point — it proves
    // both derive from the SAME array, so the tiles were narrowed and the map deliberately was not.
    // Minified identifiers are renumbered every build, so the shape is anchored, never the names.
    const bundle = await to.entryBundle();
    const wiring = bundle.match(
      /(\w+)\.rows\.reduce\(\(\w+,\w+\)=>\(\w+\[\w+\.therapistId\]=\w+\.bucket,\w+\),\{\}\),\[\1\.rows\]\),\w+=\(0,\w+\.useMemo\)\(\(\)=>\(0,\w+\.activeTileRows\)\(\1\.rows\)/,
    );
    console.log(`TO board wiring: ${wiring?.[0] ?? '(not matched)'}`);
    expect(
      wiring,
      'the TO board must build bucketByTherapistId from the unfiltered rows and the tiles from activeTileRows of the same rows',
    ).not.toBeNull();
  });

  test('AC3 — the Grau pill and tooltip use this board\'s rolling-window wording', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(600_000);
    const to = new ToBoardActiveTilesPage(page);
    await to.openToBoard();

    const pill = await to.grauPillText();
    console.log(`Grau pill: ${pill}`);
    expect(pill, 'the pill must carry the reworded label').toContain(TO_BUCKET_LABELS.grau);
    expect(pill, 'and the reworded range line').toContain('keine Personio-Stunden');
    expect(pill, '#3705 replaces "keine Aktivität" on this board too').not.toContain('keine Aktivität');

    const tip = await to.grauTooltip();
    expect(tip.rollingWindow, 'AC3: the TO board must show the rolling-window tooltip').toBe(true);
    expect(tip.period, 'and NOT the Management board\'s period wording').toBe(false);
  });

  test('AC4 — the Management board\'s Grau tooltip is left unchanged', {
    tag: ['@SuperAdmin', '@ToBoardActiveTiles', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(600_000);
    const to = new ToBoardActiveTilesPage(page);
    const boards = await (async () => {
      const b = await to.openToBoard();
      return b;
    })();
    // Back to Management, which is where the untouched period wording lives.
    await page.getByText('Management', { exact: true }).first().click({ force: true, timeout: 30_000 });
    await to.waitForTiles();
    void boards;

    const tip = await to.grauTooltip();
    expect(tip.period, 'AC4: Management keeps the period wording').toBe(true);
    expect(tip.rollingWindow, 'and must not have taken the TO board\'s rolling-window wording').toBe(false);
  });
});
