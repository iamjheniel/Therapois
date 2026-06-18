import { test, expect } from '@playwright/test';
import { ArztManagementPage } from '../../../Pages/admin/admin.arzt-management.page';

// Small helper to generate unique, reusable test data
function makeArztData() {
  const ts = Date.now();
  const firstName = `Jhen${ts}`;
  const lastName = `Sala${ts}`;
  const doctorId = `${ts}`; // unique, numeric-ish

  return {
    ts,
    firstName,
    lastName,
    doctorId,
    // use this as your search key / row identifier
    searchKey: firstName.toLowerCase(),
    updatedLastName: `${lastName} test`,
  };
}

test.describe('Admin Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

  test(
    'Create Arzt @ArztManagement',
    { tag: ['@Admin', '@ArztManagement'] },
    async ({ page }) => {
      const arzt = new ArztManagementPage(page);
      const data = makeArztData();

      await arzt.openArztManagement();
      await arzt.openAddArzt();

      await arzt.fillArztForm({
        salutation: 'Herr',
        title: 'QA',
        firstName: data.firstName,
        lastName: data.lastName,
        doctorId: data.doctorId,
      });

      await arzt.selectPractice('Orthopädie am Zoo');
      await arzt.save();
      await arzt.expectToast('Arzt erfolgreich erstellt');

      // Optional: quick verify it exists
      await arzt.search(data.searchKey);
      await expect(page.locator('#root')).toContainText(data.firstName);
    }
  );

  test(
    'Search Arzt',
    { tag: ['@Admin', '@ArztManagement'] },
    async ({ page }) => {
      const arzt = new ArztManagementPage(page);
      await arzt.openArztManagement();
      await arzt.search('jhen');
      await expect(page.locator('#root')).toContainText('Jhen');
    }
  );

  test('Update Arzt last name only', { tag: ['@Admin', '@ArztManagement'] }, async ({ page }) => {
    const arzt = new ArztManagementPage(page);

    await arzt.openArztManagement();
    await arzt.search('jhen');

    await arzt.openEditForRow('Jhen');

    const newLastName = `Sala-${Date.now()}`;

    const lastNameField = page.getByRole('textbox', { name: /nachname/i }).first();

    await expect(lastNameField).toBeVisible({ timeout: 10000 });
    await lastNameField.fill(newLastName);

    await arzt.save();
    await arzt.expectToast('Arzt erfolgreich aktualisiert');

    // optional: verify list shows updated last name
    await arzt.search(newLastName);
    await expect(page.locator('#root')).toContainText(newLastName);
  });


  test(
    'Delete Arzt',
    { tag: ['@Admin', '@ArztManagement'] },
    async ({ page }) => {
      test.fixme(
        true,
        'Delete toast "Arzt erfolgreich gelöscht" appears but the Arzt row is NOT actually removed (re-search still shows it, "1-1 of 1") — backend does not persist the deletion. Same pattern as the SA Delete Arzt / ICD update fixme; needs backend investigation.'
      );
      const arzt = new ArztManagementPage(page);
      const data = makeArztData();

      // Create first (so delete is flexible + independent)
      await arzt.openArztManagement();
      await arzt.openAddArzt();
      await arzt.fillArztForm({
        salutation: 'Herr',
        title: 'QA',
        firstName: data.firstName,
        lastName: data.lastName,
        doctorId: data.doctorId,
      });
      await arzt.selectPractice('Orthopädie am Zoo');
      await arzt.save();
      await arzt.expectToastAndWaitToDisappear('Arzt erfolgreich erstellt');

      // Delete created Arzt
      await arzt.openArztManagement();
      await arzt.search(data.searchKey);
      await arzt.deleteArzt(data.firstName);
      await arzt.expectToast('Arzt erfolgreich gelöscht');

      // Optional: verify gone
      await arzt.search(data.searchKey);
      await expect(page.locator('#root')).not.toContainText(data.firstName);
    }
  );
});
