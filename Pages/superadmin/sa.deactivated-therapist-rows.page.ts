import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';
import { FlowBoardsPage } from './sa.flow-boards.page';

/**
 * Deactivated therapists in the Management board's tiles and Detail table (RC 3.13 #3579).
 *
 * #3210 deliberately kept deactivated therapists visible everywhere on the Management board, labeled
 * "(Inaktiv)", so a departed therapist's unbilled work stays findable. #3579 narrows that in two
 * places only: the traffic-light tiles count **active therapists only**, and the Detail table drops a
 * deactivated therapist's row when it carries **no data at all** for the period.
 *
 * ## Where the rule actually lives
 *
 * **The API population is unchanged — the filtering is client-side**, which is what makes this
 * testable end to end. `GET /kpis/management/therapists` still returns every therapist with period
 * data, deactivated ones included, each row carrying `active`, `bucket`, `revenue` and
 * `validatedRevenue`. The shipped fix is a two-function module:
 *
 * ```js
 * activeTileRows   = rows => rows.filter(r => r.active)
 * visibleTableRows = rows => rows.filter(r => r.active || 'grau' !== r.bucket
 *                                          || 0 !== r.revenue || 0 !== r.validatedRevenue)
 * ```
 *
 * wired into the Management board as
 * `V = useMemo(() => activeTileRows(t.rows))` → tiles and
 * `q = useMemo(() => visibleTableRows(t.rows))` → table, both from the same `t.rows`.
 *
 * `visibleTableRows` is the exact De Morgan complement of AC2's "hide when deactivated **and** grau
 * **and** zero revenue **and** zero validated", so the predicate can be checked against the AC's own
 * truth table rather than only against whatever staging happens to hold.
 *
 * Two consequences worth asserting:
 *
 * - **AC6 holds by construction.** Both derived arrays come from the same unfiltered `t.rows`, and
 *   the KPI cards read a different hook entirely — nothing upstream was narrowed.
 * - **The shared component was left alone.** `TrafficLightBuckets` is reused by the Therapeuten-Orga
 *   board, and the Developer Reference warned that filtering *inside* it would silently change that
 *   board too. The helpers live in their own module with exactly one call site, so the TO board still
 *   counts everyone — the safe option was taken.
 *
 * ## Traps
 *
 * - **The default period hides the whole subject.** With no `from`/`to` the endpoint returns 122 rows
 *   of which **zero** are deactivated, so every #3579 assertion passes vacuously. A window with
 *   history is required — `HISTORY_WINDOW` (Q4 2025) yields 108 rows with **21** deactivated.
 * - **`grau` means "no Personio hours", not "no activity"** (see #3580, which relabels it). A
 *   deactivated therapist can be `grau` *and* carry revenue — 2025 is full of them — which is exactly
 *   why AC2 needs all four conditions and not just the bucket.
 * - A very wide window (2025→2026) can 504; keep windows to a year.
 *
 * ## The board on screen
 *
 * The API tests above check the two predicates against the rows. What a QA actually looks at is the
 * rendered tiles and table, and the fixture for THAT is a month, not the year window: the board's
 * period stepper only walks Tag/Woche/Monat, so `MONTH_FIXTURE` (**April 2026**) is used —
 * 116 rows, 4 deactivated, and **2 of those are grau/€0/€0**, so it is the one UI-reachable period
 * where AC1 *and* AC2 both bite. Tiles move `26/41/39/10` (all rows) → **`25/41/38/8`** (active
 * only), which is a visible change in three of the four live tiles.
 *
 * `FlowBoardsPage.BUCKETS` cannot be used to read those tiles: #3580 relabelled the Management
 * board's Grau pill to **"Grau — keine Personio-Stunden"** (label *and* range, overridden per board
 * so the Therapeuten-Orga pill keeps "keine Aktivität"), so the shared page object's Grau entry is
 * stale for this board. `MANAGEMENT_BUCKET_LABELS` carries the current wording.
 */

/**
 * The window that actually contains deactivated therapists on staging.
 *
 * **Q4 2025, not the full year** — a cheaper read with the same coverage, chosen when the year-wide
 * window began answering **504 at the 30 s ALB idle timeout** (four consecutive attempts) while this
 * one answered in 8.6 s. Q4 carries everything the assertions need: 108 rows, **21 deactivated**,
 * both AC3 shapes reachable (grau-with-revenue and non-grau), an AC2 fixture under
 * `patientType=pkv`, and tiles that move `28/36/33/11` → **`17/29/32/9`**.
 *
 * Do not read the narrower window as a cure for those 504s. `/kpis/management/therapists` is simply
 * unreliable under load — measured within one hour on 2026-09-10: the default window (no params)
 * went from 2.6 s to a 504, and a 2-month window 504'd in the same minute a 3-month one answered
 * (#3401's ~5-minute `kpi_data` cache is what makes the same request cheap or expensive). When every
 * window 504s, the endpoint is unhealthy — re-run rather than triage the fixture.
 */
