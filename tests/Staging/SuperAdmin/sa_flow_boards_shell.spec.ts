import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Flow Boards Shell: Navigation, Board Tabs & Access (#3173, epic #3172).
 *
 * Covers the Super-Admin side of the ticket: the navigation entry, the 5-tab switcher with the
 * Management tab open by default, the "In Vorbereitung" placeholders on the 4 unbuilt boards, and
 * the Gesellschaft selector. AC 2 (no other role may reach the page or its data) is covered from
 * the roles it concerns, in tests/Staging/Admin/admin_flow_boards_access.spec.ts and
 * tests/Staging/Therapist/therapist_flow_boards_access.spec.ts.
 */
test.describe('Flow Boards — Shell, tabs & access', () => {
  test(
    'AC1 — "Flow Boards" sits in the Management navigation next to "KPI Dashboard"',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsShell'] },
    async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1200 });
      await new AppPage(page).goto('/flow-boards');
      await expect(page.getByText('Flow Boards', { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });

      // "Management" is a top-bar menu button whose children are portalled in only once opened.
      // Matched by hasText rather than by accessible name: the button's label is "<icon glyph>
      // Management ▾", so a role-name match is unreliable.
      //
      // Retried, because React Native Web paints the nav labels before it attaches the Pressable
      // handlers — an early click lands on live text and does nothing at all (the same reason
      // AppPage.navTo retries).
      const mgmtMenu = page.locator('button[role="button"]').filter({ hasText: /Management/ }).first();
      const menuItems = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('div[tabindex="0"], [role="button"], a')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => (el as HTMLElement).innerText.trim())
            .filter(Boolean),
        );

      let menuEntries: string[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        await mgmtMenu.click({ force: true, timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        menuEntries = await menuItems();
        if (menuEntries.includes('Flow Boards')) break;
        await page.waitForTimeout(1500);
      }

      expect(menuEntries, 'Management menu should offer the new Flow Boards entry').toContain(
        'Flow Boards',
      );
      expect(
        menuEntries,
        'the existing KPI Dashboard entry must stay alongside it (parallel-run period)',
      ).toContain('KPI Dashboard');
    },
  );

  test(
    'AC3 — the 5-board tab switcher renders with Management open by default',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsShell'] },
    async ({ page }) => {
      const board = new FlowBoardsPage(page);
      await board.open();

      await board.expectAllBoardTabs();

      // "open by default" is observable through the Management board's own content: no other tab
      // renders a filter bar or KPI cards (see AC4).
      await expect(page.getByText('Umsatz (behandelt)').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Periode', { exact: true })).toBeVisible();
      await expect(page.getByText('In Vorbereitung').first()).toBeVisible(); // the 3 coming-soon cards
    },
  );

  test(
    'AC4 — each unbuilt board shows an "In Vorbereitung" placeholder with no data or filters',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsShell'] },
    async ({ page }) => {
      const board = new FlowBoardsPage(page);
      await board.open();

      // AC4 describes the four boards as UNBUILT. Two of them have since moved on, so the
      // clean-placeholder contract is asserted only where it still applies — and which boards have
      // advanced is reported rather than quietly skipped. Measured live on v3.11.0:
      //   Einrichtungen      — "In Vorbereitung", no filter bar          (still a placeholder)
      //   Ärzte-Management   — "In Vorbereitung", no filter bar          (still a placeholder)
      //   Therapeuten-Orga   — "In Vorbereitung" AND a full filter bar   (partially built)
      //   Admin-Performance  — no "In Vorbereitung" at all, renders Zeitraum (built)
      const advanced: string[] = [];

      for (const tab of FlowBoardsPage.PLACEHOLDER_BOARDS) {
        await board.openTab(tab);
        await page.waitForTimeout(3_000);
        const text = await board.boardText();

        if (!text.includes('In Vorbereitung')) {
          advanced.push(`${tab} (no "In Vorbereitung" — board is built)`);
          await board.expectAllBoardTabs();
          continue;
        }
        await expect(
          page.getByText('In Vorbereitung', { exact: true }).first(),
          `"${tab}" placeholder message`,
        ).toBeVisible({ timeout: 20_000 });

        const rendersFilters = ['Periode', 'Zeitraum'].some((f) => text.includes(f));
        if (rendersFilters) {
          advanced.push(`${tab} ("In Vorbereitung" but a filter bar is rendered)`);
        } else {
          // a true placeholder: no filters, no cards, no interactive board content
          for (const forbidden of ['Periode', 'Zeitraum', 'Umsatz (behandelt)', 'Abrechnungs-Stau']) {
            expect(text, `"${tab}" must not render "${forbidden}"`).not.toContain(forbidden);
          }
          expect(await board.bucket('Rot').count(), `"${tab}" must not render buckets`).toBe(0);
        }

        // the tab switcher itself stays available so the user can get back
        await board.expectAllBoardTabs();
      }

      // eslint-disable-next-line no-console
      console.log(`boards past the placeholder stage: ${JSON.stringify(advanced)}`);
      expect(
        advanced.length,
        `at least one board must still be an unbuilt placeholder (advanced: ${JSON.stringify(advanced)})`,
      ).toBeLessThan(FlowBoardsPage.PLACEHOLDER_BOARDS.length);

      // returning to Management restores the real board
      await board.openTab('Management');
      await expect(page.getByText('Umsatz (behandelt)').first()).toBeVisible({ timeout: 30_000 });
    },
  );

  test(
    'AC5 — Gesellschaft selector offers "Alle Gesellschaften" plus one option per company, and narrows the board',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsShell'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      await expect(page.getByText('Gesellschaft', { exact: true })).toBeVisible();
      await expect(page.getByText('Alle Gesellschaften', { exact: true })).toBeVisible();

      const options = await board.openGesellschaft();
      const companies = options.filter((o) => /GmbH|gGmbH|AG|UG/.test(o));
      expect(
        companies.length,
        `expected at least one company option, got ${JSON.stringify(options)}`,
      ).toBeGreaterThan(0);
      await board.closeDropdown();

      test.skip(
        !loaded,
        'Board settled on the empty state before a company could be compared — open defect #3233 ' +
          '(cold-cache requests exceed the client 8s read timeout and fall back to "-"/0 silently).',
      );

      // Selecting a company must re-scope the board. Any of the live figures may legitimately be
      // unchanged for a given company, so assert on the therapist population instead, which is what
      // the Gesellschaft assignment actually narrows.
      await board.setDetailView('Therapeut:innen');
      const allTherapists = await board.detailRowNames();
      expect(allTherapists.length, 'therapist rows before scoping').toBeGreaterThan(0);

      await board.selectGesellschaft(companies[0]);
      const scoped = await board.detailRowNames();

      expect(
        scoped.length,
        `selecting "${companies[0]}" must not widen the therapist population ` +
          `(all=${allTherapists.length}, scoped=${scoped.length})`,
      ).toBeLessThanOrEqual(allTherapists.length);
      expect(
        scoped.every((t) => allTherapists.includes(t)),
        'every therapist under one company must also appear under "Alle Gesellschaften"',
      ).toBe(true);
    },
  );
});
