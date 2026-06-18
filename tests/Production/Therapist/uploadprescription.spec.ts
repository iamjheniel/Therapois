import { test, expect } from '@playwright/test';
import path from 'path';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Therapist Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

  test('Therapist Upload VO', { tag: ['@Therapist','@uploadvo'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: '󰩎 Rezept hochladen' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    const filePath = path.join(__dirname, "../../Staging/Therapist/sampleprescription.png");
    console.log("FILE PATH:", filePath);  // debug

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByText("Wählen Sie ein Bild zum").click(),
    ]);

    await fileChooser.setFiles(filePath);

    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('div:has-text("In Prüfung")').first()).toBeVisible({ timeout: 30000 });

    });

  test('Therapist Upload VO View and Add Note', { tag: ['@Therapist', '@AddNoteTherapist'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    // Wait for the list to load prescriptions
    await expect(page.locator('div:has-text("In Prüfung")').first()).toBeVisible({ timeout: 30000 });

    // Click the first "View" button of the prescription
    const viewButton = page.getByRole('button', { name: /view/i }).first();
    await viewButton.click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Details zum Verordnungsbild');
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).fill('automation therapist test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation therapist test');
    await page.getByTestId('modal-surface').getByTestId('icon-button').click();
    });

});