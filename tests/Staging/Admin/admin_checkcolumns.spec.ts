import { test, expect } from '@playwright/test';

test.describe('Admin Dashboard', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard'); // already logged in due to storageState
  });

    test('Admin Dashbaord Columns', { tag: ['@Admin', '@columns'] }, async ({ page }) => {
    await expect(page.locator('#root')).toContainText('Dashboard - Verwaltung');
    await expect(page.locator('#root')).toContainText('Name');
    await expect(page.locator('#root')).toContainText('VO Nr.');
    await expect(page.locator('#root')).toContainText('Geburtsdatum');
    await expect(page.locator('#root')).toContainText('Heilmittel');
    await expect(page.locator('#root')).toContainText('ICD');
    await expect(page.locator('#root')).toContainText('Einrichtung');
    await expect(page.locator('#root')).toContainText('Therapeut');
    await expect(page.locator('#root')).toContainText('Ausst. Datum');
    await expect(page.locator('#root')).toContainText('Transfer Status');
    await expect(page.locator('#root')).toContainText('Beh. Status');
    await expect(page.locator('#root')).toContainText('Arzt');
    await expect(page.locator('#root')).toContainText('TB');
    await expect(page.locator('#root')).toContainText('F.-VO Status');
    await expect(page.locator('#root')).toContainText('Bestellen Date');
    await expect(page.locator('#root')).toContainText('Bestellt Datum');
    await expect(page.locator('#root')).toContainText('Nachverfolgen Datum');
    await expect(page.locator('#root')).toContainText('Erhalten Datum');
    await expect(page.locator('#root')).toContainText('F.-VO');
    await expect(page.locator('#root')).toContainText('Bemerkungen');
    await expect(page.locator('#root')).toContainText('Doppel-Beh.');
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Letzte Notiz');
    await expect(page.locator('#root')).toContainText('Protokolle');
    await expect(page.getByText('Bestell Status')).toBeVisible();
    await expect(page.locator('#root')).toContainText('Doku');
    await page.getByText('VO Status').first().click();
    await page.getByTestId('dropdown-item-Aktiv').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Aktiv');
    });
});
