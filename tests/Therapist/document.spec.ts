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
    await page.getByText('Zuzahlungsdokumente hochladen').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie ein Bild zum").click(),
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
    await page.getByTestId('modal-surface').getByText('Patient Info').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie ein Bild zum").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Patient Info');
    });
  
  test('Therapist Gebührenvereinbarung', { tag: ['@Therapist','@uploadGebührenvereinbarung'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByTestId('modal-surface').getByText('Gebührenvereinbarung', { exact: true }).click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie ein Bild zum").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Gebührenvereinbarung');
    });

  test('Therapist Sonstiges', { tag: ['@Therapist','@uploadsontiges'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click();
    await page.getByRole('button', { name: '󰩎 Dokument hochladen' }).click();
    await page.getByText('SonstigesAndere Dokumente').click();
     const filePath = path.join(__dirname, "sampleprescription.png");
     console.log("FILE PATH:", filePath);  // debug
 
     const [fileChooser] = await Promise.all([
       page.waitForEvent("filechooser"),
       page.getByText("Wählen Sie ein Bild zum").click(),
     ]);
 
    await fileChooser.setFiles(filePath);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByTestId('surface')).toContainText('Dokument erfolgreich hochgeladen');
    await expect(page.locator('#root')).toContainText('Sonstiges');
    });

  test('Therapist Copayment View and Add Note', { tag: ['@Therapist', '@AddNoteTherapistCopayment'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' Dokument' }).click({force:true});
    await page.getByRole('button', { name: 'View' }).first().click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('test automation');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('test automation');
    await page.getByTestId('icon-button').click();
    });

});