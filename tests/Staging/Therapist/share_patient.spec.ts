import {test,  expect} from '@playwright/test';

test.describe('Therapist Share Patient', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({page}) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Therapist Share Patient with another Therapist', {tag: ['@Therapist', '@sharepatient']}, async ({page}) => {
    // Search an existing patient, then select that patient's row checkbox.
    // (JhenTest QASala is no longer present; an unfiltered select-all header checkbox
    // would select every visible patient and yield "Patient teilen (N)".)
    await page.getByTestId('text-input-outlined').first().fill('BiniStacey Test');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await page.waitForTimeout(1500);

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
    // Same patient as the share test — should have exactly 1 shared therapist after it.
    await page.getByTestId('text-input-outlined').first().fill('BiniStacey Test');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await page.waitForTimeout(1500);

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
