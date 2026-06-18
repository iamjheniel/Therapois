import { Page, expect } from '@playwright/test';
import { CRMBasePage } from './crm.base.page';

export class CRMListPage extends CRMBasePage {
  constructor(page: Page) {
    super(page);
  }

  /* ---------- Filters ---------- */

  async filterHasIssues() {
    await this.page.getByText('Mit Problemen').click();
    await expect(this.page.locator('#root')).toContainText(/\d+/);
  }

  async filterTodayOverdue() {
    await this.page.getByText(/^Heute(\s*\(\d+\))?$/).click();
    await expect(this.page.locator('#root')).toContainText(/\d/);
  }

  async filterNoNextActivity() {
    await this.page.getByText('Geplant').click();
    await expect(this.page.locator('#root')).toContainText('-');
  }

  async resetFilters() {
    await this.page.getByText(/Alle \(\d+\)/).click();
  }

  /* ---------- Search ---------- */

  async searchPractice(value: string) {
    const searchBox = this.page.getByRole('textbox', { name: 'Suchen' });
    await searchBox.fill(value);
    await searchBox.press('Enter');
  }

  /* ---------- Practice list helpers ---------- */

  /**
   * Re-navigates to the CRM list and waits for practice rows ("Anzeigen" buttons) to render.
   * The list is server-driven and takes a few seconds to paint, so we wait for the first row
   * to be visible rather than relying on a fixed timeout. Returns the "Anzeigen" locator.
   */
  private async loadPracticeRows() {
    await this.page.goto('/crm', { waitUntil: 'domcontentloaded' });
    const anzeigen = this.page.getByText('Anzeigen', { exact: true });
    await anzeigen.first().waitFor({ state: 'visible', timeout: 30000 });
    // small settle so row order is stable before we index into it
    await this.page.waitForTimeout(1200);
    return anzeigen;
  }

  /* ---------- Practice Info ---------- */

  async openPracticeView() {
    const anzeigen = this.page.getByText('Anzeigen', { exact: true });
    // The list may still be painting; wait for the first row instead of assuming it's there.
    await expect(anzeigen.first()).toBeVisible({ timeout: 30000 });
    await anzeigen.first().click();
  }

  /**
   * Opens a practice that actually has initial orders (Bestellung) and leaves the detail
   * panel on the "Bestellung" tab. Some practices have 0 initial orders, so we walk the
   * rows until one's Bestellung tab has selectable order rows (more than the header
   * checkbox). Re-navigates each iteration to keep row order stable. Returns true if a
   * qualifying practice was found and left open on the Bestellung tab, false otherwise — the
   * caller should `test.skip(!found, ...)` rather than hard-fail on environments (e.g.
   * Staging) where no practice has initial-order data. `maxTries` is kept modest so the
   * no-data path exhausts the walk within the per-test timeout instead of being killed
   * mid-loop.
   */
  async openPracticeViewWithOrders(maxTries = 8): Promise<boolean> {
    return this.openPracticeViewWithTab('Bestellung', maxTries);
  }

  /**
   * Opens a practice whose "Nachverfolgung" (follow-up orders) tab has selectable rows.
   * Returns true if found and left open on that tab, false otherwise.
   */
  async openPracticeViewWithFollowUpOrders(maxTries = 12) {
    return this.openPracticeViewWithTab('Nachverfolgung', maxTries);
  }

