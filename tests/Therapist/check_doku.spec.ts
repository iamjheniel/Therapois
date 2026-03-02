import { test, expect} from '@playwright/test';

test.describe('Therapist Doku Check', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Check Doku feature', { tag: ['@Therapist','@checkdoku'] }, async ({ page }) => {
    // Use Martina Gerth (confirmed available via search tests)
    await page.getByTestId('text-input-outlined').fill('Martina Gerth');
    await page.getByTestId('text-input-outlined').press('Enter');
    await page.waitForTimeout(1500);
    await page.getByText('Martina Gerth').first().click({force:true});
    await page.waitForTimeout(500);
    // Click the Doku eye icon by position (icon is ~25px below the "Doku" label)
    // The eye icons have no stable data-testid; coordinate click is most reliable
    const dokuLabel = page.getByText('Doku', { exact: true }).first();
    const dokuBox = await dokuLabel.boundingBox();
    await page.mouse.click(dokuBox!.x + dokuBox!.width / 2, dokuBox!.y + dokuBox!.height + 25);
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentation (Behandlungsverlauf)');

  });

    test('Check Logs feature', { tag: ['@Therapist','@checklogs'] }, async ({ page }) => {
    // Use Martina Gerth (confirmed available via search tests)
    await page.getByTestId('text-input-outlined').fill('Martina Gerth');
    await page.getByTestId('text-input-outlined').press('Enter');
    await page.waitForTimeout(1500);
    await page.getByText('Martina Gerth').first().click({force:true});
    await page.waitForTimeout(500);
    // Click the Protokolle eye icon by position (icon is ~25px below the "Protokolle" label)
    const protokolleLabel = page.getByText('Protokolle', { exact: true }).first();
    const protokolleBox = await protokolleLabel.boundingBox();
    await page.mouse.click(protokolleBox!.x + protokolleBox!.width / 2, protokolleBox!.y + protokolleBox!.height + 25);
    await expect(page.getByTestId('modal-surface')).toContainText(/Prescription logs/i);
    await page.locator('div').filter({ hasText: /^Close$/ }).nth(1).click();
  });

});
