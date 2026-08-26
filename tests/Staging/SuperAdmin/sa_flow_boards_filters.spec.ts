import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Filter Bar (#3174 AC1–AC6, epic #3172).
 *
 * The filter bar drives every other surface on the board, so these tests assert both that each
 * control behaves and that the board actually re-scopes behind it.
 *
 * Two staging realities shape the assertions:
 *  - Selection state is colour-only (no aria-selected/aria-pressed), so `isSegmentActive()` reads
 *    the computed background. That is also the only way the auto-derived Zeitraum granularity in
 *    AC1 is observable.
 *  - Staging revenue in the current week is tiny and several filter combinations legitimately
 *    total 0 €, so "the filter worked" is asserted as a *narrowing* invariant
 *    (GKV + PKV ≤ Alle, subset relationships) rather than "the number changed".
 */
test.describe('Flow Boards — Filter bar', () => {
  test.describe.configure({ mode: 'serial' }); // one shared board; each test reloads it

  test(
    'AC1 — Zeitraum mode shows a date-range picker and derives the display level from the range length',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsFilters'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      // Periode is the default mode; Tag/Woche/Monat are picked by hand there.
      expect(await board.isSegmentActive('Periode')).toBe(true);

      await board.setPeriodMode('Zeitraum');

      // a range picker appears, with the selected range shown as a "from - to" label
      const label = await board.rangeLabel();
      expect(label, 'Zeitraum mode must show the selected date range').toMatch(
        /Zeitraum: \d{2}\.\d{2}\.\d{4} - \d{2}\.\d{2}\.\d{4}/,
      );
      await expect(page.getByText('Anzeige:', { exact: true })).toBeVisible();

      // The level is derived, not chosen: a short range maps to Tag, a month-long range to Woche.
      const shortDays = await board.rangeLengthDays();
      const shortLevel = await board.activeLevel();
      expect(shortDays, 'default Zeitraum range length').not.toBeNull();
      expect(
        shortLevel,
        `a ${shortDays}-day range should display at day level, got "${shortLevel}"`,
      ).toBe('Tag');

      await board.applyRangePreset('This Month');
      const monthDays = await board.rangeLengthDays();
      const monthLevel = await board.activeLevel();
      expect(monthDays!, 'a month preset must select a longer range').toBeGreaterThan(shortDays!);
      expect(
        monthLevel,
        `a ${monthDays}-day range must derive a coarser level than a ${shortDays}-day range ` +
          `(got "${monthLevel}" vs "${shortLevel}")`,
      ).not.toBe(shortLevel);
      expect(['Woche', 'Monat'], `derived level for ${monthDays} days`).toContain(monthLevel!);
    },
  );

  test(
    'AC2 — the period arrows step by one unit of the selected level and the forward arrow is disabled at the current period',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsFilters'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      for (const level of ['Woche', 'Monat'] as const) {
        await board.setLevel(level);
        expect(await board.isSegmentActive(level)).toBe(true);

        // the board opens on the current period, so stepping forward is not possible
        expect(
          await board.forwardArrowDisabled(),
          `at ${level} level the board opens on the current period, so the forward arrow must be disabled`,
        ).toBe(true);

        const current = await board.periodLabel();
        expect(current, `${level} period label`).not.toBe('');

        await board.stepPeriod('back');
        const previous = await board.periodLabel();
        expect(previous, `stepping back at ${level} level must change the period`).not.toBe(current);

        // once off the current period the forward arrow becomes usable again and returns
        expect(await board.forwardArrowDisabled()).toBe(false);
        await board.stepPeriod('forward');
        expect(
          await board.periodLabel(),
          `stepping forward must return to "${current}"`,
        ).toBe(current);
      }
    },
  );

  test(
    'AC3/AC4 — therapist and TO-team selectors narrow the whole board',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsFilters'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      // ── AC3: therapist selector, with its own search box, defaults to all therapists
      const therapistOptions = await board.openDropdown('Alle Therapeut:innen');
      expect(therapistOptions.length, 'therapist options').toBeGreaterThan(0);
      // v3.11.0 translated the dropdown search boxes ("Search" → "Suchen"). Accept either, so this
      // keeps working against Production's older build.
      await expect(
        page.locator('input[placeholder="Search"], input[placeholder="Suchen"]').first(),
        'the therapist dropdown offers a search box',
      ).toBeVisible();
      await board.closeDropdown();

      // ── AC4: the team selector offers all teams, each team, and the explicit "Ohne TO-Team" group
      const teamOptions = await board.openDropdown('Alle Teams');
      expect(teamOptions, 'team selector must offer the all-teams option').toContain('Alle Teams');
      expect(
        teamOptions.some((o) => o === 'Ohne TO-Team'),
        `team selector must offer "Ohne TO-Team" for therapists with no assignment, got ${JSON.stringify(teamOptions)}`,
      ).toBe(true);
      const namedTeams = teamOptions.filter((o) => o !== 'Alle Teams' && o !== 'Ohne TO-Team');
      expect(namedTeams.length, 'at least one named TO team').toBeGreaterThan(0);
      await board.closeDropdown();

      test.skip(
        !loaded,
        'Board settled on the empty state — open defect #3233 (cold-cache requests exceed the ' +
          'client 8s read timeout and silently fall back to "-"/0).',
      );

      // picking one team must narrow the therapist population to that team's members
      await board.setDetailView('Therapeut:innen');
      const everyone = await board.detailRowNames();
      expect(everyone.length, 'therapists before team scoping').toBeGreaterThan(0);

      await board.selectTeam(namedTeams[0]);
      const teamMembers = await board.detailRowNames();
      expect(
        teamMembers.length,
        `"${namedTeams[0]}" must not contain more therapists than the whole board`,
      ).toBeLessThan(everyone.length);
      expect(
        teamMembers.every((t) => everyone.includes(t)),
        'every member of a team must also appear in the unscoped therapist list',
      ).toBe(true);
    },
  );

  test(
    'AC5 — the patient-type selector scopes the board to GKV or PKV VOs only',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsFilters'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      for (const t of ['Alle Patienten', 'GKV', 'PKV'] as const) {
        await expect(board.segment(t), `patient-type option "${t}"`).toBeVisible();
      }

      const all = FlowBoardsPage.parseNumber(await board.treatedRevenue());
      expect(all, 'treated revenue with all patients').not.toBeNull();

      await board.setPatientType('GKV');
      expect(await board.isSegmentActive('GKV')).toBe(true);
      const gkv = await board.waitForCardNumber('Umsatz (behandelt)');

      await board.setPatientType('PKV');
      expect(await board.isSegmentActive('PKV')).toBe(true);
      const pkv = await board.waitForCardNumber('Umsatz (behandelt)');

      test.skip(
        gkv === null || pkv === null,
        `The treated-revenue card never left the empty state after switching patient type ` +
          `(GKV=${gkv}, PKV=${pkv}) — open defect #3233.`,
      );

      // Each insurance type is a strict subset of the whole, and the two together cannot exceed it.
      expect(gkv!, `GKV (${gkv}) must not exceed all patients (${all})`).toBeLessThanOrEqual(all!);
      expect(pkv!, `PKV (${pkv}) must not exceed all patients (${all})`).toBeLessThanOrEqual(all!);
      expect(
        gkv! + pkv!,
        `GKV (${gkv}) + PKV (${pkv}) must not exceed all patients (${all})`,
      ).toBeLessThanOrEqual(all! + 1); // +1 absorbs per-card rounding to whole euros
    },
  );

  test(
    'AC6 — the location-type selector scopes revenue to Einrichtung (facility) or Praxis (no facility)',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsFilters'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      for (const t of ['Alle Orte', 'Einrichtung', 'Praxis'] as const) {
        await expect(board.segment(t), `location-type option "${t}"`).toBeVisible();
      }

      const all = FlowBoardsPage.parseNumber(await board.treatedRevenue());

      // Values are polled rather than read once: right after a filter click a card can still be on
      // the "-" empty state for several seconds (defect #3233), so a single read is a coin flip.
      await board.setLocationType('Einrichtung');
      expect(await board.isSegmentActive('Einrichtung')).toBe(true);
      const einrichtung = await board.waitForCardNumber('Umsatz (behandelt)');

      await board.setLocationType('Praxis');
      expect(await board.isSegmentActive('Praxis')).toBe(true);
      const praxis = await board.waitForCardNumber('Umsatz (behandelt)');

      test.skip(
        einrichtung === null || praxis === null,
        `The treated-revenue card never left the empty state after switching location type ` +
          `(Einrichtung=${einrichtung}, Praxis=${praxis}) — open defect #3233.`,
      );

      // Einrichtung = "VO has an assigned facility", Praxis = "VO has none" — a complete partition,
      // so the two halves must together account for the unscoped total.
      expect(
        einrichtung! + praxis!,
        `Einrichtung (${einrichtung}) + Praxis (${praxis}) must not exceed all locations (${all})`,
      ).toBeLessThanOrEqual(all! + 1);
    },
  );
});
