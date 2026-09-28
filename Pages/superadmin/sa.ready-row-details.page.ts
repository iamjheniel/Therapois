import { APIRequestContext, expect, Page } from '@playwright/test';
import { ToRiskGroupingPage } from './sa.to-risk-grouping.page';

/**
 * Ready-for-billing rows name their real status, and gain issue date and sessions done —
 * RC 3.14 #3785, shipped inside #3775's PR **#3788** (commit `0f909db2a`, `Ref #3775` + `Ref #3785`).
 *
 * #3775 added cancelled and expired VOs to the ready-for-billing tiles; every such row carried the
 * one fixed "finished" Topic. This names the real status on both boards and adds two columns to the
 * Therepeuten-Orga grouped view and three to its download.
 *
 * ## The Topic is chosen CLIENT-SIDE from `voStatus`
 *
 * The API serves `voStatus` per row and the board picks an i18n key from it, so AC1/AC6 are two
 * questions, not one: does the dictionary carry the six strings, and does each row get the right
 * one. Both are asked here — the first against the served bundle, the second by joining the export
 * back to the payload, which is the only place the pairing can be checked in bulk.
 *
 * ## Why the export is the better surface for most of this
 *
 * The grouped view paginates and the tile holds ~1,600 rows, so the screen can only show the Topic
 * strings that happen to be on the first page. The download takes the VO ids the board would send
 * and returns one row per VO, so AC1's mapping, AC3's sessions figure, AC4's date format and AC5's
 * columns are all checkable across a large sample in one request.
 *
 * ## Traps
 *
 *  - **`Beh. Status` is written as an Excel TEXT FORMULA** — `="4 / 6"`, not `4 / 6` — deliberately,
 *    so a spreadsheet cannot read it as a date (AC5 says so outright). A comparison against the
 *    plain form fails on a correct file; strip `="` and `"` first.
 *  - **A Blanko VO reports `totalTreatments: 0`**, and the figure shows `n / BV` rather than `n / 0`.
 *    Building the expectation from `totalTreatments` alone yields `14 / 0` and reports a mismatch.
 *  - **The screen shows only the Topics on the current page.** The cancelled Admin-Performance
 *    variant did not appear on the first page even though 165 such VOs exist, so absence on screen
 *    is not evidence — the dictionary and the payload are.
 *  - **#3774's `GROUP_COLUMNS` went from 8 to 10 here.** Any exact-equality assertion on the old
 *    set fails the day this ships; see that page object's note.
 */

/** AC2 — the grouped view's ten columns, in order. `Ausst. Datum` at 3, `Beh. Status` at 9. */
export const GROUPED_VIEW_COLUMNS = [
  'Patient:in',
  'VO #',
  'Ausst. Datum',
  'Wert',
  'HM',
  'Thema',
  'Stufe',
  'Status/Frist',
  'Beh. Status',
  'Empfohlene Aktion',
] as const;

/** AC5 — the download's eleven columns, in order. */
export const DOWNLOAD_COLUMNS = [
  'TO-Team',
  'Therapeut:in',
  'VO #',
  'Patient:in',
  'Ausst. Datum',
  'Heilmittel',
  'Thema',
  'Letzte Beh. (Wochen)',
  'Beh. Status',
  'Fertig seit (Tage)',
  'Umsatz',
] as const;

/**
 * AC1 — the Therapeuten-Orga tile's Topic per VO status.
 *
 * **SUPERSEDED BY #3814 (commit `6b72bcb7e`, 2026-09-26).** #3785 introduced these three texts; that
 * ticket replaced all three so they name the LAST TREATMENT rather than the end status, because the
 * day count beside them now counts from the last treatment. The old wording is gone from the
 * deployed dictionary (0 occurrences), so this constant holds the CURRENT texts and
 * {@link ORGA_TOPIC_BY_STATUS_BEFORE_3814} keeps #3785's own for the before/after.
 */
export const ORGA_TOPIC_BY_STATUS: Record<string, string> = {
  'Fertig Behandelt': 'Fertig behandelt, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
  Abgebrochen: 'Abgebrochen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
  Abgelaufen: 'Abgelaufen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
};

/** What #3785 shipped, replaced by #3814. Retained so the replacement is assertable, not assumed. */
export const ORGA_TOPIC_BY_STATUS_BEFORE_3814: Record<string, string> = {
  'Fertig Behandelt': 'Fertig behandelt vor > 30 Tagen, nicht in Abrechnung',
  Abgebrochen: 'Abgebrochen vor > 30 Tagen, nicht in Abrechnung',
  Abgelaufen: 'Abgelaufen vor > 30 Tagen, nicht in Abrechnung',
};

/** AC6 — the Admin-Performance tile's Topic per VO status. */
export const ADMIN_TOPIC_BY_STATUS: Record<string, string> = {
  'Fertig Behandelt': 'Fertig behandelt, bereit für die Abrechnung',
  Abgebrochen: 'Abgebrochen, bereit für die Abrechnung',
  Abgelaufen: 'Abgelaufen, bereit für die Abrechnung',
};

