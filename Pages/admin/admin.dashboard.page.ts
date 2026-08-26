import { Page, Locator, expect } from '@playwright/test';

export type ColumnOption = { label: string; checked: boolean };

/**
 * Page Object for the Admin Board (Flow) — the main VO table at `/dashboard`.
 *
 * Encapsulates the top-bar controls: the free-text search box, the summary status pills (which
 * double as quick filters), the "Filter" slide-in panel that houses every column filter, the
 * "Spalten" column chooser and the pager (page numbers plus a "Zeilen pro Seite" selector).
 *
 * DOM notes, all verified live on staging (React Native Web):
 *  - **The toolbar is real `<button>`s again.** "Filter" and "Spalten" carry `aria-label`s, so
 *    `getByRole('button', { name })` is the stable hook — the old `div[tabindex="0"]` + glyph-regex
 *    matching no longer resolves them.
 *  - **Both panels are `[role="dialog"][aria-modal="true"]`, and only ONE is mounted at a time.**
 *    Opening a filter dropdown from inside the Filter panel *replaces* the dialog with the option
 *    list, then restores the panel once an option is picked. So `filterPanel()` and the option list
 *    are the same locator at different moments — never assert on both at once.
 *  - **The column chooser rows are `[role="menuitem"]` wrapping a `[role="checkbox"][aria-label]`.**
 *    The checkbox carries NO `aria-checked`; a column is on iff its checkbox renders a "✓" glyph.
 *  - **The summary pills are still plain divs** with no role — they stay text-addressed.
 *  - **The checked-column set persists** in `localStorage['hidden_column_admin:dashboard']` and the
 *    page size in `localStorage['dashboardV2.perPage']`, so anything asserting the DEFAULTS has to
 *    clear those first: `open({ resetPreferences: true })`.
 */
export class AdminDashboardPage {
  constructor(private page: Page) {}

  /** Where the hidden-column set and the page size are persisted between visits. */
  static readonly COLUMN_PREF_KEY = 'hidden_column_admin:dashboard';
  static readonly PER_PAGE_PREF_KEY = 'dashboardV2.perPage';

  /** The summary status pills, left→right. Each is also a quick filter over the table. */
  static readonly PILLS = [
    'Folge-VO erhalten',
    'Keine Folge-VO',
    'Fertig behandelt',
    'Zur Prüfung',
    'Alle VOs',
    'Alle inkl. Archivierte',
  ];

  /** The columns the board ships with, left→right (10 of the 38 the chooser offers). */
  static readonly DEFAULT_COLUMNS = [
    'Versicherungsart',
    'Heilmittel',
    'ICD',
    'Einrichtung',
    'Therapeut',
    'Ausst. Datum',
    'Beh. Status',
    'Folge-VO Status',
    'VO Status',
    'Abrechnungsvalidierungsstatus',
  ] as const;

  /** The two identity columns, which the chooser does NOT offer — they are always rendered. */
  static readonly FIXED_COLUMNS = ['VO #', 'PATIENT'] as const;

  /** Page sizes the "Zeilen pro Seite" selector offers besides the default 30. */
  static readonly PAGE_SIZES = [10, 50, 100] as const;

  /**
   * Loads the board and waits until the VO table has painted real data.
   *
   * Pass `resetPreferences` when the test asserts the DEFAULT column set or page size — both are
   * sticky localStorage preferences that a previous test (or a human) may have changed.
   */
  async open(
    opts: { baseUrl?: string; resetPreferences?: boolean } = {},
  ): Promise<void> {
    const { baseUrl = 'https://staging.therapios.de', resetPreferences = false } = opts;
    await this.page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    if (resetPreferences) {
      // Reload only when a preference was actually stored. (The Admin storageState DOES ship
      // `hidden_column_admin:dashboard`, so this usually still reloads — the guard just stops it
      // being unconditional.)
      const hadStoredPrefs = await this.page.evaluate(
        ([col, per]) => {
          const had = localStorage.getItem(col) !== null || localStorage.getItem(per) !== null;
          localStorage.removeItem(col);
          localStorage.removeItem(per);
          return had;
        },
        [AdminDashboardPage.COLUMN_PREF_KEY, AdminDashboardPage.PER_PAGE_PREF_KEY],
      );
      if (hadStoredPrefs) await this.page.reload({ waitUntil: 'domcontentloaded' });
    }
    await this.page.getByText('VO #', { exact: true }).first().waitFor({ timeout: 30_000 });
    await expect(this.totalRange()).toHaveText(/von\s+[1-9]/, { timeout: 30_000 });
  }

