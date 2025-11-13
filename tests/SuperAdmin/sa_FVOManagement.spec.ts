import { test, expect } from '@playwright/test';
import path from 'path';

//test.use({ storageState: path.join(__dirname, '../.auth/AdminJhen.json') });

test.describe('Super Admin FVO Management', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Check Bestellen Tab', { tag: ['@SuperAdmin', '@FVOBestellen'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await page.getByText('Bestellen').nth(1).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Bestellen');
    });

    test('Check Bestelt Tab', { tag: ['@SuperAdmin', '@FVOBestelt'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await page.getByText('Bestelt').click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Bestellt');
    });

    test('Check Nachverfolgen Tab', { tag: ['@SuperAdmin', '@FVONachverfolgen'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();    
    await page.getByText('Nachverfolgen', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Nachverfolgen');

    });

    test('Check Nachverfolgt Tab', { tag: [ '@SuperAdmin', '@FVONachverfolgt'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await page.getByText('Nachverfolgt', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('Keine Daten gefunden');
    });
      
    test('Check Telefonieren Tab', { tag: ['@SuperAdmin' , '@FVOTelefonieren'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();  
    await page.getByText('Telefonieren', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Telefonieren');
    });
    
    test('Check Telefoniert Tab', { tag: ['@SuperAdmin' ,'@FVOTelefoniert'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();  
    await page.getByText('Telefoniert', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('Keine Daten gefunden');
    });

});