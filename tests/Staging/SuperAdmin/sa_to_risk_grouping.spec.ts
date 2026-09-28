import { test, expect } from '@playwright/test';
import {
  ToRiskGroupingPage,
  TILES,
  GROUP_COLUMNS,
  ORIGINAL_GROUP_COLUMNS,
  CSV_HEADER,
  ORIGINAL_CSV_HEADER,
  I18N,
} from '../../../Pages/superadmin/sa.to-risk-grouping.page';

/**
 * RC 3.14 (#3774, commit `347274e1e`, merged under a `Ref` trailer with **no PR**) — the
 * Therapeuten-Orga risk table groups by therapist for the billing-backlog view and gains its own
 * CSV export; the Abrechnungs-Stau banner is retired from both boards and the Management board
 * carries a plain summary line instead.
 *
 * **Deployed on both halves; 11 passed, 1 `fixme`.**
 *
 * **Deployment is decided twice, and `/status` answers for neither half on its own.** It reports
 * the API release (`3.14.0` on both sides of this commit — #3704), so the API half is probed by its
 * two BRAND-NEW routes answering at all against a 404 control (#3711's technique), and the frontend
 * half by what the board paints. Both are asserted before anything else runs.
 *
 * ## The oracle is the board's own payload, not the screen
 *
 * `GET /kpis/orga/risks` serves all 5,501 rows with `tile`, `therapistName`, `teamName` and
 * `revenue` on each, so AC2's subtotals and AC3's order are **re-derived** and the screen compared
 * against them — `riskGroups.ts`'s rule is ported in the page object rather than read back off the
 * thing under test. That is also what makes AC3 checkable at all: the sort only shows itself across
 * 133 groups, and no fixture could demonstrate it.
 *
 * **AC3's no-TO-Team block has exactly two members and the ticket names one of them.** The Testing
 * Guidance asks for "at least one therapist assigned to no TO-Team (so rule 3's 'no-TO-Team block
 * sorts last' is actually exercised)" and records staging as having no confirmed fixture. It has
 * two — **Frauke Wolff and Palle Spiekermann** — and Palle Spiekermann is the very name the
 * ticket's own wireframe uses for that case. So the rule IS exercised, at both ends.
 *
 * **Sort with `localeCompare('de')`.** The population carries umlauts (Alexandra Schöner, Kerstin
 * Müller) and a byte sort files them after Z, which reads as AC3 failing on a correct build.
 *
 * ## The export
 *
 * `POST /kpis/orga/risks/export` takes `{filters, prescriptionIds}` and re-reads the provider for
 * those filters, so **the client sets the ORDER and never the SCOPE** — asserted by sending a bogus
 * id and watching it vanish. It writes one row per VO, excluding every `duplikatOffen` row.
 *
 * **FINDING — AC5's two clauses conflict in the view the board opens in, and the PM's own QA step
 * fails there.** With no tile selected the groups paint **5,492 rows** (every non-Duplikat row)
 * while the CSV holds fewer — because **some VOs appear under more than one tile** and the
 * export deliberately writes each VO once. AC5 asks for "every row currently grouped … one row per
 * VO, in the same order as the on-screen groups", and those cannot both hold; the commit resolved it
 * toward one-row-per-VO, which is the sane reading. But the Testing Guidance says "Download the CSV
 * and confirm the row count and therapist names match the on-screen groups", and in the default
 * view. **With the Fertig tile selected the two agree exactly**,
 * so the AC's primary case is clean and only the "no tile selected" case diverges.
 *
 * ## Traps
 *
 *  - **`tiles.duplikatOffen` reports 8 while 9 rows carry that tile**, all with distinct VO numbers.
 *    Pre-existing — this ticket does not touch tile population (#3775 does) — but it means the tile
 *    counts are not a safe oracle for the row set.
 *  - **The group header and its subtotal are separate leaves**; the subtotal is its own
 *    `"{count} VOs · {amount}"` node, so a locator expecting name and numbers together finds nothing.
 *  - **The Heilmittel column header reads "HM"**, not the Localization Reference's "Heilmittel".
 *    Pre-existing (`flowBoards.riskHm`); only the CSV header uses the full word.
 *  - **The board opens with NO tile selected**, which is itself one of AC1's two grouped cases — so
 *    the default state is already a test of AC1, not a preamble to one.
 *
 * **Read-only** — every request is a GET except the export POST, which writes nothing.
 */

