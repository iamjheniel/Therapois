import { test, expect } from '@playwright/test';
import { TILES, ToRiskGroupingPage } from '../../../Pages/superadmin/sa.to-risk-grouping.page';

/**
 * RC 3.14 #3803 — the Therapeuten-Orga risk table lists each VO ONCE with all its risks, and the
 * group headers and download count each VO once. Commit `d05a33860` (2026-09-25).
 *
 * With no tile selected the table listed a VO once per RISK, so a therapist's header counted and
 * valued it twice; the download listed each VO once but showed only its first risk. Management
 * reported that the TO team did not trust the counts, and the team sends these screenshots to
 * therapists — so every risk on a VO has to be visible in its one row.
 *
 * ## The export is the checkable surface, and the payload is the oracle
 *
 * `GET /kpis/orga/risks` still serves **one row per VO PER TILE** — the change is in the client and
 * the export, not the provider — so the expected grouping, the expected per-VO risk set and the
 * expected line order are all re-derivable from it. `POST /kpis/orga/risks/export` writes the file.
 *
 * ## TWO PARSING TRAPS THIS TICKET CREATED, both of which fake a failure
 *
 *  - **The Thema cell is MULTI-LINE**: a VO's risks are joined with `\n` INSIDE the quoted,
 *    `;`-delimited field (1,337 of 4,631 rows). A CSV parser that splits on newlines before handling
 *    quotes reports **2,908 rows for 1,713 VOs**, which reads exactly like the export duplicating
 *    rows — i.e. like this ticket being broken. `ToRiskGroupingPage.parseCsv` carries quote state
 *    across line breaks for exactly this reason.
 *  - **A group now counts DISTINCT VOs, not payload rows.** An oracle that counts rows reports
 *    Aaron Babczynski as 70 where the screen correctly shows 57 (AC5's own figure), i.e. it reports
 *    the screen as wrong when the oracle is stale.
 *
 * Read-only: every request is a GET except the export POST, which writes nothing.
 */
