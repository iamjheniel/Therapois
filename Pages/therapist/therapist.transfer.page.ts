import { Page, Locator, expect } from '@playwright/test';
import { boardSearchBox } from '../base/app.page';

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
    return boardSearchBox(this.page);
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
  /** The table headers the confirmation lists, in their `textContent` (not rendered) casing. */
  static readonly CONFIRMATION_COLUMNS = ['Patient', 'VO Nr.', 'Einrichtung', 'Arzt'] as const;

  /**
   * Asserts the confirmation the therapist sees before committing an irreversible transfer.
   *
   * The modal is fully German now — "Patienten übertragen" over "N Einträge ausgewählt", an
   * immediacy warning, an "Ausgewählte Patient/en - VO/s *" table, then "Übertragen zu Therapeut *"
   * with a "Therapeuten suchen" picker and Abbrechen / Übertragen.
   *
   * Two traps: the table headers are CSS-uppercased, so they arrive as "VO NR." in `innerText` while
   * `textContent` — what Playwright matches — stays "VO Nr."; and the rows arrive asynchronously
   * behind a "Wird geladen …" placeholder, so the table has to be waited for rather than read.
   */
  async assertTransferModalStructure(): Promise<void> {
    const modal = this.modal();
    await expect(modal).toBeVisible();
    await expect(modal, 'the modal must name the action').toContainText(/übertragen|Transfer Patients/i);

    // The rows load asynchronously; asserting through the placeholder reads an empty table.
    await expect(modal.getByText('Wird geladen', { exact: false })).toBeHidden({ timeout: 30_000 });

    // The transfer is immediate and irreversible, so the warning saying so is part of the contract.
    await expect(
      modal.getByText(/wird sofort auf den neuen Therapeuten übertragen/),
      'the modal must warn that the transfer takes effect immediately',
    ).toBeVisible();

    // The VO detail table the therapist confirms before transferring.
    for (const label of TherapistTransferPage.CONFIRMATION_COLUMNS) {
      await expect(
        modal.getByText(label, { exact: true }).first(),
        `transfer modal should list a "${label}" column`,
      ).toBeVisible();
    }
    await expect(modal.getByText('Therapeuten suchen', { exact: true })).toBeVisible();
  }

  /**
   * The open target-therapist picker.
   *
   * It is a `[role="dialog"]` over the transfer modal now — the `data-testid*="flatlist"` list it
   * used to render is gone, so keying off that testid made the picker look permanently unavailable
   * and silently skipped the test that depends on it.
   */
  private pickerList(): Locator {
    return this.page.locator('[role="dialog"]').last();
  }

  /**
   * Opens the target-therapist picker and returns the selectable therapist names it offers.
   * Names are two-word "Firstname Lastname" rows; the private-use icon glyphs are ignored by
   * the name regex. Returns [] when the picker never renders.
   */
  async openTherapistPicker(): Promise<string[]> {
    await this.page
      .getByRole('button', { name: 'Therapeuten suchen' })
      .or(this.modal().getByText('Therapeuten suchen', { exact: true }))
      .first()
      .click({ force: true });
    if (!(await this.pickerList().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) {
      return [];
    }
    await this.page.waitForTimeout(1500);
    return (await this.pickerList().innerText())
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-zÄÖÜäöü.\-]+\s+[A-Za-zÄÖÜäöü.\-]/.test(s));
  }

  /** Picks a therapist by exact name from the open picker. */
  async selectTherapist(name: string): Promise<void> {
    await this.pickerList().getByText(name, { exact: true }).first().click({ force: true });
    await this.page.waitForTimeout(1500);
  }

  /** Closes the modal via Cancel WITHOUT committing the transfer. */
  async cancel(): Promise<void> {
    // "Abbrechen" is a real button now; the old English text pressable is gone. Never click
    // "Übertragen" — that commits an irreversible transfer.
    const cancel = this.page
      .getByRole('button', { name: 'Abbrechen', exact: true })
      .or(this.modal().locator('div').filter({ hasText: /^Cancel$/ }))
      .first();
    await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.modal().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}
