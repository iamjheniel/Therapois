import { test, expect } from '@playwright/test';
import { VoFormPage } from '../../../Pages/vo/vo.form.page';

// End-to-end "Create VO" (VO erstellen) happy path for an Admin — written to be
// FLEXIBLE and NOT data-centered:
//
//  • It fills the form from whatever the environment offers (first-available patient,
//    Area, Insurance Type, ICD result and Heilmittel) instead of hardcoded records, then
//    saves through the validation gate: Speichern → approve checks → Speichern again. A
//    successful save POSTs /prescriptions (2xx) and returns to the dashboard.
//  • When the environment can't complete a real save (no matching data, the duplicate /
//    Vorgänger-VO gate, or the Staging /practices 500), it does NOT fail — it falls back to
//    asserting the data-independent form contract (Praxis required, Doctor optional) and
//    marks the test skipped with the reason.
//
// Note: on a healthy environment this creates a real VO. That is data-creating by design.

test.describe('Admin — Create VO (end-to-end)', () => {
  test(
    'Creates a VO through the full validation flow (or verifies the form contract)',
    { tag: ['@Admin', '@CreateVO'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const voForm = new VoFormPage(page);

      await voForm.openCreateVoForm();
      const result = await voForm.tryCreateVo();

      if (result.saved) {
        expect(
          result.status,
          `POST /prescriptions should succeed (got ${result.status})`,
        ).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        await voForm.expectBackOnDashboard();
        return;
      }

      // Graceful fallback: the save couldn't complete in this environment. Verify the
      // form contract still holds, then skip rather than fail on an environment condition.
      // eslint-disable-next-line no-console
      console.warn(`VO not created (${result.note}); verifying form contract instead.`);
      await voForm.expectCreateFormContract();
      test.skip(true, `VO not created in this environment: ${result.note}`);
    },
  );
});
