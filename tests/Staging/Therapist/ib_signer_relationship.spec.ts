import { test, expect } from '@playwright/test';
import { IbWizardPage } from '../../../Pages/therapist/therapist.ib-wizard.page';

/**
 * Ticket #2964 — IB · Relative Relationship Selection (RC 3.9.0).
 *
 * The in-person IB Signer Dialog ("Wer unterschreibt?") lets the therapist specify who signs when
 * it isn't the patient. On staging this is surfaced as two radio options: "Patient/in" and
 * "Bevollmächtigte/r / Betreuer/in" (authorised representative / legal guardian — the two
 * non-patient roles were merged into one combined option). "Weiter" (Continue) is gated until a
 * signer is chosen, and choosing the relative option proceeds into the wizard the same as "Patient/in".
 *
 * The persistence AC ("relationship saved on the IB / visible in IB details") requires submitting
 * an IB, which these tests deliberately never do — so that part is out of scope here (backend/
 * post-commit). Data-gated: skips when the signer dialog can't be opened.
 * Staging only (per scope); mirror to Production later.
 */
test.describe('Therapist IB — Signer Relationship Selection', () => {
  test.describe.configure({ mode: 'serial' });

  let ib: IbWizardPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    ib = new IbWizardPage(page);
    await ib.open();
    await ib.filterAndExpand('Test');
  });

  test('Signer dialog offers Patient and relationship options as single-choice radios', {
    tag: ['@Therapist', '@IBSignerRelationship'],
  }, async ({ page }) => {
    test.skip(!(await ib.openSignerDialog()), 'IB signer dialog not reachable for the available patient state');

    await expect(ib.signerDialogTitle()).toBeVisible();
    // AC1: the patient option plus the combined relationship option (guardian / authorised rep).
    await expect(page.getByText('Patient/in', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('Bevollmächtigte/r / Betreuer/in', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    // The options are single-choice radios. NOTE: the `[role="radiogroup"]` wrapper they used to sit
    // in is gone — only the radios themselves carry a role now — so this counts the radios directly.
    await expect.poll(() => ib.signerRadios().count(), { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    // Each is reachable by its accessible name, which is what a screen reader announces.
    await expect(page.getByRole('radio', { name: 'Patient/in', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Betreuer/ })).toBeVisible();

    await ib.cancelSignerDialog();
  });

  test('Continue is disabled until a signer is selected', {
    tag: ['@Therapist', '@IBSignerRelationship'],
  }, async () => {
    test.skip(!(await ib.openSignerDialog()), 'IB signer dialog not reachable for the available patient state');

    // AC2: with nothing selected, "Weiter" is disabled.
    expect(await ib.isTextControlDisabled('Weiter')).toBeTruthy();

    // Selecting a relationship enables it.
    await ib.selectSigner('Bevollmächtigte/r / Betreuer/in');
    await expect.poll(() => ib.isTextControlDisabled('Weiter'), { timeout: 8000 }).toBe(false);

    await ib.cancelSignerDialog();
  });

  test('Selecting a relative relationship proceeds into the wizard', {
    tag: ['@Therapist', '@IBSignerRelationship'],
  }, async () => {
    // AC3: pick the relative option and continue → the two-step wizard opens.
    test.skip(!(await ib.enterWizard('Bevollmächtigte/r / Betreuer/in')), 'IB wizard not reachable for the available patient state');
    await expect(ib.stepHeading('Datenschutzerklärung')).toBeVisible();
    await ib.closeWizard();
  });

  test('Selecting Patient behaves as before (no extra prompt, proceeds to wizard)', {
    tag: ['@Therapist', '@IBSignerRelationship'],
  }, async () => {
    // AC4: the patient-signs-in-person path is unchanged.
    test.skip(!(await ib.enterWizard('Patient/in')), 'IB wizard not reachable for the available patient state');
    await expect(ib.stepHeading('Datenschutzerklärung')).toBeVisible();
    await expect(ib.stepHeading('Therapie-Einverständnis')).toBeVisible();
    await ib.closeWizard();
  });
});
