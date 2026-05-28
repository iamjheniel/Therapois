import { Page, expect } from '@playwright/test';

export class PatientManagementPage {
  constructor(private page: Page) {}

  async openPatientManagement() {
    await this.page.waitForLoadState('domcontentloaded');
    const navButton = this.page
      .locator('button')
      .filter({ hasText: /Patient(en)? Management/ })
      .last();
    const found = await navButton
      .waitFor({ state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      await this.page.getByText('\uf451').first().click();
      await navButton.waitFor({ state: 'attached', timeout: 10_000 });
    }
    await navButton.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
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
    await field.click();
    await field.press('ControlOrMeta+A');
    await field.press('Backspace');
    await field.press('Enter');
  }

  async openPatientDetail(name: string) {
    // Each row ends with a clickable view icon (no visible label).
    // Walk up from the name cell to the row, then click the action icon.
    const cell = this.page.getByText(new RegExp(`Frau .*${name}|Herr .*${name}`)).first();
    const row = cell.locator('xpath=ancestor::*[self::div][.//*[@role="img"]][1]');
    await row.getByRole('img').last().click();
  }

  async expectPatientVisible(name: string) {
    await expect(this.page.locator('#root')).toContainText(name, {
      timeout: 15_000,
    });
  }

  async expectNoResults() {
    await expect(this.page.locator('#root')).toContainText(
      /Keine Patienten gefunden|Keine Ergebnisse|No results/i,
      { timeout: 15_000 }
    );
  }

  async expectToast(text: string) {
    await expect(this.page.getByTestId('surface')).toContainText(text, {
      timeout: 15_000,
    });
  }
}
