import { Page, Locator, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';
import { settleAfter } from '../util/settle';

export type ColumnOption = { label: string; checked: boolean };

/**
 * Therapist Board v2 — the desktop table at `/therapist/`.
 *
 * DOM notes, all verified live on staging (React Native Web):
 *  - **Two boards exist at once.** `/therapist/` renders the v2 board, but clicking a patient's NAME
 *    navigates to the legacy board (wide table, "Spalten anzeigen" dropdown, "#" column). Every
 *    other therapist spec in this suite drives that legacy board. To expand a v2 row, click one of
 *    its ordinary data cells — a date works well — never the name.
 *  - **The table is `data-testid`-tagged now**: `v2-table-scroll-port` owns the horizontal scroll,
 *    `v2-table-header-rail` / `v2-header-<key>` the headers, `v2-cell-<key>` / `v2-rail-cell-<key>`
 *    the cells. Prefer these over the old geometry-based column probing.
 *  - **The toolbar is real `<button>`s** with `aria-label`s ("Filter", "Spalten", "Hinweise",
 *    "Aktivität erfassen"), and both panels are `[role="dialog"][aria-modal="true"]`.
 *  - **The Spalten picker rows are `[role="menuitem"]` wrapping `[role="checkbox"][aria-label]`.**
 *    The checkbox exposes no `aria-checked` — a column is on iff it renders a "✓" glyph.
 *  - **The checked-column set is a localStorage preference**, `column-select-therapist-board-v2`,
 *    holding the column KEYS (not labels) as a JSON array. Whatever a previous test checked sticks,
 *    so anything asserting the DEFAULT set has to clear that key and reload first — `open()` does.
 *  - **Rows are grouped** under collapsible "AKTIVE PATIENTEN" / "INAKTIVE PATIENTEN" headers.
 */
export class TherapistBoardV2Page extends AppPage {
  /** Where the checked-column set is persisted between visits (a JSON array of column keys). */
  static readonly COLUMN_PREF_KEY = 'column-select-therapist-board-v2';

  /** The default (checked) columns — 7 of the 16 the picker offers. */
  static readonly DEFAULT_COLUMNS = [
    'Ausst. Datum',
    'Startfrist / Gültigkeitsfrist',
    'TB',
    'Frequenz',
    'Tage seit Beh.',
    'Folge-VO Status',
    'Einrichtung',
  ] as const;

  /** The column KEYS the default set persists as, in the order the board stores them. */
  static readonly DEFAULT_COLUMN_KEYS = [
    'date',
    'deadlines',
    'therapyReport',
    'frequency',
    'daysSinceLastTreatment',
    'followupStatus',
    'elderlyCareHome',
  ] as const;

  /** The 9 columns the picker offers opt-in — off until a therapist turns them on. */
  static readonly OPT_IN_COLUMNS = [
    'BF',
    'WB/Zi',
    'HM',
    'Beh. Status',
    'VO Status',
    'IB',
    'Versicherungsart',
    'Bestell Status',
    'Therapeut',
  ] as const;

  /** The two identity columns, which the picker does NOT offer — they are always rendered. */
  static readonly FIXED_HEADERS = ['VO Nr.', 'Name'] as const;

  /** The headers the default column set puts on the table, left→right. */
  static readonly DEFAULT_HEADERS = [
    'VO Nr.',
    'Name',
    'Ausst. Datum',
    'Startfrist',
    'Gültig bis',
    'TB',
    'Frequenz',
    'Tage seit Beh.',
    'Folge-VO Status',
    'Einrichtung',
  ] as const;

  /** The picker's own summary while the board is on its defaults, e.g. "7/16". */
  static readonly DEFAULT_SUMMARY = '7/16';

  /** Every column the picker offers, in the order it lists them. */
  static readonly ALL_COLUMNS = [
    'Ausst. Datum',
    'Startfrist / Gültigkeitsfrist',
    'TB',
    'BF',
    'WB/Zi',
    'HM',
    'Frequenz',
    'Tage seit Beh.',
    'Beh. Status',
    'VO Status',
    'Folge-VO Status',
    'IB',
    'Versicherungsart',
    'Einrichtung',
    'Bestell Status',
    'Therapeut',
  ] as const;

  /**
   * The row groups the board splits its VOs into.
   *
   * Held in the case the DOM actually carries: the headers are CSS-uppercased
   * (`text-transform: uppercase`), so they READ as "AKTIVE PATIENTEN" and land in `innerText` that
   * way, but `textContent` — which is what Playwright's text engine matches — stays title-case.
   * `getByText('AKTIVE PATIENTEN')` therefore finds nothing.
   */
  static readonly ROW_GROUPS = ['Aktive Patienten', 'Inaktive Patienten'] as const;

  /** The board's own tabs, beside the "Hinweise" button. */
  static readonly TABS = ['Meine VOs', 'Geteilte VOs', 'Kalender'] as const;

  /** Discipline abbreviations the BF badge is required to use. */
  static readonly DISCIPLINE_ABBREVIATIONS = ['PT', 'ET', 'L'] as const;

  /** The labels no badge may use — a discipline is badged by its abbreviation, not spelled out. */
  static readonly DISCIPLINE_LONG_FORMS = ['Physiotherapie', 'Ergotherapie', 'Logopädie'] as const;

  constructor(page: Page) {
    super(page);
  }

  /** Opens the board at a given viewport with the column preference reset to its default. */
  async open(width = 1440, height = 900) {
    await this.page.setViewportSize({ width, height });
    await this.page.goto('/therapist/', { waitUntil: 'domcontentloaded' });
    // Clear the preference, and reload ONLY if one was actually stored. The reload is there so the
    // board re-renders without a pref it has already read — meaningless when there was none, which
    // is the common case: the therapist storageState carries no column preference, so all 60+
    // `open()` calls in the suite were paying for a second full page load of a slow RNW app to
    // un-see a key that was never there.
    //
    // NOT done with `addInitScript`: that runs on EVERY navigation, so it would also wipe the
    // preference the AC3 persistence test reloads specifically to prove survives.
    const hadStoredPref = await this.page.evaluate((k) => {
      const had = localStorage.getItem(k) !== null;
      localStorage.removeItem(k);
      return had;
    }, TherapistBoardV2Page.COLUMN_PREF_KEY);
    if (hadStoredPref) await this.page.reload({ waitUntil: 'domcontentloaded' });
    // Below ~900px the board renders the card list, which has no table to wait for.
    await this.waitForBoardReady(width >= 900);
  }

  /**
   * Waits until the board has actually painted, rather than sleeping a fixed interval.
   *
   * A fixed settle was enough on an idle machine and silently too short under parallel load: the
   * helpers below then read an unpainted board and report an EMPTY one — no headers, no rows, no
   * group — which surfaces as "enabling a column didn't add it" or "the board must hold rows",
   * failures that look like product bugs and vanish on re-run at `--workers=1`.
   */
  private async waitForBoardReady(expectTable = true, maxMs = 40_000) {
    // The search box proves the app itself rendered; it exists in both layouts.
    await this.searchBox().waitFor({ state: 'visible', timeout: maxMs }).catch(() => {});
    if (!expectTable) {
      // Card-list viewport: there is no table to wait for, so the app having rendered is the signal.
      await this.page.waitForTimeout(3000);
      return;
    }
    // NOTE: do NOT treat "no table yet" as ready. `isTableLayout()` is also false in the moments
    // BEFORE the table mounts, so breaking on it returns instantly on a desktop viewport and hands
    // callers an unpainted board — which then reads as zero rows and no headers.
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if ((await this.rowCount()) > 0) break;
      const empty = await this.page
        .getByText('Keine VOs für diese Auswahl')
        .first()
        .isVisible()
        .catch(() => false);
      if (empty) break;
      await this.page.waitForTimeout(700);
    }
    await this.page.waitForTimeout(1500);
  }

  /**
   * Runs a board interaction and waits for the refetch it triggers, rather than sleeping a guess.
   *
   * `fallbackMs` is the flat sleep this call used to perform, kept only as the shape of the upper
   * bound — see `Pages/util/settle.ts`. Passing a no-op action is legitimate: it waits out a repaint
   * that no request backs, which is most of the picker and selection interactions here.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 10_000) });
  }

  /** The persisted column preference, or null while the board is still on its default set. */
  async storedColumnKeys(): Promise<string[] | null> {
    const raw = await this.page.evaluate(
      (k) => localStorage.getItem(k),
      TherapistBoardV2Page.COLUMN_PREF_KEY,
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return null;
    }
  }

  /** True when the table layout is rendered rather than the narrow-screen card list. */
  async isTableLayout(): Promise<boolean> {
    // The scroll port only exists in the table layout; the card list renders neither it nor headers.
    return (await this.page.locator('[data-testid="v2-table-scroll-port"]').count()) > 0;
  }

  // ─────────────────────────────── header / summary ──────────────────────────

  /** The board's heading summary, e.g. "70 VOs · 33 aktiv". */
  async summary(): Promise<{ total: number; active: number } | null> {
    const txt = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    const m = txt.match(/([\d.,]+)\s*VOs\s*·\s*([\d.,]+)\s*aktiv/);
    if (!m) return null;
    const num = (s: string) => parseInt(s.replace(/[.,]/g, ''), 10);
    return { total: num(m[1]), active: num(m[2]) };
  }

  /** One of the board's tabs — `role="tab"` divs, so addressed by role. */
  tab(label: string): Locator {
    return this.page.getByRole('tab').filter({ hasText: label }).first();
  }

  /** Reads a tab's badge count ("Meine VOs 70" → 70), or null when it carries none. */
  async tabCount(label: string): Promise<number | null> {
    const txt = (await this.tab(label).innerText().catch(() => '')) || '';
    const m = txt.replace(label, '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  async openTab(label: string) {
    await this.settle(() => this.tab(label).click(), 5000);
  }

  /** The "Hinweise" reminder button, with its own badge count. */
  hinweise(): Locator {
    return this.page.getByRole('button', { name: 'Hinweise', exact: true });
  }

  async hinweiseCount(): Promise<number | null> {
    const txt = (await this.hinweise().innerText().catch(() => '')) || '';
    const m = txt.replace('Hinweise', '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** The offline-queue status line, e.g. "Stand von vor 0 Min · alles gesendet". */
  async syncStatus(): Promise<string | null> {
    const txt = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    const line = txt.split('\n').find((l) => /^Stand von/.test(l.trim()));
    return line ? line.trim() : null;
  }

  // ─────────────────────────────── layout metrics ────────────────────────────

  /** A header cell, addressed by its column key (e.g. `medications`). */
  header(key: string): Locator {
    return this.page.locator(`[data-testid="v2-header-${key}"]`);
  }

  /** The board's visible column headers, left to right. */
  async headerLabels(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const rail = document.querySelector('[data-testid="v2-table-header-rail"]');
      const port = document.querySelector('[data-testid="v2-table-scroll-port"]');
      const cells = [
        ...(rail ? rail.querySelectorAll('[data-testid^="v2-header-"]') : []),
        ...(port ? port.querySelectorAll('[data-testid^="v2-header-"]') : []),
      ] as HTMLElement[];
      const seen = new Set<string>();
      return cells
        .filter((e) => {
          const id = e.getAttribute('data-testid') || '';
          if (seen.has(id)) return false;
          seen.add(id);
          // The deadlines cell is a CONTAINER holding two sortable sub-headers
          // ("v2-header-sort-treatmentStartDeadline" / "…-validityDate") that render as the two
          // real columns "Start" and "Gültig". Keeping the container too would report its combined
          // label ("Start / Gültig") as a third column.
          return !e.querySelector('[data-testid^="v2-header-"]');
        })
        .map((e) => ({ text: (e.innerText || '').trim(), x: e.getBoundingClientRect().left }))
        .map((o) => ({
          ...o,
          text: o.text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !['↕', '↑', '↓'].includes(l))
            .join(' / '),
        }))
        .filter((o) => o.text)
        .sort((a, b) => a.x - b.x)
        .map((o) => o.text);
    });
  }

  /** A column's rendered width, taken from its header cell. */
  async columnWidth(key: string): Promise<number | null> {
    // `locator.evaluate()` WAITS for the element, and `actionTimeout` is 0 project-wide — so on a
    // column the board is not rendering this never rejects and the trailing `.catch` never fires;
    // it just hangs to the test timeout. An explicit timeout is what makes "not rendered" return
    // null instead of taking out the worker.
    return await this.header(key)
      .evaluate((el) => Math.round(el.getBoundingClientRect().width), undefined, { timeout: 5_000 })
      .catch(() => null);
  }

  /**
   * Scroll metrics of the table's own horizontal scroll container.
   *
   * The document itself never overflows sideways, so asserting on `window` would pass even with the
   * table clipped — the port is the only element that can answer this.
   */
  async tableScroll(): Promise<{ scrollWidth: number; clientWidth: number } | null> {
    return await this.page
      .locator('[data-testid="v2-table-scroll-port"]')
      // Explicit timeout for the same reason as `columnWidth`: the port does not exist in the card
      // layout, and without one this hangs rather than returning null.
      .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }), undefined, {
        timeout: 10_000,
      })
      .catch(() => null);
  }

  /** Scroll metrics of the document — the page must not scroll sideways either. */
  async documentScroll(): Promise<{ scrollWidth: number; clientWidth: number }> {
    return await this.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
  }

  // ──────────────────────────── the Spalten picker ───────────────────────────

  /** The single mounted panel — the Spalten picker and the Filter panel share this node. */
  panel(): Locator {
    return this.page.locator('[role="dialog"]');
  }

  async openColumnPicker() {
    if (!(await this.isColumnPickerOpen())) {
      await this.page.getByRole('button', { name: 'Spalten', exact: true }).click();
      await this.page
        .getByRole('button', { name: 'Alle auswählen', exact: true })
        .waitFor({ state: 'visible', timeout: 15_000 });
    }
    // The panel chrome ("Alle auswählen", the n/m summary) mounts a beat before its rows do, and
    // `evaluateAll` does NOT auto-wait — reading straight after the sentinel returns an empty list.
    await this.panel()
      .locator('[role="checkbox"][aria-label]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
  }

  private async isColumnPickerOpen(): Promise<boolean> {
    return await this.page
      .getByRole('button', { name: 'Alle auswählen', exact: true })
      .isVisible()
      .catch(() => false);
  }

  async closeColumnPicker() {
    const close = this.page.getByRole('button', { name: 'Schließen', exact: true });
    if (await close.isVisible().catch(() => false)) await close.click();
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.waitForModal('closed');
  }


  /**
   * Waits for the single modal panel to reach a state, instead of sleeping a flat interval.
   *
   * Only safe for DOM STATE transitions (a panel mounting or unmounting). Do NOT use this shape to
   * settle a NUMERIC read after a filter/search click: the table is momentarily unchanged while the
   * request is still in flight, so a "has it stopped moving" check is satisfied before the action
   * has taken effect at all — that reads the pre-click value and fails as a product bug.
   */
  private async waitForModal(state: 'open' | 'closed', maxMs = 8_000): Promise<void> {
    await this.page
      .locator('[role="dialog"][aria-modal="true"]')
      .first()
      .waitFor({ state: state === 'open' ? 'visible' : 'detached', timeout: maxMs })
      .catch(() => {});
  }

  /** Every column the picker offers, in order, with its checked state. */
  async columnOptions(): Promise<ColumnOption[]> {
    await this.openColumnPicker();
    return await this.panel()
      .locator('[role="checkbox"]')
      .evaluateAll((els) =>
        els.map((e) => ({
          label: e.getAttribute('aria-label') || '',
          checked: (e.textContent || '').includes('✓'),
        })),
      );
  }

  /** The picker's own "<visible>/<total>" summary, e.g. "7/16". */
  async columnSummary(): Promise<string | null> {
    await this.openColumnPicker();
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    return txt.split('\n').map((l) => l.trim()).find((l) => /^\d+\/\d+$/.test(l)) ?? null;
  }

  /** Toggles a column from within the (already open) picker, by its checkbox `aria-label`. */
  async toggleColumn(label: string) {
    await this.openColumnPicker();
    await this.panel()
      .locator('[role="menuitem"]')
      .filter({ has: this.page.locator(`[role="checkbox"][aria-label="${label}"]`) })
      .first()
      .click();
    // Toggling a column repaints from data already held, so this normally costs a paint, not a
    // refetch — `settle` returns as soon as it sees that rather than sitting out the old 2 s.
    await this.settle(async () => {}, 2000);
  }

  /** Turns a column on (or off) and closes the picker so the table can be asserted. */
  async setColumn(label: string, on: boolean) {
    const current = (await this.columnOptions()).find((o) => o.label === label);
    if (!current) throw new Error(`setColumn: the Spalten picker offers no column "${label}"`);
    if (current.checked !== on) await this.toggleColumn(label);
    await this.closeColumnPicker();
  }

  // ──────────────────────────────── Filter panel ─────────────────────────────

  async openFilterPanel() {
    if (await this.isFilterPanelOpen()) return;
    await this.page.getByRole('button', { name: 'Filter', exact: true }).click();
    await this.page
      .getByRole('button', { name: 'Alle löschen', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  private async isFilterPanelOpen(): Promise<boolean> {
    return await this.page
      .getByRole('button', { name: 'Alle löschen', exact: true })
      .isVisible()
      .catch(() => false);
  }

  async closeFilterPanel() {
    const close = this.page.getByRole('button', { name: 'Schließen', exact: true });
    if (await close.isVisible().catch(() => false)) await close.click();
    await this.waitForModal('closed');
  }

  /** The live "Ergebnis: N VOs" preview the panel shows for the current filter set. */
  async filterResultCount(): Promise<number | null> {
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    const m = txt.replace(/ /g, ' ').match(/Ergebnis:\s*([\d.,]+)\s*VOs/);
    return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null;
  }

  /** The panel's section headings, e.g. EINRICHTUNG / VO STATUS / BEHANDLUNGSLÜCKE. */
  async filterSections(): Promise<string[]> {
    await this.openFilterPanel();
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l === l.toUpperCase() && /[A-ZÄÖÜ]{4,}/.test(l) && l !== 'FILTER');
  }

  /** Every option the panel offers, as its own button — the sections list inline, not as dropdowns. */
  filterOption(label: string): Locator {
    return this.panel().getByRole('button', { name: label, exact: true });
  }

  /** Applies one filter option and closes the panel so the table underneath can be asserted. */
  async applyFilter(label: string) {
    await this.openFilterPanel();
    await this.settle(() => this.filterOption(label).click(), 3000);
    await this.closeFilterPanel();
  }

  async clearFilters() {
    await this.openFilterPanel();
    await this.settle(
      () => this.page.getByRole('button', { name: 'Alle löschen', exact: true }).click(),
      2500,
    );
    await this.closeFilterPanel();
  }

  /**
   * The option labels one filter section offers.
   *
   * The panel lists its options inline as buttons under CSS-uppercased section headings, so the
   * heading is matched upper-case (that is how it arrives in `innerText`) and the options are the
   * lines between it and the next heading.
   */
  async filterOptionLabels(section: string): Promise<string[]> {
    await this.openFilterPanel();
    const lines = ((await this.panel().innerText().catch(() => '')) || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const isHeading = (l: string) => l === l.toUpperCase() && /[A-ZÄÖÜ]{4,}/.test(l);
    const start = lines.findIndex((l) => l === section.toUpperCase());
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (isHeading(lines[i])) break;
      out.push(lines[i]);
    }
    return out;
  }

  // ──────────────────────────────── search box ───────────────────────────────

  /** The board's free-text search box. */
  searchBox(): Locator {
    return this.page.getByPlaceholder(/Patient, VO/i).first();
  }

  /** Types a query into the search box and submits it. */
  async search(query: string) {
    const box = this.searchBox();
    await box.click();
    await box.fill(query);
    await this.settle(() => box.press('Enter'), 4000);
  }

  /**
   * Clears the search via the "✕" control the box grows once a query is active.
   *
   * The box is no longer readonly while a search is applied, so this resets it in place — no reload
   * needed, and the column selection survives.
   */
  async clearSearch() {
    const clear = this.page.getByText('✕', { exact: true }).filter({ visible: true }).first();
    await this.settle(async () => {
      if (await clear.isVisible().catch(() => false)) await clear.click({ force: true });
      else await this.searchBox().fill('');
    }, 4000);
  }

  // ──────────────────────────────── rows / groups ────────────────────────────

  /** The number of VO rows the table has painted. */
  async rowCount(): Promise<number> {
    return await this.page.locator('[data-testid="v2-rail-cell-prescriptionId"]').count();
  }

  /**
   * A row group's header. Pass the title-case label ("Aktive Patienten") — see `ROW_GROUPS` for why
   * the rendered upper-case form does not match.
   */
  group(label: string): Locator {
    return this.page.getByText(new RegExp(`^${label}$`, 'i')).first();
  }

  /** Reads a group header's count badge. */
  async groupCount(label: string): Promise<number | null> {
    const txt = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    const lines = txt.split('\n').map((l) => l.trim());
    // `innerText` renders the CSS-uppercased form, so match on that.
    const idx = lines.indexOf(label.toUpperCase());
    if (idx < 0) return null;
    for (let j = idx + 1; j <= Math.min(lines.length - 1, idx + 2); j++) {
      if (/^\d+$/.test(lines[j])) return parseInt(lines[j], 10);
    }
    return null;
  }

  /** The distinct values a column's cells render, addressed by column key. */
  async columnCellValues(key: string): Promise<string[]> {
    const values = await this.page
      .locator(`[data-testid="v2-cell-${key}"]`)
      .evaluateAll((els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean));
    return [...new Set(values)];
  }

  /**
   * The discipline badges rendered in the BF column, with the VO number of the row each sits on.
   *
   * BF ships opt-in, so enable it first: `setColumn('BF', true)`. Rows without a Befund render the
   * literal "Kein BF", which is not a badge and is filtered out here.
   */
  async bfBadges(): Promise<{ badge: string; vo: string }[]> {
    return await this.page.evaluate(() => {
      const out: { badge: string; vo: string }[] = [];
      for (const cell of [...document.querySelectorAll('[data-testid="v2-cell-bfStatus"]')] as HTMLElement[]) {
        const text = (cell.textContent || '').trim();
        if (!text || text === 'Kein BF') continue;
        const y = cell.getBoundingClientRect().top;
        const rail = [...document.querySelectorAll('[data-testid="v2-rail-cell-prescriptionId"]')].find(
          (e) => Math.abs(e.getBoundingClientRect().top - y) < 20,
        );
        out.push({ badge: text, vo: ((rail?.textContent || '').trim().split('\n')[0] || '?').trim() });
      }
      return out;
    });
  }

  // ────────────────────────── the Hinweise reminder panel ───────────────────────

  /**
   * Opens the "Hinweise" panel — where the board's review reminders now live.
   *
   * These used to render as yellow "Überprüfen" banners above the patient list; that surface is gone
   * and its three reminders ("N Patienten seit 14+ Tagen nicht behandelt", "N VOs laufen in 14 Tagen
   * aus", "N Therapieberichte fällig") are now sections of this panel, each listing its worst three
   * entries over a "Diese anzeigen" control.
   */
  async openHinweise() {
    await this.hinweise().click();
    await this.waitForModal('open', 10_000);
    await expect(this.panel(), 'the Hinweise panel must open').toBeVisible({ timeout: 15_000 });
  }

  /**
   * The reminder headlines the panel lists, e.g. "18 Patienten seit 14+ Tagen nicht behandelt".
   * Empty when the therapist has nothing due.
   */
  async hinweiseHeadlines(): Promise<string[]> {
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) =>
        /^\d+\s+(Patienten|VOs|Therapieberichte)\b/.test(l) &&
        /(nicht behandelt|laufen in|fällig)/.test(l),
      );
  }

  /**
   * The "Diese anzeigen" control of the nth reminder section — the one that takes the therapist to
   * the affected rows.
   *
   * The label is CSS-uppercased, so it READS "DIESE ANZEIGEN" while its `textContent` — what
   * Playwright matches — stays "Diese anzeigen".
   */
  hinweiseShowAll(index = 0): Locator {
    return this.panel().getByRole('button', { name: 'Diese anzeigen', exact: true }).nth(index);
  }

  /**
   * The patient/VO entries listed under ONE reminder section, by its index in
   * {@link hinweiseHeadlines}.
   *
   * The panel stacks all three reminders and every entry in all of them is a `<button>`, so a flat
   * scrape returns the union — 9 entries on a typical board (3 sections previewing 3 each) no matter
   * which reminder the caller meant. Comparing that against a single headline's count compares two
   * different things, and that is exactly how the 14-day assertion came to fail against a perfectly
   * healthy panel: 9 scraped entries against the 14-day section's count of 6.
   *
   * Each section opens with its own "Diese anzeigen" control, so those buttons are the section
   * boundaries — everything between boundary n and boundary n+1 belongs to reminder n.
   *
   * Note the boundary match must stay case-insensitive: the label is CSS-uppercased and `innerText`
   * (unlike `textContent`) reflects that, so it arrives here as "DIESE ANZEIGEN".
   */
  async hinweiseEntries(sectionIndex = 0): Promise<string[]> {
    const all = await this.panel()
      .locator('button')
      .evaluateAll((els) =>
        els.map((e) => ((e as HTMLElement).innerText || '').trim().replace(/\n/g, ' · ')),
      );

    const boundaries = all.reduce<number[]>((acc, text, i) => {
      if (/^Diese anzeigen$/i.test(text)) acc.push(i);
      return acc;
    }, []);
    if (boundaries.length === 0) return all.filter(Boolean);

    const start = boundaries[sectionIndex];
    if (start === undefined) return [];
    const end = boundaries[sectionIndex + 1] ?? all.length;
    return all.slice(start + 1, end).filter(Boolean);
  }

  // ─────────────────────────── row selection action bar ──────────────────────

  /** A row's select checkbox — the header one is "Alle auswählen", the rows "Zeile auswählen". */
  rowCheckbox(index = 0): Locator {
    return this.page.getByRole('checkbox', { name: 'Zeile auswählen' }).nth(index);
  }

  /** Ticks a row and waits for the bulk action bar to appear. */
  async selectRow(index = 0) {
    await this.rowCheckbox(index).click({ force: true });
    // No settle: the assertion below IS the wait, and it retries for 15 s on its own.
    await expect(
      this.page.getByText(/^\d+ ausgewählt$/).first(),
      'ticking a row must raise the selection action bar',
    ).toBeVisible({ timeout: 15_000 });
  }

  /** How many rows the action bar reports as selected. */
  async selectedCount(): Promise<number | null> {
    const txt = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    const m = txt.match(/(\d+) ausgewählt/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** The actions the selection bar offers, left to right. */
  async selectionActions(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const all = [...document.querySelectorAll('button, div[tabindex="0"]')] as HTMLElement[];
      const anchor = all.find((e) => /^\d+ ausgewählt$/.test((e.innerText || '').trim()))
        ?? [...document.querySelectorAll('*')].find(
          (e) => e.children.length === 0 && /^\d+ ausgewählt$/.test((e.textContent || '').trim()),
        ) as HTMLElement | undefined;
      if (!anchor) return [];
      const y = anchor.getBoundingClientRect().top;
      return all
        .map((e) => ({ t: (e.innerText || '').trim(), r: e.getBoundingClientRect() }))
        .filter((b) => b.t && b.r.width > 0 && Math.abs(b.r.top - y) < 30)
        .sort((a, b) => a.r.left - b.r.left)
        .map((b) => b.t.replace(/\s*[▾▼]\s*$/, '').trim());
    });
  }

  /** Drops the selection again via "Auswahl aufheben". */
  async clearSelection() {
    await this.settle(
      () => this.page.getByText('Auswahl aufheben', { exact: true }).first().click(),
      2000,
    );
  }

  /**
   * Opens the selection bar's "Bestellt von" action and returns the lines of the confirmation it
   * raises.
   *
   * This is no longer a Therapeut/Admin picker: the action sets the order status straight to
   * "Vom Therapeuten" and asks to confirm first, over a summary ("N Patienten, M VO/s werden
   * aktualisiert."), an explanation, and a Patient / VO Nr. / Bestellt von table showing the
   * current → new status for every selected VO.
   *
   * Deliberately read-only — confirming would write the order status, so callers cancel.
   */
  async openBestelltVon(): Promise<string[]> {
    await this.page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1')),
    );
    await this.page.getByText('Bestellt von', { exact: true }).first().click();
    await this.waitForModal('open');
    return await this.page.evaluate(() =>
      [...document.querySelectorAll('*:not([data-qa-seen])')]
        .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean),
    );
  }

  /** Dismisses the "Bestellt von" confirmation without writing anything. */
  async cancelBestelltVon() {
    const cancel = this.page.getByText('Abbrechen', { exact: true }).filter({ visible: true }).first();
    if (await cancel.isVisible().catch(() => false)) await cancel.click({ force: true });
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.waitForModal('closed');
  }

  // ─────────────────────────────── expanded row ──────────────────────────────

  /**
   * Expands a row by clicking one of its ordinary cells.
   *
   * `cellText` must be a value from a NON-name cell (a date works well): clicking the patient name
   * leaves the v2 board entirely for the legacy one.
   */
  async expandRowByCell(cellText: string) {
    // Explicit timeout: `actionTimeout` is 0 project-wide, so a click on a cell that never resolves
    // hangs the worker instead of failing.
    await this.page.getByText(cellText, { exact: true }).first().click({ timeout: 30_000 });
    await expect(
      this.page.getByText('Doku erfassen', { exact: true }).filter({ visible: true }).first(),
      'the expanded row detail must render its action bar',
    ).toBeVisible({ timeout: 20_000 });
  }

  /**
   * Expands the first row of the table by clicking one of its ordinary (non-name) cells.
   *
   * This used to pin the HM cell (`v2-cell-medications`). v3.11.0 moved HM out of the default
   * column set, so that cell is not rendered — and with `actionTimeout: 0` the click did not fail,
   * it HUNG until the test timeout. Resolve against whichever default data column is actually
   * painted, and give the click an explicit timeout so a future column change fails fast.
   */
  async expandFirstRow() {
    const candidates = TherapistBoardV2Page.DEFAULT_COLUMN_KEYS;
    let cell: Locator | null = null;
    for (const key of candidates) {
      const c = this.page.locator(`[data-testid="v2-cell-${key}"]`).first();
      if ((await c.count()) > 0) {
        cell = c;
        break;
      }
    }
    if (!cell) {
      throw new Error(
        `expandFirstRow: none of the default data columns (${candidates.join(', ')}) is rendered — ` +
          'the board is unpainted or the default column set changed again',
      );
    }
    await cell.click({ timeout: 30_000 });
    await expect(
      this.page.getByText('Doku erfassen', { exact: true }).filter({ visible: true }).first(),
      'the expanded row detail must render its action bar',
    ).toBeVisible({ timeout: 20_000 });
  }

  /** The action buttons rendered in the expanded row's bar, left to right. */
  async detailButtons(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const all = [...document.querySelectorAll('button, div[tabindex="0"]')] as HTMLElement[];
      const primary = all.find((e) => (e.innerText || '').trim() === 'Doku erfassen');
      if (!primary) return [];
      const y = primary.getBoundingClientRect().top;
      return all
        .map((e) => ({ t: (e.innerText || '').trim(), r: e.getBoundingClientRect() }))
        .filter((b) => b.t && b.r.width > 0 && Math.abs(b.r.top - y) < 12)
        .sort((a, b) => a.r.left - b.r.left)
        .map((b) => b.t.replace(/\s*[▾▼]\s*$/, '').trim());
    });
  }

  /** Opens the expanded row's "Weitere ▾" menu and returns its items. */
  async openWeitere(): Promise<string[]> {
    await this.page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1')),
    );
    await this.page.getByText('Weitere', { exact: false }).filter({ visible: true }).first().click();
    await this.waitForModal('open');
    return await this.page.evaluate(() =>
      [...document.querySelectorAll('*:not([data-qa-seen])')]
        .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean),
    );
  }

  /** Text of the expanded row's detail panel. */
  async detailPanelText(): Promise<string> {
    const text = (await this.page.locator('#root').innerText()) || '';
    const start = text.indexOf('VERORDNUNG');
    if (start < 0) return '';
    return text.slice(start, start + 1500);
  }
}
