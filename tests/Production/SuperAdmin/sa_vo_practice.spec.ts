import { test, expect } from '@playwright/test';
import { VoFormPage } from '../../../Pages/vo/vo.form.page';

// Epic: VO Direct Practice Assignment — therapios/monorepo#2670
//   #2671 VO Form: practice is a direct, required field (searchable by name + BSNR),
//          doctor becomes optional.
//   #2673 Surfaces: the dashboard shows a VO's directly-assigned practice column.
//
// On Production the `/practices` API is healthy, so the "select a practice" test exercises
// the full search-and-pick flow. (The test self-skips only if the API is unavailable.)

test.describe('Super Admin — VO Direct Practice Assignment', () => {
  test(
    'VO form requires Praxis and makes Doctor optional',
    { tag: ['@SuperAdmin', '@VOPracticeAssignment', '@VOFormPractice'] },
    async ({ page }) => {
      const voForm = new VoFormPage(page);
      await voForm.openCreateVoForm();
      await voForm.expectPracticeRequired();
      await voForm.expectDoctorOptional();
    }
  );

  test(
    'VO practice selector searches by name and BSNR',
    { tag: ['@SuperAdmin', '@VOPracticeAssignment', '@VOPracticeSearch'] },
    async ({ page }) => {
      const voForm = new VoFormPage(page);
      await voForm.openCreateVoForm();

      // Typing into the practice dropdown queries /practices with BOTH search[name] and
      // search[practiceId] (BSNR) — proving it is searchable by name and BSNR (#2671 AC1).
      const requestPromise = page.waitForRequest(
        (r) =>
          r.url().includes('/practices?') &&
          // Match the request carrying the COMPLETE query — pressSequentially fires a
          // request per keystroke, so matching a bare param would resolve on an early
          // partial ("O"/"Ort") and fail the full-value assertions below.
          r.url().includes('search%5Bname%5D=Ortho') &&
          r.url().includes('search%5BpracticeId%5D=Ortho'),
        { timeout: 20_000 }
      );
      await voForm.searchPractice('Ortho');
      const request = await requestPromise;
      expect(request.url()).toContain('search%5Bname%5D=Ortho');
      expect(request.url()).toContain('search%5BpracticeId%5D=Ortho');
    }
  );

  test(
    'VO practice selector lists options and selects one',
    { tag: ['@SuperAdmin', '@VOPracticeAssignment', '@VOPracticeSelect'] },
    async ({ page }) => {
      const voForm = new VoFormPage(page);
      await voForm.openCreateVoForm();
      await voForm.searchPractice('a');

      const optionCount = await voForm.practiceOptionCount();
      test.skip(
        optionCount === 0,
        'No practice options in this environment (/practices API unavailable) — selection cannot be exercised.'
      );

      const name = await voForm.selectFirstPractice();
      await expect(page.getByText(name).first()).toBeVisible();
    }
  );

  test(
    'Dashboard exposes a Praxis column (direct practice)',
    { tag: ['@SuperAdmin', '@VOPracticeAssignment', '@DashboardPracticeColumn'] },
    async ({ page }) => {
      const voForm = new VoFormPage(page);
      await voForm.expectDashboardPraxisColumnOption();
    }
  );
});
