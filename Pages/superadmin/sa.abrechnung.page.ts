import { Page, expect } from '@playwright/test';

export class AbrechnungPage {
  constructor(private page: Page) {}

  async openAbrechnung() {
    await this.page.getByText('').last().click();
    await this.page
      .locator('button')
      .filter({ hasText: /Abrechnung/ })
      .last()
      .click();
  }

  // ── Tabs ──────────────────────────────────────────────
  async clickTab(name: 'All' | 'No Status' | 'For Fixing') {
    await this.page
      .getByRole('tab', { name: new RegExp(name, 'i') })
      .first()
      .click();

    // fallback: plain text match if tabs aren't role="tab"
    if (!(await this.page.getByRole('tab', { name: new RegExp(name, 'i') }).first().isVisible().catch(() => false))) {
      await this.page.getByText(new RegExp(name, 'i')).first().click();
    }
  }

  // ── Filters ───────────────────────────────────────────
  async filterByVoStatus(status: string) {
    await this.page
      .locator('div')
      .filter({ hasText: /^VO Status$|Auswählen/ })
      .first()
      .click();
    await this.page.getByText(status, { exact: true }).first().click();
  }

  async filterByTherapist(name: string) {
    await this.page
      .locator('div')
      .filter({ hasText: /^Therapeut|Therapist/ })
      .first()
      .click();
    await this.page.getByText(name, { exact: true }).first().click();
  }

  async filterByEinrichtung(name: string) {
    await this.page
      .locator('div')
      .filter({ hasText: /^ER$|Einrichtung/ })
      .first()
      .click();
    await this.page.getByText(name, { exact: true }).first().click();
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
  async expectToast(text: string) {
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
