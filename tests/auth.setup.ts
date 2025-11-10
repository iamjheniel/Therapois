import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Define all accounts you want to log in as
const accounts = [
  {
    name: 'Sandra Zeibig',
    email: 'sandra.zeibig.66@therapios.com',
    password: '12345678',
    authFile: path.join(__dirname, '../.auth/SandraZeibig.json'),
  },
  {
    name: 'Admin Jhen',
    email: 'admin.jhen@gmail.com',
    password: '12345678',
    authFile: path.join(__dirname, '../.auth/AdminJhen.json'),
  },
  {
    name: 'SA Jhen',
    email: 'sa.jhen@gmail.com',
    password: 'thera.rocks',
    authFile: path.join(__dirname, '../.auth/SuperAdmin.json'),
  },
];

setup.use({ storageState: undefined });

// Loop through accounts
for (const user of accounts) {
  setup(`Create ${user.name} auth if missing`, async ({ page, context }) => {
    if (fs.existsSync(user.authFile)) {
      console.log(`✅ Auth state for ${user.name} already exists — skipping login.`);
      return;
    }

    console.log(`Logging in as ${user.name}...`);

    await page.goto('https://staging.therapios.de/');

    // fill login form
    await page.getByTestId('text-input-outlined').first().fill(user.email);
    await page.locator('input[type="password"]').fill(user.password);

    // click submit
    await page.locator('div').filter({ hasText: /^Proceed$/ }).first().click();

    // wait for successful login
    await expect(page.locator('#root')).toContainText(user.name);

    // save session
    await context.storageState({ path: user.authFile });

    console.log(`✅ Auth state saved for ${user.name} → ${user.authFile}`);
  });
}
