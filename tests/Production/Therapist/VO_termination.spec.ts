import { test ,  expect } from '@playwright/test';

test.describe('VO Termination', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Non-immediate termination (Keine Folge-VO bestellen)', { tag: '@KFvo' }, async ({ page }) => {
    await page.getByTestId('text-input-outlined').fill('JhenTest QA');
    await page.getByTestId('text-input-outlined').press('Enter');
    await page.waitForTimeout(1500);
    await page.getByRole('checkbox').first().click({ force: true });
    await page.getByRole('button', { name: 'Abbrechen VO' }).click();
    await page.getByText('Keine Folge-VO Bestellen').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('keine folge- VO termination automation');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('#root')).toContainText('Keine Folge-VO');
});
});