  // ------------------------------------------------------------------ header / totals

  /** The board's own heading line, e.g. "Verordnungen (VO) · 7.432 gesamt". */
  headerTotal(): Locator {
    return this.page.getByText(/Verordnungen \(VO\)\s*·\s*[\d.,]+\s*gesamt/).first();
  }

  /** The pagination range label, e.g. "1–30 von 7.432". */
  totalRange(): Locator {
    return this.page.getByText(/\d+\s*[–-]\s*\d+\s+von\s+[\d.,]+/).first();
  }

  /** Parses the total row count from the pagination range ("1–30 von 7.432" → 7432). */
  async totalCount(): Promise<number> {
    const txt = ((await this.totalRange().textContent()) || '').replace(/ /g, ' ').trim();
    const m = txt.match(/von\s+([\d.,]+)\s*$/);
    // German thousands separators: "7.432" → 7432.
    return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : NaN;
  }

  /** Parses the total off the board heading — the same number the pager reports. */
  async headerTotalCount(): Promise<number> {
    const txt = ((await this.headerTotal().textContent()) || '').replace(/ /g, ' ');
    const m = txt.match(/·\s*([\d.,]+)\s*gesamt/);
    return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : NaN;
  }

  // ------------------------------------------------------------------ pager controls

  /** The number of rows actually rendered in the table body. */
  async renderedRowCount(): Promise<number> {
    const lines = await this.rootLines();
    const start = lines.indexOf('VO #');
    if (start < 0) return 0;
    let n = 0;
    for (let i = start + 1; i < lines.length; i++) if (/^\d+-\d+$/.test(lines[i])) n++;
    return n;
  }

