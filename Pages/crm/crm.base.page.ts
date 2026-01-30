import { Page, expect } from '@playwright/test';

export class CRMBasePage {
  constructor(protected page: Page) {}

  async openCRM() {
    await this.page.getByText('').click();
    await this.page.getByRole('button', { name: /CRM/ }).click();
  }

  async expectHeaderStats() {
    const root = this.page.locator('#root');

    await expect(root).toContainText(/Pending Bestellen/);
    await expect(root).toContainText(/Ausstehende Folge-VOs/);
    await expect(root).toContainText(/Aktive Probleme/);
  }
}
