import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
  // 🕐 Increase total test timeout slightly for CI stability
  timeout: 90_000, // per test
  expect: { timeout: 30_000 },

  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // ✅ Retry flaky tests automatically on CI
  retries: process.env.CI ? 1 : 0,

  workers: process.env.CI ? 2 : undefined,

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
    actionTimeout: 0,           // disable low-level timeout
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: true,
    launchOptions: {},
  },

  projects: [
    // 👇 Separate “setup” role — generates storageState (staging only)
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },

    // 👇 Role-based authenticated users (Staging)
    {
      name: 'SandraZeibig',
      testMatch: /tests\/Staging\/Therapist\/.*\.spec\.ts$/,
      use: { storageState: path.join(__dirname, '.auth/SandraZeibig.json') },
    },
    {
      name: 'AdminJhen',
      testMatch: /tests\/Staging\/Admin\/.*\.spec\.ts$/,
      use: { storageState: path.join(__dirname, '.auth/AdminJhen.json') },
    },
    {
      name: 'SAJhen',
      testMatch: /tests\/Staging\/SuperAdmin\/.*\.spec\.ts$/,
      use: { storageState: path.join(__dirname, '.auth/SuperAdmin.json') },
    },

    // 👇 Production setup
    {
      name: 'setup-prod',
      testMatch: /.*production\.auth\.setup\.ts/,
      use: { baseURL: 'https://app.therapios.de/' },
    },

    // 👇 Role-based authenticated users (Production)
    {
      name: 'JhenQA-Prod',
      testMatch: '**/Production/Therapist/**/*.spec.ts',
      use: {
        storageState: path.join(__dirname, '.auth/JhenQA-Prod.json'),
        baseURL: 'https://app.therapios.de/',
      },
    },
    {
      name: 'AdminJhen-Prod',
      testMatch: '**/Production/Admin/**/*.spec.ts',
      use: {
        storageState: path.join(__dirname, '.auth/AdminJhen-Prod.json'),
        baseURL: 'https://app.therapios.de/',
      },
    },
    {
      name: 'SAJhen-Prod',
      testMatch: '**/Production/SuperAdmin/**/*.spec.ts',
      use: {
        storageState: path.join(__dirname, '.auth/SuperAdmin-Prod.json'),
        baseURL: 'https://app.therapios.de/',
      },
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
