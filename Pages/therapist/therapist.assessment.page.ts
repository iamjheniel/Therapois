import { Page, Locator, expect } from '@playwright/test';

/**
 * Page Object for the therapist "Meine VOs" dashboard's two new columns:
 *   - BF  = Befund / Assessment   (shows a status chip per row: a coloured status, "Kein BF", …)
 *   - IB  = Initialbefund         (shows a "+ IB" add-control per active patient row)
 *
 * Both columns sit immediately after the existing TB (T-Board) column. The app is React-Native-Web,
 * so the table cells carry NO data-testid / role — column cells are only identifiable by their
 * horizontal alignment under the (text-only) column header. This POM therefore resolves a column's
 * centre-x from its header text and clicks the cell at (columnX, rowY), the same geometry-based
 * approach the rest of the therapist suite falls back to for this table.
 *
 * The IB column is far to the right, so a wide viewport is used to keep it on-screen (at the default
 * 1280px width the column is off-screen and its cells virtualise to zero size).
 */
export class TherapistAssessmentPage {
  constructor(private page: Page) {}

  private searchBox(): Locator {
    return this.page.getByTestId('text-input-outlined').first();
  }

  /**
   * Loads the therapist dashboard at a wide viewport (so the far-right IB column is rendered).
   * Accepts a base URL so the Production mirror can point at app.therapios.de; defaults to Staging.
   */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.setViewportSize({ width: 2400, height: 900 });
    await this.page.goto(`${baseUrl}/therapist/`, { waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ state: 'visible', timeout: 45_000 });
    await this.page.waitForTimeout(1500);
  }

  /** Filters the list to surface patient rows (the unfiltered "today" list is often empty). */
  async filterPatients(term = 'Test'): Promise<void> {
    const box = this.searchBox();
    await box.click();
    await box.fill(term);
    await box.press('Enter');
    await this.page.waitForTimeout(3000);
  }

  /**
   * Expands the "Aktive Patienten" accordion so data rows render. The header toggle has no
   * stable selector, so we click it (force) and confirm by watching the per-row checkbox count
   * grow — retrying a few times because the click can land before the group is interactive.
   */
  async expandActivePatients(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if ((await this.page.getByRole('checkbox').count()) > 1) return;
      await this.page.getByText(/^Aktive Patienten$/).first().click({ force: true }).catch(() => {});
      await this.page.waitForTimeout(2000);
    }
  }

  /** Number of selectable patient rows (excludes the select-all header checkbox at nth(0)). */
  async activeRowCount(): Promise<number> {
    return Math.max(0, (await this.page.getByRole('checkbox').count()) - 1);
  }

  /** A visible column header by exact text (filters out the hidden/virtualised duplicates). */
  columnHeader(name: string): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true }).first();
  }

  /** Centre-x of a visible column header, or null if not rendered. */
  private async columnCenterX(name: string): Promise<number | null> {
    const box = await this.columnHeader(name).boundingBox().catch(() => null);
    return box ? Math.round(box.x + box.width / 2) : null;
  }

  /** Centre-y of the first data row (its per-row checkbox), or null if no rows. */
  private async firstRowCenterY(): Promise<number | null> {
    const box = await this.page.getByRole('checkbox').nth(1).boundingBox().catch(() => null);
    return box ? Math.round(box.y + box.height / 2) : null;
  }

  /** The "+ IB" add-Initialbefund control (present once per active patient row). */
  ibAddControl(): Locator {
    return this.page.getByText('+ IB', { exact: true });
  }

  /**
   * Clicks the cell under a given column in the first data row and reports whether a modal opened.
   * Used for both the BF (Assessment) chip and the IB "+ IB" control, whose cells are only
   * addressable by geometry. Returns false when the control is inert (no modal surfaces) — the
   * control is disabled for some patient states, in which case the caller should test.skip().
   */
  async openModalFromFirstRow(column: 'BF' | 'IB'): Promise<boolean> {
    const x = await this.columnCenterX(column);
    const y = await this.firstRowCenterY();
    if (x == null || y == null) return false;
    await this.page.mouse.click(x, y);
    await this.page.waitForTimeout(2500);
    return this.isModalOpen();
  }

  private modalSurface(): Locator {
    return this.page
      .locator('[data-testid="modal-surface"], [data-testid="surface"], [role="dialog"]')
      .filter({ visible: true });
  }

  async isModalOpen(): Promise<boolean> {
    return (await this.modalSurface().count()) > 0;
  }

  /**
   * Asserts the opened surface is an editable Befund/Initialbefund form: it must expose a
   * save/create affordance (German or English) or at least one editable field.
   */
  async assertModalIsForm(): Promise<void> {
    const surface = this.modalSurface().first();
    await expect(surface).toBeVisible();
    const saveBtn = this.page.getByRole('button', {
      name: /Speichern|Save|Erstellen|Bestätigen|Confirm|Änderungen speichern/i,
    });
    const field = surface.getByTestId('text-input-outlined');
    const hasSave = await saveBtn.first().isVisible({ timeout: 5000 }).catch(() => false);
    const hasField = (await field.count()) > 0;
    expect(hasSave || hasField, 'Assessment/IB modal should contain a form control').toBeTruthy();
  }

  /** Closes any open modal without persisting (Escape + best-effort close button). */
  async closeModal(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page
      .getByRole('button', { name: /close|schließen|abbrechen|zurück|cancel|󰅖/i })
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    await this.page.waitForTimeout(800);
  }
}
