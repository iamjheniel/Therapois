import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Define all production accounts
const accounts = [
  {
    name: 'Jhen QA',
    email: 'jhenqa@therapios.de',
    password: '12345678',
    authFile: path.join(__dirname, '../.auth/JhenQA-Prod.json'),
  },
  {
    name: 'Admin Jhen',
    email: 'admin.jhen@gmail.com',
    password: '12345678',
    authFile: path.join(__dirname, '../.auth/AdminJhen-Prod.json'),
  },
  {
    name: 'SA Jhen',
    email: 'sa.jhen@gmail.com',
    password: 'thera.rocks',
    authFile: path.join(__dirname, '../.auth/SuperAdmin-Prod.json'),
  },
];

setup.use({ storageState: undefined });

// Loop through accounts
for (const user of accounts) {
  setup(`[Prod] Create ${user.name} auth if missing`, async ({ page, context }) => {
    if (fs.existsSync(user.authFile)) {
      console.log(`✅ Prod auth state for ${user.name} already exists — skipping login.`);
      return;
    }

    console.log(`Logging in as ${user.name} on production...`);

    await page.goto('https://app.therapios.de/');

    // fill login form
    await page.getByTestId('text-input-outlined').first().fill(user.email);
    await page.locator('input[type="password"]').fill(user.password);

    // click submit and wait for navigation to complete
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30_000 }),
      page.locator('div').filter({ hasText: /^Proceed$/ }).first().click(),
    ]);

    // confirm we left the login page
    await expect(page.locator('input[type="password"]')).not.toBeVisible({ timeout: 15_000 });

    // save session
    await context.storageState({ path: user.authFile });

    console.log(`✅ Prod auth state saved for ${user.name} → ${user.authFile}`);
  });
}
