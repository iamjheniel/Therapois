import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Flow Boards Shell (#3173) AC2, from the Therapist role.
 *
 * Same three-part assertion as the Admin spec (nav entry absent, page not reachable, data
 * endpoints blocked). Kept as its own spec because AC2 names therapist, admin and TO staff
 * separately, and because each role runs under its own Playwright project.
 */
test.describe('Flow Boards — Therapist has no access (#3173 AC2)', () => {
  test(
    'no Flow Boards navigation entry, page not reachable, and its data endpoints are blocked',
    { tag: ['@Therapist', '@FlowBoards', '@FlowBoardsAccess'] },
    async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      const app = new AppPage(page);
      await app.goto('/therapist');
      await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });

      await expect(page.getByText('Flow Boards', { exact: true })).toHaveCount(0);

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
        expect(text, `Therapist must not see Management-board content ("${marker}")`).not.toContain(
          marker,
        );
      }
      expect(await board.tab('Therapeuten-Orga').count(), 'board tab switcher').toBe(0);

      for (const [name, path] of Object.entries(FlowBoardsPage.API)) {
        if (name === 'export') continue; // POST-only, covered by #3181's own spec
        const res = await board.apiProbe('GET', `${path}?pagination=false`);
        expect(
          [401, 403],
          `GET ${path} as Therapist — expected 401/403, got ${res.status}: ${res.body}`,
        ).toContain(res.status);
      }
    },
  );
});
