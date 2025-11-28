import { test, expect } from '@playwright/test';
import path from 'path';

//test.use({ storageState: path.join(__dirname, '../.auth/AdminJhen.json') });

test.describe('FVO Management', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Check Bestellen Tab', { tag: ['@Admin', '@FVOBestellen'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Bestellen');
    });

    test('Check Bestelt Tab', { tag: ['@Admin', '@FVOBestelt'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await page.getByText('Bestelt').click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Bestellt');
    });

    test('Check Nachverfolgen Tab', { tag: ['@Admin', '@FVONachverfolgen'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();    
    await page.getByText('Nachverfolgen', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Nachverfolgen');

    });

    test('Check Nachverfolgt Tab', { tag: [ '@Admin', '@FVONachverfolgt'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();
    await page.getByText('Nachverfolgt', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('Nachverfolgt');
    });
      
    test('Check Telefonieren Tab', { tag: ['@Admin' , '@FVOTelefonieren'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();  
    await page.getByText('Telefonieren', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Telefonieren');
    });
    
    test('Check Telefoniert Tab', { tag: ['@Admin' ,'@FVOTelefoniert'] }, async ({ page }) => {
    await page.getByText('').click();
    await page.getByRole('button', { name: ' F.VO Bestellung Dashboard' }).click();  
    await page.getByText('Telefoniert', { exact: true }).click();
    await expect(page.locator('#root')).toContainText('Telefoniert');
    });

});