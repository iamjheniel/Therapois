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
    await this.page.getByText('Heute + Übersicht').click();
    await expect(this.page.locator('#root')).toContainText(
      /[A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} (AM|PM)/
    );
  }

  async filterNoNextActivity() {
    await this.page.getByText('Keine nächste Aktivität').click();
    await expect(this.page.locator('#root')).toContainText('-');
  }

  async resetFilters() {
    await this.page.getByText('Alle', { exact: true }).click();
  }

  /* ---------- Search ---------- */

  async searchPractice(value: string) {
    const searchBox = this.page.getByRole('textbox', { name: 'Suchen' });
    await searchBox.fill(value);
    await searchBox.press('Enter');
  }

  /* ---------- Practice Info ---------- */

  async openPracticeView() {
   
    await this.page
      .locator('div:nth-child(4) > .css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi > div > div:nth-child(11) > .css-g5y9jx.r-1awozwy > .css-g5y9jx').click();

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
