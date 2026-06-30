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
    await this.selectOrderRow(3);
  }

  /** Selects a single order-row checkbox by index (0 = the "select all" header checkbox). */
  private async selectOrderRow(index: number) {
    const rowCheckbox = this.page.getByRole('checkbox').nth(index);
    await rowCheckbox.waitFor({ state: 'attached', timeout: 15000 });
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

  /**
   * Changes a follow-up order's status to "Bestellt" and asserts the success toast.
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
    throw new Error('No follow-up order row offered the "Bestellt" status transition');
  }
}
