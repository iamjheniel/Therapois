import { Page, Locator, expect } from '@playwright/test';
import { settleAfter } from '../util/settle';

/**
 * Page Object for the admin CRM dashboard's RC 3.9 improvements (epic #2929): the 5-tab structure
 * (#2932), the 5 summary cards + region/ER/Fachrichtung filter scoping (#2931/#2936/#2934), the
 * Fachrichtung + Letzte Aktivität columns (#2934/#2933), and the German localisation (#2937).
 *
 * The CRM is React-Native-Web: filters render as custom dropdown boxes (no native <select>, no
 * role=combobox/option) whose options appear as plain clickable text in a portal-ish flatlist.
 * Filter boxes are opened by clicking the box; their label text collides with the same-named table
 * column header, but the filter box sits first in the DOM (filter bar renders above the table), so
 * `.first()` targets the filter. Counts (cards + tab badges) are read by regex from the root text.
 */
export class CRMDashboardPage {
  constructor(private page: Page) {}

  /** The 5 summary-card labels, left→right. */
  static readonly CARDS = [
    'Ausstehende Bestellungen',
    'Bestellungen warten auf TB',
    'Ausstehende Folge-VOs',
    'Kritische Nachverfolgungen',
    'Aktive Probleme',
  ];

  /** The 5 tab labels, left→right (#2932). */
  static readonly TABS = ['Heute bestellen', 'Heute nachverfolgen', 'Geplant', 'Mit Problemen', 'Alle'];

  private anzeigen(): Locator {
    return this.page.getByText('Anzeigen', { exact: true });
  }

  /** Loads /crm at a wide viewport and waits for practice rows. Accepts a base URL for Prod reuse. */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.goto(`${baseUrl}/crm`, { waitUntil: 'domcontentloaded' });
    await this.waitForRows();
  }

  /** Waits for the practice list to paint; nudges the "Mit Problemen" tab if the default is slow. */
  async waitForRows(maxTries = 5): Promise<boolean> {
    for (let i = 0; i < maxTries; i++) {
      if (await this.anzeigen().first().isVisible({ timeout: 6000 }).catch(() => false)) return true;
      await this.page.getByText('Mit Problemen').first().click().catch(() => {});
      await this.page.waitForTimeout(2000);
    }
    return false;
  }

  private async rootText(): Promise<string> {
    return this.page.locator('#root').innerText().catch(() => '');
  }

  // ------------------------------------------------------------------ tabs (#2932)

  /** A tab pill by its label, matched with its badge count e.g. "Heute bestellen (220)". */
  tab(name: string): Locator {
    return this.page.getByText(new RegExp(`^${name}\\s*\\(\\d+\\)$`)).filter({ visible: true }).first();
  }

  /** Reads a tab's badge count, or null if the tab/count isn't present. */
  async tabCount(name: string): Promise<number | null> {
    const m = (await this.rootText()).match(new RegExp(`${name}\\s*\\((\\d+)\\)`));
    return m ? parseInt(m[1], 10) : null;
  }

  async openTab(name: string): Promise<void> {
    await settleAfter(this.page, () => this.tab(name).click({ force: true }), { budgetMs: 12_000 });
  }

  // ------------------------------------------------------------------ summary cards (#2931)

  /** Reads a summary card's numeric value by finding the nearest number above its label line. */
  async cardValue(label: string): Promise<number | null> {
    const lines = (await this.rootText()).split('\n').map((s) => s.trim());
    const idx = lines.indexOf(label);
    if (idx <= 0) return null;
    for (let j = idx - 1; j >= Math.max(0, idx - 3); j--) {
      if (/^\d+$/.test(lines[j])) return parseInt(lines[j], 10);
    }
    return null;
  }

  /** Snapshots all 5 card values as a map. */
  async allCardValues(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    for (const c of CRMDashboardPage.CARDS) out[c] = await this.cardValue(c);
    return out;
  }

  // ------------------------------------------------------------------ filters (#2931/#2934/#2936)

  /** The top-bar filter box for a given label (first in DOM = the filter, not the column header). */
  private filterBox(label: string): Locator {
    return this.page.getByText(label, { exact: true }).filter({ visible: true }).first();
  }

  /**
   * Opens a filter dropdown and returns the option lines it reveals (diffing body text before/after,
   * which cleanly captures the portal-rendered options). Leaves the dropdown open.
   */
  async openFilterOptions(label: string): Promise<string[]> {
    const before = await this.page.locator('body').innerText().catch(() => '');
    const box = await this.filterBox(label).boundingBox();
    if (!box) return [];
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The options are read as "text that was not on the page before", so the read has to happen
    // after the dropdown has finished painting. Poll for the body text to differ instead of
    // sleeping 1.5 s at every filter open.
    await expect
      .poll(() => this.page.locator('body').innerText().catch(() => ''), {
        timeout: 6_000,
        intervals: [100, 150, 250, 400],
      })
      .not.toBe(before)
      .catch(() => {});
    const after = await this.page.locator('body').innerText().catch(() => '');
    return after
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !before.includes(l));
  }

  /** Closes an open filter dropdown without choosing anything. */
  async closeFilter(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /** Opens a filter and clicks a specific option by exact text. Returns whether the option was found. */
  async selectFilterOption(label: string, optionText: string): Promise<boolean> {
    await this.openFilterOptions(label);
    const opt = this.page.getByText(optionText, { exact: true }).filter({ visible: true }).last();
    if (!(await opt.count())) {
      await this.closeFilter();
      return false;
    }
    await settleAfter(this.page, () => opt.click({ force: true }), { budgetMs: 15_000 });
    return true;
  }

  async clearFilters(): Promise<void> {
    await settleAfter(
      this.page,
      () => this.page.getByText('Filter löschen', { exact: true }).click({ force: true }).catch(() => {}),
      { budgetMs: 15_000 },
    );
  }

  // ------------------------------------------------------------------ table columns (#2933/#2934)

  /** A CRM table column header by exact text (visible, filtering virtualised duplicates). */
  columnHeader(name: string): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true });
  }
}
