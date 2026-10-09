import { test as setup } from '@playwright/test';
import { createAuthState } from './fixtures/auth-setup';
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

// Logs each account in through the API and saves its state; see tests/fixtures/auth-setup.ts for why
// it is filtered by AUTH_ONLY and never fails the run.
for (const user of accounts) {
  setup(`[Prod] Create ${user.name} auth`, async ({ page, context }) => {
    setup.setTimeout(400_000); // room to wait out a login throttle (Retry-After up to 60 s × retries)
    await createAuthState({ page, context }, user, { api: 'https://api.app.therapios.de', origin: 'https://app.therapios.de' });
  });
}
