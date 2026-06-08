import {test , expect} from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Admin Search', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Search Active VO Functionality', { tag: ['@Admin', '@AdminSearchActiveVo'] }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByTestId('dropdown-item-Aktiv').click();
    // The Therapeut filter is a searchable dropdown listing the therapists
    // available in the current view. Select the first available option rather
    // than a hard-coded name (Sandra Zeibig is no longer offered in this list).
    await page.getByText('Therapeut: (Auswählen)').click();
    await page.getByText('Andreas Rosky', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Aktiv');
    await expect(page.locator('#root')).toContainText('Andreas Rosky');
    });

    test('Admin Search Abgebrochen VO Functionality', { tag: ['@Admin','@AdminSearchAbgebrochenVo']}, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Abgebrochen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgebrochen');
    });

    test('Admin Search Fertig behandelt VO Functionality', { tag: ['@Admin','@AdminSearchFertigbehandeltVo' ]}, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByTestId('Fertig Behandelt').getByText('Fertig Behandelt').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig behandelt');    
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig Behandelt');
  
    });

    test('Admin Search Abgelaufen VO Functionality', { tag: ['@Admin', '@AdminSearchAbgelaufenVo'] }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByTestId('dropdown-item-Abgelaufen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgelaufen');
    });

    test('Admin Search Doctor and Facility', { tag: ['@Admin', '@AdminSearchDoctor'] }, async ({ page }) => {
    await page.getByText('Arzt: (Auswählen)').click();
    await page.getByText('Juri Sloboda').click();
    await expect(page.locator('#root')).toContainText('Ju. Sloboda');
    await page.keyboard.press('Escape'); // close the Arzt dropdown before opening ER
    await page.getByText('ER: (Auswählen)').click();
    await page.getByText('Alpenland Marzahn').click();
    await expect(page.locator('#root')).toContainText('Alpenland Marzahn');
    });
});