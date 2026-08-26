import { test ,  expect } from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';

test.describe('VO Termination', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' }); // already logged in due to storageState
  });

  test('Non-immediate termination (Keine Folge-VO bestellen)', { tag: '@KFvo' }, async ({ page }) => {
    // Resolve a real patient from live data and leave the list filtered to it.
    const list = new TherapistListPage(page);
    const name = await list.resolvePatientName(['BiniAiah Test']);
    test.skip(!name, 'No patient available in this therapist\'s list');
    // nth(1) = the filtered patient's row checkbox (nth(0) = select-all header, which does
    // NOT enable the "Abbrechen VO" action). Selecting the row enables it.
    await page.getByRole('checkbox').nth(1).click({ force: true });
    // Not every patient has a cancellable active VO — skip if the action isn't available.
    const abbrechen = page.getByRole('button', { name: 'Abbrechen VO' });
    test.skip(!(await abbrechen.isVisible({ timeout: 8000 }).catch(() => false)), 'Resolved patient has no cancellable VO');
    await abbrechen.click();
    await page.getByText('Keine Folge-VO Bestellen').click();
    // The redesign swapped the modals' `text-input-outlined` inputs for plain textareas and
    // localised their buttons, so accept either shape rather than pinning one build.
    const modal = page.getByTestId('modal-surface');
    const reason = modal
      .getByTestId('text-input-outlined')
      .or(modal.locator('textarea'))
      .first();
    await reason.click();
    await reason.fill('keine folge- VO termination automation');
    await page
      .getByRole('button', { name: 'Confirm', exact: true })
      .or(page.getByRole('button', { name: 'Bestätigen', exact: true }))
      .first()
      .click();
    await expect(page.locator('#root')).toContainText('Keine Folge-VO');
});
});