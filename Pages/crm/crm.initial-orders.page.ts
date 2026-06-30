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
    await this.selectOrderRow(1);
  }

  /** Selects a single order-row checkbox by index (0 = the "select all" header checkbox). */
  private async selectOrderRow(index: number) {
    const rowCheckbox = this.page.getByRole('checkbox').nth(index);
    await rowCheckbox.waitFor({ state: 'attached', timeout: 15000 });
    // Row checkboxes render disabled (React Native Web), so force-click with an explicit
    // timeout — without it a transient actionability miss would hang until the test times out.
    await rowCheckbox.click({ force: true, timeout: 15000 });
    await this.page.waitForTimeout(400);
  }

  /** Clears the current bulk selection via the "Clear selection" link, if shown. */
  private async clearSelection() {
    const clear = this.page.getByText('Clear selection', { exact: true });
    if (await clear.isVisible().catch(() => false)) {
      await clear.click().catch(() => {});
      await this.page.waitForTimeout(400);
    }
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

  /**
   * Changes an initial order's status to "Bestellt" and asserts the success toast.
   *
   * Selects a row itself (no prior {@link openBulkActions} needed) and is idempotent: a VO that
   * is ALREADY "Bestellt" — from a previous run or real data — won't offer the "Bestellt"
   * transition in its Change-Status menu, so this rotates through the first several order rows
   * until one does. This keeps the test independent of which practice/row navigation landed on.
   */
  async changeStatusToBestellt() {
    const bestellt = this.page.getByRole('menuitem', { name: 'Bestellt' });
    for (const idx of [1, 2, 3, 4, 5, 6]) {
      await this.clearSelection();
      await this.selectOrderRow(idx);
      await this.page.getByText('Change Status').click();
      const offered = await bestellt
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (offered) {
        await bestellt.click();
        await this.page.getByRole('button', { name: 'Ja' }).click();
        // Flexible VO count (mirrors addNote) — the selected count is environment-dependent.
        await expect(
          this.page
            .getByTestId('surface')
            .filter({ hasText: /Successfully updated status for \d+ VO\./ })
        ).toBeVisible();
        return;
      }
      // This row is already "Bestellt" (no transition offered) — close the menu and try the next.
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(400);
    }
    throw new Error('No initial order row offered the "Bestellt" status transition');
  }

}
