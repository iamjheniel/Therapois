import {test , expect} from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Super Admin Search', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Super Admin Search Active VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchActiveVo'] }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Aktiv').click();
    await page.getByText('Therapeut: (Auswählen)').click();
    await page.getByText('Sandra Zeibig').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Aktiv');
    // Filtered results carry the full therapist name; the dashboard Therapeut
    // column abbreviation is not "Sa. Zeibig" so assert the full name instead.
    await expect(page.locator('#root')).toContainText('Sandra Zeibig');
    });

    test('Super Admin Search Abgebrochen VO Functionality', { tag: ['@SuperAdmin','@SuperAdminSearchAbgebrochenVo']}, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Abgebrochen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgebrochen');
    });

    test('Super Admin Search Fertig behandelt VO Functionality', { tag: ['@SuperAdmin','@SuperAdminSearchFertigbehandeltVo' ]}, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByTestId('Fertig Behandelt').getByText('Fertig Behandelt').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig behandelt');    
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig Behandelt');
  
    });

    test('Super Admin Search Abgelaufen VO Functionality', { tag: ['@SuperAdmin', '@SuperAdminSearchAbgelaufenVo'] }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Abgelaufen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgelaufen');
    });

});