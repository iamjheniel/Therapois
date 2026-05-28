import { Page, expect } from '@playwright/test';

type IcdData = {
  code: string;
  description: string;
  diagnoseGruppenSchluessel?: string;
  diagnoseGruppenName?: string;
};

export class IcdManagementPage {
  constructor(private page: Page) {}

  async openIcdManagement() {
    await this.page.waitForLoadState('domcontentloaded');
    const navButton = this.page
      .locator('button')
      .filter({ hasText: /ICD-Code Verwaltung/ })
      .last();
    const found = await navButton
      .waitFor({ state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      await this.page.getByText('\uf451').first().click();
      await navButton.waitFor({ state: 'attached', timeout: 10_000 });
    }
    await navButton.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  }

  async openAddIcd() {
    await this.page
      .locator('div')
      .filter({ hasText: /ICD-Code hinzufügen/ })
      .last()
      .click();
  }

  async fillIcdForm(data: IcdData) {
    await this.page.getByPlaceholder('z.B. M54.4').fill(data.code);
    await this.page
      .getByPlaceholder('Geben Sie die Beschreibung ein')
      .fill(data.description);
    await this.page
      .getByPlaceholder('z.B. ZN')
      .fill(data.diagnoseGruppenSchluessel ?? 'QA');
    await this.page
      .getByPlaceholder('z.B. Erkrankungen des ZNS')
      .fill(data.diagnoseGruppenName ?? 'QA Automation Group');
    // Therapiebereich is a dropdown; open it and pick the first option (PT)
    await this.page.getByText('Wählen Sie einen Therapiebereich').click();
    await this.page
      .getByRole('dialog')
      .getByText(/PT \(physiotherapy\)/i)
      .click();
  }

  async save() {
    await this.page
      .getByRole('button', { name: /Speichern|Aktualisieren/ })
      .click();
  }

  async search(text: string) {
    const field = this.page.getByRole('textbox', { name: /Suche/i }).first();
    await field.fill(text);
    await field.press('Enter');
  }

  async openEditForRow(code: string) {
    // Each row's Aktion column has a clickable img. Walk up from the code cell.
    const cell = this.page.getByText(code, { exact: true }).first();
    const row = cell.locator(
      'xpath=ancestor::*[self::div][.//*[@role="img" or self::img]][1]'
    );
    await row.getByRole('img').last().click();
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