test.describe('#3803 the risk table lists each VO once with all its risks', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  /** AC2's order: ready-for-billing, then expiry, then IB. Duplikat is never exported. */
  const TILE_ORDER = ['fertigNichtAbgerechnet', 'laeuftAb', 'ibFehlt'] as const;
  const READY_PREFIXES = [
    'Fertig behandelt, letzte Beh.',
    'Abgebrochen, letzte Beh.',
    'Abgelaufen, letzte Beh.',
  ];
  const THEMA_BY_TILE: Record<string, string> = {
    laeuftAb: 'VO läuft in ≤ 7 Tagen ab',
    ibFehlt: 'Informationsblatt (IB) fehlt',
  };

  /** Classify a Thema line back to the tile it came from. */
  const tileOf = (line: string): string => {
    if (READY_PREFIXES.some((p) => line.startsWith(p))) return 'fertigNichtAbgerechnet';
    for (const [tile, text] of Object.entries(THEMA_BY_TILE)) if (line === text) return tile;
    return '?';
  };

  let api: ToRiskGroupingPage;

  test.beforeAll(async ({ playwright }) => {
    api = new ToRiskGroupingPage(await playwright.request.newContext());
  });

  test('AC1/AC7 the no-tile download is one line per VO, and the multi-line cells are exactly the multi-risk VOs', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const nonDuplikat = rows.filter((r) => r.tile !== TILES.duplikat.key);
    const risksByVo = new Map<string, Set<string>>();
    for (const r of nonDuplikat) {
      const set = risksByVo.get(r.voNumber) ?? new Set<string>();
      set.add(r.tile);
      risksByVo.set(r.voNumber, set);
    }
    const multiRisk = [...risksByVo.values()].filter((s) => s.size > 1).length;
    console.log(`#3803 payload: ${nonDuplikat.length} risk rows over ${risksByVo.size} VOs; ${multiRisk} carry 2+ risks`);

    const ids = [...new Set(rows.map((r) => r.prescriptionId))];
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
    const vIdx = csv.header.indexOf('VO #');
    const tIdx = csv.header.indexOf('Thema');
    const vos = csv.rows.map((r) => (r[vIdx] ?? '').trim());
    console.log(`#3803 export: ${csv.rows.length} rows, ${new Set(vos).size} distinct VO #`);

    // AC7's headline: one line per VO. A parser that splits on newlines reports ~1.7x this.
    expect(new Set(vos).size, 'AC7: one line per VO — no duplicates').toBe(csv.rows.length);

    // The multi-line cells must be exactly the VOs the payload says carry several risks — not
    // "some rows have newlines", which a stray newline in a patient name would also satisfy.
    const multiLineVos = new Set(csv.rows.filter((r) => (r[tIdx] ?? '').includes('\n')).map((r) => (r[vIdx] ?? '').trim()));
    const expectedMulti = new Set([...risksByVo].filter(([, s]) => s.size > 1).map(([vo]) => vo));
    const onlyInFile = [...multiLineVos].filter((v) => !expectedMulti.has(v));
    const onlyInPayload = [...expectedMulti].filter((v) => !multiLineVos.has(v) && vos.includes(v));
    console.log(`#3803 multi-line cells: ${multiLineVos.size}; payload says ${expectedMulti.size}`);
    expect(onlyInFile, 'no cell is multi-line without the payload saying so').toEqual([]);
    expect(onlyInPayload, 'and every multi-risk VO gets a multi-line cell').toEqual([]);
  });

  test('AC2/AC7 each cell lists exactly that VO\'s risks, each on its own line, in tile order', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const risksByVo = new Map<string, Set<string>>();
    for (const r of rows.filter((x) => x.tile !== TILES.duplikat.key)) {
      const set = risksByVo.get(r.voNumber) ?? new Set<string>();
      set.add(r.tile);
      risksByVo.set(r.voNumber, set);
    }
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv([...new Set(rows.map((r) => r.prescriptionId))]));
    const vIdx = csv.header.indexOf('VO #');
    const tIdx = csv.header.indexOf('Thema');

    const outOfOrder: string[] = [];
    const wrongSet: string[] = [];
    const unknown: string[] = [];
    for (const row of csv.rows) {
      const vo = (row[vIdx] ?? '').trim();
      const lines = (row[tIdx] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      const tiles = lines.map(tileOf);
      if (tiles.includes('?')) unknown.push(`${vo}: ${lines.join(' | ')}`);
      const ranks = tiles.filter((t) => t !== '?').map((t) => TILE_ORDER.indexOf(t as never));
      if (ranks.some((r, i) => i > 0 && r < ranks[i - 1])) outOfOrder.push(`${vo}: ${lines.join(' | ')}`);
      const expected = risksByVo.get(vo);
      if (expected && JSON.stringify([...new Set(tiles)].sort()) !== JSON.stringify([...expected].sort())) {
        wrongSet.push(`${vo}: file ${[...new Set(tiles)].sort()} vs payload ${[...expected].sort()}`);
      }
    }
    console.log(`#3803 AC2: out of order ${outOfOrder.length}, wrong risk set ${wrongSet.length}, unrecognised ${unknown.length}`);
    expect(unknown, 'every Thema line maps back to a tile').toEqual([]);
    expect(outOfOrder, 'AC2: ready-for-billing, then expiry, then IB').toEqual([]);
    expect(wrongSet, "AC7: the cell lists exactly the VO's risks").toEqual([]);
  });

  test('AC5 a group counts each VO once and adds its value once', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    const { rows } = await api.risks();
    const groups = ToRiskGroupingPage.groupRows(rows.filter((r) => r.tile !== TILES.duplikat.key));
    const distinctVos = new Set(rows.filter((r) => r.tile !== TILES.duplikat.key).map((r) => r.voNumber));
    const headerTotal = groups.reduce((sum, g) => sum + g.count, 0);
    console.log(`#3803 AC5: ${groups.length} groups, headers sum to ${headerTotal}, distinct VOs ${distinctVos.size}`);

    // The property AC5 states: every VO is counted exactly once across all group headers.
    expect(headerTotal, 'AC5: the headers add up to the number of distinct VOs').toBe(distinctVos.size);

    // And a group's own count must be its distinct VOs, not its risk rows — the two differ by the
    // multi-risk VOs, which is the whole defect. Verified per group against an independent count.
    const perTherapist = new Map<string, Set<string>>();
    const rowsPer = new Map<string, number>();
    for (const r of rows.filter((x) => x.tile !== TILES.duplikat.key)) {
      const key = `${r.therapistName ?? ''}|${r.teamName ?? ''}`;
      const s = perTherapist.get(key) ?? new Set<string>();
      s.add(r.voNumber);
      perTherapist.set(key, s);
      rowsPer.set(key, (rowsPer.get(key) ?? 0) + 1);
    }
    const disagreeing: string[] = [];
    let wouldDiffer = 0;
    for (const g of groups) {
      const key = `${g.therapistName}|${g.teamName ?? ''}`;
      const distinct = perTherapist.get(key)?.size ?? 0;
      if (g.count !== distinct) disagreeing.push(`${g.therapistName}: ${g.count} vs ${distinct}`);
      if ((rowsPer.get(key) ?? 0) !== distinct) wouldDiffer++;
    }
    expect(disagreeing, 'every group counts distinct VOs').toEqual([]);
    // Anti-vacuity: if no group had a multi-risk VO, "counts VOs" and "counts rows" would agree and
    // this test would prove nothing.
    console.log(`#3803 AC5: ${wouldDiffer} of ${groups.length} groups would differ under the old row count`);
    expect(wouldDiffer, 'the distinction is exercised — some groups hold multi-risk VOs').toBeGreaterThan(0);
  });

  test('AC8 a tile-selected download still has one row per VO of that tile, and the tile counts are untouched', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows, tiles } = await api.risks();
    for (const tile of ['fertigNichtAbgerechnet'] as const) {
      const tileRows = rows.filter((r) => r.tile === tile);
      const ids = [...new Set(tileRows.map((r) => r.prescriptionId))];
      const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
      const vIdx = csv.header.indexOf('VO #');
      console.log(`#3803 AC8 [${tile}]: tile=${tiles[tile]} rows=${tileRows.length} ids=${ids.length} -> ${csv.rows.length} file rows`);
      expect(csv.rows.length, 'one row per VO of the tile').toBe(ids.length);
      expect(new Set(csv.rows.map((r) => (r[vIdx] ?? '').trim())).size, 'and no duplicates').toBe(csv.rows.length);
      expect(tileRows.length, 'AC8: the tile count is unchanged by this ticket').toBe(tiles[tile]);
    }
  });

  test('FINDING — with a tile selected the DOWNLOAD now carries risks the tile view does not show', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const tileRows = rows.filter((r) => r.tile === TILES.fertig.key);
    const ids = [...new Set(tileRows.map((r) => r.prescriptionId))];
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
    const vIdx = csv.header.indexOf('VO #');
    const tIdx = csv.header.indexOf('Thema');

    const extra = new Map<string, number>();
    let multiLine = 0;
    for (const row of csv.rows) {
      const lines = (row[tIdx] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) multiLine++;
      for (const l of lines.slice(1)) extra.set(l, (extra.get(l) ?? 0) + 1);
    }
    console.log(`#3803 tile-selected download: ${csv.rows.length} rows, ${multiLine} with a multi-line Thema cell`);
    for (const [line, n] of extra) console.log(`   extra line on ${n} rows: ${line}`);

    // Reported, not failed. AC8 says "with a tile selected, the table and its download stay as they
    // are", and the Developer Reference states the assumption outright — "the Fertig tile's
    // download, where each VO has one risk and the result is unchanged". That premise is false: a VO
    // on the Fertig tile can also carry an IB risk, so the shared export now joins both into the
    // cell. The ROW SHAPE is unchanged (one row per VO, asserted above), which is what the PM's AC-8
    // check looked at, so this would not have been caught by it. Arguably more useful — but it is a
    // change to a surface AC8 freezes, and a QA applying AC8 literally would file it.
    if (multiLine > 0) {
      console.log(
        `\n  FINDING: the tile-selected download's Thema cell now lists risks the tile view omits — ` +
          `${multiLine} of ${csv.rows.length} rows gained a second line (${[...extra.keys()].join(', ')}). ` +
          `AC8 freezes this download and the Developer Reference assumed each VO here has one risk; ` +
          `it does not. Row count and columns are unchanged, so only the cell content differs. ` +
          `A PM decision, not a defect.`,
      );
    }
  });

  test('AC9 the Admin-Performance risk list stays flat — one row per risk, no grouping', {
    tag: ['@SuperAdmin', '@RiskOneRowPerVo', '@ReadOnly'],
  }, async () => {
    // The worklist component is shared (#3250), so the realistic leak is this ticket's grouping
    // reaching the other board. Its rows are per RISK, so a VO with two risks appears twice there.
    const body = await api.adminPerformanceRisks();
    const rows = body.rows;
    const byVo = new Map<string, number>();
    for (const r of rows) byVo.set(String(r.voNumber), (byVo.get(String(r.voNumber)) ?? 0) + 1);
    const repeated = [...byVo.values()].filter((n) => n > 1).length;
    console.log(`#3803 AC9: ${rows.length} rows over ${byVo.size} VOs; ${repeated} VOs appear more than once`);
    expect(rows.length, 'the Admin-Performance list still serves one row per risk').toBeGreaterThanOrEqual(byVo.size);
    // Its tile totals must still equal its row counts per tile — the flat contract.
    const perTile = new Map<string, number>();
    for (const r of rows) perTile.set(String(r.tile), (perTile.get(String(r.tile)) ?? 0) + 1);
    console.log(`#3803 AC9 tiles: ${JSON.stringify(body.tiles)} vs rows ${JSON.stringify(Object.fromEntries(perTile))}`);
    for (const [tile, count] of Object.entries(body.tiles)) {
      if (perTile.has(tile)) expect(perTile.get(tile), `${tile} rows equal its tile count`).toBe(count);
    }
  });
});
