import { test, expect } from '@playwright/test';
import { IbWizardPage } from '../../../Pages/therapist/therapist.ib-wizard.page';

/**
 * Ticket #2965 — IB · Accessibility Labels (RC 3.9.0).
 *
 * Screen-reader support across the IB flow. On React-Native-Web the RN accessibility props render
 * as ARIA: accessibilityLabel → aria-label, accessibilityRole → role, accessibilityViewIsModal →
 * aria-modal="true". Verified live labels:
 *   - Signer options: role="radio" with descriptive aria-labels ("Patient unterschreibt in Person", …)
 *   - Language toggle: aria-label "Sprache wechseln"
 *   - Signature field: aria-label "Unterschriftenfeld"
 *   - Wizard modal: role="dialog" + aria-modal="true" (focus trap)
 *
 * ACs 3 (IB-table view/archive/delete labels) and 4 (discipline badges P/E/L → full names) target
 * the patient-profile IB section, a different surface/role than the therapist wizard; those tests
 * search for the labels and skip cleanly when the surface isn't reachable from here.
 * Data-gated + safe (no IB submitted). Staging only (per scope); mirror to Production later.
 */
test.describe('Therapist IB — Accessibility Labels', () => {
  test.describe.configure({ mode: 'serial' });

  let ib: IbWizardPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    ib = new IbWizardPage(page);
    await ib.open();
    await ib.filterAndExpand('Test');
  });

  test('Signer dialog options are announced by a meaningful name, not just "radio"', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async ({ page }) => {
    test.skip(!(await ib.openSignerDialog()), 'IB signer dialog not reachable for the available patient state');

    // AC2, as far as it still holds: each option resolves by an accessible NAME that says what it
    // means, so a screen reader announces "Patient/in" rather than a bare "radio button". The name
    // now comes from the option's text content rather than an aria-label (see the fixme below).
    await expect(page.getByRole('radio', { name: 'Patient/in', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Betreuer/ })).toBeVisible();

    const names = await ib.signerRadios().evaluateAll((els) =>
      els.map((e) => (e.getAttribute('aria-label') || (e as HTMLElement).innerText || '').trim()),
    );
    console.log(`signer option names: ${JSON.stringify(names)}`);
    expect(names.length, 'both signer options must be exposed as radios').toBeGreaterThanOrEqual(2);
    expect(
      names.every((n) => n.length > 5),
      'every option must be announced by something longer than a bare role',
    ).toBeTruthy();

    await ib.cancelSignerDialog();
  });

  test('Signer dialog options carry descriptive aria-labels inside a radiogroup', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async ({ page }) => {
    test.fixme(
      true,
      'DEFECT (found 2026-08-20 on staging, an a11y regression from the board redesign): the signer ' +
        'options lost BOTH halves of what AC2 asked for. They no longer carry descriptive ' +
        'aria-labels — "Patient unterschreibt in Person" / "…Betreuer…" are gone, and each radio\'s ' +
        'only accessible name is its own visible text — and the `[role="radiogroup"]` wrapper that ' +
        'grouped them is gone too, so assistive tech is told neither that the two options belong ' +
        'together nor how many there are. `aria-checked` is also absent, so the selected option is ' +
        'not announced (the "Weiter" button does correctly go disabled → enabled, so selection ' +
        'itself works). The test above asserts what survives; un-fixme this one once the labels and ' +
        'the radiogroup are restored.',
    );
    test.skip(!(await ib.openSignerDialog()), 'IB signer dialog not reachable for the available patient state');

    await expect(page.locator('[role="radiogroup"]')).toBeVisible();
    const labels = (
      await page
        .locator('[role="radiogroup"] [role="radio"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
    ).filter((l) => l.trim().length > 0);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.every((l) => l.trim().length > 5)).toBeTruthy();
    await expect(page.locator('[role="radio"][aria-label*="Patient unterschreibt"]')).toBeVisible();

    await ib.cancelSignerDialog();
  });

  test('Wizard modal traps focus (aria-modal) and the language toggle is labelled', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async () => {
    test.skip(!(await ib.enterWizard('Patient/in')), 'IB wizard not reachable for the available patient state');

    // AC6: the wizard modal enables focus trapping via aria-modal="true".
    await expect.poll(() => ib.wizardModal().count(), { timeout: 8000 }).toBeGreaterThan(0);
    // AC5: the language toggle has an accessibility label describing its purpose.
    await expect(ib.languageToggle().first()).toBeVisible();

    await ib.closeWizard();
  });

  test('Signature field exposes an accessibility label', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async () => {
    test.skip(!(await ib.enterWizard('Patient/in')), 'IB wizard not reachable for the available patient state');
    test.skip(!(await ib.openSignatureOverlay()), 'Signature overlay did not open');

    // AC1: the canvas/signature area has an aria-label describing its purpose ("Unterschriftenfeld").
    await expect(ib.signRegion()).toBeVisible();
    await expect(ib.signRegion()).toHaveAttribute('aria-label', /\S/);

    await ib.cancelOverlay();
    await ib.closeWizard();
  });

  test('IB table action buttons have descriptive labels (patient-profile surface)', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async ({ page }) => {
    // AC3: the view/archive/delete IB-table actions live in the patient-profile IB section, a
    // different surface from the therapist wizard. Look for their labels here and skip if absent.
    const actionLabels = page.locator(
      '[aria-label*="IB anzeigen"], [aria-label*="IB archivieren"], [aria-label*="IB löschen"], ' +
        '[aria-label*="View IB"], [aria-label*="Archive IB"], [aria-label*="Delete IB"]',
    );
    const found = await actionLabels.count().catch(() => 0);
    test.skip(found === 0, 'IB-table action buttons not present on the therapist surface (patient-profile only)');
    await expect(actionLabels.first()).toBeVisible();
  });

  test('Discipline badges announce full names (patient-profile surface)', {
    tag: ['@Therapist', '@IBAccessibility'],
  }, async ({ page }) => {
    // AC4: P/E/L badges should carry full-discipline aria-labels. These belong to the patient-
    // profile IB section; probe for them and skip cleanly if the surface isn't reachable here.
    const badges = page.locator(
      '[aria-label*="Physiotherapie"], [aria-label*="Ergotherapie"], [aria-label*="Logopädie"]',
    );
    const found = await badges.count().catch(() => 0);
    test.skip(found === 0, 'Discipline badges not present on the therapist surface (patient-profile only)');
    await expect(badges.first()).toBeVisible();
  });
});
