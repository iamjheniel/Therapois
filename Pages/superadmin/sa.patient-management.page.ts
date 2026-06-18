import { Page, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';

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
      await new AppPage(this.page).openSideMenu();
      await navButton.waitFor({ state: 'attached', timeout: 10_000 });
    }
    await navButton.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
    // Wait for the patient table to render at least one row
    await this.page
      .getByText(/^(Frau|Herrn|Herr) \S/)
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
  }

  /**
   * Reads the surname of the first patient row from the live list.
   * Patient names render as "Frau <First> <Last>" / "Herrn <First> <Last>".
   * Returns the last token (surname) which is a reliable, data-driven search term.
   */
  async firstPatientSurname(): Promise<string> {
    const name = await this.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('div'));
      const node = all.find(
        (d) =>
          /^(Frau|Herrn|Herr) \S+/.test((d.textContent || '').trim()) &&
          d.children.length === 0 &&
          // exclude doctor entries ("Herrn Dr. med. ...")
          !/Dr\.|med\./.test((d.textContent || '').trim())
      );
      return node ? (node.textContent || '').trim() : '';
    });
    // Strip the salutation, keep the last word (surname). Surnames can be
    // hyphenated (e.g. "Aagaard-Konopatzki") — take the first hyphen segment
    // so the search term is stable.
    const withoutSalutation = name.replace(/^(Frau|Herrn|Herr)\s+/, '');
    const lastWord = withoutSalutation.split(/\s+/).pop() || withoutSalutation;
    return lastWord.split('-')[0] || lastWord;
  }

  private searchField() {
    return this.page
      .getByRole('textbox', { name: /Suche nach Name|Suche|Search|Patient/i })
      .first();
  }

  async search(text: string) {
    const field = this.searchField();
    await field.fill(text);
    await field.press('Enter');
  }

  async clearSearch() {
    const field = this.searchField();
    await field.click();
    await field.press('ControlOrMeta+A');
    await field.press('Backspace');
    await field.press('Enter');
  }

  async openPatientDetail(name: string) {
    // Each row ends with a clickable view icon (no visible label).
    // Walk up from the name cell to the row, then click the action icon.
    const cell = this.page.getByText(new RegExp(`(Frau|Herrn|Herr) .*${name}`)).first();
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
