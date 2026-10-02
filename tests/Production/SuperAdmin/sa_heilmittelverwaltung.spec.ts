import { test, expect } from '@playwright/test';

test.describe('Super Admin Heilmittelverwaltung', () => {
  test.describe.configure({ mode: 'serial' });

  // Unique code per test run to avoid "already exists" conflicts

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in via storageState
    // Navigate to Heilmittelverwaltung. The nav button can sit below the fold,
    // so scroll it into view and click via the DOM (RNW scroll-container quirk).
    const navBtn = page.getByRole('button', { name: /Heilmittelverwaltung/ }).last();
    await navBtn.waitFor({ state: 'attached', timeout: 10_000 });
    await navBtn.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
  });
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
