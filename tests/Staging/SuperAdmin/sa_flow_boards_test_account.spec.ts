import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Test-Account Exclusion Flag (#3182, epic #3172).
 *
 * A Super Admin can mark a user account as a test account, and marked accounts drop out of every
 * figure on the Management board — while the old KPI Dashboard and TO Management pages keep counting
 * them exactly as before.
 *
 * Deliberate scope limit: this spec opens the Testkonto control and verifies it, but never SAVES it.
 * Two reasons, both concrete:
 *  - The only accounts the ticket names (Sandra Zeibig, Marika Kammerer) are live test accounts, and
 *    Sandra Zeibig is this suite's Staging therapist login.
 *  - "Nutzer bearbeiten" has an open defect where saving re-sends active=false regardless of the
 *    stored state (see tests/Staging/SuperAdmin/sa_team.spec.ts @inactivateuser, which is fixme'd for
 *    it). Saving this form to flip a flag would risk deactivating the therapist account the
 *    SandraZeibig project depends on.
 * So the exclusion ACs (3–5) are asserted against whichever accounts are ALREADY marked, and skip
 * with a pointer to the go-live prerequisite when none are.
 */
test.describe('Flow Boards — Testkonto exclusion flag', () => {
  test.describe.configure({ mode: 'serial' }); // shares the /team edit panel

  /** Opens the "Nutzer bearbeiten" panel for a user row identified by e-mail. */
  async function openUserEdit(page: any, email: string): Promise<boolean> {
    return await page.evaluate((wanted: string) => {
      const leaf = [...document.querySelectorAll('div')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === wanted,
      );
      if (!leaf) return false;
      const box = leaf.getBoundingClientRect();
      const y = box.top + box.height / 2;
      // The Aktion control is a div[tabindex="0"] wrapping an <svg>, far to the right of the row —
      // matched by row geometry, exactly as sa_team.spec.ts does (climbing the DOM resolves to the
      // whole table and silently edits the last row instead).
      const controls = [...document.querySelectorAll('div[tabindex="0"]')]
        .filter((el) => el.querySelector('svg'))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && Math.abs(r.top + r.height / 2 - y) < 20)
        .sort((a, b) => a.r.left - b.r.left);
      if (!controls.length) return false;
      (controls[controls.length - 1].el as HTMLElement).click();
      return true;
    }, email);
  }

  test(
    'AC1 — the user edit form offers a "Testkonto" checkbox that is off for a normal account',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTestAccount'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      await new AppPage(page).goto('/team');
      await expect(page.getByText('Benutzer verwalten', { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // The search box goes readonly after Enter (same quirk as the Admin dashboard's Suchen box),
      // so it is filled once per page load and never re-used.
      await page.getByRole('textbox', { name: 'Benutzer suchen' }).fill('Zeibig');
      await page.getByRole('textbox', { name: 'Benutzer suchen' }).press('Enter');
      await expect(page.getByText('Sandra Zeibig', { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });

      const email = ((await page.getByText(/sandra\.zeibig[^\s]*@/).first().textContent()) || '').trim();
      expect(await openUserEdit(page, email), `edit panel for ${email}`).toBe(true);
      await expect(page.getByText('Nutzer bearbeiten', { exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // AC1: the control exists, alongside the existing Status checkbox
      await expect(page.getByText('Testkonto', { exact: true })).toBeVisible();
      expect(
        await page.getByRole('checkbox').count(),
        'the panel has a Status checkbox and the new Testkonto checkbox',
      ).toBe(2);

      // AC1: unchecked by default — the panel renders the state as an adjacent "Nein"/"Ja" label
      const panel = await page.locator('#root').innerText();
      const state = panel.slice(panel.indexOf('Testkonto')).split('\n').filter(Boolean)[2]?.trim();
      expect(
        state,
        `an account that has not been marked must show Testkonto off, got "${state}"`,
      ).toBe('Nein');

      // Never saved: leave via Abbrechen so no user record is touched (see the class note above).
      await page.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(page.getByText('Nutzer bearbeiten', { exact: true })).toBeHidden({
        timeout: 20_000,
      });
    },
  );

  test(
    'AC3/AC4 — accounts already marked as test accounts are absent from every Management-board figure',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTestAccount'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // The go-live prerequisite is to mark Sandra Zeibig and Marika Kammerer after deploy. Until
      // that is done there is no marked account to observe an exclusion against.
      const therapistOptions = await board.openDropdown('Alle Therapeut:innen');
      await board.closeDropdown();
      const knownTestAccounts = ['Sandra Zeibig', 'Marika Kammerer'];
      const stillListed = knownTestAccounts.filter((n) =>
        therapistOptions.some((o) => o.startsWith(n)),
      );

      // Gated on ALL known test accounts being absent, not just one. An account missing from the
      // selector is ambiguous on its own — the selector only lists therapists the board has data
      // for, so absence can mean "marked as a Testkonto" or simply "no activity". Requiring both to
      // be gone makes the marked state the only plausible explanation.
      test.skip(
        stillListed.length > 0,
        `Not every known test account is marked as a Testkonto on staging yet — ` +
          `${JSON.stringify(stillListed)} still appear in the therapist selector. This is the ` +
          `ticket's go-live prerequisite ("After deploy, mark Sandra Zeibig and Marika Kammerer as ` +
          `test accounts"), not a product defect. Once both are marked, this test asserts their ` +
          `absence from every board figure.`,
      );

      const excluded = knownTestAccounts;

      // AC4: gone from the therapist selector
      for (const name of excluded) {
        expect(
          therapistOptions.some((o) => o.startsWith(name)),
          `"${name}" is marked as a test account, so it must not appear in the therapist selector`,
        ).toBe(false);
      }

      // AC3: gone from the detail table in both views, and from the backlog drill-down
      for (const view of ['Therapeut:innen', 'Gruppen'] as const) {
        await board.setDetailView(view);
        const rows = await board.detailRowNames();
        for (const name of excluded) {
          expect(
            rows.some((r) => r.includes(name)),
            `"${name}" must not appear in the ${view} detail view`,
          ).toBe(false);
        }
      }

      if ((await board.backlogBanner().count()) > 0) {
        await board.openBacklogDrilldown();
        const drilldown = await board.boardText();
        for (const name of excluded) {
          expect(
            drilldown,
            `"${name}" must not appear in the billing-backlog drill-down`,
          ).not.toContain(name);
        }
      }
    },
  );

  test(
    'AC5 — marking a test account leaves the existing KPI Dashboard and TO Management untouched',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsTestAccount'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      const app = new AppPage(page);

      // The old pages must keep working and keep counting everyone. Without a marked account the
      // delta cannot be measured, so what is asserted here is the invariant the ticket protects:
      // both legacy pages still render their own numbers, independent of the new flag.
      await app.goto('/kpi');
      await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(8000);
      const kpi = await page.locator('#root').innerText();
      expect(
        kpi.length,
        'the existing KPI Dashboard must still render (it runs in parallel with the new board)',
      ).toBeGreaterThan(200);

      await app.goto('/to-management');
      await expect(page.getByText('TO Verwaltung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(8000);
      const to = await page.locator('#root').innerText();
      expect(
        to,
        'TO Management must still render its therapist table unchanged by the Testkonto flag',
      ).toMatch(/Therapeut/);

      // The "old pages still count a marked account" half of AC5 needs an account that is provably
      // marked. Absence from the Flow Boards therapist selector does NOT prove that — the selector
      // only lists therapists the board has data for, so an inactive or idle therapist is missing for
      // an entirely different reason. Gated on both known test accounts being absent, which is what
      // the go-live prerequisite produces.
      const knownTestAccounts = ['Sandra Zeibig', 'Marika Kammerer'];
      const boardPage = new FlowBoardsPage(page);
      await boardPage.open();
      const options = await boardPage.openDropdown('Alle Therapeut:innen');
      await boardPage.closeDropdown();
      const stillListed = knownTestAccounts.filter((n) => options.some((o) => o.startsWith(n)));

      test.skip(
        stillListed.length > 0,
        `Not every known test account is marked as a Testkonto on staging yet ` +
          `(${JSON.stringify(stillListed)} still appear in the Flow Boards therapist selector), so ` +
          `the "old pages still count them" half of AC5 has no provably-marked account to measure ` +
          `against. See the go-live prerequisite on #3182. The half that IS asserted above — both ` +
          `legacy pages still render and are not broken by the new flag — always runs.`,
      );

      // For an account excluded from the new board, the legacy TO Management page must still count it.
      // Read from the health counts rather than the paginated table: the table shows 10 of ~161 rows,
      // so "the name is not on screen" says nothing about whether the page counts that therapist.
      await app.goto('/to-management');
      await expect(page.getByText('TO Verwaltung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(10_000);
      const toTotal = (await page.locator('#root').innerText()).match(/\d+\s*-\s*\d+\s+of\s+(\d+)/);
      expect(toTotal, 'TO Management must report its therapist total').not.toBeNull();

      const flatRows = await boardPage.detailRowNames();
      expect(
        Number(toTotal![1]),
        `TO Management must be unaffected by the Testkonto flag (AC5): it counts ` +
          `${toTotal![1]} therapists, which must still include the accounts the Management board ` +
          `now excludes (the board lists ${flatRows.length})`,
      ).toBeGreaterThan(flatRows.length);
    },
  );
});
