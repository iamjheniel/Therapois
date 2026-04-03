import { Page, expect } from '@playwright/test';

type IcdData = {
  code: string;
  description: string;
};

export class IcdManagementPage {
  constructor(private page: Page) {}

  async openIcdManagement() {
    await this.page.getByText('').last().click();
    await this.page
      .locator('button')
      .filter({ hasText: /ICD-Code Verwaltung/ })
      .last()
      .click();
  }

  async openAddIcd() {
    await this.page
      .locator('div')
      .filter({ hasText: /ICD-Code hinzufügen/ })
      .last()
      .click();
  }

  async fillIcdForm(data: IcdData) {
    await this.page
      .getByRole('textbox', { name: /Code/i })
      .first()
      .fill(data.code);
    await this.page
      .getByRole('textbox', { name: /Beschreibung/i })
      .first()
      .fill(data.description);
  }

  async save() {
    await this.page.getByRole('button', { name: 'Speichern' }).click();
  }

  async search(text: string) {
    const field = this.page.getByRole('textbox', { name: /Suche/i }).first();
    await field.fill(text);
    await field.press('Enter');
  }

  async openEditForRow(code: string) {
    const row = this.page.locator('#root').filter({ hasText: code });
    await row.locator('svg').last().click();
  }

  async deleteIcd(code: string) {
    const row = this.page.locator('#root').filter({ hasText: code });
    await row.locator('svg').last().click();
    await this.page.getByRole('button', { name: /ICD-Code löschen/i }).click();
    await this.page
      .getByTestId('modal-surface')
      .getByRole('button', { name: 'Löschen' })
      .click();
  }

  async expectToast(text: string) {
    await expect(this.page.getByTestId('surface')).toContainText(text, {
      timeout: 15_000,
    });
  }

  async expectToastAndWaitToDisappear(text: string) {
    const toast = this.page
      .getByTestId('surface')
      .filter({ hasText: text })
      .first();
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await toast.waitFor({ state: 'hidden', timeout: 15_000 });
  }
}