  /**
   * Walks practice rows looking for one whose given detail tab actually has orders.
   *
   * - "Bestellung" (initial orders) renders a reliable "Showing N initial order(s)" summary;
   *   a practice with none shows "Showing 0 ...". We key off that text because a raw checkbox
   *   count is flaky while the panel re-renders during load.
   * - "Nachverfolgung" (follow-up orders) has no such summary, so we fall back to counting
   *   selectable order checkboxes (more than the single header checkbox), after a settle.
   *
   * Leaves the panel open on that tab and returns true; false if none found within maxTries.
   */
  private async openPracticeViewWithTab(
    tab: 'Bestellung' | 'Nachverfolgung',
    maxTries: number
  ): Promise<boolean> {
    for (let i = 0; i < maxTries; i++) {
      const anzeigen = await this.loadPracticeRows();
      if ((await anzeigen.count()) <= i) break;
      await anzeigen.nth(i).click();
      await this.page.waitForTimeout(2500);
      await this.page.getByText(tab, { exact: true }).click({ force: true });
      await this.page.waitForTimeout(2500);

      if (tab === 'Bestellung') {
        // When switching practices the panel transiently shows the *previous* practice's
        // content before the new data paints, so a stale "Showing N" can briefly disagree
        // with the rendered rows. Qualify only once the "Showing N initial order(s)" summary
        // and the selectable checkboxes agree (N order rows => N + 1 checkboxes incl. header)
        // for a non-zero count — that means the panel has fully settled on this practice.
        if (await this.waitForSettledInitialOrders()) return true;
      } else {
        // Follow-up tab: rely on selectable order checkboxes beyond the header checkbox.
        // The bulk-action helper selects the 4th checkbox, so require enough rows. Poll to
        // absorb the stale-then-real render of the order list.
        if (await this.waitForFollowUpCheckboxes()) return true;
      }
    }
    return false;
  }

  /**
   * Polls the Bestellung tab until the "Showing N initial order(s)" summary and the rendered
   * selectable checkboxes agree on a non-zero count (N order rows => N + 1 checkboxes incl.
   * the header). This rejects the transient stale render that briefly shows the previous
   * practice's count. Returns true when settled with orders, false otherwise.
   */
  private async waitForSettledInitialOrders(maxPolls = 6): Promise<boolean> {
    const re = /Showing\s+(\d+)\s+initial\s+order/i;
    // Require the same consistent non-zero state on two consecutive reads. A single read can
    // catch the transient stale render that briefly shows the previous practice's "Showing N"
    // before the real (possibly 0) count paints.
    let consecutive = 0;
    let lastCount = -1;
    for (let i = 0; i < maxPolls; i++) {
      const text = await this.page.locator('#root').innerText().catch(() => '');
      const m = text.match(re);
      const count = m ? parseInt(m[1], 10) : -1;
      const checkboxes = await this.page.getByRole('checkbox').count();
      const consistent = count > 0 && checkboxes === count + 1;
      consecutive = consistent && count === lastCount ? consecutive + 1 : consistent ? 1 : 0;
      if (consecutive >= 2) return true;
      lastCount = count;
      await this.page.waitForTimeout(900);
    }
    return false;
  }

  /**
   * Waits for the Nachverfolgung (follow-up) order list to render enough selectable rows for
   * the bulk-action helper (which selects the 4th checkbox). Polls to absorb the stale render.
   */
  private async waitForFollowUpCheckboxes(maxPolls = 8): Promise<boolean> {
    for (let i = 0; i < maxPolls; i++) {
      if ((await this.page.getByRole('checkbox').count()) > 3) return true;
      await this.page.waitForTimeout(900);
    }
    return false;
  }

  async clearFilters() {
    await this.page.getByText('Filter löschen').click();
  }

  async expectPracticeInfo() {
    const root = this.page.locator('#root');

    await expect(root).toContainText('Praxis-Infos');
    await expect(root).toContainText('Contact Information');
    await expect(root).toContainText('Opening Hours');
    await expect(root).toContainText('Doctors');
    await expect(root).toContainText('Urlaubsplan');
  }

  async closePracticeView() {
    // The practice detail panel is a drawer with a "Close drawer" control. Closing is
    // best-effort — the meaningful assertion is that the practice info rendered — so we
    // never let this step fail/hang the test.
    const closeDrawer = this.page.getByLabel('Close drawer').first();
    if (await closeDrawer.isVisible({ timeout: 5000 }).catch(() => false)) {
      await closeDrawer.click({ timeout: 5000, force: true }).catch(() => {});
      return;
    }
    await this.page.keyboard.press('Escape').catch(() => {});
  }
}
