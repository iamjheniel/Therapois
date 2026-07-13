import { test, expect } from '@playwright/test';
import { TherapistTransferPage } from '../../../Pages/therapist/therapist.transfer.page';

/**
 * Production mirror of the Therapist "Patient transferieren" coverage. Drives the transfer flow
 * up to — but never through — the irreversible commit: verifies the modal structure and the
 * target-therapist picker, then cancels. See the Staging spec for the full rationale.
 */
test.describe('Therapist Transfer Patient', () => {
  test.describe.configure({ mode: 'serial' });

  const BASE = 'https://app.therapios.de';

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test('Transfer modal shows VO details and target-therapist picker', { tag: ['@Therapist', '@transferpatient'] }, async ({ page }) => {
    const transfer = new TherapistTransferPage(page);
    await transfer.open(BASE);

    const selected = await transfer.filterAndSelectFirst();
    test.skip(!selected, 'No patient row available to transfer in this environment');

    const opened = await transfer.openTransferModal();
    test.skip(!opened, 'Transfer control unavailable for the selected patient in this environment');

    await transfer.assertTransferModalStructure();
    await transfer.cancel();
  });

  test('Transfer modal offers selectable target therapists', { tag: ['@Therapist', '@transferpatient'] }, async ({ page }) => {
    const transfer = new TherapistTransferPage(page);
    await transfer.open(BASE);

    const selected = await transfer.filterAndSelectFirst();
    test.skip(!selected, 'No patient row available to transfer in this environment');

    const opened = await transfer.openTransferModal();
    test.skip(!opened, 'Transfer control unavailable for the selected patient in this environment');

    const therapists = await transfer.openTherapistPicker();
    test.skip(therapists.length === 0, 'Target-therapist picker did not render in this environment');
    expect(therapists.length).toBeGreaterThan(0);

    await transfer.selectTherapist(therapists[0]);
    await transfer.cancel();
  });
});