  /** A windowed page-number pressable, or the "‹"/"›" arrows — all plain `div[tabindex="0"]`. */
  private pagerControl(label: string): Locator {
    return this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(`^${label}$`) })
      .filter({ visible: true })
      .last();
  }

  /** Advances one page via the "›" arrow. */
  async nextPage(): Promise<void> {
    await this.pagerControl('›').click({ force: true });
    await this.page.waitForTimeout(2500);
  }

  /** Steps back one page via the "‹" arrow (inert on page 1). */
  async prevPage(): Promise<void> {
    await this.pagerControl('‹').click({ force: true });
    await this.page.waitForTimeout(2500);
  }

  /** Jumps to a page by its number, as shown in the windowed page list. */
  async gotoPage(n: number): Promise<void> {
    await this.pagerControl(String(n)).click({ force: true });
    await this.page.waitForTimeout(2500);
  }

  /** The current page size, read off the "Zeilen pro Seite" selector's own aria-label. */
  async rowsPerPage(): Promise<number> {
    const al = (await this.rowsPerPageControl().getAttribute('aria-label')) || '';
    const m = al.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : NaN;
  }

  private rowsPerPageControl(): Locator {
    return this.page.getByRole('button', { name: /^Zeilen pro Seite/ }).first();
  }

  /** Opens the "Zeilen pro Seite" selector and picks a page size. */
  async setRowsPerPage(size: number): Promise<void> {
    if ((await this.rowsPerPage()) === size) return;
    await this.rowsPerPageControl().click();
    await this.page.waitForTimeout(1500);
    // The options open in the same portalled `[role="dialog"]` the panels use. Scoping to it matters:
    // the table and the pager both render bare numbers that would otherwise match.
    await this.panel()
      .getByText(String(size), { exact: true })
      .filter({ visible: true })
      .first()
      .click({ force: true });
    await this.page.waitForTimeout(3000);
  }

  private async rootLines(): Promise<string[]> {
    const txt = await this.page.locator('#root').innerText().catch(() => '');
    return txt.split('\n').map((l) => l.trim());
  }

  /**
   * Reads the first data row's VO number. Rows render under a "VO #" / "PATIENT" header as
   * "<VO-Nr>" / "<Patient name>" / "<dd.mm.yyyy>", e.g. "7624-6" / "Monika Ahrends".
   */
  async firstRowVoNumber(): Promise<string | null> {
    const lines = await this.rootLines();
    const start = lines.indexOf('VO #');
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\d+-\d+)$/);
      if (m) return m[1];
    }
    return null;
  }

  /** Reads the patient name of the first data row (the line following its VO number). */
  async firstRowPatientName(): Promise<string | null> {
    const lines = await this.rootLines();
    const start = lines.indexOf('VO #');
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\d+-\d+$/.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]) return lines[j];
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ free-text search

  private searchBox(): Locator {
    // The placeholder was retitled from "Suchen" to name what it matches.
    return this.page.getByPlaceholder(/suchen/i).first();
  }

  /**
   * Types a query into the search box and submits it. Note: once submitted the box renders
   * `readonly` and offers no clear control — the only reset is a page reload (see `open`), which
   * the serial `beforeEach` performs between tests to keep them isolated.
   */
  async search(query: string): Promise<void> {
    const box = this.searchBox();
    await box.click();
    await box.fill(query);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(2500);
  }

  // ------------------------------------------------------------------ summary status pills

  /** A summary pill by its exact label. */
  pill(label: string): Locator {
    return this.page.getByText(label, { exact: true }).first();
  }

  /** Reads a pill's badge count (the number rendered on the line right after its label). */
  async pillCount(label: string): Promise<number | null> {
    const lines = await this.rootLines();
    const idx = lines.indexOf(label);
    if (idx < 0) return null;
    for (let j = idx + 1; j <= Math.min(lines.length - 1, idx + 3); j++) {
      if (/^\d+$/.test(lines[j])) return parseInt(lines[j], 10);
    }
    return null;
  }

  /**
   * Clicks a summary pill to apply it as a quick filter over the table, and waits for the table to
   * actually refetch.
   *
   * The old fixed settle was enough on an idle machine and silently too short under parallel load —
   * the next read then returned the PREVIOUS filter's total, so a pill comparison failed against a
   * number belonging to the pill before it.
   */
  async clickPill(label: string): Promise<void> {
    const before = await this.totalCount().catch(() => NaN);
    await this.pill(label).click();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1000);
      const now = await this.totalCount().catch(() => NaN);
      // Settled: the total moved off the previous filter's value and stopped changing.
      if (Number.isFinite(now) && now !== before) {
        await this.page.waitForTimeout(1200);
        if ((await this.totalCount().catch(() => NaN)) === now) return;
      }
    }
    await this.page.waitForTimeout(1000);
  }

  // ------------------------------------------------------------------ the toolbar chips

  /**
   * A toolbar chip ("Filter" / "Spalten").
   *
   * On the redesigned board these are real buttons carrying their label as `aria-label`. Production
   * still serves the older build, where they are `div[tabindex="0"]` pressables rendering a glyph
   * above the label ("☰\nFilter", "▦\nSpalten") with no role at all — so both are accepted.
   */
  toolbarChip(label: 'Filter' | 'Spalten'): Locator {
    return this.page
      .getByRole('button', { name: label, exact: true })
      .or(
        this.page
          .locator('div[tabindex="0"]')
          .filter({ hasText: new RegExp(`^[^A-Za-z]*${label}\\s*\\d*$`) })
          .filter({ visible: true }),
      )
      .first();
  }

  /**
   * The badge a toolbar chip renders — the applied-filter count on "Filter", the visible-column
   * count on "Spalten". Null when the chip carries no badge (no filters applied).
   */
  async chipBadge(label: 'Filter' | 'Spalten'): Promise<number | null> {
    const txt = (await this.toolbarChip(label).innerText()) || '';
    const m = txt.replace(label, '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * The single mounted panel/dropdown. Both the Filter panel and the Spalten chooser render here,
   * and so does any filter dropdown opened from inside the panel — one at a time.
   */
  panel(): Locator {
    return this.page.locator('[role="dialog"]');
  }

  // ------------------------------------------------------------------ "Filter" panel

  /**
   * Opens the slide-in "Filter" panel that houses every column filter.
   *
   * The sentinel is matched by TEXT rather than by role: on the older build "Filter löschen" is a
   * plain pressable, not a button.
   */
  async openFilterPanel(): Promise<void> {
    if (await this.isFilterPanelOpen()) return;
    await this.toolbarChip('Filter').click({ force: true });
    await this.filterPanelSentinel().waitFor({ state: 'visible', timeout: 15_000 });
  }

  /**
   * Scoped to the mounted dialog on purpose: a stale copy of the panel can linger in `#root`
   * alongside the live one, and a page-level `.first()` picks the hidden stale node — which then
   * reads as "closed" and swallows the click.
   */
  private filterPanelSentinel(): Locator {
    return this.panel().getByText('Filter löschen', { exact: true }).first();
  }

  private async isFilterPanelOpen(): Promise<boolean> {
    return await this.filterPanelSentinel().isVisible().catch(() => false);
  }

  /** Dismisses the panel via its own "Schließen" control, falling back to the chip. */
  async closeFilterPanel(): Promise<void> {
    const close = this.page.getByText('Schließen', { exact: true }).filter({ visible: true }).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click({ force: true });
    } else {
      await this.page.keyboard.press('Escape').catch(() => {});
    }
    await this.page.waitForTimeout(2500);
    if (await this.isFilterPanelOpen()) {
      await this.toolbarChip('Filter').click({ force: true });
      await this.page.waitForTimeout(1500);
    }
  }

  /** The live "N VOs anzeigen" preview the panel shows for the current filter set. */
  async panelResultCount(): Promise<number | null> {
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    const m = txt.replace(/ /g, ' ').match(/([\d.,]+)\s*VOs anzeigen/);
    return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null;
  }

  /** The filter sections the panel offers, by the `aria-label` of each section's trigger. */
  async filterSections(): Promise<string[]> {
    await this.openFilterPanel();
    return (
      await this.panel()
        .locator('button[aria-label]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
    ).filter(Boolean);
  }

  /** Clears every applied filter from within the open panel. */
  async clearFilters(): Promise<void> {
    await this.openFilterPanel();
    await this.filterPanelSentinel().click({ force: true });
    await this.page.waitForTimeout(2500);
  }

  /**
   * Selects a value in one of the Filter panel's dropdowns (e.g. section "VO Status" → "Aktiv").
   *
   * Each section's trigger is a button whose `aria-label` IS the section label — including the
   * pickers that render as "Therapeut: (Auswählen)". Opening it swaps the panel out for the option
   * list (same `[role="dialog"]` node), so the option is taken from inside that dialog rather than
   * from the page, which also renders "Aktiv" in 20-odd table cells.
   */
  async selectFilter(section: string, option: string): Promise<void> {
    await this.openFilterPanel();
    await this.page.getByRole('button', { name: section, exact: true }).click();
    await this.page.waitForTimeout(1500);

    const list = this.panel();
    // Long option lists (Therapeut / Arzt / ER) open with their own search box, and the wanted
    // entry may not be rendered until it is typed.
    const search = list.locator('input');
    if (await search.first().isVisible().catch(() => false)) {
      await search.first().fill(option);
      await this.page.waitForTimeout(1500);
    }

    // Prefer an exact hit; the Arzt/ER pickers decorate entries with a location suffix
    // ("Juri Sloboda - Teltow"), so fall back to a substring match.
    let opt = list.getByText(option, { exact: true }).filter({ visible: true }).first();
    if (!(await opt.isVisible({ timeout: 5000 }).catch(() => false))) {
      opt = list.getByText(option, { exact: false }).filter({ visible: true }).first();
    }
    await opt.waitFor({ state: 'visible', timeout: 10_000 });
    // Long lists scroll inside the dropdown, so an entry can sit outside the viewport — which even
    // a force-click rejects. Scroll it in first, then fall back to a direct DOM click.
    await opt.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await opt.click({ force: true, timeout: 8000 }).catch(async () => {
      await opt.evaluate((el) => (el as HTMLElement).click());
    });
    await this.page.waitForTimeout(2500);
  }

  /**
   * Picks the first option one of the panel's dropdowns offers, and returns the label it chose.
   *
   * Use this for the Arzt / Therapeut / ER pickers, whose contents are live reference data — a
   * hard-coded name churns out and turns data drift into a test failure.
   */
  async selectFirstFilterOption(section: string): Promise<string | null> {
    await this.openFilterPanel();
    await this.page.getByRole('button', { name: section, exact: true }).click();
    await this.page.waitForTimeout(1500);

    // The option list populates asynchronously, so poll rather than reading once.
    const readOptions = async () =>
      (
        await this.panel().evaluate((d) =>
          [...d.querySelectorAll('*')]
            .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
            .map((e) => (e.textContent || '').trim())
            .filter(Boolean),
        )
      )
        // The list renders its own search box, a "(Auswählen)" placeholder and chrome glyphs above
        // the entries.
        .filter((o) => o && !/Auswählen|Suchen|^✕$|^▾$|^▴$|^\s*$/.test(o));

    let label: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      [label] = await readOptions();
      if (label) break;
      await this.page.waitForTimeout(700);
    }
    if (!label) return null;

    const opt = this.panel().getByText(label, { exact: true }).filter({ visible: true }).first();
    await opt.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await opt.click({ force: true, timeout: 8000 }).catch(async () => {
      await opt.evaluate((el) => (el as HTMLElement).click());
    });
    await this.page.waitForTimeout(2500);
    return label;
  }

  /** Back-compat wrapper: the "Folge-VO Status" filter lives inside the Filter panel. */
  async selectFolgeVoStatus(option: string): Promise<void> {
    await this.selectFilter('Folge-VO Status', option);
  }

  /** Applies a filter and closes the panel so the table underneath can be asserted. */
  async applyFilter(section: string, option: string): Promise<void> {
    await this.selectFilter(section, option);
    await this.closeFilterPanel();
  }

  // ------------------------------------------------------------------ "Spalten" column chooser

  /** A column's cell wherever it appears (table header or chooser row). */
  column(name: string): Locator {
    return this.page.getByText(name, { exact: true });
  }

  /**
   * The table's own column headers, left→right.
   *
   * Read by GEOMETRY, not by text order: the table is split into a frozen rail ("VO #" / "PATIENT")
   * and a horizontally-scrolling port, and the port's markup comes AFTER every data row — so in
   * `innerText` the scrollable headers trail the whole table body and a top-down scan finds only the
   * two rail headers. Visually they are one row, so the header band is what identifies them.
   */
  async headerLabels(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const leaves = [...document.querySelectorAll('div, span')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim(),
      ) as HTMLElement[];
      const anchor = leaves.find((e) => (e.textContent || '').trim() === 'VO #');
      if (!anchor) return [];
      const band = anchor.getBoundingClientRect();
      return leaves
        .map((e) => ({ t: (e.textContent || '').trim(), r: e.getBoundingClientRect() }))
        .filter(
          (o) =>
            o.r.width > 0 &&
            // same header row, within a couple of pixels of the anchor's own band
            Math.abs(o.r.top - band.top) < 8 &&
            !['↕', '↑', '↓', '→', '←'].includes(o.t),
        )
        .sort((a, b) => a.r.left - b.r.left)
        .map((o) => o.t);
    });
  }

  async openColumnChooser(): Promise<void> {
    if (!(await this.isColumnChooserOpen())) {
      await this.toolbarChip('Spalten').click({ force: true });
      await this.columnChooserSentinel().waitFor({ state: 'visible', timeout: 15_000 });
    }
    // The panel chrome mounts a beat before its rows do, and `evaluateAll` does NOT auto-wait — so
    // reading straight after the sentinel can return an empty list. Tolerate the absence: the older
    // build's rows carry no roles at all and are read by glyph geometry instead.
    await this.panel()
      .locator('[role="checkbox"][aria-label]')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});
  }

  /** Matched by text: on the older build "Alle auswählen" is a plain pressable, not a button. */
  private columnChooserSentinel(): Locator {
    return this.panel().getByText('Alle auswählen', { exact: true }).first();
  }

  private async isColumnChooserOpen(): Promise<boolean> {
    return await this.columnChooserSentinel().isVisible().catch(() => false);
  }

  async closeColumnChooser(): Promise<void> {
    if (!(await this.isColumnChooserOpen())) return;
    const close = this.page.getByText('Schließen', { exact: true }).filter({ visible: true }).first();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(1000);
    if (await this.isColumnChooserOpen()) {
      // Neither always dismisses the portalled panel; toggling the chip does.
      await this.toolbarChip('Spalten').click({ force: true });
      await this.page.waitForTimeout(1500);
    }
    await this.page.waitForTimeout(1000);
  }

  /**
   * Every column the chooser offers, in order, with its checked state.
   *
   * A row is `[role="menuitem"]` wrapping `[role="checkbox"][aria-label="<column>"]`. The checkbox
   * exposes no `aria-checked` — the only signal is the "✓" glyph it renders when the column is on.
   */
  async columnOptions(): Promise<ColumnOption[]> {
    await this.openColumnChooser();
    const tagged = await this.panel()
      .locator('[role="checkbox"][aria-label]')
      .evaluateAll((els) =>
        els.map((e) => ({
          label: e.getAttribute('aria-label') || '',
          checked: (e.textContent || '').includes('✓'),
        })),
      );
    if (tagged.length) return tagged;

    // Older build: the rows carry no roles at all, so a column is on iff a "✓" glyph renders at the
    // same vertical offset as its label.
    return await this.panel().evaluate((panel) => {
      const leaves = [...panel.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
        .map((e) => ({
          text: (e.textContent || '').trim(),
          y: Math.round(e.getBoundingClientRect().top),
        }));
      const ticks = leaves.filter((l) => l.text === '✓');
      const chrome = ['Spalten', 'Alle auswählen', 'Zurücksetzen', 'Schließen', '✓'];
      return leaves
        .filter((l) => !chrome.includes(l.text) && !/^\d+\/\d+$/.test(l.text))
        .map((l) => ({ label: l.text, checked: ticks.some((t) => Math.abs(t.y - l.y) <= 6) }));
    });
  }

  /** The chooser's own "<visible>/<total>" summary, e.g. "10/38". */
  async columnSummary(): Promise<string | null> {
    await this.openColumnChooser();
    const txt = (await this.panel().innerText().catch(() => '')) || '';
    return txt.split('\n').map((l) => l.trim()).find((l) => /^\d+\/\d+$/.test(l)) ?? null;
  }

  /** Toggles a column from within the (already open) chooser, by its checkbox `aria-label`. */
  async toggleColumnInChooser(name: string): Promise<void> {
    await this.openColumnChooser();
    const row = this.panel()
      .locator('[role="menuitem"]')
      .filter({ has: this.page.locator(`[role="checkbox"][aria-label="${name}"]`) })
      .first();
    if (await row.count()) await row.click();
    // Older build: no roles to hook, so click the label itself inside the panel.
    else await this.panel().getByText(name, { exact: true }).first().click({ force: true });
    await this.page.waitForTimeout(1500);
  }

  /** Drives a column to a wanted state, leaving it alone when it is already there. */
  async setColumn(name: string, on: boolean): Promise<void> {
    const current = (await this.columnOptions()).find((o) => o.label === name);
    if (!current) throw new Error(`setColumn: the Spalten chooser offers no column "${name}"`);
    if (current.checked !== on) await this.toggleColumnInChooser(name);
  }
}
