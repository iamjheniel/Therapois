import { test, expect } from '@playwright/test';
import { DeceasedPage, DECEASED_PATIENT } from '../../../Pages/admin/admin.deceased.page';

/**
 * Ticket #2996 (AC5/AC8) — Undo Deceased Marking is Super-Admin-only (RC 3.9, epic #2995).
 *
 * On a deceased patient's detail form, a Super Admin sees the "Markierung 'Verstorben' rückgängig
 * machen" action (which would restore all terminated VOs) — whereas admins do NOT (asserted in the
 * Admin marking spec). This test only verifies visibility; it NEVER clicks Undo (that would restore
 * the fixture patient's VOs). Staging only (per scope); mirror to Prod later.
 */
test.describe('Super Admin — Undo Deceased Marking', () => {
  test('Super Admin sees the deceased banner and the Undo action', {
    tag: ['@SuperAdmin', '@DeceasedUndo'],
  }, async ({ page }) => {
    test.setTimeout(120_000);
    const dp = new DeceasedPage(page);
    await dp.openPatientForm(DECEASED_PATIENT.id);

    test.skip(!(await dp.deceasedBanner().count()), 'deceased fixture patient no longer marked — data changed');
    await expect(dp.deceasedBanner().first()).toBeVisible();
    // AC5: the SuperAdmin-only Undo action is present (admins do not see it — see Admin spec).
    await expect(dp.undoDeceasedButton().first()).toBeVisible({ timeout: 10_000 });
    // Deliberately NOT clicked — undoing would reactivate the patient's terminated VOs.
  });
});
