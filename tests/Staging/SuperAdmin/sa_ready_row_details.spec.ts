import { test, expect } from '@playwright/test';
import {
  ReadyRowDetailsPage,
  GROUPED_VIEW_COLUMNS,
  DOWNLOAD_COLUMNS,
  ORGA_TOPIC_BY_STATUS,
  ORGA_TOPIC_BY_STATUS_BEFORE_3814,
  ADMIN_TOPIC_BY_STATUS,
  TOPIC_KEYS,
  OLD_COMBINED_TOPIC,
} from '../../../Pages/superadmin/sa.ready-row-details.page';
import { ToRiskGroupingPage, TILES } from '../../../Pages/superadmin/sa.to-risk-grouping.page';

/**
 * RC 3.14 (#3785) — ready-for-billing rows name the VO's real status, and the Therapeuten-Orga
 * grouped view and its download gain the issue date and sessions done.
 *
 * **Deployed; all six ACs verified. 8 passed, 0 `fixme`.**
 *
 * **It shipped inside #3775's PR #3788**, commit `0f909db2a`, which carries `Ref #3775` AND
 * `Ref #3785` — so the two tickets landed in the same merge and neither has a PR of its own. That
 * also sequences them the way #3785's own Testing Guidance requires ("Needs #3775 merged first:
 * before it, no cancelled or expired VO reaches these tiles").
 *
 * **The before/after on AC6 is on record rather than inferred.** This suite dumped the served
 * dictionary on 2026-09-23 and logged `flowBoards.riskThemaBereit` as the COMBINED label —
 * *"Fertig behandelt / abgebrochen — bereit für die Abrechnung"*. It now reads the finished-specific
 * *"Fertig behandelt, bereit für die Abrechnung"*, and the combined string is gone from the bundle
 * entirely. AC6 says the new Topic "replaces today's combined finished/cancelled label"; that
 * replacement is measured, not assumed.
 *
 * ## The Topic is chosen CLIENT-SIDE, so AC1/AC6 are two questions
 *
 * The API serves `voStatus` per row and the board picks an i18n key from it. So: does the dictionary
 * carry the six strings (asked against the served bundle), and does each row get the right one
 * (asked by joining the export back to the payload — **150 of 150** rows match their `voStatus`).
 *
 * ## Why the export carries most of the verification
 *
 * The grouped view paginates over ~1,600 rows, so the screen only shows the Topics on the current
 * page — the cancelled Admin-Performance variant was not on the first page although 165 such VOs
 * exist, which is why **absence on screen is not evidence here** and the dictionary plus the payload
 * are. The download takes the ids the board would send and returns one row per VO, so AC1's
 * mapping, AC3's figure, AC4's format and AC5's columns are all checkable in one request.
 *
 * ## Traps
 *
 *  - **`Beh. Status` is written as an Excel TEXT FORMULA** — `="4 / 6"`, not `4 / 6` — deliberately,
 *    because AC5 requires a spreadsheet not to read it as a date. A comparison against the plain
 *    form fails on a correct file.
 *  - **A Blanko VO reports `totalTreatments: 0`** and shows `n / BV`. Building the expectation from
 *    `totalTreatments` alone gives `14 / 0` and reports a mismatch on a correct row.
 *  - **#3774's `GROUP_COLUMNS` went from 8 to 10 here** (`Ausst. Datum` at 3, `Beh. Status` at 9),
 *    so that spec's exact-equality assertion failed the day this shipped. Fixed there: its own eight
 *    are now asserted as a subsequence, which is what its AC4 actually governs.
 *
 * **Read-only** — every request is a GET except the export POST, which writes nothing.
 */

