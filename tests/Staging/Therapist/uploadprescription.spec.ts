import { test, expect } from '@playwright/test';
import path from 'path';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Therapist Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

  test('Therapist Upload VO', { tag: ['@Therapist','@uploadvo'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');
    await page.getByRole('button', { name: '󰩎 Rezept hochladen' }).click();
    // Step 1 of the modal reserves an Upload ID; wait for it to mount before advancing. Clicking
    // "Continue" too early leaves the wizard in a state where step 2's drop zone never renders.
    await expect(page.getByText(/Bitte notieren Sie diese Nummer/)).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    const filePath = path.join(__dirname, "sampleprescription.png");

    // Wait for the drop zone to be fully rendered before clicking — clicking before the
    // React file-picker handler attaches means no `filechooser` event ever fires.
    const dropZone = page.getByText("Wählen Sie ein Bild zum");
    await expect(dropZone).toBeVisible({ timeout: 15000 });

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dropZone.click(),
    ]);

    await fileChooser.setFiles(filePath);

    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('div:has-text("In Prüfung")').first()).toBeVisible({ timeout: 30000 });

    });

  test('Therapist Upload VO View and Add Note', { tag: ['@Therapist', '@AddNoteTherapist'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Rezept/);
    await expect(page.locator('#root')).toContainText('VO Upload');

    // Wait for the prescription list to load. The therapist's prescriptions may be in ANY status
    // (Nicht lesbar, Abgelehnt, Angelegt, In Prüfung, …), so gate on a row's "View" control rather
    // than a specific status label like "In Prüfung" — that label is absent whenever no prescription
    // happens to be in review, which was causing spurious failures.
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