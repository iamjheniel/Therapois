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
    await this.page.getByText('Heute', { exact: true }).click();
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
