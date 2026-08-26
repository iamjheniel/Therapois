import { Page, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';

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
    // Nested under the "Admin" sidebar submenu; AppPage.navTo expands it. Nav entries expose no
    // <button>/role=button in this build.
    await new AppPage(this.page).navTo(/ICD-Code Verwaltung/);
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

  /**
   * Asserts an ICD code is present in the list. This build renders NO success snackbar (the old
   * `getByTestId('surface')` toast is gone), so the persisted row is the only observable outcome.
   */
  async expectIcdInList(code: string) {
    await expect(this.page.locator('#root')).toContainText(code, { timeout: 15_000 });
  }

  /**
   * Formerly waited for a success snackbar to appear and clear before the next action. No toasts
   * exist in this build, so this is a settle-only pause.
   */
  async expectToastAndWaitToDisappear(_text: string) {
    await this.page.waitForTimeout(1500);
  }
}
