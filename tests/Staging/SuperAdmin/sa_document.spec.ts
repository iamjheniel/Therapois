import { test, expect } from '@playwright/test';

const DOCUMENT_URL = 'https://staging.therapios.de/document';

test.describe('Super Admin Copayment', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

    test('Super Admin Document View and Add Note', { tag: ['@SuperAdmin', '@DocumentAddNoteAdmin'] }, async ({ page }) => {
    await page.goto(DOCUMENT_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByRole('button', { name: 'View' }).nth(3).click({force: true});
    await expect(page.getByTestId('modal-surface')).toContainText('Dokumentdetails');
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('automation test');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(page.getByTestId('modal-surface')).toContainText('automation test');

    });

    test('Super Admin Document Search by Therapist Name', { tag: ['@SuperAdmin', '@DocumentSearch'] }, async ({ page }) => {
    // Retargeted to existing data: staging documents are unassigned (no patient/therapist),
    // so we search by an existing Document ID instead of a therapist name.
    await page.goto(DOCUMENT_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('00001');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).not.toContainText('Keine Patienten gefunden', { timeout: 15000 });
    await expect(page.locator('#root')).toContainText(/00001-/i);
    });

    test('Super Admin Document Search by Document ID', { tag: ['@SuperAdmin', '@DocumentSearch'] }, async ({ page }) => {
    // existing staging document IDs are of the form 00001-NN
    await page.goto(DOCUMENT_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    await page.getByRole('textbox', { name: 'Suchen' }).click();
    await page.getByRole('textbox', { name: 'Suchen' }).fill('00001');
    await page.getByRole('textbox', { name: 'Suchen' }).press('Enter');
    await expect(page.locator('#root')).toContainText(/00001-/i);
    });

    test('Super Admin Document Update Status', { tag: ['@SuperAdmin', '@DocumentStatusChange'] }, async ({ page }) => {
    await page.goto(DOCUMENT_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('Dokument Upload');
    // Status change is an inline action per row: each row has button-text buttons
    // (In Prüfung / Bestätigt / Nicht lesbar / Abgelehnt) in the Aktionen column, which
    // sits off-screen to the right — so click with force. Clicking sets the status
    // immediately (no confirmation dialog). The status filter ("In Prüfung (N)") shows a
    // live count; marking a row "Nicht lesbar" drops the In-Prüfung count by one.
    // The default view is filtered to "In Prüfung"; marking a row "Nicht lesbar" moves
    // that document out of the view, so the number of rows (one View button per row)
    // drops by one — a reliable signal the status change took effect.
    const rowCount = () => page.getByRole('button', { name: 'View' }).count();
    await expect.poll(rowCount, { timeout: 15000 }).toBeGreaterThan(0);
    const before = await rowCount();
    await page.getByTestId('button-text').filter({ hasText: 'Nicht lesbar' }).first().click({ force: true });
    await expect.poll(rowCount, { timeout: 15000 }).toBeLessThan(before);
    });

});
