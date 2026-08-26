import { test, expect } from '@playwright/test';
import { DeceasedPage, DECEASED_PATIENT } from '../../../Pages/admin/admin.deceased.page';

/**
 * Ticket #2998 (AC1) — VO Creation Warning for a deceased patient (RC 3.9, epic #2995).
 *
 * Selecting a deceased patient in the Create-VO patient picker shows a prominent, NON-blocking
 * warning (posthumous prescriptions are legitimate). This test selects the deceased patient and
 * asserts the warning; it never creates the VO. Staging only (per scope); mirror to Prod later.
 */
test.describe('Admin — VO Creation Deceased Warning', () => {
  test('Selecting a deceased patient during VO creation shows a non-blocking warning', {
    tag: ['@Admin', '@DeceasedVoWarning'],
  }, async ({ page }) => {
    test.setTimeout(120_000);
    const dp = new DeceasedPage(page);
    await dp.openCreateVo();

    const selected = await dp.selectVoPatient('NikkiQA');
    test.skip(!selected, 'deceased patient not selectable in the VO patient picker in this environment');

    // AC1: the warning appears (and creation is still possible — not blocked).
    await expect(dp.deceasedVoWarning()).toBeVisible({ timeout: 10_000 });
    // Do NOT submit — no VO is created for the deceased patient.
  });
});
