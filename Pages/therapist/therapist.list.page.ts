import { Page, expect } from '@playwright/test';

/**
 * Patient-list helpers for the Therapist landing page.
 *
 * The therapist specs historically hard-coded patient names (e.g. "Aiah BiniTest",
 * "JhenTest QA") in search boxes. Those names drift as Staging/Production data changes,
 * which turned data churn into noisy test failures. This helper resolves an *existing*
 * patient from live data instead: it tries the historically-used name first (a hint), then
 * falls back to a broad search, and reports null when no patient is available at all — so
 * callers can `test.skip(...)` rather than time out.
 */
export class TherapistListPage {
  constructor(private page: Page) {}

  private searchBox() {
    return this.page.getByTestId('text-input-outlined').first();
  }

  /**
   * Reloads the therapist landing page (using the current origin) to a clean, unfiltered state.
   * Uses 'domcontentloaded' rather than 'networkidle' — Production has continuous background
   * polling, so 'networkidle' never settles and times out. A short fixed settle lets the
   * patient list paint.
   */
  async reload() {
    const origin = new URL(this.page.url()).origin;
    await this.page.goto(`${origin}/therapist/`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(1500);
  }

  /**
   * Searches for a patient. The app marks the search input readonly while a filter is active,
   * so we always reload to a clean state first (clearing via fill('') is rejected). An empty
   * term just leaves the unfiltered "today" list.
   */
  async searchPatient(term: string) {
    await this.reload();
    if (term) {
      const box = this.searchBox();
      await box.click();
      await box.fill(term);
      await box.press('Enter');
    }
    await this.page.waitForTimeout(1500);
  }

  /** True when the list shows the "no patients found" empty state. */
  async hasNoResults(): Promise<boolean> {
    return this.page
      .getByText('Keine Patienten gefunden')
      .isVisible()
      .catch(() => false);
  }

  /** Number of selectable patient rows (excludes the select-all header checkbox at nth(0)). */
  async selectableRowCount(): Promise<number> {
    return Math.max(0, (await this.page.getByRole('checkbox').count()) - 1);
  }

  /**
   * Parses the first data row's patient name — the text between the row checkbox and the
   * first date cell (dd.mm.yyyy). Returns null if no row is rendered or the name can't be
   * parsed. Private-use-area glyphs (nerd-font checkbox/icons) are stripped first.
   */
  async firstRowName(): Promise<string | null> {
    const raw = await this.page
      .locator('[role="checkbox"]')
      .nth(1)
      .locator('xpath=ancestor::div[contains(@class,"r-qklmqi")][1]')
      .innerText()
      .catch(() => '');
    const cleaned = raw.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/gu, '').trim();
    const m = cleaned.match(/^(.+?)\s*\d{2}\.\d{2}\.\d{4}/u);
    return m ? m[1].trim() : null;
  }

  /**
   * Resolves an existing patient name from live data. Tries each `preferred` term first
   * (historically hard-coded names), then a broad 'Test' search, then today's unfiltered
   * list. Leaves that patient filtered in the list. Returns the patient's display name, or
   * null if none is available anywhere (caller should test.skip).
   */
  async resolvePatientName(preferred: string[] = []): Promise<string | null> {
    for (const term of [...preferred, 'Test', '']) {
      await this.searchPatient(term);
      if (await this.hasNoResults()) continue;
      if ((await this.selectableRowCount()) < 1) continue;
      const name = await this.firstRowName();
      if (name) {
        // Re-filter to just this patient so the caller's nth(1) row selection is unambiguous.
        await this.searchPatient(name);
        if (!(await this.hasNoResults()) && (await this.selectableRowCount()) >= 1) return name;
      }
    }
    return null;
  }

  /** Selects the first filtered patient row (checkbox nth(1); nth(0) is the select-all header). */
  async selectFirstPatientRow() {
    await this.page.getByRole('checkbox').nth(1).click({ force: true });
  }
}
