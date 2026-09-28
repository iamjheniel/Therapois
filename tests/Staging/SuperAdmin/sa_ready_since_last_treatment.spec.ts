import { test, expect } from '@playwright/test';
import { TILES, ToRiskGroupingPage } from '../../../Pages/superadmin/sa.to-risk-grouping.page';

/**
 * RC 3.14 #3814 — "Fertig seit (Tage)" and the ready-for-billing Thema count from the LAST SIGNED
 * TREATMENT, not from the day the VO reached its end status. Commit `6b72bcb7e` (PR #3825).
 *
 * The tile "Fertig > 30 T, nicht abger." and the Status/Frist column already counted from the last
 * treatment; the download's day column and the Issue text did not, so **73 of the 486 VOs on the
 * tile showed 30 days or fewer** — the reason the TO team stopped trusting the board.
 *
 * ## The export is the surface, and it is exactly checkable
 *
 * `POST /kpis/orga/risks/export` writes one row per VO with both numbers on it, and
 * `GET /kpis/orga/risks` serves `daysSince` — which IS the Status/Frist entry ("Letzte Beh. vor N
 * T"). So AC1's "the file shows the same number as the screen" is a join, not a sample: every row
 * is compared, not three.
 *
 * ## TWO TRAPS FROM SIBLING TICKETS, both of which fake a failure
 *
 *  - **#3803 made the Thema cell MULTI-LINE.** A VO's risks are joined with `\n` inside the quoted
 *    field (1,195 of 1,713 rows here), so a CSV parser that splits on newlines before handling
 *    quotes reports **2,908 rows for 1,713 VOs** — which reads exactly like the export duplicating
 *    rows. `ToRiskGroupingPage.parseCsv` carries quote state across line breaks for this reason.
 *  - **The Thema cell is therefore a LIST.** Matching a VO's expected text with `===` fails on every
 *    VO that carries a second risk, while the text is correct; match against the cell's lines.
 *
 * Read-only: every request is a GET except the export POST, which writes nothing.
 */
