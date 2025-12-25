import { test, expect } from '@playwright/test';
//test.use({ storageState: undefined });

test.describe('Notification functionality', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/'); // already logged in due to storageState
  });

  test('Therapist UI Banner Notification', { tag: ['@Therapist','@notification'] }, async ({ page }) => {

    // Assert notification banner appears
    await expect(page.getByText(/You have .* unread notifications/i)).toBeVisible();

    // Extract unread count (optional)
    const text = await page.getByText(/You have .* unread notifications/i).textContent();
    console.log("NOTIF TEXT:", text);

    // Locate View button inside the banner
    const viewBtn = page.getByText(/^View$/).first();

    // Assert it appears
    await expect(viewBtn).toBeVisible();

    // Click it
    await viewBtn.click({force:true});
    // Assert navigation to Notifications page
    await expect(page.getByRole('dialog')).toContainText('Notifications');
    await expect(page.getByRole('dialog')).toContainText(/My Notifications/i);
    await page.getByRole('dialog').getByText('').click();
    //Dismiss header
    await page.locator('div').filter({ hasText: /^$/ }).first().click();
    await expect(page.getByText(/Notifications/i)).not.toBeVisible();

    });

  test('Therapist UI Bell Notification', { tag: ['@Therapist','@bellnotification'] }, async ({ page }) => {
    await page.getByText('').click();
    await expect(page.locator('#root')).toContainText('Notifications');
    await expect(page.locator('#root')).toContainText(/My Notifications/i);
    await page.getByText('').nth(1).click();    

  });
  
  test('Therapist Mark as Read', { tag: ['@Therapist','@markasread'] }, async ({ page }) => {
    await page.getByText('').click();
    await expect(page.locator('#root')).toContainText('Notifications');
    await expect(page.locator('#root')).toContainText('Mark as Read');
    await page.getByText('Mark as Read').first().click({force:true});
    await page.getByText('Read').click();
    await expect(page.locator('#root')).toContainText(/VO /);
  });
});