import { test, expect } from '@playwright/test';
import { ArztManagementPage } from '../../../Pages/admin/admin.arzt-management.page';

function makeArztData() {
  const ts = Date.now();
  return {
    ts,
    firstName: `SA${ts}`,
    lastName: `AutoArzt${ts}`,
    doctorId: `${ts}`,
    searchKey: `sa${ts}`.toLowerCase(),
    get updatedLastName() {
      return `${this.lastName}-updated`;
    },
  };
}

test.describe('Super Admin - Arzt Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'SA Create Arzt',
    { tag: ['@SuperAdmin', '@ArztManagement'] },
    async ({ page }) => {
      const arzt = new ArztManagementPage(page);
      const data = makeArztData();

      await arzt.openArztManagement();
      await arzt.openAddArzt();

      await arzt.fillArztForm({
        salutation: 'Herr',
        title: 'Dr.',
        firstName: data.firstName,
        lastName: data.lastName,
        doctorId: data.doctorId,
      });

      await arzt.selectPractice('Orthopädie am Zoo');
      await arzt.save();
      await arzt.expectToast('Arzt erfolgreich erstellt');

      await arzt.search(data.searchKey);
      await expect(page.locator('#root')).toContainText(data.firstName);
    }
  );

  test(
    'SA Search Arzt',
    { tag: ['@SuperAdmin', '@ArztManagement'] },
    async ({ page }) => {
      const arzt = new ArztManagementPage(page);

      await arzt.openArztManagement();
      await arzt.search('SA');
      await expect(page.locator('#root')).toContainText('SA');
    }
  );

  test(
    'SA Update Arzt last name',
    { tag: ['@SuperAdmin', '@ArztManagement'] },
    async ({ page }) => {
      const arzt = new ArztManagementPage(page);

      await arzt.openArztManagement();
      await arzt.search('SA');

      await arzt.openEditForRow('SA');

      const newLastName = `AutoArzt-${Date.now()}`;
      const lastNameField = page.getByRole('textbox', { name: /nachname/i }).first();

      await expect(lastNameField).toBeVisible({ timeout: 10_000 });
      await lastNameField.fill(newLastName);

      await arzt.save();
      await arzt.expectToast('Arzt erfolgreich aktualisiert');

      await arzt.search(newLastName);
      await expect(page.locator('#root')).toContainText(newLastName);
    }
  );

  test(
    'SA Delete Arzt',
    { tag: ['@SuperAdmin', '@ArztManagement'] },
    async ({ page }) => {
      test.fixme(
        true,
        'Delete toast "Arzt erfolgreich gelöscht" appears but the Arzt row is NOT actually removed (re-search still shows it) — backend does not persist the deletion. Same pattern as the staging SA Delete Arzt / ICD update fixme; needs backend investigation.'
      );
      const arzt = new ArztManagementPage(page);
      const data = makeArztData();

      // Create first so delete is self-contained
      await arzt.openArztManagement();
      await arzt.openAddArzt();
      await arzt.fillArztForm({
        salutation: 'Frau',
        title: 'Prof.',
        firstName: data.firstName,
        lastName: data.lastName,
        doctorId: data.doctorId,
      });
      await arzt.selectPractice('Orthopädie am Zoo');
      await arzt.save();
      await arzt.expectToastAndWaitToDisappear('Arzt erfolgreich erstellt');

      // Delete the just-created Arzt
      await arzt.openArztManagement();
      await arzt.search(data.searchKey);
      await arzt.deleteArzt(data.firstName);
      await arzt.expectToast('Arzt erfolgreich gelöscht');

      // Verify it's gone
      await arzt.search(data.searchKey);
      await expect(page.locator('#root')).not.toContainText(data.firstName);
    }
  );
});
