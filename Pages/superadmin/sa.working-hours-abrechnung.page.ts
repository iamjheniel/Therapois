import { Page, Locator, expect } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

export type FacilityRow = {
  facilityId: number | null;
  facilityName: string | null;
  active: number; pending: number;
  completedUnbilled: number; cancelledUnbilled: number; expiredUnbilled: number;
};
export type WhRow = Record<string, any> & { therapistId: number; therapistName: string; facilityBreakdown?: FacilityRow[] };

/**
 * RC 3.15 #3725 — the Arbeitszeiten table gains a third column mode, **Abrechnung**, showing five
 * per-therapist VO counts, each therapist row expandable into one sub-row per care facility.
 *
 * The board's OWN `/kpis/management/working-hours` response is captured as it loads (#3471), so the
 * painted numbers are compared against the payload they were drawn from rather than against a
 * re-issued query — which matters here because AC5 is an identity between the two.
 */
export class WorkingHoursAbrechnungPage {
  /** The five columns AC2 names, as the table's own testid suffixes. */
  static readonly COLUMN_KEYS = [
    'aktiveVos', 'ausstehendeVos', 'completedUnbilled', 'cancelledUnbilled', 'expiredUnbilled',
  ] as const;

  /**
   * The headers those columns carry, **in source case**.
   *
   * The table CSS-uppercases its headers, so the ticket and the PR quote them as `AKTIVE VOS` —
   * that is `innerText`. `textContent`, which is what a DOM read returns and what Playwright's
   * text engine matches, keeps `Aktive VOs`. Both readings are asserted; a constant written in the
   * painted form alone fails on a correct build (#3718/#3770).
   */
  static readonly COLUMN_HEADERS = [
    'Aktive VOs', 'Ausstehende VOs', 'Fertig (n. abger.)',
    'Abgebrochen (n. abger.)', 'Abgelaufen (n. abger.)',
  ] as const;

  /** The same five as the screen paints them. */
  static readonly COLUMN_HEADERS_PAINTED = [
    'AKTIVE VOS', 'AUSSTEHENDE VOS', 'FERTIG (N. ABGER.)',
    'ABGEBROCHEN (N. ABGER.)', 'ABGELAUFEN (N. ABGER.)',
  ] as const;

  /**
   * The payload field behind each column.
   *
   * **`completedUnbilled` reads `completedOnlyUnbilledCount`, NOT `completedUnbilledCount`.** #3775
   * widened the latter the day after #3725 merged, so it now counts Abgebrochen and Abgelaufen too
   * — binding to it would triple-count and break AC5's sum on most therapists.
   */
  static readonly FIELD_OF: Record<string, string> = {
    aktiveVos: 'activeVoCount',
    ausstehendeVos: 'openFollowUpCount',
    completedUnbilled: 'completedOnlyUnbilledCount',
    cancelledUnbilled: 'cancelledUnbilledCount',
    expiredUnbilled: 'expiredUnbilledCount',
  };

  /** The per-facility key each therapist-level field must sum to (AC5). */
  static readonly FACILITY_KEY_OF: Record<string, keyof FacilityRow> = {
    aktiveVos: 'active',
    ausstehendeVos: 'pending',
    completedUnbilled: 'completedUnbilled',
    cancelledUnbilled: 'cancelledUnbilled',
    expiredUnbilled: 'expiredUnbilled',
  };

  /**
   * The Operativ/Details column AC3 says must NOT appear in this mode.
   *
   * It differs from the new one only by its PARENTHESES — `FERTIG N. ABGER.` against
   * `FERTIG (N. ABGER.)` — so a substring check matches both and AC3 passes on a build that still
   * renders the old column.
   */
  static readonly OLD_COLUMN = 'Fertig n. abger.';
  static readonly NEW_COLUMN = 'Fertig (n. abger.)';

  /** The section heading, in both spellings (#3770 renamed it; Production is pre-3.14). */
  static readonly OVERVIEW_HEADING = /^(Übersicht|Arbeitszeiten)$/;

  /** Captured board responses, oldest first. */
  readonly payloads: WhRow[][] = [];

  constructor(private page: Page) {}

  get ui(): Page { return this.page; }

