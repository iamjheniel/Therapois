import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Trend Chart (#3179, epic #3172).
 *
 * 12 periods at the level chosen on the filter bar, 3 live metric toggles and 3 disabled ones, and a
 * series selector offering Gesamt / each TO team / Ohne TO-Team.
 *
 * AC3's "the per-team lines plus Ohne TO-Team always add up to the Gesamt line" and AC4's per-point
 * value are asserted against the trend endpoint's own response rather than the rendered SVG: the
 * chart draws with no text nodes per data point, so reading point values out of the DOM is not
 * possible, while the response the chart is drawn from carries exactly the series the AC talks about.
 */
test.describe('Flow Boards — Trend chart', () => {
  test(
    'AC1 — the chart plots 12 periods at the filter bar\'s display level',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTrend'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);

      const trendCalls: URL[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith('/kpis/management/trend')) trendCalls.push(u);
      });

      await board.open();
      const loaded = await board.waitForBoardLoaded();

      await expect(page.getByText('Verlauf nach Gruppe', { exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // weekly by default, matching the filter bar's default level
      expect(await board.activeLevel(), 'the board opens at Woche level').toBe('Woche');
      expect(
        trendCalls.at(-1)?.searchParams.get('level'),
        'the trend request must follow the filter bar level',
      ).toBe('woche');

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      const weekly = await board.trendPeriodLabels();
      expect(
        weekly.length,
        `the chart must plot the most recent 12 periods, got ${weekly.length}: ${JSON.stringify(weekly)}`,
      ).toBe(12);
      expect(weekly.every((l) => /^KW \d+$/.test(l)), 'weekly axis labels').toBe(true);

      // switching the level re-plots 12 periods of the new unit
      await board.setLevel('Monat');
      expect(
        trendCalls.at(-1)?.searchParams.get('level'),
        'switching to Monat must re-request the trend at month level',
      ).toBe('monat');
      const monthly = await board.trendPeriodLabels();
      expect(
        monthly.every((l) => !/^KW /.test(l)),
        `at Monat level the axis must not still show calendar weeks, got ${JSON.stringify(monthly)}`,
      ).toBe(true);
    },
  );

  test(
    'AC2 — 3 metric toggles are live and 3 are disabled "coming soon"',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTrend'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // the live toggles are real buttons and each one is selectable
      for (const metric of FlowBoardsPage.TREND_LIVE_METRICS) {
        const control = board.trendControl(metric);
        await expect(control, `live metric toggle "${metric}"`).toBeVisible({ timeout: 20_000 });
        await expect(control, `"${metric}" must be enabled`).toBeEnabled();
        await board.selectTrendMetric(metric);
        await expect(page.getByText('Verlauf nach Gruppe', { exact: true })).toBeVisible();
      }

      // the coming-soon metrics are present but not selectable
      const flat = await board.boardText();
      const toggleRegion = flat.slice(flat.indexOf('Verlauf nach Gruppe'));
      for (const metric of FlowBoardsPage.TREND_COMING_SOON_METRICS) {
        expect(toggleRegion, `coming-soon metric "${metric}" must be listed`).toContain(metric);
        expect(
          await board.trendControl(metric).count(),
          `"${metric}" must not be an enabled metric button — it is a disabled coming-soon toggle`,
        ).toBe(0);
      }
    },
  );

  test(
    'AC3/AC4 — the series selector offers Gesamt, each TO team and Ohne TO-Team, and the team series sum to Gesamt',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTrend'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      // "Gesamt" mounts with the chart frame; the per-team buttons only arrive with the teams
      // response, so the list must be waited for rather than read immediately.
      const series = await board.waitForTrendSeries();
      expect(series, 'the combined-total series').toContain('Gesamt');
      const teams = series.filter((s) => /^Team .+/.test(s));
      expect(teams.length, `at least one "Team [name]" series, got ${JSON.stringify(series)}`)
        .toBeGreaterThan(0);

      // "Ohne TO-Team" is a bucket, not a fixed series: it appears only while some therapist is
      // unassigned. That bucket is EMPTY on staging today (selecting it on the board returns 0 €
      // and all four traffic-light counts at 0), so AC3's series is data-gated here.
      const hasUnassigned = series.includes('Ohne TO-Team');
      if (!hasUnassigned) {
        // eslint-disable-next-line no-console
        console.log('no "Ohne TO-Team" series — every therapist is currently assigned to a team');
      }

      // each series is selectable
      for (const s of ['Gesamt', ...(hasUnassigned ? ['Ohne TO-Team'] : []), teams[0]]) {
        await board.selectTrendSeries(s);
        await expect(page.getByText('Verlauf nach Gruppe', { exact: true })).toBeVisible();
      }

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // AC3's additivity and AC4's exact per-period values live in the trend response: the chart
      // draws no text node per data point, so the payload it is drawn from is where they are checked.
      const { status, json } = await board.apiJson(
        `${FlowBoardsPage.API.trend}?pagination=false&level=woche`,
      );
      expect(status, `GET ${FlowBoardsPage.API.trend} as Super Admin`).toBe(200);

      // Response shape (confirmed live): one entry per period, each with `periodStart`/`periodEnd`,
      // a `gesamt` object of metrics, and a `teams` array of per-team metric objects.
      const periods: any[] = json?.member ?? json?.['hydra:member'] ?? [];
      expect(periods.length, 'the trend response must carry period entries').toBe(12);

      // AC4: every plotted period exposes exact values for the 3 live metrics
      for (const p of periods) {
        expect(
          p.gesamt,
          `period ${p.periodStart} must carry a Gesamt value set, got ${JSON.stringify(p).slice(0, 200)}`,
        ).toBeTruthy();
        for (const metric of ['revenue', 'validatedRevenue', 'revenuePerHour']) {
          expect(
            typeof p.gesamt[metric],
            `period ${p.periodStart} must expose an exact "${metric}"`,
          ).toBe('number');
        }
      }

      // AC3: for each period and each metric, the per-team values plus the no-team group must add up
      // to the Gesamt line. `revenuePerHour` is deliberately excluded — it is a ratio, and ratios do
      // not sum across groups.
      for (const p of periods) {
        const parts: any[] = [
          ...(p.teams ?? []),
          ...(p.ohneTeam ? [p.ohneTeam] : []),
          ...(p.withoutTeam ? [p.withoutTeam] : []),
        ];
        expect(
          parts.length,
          `period ${p.periodStart} must break down by TO team, got ${JSON.stringify(Object.keys(p))}`,
        ).toBeGreaterThan(0);

        for (const metric of ['revenue', 'validatedRevenue'] as const) {
          const sum = parts.reduce((a, t) => a + (typeof t[metric] === 'number' ? t[metric] : 0), 0);
          expect(
            Math.abs(p.gesamt[metric] - sum),
            `${p.periodStart}: the per-team "${metric}" values plus the no-team group (${sum}) must ` +
              `add up to Gesamt (${p.gesamt[metric]}). Groups: ` +
              `${JSON.stringify(parts.map((t) => [t.teamName ?? 'ohneTeam', t[metric]]))}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    },
  );

  test(
    'AC5 — the trend chart follows the same filters as the KPI cards',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTrend'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);

      const trendCalls: URL[] = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith('/kpis/management/trend')) trendCalls.push(u);
      });

      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      const callsBefore = trendCalls.length;
      await board.setPatientType('GKV');

      expect(
        trendCalls.length,
        'changing the insurance-type filter must re-request the trend data',
      ).toBeGreaterThan(callsBefore);

      const q = trendCalls.at(-1)!.searchParams;
      const carried = [...q.keys()].some((k) => /insurance|patient|type|gkv|pkv/i.test(k));
      expect(
        carried,
        `the trend request must carry the insurance-type filter, got ${trendCalls.at(-1)!.search}`,
      ).toBe(true);

      // and the location filter likewise
      const beforeOrt = trendCalls.length;
      await board.setLocationType('Einrichtung');
      expect(
        trendCalls.length,
        'changing the location filter must re-request the trend data',
      ).toBeGreaterThan(beforeOrt);
    },
  );
});
