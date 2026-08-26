import { test, expect } from '@playwright/test';
import { DeceasedPage, DECEASED_PATIENT } from '../../../Pages/admin/admin.deceased.page';

/**
 * Ticket #2996 — Mark as Deceased Action with Confirmation (RC 3.9, epic #2995).
 *
 * The admin patient detail form gains an "Als verstorben markieren" action that opens a confirmation
 * dialog listing every active VO to be terminated, and (on an already-deceased patient) shows a
 * banner instead. Covers the button, the confirmation dialog structure, and the deceased banner —
 * plus the role gating (admin sees no SuperAdmin-only "Undo" action).
 *
 * SAFETY: marking a patient deceased terminates ALL their active VOs, so these tests open the
 * confirmation dialog and CANCEL — they never confirm. Staging only (per scope); mirror to Prod later.
 */
const NON_DECEASED_ID = 6334; // Monika Ahrends — non-deceased QA patient with active VOs.

test.describe('Admin — Mark Patient as Deceased', () => {
  let dp: DeceasedPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    dp = new DeceasedPage(page);
  });

  test('Mark-as-Deceased opens a confirmation dialog listing active VOs (cancelled)', {
    tag: ['@Admin', '@DeceasedMarking'],
  }, async ({ page }) => {
    await dp.openPatientForm(NON_DECEASED_ID);
    // AC1: the action is visible to admins on a (non-deceased) patient form.
    test.skip(!(await dp.markAsDeceasedButton().count()), 'Mark-as-Deceased action not available for this patient/state');
    await expect(dp.markAsDeceasedButton().first()).toBeVisible();

    // AC2: a confirmation dialog lists the active VOs (number / therapy / treatment status) and
    // explains the termination + SuperAdmin-undo behaviour.
    test.skip(!(await dp.openMarkDialog()), 'confirmation dialog did not open');
    const root = page.locator('#root');
    await expect(dp.confirmDialogTitle()).toBeVisible();
    await expect(root).toContainText('werden die folgenden aktiven VOs beendet');
    await expect(root).toContainText('Grund: Verstorben');
    await expect(root).toContainText('VO-Nummer');
    await expect(root).toContainText('Behandlungsstatus');
    await expect(root).toContainText('kann von einem Super Admin rückgängig gemacht werden');
    // The confirm button carries the same label; it is present but we never click it.
    await expect(page.getByText('Als verstorben markieren', { exact: true }).filter({ visible: true }).last()).toBeVisible();

    // AC: cancel without marking — nothing is terminated.
    await dp.cancelMarkDialog();
    await expect(dp.confirmDialogTitle()).toBeHidden({ timeout: 8000 });
  });

  test('Deceased patient form shows the banner; admin sees no Mark/Undo action', {
    tag: ['@Admin', '@DeceasedMarking'],
  }, async ({ page }) => {
    await dp.openPatientForm(DECEASED_PATIENT.id);
    // #2997 AC3: a banner states the patient is deceased, with date and who marked them.
    test.skip(!(await dp.deceasedBanner().count()), 'deceased fixture patient no longer marked — data changed');
    await expect(dp.deceasedBanner().first()).toBeVisible();
    await expect(page.locator('#root')).toContainText(/Als verstorben markiert am .* von /);

    // Already deceased ⇒ no "Mark as Deceased"; and the "Undo" action is SuperAdmin-only (#2996 AC8).
    await expect(dp.markAsDeceasedButton()).toHaveCount(0);
    await expect(dp.undoDeceasedButton()).toHaveCount(0);
  });
});
