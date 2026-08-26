import { test, expect } from '@playwright/test';
import { IbWizardPage } from '../../../Pages/therapist/therapist.ib-wizard.page';

/**
 * Ticket #2963 — IB · Typed-Name Signature Fallback (RC 3.9.0).
 *
 * The signature overlay offers a typed-name alternative for patients who cannot draw: a
 * "Unterschrift nicht möglich? Namen eingeben" link switches the canvas to a text input
 * (pre-filled with the patient's name) plus an "Ich bestätige dies als meine Unterschrift"
 * checkbox. "Fertig" (Done) stays disabled until the input is non-empty AND the box is checked.
 * "Zurück zum Zeichnen" returns to draw mode.
 *
 * Data-gated + safe: skips when the wizard/overlay can't be reached; never submits an IB.
 * Staging only (per scope); mirror to Production later.
 */
test.describe('Therapist IB — Typed-Name Signature Fallback', () => {
  test.describe.configure({ mode: 'serial' });

  let ib: IbWizardPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    ib = new IbWizardPage(page);
    await ib.open();
    await ib.filterAndExpand('Test');
  });

  /** Opens the wizard, opens the overlay, and switches to typed mode — or skips. */
  async function reachTypedMode(): Promise<boolean> {
    if (!(await ib.enterWizard('Patient/in'))) return false;
    if (!(await ib.openSignatureOverlay())) return false;
    return ib.switchToTypedMode();
  }

  test('Typed-fallback link is visible in draw mode', {
    tag: ['@Therapist', '@IBTypedSignature'],
  }, async () => {
    test.skip(!(await ib.enterWizard('Patient/in')), 'IB wizard not reachable for the available patient state');
    test.skip(!(await ib.openSignatureOverlay()), 'Signature overlay did not open');

    // AC1: the "Can't sign? Type name" link sits below the drawing canvas.
    await expect(ib.typedFallbackLink()).toBeVisible();

    await ib.cancelOverlay();
    await ib.closeWizard();
  });

  test('Switching to typed mode shows a name input, prompt, and confirm checkbox', {
    tag: ['@Therapist', '@IBTypedSignature'],
  }, async ({ page }) => {
    test.skip(!(await reachTypedMode()), 'Typed-name mode not reachable for the available patient state');

    // AC2/AC3: canvas is replaced by a text input + confirmation checkbox, with the typed prompt.
    await expect(page.getByText('Geben Sie Ihren vollständigen Namen als Unterschrift ein', { exact: true })).toBeVisible();
    await expect(ib.typedNameInput()).toBeVisible();
    await expect(ib.confirmCheckboxLabel()).toBeVisible();
    // The input is pre-filled with the patient's full name (editable → non-empty on entry).
    await expect(ib.typedNameInput()).toHaveValue(/\S/);

    await ib.cancelOverlay();
    await ib.closeWizard();
  });

  test('Done is gated on both a non-empty name and the confirmation checkbox', {
    tag: ['@Therapist', '@IBTypedSignature'],
  }, async () => {
    test.skip(!(await reachTypedMode()), 'Typed-name mode not reachable for the available patient state');

    // AC5: with a pre-filled name but the box unchecked, Done is still disabled.
    await expect(ib.typedNameInput()).toHaveValue(/\S/);
    expect(await ib.isTextControlDisabled('Fertig')).toBeTruthy();

    // Clearing the name keeps Done disabled even if the box were checked.
    await ib.typedNameInput().fill('');
    await ib.checkConfirm();
    expect(await ib.isTextControlDisabled('Fertig')).toBeTruthy();

    // Name + checked → Done enabled.
    await ib.typedNameInput().fill('Max Mustermann');
    await expect.poll(() => ib.isTextControlDisabled('Fertig'), { timeout: 8000 }).toBe(false);

    await ib.cancelOverlay();
    // A discard confirmation may appear (a typed signature counts as content) — dismiss it.
    await ib.confirmDiscard().catch(() => {});
    await ib.closeWizard();
  });

  test('Back to drawing returns to draw mode with an empty canvas', {
    tag: ['@Therapist', '@IBTypedSignature'],
  }, async () => {
    test.skip(!(await reachTypedMode()), 'Typed-name mode not reachable for the available patient state');

    // AC4: "Zurück zum Zeichnen" switches back to the drawing canvas.
    await expect(ib.backToDrawingLink()).toBeVisible();
    await ib.backToDrawing();

    await expect(ib.signRegion()).toBeVisible();
    await expect(ib.baselinePrompt()).toBeVisible();
    // Back on an empty canvas → Done disabled again.
    expect(await ib.isTextControlDisabled('Fertig')).toBeTruthy();

    await ib.cancelOverlay();
    await ib.closeWizard();
  });
});
