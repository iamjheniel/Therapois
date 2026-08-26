import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Chart-Data Download, Management only (#3181, epic #3172).
 *
 * The allowlist is Kian and Dennis specifically — NOT every Super Admin. The QA Super Admin
 * (sa.jhen@gmail.com) is deliberately outside it, which makes this suite's account the right one to
 * prove AC2 with, and the wrong one to prove AC1/AC3/AC4 with.
 *
 * AC2 is the security-relevant half and is asserted in full, both halves the ticket demands:
 *   - the button is not rendered, and
 *   - the download request itself is refused server-side ("hiding the button alone is not
 *     sufficient"). Verified live: POST /kpis/management/export returns 403 Access Denied for this
 *     account, while the board's own five data endpoints return 200 — so the narrower gate is real
 *     and is not just the Super-Admin gate from #3173.
 */
test.describe('Flow Boards — chart-data download is Kian/Dennis only', () => {
  test(
    'AC2 — a Super Admin outside the allowlist sees no download button and is refused the file server-side',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDownload'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      // ── the button must not be rendered anywhere on the board
      expect(
        await board.exportControl().count(),
        'a Super Admin outside the Kian/Dennis allowlist must not see a download control',
      ).toBe(0);

      // ── and the request must be refused even if it is issued directly
      const refused = await board.apiProbe('POST', FlowBoardsPage.API.export, {
        from: '2026-08-03',
        to: '2026-08-09',
        level: 'woche',
      });
      expect(
        refused.status,
        `POST ${FlowBoardsPage.API.export} must be refused for a non-allowlisted Super Admin — ` +
          `hiding the button is not sufficient. Got ${refused.status}: ${refused.body}`,
      ).toBe(403);
      expect(
        refused.contentType ?? '',
        'the refusal must not hand back a CSV payload',
      ).not.toMatch(/text\/csv/);
      expect(refused.body, 'the refusal must not contain CSV rows').not.toMatch(/Umsatz|Effizienz/);

      // ── the narrower gate must be a real second check, not just the #3173 Super-Admin gate:
      // the same account's board data endpoints are allowed.
      const allowed = await board.apiProbe(
        'GET',
        `${FlowBoardsPage.API.management}?pagination=false`,
      );
      expect(
        allowed.status,
        `the same account must still be allowed the board data itself (GET ` +
          `${FlowBoardsPage.API.management}), otherwise the 403 above proves nothing about the ` +
          `download-specific allowlist`,
      ).toBe(200);
    },
  );

  test(
    'AC1/AC3/AC4 — Kian and Dennis can download the current KPI summary, previous period and trend series as CSV',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsDownload'] },
    async () => {
      test.skip(
        true,
        'AC1, AC3 and AC4 require an account on the download allowlist. The allowlist is Kian and ' +
          'Dennis specifically (the ticket makes it a configuration value, not a code constant), ' +
          'and this suite has no such staging credentials — the QA Super Admin is intentionally ' +
          'outside it, which is what the AC2 test above verifies. To enable this test: add a ' +
          'staging account to the export allowlist, generate an auth state for it in ' +
          'auth.setup.ts, and assert that (a) the download control is visible, (b) clicking it ' +
          'produces management-export.csv, and (c) the CSV contains the current period\'s live ' +
          'card values, the previous period\'s comparison values, and the per-team series for the ' +
          'metric selected on the trend chart, all under the filters currently applied.',
      );
    },
  );
});
