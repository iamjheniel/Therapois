import { Page, expect } from '@playwright/test';
import { boardSearchBox } from '../base/app.page';

/**
 * Patient-list helpers for the Therapist landing page.
 *
 * The therapist specs historically hard-coded patient names (e.g. "Aiah BiniTest",
 * "JhenTest QA") in search boxes. Those names drift as Staging/Production data changes,
 * which turned data churn into noisy test failures. This helper resolves an *existing*
 * patient from live data instead: it tries the historically-used name first (a hint), then
 * falls back to a broad search, and reports null when no patient is available at all — so
 * callers can `test.skip(...)` rather than time out.
 *
 * **The board redesign moved every hook this class used, and Production has not taken it yet**, so
 * each selector below accepts either shape:
 *  - the search box lost its `text-input-outlined` testid in favour of a "Patient, VO Nr. …"
 *    placeholder;
 *  - the empty state reads "Keine VOs für diese Auswahl" (was "Keine Patienten gefunden");
 *  - rows are `data-testid`-tagged (`v2-rail-cell-patient`) instead of being reachable only through
 *    the `.r-qklmqi` row-wrapper class.
 *
 * **Every action here carries an explicit timeout.** `actionTimeout` is 0 (disabled) project-wide, so
 * an action on a locator that never resolves waits FOREVER — and because it never rejects, the
 * `.catch(() => …)` guards these helpers rely on never fire. That turns one stale selector into a
 * hung worker rather than a skip.
 */
export class TherapistListPage {
  constructor(private page: Page) {}

  /** The board's search box, on either build. */
  private searchBox() {
    return boardSearchBox(this.page);
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
    await this.searchBox().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    await this.settle();
  }

  /**
   * Waits until the board has resolved — rows painted, or a settled empty state.
   *
   * A FIXED settle can't serve both callers here: the redesigned board needs ~10s to paint (a short
   * sleep reads an empty board and makes `resolvePatientName` report "no patient available" on an
   * environment holding 30 matches), but several specs call this in a loop over patients × therapists
   * inside a 180s budget, where a flat 10s per call exhausts the test before the work.
   *
   * So poll, and return the moment it is ready. Deliberately uses `locator(...).count()` rather than
   * `getByRole` — role queries walk the whole RNW accessibility tree and are far too slow to sit in a
   * hot loop.
   */
  private async settle(maxMs = 20_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if ((await this.page.locator('[data-testid="v2-rail-cell-patient"]').count()) > 0) return;
      const empty = await this.page
        .getByText(/Keine Patienten gefunden|Keine VOs für diese Auswahl/)
        .first()
        .isVisible()
        .catch(() => false);
      if (empty) return;
      await this.page.waitForTimeout(400);
    }
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
      await box.click({ timeout: 15_000 });
      await box.fill(term, { timeout: 15_000 });
      await box.press('Enter', { timeout: 15_000 });
      // A submitted search re-fetches, and the board shows its empty state while the request is in
      // flight — so read the result only after it has landed.
      await this.page.waitForTimeout(1200);
      await this.settle(15_000);
    }
  }

  /**
   * True when the list really has no results, under either build's wording.
   *
   * Requires BOTH the empty-state text AND zero selectable rows: the text also shows transiently
   * while a search is in flight, so the text alone reports a false empty.
   */
  async hasNoResults(): Promise<boolean> {
    const empty = await this.page
      .getByText(/Keine Patienten gefunden|Keine VOs für diese Auswahl/)
      .first()
      .isVisible()
      .catch(() => false);
    if (!empty) return false;
    // The empty-state text also flashes while a search is in flight, so it only counts as "no
    // results" when the board really has no rows.
    return (await this.selectableRowCount()) === 0;
  }

  /** Number of selectable patient rows. */
  async selectableRowCount(): Promise<number> {
    // Prefer the testid: it is a plain CSS match, where `getByRole` walks the whole RNW
    // accessibility tree — slow enough to matter in the loops that call this per iteration.
    const rows = await this.page.locator('[data-testid="v2-rail-cell-patient"]').count();
    if (rows) return rows;
    // The redesigned board labels the per-row boxes; older builds only offer an unlabelled set whose
    // first entry is the select-all header.
    const labelled = await this.page.getByRole('checkbox', { name: 'Zeile auswählen' }).count();
    if (labelled) return labelled;
    return Math.max(0, (await this.page.getByRole('checkbox').count()) - 1);
  }

  /**
   * Parses the first data row's patient name — the text between the row checkbox and the
   * first date cell (dd.mm.yyyy). Returns null if no row is rendered or the name can't be
   * parsed. Private-use-area glyphs (nerd-font checkbox/icons) are stripped first.
   */
  async firstRowName(): Promise<string | null> {
    // The redesigned board tags the patient cell, which renders "<name>\n<dd.mm.yyyy>".
    const cell = this.page.locator('[data-testid="v2-rail-cell-patient"]').first();
    if (await cell.count()) {
      const raw = (await cell.innerText({ timeout: 10_000 }).catch(() => '')) || '';
      const name = raw
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !/^\d{2}\.\d{2}\.\d{4}$/.test(l));
      if (name) return name;
    }
    // Older build: the name is only reachable through the row wrapper's own class. That class does
    // not exist on the redesigned board, so this must be timeout-bounded or it hangs forever.
    const raw = await this.page
      .locator('[role="checkbox"]')
      .nth(1)
      .locator('xpath=ancestor::div[contains(@class,"r-qklmqi")][1]')
      .innerText({ timeout: 8_000 })
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

  /** Selects the first filtered patient row. */
  async selectFirstPatientRow() {
    const labelled = this.page.getByRole('checkbox', { name: 'Zeile auswählen' });
    if (await labelled.count()) {
      await labelled.first().click({ force: true, timeout: 15_000 });
      return;
    }
    // Older build: nth(0) is the select-all header, so the first row is nth(1).
    await this.page.getByRole('checkbox').nth(1).click({ force: true, timeout: 15_000 });
  }
}
