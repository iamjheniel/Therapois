import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Therapist Upload Documents', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Therapist Copayment', { tag: ['@Therapist','@uploadcopayment'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByTestId('modal-surface').getByText('Zuzahlungsbefreiung').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie eine Datei").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Zuzahlung');
    });
  
  test('Therapist Patient Info', { tag: ['@Therapist','@uploadpatientinfo'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByTestId('modal-surface').getByText('Patienteninformationsbogen').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie eine Datei").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Patienteninformationsbogen');
    });
  
  test('Therapist Honorarvereinbarung', { tag: ['@Therapist','@uploadHonorarvereinbarung'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByTestId('modal-surface').getByText('Honorarvereinbarung').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie eine Datei").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Honorarvereinbarung');
    });

  test('Therapist Sonstiges', { tag: ['@Therapist','@uploadsontiges'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByText('Andere', { exact: true }).click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie eine Datei").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Andere');
    });

  test('Therapist Copayment View and Add Note', { tag: ['@Therapist', '@AddNoteTherapistCopayment'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: 'View' }).nth(1).click({force:true});
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test automation');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('test automation');
    await page.getByTestId('modal-surface').getByTestId('icon-button').click();
    });

});