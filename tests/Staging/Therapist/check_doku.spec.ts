import { test, expect } from '@playwright/test';

test.describe('Therapist Doku Check', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Check Doku feature', { tag: ['@Therapist', '@checkdoku'] }, async ({ page }) => {
    // Search for patient
    await page.getByTestId('text-input-outlined').first().fill('Martina Gerth');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await page.getByText('Martina Gerth').first().waitFor({ state: 'visible' });
    await page.getByText('Martina Gerth').first().click({ force: true });

    // Click the Doku eye icon safely using boundingBox with null guard
    const dokuLabel = page.getByText('Doku', { exact: true }).first();
    await dokuLabel.waitFor({ state: 'visible' });
    const dokuBox = await dokuLabel.boundingBox();
    if (!dokuBox) throw new Error('Could not find bounding box for "Doku" label');
    await page.mouse.click(dokuBox.x + dokuBox.width / 2, dokuBox.y + dokuBox.height + 25);

    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentation (Behandlungsverlauf)');
  });

  test('Check Logs feature', { tag: ['@Therapist', '@checklogs'] }, async ({ page }) => {
    // Search for patient
    await page.getByTestId('text-input-outlined').first().fill('Martina Gerth');
    await page.getByTestId('text-input-outlined').first().press('Enter');
    await page.getByText('Martina Gerth').first().waitFor({ state: 'visible' });
    await page.getByText('Martina Gerth').first().click({ force: true });

    // Click the Protokolle eye icon safely using boundingBox with null guard
    const protokolleLabel = page.getByText('Protokolle', { exact: true }).first();
    await protokolleLabel.waitFor({ state: 'visible' });
    const protokolleBox = await protokolleLabel.boundingBox();
    if (!protokolleBox) throw new Error('Could not find bounding box for "Protokolle" label');
    await page.mouse.click(protokolleBox.x + protokolleBox.width / 2, protokolleBox.y + protokolleBox.height + 25);

    await expect(page.getByTestId('modal-surface')).toContainText(/Prescription logs/i);

    // Close modal using a more stable selector
    await page.getByRole('button', { name: /close/i }).click();
  });

});