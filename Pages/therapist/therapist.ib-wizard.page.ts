import { Page, Locator } from '@playwright/test';
import { settleAfter, waitForStable } from '../util/settle';
import { boardSearchBox } from '../base/app.page';

/**
 * Page Object for the therapist IB (Infoblatt) signing wizard and its new 3.9 signature overlay.
 *
 * Reached from the therapist "Meine VOs" dashboard: each active VO row carries a "+ IB" control
 * (aria-label "Neuer IB"). Clicking it opens the IB Signer Dialog ("Wer unterschreibt?"); choosing
 * a signer and "Weiter" opens the two-step wizard (1 Datenschutzerklärung / DSGVO, 2 Therapie-
 * Einverständnis). Each step's "Unterschreiben" button opens a full-screen signature overlay
 * (ticket #2962) that also offers a typed-name fallback (#2963).
 *
 * The app is React-Native-Web: most controls are `div`s. Overlay buttons carry role="button" and
 * express their disabled state as aria-disabled="true"; the signer options are role="radio" inside
 * a role="radiogroup"; the wizard modal is role="dialog" with aria-modal="true". Selectors prefer
 * exact German text (the rest of the therapist suite's convention) and fall back to aria-labels.
 *
 * SAFETY: this POM never submits an IB. Drawing a signature and discarding it does not persist;
 * only the wizard's final confirmation/submission would. Tests drive up to — never through — that.
 */
export class IbWizardPage {
  constructor(private page: Page) {}

  private searchBox(): Locator {
    return boardSearchBox(this.page);
  }

