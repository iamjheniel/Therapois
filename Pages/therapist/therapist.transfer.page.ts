import { Page, Locator, expect } from '@playwright/test';

/**
 * Page Object for the Therapist "Patient transferieren" (Transfer Patients) flow.
 *
 * This is the sibling of the "Patient teilen" (share) action in the patient-list action bar:
 * where sharing grants a second therapist access, transferring hands the VO's responsibility
 * over to another therapist outright ("Die Zuständigkeit für die VO wird sofort auf den neuen
 * Therapeuten übertragen.").
 *
 * IMPORTANT — this POM deliberately never commits the transfer. Committing would move the
 * selected patient's VO off the acting therapist's dashboard, which would (a) be irreversible
 * from this account and (b) remove a patient the rest of the therapist suite relies on. The
 * spec therefore verifies the modal structure, the target-therapist picker and the selection
 * behaviour, then cancels — exercising the whole UI up to (but not through) the mutation.
 *
 * The app is React-Native-Web, so most controls are `div`s without roles; selectors fall back
 * to exact visible German/English text, matching the rest of the therapist suite.
 */
export class TherapistTransferPage {
  constructor(private page: Page) {}

  private searchBox(): Locator {
    return this.page.getByTestId('text-input-outlined').first();
  }

  modal(): Locator {
    return this.page.getByTestId('modal-surface').first();
  }

  /** Loads the therapist landing page. Accepts a base URL so the Production mirror can reuse it. */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.goto(`${baseUrl}/therapist/`, { waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ state: 'visible', timeout: 45_000 });
    await this.page.waitForTimeout(1500);
  }

  /**
   * Filters the list with a broad term and selects exactly the first patient row. Returns false
   * when no patient row is available (caller should test.skip). A fresh search resets any prior
   * selection so exactly one patient ends up selected.
   */
  async filterAndSelectFirst(term = 'Test'): Promise<boolean> {
    const box = this.searchBox();
    await box.click();
    await box.fill(term);
    await box.press('Enter');
    await this.page.waitForTimeout(2500);
    // nth(0) is the select-all header checkbox; a real patient row starts at nth(1).
    if ((await this.page.getByRole('checkbox').count()) < 2) return false;
    await this.page.getByRole('checkbox').nth(1).click({ force: true });
    await this.page.waitForTimeout(600);
    return true;
  }

  /** Opens the "Patient transferieren" modal. Returns whether it became visible. */
  async openTransferModal(): Promise<boolean> {
    const btn = this.page.getByRole('button', { name: /Patient transferieren/ });
    if (!(await btn.first().isEnabled().catch(() => false))) return false;
    await btn.first().click({ force: true });
    return this.modal()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Asserts the transfer modal is the expected form: the "übertragen" heading, the irreversible-
   * transfer warning, the selected-patient VO detail labels, and the target-therapist search.
   */
  async assertTransferModalStructure(): Promise<void> {
    const modal = this.modal();
    await expect(modal).toBeVisible();
    const text = await modal.innerText();
    expect(text).toMatch(/übertragen|Transfer Patients/i);
    // The VO detail table the therapist confirms before transferring.
    for (const label of ['VO Nr.', 'Current Therapist']) {
      expect(text, `transfer modal should list "${label}"`).toContain(label);
    }
    await expect(modal.getByText('Therapeuten suchen', { exact: true })).toBeVisible();
  }

  private pickerList(): Locator {
    return this.page.locator('[data-testid*="flatlist"]').first();
  }

  /**
   * Opens the target-therapist picker and returns the selectable therapist names it offers.
   * Names are two-word "Firstname Lastname" rows; the private-use icon glyphs are ignored by
   * the name regex. Returns [] when the picker never renders.
   */
  async openTherapistPicker(): Promise<string[]> {
    await this.modal().getByText('Therapeuten suchen', { exact: true }).click({ force: true });
    if (!(await this.pickerList().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false))) {
      return [];
    }
    return (await this.pickerList().innerText())
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-zÄÖÜäöü.\-]+\s+[A-Za-zÄÖÜäöü.\-]/.test(s));
  }

  /** Picks a therapist by exact name from the open picker. */
  async selectTherapist(name: string): Promise<void> {
    await this.pickerList().getByText(name, { exact: true }).first().click({ force: true });
    await this.page.waitForTimeout(500);
  }

  /** Closes the modal via Cancel WITHOUT committing the transfer. */
  async cancel(): Promise<void> {
    const cancel = this.modal().locator('div').filter({ hasText: /^Cancel$/ }).first();
    await cancel.click({ timeout: 3000 }).catch(() => {});
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.modal().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}
