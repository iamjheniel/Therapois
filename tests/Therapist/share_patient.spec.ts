import {test,  expect} from '@playwright/test';

test.describe('Therapist Share Patient', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({page}) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Therapist Share Patient with another Therapist', {tag: ['@Therapist', '@sharepatient']}, async ({page}) => {

    await page.getByRole('checkbox').nth(2).click();

    const shareButton = page.getByRole('button', {
      name: /Patient teilen/
    });

    await expect(shareButton).toBeVisible();
    await expect(shareButton).toBeEnabled();
    await shareButton.click();

    await expect(page.getByTestId('modal-surface')).toContainText('Patient teilen (1)');
    await page.getByText('Therapeut auswählen', { exact: true }).click();
    await page.locator('div:nth-child(3) > div > div > .css-g5y9jx.r-1i6wzkk > div > div > .css-g5y9jx.r-1otgn73').click();
    await page.locator('div').filter({ hasText: /^Fertig$/ }).first().click();
    await page.locator('div').filter({ hasText: /^Speichern$/ }).first().click();
    await expect(page.getByTestId('surface')).toContainText(/erfolgreich geteilt/i);
    });

    test('Therapist Remove Shared Patient with another Therapist', {tag: ['@Therapist', '@removesharedpatient']}, async ({page}) => {
    //remove shared patient
    await page.getByRole('checkbox').nth(2).click({ force: true });
    await page.getByRole('button', { name: 'Patient teilen (1)' }).click();
    await page.getByTestId('modal-surface').getByRole('button', { name: 'Close' }).click({force: true });
    await page.getByText('Speichern').click();
    await page.locator('div').filter({ hasText: /^Speichern$/ }).first().click();
    await expect(
      page
        .getByTestId('surface')
        .filter({ hasText: 'Patientenfreigabe entfernt' })
    ).toBeVisible();

    });
});
