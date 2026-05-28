import { test, expect } from '@playwright/test';

test.describe('Super Admin Team', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test('Super Admin Team Account Creation', { tag: ['@SuperAdmin', '@accountcreation'] }, async ({ page }) => {
    // Generate unique values
    const timestamp = Date.now();
    const uniqueEmpId = `test${timestamp}`;
    const uniqueEmail = `automation_${timestamp}@gmail.com`;

    await page.getByText('').click();
    await page.getByRole('button', { name: ' Team' }).click();
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
  await page.getByText('').click();
  await page.getByRole('button', { name: ' Team' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).fill('automation');
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).press('Enter');
  await page.waitForLoadState('networkidle');
  await page.locator('div:nth-child(2) > .css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi > div > div:last-child > .css-g5y9jx').first().click();
 // generate a unique last name so save button gets enabled
  const updatedLastName = `Updated_${Date.now()}`;
  await page.getByRole('textbox', { name: 'e.g. Bond' }).fill(updatedLastName);
  // Now the button becomes enabled
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(page.getByTestId('surface')).toContainText('User updated successfully');
});

  test('Super Admin Inactivate + Activate User', { tag: ['@SuperAdmin', '@inactivateuser'] }, async ({ page }) => {
  await page.getByText('').click();
  await page.getByRole('button', { name: ' Team' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).click();
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).fill('automation');
  await page.getByRole('textbox', { name: 'Benutzer suchen' }).press('Enter');
  await page.waitForLoadState('networkidle');

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
