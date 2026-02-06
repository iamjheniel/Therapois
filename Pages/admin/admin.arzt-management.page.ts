import { Page, expect } from '@playwright/test';

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
    await this.page.getByText('').last().click();

    const arztBtn = this.page
      .locator('button')
      .filter({ hasText: 'Arzt Management' })
      .last();

    await arztBtn.click();
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
    await this.rnText(practiceName).click();
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

  async openEditForRow(name: string) {
    const row = this.page.locator('#root').filter({ hasText: name });
    await row.locator('svg').last().click();
  }

  async deleteArzt(name: string) {
    const row = this.page.locator('#root').filter({ hasText: name });
    await row.locator('svg').last().click();

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
