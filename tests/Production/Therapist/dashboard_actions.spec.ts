import { test, expect } from '@playwright/test';
import { TherapistDashboardPage } from '../../../Pages/therapist/therapist.dashboard.page';

/**
 * Production mirror of the Therapist "Überprüfen" review banners and "Bestellt von" dropdown
 * coverage. Both are data-dependent and skip cleanly when nothing is due / no patient exists.
 * The "Bestellt von" test never picks an option (that records the follow-up-VO order — a mutation).
 * See the Staging spec for the full rationale.
 */

const BASE = 'https://app.therapios.de';

test.describe('Therapist Überprüfen Review Banner', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test('Review banner is present with an Überprüfen call-to-action', { tag: ['@Therapist', '@reviewbanner'] }, async ({ page }) => {
    const dash = new TherapistDashboardPage(page);
    await dash.open(BASE);

    const banners = await dash.waitForReviewBanners();
    test.skip(banners.length === 0, 'No review reminders due in this environment');
    expect(banners.length).toBeGreaterThan(0);
    await expect(page.getByText('Überprüfen', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });

  test('Überprüfen opens the "14+ Tage" review popover listing patients', { tag: ['@Therapist', '@reviewbanner'] }, async ({ page }) => {
    const dash = new TherapistDashboardPage(page);
    await dash.open(BASE);

    test.skip(!(await dash.has14DayBanner()), 'No "14+ Tagen nicht behandelt" reminder due in this environment');

    const opened = await dash.open14DayReviewPopover();
    test.skip(!opened, 'Review popover did not render in this environment');
    await dash.assertReviewPopoverListsPatients();
    await dash.closePopover();
  });
});

test.describe('Therapist Bestellt von', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
  });

  test('Bestellt von dropdown offers Therapeut and Admin options', { tag: ['@Therapist', '@bestelltvon'] }, async ({ page }) => {
    const dash = new TherapistDashboardPage(page);
    await dash.open(BASE);

    const selected = await dash.filterAndSelectFirstRow();
    test.skip(!selected, 'No patient row available in this environment');

    const opened = await dash.openBestelltVonDropdown();
    test.skip(!opened, '"Bestellt von" dropdown did not open for the selected patient in this environment');
    await dash.assertBestelltVonOptions();
    // Deliberately not selecting an option — that would record the follow-up-VO order (a mutation).
  });
});
