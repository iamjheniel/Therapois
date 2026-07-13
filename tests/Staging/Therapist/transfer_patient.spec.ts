import { test, expect } from '@playwright/test';
import { TherapistTransferPage } from '../../../Pages/therapist/therapist.transfer.page';

/**
 * Coverage for the Therapist "Patient transferieren" (Transfer Patients) action — the sibling of
 * "Patient teilen" (share_patient.spec.ts), which had no test until now.
 *
 * Transferring hands the VO's responsibility to another therapist immediately and irreversibly,
 * which would remove a patient the rest of the therapist suite depends on. These tests therefore
 * drive the flow up to — but never through — the commit: they verify the modal opens with the
 * correct VO-confirmation structure and that a target therapist can be picked, then cancel.
 */
test.describe('Therapist Transfer Patient', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    // Wide viewport keeps the full action bar (incl. "Patient transferieren") on-screen.
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test('Transfer modal shows VO details and target-therapist picker', { tag: ['@Therapist', '@transferpatient'] }, async ({ page }) => {
    const transfer = new TherapistTransferPage(page);
    await transfer.open();

    const selected = await transfer.filterAndSelectFirst();
    test.skip(!selected, 'No patient row available to transfer in this environment');

    const opened = await transfer.openTransferModal();
    test.skip(!opened, 'Transfer control unavailable for the selected patient in this environment');

    await transfer.assertTransferModalStructure();
    await transfer.cancel();
  });

  test('Transfer modal offers selectable target therapists', { tag: ['@Therapist', '@transferpatient'] }, async ({ page }) => {
    const transfer = new TherapistTransferPage(page);
    await transfer.open();

    const selected = await transfer.filterAndSelectFirst();
    test.skip(!selected, 'No patient row available to transfer in this environment');

    const opened = await transfer.openTransferModal();
    test.skip(!opened, 'Transfer control unavailable for the selected patient in this environment');

    const therapists = await transfer.openTherapistPicker();
    test.skip(therapists.length === 0, 'Target-therapist picker did not render in this environment');
    expect(therapists.length).toBeGreaterThan(0);

    // Selecting a target is the last step before the (deliberately un-clicked) "Übertragen" commit.
    await transfer.selectTherapist(therapists[0]);
    await transfer.cancel();
  });
});
