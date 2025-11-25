import { test, expect } from '@playwright/test';

test.describe('Therapist Upload Prescription', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Therapist Copayment', { tag: ['@Therapist','@uploadcopayment'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Zuzahlungsbefreiung' }).click();
    await expect(page.locator('#root')).toContainText('Zuzahlungsbefreiung Upload');
    await page.getByTestId( 'button-text' ).click({force:true});
    const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("󰭾Wählen Sie ein Bild zum").click(),]);
    await fileChooser.setFiles("/Users/jhenielguardiana/Documents/Therapois/tests/Therapist/sampleprescription.png");
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Copayment uploaded successfully');
    });

  test('Therapist Copayment View and Add Note', { tag: ['@Therapist', '@AddNoteTherapistCopayment'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Zuzahlungsbefreiung' }).click();
    await expect(page.locator('#root')).toContainText('Zuzahlungsbefreiung Upload');
    await page.getByTestId('button').nth(1).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Copayment Details');
    await page.getByRole('textbox', { name: 'Type your note here...' }).click();
    await page.getByRole('textbox', { name: 'Type your note here...' }).fill('automation therapist test');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation therapist test');
    await page.getByText('Close').click();
    });

});