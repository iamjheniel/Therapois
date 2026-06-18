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
    const arztBtn = this.page
      .locator('button')
      .filter({ hasText: 'Arzt Management' })
      .last();
    const found = await arztBtn
      .waitFor({ state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      await new AppPage(this.page).openSideMenu();
      await arztBtn.waitFor({ state: 'attached', timeout: 10_000 });
    }
    await arztBtn.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
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
    const searchBox = this.page.getByRole('textbox', { name: 'Search' });
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

  async expectToast(text: string) {
    await expect(this.page.getByTestId('surface')).toContainText(text);
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

  async expectToastAndWaitToDisappear(text: string) {
  const toast = this.page.getByTestId('surface').filter({ hasText: text }).first();

  // wait for the toast to appear
  await expect(toast).toBeVisible({ timeout: 15000 });

  // wait for it to disappear (prevents collision with next toast)
  await toast.waitFor({ state: 'hidden', timeout: 15000 });
}
}