  /**
   * ONE navigation: `mintUiSession` spends a single-use refresh token (#3460), so a reload lands on
   * the login form. The response listener is installed before the first paint.
   */
  async open(): Promise<void> {
    this.page.on('response', async (res) => {
      if (!res.url().includes('/kpis/management/working-hours')) return;
      try {
        const body = await res.json();
        this.payloads.push((body?.member ?? body ?? []) as WhRow[]);
      } catch { /* a aborted or non-JSON response is not a payload */ }
    });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto('https://staging.therapios.de/flow-boards', { waitUntil: 'domcontentloaded' });
    await this.page.getByText('Therapeuten-Orga', { exact: true }).first()
      .click({ timeout: 240_000 });
    await this.page.getByText(WorkingHoursAbrechnungPage.OVERVIEW_HEADING).first()
      .scrollIntoViewIfNeeded().catch(() => {});
    await this.waitForTable();
  }

  /**
   * Waits for a painted ROW, not for the heading.
   *
   * The heading and both toggles paint long before `/kpis/management/working-hours` answers — one
   * of the slowest reads on staging — and reading early returns an empty table, which looks exactly
   * like the mode being absent (#3774's lesson, and #3575's).
   *
   * **A row is NOT always `working-hours-name-t…`**: the board opens in GRUPPEN view, whose rows
   * are team toggles under the pre-existing `team-toggle-g<teamId>` id (#3718). Polling for the
   * therapist id alone never resolves until the view is switched, and the 240 s timeout then reads
   * exactly like the whole feature being absent — which is how this file first failed.
   */
  async waitForTable(ms = 240_000): Promise<void> {
    await expect
      .poll(async () =>
        (await this.page.locator('[data-testid^="working-hours-name-t"]').count())
        + (await this.page.locator('[data-testid^="team-toggle-g"]').count()),
        { timeout: ms, intervals: [1_000, 2_000, 4_000] })
      .toBeGreaterThan(0);
  }

  /** Readiness for the therapist-level assertions specifically. */
  async waitForTherapistRows(ms = 240_000): Promise<void> {
    await expect
      .poll(async () => this.page.locator('[data-testid^="working-hours-name-t"]').count(),
        { timeout: ms, intervals: [1_000, 2_000, 4_000] })
      .toBeGreaterThan(0);
  }

  /** The payload the table was last drawn from. */
  rows(): WhRow[] {
    if (!this.payloads.length) throw new Error('no working-hours payload was captured');
    return this.payloads[this.payloads.length - 1];
  }

  async selectMode(label: 'Details' | 'Operativ' | 'Abrechnung'): Promise<void> {
    await this.page.getByText(label, { exact: true }).first().click({ force: true, timeout: 60_000 });
    await this.page.waitForTimeout(2_000);
    await this.waitForTable(120_000);
  }

  async selectView(label: 'Gruppen' | 'Therapeut:innen'): Promise<void> {
    await this.page.getByText(label, { exact: true }).first().click({ force: true, timeout: 60_000 });
    await this.page.waitForTimeout(2_000);
    if (label === 'Therapeut:innen') await this.waitForTherapistRows(120_000);
    else await this.waitForTable(120_000);
  }

  /** Whether the mode toggle offers a label at all (AC1). */
  async offersMode(label: string): Promise<boolean> {
    return (await this.page.getByText(label, { exact: true }).count()) > 0;
  }

  /**
   * The header row, left→right, read from the "VO"-less header band.
   *
   * `textContent` rather than `innerText`: the headers are CSS-uppercased and German ß uppercases
   * to SS, so `innerText` yields MASSNAHME, which matches neither /Maßnahme/ nor /Maßnahme/i
   * (#3718/#3770). Here the labels are already upper-case in the source, so both agree — the read
   * is kept explicit so a future label with an ß does not silently drift.
   */
  async headers(): Promise<string[]> {
    return this.page.evaluate(() => {
      const anchor = [...document.querySelectorAll('[data-testid="working-hours-name-header"]')][0];
      if (!anchor) return [];
      const ar = anchor.getBoundingClientRect();
      return [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          const t = (e.textContent || '').trim();
          return t && Math.abs(r.top - ar.top) < 16 && r.width > 0 ? { t, x: Math.round(r.left) } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.x - b.x)
        .map((o: any) => o.t) as string[];
    });
  }

  /** The header row as the screen PAINTS it (CSS-uppercased), for the AC's own wording. */
  async headersPainted(): Promise<string[]> {
    const src = await this.headers();
    return src.map((h) => h.toLocaleUpperCase('de-DE'));
  }

