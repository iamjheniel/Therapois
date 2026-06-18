import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';

test.describe('Super Admin Team', () => {
  test.beforeEach(async ({ page }) => {
    // Wait for the DOM only — Staging/Production keep the `load`/network busy via polling.
    await new AppPage(page).goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Super Admin Team Account Creation', { tag: ['@SuperAdmin', '@accountcreation'] }, async ({ page }) => {
    const app = new AppPage(page);
    // Generate unique values
    const timestamp = Date.now();
    const uniqueEmpId = `test${timestamp}`;
    const uniqueEmail = `automation_${timestamp}@gmail.com`;

    await app.navTo(/Team/);
    await page.getByText('Nutzer hinzufügen').click();

    // Select role
    await page.locator('div').filter({ hasText: /^Rolle auswählen$/ }).first().click();
    await page.getByTestId('Therapist').click();

    // Employee ID
    await page.getByRole('textbox', { name: 'e.g. EMP12345' }).fill(uniqueEmpId);

    // Name fields
    await page.getByRole('textbox', { name: 'e.g. James' }).fill('Automation');
    await page.getByRole('textbox', { name: 'e.g. Bond' }).fill('Test');

    // Email (unique)
    await page.getByRole('textbox', { name: 'e.g. user@example.com' }).fill(uniqueEmail);

    // Password
    await page.getByRole('textbox', { name: 'Passwort eingeben' }).fill('12345678');
    await page.getByRole('textbox', { name: 'Passwort erneut eingeben' }).fill('12345678');

    // Submit
    await page.getByRole('button', { name: 'Hinzufügen' }).click();

    // Assertion
    await expect(page.getByTestId('surface')).toContainText('User created successfully');
  });

  test('Super Admin Edit User', { tag: ['@SuperAdmin', '@edituser'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Team/);
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).fill('automation');
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).press('Enter');
  // Open the first matching user's edit panel via its row action icon (the rightmost img
  // in the row). Mirrors the reliable approach used by the inactivate test instead of the
  // previous brittle bounding-box/svg heuristic.
  const emailCells = page.getByText(/automation_\d+@gmail\.com/);
  await expect(emailCells.first()).toBeVisible({ timeout: 15000 });
  const row = emailCells.first().locator(
    'xpath=ancestor::*[self::div][.//*[@role="img" or self::img]][1]'
  );
  await row.getByRole('img').last().click();
 // generate a unique last name so save button gets enabled
  const updatedLastName = `Updated_${Date.now()}`;
  const lastNameField = page.getByRole('textbox', { name: 'e.g. Bond' });
  await expect(lastNameField).toBeVisible({ timeout: 15000 });
  await lastNameField.fill(updatedLastName);
  // Now the button becomes enabled
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(page.getByTestId('surface')).toContainText('User updated successfully');
});

  test('Super Admin Inactivate + Activate User', { tag: ['@SuperAdmin', '@inactivateuser'] }, async ({ page }) => {
    const app = new AppPage(page);
    await app.navTo(/Team/);
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).fill('automation');
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).press('Enter');

  // Open the edit panel for the third automation row via its action icon.
  const openThirdRowEdit = async () => {
    const emailCells = page.getByText(/automation_\d+@gmail\.com/);
    await expect(emailCells.nth(2)).toBeVisible({ timeout: 10_000 });
    const thirdEmail = emailCells.nth(2);
    const row = thirdEmail.locator(
      'xpath=ancestor::*[self::div][.//*[@role="img" or self::img]][1]'
    );
    await row.getByRole('img').last().click();
  };

  await openThirdRowEdit();
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(page.locator('html')).toContainText('User updated successfully');
  await expect(page.locator('#root')).toContainText('Inaktiv ✗');
  //activate again for test idempotency
  await openThirdRowEdit();
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(page.locator('html')).toContainText('User updated successfully');
  await expect(page.locator('#root')).toContainText('Aktiv ✓');
});
});
