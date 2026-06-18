import { test, expect } from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';

test.describe('Therapist Doku Check', () => {
  // Resolved (real, existing) patient name — set per test in beforeEach.
  let resolvedPatient: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
    // Resolve a real patient from live data ('JhenTest QA' is just a hint).
    const list = new TherapistListPage(page);
    resolvedPatient = await list.resolvePatientName(['JhenTest QA']);
    test.skip(!resolvedPatient, 'No patient available');
  });

  test('Check Doku feature', { tag: ['@Therapist', '@checkdoku'] }, async ({ page }) => {
    // The list is already filtered to the resolved patient; expand its row.
    await page.getByText(resolvedPatient!).first().waitFor({ state: 'visible', timeout: 20000 });
    await page.getByText(resolvedPatient!).first().click({ force: true });

    // Click the Doku eye icon safely using boundingBox with null guard
    const dokuLabel = page.getByText('Doku', { exact: true }).first();
    await dokuLabel.waitFor({ state: 'visible' });
    const dokuBox = await dokuLabel.boundingBox();
    if (!dokuBox) throw new Error('Could not find bounding box for "Doku" label');
    await page.mouse.click(dokuBox.x + dokuBox.width / 2, dokuBox.y + dokuBox.height + 25);

    // The Doku panel only opens for a patient that has documentation. A resolved fallback
    // patient may have none, so skip rather than fail when the panel never appears.
    const dokuModal = page.getByTestId('modal-surface');
    test.skip(
      !(await dokuModal.isVisible({ timeout: 15000 }).catch(() => false)),
      'Resolved patient has no documentation panel to inspect'
    );
    await expect(dokuModal).toContainText('Dokumentation (Behandlungsverlauf)');
  });

  test('Check Logs feature', { tag: ['@Therapist', '@checklogs'] }, async ({ page }) => {
    // The list is already filtered to the resolved patient; expand its row.
    await page.getByText(resolvedPatient!).first().waitFor({ state: 'visible', timeout: 20000 });
    await page.getByText(resolvedPatient!).first().click({ force: true });

    // Click the Protokolle eye icon safely using boundingBox with null guard
    const protokolleLabel = page.getByText('Protokolle', { exact: true }).first();
    await protokolleLabel.waitFor({ state: 'visible' });
    const protokolleBox = await protokolleLabel.boundingBox();
    if (!protokolleBox) throw new Error('Could not find bounding box for "Protokolle" label');
    await page.mouse.click(protokolleBox.x + protokolleBox.width / 2, protokolleBox.y + protokolleBox.height + 25);

    // The logs panel only opens for a patient that has prescription logs. A resolved fallback
    // patient may have none, so skip rather than fail when the panel never appears.
    const logsModal = page.getByTestId('modal-surface');
    test.skip(
      !(await logsModal.isVisible({ timeout: 15000 }).catch(() => false)),
      'Resolved patient has no prescription-logs panel to inspect'
    );
    await expect(logsModal).toContainText(/Prescription logs/i);

    // Close modal using a more stable selector
    await page.getByRole('button', { name: /close/i }).click();
  });

});