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
      await this.page.getByText('').first().click();
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
    // The picker now opens a search-enabled list; filter to the desired practice.
    const searchBox = this.page.getByRole('textbox', { name: 'Search' });
    if (await searchBox.isVisible().catch(() => false)) {
      await searchBox.fill(practiceName);
    }
    await this.page
      .getByRole('dialog')
      .getByText(practiceName, { exact: false })
      .first()
      .click();
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
