import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Super Admin Heilmittelverwaltung', () => {
  test.describe.configure({ mode: 'serial' });

  // Unique code per test run to avoid "already exists" conflicts
  const uniqueCode = `QA-${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in via storageState
    // Use the robust sidebar nav helper instead of a raw nerd-font glyph click, which flakes
    // when the sidebar hasn't painted yet.
    const app = new AppPage(page);
    await app.navTo(/Heilmittelverwaltung/);
  });

  // ─────────────────────────────────────────────────
  // Test 1: Create a new Heilmittel (treatment type)
  // ─────────────────────────────────────────────────
  test('Create new Heilmittel', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminCreateHeilmittel'] }, async ({ page }) => {
    await page.getByText('Heilmittel hinzufügen').click();

    // Fill in basic information
    await page.getByRole('textbox', { name: 'Description' }).fill('QA Automation Treatment');
    await page.getByRole('textbox', { name: 'Code' }).fill(uniqueCode);
    await page.getByRole('textbox', { name: 'e.g. 20, 30,' }).fill('30');

    // Select Bereich (area) — PT = Physiotherapy
    await page.getByText('Select Bereich').click();
    await page.getByText('PT', { exact: true }).click();

    // Select Kind (type) — Treatment
    await page.getByText('Select Kind').click();
    await page.getByTestId('dropdown-item-Treatment').getByText('Treatment').click();

    // Fill order text
    await page.getByRole('textbox', { name: 'Order text', exact: true }).fill('test automation');

    // Set GKV price — click Update to open the inline price editor
    await page.getByRole('button', { name: 'Update' }).first().click();
    await page.getByRole('textbox', { name: '0,00' }).fill('78,99');

    // Save the price entry first, then save the whole Heilmittel form
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByTestId('surface').filter({ hasText: 'Treatment created successfully' })).toContainText('Treatment created successfully', { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────
  // Test 2: Search for the newly created Heilmittel
  // ─────────────────────────────────────────────────
  test('Search Heilmittel by code', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminSearchHeilmittel'] }, async ({ page }) => {
    await page.getByRole('textbox', { name: 'Search...' }).fill(uniqueCode);
    await page.getByRole('textbox', { name: 'Search...' }).press('Enter');
    await expect(page.locator('#root')).toContainText(uniqueCode, { timeout: 10000 });
  });

  // ─────────────────────────────────────────────────
  // Test 3: Filter by Bereich (area) — ERGO
  // ─────────────────────────────────────────────────
  test('Filter Heilmittel by Bereich (ERGO)', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminFilterBereich'] }, async ({ page }) => {
    // Open the Bereich filter dropdown and select ERGO
    await page.getByText('Alle Bereiche').click();
    await page.getByTestId('dropdown-item-ERGO').click();
    await expect(page.locator('#root')).toContainText('ERGO', { timeout: 10000 });
  });

  // ─────────────────────────────────────────────────
  // Test 4: Filter by Kind (type) — Treatment
  // ─────────────────────────────────────────────────
  test('Filter Heilmittel by Kind (Treatment)', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminFilterKind'] }, async ({ page }) => {
    // Open the Kind filter dropdown and select Treatment
    await page.getByText('Alle Arten').click();
    await page.getByTestId('dropdown-item-Treatment').getByText('Treatment').click();
    await expect(page.locator('#root')).toContainText('Treatment', { timeout: 10000 });
  });

  // ─────────────────────────────────────────────────
  // Test 5: Download the CSV import template (Vorlage)
  // ─────────────────────────────────────────────────
  test('Download Vorlage (CSV template)', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminDownloadVorlage'] }, async ({ page }) => {
    const downloadPromise = page.waitForEvent('download');
    await page.getByText('Vorlage herunterladen').click();
    const download = await downloadPromise;
    // Verify a file was actually downloaded
    expect(download.suggestedFilename()).toBeTruthy();
  });

  // ─────────────────────────────────────────────────
  // Test 6: View CSV Import Logs modal
  // ─────────────────────────────────────────────────
  test('View CSV Import Logs', { tag: ['@SuperAdmin', '@heilmittel', '@SuperAdminImportLogs'] }, async ({ page }) => {
    await page.locator('div').filter({ hasText: /^Logs$/ }).first().click();
    await expect(page.getByTestId('modal-surface')).toContainText('CSV-Import Verlauf', { timeout: 10000 });
    // Close the modal
    await page.getByRole('button', { name: '󰅖' }).click();
  });

});
