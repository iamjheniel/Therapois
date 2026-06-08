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

  /* ---------- Practice Info ---------- */

  async openPracticeView() {
    // Click the "Anzeigen" (View) button in the first practice row to open the detail panel
    await this.page.getByText('Anzeigen', { exact: true }).first().click();
  }

  /**
   * Opens a practice that actually has initial orders (Bestellung) and leaves the detail
   * panel on the "Bestellung" tab. The first practice often has 0 initial orders
   * ("Showing 0 initial order"), so we apply the "Mit Problemen" filter and walk the rows
   * until one's Bestellung tab has selectable order rows (more than the header checkbox).
   * Re-navigates each iteration to keep row order stable.
   */
  async openPracticeViewWithOrders(maxTries = 6) {
    for (let i = 0; i < maxTries; i++) {
      await this.openCRM();
      await this.page.waitForTimeout(2500);
      await this.page.getByText('Mit Problemen').click().catch(() => {});
      await this.page.waitForTimeout(2500);
      const anzeigen = this.page.getByText('Anzeigen', { exact: true });
      if ((await anzeigen.count()) <= i) break;
      await anzeigen.nth(i).click();
      await this.page.waitForTimeout(2500);
      await this.page.getByText('Bestellung', { exact: true }).click({ force: true });
      await this.page.waitForTimeout(2500);
      if ((await this.page.getByRole('checkbox').count()) > 1) return;
    }
    throw new Error('CRM: no practice with initial orders found in the first ' + maxTries + ' rows');
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
    await this.page
      .locator('div')
      .filter({ hasText: /^$/ })
      .first()
      .click();
  }
}
