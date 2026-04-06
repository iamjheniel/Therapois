import { Page, expect } from '@playwright/test';

export class AbrechnungPage {
  constructor(private page: Page) {}

  async openAbrechnung() {
    await this.page.getByText('\uf451').click();
    await this.page
      .locator('button')
      .filter({ hasText: /Abrechnung/ })
      .last()
      .click();
  }

  // ── Tabs ──────────────────────────────────────────────
  async clickTab(name: 'All' | 'No Status' | 'For Fixing') {
    // Tabs are plain div elements (no role="tab"). "All" is labelled "Alle" in the UI.
    const tabText = name === 'All' ? 'Alle' : name;
    await this.page.getByText(tabText, { exact: true }).first().click();
  }

  // ── Filters ───────────────────────────────────────────
  async filterByVoStatus(status: string) {
    // VO Status has a single visible element so .first() works directly
    await this.page.getByText(/VO Status:/).first().click();
    await this.page.getByRole('dialog').getByText(status, { exact: true }).click();
  }

  async filterByTherapist(name: string) {
    // The app renders hidden zero-size duplicates; target the visible element
    await this.page.getByText(/Therapeut:/).filter({ visible: true }).first().click();
    await this.page.getByRole('dialog').getByText(name, { exact: true }).click();
  }

  async filterByEinrichtung(name: string) {
    await this.page.getByText(/ER:/).filter({ visible: true }).first().click();
    await this.page.getByRole('dialog').getByText(name, { exact: true }).click();
  }

  async resetFilters() {
    const reset = this.page.getByText(/Filter löschen|Reset/i).first();
    if (await reset.isVisible()) await reset.click();
  }

  // ── Row actions ───────────────────────────────────────
  async openValidationDetail(voNr: string) {
    const row = this.page.locator('#root').filter({ hasText: voNr });
    await row.getByText('Validate', { exact: true }).first().click();
  }

  async addNoteToRow(voNr: string, note: string) {
    const row = this.page.locator('#root').filter({ hasText: voNr });
    const noteField = row.getByText(/Click to add note/i).first();
    await noteField.click();
    await this.page.keyboard.type(note);
    await this.page.keyboard.press('Enter');
  }

  // ── Validation detail actions ─────────────────────────
  async markAsValidated() {
    await this.page
      .getByRole('button', { name: /Validated|Validiert/i })
      .first()
      .click();
  }

  async markAsForFixing() {
    await this.page
      .getByRole('button', { name: /For Fixing|Korrigieren/i })
      .first()
      .click();
  }

  async markAsUnableToValidate() {
    await this.page
      .getByRole('button', { name: /Unable to Validate|Nicht validierbar/i })
      .first()
      .click();
  }

  async confirmStatusChange() {
    const confirm = this.page
      .getByTestId('modal-surface')
      .getByRole('button', { name: /Bestätigen|Confirm|OK/i })
      .first();
    if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirm.click();
    }
  }

  // ── Assertions ────────────────────────────────────────
  async expectToast(text: string | RegExp) {
    await expect(this.page.getByTestId('surface')).toContainText(text, {
      timeout: 15_000,
    });
  }

  async expectTableVisible() {
    await expect(this.page.locator('#root')).toContainText(/VO Nr|Patient|Therapist/i, {
      timeout: 15_000,
    });
  }

  async expectTabActive(name: string) {
    await expect(this.page.locator('#root')).toContainText(
      new RegExp(name, 'i'),
      { timeout: 10_000 }
    );
  }

  async expectValidationStatusInRow(voNr: string, status: string) {
    const row = this.page.locator('#root').filter({ hasText: voNr });
    await expect(row).toContainText(status, { timeout: 10_000 });
  }
}
