import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Document Treatment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

    test('Document single patient regular treatment', { tag: ['@Therapist','@singleregular'] }, async ({ page }) => {
    await page.getByRole('checkbox').nth(3).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('Regular treatment test automation');
    await page.getByRole('radio').first().click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });
  });

    test('Document single patient BV treatment', { tag: ['@Therapist','@bvtreatment'] }, async ({ page }) => {
    await page.getByRole('checkbox').nth(2).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await page.getByTestId('surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('surface').getByTestId('text-input-outlined').fill('BV treatment test automation');
    await page.getByRole('radio').first().click();
    await page.locator('div:nth-child(2) > div > .css-g5y9jx.r-gbtiil > div > .css-g5y9jx.r-1awozwy > .css-g5y9jx > .css-146c3p1').first().click();
    await page.getByText('HR-H-BV').click();
    await page.getByText('Search and select Heilmittel').click();
    await page.locator('div').filter({ hasText: /^BGM-BV$/ }).nth(3).click();
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });
  });

    test('Document single patient doppel beh treatment', { tag: ['@Therapist','@doppelbeh'] }, async ({ page }) => {
    await page.getByRole('checkbox').nth(7).click({ force: true });
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
    await page.getByRole('checkbox').nth(8).click({ force: true });
    await page.getByRole('checkbox').nth(9).click({ force: true });
    await page.getByRole('checkbox').nth(10).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (3)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (3)󰅖');
    await page.locator('[id="3"]').getByTestId('text-input-outlined').click();
    await page.locator('[id="3"]').getByTestId('text-input-outlined').fill('multiple regular treatment automation');
    await page.locator('[id="5"]').getByTestId('text-input-outlined').click();
    await page.locator('[id="5"]').getByTestId('text-input-outlined').fill('multiple regular treatment automation');
    await page.locator('[id="7"]').getByTestId('text-input-outlined').click();
    await page.locator('[id="7"]').getByTestId('text-input-outlined').fill('multiple regular treatment automation');
    await page.getByRole('button', { name: 'Save' }).click();
    // Wait for backend + UI to stabilize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await expect(page.getByText(/marked as Treated/i).first()).toBeVisible({ timeout: 20000 });

  });

    test('Validate required filleds', { tag: ['@Therapist','@validationerror'] }, async ({ page }) => {
    await page.getByRole('checkbox').nth(3).click({ force: true });
    await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
    await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)󰅖');
    await expect(page.locator('[id="3"]')).toContainText('Bitte alle erforderlichen Felder ausfüllen');
  });

    test('Document reject treatment', { tag: ['@Therapist','@rejecttreatment'] }, async ({ page }) => {
    await page.getByRole('checkbox').nth(12).click({ force: true });
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
    await page.getByRole('checkbox').nth(14).click({ force: true });
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
  await page.getByRole('checkbox').nth(11).click({ force: true });
  await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();
  await page.getByRole('button', { name: ' Aktivität' }).click();
  await page.locator('div').filter({ hasText: /^Pause$/ }).nth(1).click();
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
  await expect(page.getByTestId('surface')).toContainText(
  '1 patients marked as Treated',
  { timeout: 15000 });
  });

});
