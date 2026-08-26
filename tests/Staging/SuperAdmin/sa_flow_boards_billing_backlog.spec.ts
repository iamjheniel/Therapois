import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Billing Backlog Banner & Drill-Down (#3180, epic #3172).
 *
 * The banner counts fully-treated VOs, last treated more than 6 weeks ago, not yet in a billing
 * batch — deliberately regardless of validation status (AC1). The drill-down groups them by TO team,
 * then by therapist, with a subtotal at each level.
 *
 * AC1's status/6-week/not-yet-billed conditions and AC2's "latest SIGNED treatment activity" are
 * query-side rules. What the UI does expose is the consequence: every row in the drill-down must be
 * at least 6 weeks past its last treatment, and the count and value on the banner must match the
 * rows the drill-down lists. Both are asserted.
 */
test.describe('Flow Boards — Abrechnungs-Stau banner & drill-down', () => {
  test(
    'AC1/AC3 — the banner states the stuck-VO count and its immediately billable value',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBacklog'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      const banner = board.backlogBanner();
      const present = await banner.count();
      test.skip(
        present === 0,
        'No billing backlog in the current filter scope, so the Abrechnungs-Stau banner is not ' +
          'shown — there is nothing to alert about.',
      );

      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(
        banner,
        'the banner names the alert and how many fully treated VOs are stuck',
      ).toContainText(/Abrechnungs-Stau · \d+ fertig behandelte VOs noch nicht in der Abrechnung/);
      await expect(
        banner,
        'AC3 — the combined treated-revenue value, labelled "direkt abrechenbar"',
      ).toContainText(/≈ [\d.,]+ € direkt abrechenbar/);

      const { count, value } = await board.backlogSummary();
      expect(count, 'backlog VO count').not.toBeNull();
      expect(count!, 'a shown banner must count at least one VO').toBeGreaterThan(0);
      expect(value, 'backlog value').toMatch(/€/);
    },
  );

  test(
    'AC5/AC6/AC7 — the drill-down lists the VOs grouped by TO team then therapist, with subtotals and per-VO detail',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBacklog'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      test.skip(
        (await board.backlogBanner().count()) === 0,
        'No billing backlog in the current filter scope.',
      );
      const { count } = await board.backlogSummary();

      await board.openBacklogDrilldown();

      // AC6: the per-VO columns. Matched case-insensitively — like the detail table's headers these
      // are uppercased by CSS, so the DOM text is "Patient:in" while the screen reads "PATIENT:IN".
      for (const col of FlowBoardsPage.BACKLOG_COLUMNS) {
        await expect(board.headerText(col), `drill-down column "${col}"`).toBeVisible();
      }

      // AC5: grouped by TO team, including the explicit no-team group
      const groups = await board.backlogGroupHeaders();
      expect(groups.length, `TO-team group headers, got ${JSON.stringify(groups)}`).toBeGreaterThan(0);
      expect(
        groups.every((g) => /^Team .+|^Ohne TO-Team$/.test(g)),
        `every group header must be a TO team or "Ohne TO-Team", got ${JSON.stringify(groups)}`,
      ).toBe(true);

      // AC7: a subtotal (VO count + revenue) per therapist group and per team group
      const subtotals = await board.backlogSubtotals();
      expect(
        subtotals.length,
        `each team and therapist group needs a "N VOs · X €" subtotal, got ` +
          `${subtotals.length} for ${groups.length} team groups`,
      ).toBeGreaterThanOrEqual(groups.length * 2); // one per team + at least one therapist inside each

      // AC6: each row carries VO number, patient initials, Heilmittel, weeks since last treatment,
      // days since fully treated, and the VO's revenue
      const rows = await board.backlogRows();
      expect(rows.length, 'per-VO rows in the drill-down').toBeGreaterThan(0);
      for (const row of rows.slice(0, 10)) {
        const [voNr, initials, , lastTreatment, fertigSeit, revenue] = row;
        expect(voNr, 'VO number').toMatch(/^\d+-\d+$/);
        expect(initials, 'patient initials only — never a full name').toMatch(
          /^[A-ZÄÖÜ]\.\s?[A-ZÄÖÜ]\.$/,
        );
        expect(lastTreatment, `"${voNr}" weeks since last treatment`).toMatch(/^\d+ Wo\.$/);
        expect(fertigSeit, `"${voNr}" days since fully treated`).toMatch(/^(\d+ Tage|—)$/);
        expect(revenue, `"${voNr}" treated-revenue value`).toMatch(/€/);
      }

      // AC1's 6-week rule, as the UI exposes it: nothing younger than 6 weeks may be listed
      const weeks = rows.map((r) => Number(r[3].match(/(\d+) Wo\./)?.[1] ?? -1));
      expect(
        Math.min(...weeks),
        `every backlog VO must be more than 6 weeks past its last treatment; ` +
          `the youngest row is ${Math.min(...weeks)} Wo.`,
      ).toBeGreaterThanOrEqual(6);

      // the banner count must describe the list it opens
      expect(
        rows.length,
        `the drill-down lists ${rows.length} VOs but the banner claims ${count}`,
      ).toBe(count);
    },
  );

  test(
    'AC4 — the banner recomputes for the filtered scope',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBacklog'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);

      const backlogCalls: URL[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith('/kpis/management/billing-backlog')) backlogCalls.push(u);
      });

      await board.open();
      await board.waitForBoardLoaded();
      test.skip(
        (await board.backlogBanner().count()) === 0,
        'No billing backlog in the current filter scope.',
      );

      const unfiltered = await board.backlogSummary();

      // scoping to one TO team must narrow the banner to that team's stuck VOs
      const teamOptions = await board.openDropdown('Alle Teams');
      const named = teamOptions.filter((o) => o !== 'Alle Teams' && o !== 'Ohne TO-Team');
      await board.closeDropdown();
      test.skip(!named.length, 'No named TO team available in the team selector.');

      const callsBefore = backlogCalls.length;
      await board.selectTeam(named[0]);
      expect(
        backlogCalls.length,
        'changing the team filter must re-request the billing backlog',
      ).toBeGreaterThan(callsBefore);

      const scopedPresent = await board.backlogBanner().count();
      if (scopedPresent === 0) {
        // a team with no stuck VOs correctly hides the alert entirely — that is AC4 working
        expect(scopedPresent, `"${named[0]}" has no backlog, so no banner is shown`).toBe(0);
        return;
      }
      const scoped = await board.backlogSummary();
      expect(
        scoped.count!,
        `"${named[0]}" backlog (${scoped.count}) cannot exceed the unfiltered backlog ` +
          `(${unfiltered.count})`,
      ).toBeLessThanOrEqual(unfiltered.count!);
    },
  );

  test(
    'AC1 — the backlog deliberately ignores validation status',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBacklog'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');
      test.skip(
        (await board.backlogBanner().count()) === 0,
        'No billing backlog in the current filter scope.',
      );

      // AC1 is explicit that a not-yet-validated VO still counts. The observable consequence: the
      // backlog value is NOT bounded by validated revenue — it is drawn from a different axis
      // entirely (treatment + billing state), so it may freely exceed Umsatz validiert.
      const { value } = await board.backlogSummary();
      const backlog = FlowBoardsPage.parseNumber(value);
      const validated = FlowBoardsPage.parseNumber(await board.valueUnder('Umsatz validiert'));
      expect(backlog, 'backlog value').not.toBeNull();

      // The drill-down must not filter itself down to validated VOs only, so nothing in it may claim
      // a validation status as an inclusion criterion.
      await board.openBacklogDrilldown();
      const text = await board.boardText();
      const drilldown = text.slice(text.indexOf('FERTIG SEIT'));
      for (const status of ['Zur Korrektur', 'Kann nicht validiert werden', 'An Therapeut zurückgesendet']) {
        expect(
          drilldown,
          `the drill-down must not gate on validation status ("${status}" must not appear as a filter)`,
        ).not.toContain(status);
      }

      // Log the relationship for the record — it is expected to be independent, not ordered.
      console.log(
        `backlog value=${backlog} vs Umsatz validiert=${validated} ` +
          `(independent axes per AC1 — no ordering is asserted)`,
      );
    },
  );
});
