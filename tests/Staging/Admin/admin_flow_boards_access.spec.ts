import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Flow Boards Shell (#3173) AC2, from the Admin role.
 *
 * "the Flow Boards entry is not shown, the page itself is not reachable, and any attempt to load
 * its data directly is blocked with an authorization error."
 *
 * All three halves are asserted, including the API one: the ticket explicitly calls out that the
 * frontend route gate is not sufficient because the API is a separate trust boundary, and the
 * existing /kpis route is only ROLE_USER-gated. The probe runs inside the page so it carries the
 * Admin's own bearer token (the API host authenticates with `Authorization: Bearer`, not a cookie —
 * an unauthenticated request would return 401 for the wrong reason).
 */
test.describe('Flow Boards — Admin has no access (#3173 AC2)', () => {
  test(
    'no Flow Boards navigation entry, page not reachable, and its data endpoints are blocked',
    { tag: ['@Admin', '@FlowBoards', '@FlowBoardsAccess'] },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      const app = new AppPage(page);
      await app.goto('/dashboard');
      await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });

      // ── navigation: the entry must not exist anywhere, including inside submenus.
      // An Admin may not have the Management menu at all, so this is guarded: `actionTimeout` is
      // disabled repo-wide, so an unguarded click on a missing element waits out the whole test.
      const mgmtMenu = page.getByRole('button', { name: /Management/ }).first();
      if (await mgmtMenu.isVisible({ timeout: 5000 }).catch(() => false)) {
        await mgmtMenu.click({ force: true, timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(2500);
      }
      await expect(page.getByText('Flow Boards', { exact: true })).toHaveCount(0);

      // ── direct navigation must not render the board
      await app.goto(FlowBoardsPage.URL);
      await page.waitForTimeout(8000);
      const board = new FlowBoardsPage(page);
      const text = await board.boardText();
      for (const marker of [
        'Umsatz (behandelt)',
        'Umsatz validiert',
        'Abrechnungs-Stau',
        'Umsatz-Realisierung',
        'Verlauf nach Gruppe',
      ]) {
        expect(text, `Admin must not see Management-board content ("${marker}")`).not.toContain(
          marker,
        );
      }
      expect(await board.tab('Therapeuten-Orga').count(), 'board tab switcher').toBe(0);

      // ── the API is the real trust boundary: every Flow Boards endpoint must refuse this token
      for (const [name, path] of Object.entries(FlowBoardsPage.API)) {
        if (name === 'export') continue; // POST-only, and covered by #3181's own spec
        const res = await board.apiProbe('GET', `${path}?pagination=false`);
        expect(
          res.status,
          `GET ${path} as Admin must be an authorization error, got ${res.status}: ${res.body}`,
        ).toBeGreaterThanOrEqual(400);
        expect([401, 403], `GET ${path} as Admin — expected 401/403, got ${res.status}`).toContain(
          res.status,
        );
      }
    },
  );
});
