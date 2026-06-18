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
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').click();
    await page.getByTestId('modal-surface').getByTestId('text-input-outlined').fill('keine folge- VO termination automation');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('#root')).toContainText('Keine Folge-VO');
});
});