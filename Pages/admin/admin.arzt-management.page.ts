import { Page, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';

type ArztData = {
  salutation: string;
  title: string;
  firstName: string;
  lastName: string;
  doctorId: string;
};

export class ArztManagementPage {
  constructor(private page: Page) {}

  // ---------- helpers ----------
  private rnText(text: string) {
    return this.page.locator('div').filter({ hasText: text }).last();
  }

  async openArztManagement() {
    await this.page.waitForLoadState('domcontentloaded');
    // Nested under the "Admin" sidebar submenu; AppPage.navTo expands it. Nav entries expose no
    // <button>/role=button in this build.
    await new AppPage(this.page).navTo('Arzt Management');
  }

  async openAddArzt() {
    await this.rnText('Add Arzt').click();
  }

  async fillArztForm(data: ArztData) {
    await this.page.getByRole('textbox', { name: 'z.B. Herr, Frau' }).fill(data.salutation);
    await this.page.keyboard.press('Tab');

    await this.page.getByRole('textbox', { name: 'z.B. Dr., Prof.' }).fill(data.title);
    await this.page.keyboard.press('Tab');

    await this.page.getByRole('textbox', { name: 'Geben Sie den Vornamen ein' }).fill(data.firstName);
    await this.page.keyboard.press('Tab');

    await this.page.getByRole('textbox', { name: 'Geben Sie den Nachnamen ein' }).fill(data.lastName);

    await this.page.getByRole('textbox', { name: 'Geben Sie die Arzt-ID ein' }).fill(data.doctorId);
  }

  async selectPractice(practiceName: string) {
    await this.rnText('Wählen Sie eine Praxis').click();
    // The picker opens a search-enabled list; wait for the dialog, then filter.
    const dialog = this.page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    // "Search" → "Suchen" in v3.11.0; accept either so Production's older build still resolves.
    const searchBox = this.page.getByRole('textbox', { name: /^(Search|Suchen)$/ }).first();
    if (await searchBox.isVisible().catch(() => false)) {
      await searchBox.fill(practiceName);
    }
    const option = dialog.getByText(practiceName, { exact: false }).first();
    await option.waitFor({ state: 'visible', timeout: 20_000 });
    await option.click();
  }

  async save() {
    await this.page.getByRole('button', { name: 'Speichern' }).click();
  }

  /**
   * Asserts an Arzt is present in the list, by name. Use this as the post-condition for
   * create/update — this build renders NO success toast (the old `getByTestId('surface')` snackbar
   * is gone), so the persisted row is the only observable outcome.
   */
  async expectArztInList(name: string) {
    await expect(this.page.locator('#root')).toContainText(name, { timeout: 15_000 });
  }

  async search(text: string) {
    const search = this.page.getByRole('textbox', {
      name: 'Suche nach Name oder Praxis...',
    });
    await search.fill(text);
    await search.press('Enter');
  }

  // After search() narrows the Arzt list to the matching row(s), the row's
  // Aktion column (edit/delete SVGs) sits off-screen to the right. Use force +
  // scrollIntoView so the icon is clickable even when not in the viewport.
  async openEditForRow(name: string) {
    const row = this.page.locator('#root').filter({ hasText: name });
    const editIcon = row.locator('svg').last();
    await editIcon.scrollIntoViewIfNeeded().catch(() => {});
    await editIcon.click({ force: true });
  }

  async deleteArzt(name: string) {
    const row = this.page.locator('#root').filter({ hasText: name });
    const deleteIcon = row.locator('svg').last();
    await deleteIcon.scrollIntoViewIfNeeded().catch(() => {});
    await deleteIcon.click({ force: true });

    await this.page.getByRole('button', { name: 'Arzt löschen' }).click();
    await this.page
      .getByTestId('modal-surface')
      .getByRole('button', { name: 'Löschen' })
      .click();
  }

  /**
   * Formerly waited for a success snackbar to appear and clear before the next action. This build
   * shows no toasts at all, so there is nothing to wait out — kept as a settle-only pause for the
   * (currently `test.fixme`'d) delete flows that call it.
   */
  async expectToastAndWaitToDisappear(_text: string) {
    await this.page.waitForTimeout(1500);
  }
}
