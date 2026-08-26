import { test, expect } from '@playwright/test';
import { AdminDashboardPage } from '../../../Pages/admin/admin.dashboard.page';

/**
 * Pagination on the Admin Board.
 *
 * The pager reads "Zeilen pro Seite [30 ▾]   1–30 von 7.432   ‹ 1 2 3 4 5 ›". The old
 * first/prev/next/last icon buttons (`data-testid="icon-button-container"`) are long gone: the page
 * numbers and the "‹"/"›" arrows are plain `div[tabindex="0"]` pressables, while the page-size
 * selector beside them is a real button carrying its size in its `aria-label`
 * ("Zeilen pro Seite: 30").
 */
test.describe('Admin Pagination', () => {
  test('Pagination works correctly on Flow page', { tag: ['@Admin', '@pagination'] }, async ({ page }) => {
    test.setTimeout(180_000);
    const dash = new AdminDashboardPage(page);
    // The page size is a sticky preference; start from the shipped 30 so the ranges are predictable.
    await dash.open({ resetPreferences: true });

    const range = dash.totalRange();
    await expect(range).toBeVisible();
    // Wait for real data (avoid capturing a transient "0 von 0").
    await expect(range).toHaveText(/von\s+[1-9]/, { timeout: 30_000 });

    const firstPageRange = (await range.textContent())?.trim() || '';
    expect(firstPageRange).toMatch(/^1\s*[–-]/);

    // ── next page
    await dash.nextPage();
    const secondPageRange = (await range.textContent())?.trim() || '';
    expect(secondPageRange, 'the "›" arrow must advance a page').not.toBe(firstPageRange);

    // ── and back again
    await dash.prevPage();
    await expect(range, 'the "‹" arrow must step back').toHaveText(/^1\s*[–-]/, { timeout: 15_000 });

    // ── jump to a later page via its number, then back to page 1
    await dash.gotoPage(3);
    const thirdPageRange = (await range.textContent())?.trim() || '';
    expect(thirdPageRange).not.toBe(secondPageRange);
    expect(thirdPageRange).not.toBe(firstPageRange);

    await dash.gotoPage(1);
    await expect(range).toHaveText(/^1\s*[–-]/, { timeout: 15_000 });

    const backToFirst = ((await range.textContent()) || '').replace(/ /g, ' ').trim();
    const m = backToFirst.match(/^(\d+)\s*[–-]\s*(\d+)\s+von\s+([\d.,]+)$/);
    expect(m, `Unexpected pagination text: "${backToFirst}"`).not.toBeNull();

    const start = Number(m![1]);
    const end = Number(m![2]);
    const total = Number(m![3].replace(/[.,]/g, ''));

    expect(start).toBe(1);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(total);
    expect(end, 'a full first page holds one page-size worth of rows').toBe(await dash.rowsPerPage());
    expect(await dash.renderedRowCount(), 'and the table paints exactly that many rows').toBe(end);
  });
});