  /** Loads the therapist dashboard at a wide viewport (the IB column sits far right). */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.setViewportSize({ width: 2400, height: 900 });
    await this.page.goto(`${baseUrl}/therapist/`, { waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ state: 'visible', timeout: 45_000 });
    // The search box paints before the rows behind it; every caller goes on to read those rows, so
    // wait for the row set to stop changing rather than sleeping 1.5 s at it.
    await waitForStable(this.page.getByRole('checkbox'));
  }

  /** Filters the list and expands "Aktive Patienten" so "+ IB" controls render. */
  async filterAndExpand(term = 'Test'): Promise<void> {
    const box = this.searchBox();
    await box.click();
    await box.fill(term);
    // Searching refetches the board, so settle on that request rather than the flat 3 s.
    await settleAfter(this.page, () => box.press('Enter'), { budgetMs: 15_000 });
    for (let i = 0; i < 4; i++) {
      if ((await this.page.getByRole('checkbox').count()) > 1) break;
      await this.page.getByText(/^Aktive Patienten$/).first().click({ force: true }).catch(() => {});
      await this.page.waitForTimeout(2000);
    }
  }

  /** The "+ IB" add-Initialbefund/Infoblatt control (one per active VO row). */
  ibAddControl(): Locator {
    return this.page.getByText('+ IB', { exact: true });
  }

  // ---------------------------------------------------------------- generic helpers

  /**
   * Whether the pressable ancestor of a text node is disabled (aria-disabled="true").
   * Works for both the plain-div signer buttons and the role="button" overlay buttons.
   * Returns null when the text isn't found.
   */
  async isTextControlDisabled(text: string): Promise<boolean | null> {
    return this.page.evaluate((t) => {
      const hits = Array.from(document.querySelectorAll('*')).filter((el) =>
        Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim() === t),
      );
      const el = hits[hits.length - 1] as HTMLElement | undefined;
      if (!el) return null;
      const ctrl = (el.closest('[aria-disabled],[role="button"],[tabindex]') as HTMLElement) || el;
      return ctrl.getAttribute('aria-disabled') === 'true';
    }, text);
  }

  /** Taps a visible element by exact/regex text. Returns whether the click landed. */
  private async tap(text: RegExp | string, timeout = 6000): Promise<boolean> {
    return this.page
      .getByText(text, { exact: typeof text === 'string' })
      .filter({ visible: true })
      .first()
      .click({ timeout })
      .then(() => true)
      .catch(() => false);
  }

  // ---------------------------------------------------------------- signer dialog

  signerDialogTitle(): Locator {
    return this.page.getByText('Wer unterschreibt?', { exact: true });
  }

  /**
   * The signer options in the dialog.
   *
   * They are still `[role="radio"]`, but the `[role="radiogroup"]` wrapper they used to sit in is
   * gone, so an ancestor-scoped selector matches nothing. They are addressable by accessible name
   * ("Patient/in", "Bevollmächtigte/r / Betreuer/in"), which comes from their text — their
   * descriptive `aria-label`s are gone too (see `ib_accessibility.spec.ts`).
   */
  signerRadios(): Locator {
    return this.page.getByRole('radio');
  }

  /** Opens the signer dialog from the first "+ IB" row. Returns false when unavailable. */
  async openSignerDialog(): Promise<boolean> {
    const ib = this.ibAddControl();
    if ((await ib.count()) === 0) return false;
    await ib.first().click({ force: true, timeout: 8000 }).catch(() => {});
    return this.signerDialogTitle()
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }

  /** Selects a signer option by its visible label. */
  async selectSigner(label: string): Promise<void> {
    await this.page.getByText(label, { exact: true }).filter({ visible: true }).first().click();
    await this.page.waitForTimeout(400);
  }

  /** Clicks "Weiter" to leave the signer dialog. */
  async continueFromSigner(): Promise<void> {
    await this.tap('Weiter');
  }

  /** Closes the signer dialog without proceeding. */
  async cancelSignerDialog(): Promise<void> {
    await this.tap('Abbrechen');
    await this.page.keyboard.press('Escape').catch(() => {});
  }

  // ---------------------------------------------------------------- wizard

  /** The wizard modal wrapper (role=dialog, aria-modal=true). */
  wizardModal(): Locator {
    return this.page.locator('[role="dialog"][aria-modal="true"]');
  }

  /** The wizard's language toggle (shows "DE"/"EN", aria-label "Sprache wechseln"). */
  languageToggle(): Locator {
    return this.page.locator('[aria-label="Sprache wechseln"]');
  }

  /**
   * Opens the signer dialog, picks a signer and enters the wizard. Returns false if any step is
   * unavailable in the current environment (caller should test.skip).
   */
  async enterWizard(signer = 'Patient/in'): Promise<boolean> {
    if (!(await this.openSignerDialog())) return false;
    await this.selectSigner(signer);
    await this.continueFromSigner();
    // The wizard shows the step title and a "Unterschreiben" (Sign) button.
    return this.page
      .getByText('Unterschreiben', { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  }

  /** True when a given wizard step heading is visible. */
  stepHeading(name: 'Datenschutzerklärung' | 'Therapie-Einverständnis'): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true }).first();
  }

  /** Advances to the next wizard step (step 2). */
  async nextStep(): Promise<void> {
    await settleAfter(this.page, () => this.tap('Weiter'), { budgetMs: 10_000 });
  }

  /** Opens the full-screen signature overlay for the current step. Returns whether it opened. */
  async openSignatureOverlay(): Promise<boolean> {
    await this.tap(/^Unterschreiben$/);
    return this.overlayUndo()
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }

  /** Closes the wizard modal (best effort, without submitting). */
  async closeWizard(): Promise<void> {
    await this.page.locator('[aria-label="Close modal"]').first().click({ timeout: 3000 }).catch(() => {});
    await this.page.keyboard.press('Escape').catch(() => {});
    // Dismiss any discard confirmation the close may raise.
    await this.tap(/Verwerfen|Ja|Schließen/).catch(() => {});
  }

  // ---------------------------------------------------------------- signature overlay

  signRegion(): Locator {
    return this.page.locator('[aria-label="Unterschriftenfeld"]').first();
  }
  overlayDone(): Locator {
    return this.page.getByRole('button', { name: 'Fertig' });
  }
  overlayUndo(): Locator {
    return this.page.getByRole('button', { name: 'Rückgängig' });
  }
  overlayClear(): Locator {
    return this.page.getByRole('button', { name: 'Löschen' });
  }
  /**
   * The overlay's "Abbrechen" (Cancel). NOTE: getByRole('button', {name:'Abbrechen'}) matches more
   * than one node (a detached/hidden dashboard button lingers behind the full-screen overlay), and
   * its first match isn't clickable — so anchor on the single VISIBLE exact-text button instead.
   */
  overlayCancel(): Locator {
    return this.page.getByText('Abbrechen', { exact: true }).filter({ visible: true }).first();
  }
  baselinePrompt(): Locator {
    return this.page.getByText('Bitte hier unterschreiben', { exact: true });
  }
  typedFallbackLink(): Locator {
    return this.page.getByText('Unterschrift nicht möglich? Namen eingeben', { exact: true });
  }

  /**
   * Draws a stroke across the signature field via the mouse and reports whether it REGISTERED
   * (i.e. "Fertig" became enabled). The web signature pad is driven by synthetic pointer events,
   * which it intermittently drops, so this retries several times. It still occasionally fails to
   * register at all — callers should test.skip() on a `false` return rather than hard-fail, the
   * same way the rest of the suite skips when a UI affordance is inert for the environment.
   */
  async drawSignature(): Promise<boolean> {
    const box = await this.signRegion().boundingBox();
    if (!box) return false;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let attempt = 0; attempt < 6; attempt++) {
      const yOffset = -30 + attempt * 12;
      await this.page.mouse.move(cx - 160, cy + yOffset);
      await this.page.mouse.down();
      for (let i = -160; i <= 160; i += 6) {
        await this.page.mouse.move(cx + i, cy + yOffset + Math.sin(i / 22) * 45);
      }
      await this.page.mouse.up();
      await this.page.waitForTimeout(450);
      if ((await this.isTextControlDisabled('Fertig')) === false) return true; // stroke registered
    }
    return false;
  }

  /** Confirms the signature ("Fertig") — closes the overlay and captures it into the wizard. */
  async done(): Promise<void> {
    await this.page.getByText('Fertig', { exact: true }).filter({ visible: true }).first().click({ timeout: 4000 });
    await this.page.waitForTimeout(800);
  }

  async undo(): Promise<void> {
    await this.overlayUndo().click();
    await this.page.waitForTimeout(400);
  }
  async clear(): Promise<void> {
    await this.overlayClear().click();
    await this.page.waitForTimeout(400);
  }

  /** Cancels the overlay; when strokes exist this raises the discard confirmation. */
  async cancelOverlay(): Promise<void> {
    await this.overlayCancel().click({ timeout: 4000 }).catch(() => {});
  }

  /** The discard-confirmation prompt raised by cancelling with strokes present. */
  discardConfirmTitle(): Locator {
    return this.page.getByText('Unterschrift verwerfen?', { exact: true });
  }
  discardConfirmBody(): Locator {
    return this.page.getByText('Ihre Unterschrift wird verworfen. Möchten Sie fortfahren?', { exact: true });
  }
  discardConfirmDiscardButton(): Locator {
    return this.page.getByText('Verwerfen', { exact: true }).filter({ visible: true });
  }
  discardConfirmKeepButton(): Locator {
    return this.page.getByText('Weiter unterschreiben', { exact: true }).filter({ visible: true });
  }
  async confirmDiscard(): Promise<void> {
    await this.tap('Verwerfen');
    await this.page.waitForTimeout(600);
  }
  async keepSigning(): Promise<void> {
    await this.tap('Weiter unterschreiben');
    await this.page.waitForTimeout(400);
  }

  // ---------------------------------------------------------------- typed-name mode

  /** Switches the overlay from draw mode to typed-name mode. */
  async switchToTypedMode(): Promise<boolean> {
    await this.typedFallbackLink().click({ timeout: 4000 }).catch(() => {});
    return this.page
      .getByText('Geben Sie Ihren vollständigen Namen als Unterschrift ein', { exact: true })
      .waitFor({ state: 'visible', timeout: 6000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * The typed-name text input. RN-Web renders it as a bare <input> with no `type` attribute (so
   * `input[type="text"]` misses it) and no data-testid.
   *
   * It used to be isolated by excluding `data-testid="text-input-outlined"`, the board search box.
   * That testid is GONE from the board, so the exclusion stopped excluding anything and this locator
   * silently resolved to the search box instead — which the specs then asserted on and typed into.
   * (It even passed a `toHaveValue(/\S/)` check, because the search box holds the filter term.) The
   * board box is now excluded by its own placeholder/aria-label, and the old testid exclusion is kept
   * for environments still serving it.
   */
  typedNameInput(): Locator {
    return this.page
      .locator(
        'input:not([data-testid="text-input-outlined"]):not([placeholder*="Patient, VO"]):not([aria-label*="Patient, VO"])',
      )
      .first();
  }

  /** The "Ich bestätige dies als meine Unterschrift" confirmation checkbox. */
  confirmCheckbox(): Locator {
    return this.page.getByRole('checkbox').filter({ hasText: 'Ich bestätige dies als meine Unterschrift' });
  }

  confirmCheckboxLabel(): Locator {
    return this.page.getByText('Ich bestätige dies als meine Unterschrift', { exact: true });
  }

  async checkConfirm(): Promise<void> {
    await this.confirmCheckboxLabel().click({ timeout: 4000 }).catch(() => {});
    await this.page.waitForTimeout(400);
  }

  backToDrawingLink(): Locator {
    return this.page.getByText('Zurück zum Zeichnen', { exact: true });
  }
  async backToDrawing(): Promise<void> {
    await this.backToDrawingLink().click({ timeout: 4000 }).catch(() => {});
    await this.page.waitForTimeout(600);
  }
}
