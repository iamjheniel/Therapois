import {test , expect} from '@playwright/test';

test.use({ storageState: undefined });

test.describe('Admin Search', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Search Active VO Functionality', { tag: '@AdminSearchActiveVo' }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Aktiv').click();
    await page.getByText('Therapeut: (Auswählen)').click();
    await page.getByText('Sandra Zeibig').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Aktiv');
    await expect(page.locator('#root')).toContainText('S. Zeibig');
    });

    test('Admin Search Abgebrochen VO Functionality', { tag: '@AdminSearchAbgebrochenVo' }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Abgebrochen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgebrochen');
    });

    test('Admin Search Fertig behandelt VO Functionality', { tag: '@AdminSearchFertigbehandeltVo' }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByTestId('Fertig Behandelt').getByText('Fertig Behandelt').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig behandelt');    
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Fertig Behandelt');
  
    });

    test('Admin Search Abgelaufen VO Functionality', { tag: '@AdminSearchAbgelaufenVo' }, async ({ page }) => {
    await page.getByText('VO Status').first().click();
    await page.getByText('Abgelaufen').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Abgelaufen');
    });

});