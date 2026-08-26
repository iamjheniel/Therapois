import { Page, Locator, expect } from '@playwright/test';
import { boardSearchBox } from '../base/app.page';

/**
 * Page Object for the therapist "Meine VOs" dashboard's two new columns:
 *   - BF  = Befund / Assessment   (shows a status chip per row: a coloured status, "Kein BF", …)
 *   - IB  = Initialbefund         (shows a "+ IB" add-control per active patient row)
 *
 * The board table is `data-testid`-tagged now — `v2-header-<key>` for the headers and
 * `v2-cell-<key>` for the cells (`bfStatus`, `ibStatus`) — so both columns are addressed directly
 * instead of by the horizontal-alignment geometry this POM used to need.
 *
 * Two things about the current board matter here:
 *  - **BF and IB both ship opt-in.** Each is one of the nine columns the "Spalten" picker leaves
 *    unchecked, so anything asserting on either has to turn it on first: `enableColumn('BF')` /
 *    `enableColumn('IB')`. (IB was a default column until v3.11.0 moved it out.) `enableColumn`
 *    is idempotent — it no-ops when the column already carries its "✓".
 *  - **The old `text-input-outlined` testid is gone** from this surface; the search box is addressed
 *    by its placeholder ("Patient, VO Nr. …").
 *
 * The IB column is far to the right, so a wide viewport is used to keep it on-screen (at the default
 * 1280px width the column is off-screen and its cells virtualise to zero size).
 */
export class TherapistAssessmentPage {
  constructor(private page: Page) {}

  private searchBox(): Locator {
    return boardSearchBox(this.page);
  }

  /** The column keys the two features render under. */
  private static readonly COLUMN_KEYS = { BF: 'bfStatus', IB: 'ibStatus' } as const;

  /**
   * Loads the therapist dashboard at a wide viewport (so the far-right IB column is rendered).
   * Accepts a base URL so the Production mirror can point at app.therapios.de; defaults to Staging.
   */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.setViewportSize({ width: 2400, height: 900 });
    await this.page.goto(`${baseUrl}/therapist/`, { waitUntil: 'domcontentloaded' });
    // The checked-column set is a sticky localStorage preference; clear it so "BF is off by default"
    // is a statement about the product rather than about whatever ran here last.
    // Reload only when a preference was actually stored — see the note in TherapistBoardV2Page.open.
    const hadStoredPref = await this.page.evaluate(() => {
      const had = localStorage.getItem('column-select-therapist-board-v2') !== null;
      localStorage.removeItem('column-select-therapist-board-v2');
      return had;
    });
    if (hadStoredPref) await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ state: 'visible', timeout: 45_000 });
    await this.page
      .locator('[data-testid="v2-table-scroll-port"]')
      .waitFor({ state: 'visible', timeout: 45_000 })
      .catch(() => {});
    await this.page.waitForTimeout(1500);
  }

  /**
   * Turns a column on via the "Spalten" picker, leaving it alone when it is already on.
   *
   * BF is opt-in, so this is a precondition for every BF assertion rather than a test in its own
   * right. The picker is a `[role="dialog"]` of `[role="menuitem"]` rows, each wrapping a
   * `[role="checkbox"][aria-label="<column>"]` whose "✓" glyph is the only checked-state signal.
   */
  async enableColumn(label: string): Promise<void> {
    const checkbox = this.page.locator(`[role="checkbox"][aria-label="${label}"]`);
    await this.page.getByRole('button', { name: 'Spalten', exact: true }).click();
    await this.page
      .getByRole('button', { name: 'Alle auswählen', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 });
    const already = ((await checkbox.first().textContent().catch(() => '')) || '').includes('✓');
    if (!already) {
      await this.page
        .locator('[role="menuitem"]')
        .filter({ has: checkbox })
        .first()
        .click();
      await this.page.waitForTimeout(2000);
    }
    const close = this.page.getByRole('button', { name: 'Schließen', exact: true });
    if (await close.isVisible().catch(() => false)) await close.click();
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.page
      .locator('[role="dialog"][aria-modal="true"]')
      .first()
      .waitFor({ state: 'detached', timeout: 8_000 })
      .catch(() => {});
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
   * Expands the "Aktive Patienten" group so data rows render. It ships expanded, so this usually
   * returns immediately; when it doesn't, the header toggle has no stable selector, so it is clicked
   * (force) and confirmed by watching the per-row checkbox count grow.
   *
   * Note the group header is CSS-uppercased — it READS "AKTIVE PATIENTEN" but its `textContent`,
   * which is what Playwright matches, stays title-case.
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

  /** A column header, addressed by the table's own testid. */
  columnHeader(name: 'BF' | 'IB'): Locator {
    return this.page.locator(`[data-testid="v2-header-${TherapistAssessmentPage.COLUMN_KEYS[name]}"]`);
  }

  /** A column's cells, top to bottom. */
  columnCells(name: 'BF' | 'IB'): Locator {
    return this.page.locator(`[data-testid="v2-cell-${TherapistAssessmentPage.COLUMN_KEYS[name]}"]`);
  }

  /** The "+ IB" add-Initialbefund control (present once per active patient row). */
  ibAddControl(): Locator {
    return this.page.getByText('+ IB', { exact: true });
  }

  /**
   * Clicks the cell under a given column in the first data row and reports whether a modal opened.
   * Used for both the BF (Assessment) chip and the IB "+ IB" control. Returns false when the control
   * is inert (no modal surfaces) — it is disabled for some patient states, in which case the caller
   * should test.skip().
   */
  async openModalFromFirstRow(column: 'BF' | 'IB'): Promise<boolean> {
    const cell = this.columnCells(column).first();
    if (!(await cell.isVisible().catch(() => false))) return false;
    await cell.click({ force: true });
    await this.page
      .locator('[role="dialog"][aria-modal="true"], [data-testid="modal-surface"]')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => {});
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
    // The IB column now launches the 3.9 IB flow, whose opened surface depends on the row's IB
    // state: a NEW IB opens the signer dialog ("Wer unterschreibt?" + radios + "Weiter"); an
    // EXISTING/signed IB opens the "Infoblatt" PDF preview ("PDF herunterladen" / "Schließen" /
    // "Vorschau"). Either — as well as the Befund (BF) save/field form — is a valid opened surface.
    const surfaceText = await surface.innerText().catch(() => '');
    const hasSigner = /Wer unterschreibt|Weiter|Patient\/in/.test(surfaceText)
      || (await surface.locator('[role="radio"]').count()) > 0;
    const hasIbViewer = /Infoblatt|PDF herunterladen|Vorschau|Schließen/.test(surfaceText);
    expect(
      hasSave || hasField || hasSigner || hasIbViewer,
      'Assessment/IB modal should be a form, the IB signer dialog, or the Infoblatt preview',
    ).toBeTruthy();
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