test.describe('#3814 "Fertig seit" and the Thema count from the last treatment', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  /** AC4's three new Issue texts, per VO status (the Localization Reference, verbatim). */
  const NEW_THEMA: Record<string, string> = {
    'Fertig Behandelt': 'Fertig behandelt, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
    Abgebrochen: 'Abgebrochen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
    Abgelaufen: 'Abgelaufen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
  };
  /** What #3785 shipped and this ticket replaces — must be gone everywhere. */
  const OLD_THEMA = [
    'Fertig behandelt vor > 30 Tagen, nicht in Abrechnung',
    'Abgebrochen vor > 30 Tagen, nicht in Abrechnung',
    'Abgelaufen vor > 30 Tagen, nicht in Abrechnung',
  ];
  const NEW_THEMA_EN = [
    'Fully treated, last treatment > 30 days ago, not in billing',
    'Cancelled, last treatment > 30 days ago, not in billing',
    'Expired, last treatment > 30 days ago, not in billing',
  ];
  /** AC5 — the Admin-Performance board keeps its own texts. */
  const ADMIN_KEEPS = ['Fertig behandelt, bereit für die Abrechnung', 'Abgelaufen, bereit für die Abrechnung'];
  const READY_STATUSES = ['Fertig Behandelt', 'Abgebrochen', 'Abgelaufen'];

  let api: ToRiskGroupingPage;

  test.beforeAll(async ({ playwright }) => {
    api = new ToRiskGroupingPage(await playwright.request.newContext());
  });

  test('AC4/AC5 deployment: the three new texts ship, the three old ones are gone, and Admin-Performance keeps its own', {
    tag: ['@SuperAdmin', '@ReadySinceLastTreatment', '@ReadOnly'],
  }, async () => {
    const { de, bundle } = await api.dictionaries();
    const esc = (s: string) => [...s].map((c) => (c.charCodeAt(0) < 128 ? c : `\\x${c.charCodeAt(0).toString(16)}`)).join('');

    for (const [status, text] of Object.entries(NEW_THEMA)) {
      const inDict = Object.values(de).includes(text);
      console.log(`  NEW ${status.padEnd(17)} in dictionary=${inDict}`);
      expect(inDict, `${status}'s new Thema ships`).toBe(true);
    }
    // The replacement half. Without it the two tickets' texts could coexist and the board render
    // either — the bundle escapes non-ASCII, so both forms are checked (#3611).
    for (const text of OLD_THEMA) {
      expect(bundle.includes(text) || bundle.includes(esc(text)), `superseded text gone: ${text}`).toBe(false);
    }
    for (const text of NEW_THEMA_EN) {
      expect(bundle.includes(text), `English UI text ships: ${text}`).toBe(true);
    }
    // AC5: the Admin-Performance list has its own texts and this ticket must not touch them.
    for (const text of ADMIN_KEEPS) {
      expect(bundle.includes(text) || bundle.includes(esc(text)), `Admin-Performance keeps: ${text}`).toBe(true);
    }
  });

  test('AC1 the download equals the screen, for every VO on the tile — and nothing is ≤ 30', {
    tag: ['@SuperAdmin', '@ReadySinceLastTreatment', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const fertig = rows.filter((r) => r.tile === TILES.fertig.key);
    const ids = [...new Set(fertig.map((r) => r.prescriptionId))];
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
    const col = (name: string) => {
      const i = csv.header.indexOf(name);
      expect(i, `the export has a "${name}" column`).toBeGreaterThanOrEqual(0);
      return csv.rows.map((r) => (r[i] ?? '').trim());
    };
    const vos = col('VO #');
    const fertigSeit = col('Fertig seit (Tage)');
    console.log(`#3814 AC1: ${ids.length} tile VOs -> ${csv.rows.length} rows`);
    expect(csv.rows.length, '#3803: one row per VO').toBe(ids.length);

    // `daysSince` IS the Status/Frist entry ("Letzte Beh. vor N T"), so this is AC1's own comparison.
    const byVo = new Map(fertig.map((r) => [r.voNumber, r as unknown as Record<string, unknown>]));
    const mismatches: string[] = [];
    const notAbove30: string[] = [];
    for (let i = 0; i < vos.length; i++) {
      const src = byVo.get(vos[i]);
      expect(src, `${vos[i]} joins back to the payload`).toBeTruthy();
      const onScreen = Number(src!.daysSince);
      expect(fertigSeit[i], `${vos[i]}: the column is filled on a tile row`).not.toBe('');
      if (Number(fertigSeit[i]) !== onScreen) mismatches.push(`${vos[i]}: file ${fertigSeit[i]} vs screen ${onScreen}`);
      if (Number(fertigSeit[i]) <= 30) notAbove30.push(`${vos[i]}=${fertigSeit[i]}`);
    }
    console.log(`#3814 AC1 mismatches: ${mismatches.length} ${JSON.stringify(mismatches.slice(0, 3))}`);
    console.log(`#3814 AC1 values <= 30 on the tile: ${notAbove30.length} ${JSON.stringify(notAbove30.slice(0, 5))}`);
    expect(mismatches, 'AC1: the file shows the same number as the screen, for every VO').toEqual([]);
    // The ticket's headline complaint: 73 of 486 used to be ≤ 30.
    expect(notAbove30, 'AC1: every VO on the tile shows more than 30 days').toEqual([]);
  });

  test('AC2 the column is filled for exactly the three end statuses with a signed treatment', {
    tag: ['@SuperAdmin', '@ReadySinceLastTreatment', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const ids = [...new Set(rows.map((r) => r.prescriptionId))];
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
    const idx = (n: string) => csv.header.indexOf(n);
    const vIdx = idx('VO #');
    const fIdx = idx('Fertig seit (Tage)');

    // One payload row per VO carries the status; a VO under several tiles repeats it.
    const status = new Map<string, { voStatus: string; activityCount: number }>();
    for (const r of rows) {
      const rec = r as unknown as Record<string, unknown>;
      if (!status.has(r.voNumber)) {
        status.set(r.voNumber, {
          voStatus: String(rec.voStatus),
          activityCount: Number(rec.activityCount ?? 0),
        });
      }
    }

    const wronglyFilled: string[] = [];
    const wronglyEmpty: string[] = [];
    let filled = 0;
    for (const row of csv.rows) {
      const vo = (row[vIdx] ?? '').trim();
      const val = (row[fIdx] ?? '').trim();
      const s = status.get(vo);
      if (!s) continue;
      const qualifies = READY_STATUSES.includes(s.voStatus) && s.activityCount > 0;
      if (val !== '') {
        filled++;
        if (!qualifies) wronglyFilled.push(`${vo} (${s.voStatus}, ${s.activityCount} treatments) = ${val}`);
      } else if (qualifies) wronglyEmpty.push(`${vo} (${s.voStatus}, ${s.activityCount} treatments)`);
    }
    console.log(`#3814 AC2: ${csv.rows.length} rows, ${filled} filled, ${csv.rows.length - filled} empty`);
    console.log(`  wrongly filled: ${wronglyFilled.length} ${JSON.stringify(wronglyFilled.slice(0, 3))}`);
    console.log(`  wrongly empty : ${wronglyEmpty.length} ${JSON.stringify(wronglyEmpty.slice(0, 3))}`);
    expect(wronglyFilled, 'AC2: filled only for the three end statuses with a signed treatment').toEqual([]);
    expect(wronglyEmpty, 'AC2: and filled for every one of them').toEqual([]);

    // AC2's own wording is "as today — only the date it counts from changes", so the column must be
    // filled on MORE rows than the tile holds: a VO in one of the three statuses whose last
    // treatment is under 31 days old is off the tile but still gets a number.
    const tileCount = rows.filter((r) => r.tile === TILES.fertig.key).length;
    console.log(`#3814 AC2: ${filled} filled vs ${tileCount} on the tile (the difference is the <31-day VOs)`);
    expect(filled, 'the column is not merely the tile').toBeGreaterThanOrEqual(tileCount);
  });

  test('AC4 the new Thema reaches the export, with the tile and without it', {
    tag: ['@SuperAdmin', '@ReadySinceLastTreatment', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows } = await api.risks();
    const fertig = rows.filter((r) => r.tile === TILES.fertig.key);
    const byVo = new Map(fertig.map((r) => [r.voNumber, String((r as unknown as Record<string, unknown>).voStatus)]));

    for (const [label, ids] of [
      ['tile selected', [...new Set(fertig.map((r) => r.prescriptionId))]],
      ['no tile', [...new Set(rows.map((r) => r.prescriptionId))]],
    ] as [string, number[]][]) {
      const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
      const vIdx = csv.header.indexOf('VO #');
      const tIdx = csv.header.indexOf('Thema');
      let checked = 0;
      const missing: string[] = [];
      const stale: string[] = [];
      for (const row of csv.rows) {
        const vo = (row[vIdx] ?? '').trim();
        const cell = row[tIdx] ?? '';
        // #3803 joins a VO's risks with newlines — the cell is a LIST, so match its lines.
        const lines = cell.split('\n').map((l) => l.trim());
        const status = byVo.get(vo);
        if (status && NEW_THEMA[status]) {
          checked++;
          if (!lines.includes(NEW_THEMA[status])) missing.push(`${vo} (${status}) -> ${cell.replace(/\n/g, ' | ')}`);
        }
        if (OLD_THEMA.some((o) => cell.includes(o))) stale.push(vo);
      }
      console.log(`#3814 AC4 [${label}]: ${csv.rows.length} rows, ${checked} ready-for-billing, missing ${missing.length}, stale ${stale.length}`);
      expect(missing, `AC4 [${label}]: every ready-for-billing row carries its new text`).toEqual([]);
      expect(stale, `AC4 [${label}]: no superseded text survives`).toEqual([]);
      expect(checked, `AC4 [${label}]: the file actually contains ready-for-billing rows`).toBeGreaterThan(0);
    }
  });

  test('AC5 what must NOT change: the weeks column, the tile rule and its count', {
    tag: ['@SuperAdmin', '@ReadySinceLastTreatment', '@ReadOnly'],
  }, async () => {
    test.setTimeout(900_000);
    const { rows, tiles } = await api.risks();
    const fertig = rows.filter((r) => r.tile === TILES.fertig.key);
    const ids = [...new Set(fertig.map((r) => r.prescriptionId))];
    const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));

    // "Letzte Beh. (Wochen)": same values, same place — position 8 of the eleven.
    expect(csv.header.indexOf('Letzte Beh. (Wochen)'), 'the weeks column is where it was').toBe(7);
    const wIdx = csv.header.indexOf('Letzte Beh. (Wochen)');
    const fIdx = csv.header.indexOf('Fertig seit (Tage)');
    const emptyWeeks = csv.rows.filter((r) => (r[wIdx] ?? '').trim() === '');
    console.log(`#3814 AC5: weeks filled on ${csv.rows.length - emptyWeeks.length} of ${csv.rows.length}`);
    expect(emptyWeeks, 'the weeks column is still filled on every tile row').toEqual([]);

    // The two columns are different measures and must not have been collapsed into one: weeks is a
    // week count, days a day count, so days ≈ 7 × weeks rather than equal to it.
    const sample = csv.rows.slice(0, 200).map((r) => [Number(r[wIdx]), Number(r[fIdx])] as const);
    const identical = sample.filter(([w, d]) => w === d).length;
    console.log(`#3814 AC5: of 200 rows, ${identical} have weeks == days (they measure different things)`);
    expect(identical, 'the weeks column was not silently replaced by the day count').toBeLessThan(sample.length / 2);

    // The tile's own rule is untouched: every VO on it has a last treatment more than 30 days ago.
    const under = fertig.filter((r) => Number((r as unknown as Record<string, unknown>).daysSince) <= 30);
    console.log(`#3814 AC5: tile count ${tiles.fertigNichtAbgerechnet}, rows ${fertig.length}, any ≤30 days: ${under.length}`);
    expect(under, 'the tile still holds only VOs whose last treatment is over 30 days ago').toEqual([]);
    expect(fertig.length, 'and the tile count matches its rows').toBe(tiles.fertigNichtAbgerechnet);
  });
});
