import { defineConfig } from '@playwright/test';
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
    // `retain-on-failure` reads like "only pay for failures", but it does not: Playwright has to
    // record EVERY test and then delete the artifact when the test passes. On a green run that is
    // pure overhead — a screencast running for the whole of all ~460 tests — and it buys nothing,
    // because a CI failure is retried (`retries: 1`) and the retry captures both video and trace.
    // Locally the trace above is already the debugging surface and carries its own screenshots, so
    // the video is redundant there too. `screenshot` is exempt: it is captured at the failure point
    // only, not recorded continuously.
    video: process.env.CI ? 'on-first-retry' : 'off',
    screenshot: 'only-on-failure',
    headless: true,
    actionTimeout: 0,           // disable low-level timeout
    navigationTimeout: 60_000, // staging's `load` event can be slow; avoid transient goto timeouts
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

    // NOTE: there are deliberately no bare `chromium` / `firefox` / `webkit` projects here.
    // They carried no `testMatch`, so each of them matched EVERY spec in `testDir` — a bare
    // `npx playwright test` scheduled 2,370 tests across 163 files instead of the 440 the six
    // role projects hold. None of those extra runs could pass either: the browser projects
    // declared no `storageState`, so every test landed on the login page. The role projects
    // above already pin Desktop Chrome via the default channel; add a browser matrix back only
    // with an explicit `testMatch` and a `storageState`.
  ],
});
