import { test, expect } from '../../fixtures/crm-serial';
import { CRMDashboardPage } from '../../../Pages/crm/crm.dashboard.page';

/**
 * Ticket #2935 — CRM · Activity Flexibility (editable notes + independent next activity) (RC 3.9).
 *
 * Two workflow improvements on the practice-detail "Aktivitäten" tab:
 *   - Existing activities can now be edited (each AKTIVITÄTSVERLAUF entry has an "Edit" control).
 *   - A next activity can be scheduled ("Nächste Aktivität planen") without first documenting the
 *     current one — the schedule form is available independently of the add-activity notes.
 *
 * SAFETY: these tests open the edit/schedule affordances and assert they become usable, then cancel
 * WITHOUT saving — no activity notes are overwritten and no next activity is committed on the shared
 * practice. Drives the shared CRM dashboard → uses the crm-serial fixture; no setTimeout. Staging only.
 */
test.describe('Admin CRM — Activity Flexibility', () => {
  let dash: CRMDashboardPage;

  test.beforeEach(async ({ page }) => {
    dash = new CRMDashboardPage(page);
    await dash.open();
    test.skip(!(await dash.waitForRows()), 'CRM practice list did not render in this environment');
    await page.getByText('Anzeigen', { exact: true }).first().click();
    await page.waitForTimeout(2500);
    await page.getByText('Aktivitäten', { exact: true }).first().click({ force: true });
    await page.waitForTimeout(2500);
  });

  test('Existing activity notes can be edited (edit mode opens)', {
    tag: ['@Admin', '@CRMActivityFlex'],
  }, async ({ page }) => {
    // AC1: history entries expose an "Edit" control.
    const editBtn = page.getByText('Edit', { exact: true }).filter({ visible: true });
    test.skip(!(await editBtn.count()), 'No editable activity-history entries for this practice');

    const textboxesBefore = await page.getByRole('textbox').filter({ visible: true }).count();
    await editBtn.first().click({ force: true });
    await page.waitForTimeout(1500);

    // AC1/AC3: the note becomes editable — a save affordance and/or a new editable field appears
    // (without the edit committing anything yet).
    const saveVisible = await page.getByText(/^(Speichern|Save|Aktualisieren|Update)$/)
      .filter({ visible: true }).count().catch(() => 0);
    const textboxesAfter = await page.getByRole('textbox').filter({ visible: true }).count();
    expect(
      saveVisible > 0 || textboxesAfter > textboxesBefore,
      'clicking Edit should open an editable notes field / save control',
    ).toBeTruthy();

    // Cancel without saving — do not overwrite the existing note.
    await page.getByText(/^(Abbrechen|Cancel)$/).filter({ visible: true }).first()
      .click({ timeout: 3000, force: true }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  });

  test('Next activity can be scheduled independently of documenting the current one', {
    tag: ['@Admin', '@CRMActivityFlex'],
  }, async ({ page }) => {
    // AC4: the "Nächste Aktivität planen" scheduler is present in the Aktivitäten tab.
    await expect(page.getByText('Nächste Aktivität planen', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Engaging a quick-date chip opens the schedule form WITHOUT touching the add-activity notes
    // field — i.e. the current activity need not be documented first.
    const chip = page.locator('div').filter({ hasText: /^\+3D$/ }).first();
    test.skip(!(await chip.count()), 'Schedule-next quick chip not present in this environment');
    await chip.click({ force: true });
    await page.waitForTimeout(1200);

    // The "What needs to be done?" field appears — the next-activity form opened on its own.
    await expect(page.getByRole('textbox', { name: 'What needs to be done?' })).toBeVisible({ timeout: 8000 });

    // Do NOT save — no next activity is committed on the shared practice.
    await page.keyboard.press('Escape').catch(() => {});
  });
});
