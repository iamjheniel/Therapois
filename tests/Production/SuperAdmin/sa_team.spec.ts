import { test, expect, Page } from '@playwright/test';

// Robustly navigate to the Team page (sidebar nav can be below the fold).
async function openTeam(page: Page) {
  const navBtn = page.getByRole('button', { name: ' Team' }).last();
  await navBtn.waitFor({ state: 'attached', timeout: 10_000 });
  await navBtn.evaluate((el: HTMLElement) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });
}

async function searchUsers(page: Page, term: string) {
  const search = page.getByRole('textbox', { name: 'Benutzer suchen' });
  await search.click();
  await search.fill(term);
  await search.press('Enter');
  await page.waitForTimeout(1500);
}

// Open the edit form for the row matching `rowText` (e.g. a unique email).
// Each data row is a `.r-qklmqi` wrapper; the Aktion (last) cell holds a single
// clickable edit control with the stable classes `.r-1i6wzkk.r-1ux3glh`.
async function openEditForRow(page: Page, rowText: string | RegExp) {
  const row = page.locator('.r-qklmqi').filter({ hasText: rowText }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const editBtn = row.locator('.r-1i6wzkk.r-1ux3glh').first();
  await editBtn.scrollIntoViewIfNeeded();
  await editBtn.click({ force: true });
  // Edit form is open once the last-name field renders
  await expect(page.getByRole('textbox', { name: 'e.g. Bond' })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Super Admin Team', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Super Admin Team Account Creation', { tag: ['@SuperAdmin', '@accountcreation'] }, async ({ page }) => {
    // Generate unique values
    const timestamp = Date.now();
    const uniqueEmpId = `test${timestamp}`;
    const uniqueEmail = `automation_${timestamp}@gmail.com`;

    await openTeam(page);
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
    await openTeam(page);
    await searchUsers(page, 'automation');

    // Act on the first automation test user (never a real admin account)
    await openEditForRow(page, /automation_\d+@gmail\.com/);

    // Generate a unique last name so the save button gets enabled
    const updatedLastName = `Updated_${Date.now()}`;
    await page.getByRole('textbox', { name: 'e.g. Bond' }).fill(updatedLastName);

    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(page.getByTestId('surface')).toContainText('User updated successfully');
  });

  test('Super Admin Inactivate + Activate User', { tag: ['@SuperAdmin', '@inactivateuser'] }, async ({ page }) => {
    await openTeam(page);
    await searchUsers(page, 'automation');

    // Capture the email of the first automation user so we can re-open the same
    // row to restore its state afterwards.
    const emailText = await page
      .getByText(/automation_\d+@gmail\.com/)
      .first()
      .textContent();
    const email = (emailText || '').trim();
    expect(email).toMatch(/automation_\d+@gmail\.com/);

    // Inactivate
    await openEditForRow(page, email);
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(page.getByTestId('surface')).toContainText('User updated successfully');
    await expect(page.locator('#root')).toContainText('Inaktiv ✗');

    // Reactivate (restore original state for idempotency)
    await searchUsers(page, 'automation');
    await openEditForRow(page, email);
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(page.getByTestId('surface')).toContainText('User updated successfully');
    await expect(page.locator('#root')).toContainText('Aktiv ✓');
  });
});
