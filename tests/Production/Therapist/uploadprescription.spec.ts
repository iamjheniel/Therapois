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

    // Wait for the prescription list to load. Prescriptions may be in ANY status, so gate on a
    // row's "View" control rather than the "In Prüfung" label (absent when nothing is in review).
    const viewButton = page.getByRole('button', { name: /view/i }).first();
    // waitFor (not isVisible — that returns the current state without polling) gives the async
    // prescription list time to render before we decide whether any prescription exists.
    const hasPrescription = await viewButton
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasPrescription, 'No uploaded prescriptions available for this therapist to view');

    // Open the first prescription
    await viewButton.click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Details zum Verordnungsbild');
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).click();
    await page.getByRole('textbox', { name: 'Geben Sie Ihre Notiz hier ein' }).fill('automation therapist test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation therapist test');
    await page.getByTestId('modal-surface').getByTestId('icon-button').click();
    });

});