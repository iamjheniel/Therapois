import { test, expect } from '@playwright/test';

test.describe('Therapist Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Therapist Upload VO', { tag: ['@Therapist','@uploadvo'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: '󰩎 Rezept hochladen' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Wählen Sie ein Bild zum Hochladen").click(),]);
    await fileChooser.setFiles("/Users/jhenielguardiana/Documents/Therapois/tests/Therapist/sampleprescription.png");
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('#root')).toContainText('In Prüfung');
    });

  test('Therapist Upload VO View and Add Note', { tag: ['@Therapist', '@AddNoteTherapist'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Rezept' }).click();
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByTestId('button').nth(1).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Prescription Image Details');
    await page.getByRole('textbox', { name: 'Type your note here...' }).click();
    await page.getByRole('textbox', { name: 'Type your note here...' }).fill('automation therapist test');
    await page.getByRole('button', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation therapist test');
    await page.getByText('Close').click();
    });

});