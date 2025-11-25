import { test, expect } from '@playwright/test';

//test.use({ storageState: undefined });

test.describe('Calendar', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Calendar document treatment', { tag : ['@Therapist', '@calendar'] }, async ({ page }) => {
    await page.getByText('Kalender').click();
    await page.getByText('Doku erfassen').click();
    await expect(page.locator('#root')).toContainText('Offene VOs');
    await expect(page.locator('#root')).toContainText('Franz Abitz');
  });

//   test('Calendar edit document treatment', { tag : ['@Therapist', '@editcalendar'] }, async ({ page }) => {
//     await page.getByText('Kalender').click();
//     await page.getByText('Andreas Bloch').click();
//     await page.getByTestId('text-input-outlined').click();
//     await page.getByTestId('text-input-outlined').fill('online bv treatment edit automation');
//     await page.getByRole('button', { name: 'Save' }).click();
//     await expect(page.getByTestId('surface')).toContainText('Activity updated');
//     await page.locator('[id="61"] > div > .css-g5y9jx.r-14lw9ot > .css-g5y9jx.r-1loqt21.r-1otgn73 > .css-g5y9jx.r-1awozwy > .css-146c3p1.r-dnmrzs').click();
//     await page.getByTestId('surface').getByTestId('icon-button').click();
//     await page.getByText('Andreas Bloch#113/BV (15 mins').click();
//     await expect(page.getByTestId('text-input-outlined')).toContainText('online bv treatment edit automation');
// });
});