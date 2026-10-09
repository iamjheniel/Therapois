import { test as setup } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Define all accounts you want to log in as
const accounts = [
  {
    name: 'Sandra Zeibig',
    email: 'jhenqa@therapios.de',
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
    // Always log in fresh. The saved refresh token is SINGLE-USE (#3460) — the first test of a run
    // spends it — so a file left over from an earlier run is always stale; skipping when it
    // existed is what made local runs fail at the login form while CI (no file) did not.

    console.log(`Logging in as ${user.name}...`);

    await page.goto('https://staging.therapios.de/');

    // fill login form
    await page.getByTestId('text-input-outlined').first().fill(user.email);
    await page.locator('input[type="password"]').fill(user.password);

    // click submit
    await page.locator('div').filter({ hasText: /^Weiter$/ }).first().click();

    // wait for redirect away from login page (URL path changes from '/')
    await page.waitForURL(url => new URL(url).pathname !== '/', { timeout: 30_000 });

    // save session
    // `indexedDB: true` — since #3910 (5da96139d5, 2026-10-07) the web app keeps the refresh token
    // in IndexedDB (`therapios-auth`), not localStorage. Without this the saved file carries no
    // token and every test that loads it lands on the login form.
    await context.storageState({ path: user.authFile, indexedDB: true });

    console.log(`✅ Auth state saved for ${user.name} → ${user.authFile}`);
  });
}