export const HISTORY_WINDOW = { from: '2025-10-01', to: '2025-12-31' } as const;

/**
 * The one period the board's own stepper can reach where both ACs have a fixture: April 2026 holds
 * 4 deactivated therapists, 2 of them grau/€0/€0 (AC2 hides those) and 2 with data (AC3 keeps
 * those, labeled "(Inaktiv)").
 */
export const MONTH_FIXTURE = {
  from: '2026-04-01',
  to: '2026-04-30',
  /** As the period label renders it in Monat level. */
  label: 'April 2026',
} as const;

/**
 * The Management board's tile labels as #3580 leaves them — the Grau pill carries a board-local
 * override, so `FlowBoardsPage.BUCKETS`'s "Grau — keine Aktivität" no longer matches here.
 */
export const MANAGEMENT_BUCKET_LABELS: Record<keyof TileCounts, string> = {
  rot: 'Rot',
  gelb: 'Gelb',
  gruen: 'Grün',
  grau: 'Grau — keine Personio-Stunden',
  abwesend: 'Abwesend',
};

export type TherapistRow = {
  therapistId: number;
  therapistName: string;
  teamId: number | null;
  teamName: string | null;
  bucket: string;
  revenue: number;
  validatedRevenue: number;
  active: boolean;
};

export type TileCounts = { rot: number; gelb: number; gruen: number; grau: number; abwesend: number };

export class DeactivatedTherapistRowsPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3579: no bearer token');
  }

  private async json(path: string, timeout = 240_000): Promise<any> {
    let last = '';
    // Four attempts with a growing wait: the year-wide window is the slowest read on this board and
    // answers 504 under load (CLAUDE.md's standing note on the KPI endpoints). Three tries at a flat
    // 4 s was not enough on a loaded staging.
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(4_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  /** The rows both the tiles and the table are built from. `query` takes the board's filter params. */
  async therapistRows(query: Record<string, string> = {}): Promise<TherapistRow[]> {
    const qs = new URLSearchParams(query).toString();
    const body = await this.json(`/kpis/management/therapists${qs ? `?${qs}` : ''}`);
    const rows = body?.member ?? body?.['hydra:member'] ?? [];
    return rows.map((r: any) => ({
      therapistId: r.therapistId,
      therapistName: r.therapistName,
      teamId: r.teamId ?? null,
      teamName: r.teamName ?? null,
      bucket: r.bucket,
      revenue: r.revenue ?? 0,
      validatedRevenue: r.validatedRevenue ?? 0,
      active: !!r.active,
    }));
  }

  // ─────────────────────────── the shipped predicates, ported ───────────────────────────

  /** AC1: `rows.filter(r => r.active)`. */
  static activeTileRows<T extends { active: boolean }>(rows: T[]): T[] {
    return rows.filter((r) => r.active);
  }

  /**
   * AC2/AC3: `rows.filter(r => r.active || 'grau' !== r.bucket || 0 !== r.revenue || 0 !== r.validatedRevenue)`.
   *
   * Kept in the shipped form rather than rewritten as the negation, so a reader can compare it to the
   * bundle character for character.
   */
  static visibleTableRows<T extends { active: boolean; bucket: string; revenue: number; validatedRevenue: number }>(rows: T[]): T[] {
    return rows.filter((r) => r.active || 'grau' !== r.bucket || 0 !== r.revenue || 0 !== r.validatedRevenue);
  }

  /** The rows AC2 says to hide — the complement of `visibleTableRows`. */
  static hiddenByAc2<T extends { active: boolean; bucket: string; revenue: number; validatedRevenue: number }>(rows: T[]): T[] {
    return rows.filter((r) => !r.active && 'grau' === r.bucket && 0 === r.revenue && 0 === r.validatedRevenue);
  }

  static tileCounts(rows: { bucket: string }[]): TileCounts {
    const c: TileCounts = { rot: 0, gelb: 0, gruen: 0, grau: 0, abwesend: 0 };
    for (const r of rows) if (r.bucket in c) (c as any)[r.bucket] += 1;
    return c;
  }

  // ─────────────────────────────── the deployed bundle ───────────────────────────────

  async entryBundle(): Promise<string> {
    const html = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3579: no entry bundle in the served HTML');
    return await (await this.page.request.get(`https://staging.therapios.de${src}`, { timeout: 180_000 })).text();
  }

  /** How many times a name appears in the bundle — 1 definition + n call sites. */
  static occurrences(bundle: string, name: string): number {
    return bundle.split(name).length - 1;
  }

  /** How many deactivated therapists exist at all, which decides whether a fixture is possible. */
  async deactivatedTherapistCount(): Promise<{ total: number; deactivated: number }> {
    const body = await this.json('/users?itemsPerPage=1000');
    const users = body?.member ?? [];
    const therapists = users.filter((u: any) => (u.roles ?? []).includes('ROLE_THERAPIST'));
    return { total: therapists.length, deactivated: therapists.filter((u: any) => false === u.active).length };
  }

  // ───────────────────────────────── the board on screen ─────────────────────────────────

  /**
   * Opens the Management board at `MONTH_FIXTURE` and returns the driver.
   *
   * `mintUiSession` rather than the saved `storageState`: since the v3.12 auth migration a
   * `.auth/*.json` refresh token is spent by the first run, and a spec that relies on it lands on
   * the login form — which reads as "the board renders nothing" (it is what blocks
   * `sa_flow_boards_buckets.spec.ts` today).
   *
   * The period is reached by STEPPING, because the board's Periode mode only walks Tag/Woche/Monat
   * and there is no arbitrary-month picker. Stepping stops on the label, not after a fixed number of
   * clicks, so the helper keeps working as the current month moves.
   */
  async openManagementMonth(): Promise<FlowBoardsPage> {
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(this.page);
    await boards.open();
    await boards.openTab('Management');
    await boards.waitForBoardLoaded();
    await boards.setLevel('Monat');

    for (let step = 0; step < 24; step++) {
      if (MONTH_FIXTURE.label === (await boards.periodLabel())) return boards;
      await boards.stepPeriod('back');
    }
    throw new Error(`#3579: could not step back to ${MONTH_FIXTURE.label}`);
  }

  /**
   * The five rendered tile counts, keyed by bucket.
   *
   * Read off the pill's own text ("Rot\n25\n< 70 %") rather than through `FlowBoardsPage.BUCKETS`,
   * whose Grau label is stale for this board (#3580). A pill whose count cannot be parsed comes back
   * `null` instead of 0 — four real zeros and a board that has not painted look identical otherwise
   * (#3233).
   */
  async renderedTileCounts(): Promise<Record<keyof TileCounts, number | null>> {
    return this.page.evaluate((labels) => {
      const out: Record<string, number | null> = {};
      const pills = [...document.querySelectorAll('[role="button"]')] as HTMLElement[];
      for (const [key, label] of Object.entries(labels)) {
        const pill = pills.find((el) => (el.innerText || '').trim().startsWith(label));
        const match = pill ? (pill.innerText || '').match(/\n\s*(\d+)\s*\n/) : null;
        out[key] = match ? Number(match[1]) : null;
      }
      return out;
    }, MANAGEMENT_BUCKET_LABELS as unknown as Record<string, string>) as Promise<Record<keyof TileCounts, number | null>>;
  }

  /** The Grau pill's two lines, for the #3580 wording regression. */
  async grauPillText(): Promise<string | null> {
    return this.page.evaluate((label) => {
      const pill = ([...document.querySelectorAll('[role="button"]')] as HTMLElement[])
        .find((el) => (el.innerText || '').trim().startsWith(label));
      return pill ? (pill.innerText || '').replace(/\n/g, ' | ') : null;
    }, MANAGEMENT_BUCKET_LABELS.grau);
  }

  /**
   * The painted therapist names, with #3210's "(Inaktiv)" suffix stripped.
   *
   * A deactivated row renders as one line — `"Jacqueline Kusche (Inaktiv)"` — so the raw output of
   * `FlowBoardsPage.detailRowNames()` never contains a deactivated therapist's bare name and an
   * exact-membership check on it reports AC3 as failing when it holds. The suffix is kept out here
   * and asserted separately via `tableRowFor()`.
   */
  static plainNames(rows: string[]): string[] {
    return rows.map((row) => DeactivatedTherapistRowsPage.normalizeName(row.replace(/\s*\(Inaktiv\)\s*$/, '')));
  }

  /**
   * A therapist name in the form both sides can be compared in.
   *
   * The stored names are not all clean — `"Christina  Kirch"` carries a double space in the API —
   * and HTML collapses whitespace runs when it renders, so the served name and the painted one are
   * different strings. Every comparison here goes through this.
   */
  static normalizeName(name: string): string {
    return name.replace(/\s+/g, ' ').trim();
  }

  /**
   * Whether a therapist's name is painted anywhere in the detail table, and whether the row carries
   * the "(Inaktiv)" label #3210 puts on a deactivated therapist.
   *
   * The table flattens to one text blob, so the label is matched on the same line as the name rather
   * than through a row locator — in the flat Therapeut:innen view the rows are not buttons, so a
   * locator-based lookup silently finds one element (see `FlowBoardsPage.detailRowNames`).
   */
  async tableRowFor(name: string): Promise<{ present: boolean; inaktiv: boolean } | null> {
    return this.page.evaluate((therapist) => {
      const root = document.querySelector('#root') ?? document.body;
      const lines = ((root as HTMLElement).innerText || '').split('\n').map((l) => l.trim());
      const line = lines.find((l) => l.startsWith(therapist));
      if (!line) return { present: false, inaktiv: false };
      return { present: true, inaktiv: line.includes('(Inaktiv)') };
    }, name);
  }

}
