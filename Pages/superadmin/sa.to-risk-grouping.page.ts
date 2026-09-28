import { APIRequestContext, expect, Page } from '@playwright/test';
import { FlowBoardsPage } from './sa.flow-boards.page';
import { API_BASE, Credentials, mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The Therapeuten-Orga board's **grouped risk table**, its CSV export, and the retired
 * Abrechnungs-Stau banner — RC 3.14 #3774 (commit `347274e1e`, merged under a `Ref` trailer with no PR).
 *
 * With the "Fertig > 30 T, nicht abger." tile selected — or none — the risk table groups its rows by
 * treating therapist with a count and value per group; the other three tiles stay flat. The banner
 * is gone from both boards, and the Management board carries a plain summary line in its place.
 *
 * ## The oracle is the board's own payload
 *
 * `GET /kpis/orga/risks` serves **every** row with `tile`, `therapistName`, `teamName`, `revenue`
 * and `voNumber` on it, so the grouping, the subtotals and the sort are all re-derivable from one
 * read — {@link groupRows} ports `riskGroups.ts`'s ordering rule and the screen is compared against
 * it rather than against itself. The payload is ~2.6 MB and takes ~10 s, so it is cached per worker.
 *
 * ## The export contract, which is not quite what AC5 implies
 *
 * `POST /kpis/orga/risks/export` takes `{filters, prescriptionIds}`. The controller re-reads
 * `OrgaBoardRisksProvider` for the same filters, builds a map keyed by prescription id that
 * **excludes every `duplikatOffen` row and keeps the first tile a VO appears under**, then writes
 * only requested ids present in that map, in the requested order. The client sets the ORDER and
 * never the SCOPE — an id the board could not show is dropped silently, which is asserted with a
 * bogus id.
 *
 * ## Traps
 *
 *  - **`tiles.duplikatOffen` and the rows disagree** — the tile reports 8 while 9 rows carry that
 *    tile, all with distinct VO numbers. Pre-existing (this ticket does not touch tile population;
 *    #3775 does), but it means the tile counts are not a safe row oracle.
 *  - **Some VOs appear under MORE THAN ONE tile** (measured 2026-09-23: 4,167 distinct VOs behind
 *    5,501 rows; 2026-09-25: 4,596 behind 5,949 — it drifts daily, so never pin it). In the
 *    no-tile view the on-screen groups therefore sum to 5,492 while the CSV — one row per VO —
 *    holds 4,167. See the spec's FINDING; with the Fertig tile selected the two agree exactly.
 *  - **The group header and its subtotal are separate leaves.** The subtotal renders as
 *    `"{count} VOs · {amount}"` (`flowBoards.backlogSubtotal`) in its own node, so a locator that
 *    expects the name and the numbers in one element finds nothing.
 *  - **The Heilmittel column header reads "HM"**, not the Localization Reference's "Heilmittel" —
 *    the abbreviation is pre-existing (`flowBoards.riskHm`); only the CSV uses the full word.
 *  - **The board opens with NO tile selected**, which is itself one of AC1's two grouped cases — so
 *    a spec that asserts grouping without clicking anything is testing the default, not the tile.
 *  - **Sort with `localeCompare('de')`**: the population carries umlauts (Schöner, Müller) and a
 *    byte sort files them after Z, which reads as AC3 failing.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** Separator for composite group keys — a name and a team name cannot contain it. */
const KEY_SEP = '|::|';

/** The four tiles the Therapeuten-Orga board renders, with the API key each corresponds to. */
export const TILES = {
  fertig: { label: 'Fertig > 30 T, nicht abger.', key: 'fertigNichtAbgerechnet', grouped: true },
  laeuftAb: { label: 'VO läuft ab ≤ 7 T', key: 'laeuftAb', grouped: false },
  ibFehlt: { label: 'Informationsblatt fehlt', key: 'ibFehlt', grouped: false },
  duplikat: { label: 'Duplikat offen', key: 'duplikatOffen', grouped: false },
} as const;

/**
 * AC4 — the column order inside a group, as `textContent` serves it.
 *
 * **Widened from eight to ten on 2026-09-23 by #3785** (PR #3788), which inserted `Ausst. Datum` at
 * position 3 and `Beh. Status` at position 9. #3774's AC4 governs the ORDER of the columns it named
 * and says nothing about later additions, so this is a stale pin rather than a regression — but an
 * exact-equality assertion on the old eight fails the day #3785 ships, which is what happened here.
 * {@link ORIGINAL_GROUP_COLUMNS} keeps #3774's own set so its AC can still be stated precisely.
 */
export const GROUP_COLUMNS = [
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

/** The eight columns #3774 AC4 itself names, whose relative order must survive #3785's insertions. */
export const ORIGINAL_GROUP_COLUMNS = [
  'Patient:in',
  'VO #',
  'Wert',
  'HM',
  'Thema',
  'Stufe',
  'Status/Frist',
  'Empfohlene Aktion',
] as const;

/** AC5 — the CSV header, byte for byte as `OrgaRisksExportController` writes it. */
export const CSV_HEADER = [
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
 * The eight columns #3774 AC5 itself names — "the same columns the billing backlog banner's export
 * offered today". **#3785 inserted three more** (`Ausst. Datum`, `Thema`, `Beh. Status`), so an
 * exact-equality assertion on these eight fails the day it ships, exactly as {@link GROUP_COLUMNS}
 * did on the screen side. Their relative ORDER is what #3774's AC governs, and that is what the
 * spec asserts; {@link CSV_HEADER} carries the full current set.
 */
export const ORIGINAL_CSV_HEADER = [
  'TO-Team',
  'Therapeut:in',
  'VO #',
  'Patient:in',
  'Heilmittel',
  'Letzte Beh. (Wochen)',
  'Fertig seit (Tage)',
  'Umsatz',
] as const;

/** AC7's two reused banner strings, and the banner name AC6 removes. */
export const I18N = {
  summaryCount: 'flowBoards.backlogBannerText',
  summaryValue: 'flowBoards.backlogDirektAbrechenbar',
  bannerTitle: 'flowBoards.abrechnungsStau',
  exportButton: 'flowBoards.exportButton',
  ohneTeam: 'flowBoards.ohneTeam',
} as const;

export type RiskRow = {
  prescriptionId: number;
  voNumber: string;
  tile: string;
  therapistId: number | null;
  therapistName: string | null;
  therapistActive: boolean;
  teamId: number | null;
  teamName: string | null;
  revenue: number | null;
  patientInitials: string | null;
  heilmittel: string | null;
};

export type RiskGroup = { therapistName: string; teamName: string | null; count: number; revenue: number };
export type PaintedGroup = { name: string; count: number; revenue: number };

export class ToRiskGroupingPage {
  private static risksCache: Promise<{ rows: RiskRow[]; tiles: Record<string, number> }> | null = null;
  private static dictCache: Promise<{ de: Record<string, string>; en: Record<string, string>; bundle: string }> | null = null;
  private bearer: string | null = null;

  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  // ─────────────────────────────── the API ────────────────────────────────

  /** The board's own risk payload — every row, plus the four tile counts. ~2.6 MB, cached. */
  async risks(): Promise<{ rows: RiskRow[]; tiles: Record<string, number> }> {
    if (!ToRiskGroupingPage.risksCache) ToRiskGroupingPage.risksCache = this.fetchRisks();
    return await ToRiskGroupingPage.risksCache;
  }

  private async fetchRisks() {
    const token = await this.token();
    // ~2.6 MB and ~10 s on a good day; it 504s under load like every other KPI read here, and a
    // single bad sample would fail the whole file. Retried with a widening pause.
    let res = await this.request.get(`${API_BASE}/kpis/orga/risks`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    for (let attempt = 1; attempt <= 2 && res.status() >= 500; attempt++) {
      console.log(`  GET /kpis/orga/risks -> ${res.status()}; retrying (${attempt}/2)`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      res = await this.request.get(`${API_BASE}/kpis/orga/risks`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout: 300_000,
      });
    }
    expect(res.status(), 'GET /kpis/orga/risks').toBe(200);
    const body = await res.json();
    // API Platform wraps a single-item DTO collection on this route but not on every sibling.
    const dto = Array.isArray(body?.member) ? body.member[0] : body;
    return { rows: (dto.rows ?? []) as RiskRow[], tiles: (dto.tiles ?? {}) as Record<string, number> };
  }

  /** AC7's source — `GET /kpis/management/unbilled-summary`. */
  async unbilledSummary(): Promise<{ count: number; totalRevenue: number }> {
    const token = await this.token();
    let res = await this.request.get(`${API_BASE}/kpis/management/unbilled-summary`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    for (let attempt = 1; attempt <= 2 && res.status() >= 500; attempt++) {
      console.log(`  GET /kpis/management/unbilled-summary -> ${res.status()}; retrying (${attempt}/2)`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      res = await this.request.get(`${API_BASE}/kpis/management/unbilled-summary`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout: 300_000,
      });
    }
    expect(res.status(), 'GET /kpis/management/unbilled-summary').toBe(200);
    const body = await res.json();
    const dto = Array.isArray(body?.member) ? body.member[0] : body;
    return { count: dto.count as number, totalRevenue: dto.totalRevenue as number };
  }

  /**
   * Raw status for a route, so "does this exist?" is asserted rather than assumed.
   *
   * **Retries on 5xx, and that is the point of the helper.** These are the slowest reads on
   * staging, and `unbilled-summary` answered **504** once mid-session while the route was
   * demonstrably deployed — which failed the deployment gate and, in a `serial` describe, cascaded
   * every remaining test to "did not run". A gateway timeout is the server being unhealthy, not the
   * route being absent; only 404 means absent, and the 404 controls beside it are what give that
   * reading its force. So a 5xx is retried rather than believed.
   */
  async status(path: string, method: 'GET' | 'POST' = 'GET', attempts = 3): Promise<number> {
    const token = await this.token();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/ld+json',
      'Content-Type': 'application/json',
    };
    let last = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res =
        method === 'GET'
          ? await this.request.get(`${API_BASE}${path}`, { headers, timeout: 180_000 })
          : await this.request.post(`${API_BASE}${path}`, { headers, data: {}, timeout: 180_000 });
      last = res.status();
      if (last < 500) return last;
      console.log(`  ${method} ${path} -> ${last} (attempt ${attempt}/${attempts}); retrying — a 5xx is not a verdict`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
    return last;
  }

  /** `POST /kpis/orga/risks/export` — returns the raw CSV text. */
  async exportCsv(prescriptionIds: number[], filters: Record<string, unknown> = {}): Promise<string> {
    const token = await this.token();
    const res = await this.request.post(`${API_BASE}/kpis/orga/risks/export`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { filters, prescriptionIds },
      timeout: 600_000,
    });
    expect(res.status(), 'POST /kpis/orga/risks/export').toBe(200);
    return await res.text();
  }

  /**
   * Split a CSV the controller wrote: BOM-stripped, `;`-delimited, quotes unwrapped.
   *
   * **The scan must run across NEWLINES, not line by line.** #3803 joins a VO's several risks into
   * one Thema cell separated by `\n` INSIDE the quotes — 1,195 of 1,713 rows on staging — so a
   * parser that splits on newlines first and then handles quotes reports **2,908 rows for 1,713
   * VOs**. That reads exactly like the export duplicating rows, i.e. like #3803 being broken, and it
   * is purely a parser bug. Quote state is therefore carried across line breaks.
   */
  static parseCsv(text: string): { header: string[]; rows: string[][] } {
    const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const records: string[][] = [];
    let row: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (quoted) {
        if (c === '"' && clean[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ';') {
        row.push(cur);
        cur = '';
      } else if (c === '\n') {
        row.push(cur);
        records.push(row);
        row = [];
        cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) {
      row.push(cur);
      records.push(row);
    }
    const header = records.shift() ?? [];
    return { header, rows: records.filter((r) => r.length > 1) };
  }

  /**
   * `GET /kpis/admin-performance/risks` — the OTHER board that renders the shared `RiskWorklist`.
   *
   * #3803's grouping had to be opt-in, so the realistic leak is that board turning grouped too. Its
   * contract is flat: one row per RISK, so a VO with two risks legitimately appears twice.
   */
  async adminPerformanceRisks(): Promise<{ rows: Record<string, unknown>[]; tiles: Record<string, number> }> {
    const token = await this.token();
    const res = await this.request.get(`${API_BASE}/kpis/admin-performance/risks`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    expect(res.status(), 'GET /kpis/admin-performance/risks').toBe(200);
    const body = await res.json();
    const dto = Array.isArray(body?.member) ? body.member[0] : body;
    return { rows: dto.rows ?? [], tiles: dto.tiles ?? {} };
  }

  // ───────────────────────────── the oracle ──────────────────────────────

  private static keyOf(therapistName: string | null, teamName: string | null): string {
    return `${therapistName ?? ''}${KEY_SEP}${teamName ?? ''}`;
  }

  /**
   * A port of `riskGroups.ts`'s ordering rule (AC3).
   *
   * Therapists who belong to a TO-Team come first, then the team-less block; each alphabetical by
   * the therapist's full name, first name leading. `localeCompare('de')` rather than a raw `<`:
   * the population carries umlauts and a byte sort files them after Z.
   */
  static groupRows(rows: RiskRow[]): RiskGroup[] {
    const map = new Map<string, RiskGroup>();
    // **#3803 (2026-09-25) made the table ONE ROW PER VO**, so a group counts DISTINCT VOs, not
    // payload rows: the payload still serves one row per VO PER TILE, and a VO carrying two risks
    // used to be counted twice. Measured on the first run after that shipped — Aaron Babczynski's
    // group read 57 on screen against a row-counting oracle's 70. Counting rows again would report
    // the screen as wrong when it is the oracle that is stale.
    const seen = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = ToRiskGroupingPage.keyOf(row.therapistName, row.teamName);
      const vos = seen.get(key) ?? new Set<string>();
      if (vos.has(row.voNumber)) continue;
      vos.add(row.voNumber);
      seen.set(key, vos);
      const hit = map.get(key) ?? {
        therapistName: row.therapistName ?? '',
        teamName: row.teamName ?? null,
        count: 0,
        revenue: 0,
      };
      hit.count += 1;
      hit.revenue += row.revenue ?? 0;
      map.set(key, hit);
    }
    return [...map.values()].sort((a, b) => {
      const teamRank = (g: RiskGroup) => (g.teamName ? 0 : 1);
      return teamRank(a) - teamRank(b) || a.therapistName.localeCompare(b.therapistName, 'de');
    });
  }

  /**
   * Strip the `" (Inaktiv)"` suffix the boards append to a deactivated therapist's name (#3210).
   *
   * The payload carries the bare name plus `therapistActive`, while the screen — and the CSV —
   * carry the decorated one, so a name-keyed comparison silently drops every deactivated therapist.
   * On staging that is **8 of 133 groups**, and the first version of this spec reported "125 of 133
   * matched" without saying why the other 8 were skipped.
   */
  static plainName(name: string): string {
    return name.replace(/\s*\(Inaktiv\)\s*$/, '').trim();
  }

  /** The rows a given selection puts in the table. `null` tile = no tile selected. */
  static rowsFor(rows: RiskRow[], tileKey: string | null): RiskRow[] {
    if (tileKey === null) return rows.filter((r) => r.tile !== TILES.duplikat.key);
    return rows.filter((r) => r.tile === tileKey);
  }

  /** The ids the board would send to the export for a selection — deduplicated, in group order. */
  static exportIdsFor(rows: RiskRow[], tileKey: string | null): number[] {
    const selected = ToRiskGroupingPage.rowsFor(rows, tileKey).filter((r) => r.tile !== TILES.duplikat.key);
    const rank = new Map(
      ToRiskGroupingPage.groupRows(selected).map((g, i) => [ToRiskGroupingPage.keyOf(g.therapistName, g.teamName), i]),
    );
    const ordered = [...selected].sort(
      (a, b) =>
        (rank.get(ToRiskGroupingPage.keyOf(a.therapistName, a.teamName)) ?? 0) -
        (rank.get(ToRiskGroupingPage.keyOf(b.therapistName, b.teamName)) ?? 0),
    );
    const seen = new Set<number>();
    const out: number[] = [];
    for (const row of ordered)
      if (!seen.has(row.prescriptionId)) {
        seen.add(row.prescriptionId);
        out.push(row.prescriptionId);
      }
    return out;
  }

  // ─────────────────────────────── the screen ────────────────────────────────

  async openBoard(tab: 'Therapeuten-Orga' | 'Management' | 'Admin-Performance'): Promise<FlowBoardsPage> {
    const page = this.requirePage();
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(page);
    await boards.open();
    await boards.openTab(tab);
    return boards;
  }

  /**
   * Waits for the risk section to have painted, and for the thing the CALLER is about to read.
   *
   * `expectGroups` is not a convenience — it is the difference between a reliable test and a flaky
   * one. The column headers render before the group rows do, so a readiness gate that accepts
   * "headers OR groups" is satisfied by the headers alone and {@link paintedGroups} then returns
   * `[]`, which reads exactly like the table not being grouped. That failed this file's own
   * on-screen test once, on a build where the same test had passed minutes earlier — the identical
   * mistake #3575's dot spec makes by waiting on a therapist NAME and then reading DOTS.
   *
   * So: pass `true` when grouping is expected, and the gate waits for a group; pass `false` (the
   * flat tiles, and the Admin-Performance board) and it waits for the headers, since zero groups is
   * the assertion there and can never be waited for.
   */
  async waitForRiskTable(opts: { expectGroups?: boolean; timeout?: number } = {}): Promise<void> {
    const { expectGroups = true, timeout = 300_000 } = opts;
    const page = this.requirePage();
    await expect(page.getByText('Offene Risiken', { exact: true }).first(), 'the risk section').toBeVisible({ timeout });
    await expect
      .poll(async () => (expectGroups ? (await this.paintedGroups()).length : (await this.riskColumnHeaders()).length), {
        timeout,
        intervals: [2_000],
      })
      .toBeGreaterThan(0);
  }

  /**
   * The painted group headers — therapist name, row count and value.
   *
   * The subtotal is its own leaf (`"{count} VOs · {amount}"`), so it is matched on that pattern and
   * the name is taken from the nearest leaf to its left on the same visual row.
   */
  async paintedGroups(): Promise<PaintedGroup[]> {
    const page = this.requirePage();
    return await page.evaluate(() => {
      const leaves: { text: string; x: number; y: number }[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!text) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        leaves.push({ text, x: r.x, y: r.y });
      });
      const subtotal = /^(\d[\d.]*)\s+VOs?\s+·\s+([\d.]+,\d{2})\s*€$/;
      const out: { name: string; count: number; revenue: number }[] = [];
      for (const leaf of leaves) {
        const m = leaf.text.match(subtotal);
        if (!m) continue;
        const name = leaves
          .filter((l) => Math.abs(l.y - leaf.y) < 24 && l.x < leaf.x && !subtotal.test(l.text))
          .sort((a, b) => b.x - a.x)[0];
        out.push({
          name: name?.text ?? '',
          count: Number(m[1].replace(/\./g, '')),
          revenue: Number(m[2].replace(/\./g, '').replace(',', '.')),
        });
      }
      return out;
    });
  }

  /** The risk table's own column headers, left to right, from the topmost header band. */
  async riskColumnHeaders(): Promise<string[]> {
    const page = this.requirePage();
    return await page.evaluate((wanted: string[]) => {
      const found: { text: string; x: number; y: number }[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!wanted.includes(text)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        found.push({ text, x: r.x, y: r.y });
      });
      if (found.length === 0) return [];
      const top = Math.min(...found.map((f) => f.y));
      return found
        .filter((f) => f.y - top < 16)
        .sort((a, b) => a.x - b.x)
        .map((f) => f.text);
    }, [...GROUP_COLUMNS]);
  }

  /** Click a risk tile by its German label. */
  async selectTile(label: string): Promise<void> {
    const page = this.requirePage();
    await page.getByText(label, { exact: true }).first().click({ timeout: 30_000, force: true });
    await page.waitForTimeout(4_000);
  }

  /** Is the "Herunterladen" export control on screen? */
  async downloadButtonCount(): Promise<number> {
    return await this.requirePage().getByText('Herunterladen', { exact: true }).count();
  }

  /** Whole-page text, for the banner-absence and summary-line assertions. */
  async boardText(): Promise<string> {
    return await this.requirePage().evaluate(() => (document.body as HTMLElement).innerText);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('This helper needs a Page; construct ToRiskGroupingPage(request, page).');
    return this.page;
  }

  // ─────────────────────────── the deployed bundle ───────────────────────────

  async dictionaries() {
    if (!ToRiskGroupingPage.dictCache) ToRiskGroupingPage.dictCache = this.fetchDictionaries();
    return await ToRiskGroupingPage.dictCache;
  }

  private async fetchDictionaries() {
    const shell = await this.request.get(`${STAGING_WEB}/`, { timeout: 60_000 });
    const entry = (await shell.text()).match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    expect(entry, 'the shell references an entry bundle').toBeTruthy();
    const res = await this.request.get(`${STAGING_WEB}${entry}`, { timeout: 180_000 });
    const bundle = await res.text();
    const dicts = ToRiskGroupingPage.extractDictionaries(bundle).filter(
      (d) => typeof d['controls.loading'] === 'string',
    );
    const de = dicts.find((d) => d['controls.loading'] !== 'Loading...')!;
    const en = dicts.find((d) => d['controls.loading'] === 'Loading...')!;
    expect(de, 'the bundle ships a German dictionary').toBeTruthy();
    return { de, en, bundle };
  }

  private static extractDictionaries(source: string): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    const start = /__d\(function\([^)]*\)\{(\w+)\.exports=\{/g;
    let m: RegExpExecArray | null;
    while ((m = start.exec(source)) !== null) {
      const objectStart = m.index + m[0].length - 1;
      const tail = /\},(\d+),\[\]\);/g;
      tail.lastIndex = objectStart;
      const end = tail.exec(source);
      if (!end) continue;
      const literal = source.slice(objectStart, end.index);
      if (literal.length < 50_000) continue;
      try {
        out.push(ToRiskGroupingPage.flatten(new Function(`return ${literal};`)() as Record<string, unknown>));
      } catch {
        /* not a locale module */
      }
      start.lastIndex = end.index;
    }
    return out;
  }

  private static flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object')
        Object.assign(out, ToRiskGroupingPage.flatten(entry as Record<string, unknown>, `${prefix}${key}.`));
      else out[`${prefix}${key}`] = String(entry);
    }
    return out;
  }
}
