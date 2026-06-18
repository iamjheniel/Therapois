import { Page, expect } from '@playwright/test';
import { CRMBasePage } from './crm.base.page';

export class CRMInitialOrdersPage extends CRMBasePage {
  constructor(page: Page) {
    super(page);
  }

  async openErstverordnungen() {
    // The CRM practice panel was redesigned: the old "Erstverordnungen" tab is now "Bestellung".
    await this.page.getByText('Bestellung', { exact: true }).click({ force: true });
  }

  async addNote(note: string) {
    // Open Add Note modal
    await this.page.getByText('Add Note', { exact: true }).click();

    const modal = this.page.getByTestId('modal-surface');
    const noteInput = modal.getByTestId('text-input-outlined');

    // Enter note
    await noteInput.click();
    await noteInput.fill(note);

    // Apply note
    await this.page
      .getByRole('button', { name: /Apply to \d+ VO/ })
      .click();


    // Confirm
    await this.page.getByRole('button', { name: 'Ja' }).click();

    // Assert success toast (flexible count)
    await expect(
      this.page
        .getByTestId('surface')
        .filter({ hasText: /Successfully added note to \d+ VO\./ })
    ).toBeVisible();
  }

  async openBulkActions() {
    // The practice detail panel can still be loading when this runs, so wait for the order
    // list to actually render (the "Showing N initial order(s)" summary plus selectable
    // checkboxes) before selecting a row. Selecting an order row reveals the bulk actions.
    await expect(
      this.page.getByText(/Showing\s+\d+\s+initial\s+order/i).first()
    ).toBeVisible({ timeout: 30000 });
    const rowCheckbox = this.page.getByRole('checkbox').nth(1);
    await rowCheckbox.waitFor({ state: 'attached', timeout: 15000 });
    // Row checkboxes render disabled (React Native Web), so force-click with an explicit
    // timeout — without it a transient actionability miss would hang until the test times out.
    await rowCheckbox.click({ force: true, timeout: 15000 });
  }

  async generateInitialOrderForm() {
    await this.page.getByText('Generate Initial Order Form').click();
    await this.page.getByRole('radio').first().click();
    await this.page.getByRole('button', { name: 'Generate Form' }).click();

    const preview = this.page
      .getByTestId('surface')
      .filter({ hasText: 'PDF Preview - Initial Order Form' });

    await expect(preview).toBeVisible();
  }

  async downloadPDF() {
    const downloadPromise = this.page.waitForEvent('download');
    await this.page.getByRole('button', { name: 'Download PDF' }).click();
    await downloadPromise;
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  async changeStatusToBestellt() {
    await this.page.getByText('Change Status').click();
    await this.page.getByRole('menuitem', { name: 'Bestellt' }).click();
    await this.page.getByRole('button', { name: 'Ja' }).click();

    await expect(
      this.page.getByTestId('surface')
    ).toContainText('Successfully updated status for 1 VO.');
  }

}
