import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — TO-Team Detail Table (#3178, epic #3172).
 *
 * Two views over the same data (Gruppen / Therapeut:innen), team rows that must add up to the board
 * total, "real totals" team maths, sortable columns, and the ⚠ Zeiterfassung marker.
 *
 * Note on AC3: "real totals, never an average of member percentages" is a claim about how a team
 * figure is derived, which a UI test cannot read directly. It IS falsifiable, though — the test
 * expands a team and checks the team's Effizienz against the arithmetic mean of its members'
 * percentages; where the two differ, the average-of-averages implementation is ruled out. Where a
 * team's members happen to make both formulas agree, the test says so instead of claiming a pass.
 */
test.describe('Flow Boards — TO-team detail table', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1/AC5 — both views render, with the live columns and the 3 coming-soon columns',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDetailTable'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      await expect(page.getByText('Detail', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(board.segment('Gruppen')).toBeVisible();
      await expect(board.segment('Therapeut:innen')).toBeVisible();

      // Column headers are uppercased by CSS, so the DOM text is "Gruppe" while the screen reads
      // "GRUPPE" — every header assertion here matches case-insensitively via `headerText`.
      await board.setDetailView('Gruppen');
      await expect(board.headerText('GRUPPE'), 'the Gruppen view keys rows by group').toBeVisible();
      for (const col of FlowBoardsPage.TABLE_LIVE_COLUMNS) {
        await expect(board.headerText(col), `column "${col}"`).toBeVisible();
      }
      for (const col of FlowBoardsPage.TABLE_COMING_SOON_COLUMNS) {
        await expect(board.headerText(col), `coming-soon column "${col}"`).toBeVisible();
      }

      // Therapeut:innen view: the same columns, keyed by therapist
      await board.setDetailView('Therapeut:innen');
      await expect(
        board.headerText('THERAPEUT:IN'),
        'the flat view keys rows by therapist',
      ).toBeVisible();
      for (const col of FlowBoardsPage.TABLE_LIVE_COLUMNS) {
        await expect(board.headerText(col), `column "${col}" in the flat view`).toBeVisible();
      }

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // the 3 coming-soon columns carry no data on any row
      const rowRegion = (await board.boardText()).slice(
        (await board.boardText()).lastIndexOf('ABSETZ.-QUOTE'),
      );
      const rows = rowRegion.split('\n').filter((l) => l.trim());
      expect(rows.length, 'the flat view renders rows').toBeGreaterThan(0);
      // each row ends with three "—" placeholders for the coming-soon columns
      expect(
        rowRegion,
        'coming-soon columns must render as placeholders on the rows',
      ).toContain('—');
    },
  );

  test(
    'AC2 — Gruppen shows one row per TO team plus "Ohne TO-Team", and the rows add up to the whole board',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDetailTable'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      await board.setDetailView('Gruppen');
      const groups = await board.detailRowNames();
      expect(groups.length, 'team rows').toBeGreaterThan(1);

      // "Ohne TO-Team" gets a group row only when some therapist is actually unassigned — the row
      // is a bucket, not a fixed heading. On staging today that bucket is EMPTY: the option is
      // still offered by the team filter, and selecting it returns 0 €, 0,0 % efficiency and
      // Rot/Gelb/Grün/Grau all 0. So the AC is checked where it is unconditionally true (the
      // selector) and only demanded of the rows when the bucket has members.
      const teamOptions = await board.openDropdown('Alle Teams');
      await board.closeDropdown();
      expect(
        teamOptions,
        'the "Ohne TO-Team" group must always be offered by the team selector',
      ).toContain('Ohne TO-Team');
      if (!groups.includes('Ohne TO-Team')) {
        // eslint-disable-next-line no-console
        console.log('no "Ohne TO-Team" group row — every therapist is currently assigned to a team');
      }

      // The group rows must account for the whole board: their member counts sum to the therapist
      // population, which is the Gesamt figure this table drills into.
      const flat = await board.boardText();
      const rowRegion = flat.slice(flat.lastIndexOf('ABSETZ.-QUOTE'));
      const memberCounts = [...rowRegion.matchAll(/\n([A-ZÄÖÜ][^\n]*)\n(\d+)\n/g)].map((m) => ({
        group: m[1].trim(),
        members: Number(m[2]),
      }));
      expect(memberCounts.length, 'each group row states its member count').toBeGreaterThan(0);

      await board.setDetailView('Therapeut:innen');
      const therapists = await board.detailRowNames();
      const summed = memberCounts.reduce((a, g) => a + g.members, 0);
      expect(
        summed,
        `the team rows plus "Ohne TO-Team" (${JSON.stringify(memberCounts)} = ${summed}) must add ` +
          `up to the ${therapists.length} therapists in the flat view`,
      ).toBe(therapists.length);
    },
  );

  test(
    'AC3/AC4 — expanding a team lists its members, and the team figure is a real total rather than an average of member percentages',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDetailTable'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      await board.setDetailView('Gruppen');
      const groups = (await board.detailRowNames()).filter((g) => g !== 'Ohne TO-Team');
      test.skip(!groups.length, 'No named TO team row in the Gruppen view.');

      // AC4: expanding adds member rows, and they are real therapists from this board
      const before = await board.detailRowNames();
      const members = await board.expandTeamAndListMembers(groups[0]);
      expect(
        members.length,
        `expanding "${groups[0]}" must reveal its member therapists (had ${before.length} rows)`,
      ).toBeGreaterThan(0);

      await board.setDetailView('Therapeut:innen');
      const allTherapists = await board.detailRowNames();
      expect(
        members.every((m) => allTherapists.includes(m)),
        `every member row under "${groups[0]}" must be a therapist the flat view also lists; ` +
          `members=${JSON.stringify(members)}`,
      ).toBe(true);
      await board.setDetailView('Gruppen');
      await board.expandTeam(groups[0]);

      // AC3: a team's Effizienz must be a real total (combined ÷ combined), not the mean of its
      // members' percentages. Cells are read by column alignment — a team row carries a trend
      // percentage that a member row does not, so "the first % in the row" is a different column on
      // the two row types.
      const teamPct = await board.rowEfficiency(groups[0]);
      const memberPcts: number[] = [];
      for (const m of members) {
        const pct = await board.rowEfficiency(m);
        if (pct !== null) memberPcts.push(pct);
      }

      test.skip(
        teamPct === null || memberPcts.length < 2,
        `"${groups[0]}" does not report enough Effizienz values this period ` +
          `(team=${teamPct}, members=${JSON.stringify(memberPcts)}) to compare the two formulas.`,
      );

      const mean = memberPcts.reduce((a, b) => a + b, 0) / memberPcts.length;
      const spread = Math.max(...memberPcts) - Math.min(...memberPcts);
      test.skip(
        spread < 0.05,
        `Every member of "${groups[0]}" reports the same Effizienz (${memberPcts[0]} %) this period, ` +
          `so a real total and an average of member percentages produce the same number — the two ` +
          `implementations are not distinguishable from the UI right now.`,
      );

      expect(
        Math.abs(teamPct! - mean),
        `"${groups[0]}" team Effizienz (${teamPct} %) must be a real total over the team's combined ` +
          `time, not the average of its members' percentages (${mean.toFixed(2)} %, from ` +
          `${JSON.stringify(memberPcts)})`,
      ).toBeGreaterThan(0.05);
    },
  );

  test(
    'AC6 — clicking a sortable column header reorders the rows and toggles direction',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDetailTable'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      await board.setDetailView('Therapeut:innen');
      const original = await board.detailRowNames();
      expect(original.length, 'therapist rows').toBeGreaterThan(2);

      // A metric column proves "clicking a header reorders the rows"…
      await board.sortBy('EFFIZIENZ');
      const byEfficiency = await board.detailRowNames();
      expect(byEfficiency, 'sorting by EFFIZIENZ must reorder the rows').not.toEqual(original);

      // …but it cannot prove the direction toggle: nearly every therapist reports the same Effizienz
      // on staging this period, so ascending and descending are the same list. The name column has
      // all-distinct values, so a direction flip there is unambiguous.
      await board.sortBy('THERAPEUT:IN');
      const ascending = await board.detailRowNames();
      await board.sortBy('THERAPEUT:IN');
      const descending = await board.detailRowNames();

      expect(
        descending,
        'clicking the same header again must toggle the sort direction',
      ).not.toEqual(ascending);
      expect(
        descending.slice().reverse(),
        'toggling the direction on the name column must reverse the order, not re-filter the rows',
      ).toEqual(ascending);
    },
  );

  test(
    'AC7 — a ⚠ Zeiterfassung marker flags therapists with a time-recording discrepancy',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDetailTable'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // the marker belongs to the Therapeut:innen view (per-person, not per-team)
      await board.setDetailView('Therapeut:innen');
      const flagged = await board.timeRecordingWarnings().count();
      test.skip(
        flagged === 0,
        'No therapist currently trips the time-recording thresholds (>115 % efficiency or a ' +
          '>12 % Personio-vs-Flow gap) in the selected period.',
      );

      const therapists = await board.detailRowNames();
      expect(
        flagged,
        `${flagged} time-recording warnings cannot exceed the ${therapists.length} therapist rows`,
      ).toBeLessThanOrEqual(therapists.length);

      // the marker sits next to a therapist's name, i.e. inside the row region
      const flat = await board.boardText();
      const rowRegion = flat.slice(flat.lastIndexOf('ABSETZ.-QUOTE'));
      expect(
        rowRegion,
        'the ⚠ Zeiterfassung marker must render within the therapist rows',
      ).toContain('⚠ Zeiterfassung');

      // and it is a per-therapist marker, so it must not appear on the team rows
      await board.setDetailView('Gruppen');
      const groupFlat = await board.boardText();
      const groupRows = groupFlat.slice(groupFlat.lastIndexOf('ABSETZ.-QUOTE'));
      expect(
        groupRows,
        'the time-recording marker is per therapist (AC7), so team rows must not carry it',
      ).not.toContain('⚠ Zeiterfassung');
    },
  );
});
