import { test, expect, Page } from '../../fixtures/session';

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

/**
 * **These tests act on `automation_*@gmail.com` users that PAST runs left in production.**
 *
 * The account-creation test was removed on 2026-10-02 — it created a real login on the production
 * system (with the password `12345678`) and never deleted it, so every run added one. The Edit and
 * Inactivate tests below search for `automation` and act on whichever such user they find, so they
 * still work; but they depend on that residue, and once the production team clears those accounts
 * these two have no fixture and should be retired with them.
 */
test.describe('Super Admin Team', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });
  test('Super Admin Edit User', { tag: ['@SuperAdmin', '@edituser'] }, async ({ page }) => {
    // DISABLED: edits a real user account.
    test.skip(true, 'Production is read-only (2026-10-02): this test writes to the live system: it edits a real user account.');
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
    // DISABLED: deactivates and reactivates a real user account.
    test.skip(true, 'Production is read-only (2026-10-02): this test writes to the live system: it deactivates and reactivates a real user account.');
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
