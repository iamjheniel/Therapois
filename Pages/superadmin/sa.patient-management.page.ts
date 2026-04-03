import { Page, expect } from '@playwright/test';

export class PatientManagementPage {
  constructor(private page: Page) {}

  async openPatientManagement() {
    await this.page.getByText('').last().click();
    await this.page
      .locator('button')
      .filter({ hasText: /Patient Management/ })
      .last()
      .click();
  }

  async search(text: string) {
    const field = this.page
      .getByRole('textbox', { name: /Suche|Search|Patient/i })
      .first();
    await field.fill(text);
    await field.press('Enter');
  }

  async clearSearch() {
    const field = this.page
      .getByRole('textbox', { name: /Suche|Search|Patient/i })
      .first();
    await field.clear();
    await field.press('Enter');
  }

  async openPatientDetail(name: string) {
    const row = this.page.locator('#root').filter({ hasText: name });
    await row.getByText('Anzeigen', { exact: true }).first().click();
  }

  async expectPatientVisible(name: string) {
    await expect(this.page.locator('#root')).toContainText(name, {
      timeout: 15_000,
    });
  }

  async expectNoResults() {
    await expect(this.page.locator('#root')).toContainText(
      /Keine Ergebnisse|Kein Patient|No results/i,
      { timeout: 15_000 }
    );
  }

  async expectToast(text: string) {
    await expect(this.page.getByTestId('surface')).toContainText(text, {
      timeout: 15_000,
    });
  }
}
