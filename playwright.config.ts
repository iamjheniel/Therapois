import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
  // 🕐 Increase total test timeout slightly for CI stability
  timeout: 90_000, // per test
  expect: { timeout: 10_000 },

  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // ✅ Retry flaky tests automatically on CI
  retries: process.env.CI ? 2 : 0,

  // ✅ Run more workers in CI (1 is too slow)
  // Playwright handles parallel isolation well
  workers: process.env.CI ? 4 : undefined,

  // ✅ Use concise + HTML reporter combo
  reporter: process.env.CI
    ? [['dot'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'html',

  use: {
    baseURL: 'https://staging.therapios.de/',
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure', // Only collect heavy traces on retries
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
    actionTimeout: 15_000, // Avoid hanging forever
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: true,
  },

  projects: [
    // 👇 Separate “setup” role — generates storageState
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },

    // 👇 Role-based authenticated users
    {
      name: 'SandraZeibig',
      use: { storageState: path.join(__dirname, '.auth/SandraZeibig.json') },
    },
    {
      name: 'AdminJhen',
      use: { storageState: path.join(__dirname, '.auth/AdminJhen.json') },
    },
    {
      name: 'SAJhen',
      use: { storageState: path.join(__dirname, '.auth/SuperAdmin.json') },
    },

    // 👇 Browser configurations (desktop)
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read'],
      },
    },
    {
      name: 'firefox',
      dependencies: ['setup'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      dependencies: ['setup'],
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