test.describe('#3785 ready-for-billing rows show status, sessions and issue date', () => {
  test.describe.configure({ mode: 'serial' });

  /** The tile's VO ids in the order the board would send them, capped so one request answers. */
  const exportIds = (rows: { tile: string; prescriptionId: number }[], limit = 150) =>
    ToRiskGroupingPage.exportIdsFor(rows as never, TILES.fertig.key).slice(0, limit);

  test(
    'deployment: all six Topic strings ship, and the combined label AC6 replaces is gone',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new ReadyRowDetailsPage(request);
      const { de, bundle } = await api.dictionaries();

      for (const key of [...TOPIC_KEYS.orga, ...TOPIC_KEYS.admin, ...TOPIC_KEYS.columns])
        console.log(`  ${key.padEnd(40)} ${JSON.stringify(de[key])}`);

      // AC1's three, verbatim from the Localization Reference.
      for (const [status, topic] of Object.entries(ORGA_TOPIC_BY_STATUS))
        expect(Object.values(de), `AC1: the Topic for ${status}`).toContain(topic);
      // AC6's three.
      for (const [status, topic] of Object.entries(ADMIN_TOPIC_BY_STATUS))
        expect(Object.values(de), `AC6: the Topic for ${status}`).toContain(topic);
      // AC2/AC5's two new column headers.
      expect(de[TOPIC_KEYS.columns[0]], 'AC2/AC5: the issue-date header').toBe('Ausst. Datum');
      expect(de[TOPIC_KEYS.columns[1]], 'AC2/AC5: the sessions-done header').toBe('Beh. Status');

      // **The replacement, not merely the arrival.** This suite recorded the combined label from the
      // served dictionary the day before #3788 shipped; it is now absent from the whole bundle.
      // #3814 (2026-09-26) replaced all three of #3785's Topic texts so they name the LAST
      // TREATMENT. Asserted as a replacement, not just a presence: the superseded wording must be
      // gone, or the two tickets' texts would coexist and the board could render either.
      for (const [status, topic] of Object.entries(ORGA_TOPIC_BY_STATUS_BEFORE_3814)) {
        expect(bundle.includes(topic), `#3814 removed #3785's ${status} text`).toBe(false);
      }

      const stillCombined = bundle.includes(OLD_COMBINED_TOPIC) || Object.values(de).includes(OLD_COMBINED_TOPIC);
      console.log(`#3785 AC6: the pre-#3788 combined label "${OLD_COMBINED_TOPIC}" still present? ${stillCombined}`);
      expect(stillCombined, "AC6: today's combined finished/cancelled label is replaced, not merely joined").toBe(false);
    },
  );

  test(
    'AC1 every exported row\'s Topic matches its own VO status',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request);
      const { rows } = await api.orgaRisks();
      const byVo = new Map(
        rows.filter((r) => r.tile === TILES.fertig.key).map((r) => [r.voNumber, r as unknown as Record<string, unknown>]),
      );
      const csv = ReadyRowDetailsPage.parseCsv(await api.exportCsv(exportIds(rows as never)));
      const vos = ReadyRowDetailsPage.column(csv, 'VO #');
      const themas = ReadyRowDetailsPage.column(csv, 'Thema');

      const seen: Record<string, number> = {};
      let matched = 0;
      const wrong: string[] = [];
      for (let i = 0; i < vos.length; i++) {
        const src = byVo.get(vos[i]);
        expect(src, `${vos[i]} is joinable back to the payload`).toBeTruthy();
        const status = String(src!.voStatus);
        seen[status] = (seen[status] ?? 0) + 1;
        // #3803 (2026-09-25) made this ONE ROW PER VO, so the Thema cell now JOINS every risk the
        // VO carries, newline-separated ("Fertig behandelt, …\nInformationsblatt (IB) fehlt").
        // An equality check against the single ready-for-billing Topic therefore fails on any VO
        // with a second risk — 202 of them here — while the text is perfectly correct.
        if (themas[i].split('\n').map((l) => l.trim()).includes(ORGA_TOPIC_BY_STATUS[status])) matched++;
        else wrong.push(`${vos[i]}: ${status} -> ${themas[i].replace(/\n/g, ' | ')}`);
      }
      console.log(`#3785 AC1: ${vos.length} rows, statuses ${JSON.stringify(seen)}, mismatches ${wrong.length} ${JSON.stringify(wrong.slice(0, 3))}`);

      // All three statuses must actually occur, or "every row matched" is satisfied by a file that
      // is entirely one status — which is what the tile looked like before #3775.
      for (const status of Object.keys(ORGA_TOPIC_BY_STATUS))
        expect(seen[status], `AC1: the sample contains a ${status} VO`).toBeGreaterThan(0);
      expect(wrong, 'AC1: each row names its own status').toEqual([]);
      expect(matched, 'and every one of them').toBe(vos.length);
    },
  );

  test(
    'AC3/AC4/AC5 the download: eleven columns in order, the issue date, and sessions done as TEXT',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request);
      const { rows } = await api.orgaRisks();
      const byVo = new Map(
        rows.filter((r) => r.tile === TILES.fertig.key).map((r) => [r.voNumber, r as unknown as Record<string, unknown>]),
      );
      const csv = ReadyRowDetailsPage.parseCsv(await api.exportCsv(exportIds(rows as never)));
      const header = csv.header.map((h) => h.trim().replace(/^"|"$/g, ''));
      console.log(`#3785 AC5 columns (${header.length}): ${JSON.stringify(header)}`);
      expect(header, 'AC5: the eleven columns, in the ticket\'s order').toEqual([...DOWNLOAD_COLUMNS]);

      // AC4 — DD.MM.YYYY, every row.
      const dates = ReadyRowDetailsPage.column(csv, 'Ausst. Datum');
      const badDates = dates.filter((d) => !/^\d{2}\.\d{2}\.\d{4}$/.test(d));
      console.log(`#3785 AC4: ${dates.length} issue dates, ${badDates.length} not DD.MM.YYYY, e.g. ${JSON.stringify(dates.slice(0, 3))}`);
      expect(badDates, 'AC4: every issue date is DD.MM.YYYY').toEqual([]);

      // AC3/AC5 — the figure, and the form it is written in.
      const vos = ReadyRowDetailsPage.column(csv, 'VO #');
      const sessions = ReadyRowDetailsPage.column(csv, 'Beh. Status');
      const notFormula = sessions.filter((s) => !s.startsWith('="'));
      console.log(`#3785 AC5: sessions written as a text formula on ${sessions.length - notFormula.length}/${sessions.length}, e.g. ${JSON.stringify(sessions.slice(0, 3))}`);
      // The AC's own words: "opens in a spreadsheet as text such as '5 / 6', not as a date".
      expect(notFormula, 'AC5: every sessions value is an Excel text formula').toEqual([]);

      const wrong: string[] = [];
      for (let i = 0; i < vos.length; i++) {
        const src = byVo.get(vos[i])!;
        const want = ReadyRowDetailsPage.expectedSessions(src);
        const got = ReadyRowDetailsPage.unwrapFormula(sessions[i]);
        if (got !== want) wrong.push(`${vos[i]}: ${got} != ${want}`);
      }
      console.log(`#3785 AC3: ${vos.length} sessions figures, ${wrong.length} mismatched ${JSON.stringify(wrong.slice(0, 3))}`);
      expect(wrong, 'AC3: sessions done is the VO\'s documented/prescribed figure').toEqual([]);
    },
  );

  test(
    'AC3 a Blanko VO reports "n / BV", not "n / 0"',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request);
      const { rows } = await api.orgaRisks();
      const blanko = rows.filter(
        (r) => r.tile === TILES.fertig.key && (r as unknown as { blankoVO?: boolean }).blankoVO,
      );
      console.log(`#3785 AC3: ${blanko.length} Blanko VOs on the tile`);
      expect(blanko.length, 'the tile carries Blanko VOs, so AC3\'s third row is exercisable').toBeGreaterThan(0);

      const sample = blanko.slice(0, 40);
      const csv = ReadyRowDetailsPage.parseCsv(
        await api.exportCsv(sample.map((r) => r.prescriptionId)),
      );
      const vos = ReadyRowDetailsPage.column(csv, 'VO #');
      const sessions = ReadyRowDetailsPage.column(csv, 'Beh. Status').map(ReadyRowDetailsPage.unwrapFormula);
      const byVo = new Map(sample.map((r) => [r.voNumber, r as unknown as Record<string, unknown>]));
      console.log(`#3785 AC3 Blanko sample: ${JSON.stringify(sessions.slice(0, 6))}`);

      const wrong: string[] = [];
      for (let i = 0; i < vos.length; i++) {
        // **The trap**: `totalTreatments` is 0 on a Blanko VO, so an expectation built from it gives
        // "14 / 0" and reports a mismatch on a correct row. The prescribed side is "BV".
        const want = `${byVo.get(vos[i])!.activityCount} / BV`;
        if (sessions[i] !== want) wrong.push(`${vos[i]}: ${sessions[i]} != ${want}`);
      }
      expect(sessions.every((s) => s.endsWith('/ BV')), 'AC3: every Blanko row shows "/ BV"').toBe(true);
      expect(wrong, 'AC3: and the documented count beside it').toEqual([]);
    },
  );

  test(
    'AC5 "Fertig seit (Tage)" is filled for cancelled and expired VOs too — the AC\'s own worry',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request);
      const { rows } = await api.orgaRisks();
      const byVo = new Map(
        rows.filter((r) => r.tile === TILES.fertig.key).map((r) => [r.voNumber, r as unknown as Record<string, unknown>]),
      );
      const csv = ReadyRowDetailsPage.parseCsv(await api.exportCsv(exportIds(rows as never)));
      const vos = ReadyRowDetailsPage.column(csv, 'VO #');
      const since = ReadyRowDetailsPage.column(csv, 'Fertig seit (Tage)');

      const emptyByStatus: Record<string, number> = {};
      const totalByStatus: Record<string, number> = {};
      for (let i = 0; i < vos.length; i++) {
        const status = String(byVo.get(vos[i])!.voStatus);
        totalByStatus[status] = (totalByStatus[status] ?? 0) + 1;
        if (!since[i]) emptyByStatus[status] = (emptyByStatus[status] ?? 0) + 1;
      }
      console.log(`#3785 AC5 "Fertig seit": per status ${JSON.stringify(totalByStatus)}, empty ${JSON.stringify(emptyByStatus)}`);

      // The AC names this outright: "Today it is filled only for finished VOs and would stay empty
      // for the cancelled and expired VOs #3775 adds." So the two added statuses are the assertion,
      // and both must be present in the sample or it says nothing.
      for (const status of ['Abgebrochen', 'Abgelaufen'])
        expect(totalByStatus[status], `the sample contains a ${status} VO`).toBeGreaterThan(0);
      expect(since.filter((v) => !v).length, 'AC5: no row leaves it empty').toBe(0);
    },
  );

  test(
    'AC2 the grouped view paints the ten columns in order, with the two new ones in place',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request, page);
      await api.openBoard('Therapeuten-Orga');
      await api.waitForRiskSection();

      const columns = await api.groupedColumns();
      console.log(`#3785 AC2 grouped-view columns (${columns.length}): ${JSON.stringify(columns)}`);
      expect(columns, 'AC2: the ticket\'s ten columns, in its order').toEqual([...GROUPED_VIEW_COLUMNS]);
      // The two the ticket adds, at the positions it specifies (3rd and 9th).
      expect(columns.indexOf('Ausst. Datum'), 'AC2: issue date is the third column').toBe(2);
      expect(columns.indexOf('Beh. Status'), 'AC2: sessions done is the ninth').toBe(8);
    },
  );

  test(
    'AC1 the Therapeuten-Orga board paints a different Topic per status',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request, page);
      await api.openBoard('Therapeuten-Orga');
      await api.waitForRiskSection();

      const painted = await api.paintedTopics();
      console.log(`#3785 AC1 on screen: ${JSON.stringify(painted)}`);
      // All three happen to be on the first page here; each is asserted individually so a partial
      // render names which one is missing rather than failing on a set comparison.
      for (const [status, topic] of Object.entries(ORGA_TOPIC_BY_STATUS))
        expect(painted, `AC1: the ${status} Topic is painted`).toContain(topic);
    },
  );

  test(
    'AC6 the Admin-Performance tile names the status — verified from the payload, since the screen only shows a page',
    { tag: ['@SuperAdmin', '@ReadyRowDetails', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ReadyRowDetailsPage(request, page);
      const { rows, tiles } = await api.adminPerformanceRisks();
      const ready = rows.filter((r) => r.tile === 'bereitZurAbrechnung');
      const statuses = new Set(ready.map((r) => String(r.voStatus)));
      console.log(`#3785 AC6: ${ready.length} ready rows (tile ${tiles.bereitZurAbrechnung}), statuses ${JSON.stringify([...statuses])}`);

      // The population is what decides which Topics CAN render; all three statuses must be in it,
      // or AC6 is untestable on this data.
      for (const status of Object.keys(ADMIN_TOPIC_BY_STATUS))
        expect([...statuses], `AC6: the tile carries a ${status} VO`).toContain(status);

      await api.openBoard('Admin-Performance');
      await api.waitForRiskSection();
      const painted = await api.paintedTopics();
      console.log(`#3785 AC6 painted on the first page: ${JSON.stringify(painted)}`);

      // **Absence on screen is not evidence here** — the tile holds ~2,266 rows and paginates, and
      // the cancelled variant was not on the first page on a build where 165 such VOs exist. So the
      // screen is asserted only for what it DOES show, and every painted Topic must be one of the
      // three; the dictionary and the population carry the rest.
      expect(painted.length, 'the board paints ready-for-billing Topics').toBeGreaterThan(0);
      for (const topic of painted)
        expect(Object.values(ADMIN_TOPIC_BY_STATUS), `"${topic}" is one of AC6's three`).toContain(topic);
      const missing = Object.entries(ADMIN_TOPIC_BY_STATUS).filter(([, t]) => !painted.includes(t));
      if (missing.length)
        console.log(
          `#3785 AC6: not on the first page (paginated, not absent): ${JSON.stringify(missing.map(([s]) => s))} — ` +
            'their VOs exist in the payload above and the strings ship in the dictionary.',
        );
    },
  );
});
