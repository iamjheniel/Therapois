import { test, expect } from '@playwright/test';
import { IcdManagementPage } from '../../../Pages/superadmin/sa.icd-management.page';

function makeIcdData() {
  const ts = Date.now();
  return {
    code: `QA-${ts}`,
    description: `QA Automation ICD ${ts}`,
    updatedDescription: `QA Automation ICD ${ts} - updated`,
  };
}

test.describe('Super Admin - ICD-Code Verwaltung', () => {
  test.describe.configure({ mode: 'serial' });

  const shared = makeIcdData();

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard');
  });

  // ────────────────────────────────────────────────────
  // Test 1: Create a new ICD Code
  // ────────────────────────────────────────────────────
  test(
    'SA Create ICD-Code',
    { tag: ['@SuperAdmin', '@ICDManagement'] },
    async ({ page }) => {
      const icd = new IcdManagementPage(page);

      await icd.openIcdManagement();
      await icd.openAddIcd();

      await icd.fillIcdForm({
        code: shared.code,
        description: shared.description,
      });

      await icd.save();
      await icd.expectToast('ICD-Code erfolgreich erstellt');

      await icd.search(shared.code);
      await expect(page.locator('#root')).toContainText(shared.code);
    }
  );

  // ────────────────────────────────────────────────────
  // Test 2: Search ICD Code by code
  // ────────────────────────────────────────────────────
  test(
    'SA Search ICD-Code',
    { tag: ['@SuperAdmin', '@ICDManagement'] },
    async ({ page }) => {
      const icd = new IcdManagementPage(page);

      await icd.openIcdManagement();
      await icd.search(shared.code);
      await expect(page.locator('#root')).toContainText(shared.code, {
        timeout: 10_000,
      });
    }
  );

  // ────────────────────────────────────────────────────
  // Test 3: Search with no results
  // ────────────────────────────────────────────────────
  test(
    'SA Search ICD-Code - no results',
    { tag: ['@SuperAdmin', '@ICDManagement'] },
    async ({ page }) => {
      const icd = new IcdManagementPage(page);

      await icd.openIcdManagement();
      await icd.search('ZZZZNOTEXIST99999');
      await expect(page.locator('#root')).toContainText(
        /Keine Ergebnisse|Kein Eintrag|No results/i,
        { timeout: 10_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 4: Update ICD Code description
  // ────────────────────────────────────────────────────
  test(
    'SA Update ICD-Code description',
    { tag: ['@SuperAdmin', '@ICDManagement'] },
    async ({ page }) => {
      const icd = new IcdManagementPage(page);

      await icd.openIcdManagement();
      await icd.search(shared.code);
      await icd.openEditForRow(shared.code);

      const descField = page
        .getByRole('textbox', { name: /Beschreibung/i })
        .first();
      await expect(descField).toBeVisible({ timeout: 10_000 });
      await descField.fill(shared.updatedDescription);

      await icd.save();
      await icd.expectToast('ICD-Code erfolgreich aktualisiert');

      await icd.search(shared.code);
      await expect(page.locator('#root')).toContainText(
        shared.updatedDescription
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 5: Delete ICD Code
  // ────────────────────────────────────────────────────
  test(
    'SA Delete ICD-Code',
    { tag: ['@SuperAdmin', '@ICDManagement'] },
    async ({ page }) => {
      const icd = new IcdManagementPage(page);
      const data = makeIcdData();

      // Create a fresh entry so delete is self-contained
      await icd.openIcdManagement();
      await icd.openAddIcd();
      await icd.fillIcdForm({ code: data.code, description: data.description });
      await icd.save();
      await icd.expectToastAndWaitToDisappear('ICD-Code erfolgreich erstellt');

      // Delete it
      await icd.openIcdManagement();
      await icd.search(data.code);
      await icd.deleteIcd(data.code);
      await icd.expectToast('ICD-Code erfolgreich gelöscht');

      // Verify it's gone
      await icd.search(data.code);
      await expect(page.locator('#root')).not.toContainText(data.code);
    }
  );
});
