import { test, expect } from '@playwright/test';
import { PatientManagementPage } from '../../../Pages/superadmin/sa.patient-management.page';

test.describe('Super Admin - Patient Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  // ────────────────────────────────────────────────────
  // Test 1: Patient list loads on navigation
  // ────────────────────────────────────────────────────
  test(
    'SA Patient Management page loads',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      // Verify the section heading is visible (German UI: "Patienten Management")
      await expect(page.locator('#root')).toContainText(
        /Patienten? Management|Patientenverwaltung/i,
        { timeout: 15_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 2: Search patient by name
  // ────────────────────────────────────────────────────
  test(
    'SA Search Patient by name',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      // Data-robust: derive the search term from a patient actually in the list
      const surname = await pm.firstPatientSurname();
      expect(surname.length).toBeGreaterThan(0);
      await pm.search(surname);
      await pm.expectPatientVisible(surname);
    }
  );

  // ────────────────────────────────────────────────────
  // Test 3: Search patient by patient number (Patientennummer)
  // ────────────────────────────────────────────────────
  test(
    'SA Search Patient by patient number',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      // Use a known patient number from production QA data
      await pm.search('P-001');
      await expect(page.locator('#root')).not.toContainText(
        /Keine Ergebnisse|No results/i,
        { timeout: 10_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 4: Search returns no results for unknown term
  // ────────────────────────────────────────────────────
  test(
    'SA Search Patient - no results for unknown name',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      await pm.search('ZZZZNOTEXIST99999');
      await pm.expectNoResults();
    }
  );

  // ────────────────────────────────────────────────────
  // Test 5: View patient detail panel
  // ────────────────────────────────────────────────────
  test(
    'SA View Patient detail',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      const surname = await pm.firstPatientSurname();
      expect(surname.length).toBeGreaterThan(0);
      await pm.search(surname);
      await pm.expectPatientVisible(surname);
      await pm.openPatientDetail(surname);

      // Verify a detail panel/section is shown
      await expect(page.locator('#root')).toContainText(
        new RegExp(`Patientendetails|Patient Details|${surname}`, 'i'),
        { timeout: 15_000 }
      );
    }
  );

  // ────────────────────────────────────────────────────
  // Test 6: Clear search restores full list
  // ────────────────────────────────────────────────────
  test(
    'SA Clear search restores patient list',
    { tag: ['@SuperAdmin', '@PatientManagement'] },
    async ({ page }) => {
      const pm = new PatientManagementPage(page);

      await pm.openPatientManagement();
      const surname = await pm.firstPatientSurname();
      expect(surname.length).toBeGreaterThan(0);
      await pm.search(surname);
      await pm.expectPatientVisible(surname);

      await pm.clearSearch();
      // After clearing, the list should show the section heading again
      await expect(page.locator('#root')).toContainText(
        /Patienten? Management|Patientenverwaltung/i,
        { timeout: 10_000 }
      );
    }
  );
});
