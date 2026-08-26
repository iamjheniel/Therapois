import { test, expect } from '@playwright/test';

test.describe('Super Admin Dashboard Check all columns', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Super Admin Dashbaord Columns', { tag: ['@SuperAdmin', '@columns'] }, async ({ page }) => {
    await expect(page.locator('#root')).toContainText('Dashboard - Verwaltung');
    await expect(page.locator('#root')).toContainText('Name');
    await expect(page.locator('#root')).toContainText('VO Nr.');
    await expect(page.locator('#root')).toContainText('Geburtsdatum');
    await expect(page.locator('#root')).toContainText('Heilmittel');
    await expect(page.locator('#root')).toContainText('Einrichtung');
    await expect(page.locator('#root')).toContainText('Therapeut');
    await expect(page.locator('#root')).toContainText('Ausst. Datum');
    await expect(page.locator('#root')).toContainText('Praxis');
    await expect(page.locator('#root')).toContainText('Beh. Status');
    await expect(page.locator('#root')).toContainText('Arzt');
    await expect(page.locator('#root')).toContainText('TB');
    await expect(page.locator('#root')).toContainText('Folge-VO Status');
    await expect(page.locator('#root')).toContainText('Bestelldatum');
    await expect(page.locator('#root')).toContainText('Bestellt Datum');
    await expect(page.locator('#root')).toContainText('Nachverfolgen Datum');
    await expect(page.locator('#root')).toContainText('Erhalten Datum');
    await expect(page.locator('#root')).toContainText('Folge-VO');
    await expect(page.locator('#root')).toContainText('Bemerkungen');
    await expect(page.locator('#root')).toContainText('Doppel-Beh.');
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Letzte Notiz');
    await expect(page.locator('#root')).toContainText('Protokolle');
    await expect(page.locator('#root')).toContainText('Bestell Status');
    await expect(page.locator('#root')).toContainText('Doku');
    await page.getByText('VO Status').first().click();
    await page.getByTestId('dropdown-item-Aktiv').click();
    await expect(page.locator('#root')).toContainText('VO Status');
    await expect(page.locator('#root')).toContainText('Aktiv');
    });
});