  cell(therapistId: number, key: string): Locator {
    return this.page.getByTestId(`working-hours-${key}-t${therapistId}`).first();
  }

  /** The five painted numbers of a therapist row, in column order. */
  async paintedRow(therapistId: number): Promise<(number | null)[]> {
    const out: (number | null)[] = [];
    for (const k of WorkingHoursAbrechnungPage.COLUMN_KEYS) {
      const t = (await this.cell(therapistId, k).textContent().catch(() => null))?.trim() ?? null;
      out.push(t === null || t === '' ? null : Number(t));
    }
    return out;
  }

  expander(therapistId: number): Locator {
    return this.page.getByTestId(`working-hours-expand-t${therapistId}`).first();
  }

  async toggleExpand(therapistId: number): Promise<void> {
    await this.expander(therapistId).click({ force: true, timeout: 60_000 });
    await this.page.waitForTimeout(3_000);
  }

  /** The facility sub-rows currently painted for a therapist, keyed by testid suffix. */
  async facilityTestIds(therapistId: number): Promise<string[]> {
    return this.page.evaluate((id) => [...document.querySelectorAll('[data-testid]')]
      .map((e) => e.getAttribute('data-testid') || '')
      .filter((t) => t.startsWith(`working-hours-facility-t${id}-`)), therapistId);
  }

  /**
   * One painted facility sub-row: its name and five numbers, read by the sub-row's own y-band.
   *
   * The cells carry no per-cell testid, so they are gathered from the row element's vertical band —
   * and the numbers are taken in x order, which is also what makes the alignment regression below
   * detectable.
   */
  async facilitySubRow(testId: string): Promise<{ name: string; numbers: number[]; boxes: number[] }> {
    return this.page.evaluate((tid) => {
      const row = document.querySelector(`[data-testid="${tid}"]`);
      if (!row) return { name: '', numbers: [], boxes: [] };
      const rr = row.getBoundingClientRect();
      const leaves = [...row.querySelectorAll('*')]
        .filter((e) => e.children.length === 0)
        .map((e) => ({ t: (e.textContent || '').trim(), r: e.getBoundingClientRect() }))
        .filter((o) => o.t && o.r.width > 0)
        .sort((a, b) => a.r.left - b.r.left);
      const nums = leaves.filter((o) => /^-?\d+$/.test(o.t));
      const name = leaves.find((o) => !/^-?\d+$/.test(o.t) && !/^[├└]─$/.test(o.t))?.t ?? '';
      return {
        name,
        numbers: nums.map((o) => Number(o.t)),
        // the RIGHT edge of each number, which is what a right-aligned column shares
        boxes: nums.map((o) => Math.round(o.r.right)),
        _top: Math.round(rr.top),
      } as any;
    }, testId);
  }

  /** The right edge of each of a therapist row's five numbers — the alignment baseline. */
  async therapistNumberEdges(therapistId: number): Promise<number[]> {
    const out: number[] = [];
    for (const k of WorkingHoursAbrechnungPage.COLUMN_KEYS) {
      const box = await this.cell(therapistId, k).boundingBox().catch(() => null);
      out.push(box ? Math.round(box.x + box.width) : -1);
    }
    return out;
  }

  /** How many tree connectors the page currently paints. */
  async treeGlyphCount(): Promise<number> {
    const txt = await this.page.locator('#root').innerText();
    return (txt.match(/[├└]─/g) ?? []).length;
  }

  // ───────────────────────────── oracles ─────────────────────────────

  /** The sum of one count across a therapist's facility sub-rows (AC5's left-hand side). */
  static facilitySum(row: WhRow, columnKey: string): number {
    const k = WorkingHoursAbrechnungPage.FACILITY_KEY_OF[columnKey];
    return (row.facilityBreakdown ?? []).reduce((a, f) => a + ((f[k] as number) ?? 0), 0);
  }

  /** The therapist-level value a column must show. */
  static therapistValue(row: WhRow, columnKey: string): number {
    return (row[WorkingHoursAbrechnungPage.FIELD_OF[columnKey]] as number) ?? 0;
  }

  /**
   * A row where the right field and the wrong one DISAGREE, i.e. one that can actually catch a
   * binding to `completedUnbilledCount`. A row where they agree proves nothing.
   */
  static discriminatesOnCompleted(row: WhRow): boolean {
    return (row.completedOnlyUnbilledCount ?? 0) !== (row.completedUnbilledCount ?? 0);
  }
}