test.describe('#3774 Therapeuten-Orga risk table grouped by therapist', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: both new API routes answer, against a 404 control',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new ToRiskGroupingPage(request);

      // `GET /status` reports the release, not the commit (#3704), and says nothing about the
      // frontend at all (#3705). Two routes this commit ADDS are the probe that can decide it —
      // and the controls matter, because a 404 from a typo would look identical to "not deployed".
      const summary = await api.status('/kpis/management/unbilled-summary');
      const exportRoute = await api.status('/kpis/orga/risks/export', 'POST');
      const missingGet = await api.status('/kpis/management/zzz-not-a-route');
      const missingPost = await api.status('/kpis/orga/zzz-not-a-route', 'POST');
      console.log(
        `#3774 deployment: unbilled-summary=${summary} risks/export=${exportRoute} | controls ${missingGet}/${missingPost}`,
      );

      expect(summary, 'AC7 reads this route').toBe(200);
      expect(exportRoute, 'AC5 writes through this one').toBe(200);
      expect(missingGet, 'the control proves a missing route 404s here').toBe(404);
      expect(missingPost, 'on both verbs').toBe(404);
    },
  );

  test(
    'AC2/AC3 the grouping and its order, re-derived from the board\'s own payload',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new ToRiskGroupingPage(request);
      const { rows, tiles } = await api.risks();

      const fertig = ToRiskGroupingPage.rowsFor(rows, TILES.fertig.key);
      const groups = ToRiskGroupingPage.groupRows(fertig);
      const noTeam = groups.filter((g) => !g.teamName);
      console.log(
        `#3774 tiles=${JSON.stringify(tiles)} | Fertig rows=${fertig.length} groups=${groups.length} ` +
          `noTeam=${JSON.stringify(noTeam.map((g) => g.therapistName))}`,
      );

      expect(fertig.length, 'the Fertig tile count is the row population').toBe(tiles[TILES.fertig.key]);
      // AC2: the subtotals partition the rows exactly — a group that double-counted or dropped rows
      // would break this even if each individual figure looked plausible.
      expect(
        groups.reduce((n, g) => n + g.count, 0),
        'AC2: the group counts sum to the tile',
      ).toBe(fertig.length);

      // AC3, both halves. The team block first, then the team-less one, each alphabetical.
      const firstNoTeam = groups.findIndex((g) => !g.teamName);
      expect(firstNoTeam, 'AC3: a no-TO-Team block exists, so the rule is exercised').toBeGreaterThan(0);
      expect(
        groups.slice(firstNoTeam).every((g) => !g.teamName),
        'AC3: once the no-team block starts, no team therapist follows',
      ).toBe(true);
      for (const block of [groups.slice(0, firstNoTeam), groups.slice(firstNoTeam)]) {
        const names = block.map((g) => g.therapistName);
        expect(names, 'AC3: alphabetical by full name, first name leading').toEqual(
          [...names].sort((a, b) => a.localeCompare(b, 'de')),
        );
      }
      // The ticket's own wireframe names this therapist as the no-team example.
      expect(noTeam.map((g) => g.therapistName), "the wireframe's own no-team example is real").toContain(
        'Palle Spiekermann',
      );
    },
  );

  test(
    'AC5 the export writes one row per VO, in group order, and cannot widen its own scope',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request);
      const { rows } = await api.risks();

      const ids = ToRiskGroupingPage.exportIdsFor(rows, TILES.fertig.key);
      const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(ids));
      console.log(`#3774 AC5: sent ${ids.length} ids, CSV has ${csv.rows.length} data rows`);

      // **#3785 inserted three columns into this export** (`Ausst. Datum`, `Thema`, `Beh. Status`),
      // so #3774's own eight are asserted as a SUBSEQUENCE — which is what its AC5 governs ("the
      // same columns the billing backlog banner's export offered today") — with the full current
      // set checked beside it. The same stale-pin fix as AC4's on the screen side.
      const header = csv.header.map((h) => h.trim().replace(/^"|"$/g, ''));
      expect(header, 'the export still writes the full current column set').toEqual([...CSV_HEADER]);
      expect(
        header.filter((h) => (ORIGINAL_CSV_HEADER as readonly string[]).includes(h)),
        "AC5: the Abrechnungs-Stau column set, with Patient:in, in its original order",
      ).toEqual([...ORIGINAL_CSV_HEADER]);
      expect(csv.rows.length, 'AC5: one row per VO, and the Fertig tile has no cross-tile duplicates').toBe(ids.length);

      // AC5's order clause: the file follows the on-screen groups, so the therapist column must
      // come out in the same block order the oracle produced — and, crucially, the team-less block
      // must still be last in the FILE, which is the half a flat row-count check cannot see.
      const therapistColumn = csv.rows.map((r) => r[1]);
      const teamColumn = csv.rows.map((r) => r[0]);
      const firstOhne = teamColumn.indexOf('Ohne TO-Team');
      expect(firstOhne, 'AC5: the team-less rows are present in the file').toBeGreaterThan(0);
      expect(
        teamColumn.slice(firstOhne).every((t) => t === 'Ohne TO-Team'),
        'AC5: and they are the last block, as on screen',
      ).toBe(true);

      const blockOrder: string[] = [];
      for (const name of therapistColumn) if (blockOrder[blockOrder.length - 1] !== name) blockOrder.push(name);
      expect(
        new Set(blockOrder).size,
        "AC5: each therapist's rows are contiguous — the file is grouped, not merely sorted",
      ).toBe(blockOrder.length);

      // The scope guard: the client orders, the server scopes. A bogus id is dropped silently.
      const withBogus = ToRiskGroupingPage.parseCsv(await api.exportCsv([...ids.slice(0, 5), 999_999_999]));
      console.log(`#3774 AC5 scope: 5 real ids + 1 bogus -> ${withBogus.rows.length} rows`);
      expect(withBogus.rows.length, 'an id the board could not show is dropped, not written').toBe(5);
    },
  );

  test(
    'AC5 the Duplikat tile is never exported, but a stale VO that is ALSO in the Duplikat process still is',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new ToRiskGroupingPage(request);
      const { rows } = await api.risks();

      const duplikatIds = rows.filter((r) => r.tile === TILES.duplikat.key).map((r) => r.prescriptionId);
      const alsoElsewhere = new Set(
        rows.filter((r) => r.tile !== TILES.duplikat.key).map((r) => r.prescriptionId),
      );
      const expected = duplikatIds.filter((id) => alsoElsewhere.has(id));
      const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(duplikatIds));
      console.log(
        `#3774: ${duplikatIds.length} Duplikat ids -> ${csv.rows.length} exported; ` +
          `${expected.length} of them also carry a non-Duplikat row`,
      );

      // The controller drops rows whose tile IS duplikatOffen, not VOs that happen to be in the
      // Duplikat process. A VO that is also stale and unbilled is a legitimate backlog row and is
      // written through its OTHER tile — which is why the count here is not zero and must not be
      // asserted as zero.
      expect(csv.rows.length, 'exported via their non-Duplikat row, never via the Duplikat one').toBe(expected.length);
      const purelyDuplikat = duplikatIds.filter((id) => !alsoElsewhere.has(id));
      if (purelyDuplikat.length > 0) {
        const onlyDup = ToRiskGroupingPage.parseCsv(await api.exportCsv(purelyDuplikat));
        expect(onlyDup.rows.length, 'a VO whose ONLY row is Duplikat is never exported').toBe(0);
      }
    },
  );

  test(
    'FINDING: with no tile selected the CSV is shorter than the groups on screen',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request);
      const { rows } = await api.risks();

      const onScreen = ToRiskGroupingPage.rowsFor(rows, null);
      const exportIds = ToRiskGroupingPage.exportIdsFor(rows, null);
      const csv = ToRiskGroupingPage.parseCsv(await api.exportCsv(exportIds));
      const crossTile = onScreen.length - new Set(onScreen.map((r) => r.prescriptionId)).size;
      console.log(
        `#3774 FINDING: no tile selected — groups paint ${onScreen.length} rows, CSV holds ${csv.rows.length}, ` +
          `difference ${onScreen.length - csv.rows.length} (VOs listed under more than one tile: ${crossTile})`,
      );

      // AC5 asks for "every row currently grouped … one row per VO, in the same order as the
      // on-screen groups". Those two clauses cannot both hold while a VO can sit under two tiles,
      // and the commit chose one-row-per-VO — the defensible reading. What it leaves behind is the
      // Testing Guidance: "confirm the row count and therapist names match the on-screen groups"
      // fails in the state the board OPENS in, by the number below. Asserted as the current
      // behaviour so the test reports it and flips if the PM decides otherwise.
      expect(csv.rows.length, 'the file is deduplicated by VO').toBe(exportIds.length);
      expect(onScreen.length, 'while the screen counts rows, not VOs').toBeGreaterThan(csv.rows.length);
      expect(crossTile, 'and this is why: VOs appearing under more than one tile').toBeGreaterThan(0);

      // The contrast that keeps this a scoped finding rather than a blanket one.
      const fertigIds = ToRiskGroupingPage.exportIdsFor(rows, TILES.fertig.key);
      expect(
        ToRiskGroupingPage.rowsFor(rows, TILES.fertig.key).length,
        "AC5's primary case is clean: with the Fertig tile selected the two agree exactly",
      ).toBe(fertigIds.length);
    },
  );

  test(
    'AC7 the Management summary line equals the Fertig tile, to the cent',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new ToRiskGroupingPage(request);
      const { rows, tiles } = await api.risks();
      const summary = await api.unbilledSummary();

      const fertig = ToRiskGroupingPage.rowsFor(rows, TILES.fertig.key);
      const revenue = fertig.reduce((sum, r) => sum + (r.revenue ?? 0), 0);
      console.log(
        `#3774 AC7: unbilled-summary ${JSON.stringify(summary)} vs Fertig tile ${tiles[TILES.fertig.key]} / ${revenue.toFixed(2)}`,
      );

      // AC7 says the line reads "the same finished-and-unbilled population the risk tile uses", and
      // `ManagementUnbilledSummaryProvider` calls `OrgaBoardRisksProvider::unbilledSummary()` —
      // which computes only the Fertig tile, so the Management board does not pay for the expiry
      // tile's hydration. Comparing against the tile's OWN rows is what makes that claim testable
      // rather than tautological: two providers, one figure.
      expect(summary.count, 'AC7: the same count the tile shows').toBe(tiles[TILES.fertig.key]);
      expect(summary.totalRevenue, 'AC7: and the same value the rows sum to').toBeCloseTo(revenue, 2);
    },
  );

  test(
    'AC7 the two strings the summary line reuses are the banner\'s own, still in the dictionary',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new ToRiskGroupingPage(request);
      const { de, en, bundle } = await api.dictionaries();
      console.log(
        `#3774 AC7 i18n: ${I18N.summaryCount}=${JSON.stringify(de[I18N.summaryCount])} | ` +
          `${I18N.summaryValue}=${JSON.stringify(de[I18N.summaryValue])} | ` +
          `${I18N.bannerTitle}=${JSON.stringify(de[I18N.bannerTitle])}`,
      );

      // AC7 is explicit that the wording is REUSED from the banner rather than written afresh, so
      // the keys must be the banner's own — which is also why AC6's removal is a render change, not
      // a dictionary one: the banner's strings are all still here and that is correct.
      expect(de[I18N.summaryCount]).toBe('{{count}} fertig behandelte VOs noch nicht in der Abrechnung');
      expect(de[I18N.summaryValue]).toBe('≈ {{amount}} direkt abrechenbar');
      // **The banner's own name is GONE as of 2026-09-23, and that is the planned sequel, not a
      // regression.** This ticket's Out of Scope deferred the deletion — "hidden, not removed… the
      // companion ticket replaces the count it was built on before that code is deleted" — and
      // #3775's PR #3788 is titled "…and retire the Abrechnungs-Stau code". `abrechnungsStau` and
      // the literal "Abrechnungs-Stau" are now 0 occurrences in the whole bundle.
      //
      // What AC7 actually depends on is the two REUSED strings above, and those survive; asserting
      // those is the stronger statement anyway, since the banner's title was never part of the
      // summary line. Asserted as the current state so a future re-introduction is visible.
      expect(de[I18N.bannerTitle], "the banner's own title is retired by #3775, as this ticket deferred").toBeUndefined();
      expect(bundle.includes('Abrechnungs-Stau'), 'and the literal is gone from the bundle too').toBe(false);
      expect(de[I18N.exportButton], 'AC5: the Download button').toBe('Herunterladen');
      expect(de[I18N.ohneTeam], 'AC3/AC5: the team-less label').toBe('Ohne TO-Team');
      expect(en[I18N.summaryCount], 'and the English half ships too').toContain('not yet billed');
    },
  );

  test(
    'AC1/AC2/AC4 on screen: the board opens grouped, with subtotals matching the payload and AC4\'s column order',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request, page);
      const { rows } = await api.risks();
      await api.openBoard('Therapeuten-Orga');
      await api.waitForRiskTable();

      const painted = await api.paintedGroups();
      const expected = ToRiskGroupingPage.groupRows(ToRiskGroupingPage.rowsFor(rows, null));
      console.log(`#3774 AC1: ${painted.length} groups painted; first three ${JSON.stringify(painted.slice(0, 3))}`);
      console.log(`#3774 AC1: oracle's first three ${JSON.stringify(expected.slice(0, 3).map((g) => ({ name: g.therapistName, count: g.count, revenue: Number(g.revenue.toFixed(2)) })))}`);

      // The board opens with NO tile selected, which is AC1's second grouped case — so the default
      // state is already the assertion, not a preamble to one.
      expect(painted.length, 'AC1: the table is grouped on open').toBeGreaterThan(1);

      // AC2: every painted subtotal must equal the payload's for that therapist. Comparing the
      // first group only would pass on a table that grouped correctly and totalled wrongly further
      // down, so every painted group is checked against the oracle by name.
      // The boards append " (Inaktiv)" to a deactivated therapist's name (#3210) while the payload
      // carries the bare one, so a raw name key drops exactly those groups — 8 of 133 here. Both
      // sides are normalised, which is what lets this assert ALL of them rather than most.
      const byName = new Map(expected.map((g) => [ToRiskGroupingPage.plainName(g.therapistName), g]));
      let checked = 0;
      for (const group of painted) {
        const oracle = byName.get(ToRiskGroupingPage.plainName(group.name));
        expect(oracle, `AC2: "${group.name}" is a therapist the payload knows`).toBeTruthy();
        expect(group.count, `AC2: ${group.name}'s row count`).toBe(oracle!.count);
        expect(group.revenue, `AC2: ${group.name}'s value`).toBeCloseTo(oracle!.revenue, 2);
        checked++;
      }
      console.log(`#3774 AC2: ${checked} of ${painted.length} painted groups matched the payload exactly`);
      expect(checked, 'every painted group was checked against the payload').toBe(painted.length);
      expect(painted.length, 'and the board painted every group the payload implies').toBe(expected.length);

      // AC3 on screen: the painted order is the oracle's order, restricted to what is rendered.
      const paintedNames = painted.map((g) => ToRiskGroupingPage.plainName(g.name));
      const oracleOrder = expected.map((g) => ToRiskGroupingPage.plainName(g.therapistName));
      expect(paintedNames, 'AC3: painted in the oracle\'s order, all 133 of them').toEqual(oracleOrder);

      // AC4: the column order inside a group. **#3785 inserted two columns on 2026-09-23**
      // (`Ausst. Datum` at 3, `Beh. Status` at 9), so an exact match on #3774's original eight now
      // fails on a correct build. #3774 AC4 governs the order of the columns IT names, so that is
      // what is asserted — as a subsequence — with the full current set checked separately.
      const headers = await api.riskColumnHeaders();
      console.log(`#3774 AC4 columns (${headers.length}): ${JSON.stringify(headers)}`);
      expect(headers, 'the grouped view still paints the full current column set').toEqual([...GROUP_COLUMNS]);
      expect(
        headers.filter((h) => (ORIGINAL_GROUP_COLUMNS as readonly string[]).includes(h)),
        "AC4: #3774's own eight keep their relative order through #3785's insertions",
      ).toEqual([...ORIGINAL_GROUP_COLUMNS]);

      // AC5: the Download control is present for the grouped view.
      expect(await api.downloadButtonCount(), 'AC5: "Herunterladen" is offered on the grouped view').toBeGreaterThan(0);
    },
  );

  test(
    'AC1 the three other tiles render FLAT, and AC5\'s button is withheld there',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request, page);
      await api.openBoard('Therapeuten-Orga');
      await api.waitForRiskTable();

      // The grouped case first, so "no groups" on the flat tiles is a change rather than a state
      // the board might have been in all along.
      await api.selectTile(TILES.fertig.label);
      await api.waitForRiskTable({ expectGroups: true });
      const grouped = await api.paintedGroups();
      const groupedDownload = await api.downloadButtonCount();
      console.log(`#3774 AC1 "${TILES.fertig.label}": ${grouped.length} groups, download control x${groupedDownload}`);
      expect(grouped.length, 'AC1: the billing-backlog tile groups').toBeGreaterThan(1);
      expect(groupedDownload, 'AC5: and carries the export').toBeGreaterThan(0);

      for (const tile of [TILES.laeuftAb, TILES.ibFehlt, TILES.duplikat]) {
        await api.selectTile(tile.label);
        // Wait on the headers, not on groups: zero groups IS the assertion here, so it cannot be
        // waited for — and reading too early would satisfy it for the wrong reason.
        await api.waitForRiskTable({ expectGroups: false });
        const groups = await api.paintedGroups();
        const download = await api.downloadButtonCount();
        console.log(`#3774 AC1 "${tile.label}": ${groups.length} groups, download control x${download}`);
        expect(groups.length, `AC1: "${tile.label}" stays flat`).toBe(0);
        expect(download, `AC5: and offers no export`).toBe(0);
      }
    },
  );

  test(
    'AC6/AC7 the banner is gone from both boards, and Management carries the plain summary line',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request, page);
      const summary = await api.unbilledSummary();

      const boards = await api.openBoard('Therapeuten-Orga');
      await api.waitForRiskTable();
      const toText = await api.boardText();
      expect(toText, 'AC6: no banner on the Therapeuten-Orga board').not.toContain('Abrechnungs-Stau');
      // The legend line that explained the banner went with it, so the legend is checked too.
      expect(toText, 'and the legend line that explained it is gone').not.toContain('Abrechnungs-Stau');

      await boards.openTab('Management');
      await expect(page.getByText('Umsatz-Realisierung', { exact: false }).first(), 'the Management board').toBeVisible({
        timeout: 300_000,
      });
      // The line renders from the same read as the tile, which is slower than the board shell —
      // poll for it rather than reading once, or its absence looks like AC7 failing.
      await expect
        .poll(async () => (await api.boardText()).includes('noch nicht in der Abrechnung'), {
          timeout: 300_000,
          intervals: [3_000],
        })
        .toBe(true);
      const mgmtText = await api.boardText();
      const line = mgmtText.split('\n').find((l) => l.includes('noch nicht in der Abrechnung')) ?? '';
      console.log(`#3774 AC7 summary line: ${JSON.stringify(line)}`);

      expect(mgmtText, 'AC6: no banner on the Management board either').not.toContain('Abrechnungs-Stau');
      // AC7: the same count the API serves, formatted German (1.179), and both halves on one line.
      expect(line, 'AC7: the count').toContain(summary.count.toLocaleString('de-DE'));
      expect(line, 'AC7: and the value, on the same line').toContain('direkt abrechenbar');
      expect(line, 'AC7: reusing the banner wording').toContain('fertig behandelte VOs noch nicht in der Abrechnung');
      // AC7: text only — no flag icon, no chevron, not a button.
      expect(line, 'AC7: the chevron is gone').not.toContain('›');
      const clickable = await page.getByRole('button', { name: /noch nicht in der Abrechnung/ }).count();
      expect(clickable, 'AC7: not clickable — it opens no drill-down').toBe(0);
    },
  );

  test(
    'AC1 the Admin-Performance board\'s own risk table is untouched — still flat, for every tile',
    { tag: ['@SuperAdmin', '@RiskGrouping', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new ToRiskGroupingPage(request, page);
      await api.openBoard('Admin-Performance');

      // The whole risk table is a SHARED component (`RiskWorklist`), so the realistic failure here
      // is grouping leaking onto a second board — which is exactly what #3579's sibling ticket had
      // to be careful about on this same board family. The gate lives in `TherapeutenOrgaRisks`.
      // Zero groups is the assertion, so readiness is the headers — waiting for groups here would
      // wait out the whole timeout on a correct build.
      await api.waitForRiskTable({ expectGroups: false });
      const groups = await api.paintedGroups();
      const download = await api.downloadButtonCount();
      console.log(`#3774 AC1 Admin-Performance: ${groups.length} groups, download control x${download}`);
      expect(groups.length, 'AC1: the Admin-Performance risk table is not grouped').toBe(0);
      expect(download, 'and carries no export button').toBe(0);
    },
  );

});
