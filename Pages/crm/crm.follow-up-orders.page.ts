import { Page, expect } from '@playwright/test';

export class CRMFollowUpOrdersPage {
  constructor(private page: Page) {}

  /* ---------- Navigation ---------- */

  async openFollowUpOrders() {
    // The CRM practice panel was redesigned: the old "Folge-Verordnungen" tab is now "Nachverfolgung".
    await this.page.getByText('Nachverfolgung', { exact: true }).click({ force: true });
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
    // Selecting an order row reveals the bulk actions. The row checkboxes render disabled
    // (React Native Web), so force-click with an explicit timeout to avoid hanging the test
    // on a transient actionability miss.
    const rowCheckbox = this.page.getByRole('checkbox').nth(3);
    await rowCheckbox.waitFor({ state: 'attached', timeout: 15000 });
    await rowCheckbox.click({ force: true, timeout: 15000 });
  }

  async generateFollowUpOrderForm() {
    await this.page.getByText('Generate Follow-up Order Form').click();
    await this.page.getByRole('radio').first().click();
    await this.page.getByRole('button', { name: 'Generate Form' }).click();

    const preview = this.page
      .getByTestId('surface')
      .filter({ hasText: 'PDF Preview - Follow-up Order Form' });

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
