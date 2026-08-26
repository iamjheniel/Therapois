import { Page, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';

export class AbrechnungPage {
  constructor(private page: Page) {}

  async openAbrechnung() {
    await this.page.waitForLoadState('domcontentloaded');
    // "Abrechnung" is nested under the "Admin" sidebar submenu; AppPage.navTo expands it. The app
    // exposes no <button>/role=button for nav entries, so don't try to locate one here.
    await new AppPage(this.page).navTo(/Abrechnung/);
  }

  // ── Tabs ──────────────────────────────────────────────
  /**
   * The status tabs were translated in v3.11.0 — they read "Alle" / "Kein Status" /
   * "Zur Korrektur" (plus a fourth, "Alle inkl. Geschlossene"). Callers still name them in
   * English, so the mapping lives here rather than in every spec.
   */
  static readonly TAB_LABELS = {
    All: 'Alle',
    'No Status': 'Kein Status',
    'For Fixing': 'Zur Korrektur',
  } as const;

  /** A status tab, matched tolerantly: the label renders with its count appended, e.g. "Alle(4428)". */
  tab(name: 'All' | 'No Status' | 'For Fixing') {
    const label = AbrechnungPage.TAB_LABELS[name];
    // "Alle" is a prefix of "Alle inkl. Geschlossene", so anchor on an optional "(N)" and nothing else.
    return this.page
      .getByText(new RegExp(`^${label}\\s*(\\(\\d[\\d.,]*\\))?$`))
      .filter({ visible: true })
      .first();
  }

  async clickTab(name: 'All' | 'No Status' | 'For Fixing') {
    // Tabs are plain div elements (no role="tab").
    await this.tab(name).click({ timeout: 30_000 });
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
      .getByRole('button', { name: /For Fixing|Korrigieren|Zur Korrektur/i })
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

  async expectTabActive(name: 'All' | 'No Status' | 'For Fixing' | string) {
    const label =
      (AbrechnungPage.TAB_LABELS as Record<string, string>)[name] ?? name;
    await expect(this.page.locator('#root')).toContainText(
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      { timeout: 10_000 }
    );
  }

  async expectValidationStatusInRow(voNr: string, status: string) {
    const row = this.page.locator('#root').filter({ hasText: voNr });
    await expect(row).toContainText(status, { timeout: 10_000 });
  }
}
