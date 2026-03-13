import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Document Treatment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });


  test('Create treatment then open Doku and delete treatment activity', {tag: ['@Therapist','@singleregular']}, async ({ page }) => {
  // Using Martina Gerth - confirmed available in staging via search tests
  const patientName = 'Martina Gerth';
  const treatmentNote = 'Regular treatment test automation';

  // Search for patient to ensure she's visible regardless of today's schedule
  await page.getByTestId('text-input-outlined').fill(patientName);
  await page.getByTestId('text-input-outlined').press('Enter');
  await page.waitForTimeout(1500);

  await page.getByRole('checkbox').first().click({ force: true });
  await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();

  await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');

  await page.getByTestId('surface').getByTestId('text-input-outlined').click();
  await page.getByTestId('surface').getByTestId('text-input-outlined').fill(treatmentNote);

  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Save' }).click();

  // backend + UI stabilize
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });

  await page.getByText(patientName, { exact: true }).first().click();
  await page.locator('div').filter({ hasText: /^$/ }).nth(1).click();
  // Click the first treatment row's action cell (most recent treatment appears first)
  await page.locator('.css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi').first().locator('div > div:nth-child(6) > .css-g5y9jx').click({ force: true });

  // wait edit activity
  await expect(page.getByText('Edit Activity', { exact: true })).toBeVisible({ timeout: 20000 });

  // ✅ Click trash
  const trash = page.getByTestId('activity-delete-button');
  await expect(trash).toBeVisible({ timeout: 10000 });
  await trash.click();

  await expect(page.getByText('Are you sure?', { exact: true })).toBeVisible({ timeout: 10000 });

  const confirmDialog = page.getByText('Are you sure?', { exact: true }).locator('xpath=ancestor::div[2]');
  const jaText = confirmDialog.locator('[data-testid="button-text"]', { hasText: 'Ja' });

  await jaText.locator('xpath=ancestor::button[1]').click();

  // Assert toast
  await expect(page.getByText(/Treatment deleted!/i)).toBeVisible({ timeout: 20000 });

});

    test('Document single patient BV treatment', { tag: ['@Therapist','@bvtreatment'] }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').fill('Martina Gerth');
    await page.getByTestId('text-input-outlined').press('Enter');
    await page.waitForTimeout(1500);
    await page.getByRole('checkbox').first().click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('BV treatment test automation');
    await page.getByRole('radio').first().click();
    // Click Heilmittelgruppe dropdown - use partial text match for the dropdown placeholder
    await page.getByText(/heilmittelgruppe/i, { exact: false }).first().click();
    await page.getByText('HR-H-BV').click();
    await page.getByText('Search and  select Heilmittel').click();
    await page.locator('div').filter({ hasText: /^BGM-BV$/ }).nth(3).click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });
  });

    test('Document single patient doppel beh treatment', { tag: ['@Therapist','@doppelbeh'] }, async ({ page }) => {
    await page.getByRole('checkbox').first().waitFor();
    await page.getByRole('checkbox').nth(3).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('Doppel beh treatment test automation');
    await page.getByRole('radio').first().click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });
  });

    test('Document multiple patients regular treatment', { tag: ['@Therapist','@multipleregular'] }, async ({ page }) => {
    await page.getByRole('checkbox').first().waitFor();
    await page.getByRole('checkbox').nth(8).click({ force: true });
    await page.getByRole('checkbox').nth(9).click({ force: true });
    await page.getByRole('checkbox').nth(10).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (3)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (3)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').nth(0).fill('multiple regular treatment automation');
    await page.getByTestId('surface').getByTestId('text-input-outlined').nth(1).fill('multiple regular treatment automation');
    await page.getByTestId('surface').getByTestId('text-input-outlined').nth(2).fill('multiple regular treatment automation');
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });

  });

    test('Validate required fields', { tag: ['@Therapist','@validationerror'] }, async ({ page }) => {
    await page.getByRole('checkbox').first().waitFor();
    await page.getByRole('checkbox').nth(3).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface').first()).toContainText('Mark as Treated (1)󰅖');
    await expect(page.getByText('Bitte alle erforderlichen Felder ausfüllen').first()).toBeVisible();
  });

    test('Document reject treatment', { tag: ['@Therapist','@rejecttreatment'] }, async ({ page }) => {
    await page.getByRole('checkbox').first().waitFor();
    await page.getByRole('checkbox').nth(7).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('reject automation test');
    await page.locator('.css-g5y9jx.r-14lw9ot > div > div:nth-child(2) > .css-g5y9jx.r-1awozwy.r-18u37iz > div > .css-g5y9jx.r-1otgn73').click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });

  });

    test('Document planned treatment', { tag: ['@Therapist','@plannedtreatment'] }, async ({ page }) => {
    await page.getByRole('checkbox').first().waitFor();
    await page.getByRole('checkbox').nth(5).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('planned treatment automation');
    await page.getByRole('radio').nth(1).click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });
  });

  test('Document activity', { tag: ['@Therapist','@activity'] }, async ({ page }) => {
  await page.getByRole('checkbox').first().waitFor();
  await page.getByRole('checkbox').nth(6).click({ force: true });
  await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
  await page.getByRole('button', { name: ' Aktivität' }).click();
  await page.locator('div').filter({ hasText: /^Pause$/ }).nth(1).click();
  await page.getByText('Other').click();
  await page.getByRole('textbox', { name: 'Enter custom activity' }).click();
  await page.getByRole('textbox', { name: 'Enter custom activity' }).fill('dance');
  await page.getByRole('textbox', { name: 'In minutes' }).click();
  await page.getByRole('textbox', { name: 'In minutes' }).fill('20');
  await page.getByRole('textbox', { name: 'Doku eingeben' }).click();
  await page.getByRole('textbox', { name: 'Doku eingeben' }).fill('automation test');
  await page.getByRole('button', { name: 'Save' }).click();
  // Wait for backend + UI to stabilize
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  // Scope to the toast notification surface (aria-live="polite") to avoid strict mode violation
  await expect(page.locator('[aria-live="polite"][data-testid="surface"]')).toContainText(
  /patients marked as Treated/i,
  { timeout: 15000 });
  });

});
