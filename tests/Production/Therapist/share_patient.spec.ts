import {test,  expect} from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';

test.describe('Therapist Share Patient', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({page}) => {
    await page.goto('https://app.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Therapist Share Patient with another Therapist', {tag: ['@Therapist', '@sharepatient']}, async ({page}) => {
    // Use JhenTest QA — confirmed to have no existing shared therapists ("Geteilter Therapeut: -")
    // This avoids "Failed to share patients" errors from state pollution
    // Resolve a real patient from live data and leave the list filtered to it.
    const list = new TherapistListPage(page);
    const name = await list.resolvePatientName(['JhenTest QA']);
    test.skip(!name, 'No patient available in this therapist\'s list');

    // nth(0) = select-all header checkbox; nth(1) = the (single) filtered patient row.
    await page.getByRole('checkbox').nth(1).click({ force: true });

    const shareButton = page.getByRole('button', {
      name: /Patient teilen/
    });

    await expect(shareButton).toBeVisible();
    await expect(shareButton).toBeEnabled();
    await shareButton.click();

    await expect(page.getByTestId('modal-surface')).toContainText('Patient teilen (1)');
    // Open the therapist picker dropdown
    await page.getByText('Therapeut auswählen', { exact: true }).click({ force: true });
    await page.waitForTimeout(1000);
    // Select the first available therapist (nth(0) = first option in expanded dropdown)
    await page.getByTestId('modal-surface').locator('div[tabindex="0"]').nth(0).click({ force: true });
    // Confirm selection (Fertig closes the dropdown picker)
    await page.locator('div').filter({ hasText: /^Fertig$/ }).first().click();
    await page.locator('div').filter({ hasText: /^Speichern$/ }).first().click();
    await expect(page.getByTestId('surface')).toContainText(/erfolgreich geteilt/i);
    });

    test('Therapist Remove Shared Patient with another Therapist', {tag: ['@Therapist', '@removesharedpatient']}, async ({page}) => {
    // Use JhenTest QA (same as share test — should have exactly 1 shared therapist after share test)
    // Resolve a real patient from live data and leave the list filtered to it.
    const list = new TherapistListPage(page);
    const name = await list.resolvePatientName(['JhenTest QA']);
    test.skip(!name, 'No patient available in this therapist\'s list');

    // nth(0) = select-all header checkbox; nth(1) = the (single) filtered patient row.
    await page.getByRole('checkbox').nth(1).click({ force: true });
    await page.getByRole('button', { name: /Patient teilen/ }).click();
    // Use .last() to remove the most recently added shared therapist
    await page.getByTestId('modal-surface').getByRole('button', { name: 'Close' }).last().click({force: true });
    await page.getByText('Speichern').click();
    await page.locator('div').filter({ hasText: /^Speichern$/ }).first().click();
    await expect(
      page
        .getByTestId('surface')
        .filter({ hasText: 'Patientenfreigabe entfernt' })
    ).toBeVisible();

    });
});
