import { Page, expect } from '@playwright/test';
import { CRMBasePage } from './crm.base.page';
import { settleAfter, waitForStable } from '../util/settle';

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
    // v3.9 (#2932) split the single "Heute" tab into "Heute bestellen" (ordering) and
    // "Heute nachverfolgen" (follow-up/overdue). Exercise the follow-up view; fall back to
    // the legacy standalone "Heute" tab so this works on pre-3.9 environments too.
    const followUp = this.page.getByText(/^Heute nachverfolgen(\s*\(\d+\))?$/);
    const legacy = this.page.getByText(/^Heute(\s*\(\d+\))?$/);
    const tab = (await followUp.count()) > 0 ? followUp : legacy;
    await tab.first().click();
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
    // The first row being visible does not mean the list has finished arriving, and callers index
    // into it by position — so wait for the row set to stop changing rather than sleeping 1.2 s and
    // hoping that covered it. A list that has already finished costs ~450 ms here; one still
    // streaming gets up to the helper's budget, which the flat sleep could not give it.
    await waitForStable(anzeigen);
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
      // Both the panel open and the tab switch are server-driven, so settle on their requests
      // instead of charging 2.5 s each on every iteration of this retry loop.
      await settleAfter(this.page, () => anzeigen.nth(i).click(), { budgetMs: 12_000 });
      await settleAfter(
        this.page,
        () => this.page.getByText(tab, { exact: true }).click({ force: true }),
        { budgetMs: 12_000 },
      );

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
      // 400 ms, not 900: this loop needs two consecutive consistent reads before it can return, so
      // the interval is paid at least twice on the success path.
      await this.page.waitForTimeout(400);
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
      await this.page.waitForTimeout(400);
    }
    return false;
  }

  async clearFilters() {
    await this.page.getByText('Filter löschen').click();
  }

  async expectPracticeInfo() {
    const root = this.page.locator('#root');

    // v3.9 (#2937) translated the practice-detail panel to German. Section headers render
    // upper-cased via CSS text-transform, so match case-insensitively:
    //   "Contact Information" → "Kontaktinformationen" (Email/Fax block),
    //   "Opening Hours" → "Öffnungszeiten", "Doctors" → "Ärzte", plus the unchanged "Urlaubsplan".
    await expect(root).toContainText('Praxis-Infos');
    await expect(root).toContainText(/Kontaktinformationen|Fax/i);
    await expect(root).toContainText(/Öffnungszeiten/i);
    await expect(root).toContainText(/Ärzte/i);
    await expect(root).toContainText(/Urlaubsplan/i);
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
