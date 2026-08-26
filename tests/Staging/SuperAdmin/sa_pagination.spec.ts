import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * Pagination on the Super Admin board. Mirrors `admin_pagination`.
 *
 * The pager was redesigned: the range label reads "1–30 von 15.617" (was "1-10 of 13642"), and the
 * old first/prev/next/last icon buttons (`data-testid="icon-button-container"`) are gone — there are
 * now windowed page-number pressables plus "‹"/"›" arrows, alongside a "Zeilen pro Seite" selector.
 */
test.describe('Super Admin Pagination', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Pagination works correctly on Flow page', { tag: ['@SuperAdmin', '@pagination'] }, async ({ page }) => {
    const dash = new AdminDashboardPage(page);
    // Row-selection cells are plain divs now (no role=checkbox), so key off the table header.
    await page.getByText('VO #', { exact: true }).first().waitFor({ timeout: 30_000 });

    const range = dash.totalRange();
    await expect(range).toBeVisible();
    // Wait for real data (avoid capturing a transient "0 von 0").
    await expect(range).toHaveText(/von\s+[1-9]/, { timeout: 30_000 });

    const firstPageRange = (await range.textContent())?.trim() || '';
    expect(firstPageRange).toMatch(/^1\s*[–-]/);

    // ── next page
    await dash.nextPage();
    const secondPageRange = (await range.textContent())?.trim() || '';
    expect(secondPageRange).not.toBe(firstPageRange);

    // ── jump to a later page via its number, then back to page 1
    await dash.gotoPage(3);
    expect((await range.textContent())?.trim()).not.toBe(secondPageRange);

    await dash.gotoPage(1);
    await expect(range).toHaveText(/^1\s*[–-]/, { timeout: 15_000 });

    const backToFirst = ((await range.textContent()) || '').replace(/ /g, ' ').trim();
    const m = backToFirst.match(/^(\d+)\s*[–-]\s*(\d+)\s+von\s+([\d.,]+)$/);
    expect(m, `Unexpected pagination text: "${backToFirst}"`).not.toBeNull();

    const start = Number(m![1]);
    const end = Number(m![2]);
    const total = Number(m![3].replace(/[.,]/g, ''));

    expect(start).toBe(1);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(total);
  });
});