/** The i18n keys behind those six, so the dictionary can be checked by key as well as by value. */
export const TOPIC_KEYS = {
  orga: ['flowBoards.riskThemaFertig', 'flowBoards.riskThemaAbgebrochen', 'flowBoards.riskThemaAbgelaufen'],
  admin: ['flowBoards.riskThemaBereit', 'flowBoards.riskThemaBereitAbgebrochen', 'flowBoards.riskThemaBereitAbgelaufen'],
  columns: ['flowBoards.riskAusstDatum', 'flowBoards.riskBehStatus'],
} as const;

/**
 * The combined label AC6 replaces, as this suite recorded it from the served dictionary on
 * 2026-09-23 — the day before #3788 shipped. Its disappearance is the before/after.
 */
export const OLD_COMBINED_TOPIC = 'Fertig behandelt / abgebrochen — bereit für die Abrechnung';

export class ReadyRowDetailsPage {
  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  private risks = new ToRiskGroupingPage(this.request, this.page);

  /** Delegate, so this file needs no second copy of the auth, retry or CSV plumbing. */
  orgaRisks = () => this.risks.risks();
  openBoard = (tab: 'Therapeuten-Orga' | 'Management' | 'Admin-Performance') => this.risks.openBoard(tab);
  /** Returns the raw CSV TEXT, not a `{status, text}` envelope — the sibling page object's
   * `riskExportCsv()` uses the latter shape, and mixing them yields `undefined` at the parser. */
  exportCsv = (ids: number[]): Promise<string> => this.risks.exportCsv(ids);

  /** The served de/en dictionaries, for the six Topic strings and the two column headers. */
  dictionaries = () => this.risks.dictionaries();

  /** `GET /kpis/admin-performance/risks`, whose rows carry the `voStatus` AC6's Topic is chosen from. */
  async adminPerformanceRisks(): Promise<{ rows: Record<string, unknown>[]; tiles: Record<string, number> }> {
    const token = await this.risks.token();
    const res = await this.request.get(`https://api.staging.therapios.de/kpis/admin-performance/risks`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    expect(res.status(), 'GET /kpis/admin-performance/risks').toBe(200);
    const body = await res.json();
    const dto = Array.isArray(body?.member) ? body.member[0] : body;
    return { rows: dto.rows ?? [], tiles: dto.tiles ?? {} };
  }

  // ─────────────────────────────── the CSV ────────────────────────────────

  static parseCsv = ToRiskGroupingPage.parseCsv;

  /** Column values by HEADER NAME, so a later insertion cannot silently shift an index. */
  static column(parsed: { header: string[]; rows: string[][] }, name: string): string[] {
    const index = parsed.header.findIndex((h) => h.trim().replace(/^"|"$/g, '') === name);
    expect(index, `the export has a "${name}" column`).toBeGreaterThanOrEqual(0);
    return parsed.rows.map((r) => (r[index] ?? '').trim());
  }

  /**
   * `="4 / 6"` → `4 / 6`.
   *
   * AC5 requires the file to open as text rather than a date, and the implementation does that with
   * an Excel formula wrapper. Comparing against the bare form without stripping it fails on a
   * correct file.
   */
  static unwrapFormula(value: string): string {
    return value.replace(/^="?/, '').replace(/"$/, '');
  }

  /** AC3's expected figure for a row: `n / m`, or `n / BV` for a Blanko VO. */
  static expectedSessions(row: { activityCount?: unknown; totalTreatments?: unknown; blankoVO?: unknown }): string {
    return `${row.activityCount} / ${row.blankoVO ? 'BV' : row.totalTreatments}`;
  }

  // ─────────────────────────────── the screen ─────────────────────────────

  /** The grouped view's header row, left to right, from the topmost band. */
  async groupedColumns(): Promise<string[]> {
    const page = this.requirePage();
    return await page.evaluate((want: string[]) => {
      const found: { t: string; x: number; y: number }[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const t = (el.textContent ?? '').trim();
        if (!want.includes(t)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        found.push({ t, x: r.x, y: r.y });
      });
      if (!found.length) return [];
      const top = Math.min(...found.map((f) => f.y));
      return found
        .filter((f) => f.y - top < 16)
        .sort((a, b) => a.x - b.x)
        .map((f) => f.t);
    }, [...GROUPED_VIEW_COLUMNS]);
  }

  /** Every distinct ready-for-billing Topic painted on the current page. */
  async paintedTopics(): Promise<string[]> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      const out = new Set<string>();
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const t = (el.textContent ?? '').trim();
        if (/(nicht in Abrechnung|bereit für die Abrechnung)$/.test(t)) out.add(t);
      });
      return [...out];
    });
  }

  async waitForRiskSection(timeout = 300_000): Promise<void> {
    const page = this.requirePage();
    await expect(page.getByText('Offene Risiken', { exact: true }).first(), 'the risk section').toBeVisible({ timeout });
    await expect
      .poll(async () => (await this.paintedTopics()).length, { timeout, intervals: [2_000] })
      .toBeGreaterThan(0);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('This helper needs a Page; construct ReadyRowDetailsPage(request, page).');
    return this.page;
  }
}
