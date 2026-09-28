import { Page, expect } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * The Management board's KPI cards, trend chart and detail table must report the same revenue
 * for the same filters and period (RC 3.12 #3398).
 *
 * **What actually shipped is not what the ticket's Developer Reference proposed.** That reference
 * blamed the therapist POPULATION — the cards resolve it over the single period, the trend over
 * the whole 12-period span — and suggested unifying the two. The fix that landed (in `d10e8f075`,
 * 2026-08-19, alongside the Personio work) leaves that asymmetry in place and changes the WINDOW
 * instead: in Zeitraum (custom-range) mode the board now sends `rangeFrom`, and the series TILES
 * `[rangeFrom..to]` rather than trailing 12 periods back from `to`. Before it, a card totalling a
 * custom range was compared against a chart showing 12 full periods ending at that range's end
 * date — two different windows, hence two different numbers.
 *
 * So the surfaces this page object addresses are:
 *
 * | surface | endpoint |
 * |---|---|
 * | KPI cards (+ waterfall) | `GET /kpis/management?from&to` |
 * | Verlauf chart, Periode mode | `GET /kpis/management/trend?level&to` — 12 trailing periods |
 * | Verlauf chart, Zeitraum mode | `GET /kpis/management/trend?level&to&rangeFrom` — tiles the range |
 * | Detail table | `GET /kpis/management/therapists` and `/teams` |
 *
 * **`rangeFrom` is deliberately a separate parameter from the cards' `from`.** `buildManagementFilter`
 * emits it only for the trend caller and only in Zeitraum mode (`...l && 'zeitraum' === M && {rangeFrom: o.from}`
 * in the deployed bundle); five other consumers share that builder and one SPREADS its result, so
 * a bare `from` would have leaked into unrelated requests and collapsed a Periode export's 12
 * buckets to one.
 *
 * **Traps**
 * - **Periode mode is not a mismatch.** Without `rangeFrom` the trend legitimately describes a
 *   different window from a card request over a custom range; comparing those two sums reports a
 *   bug that does not exist. Compare per-period (each bucket against a card for that bucket's own
 *   dates) or compare a Zeitraum series against a card for the same range.
 * - **KPI reads are cached 5 minutes and keyed on the span** (#3401). A Periode and a Zeitraum
 *   request ending on the same date carry different cache keys by design (the `v2` generation tag
 *   and both span ends), so they do not contaminate each other — but repeating the same request
 *   measures the cache, not the board.
 * - **The population IS resolved more widely than the revenue window, and that is not the bug.**
 *   `findTherapistIdsWithPeriodData` widens to whole UTC calendar days, so a therapist whose only
 *   activity sits at a Berlin day edge shows up in the NEIGHBOURING day's detail table with
 *   revenue 0. The totals are unaffected because the revenue math converts the range properly.
 * - `revenuePerHour` comes back **null** from the trend and **0** from the cards on some
 *   zero-revenue periods — compare with a null-coalesce or every empty day reads as a mismatch.
 * - The CSV export (`POST /kpis/management/export`), which #3398 also touched, answers **403** for
 *   any account outside the Kian/Dennis allowlist (#3181).
 */

export const API = 'https://api.staging.therapios.de';

export type TrendLevel = 'tag' | 'woche' | 'monat';

export type TrendPeriod = {
  periodStart: string;
  periodEnd: string;
  gesamt: { revenue: number; validatedRevenue: number; revenuePerHour: number | null };
  teams: { teamId: number | null; teamName: string; revenue: number; validatedRevenue: number }[];
};

export type CardValues = {
  treatedRevenue: number;
  validatedRevenue: number;
  revenuePerHour: number | null;
  efficiency: number | null;
};

export type TherapistRow = {
  therapistId: number;
  therapistName: string;
  teamId: number | null;
  revenue: number;
  validatedRevenue: number;
};

export type TeamRow = { teamId: number | null; teamName: string; revenue: number; validatedRevenue: number };

/** Board filters, in the shape the endpoints take them. */
export type BoardFilters = {
  therapist?: number;
  team?: number | 'none';
  entity?: number;
  patientType?: 'gkv' | 'pkv';
  location?: string;
};

export class TrendParityPage {
  static readonly API = API;

  private token: string | null = null;

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  /** For probes that call an endpoint this class does not wrap (the CSV export). */
  authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private static filterQuery(filters: BoardFilters = {}): string {
    return Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`)
      .join('');
  }

  /** A raw GET, so the edge-case tests can assert a status instead of a payload. */
  async raw(path: string, timeout = 240_000): Promise<{ status: number; body: string }> {
    const res = await this.page.request.get(`${API}${path}`, { headers: this.auth(), timeout });
    return { status: res.status(), body: await res.text() };
  }

  private async json(path: string, timeout = 240_000): Promise<any> {
    const res = await this.raw(path, timeout);
    expect(res.status, `GET ${path}`).toBe(200);
    return JSON.parse(res.body);
  }

  // ─────────────────────────────── the surfaces ──────────────────────────────

  /** The KPI cards for one window. */
  async cards(from: string, to: string, filters: BoardFilters = {}): Promise<CardValues> {
    const body = await this.json(
      `/kpis/management?pagination=false&from=${from}&to=${to}${TrendParityPage.filterQuery(filters)}`,
    );
    const row = TrendParityPage.members(body)[0] ?? body;
    return {
      treatedRevenue: row.treatedRevenue,
      validatedRevenue: row.validatedRevenue,
      revenuePerHour: row.revenuePerHour ?? null,
      efficiency: row.efficiency ?? null,
    };
  }

  /**
   * The Verlauf chart. Omitting `rangeFrom` is Periode mode (12 trailing periods); supplying it is
   * Zeitraum mode, which tiles `[rangeFrom..to]`.
   */
  async trend(
    opts: { level: TrendLevel; to: string; rangeFrom?: string },
    filters: BoardFilters = {},
  ): Promise<TrendPeriod[]> {
    const range = opts.rangeFrom ? `&rangeFrom=${opts.rangeFrom}` : '';
    return TrendParityPage.members(
      await this.json(
        `/kpis/management/trend?pagination=false&level=${opts.level}&to=${opts.to}${range}` +
          TrendParityPage.filterQuery(filters),
      ),
    );
  }

  async therapistRows(from: string, to: string, filters: BoardFilters = {}): Promise<TherapistRow[]> {
    return TrendParityPage.members(
      await this.json(
        `/kpis/management/therapists?pagination=false&from=${from}&to=${to}${TrendParityPage.filterQuery(filters)}`,
      ),
    );
  }

  async teamRows(from: string, to: string, filters: BoardFilters = {}): Promise<TeamRow[]> {
    return TrendParityPage.members(
      await this.json(
        `/kpis/management/teams?pagination=false&from=${from}&to=${to}${TrendParityPage.filterQuery(filters)}`,
      ),
    );
  }

  // ───────────────────────────────── helpers ─────────────────────────────────

  static sum(values: number[]): number {
    return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  }

  static sumRevenue(periods: TrendPeriod[]): number {
    return TrendParityPage.sum(periods.map((p) => p.gesamt.revenue));
  }

  static sumValidated(periods: TrendPeriod[]): number {
    return TrendParityPage.sum(periods.map((p) => p.gesamt.validatedRevenue));
  }

  /** Whether the series tiles exactly `[from..to]` with no gap and no overlap. */
  static tiles(periods: TrendPeriod[], from: string, to: string): boolean {
    if (!periods.length) return false;
    if (periods[0].periodStart !== from || periods[periods.length - 1].periodEnd !== to) return false;
    for (let i = 1; i < periods.length; i++) {
      const previousEnd = new Date(`${periods[i - 1].periodEnd}T00:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      if (previousEnd.toISOString().slice(0, 10) !== periods[i].periodStart) return false;
    }
    return true;
  }

  // ─────────────────────── the AC2 day-boundary fixture ──────────────────────

  /**
   * Every activity on staging is stamped `00:00:00Z` or `10:00:00Z` (02:00 / 12:00 Berlin), so
   * AC2's boundary case has no natural fixture and has to be manufactured: move one therapist's
   * only activity of a day to the very start or end of that BERLIN day and check both surfaces
   * still count it there.
   *
   * `date` is writable (it sits in the `activity` group, which is the denormalization context),
   * and `KpiCacheInvalidationListener` watches `Activity`, so the KPI caches drop on the write —
   * the reads that follow are fresh rather than 5 minutes stale. Reading one back needs a
   * collection query: there is no item `Get` on this resource.
   */
  async activityDate(activityId: number, prescriptionId: number): Promise<string> {
    // `/activities/{id}` is **404** — the resource declares GetCollection, a calendar
    // GetCollection, the bulk Post, Delete and Patch, but NO item Get. Read the row through a
    // collection the SearchFilter supports (`therapist` or `prescription`) instead; addressing it
    // by id reads like a permissions problem and is simply an operation that does not exist.
    const rows = TrendParityPage.members(
      await this.json(`/activities?pagination=false&itemsPerPage=200&prescription=${prescriptionId}`),
    );
    const row = rows.find((a: any) => a.id === activityId);
    expect(row, `activity ${activityId} must be reachable through prescription ${prescriptionId}`).toBeTruthy();
    return row.date;
  }

  async setActivityDate(activityId: number, isoDate: string): Promise<{ status: number; date: string | null }> {
    const res = await this.page.request.patch(`${API}/activities/${activityId}`, {
      headers: { ...this.auth(), 'Content-Type': 'application/merge-patch+json' },
      data: { date: isoDate },
      timeout: 180_000,
    });
    const body = await res.json().catch(() => ({}) as any);
    return { status: res.status(), date: body?.date ?? null };
  }

  /** The countable activities a therapist documented inside one Berlin calendar day. */
  async countableActivitiesOnBerlinDay(therapistId: number, day: string): Promise<any[]> {
    const previous = new Date(`${day}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const after = `${previous.toISOString().slice(0, 10)}T22:00:00`;
    const before = `${day}T21:59:59`;
    const rows = TrendParityPage.members(
      await this.json(
        `/activities?pagination=false&itemsPerPage=50&therapist=${therapistId}` +
          `&date%5Bafter%5D=${after}&date%5Bbefore%5D=${before}`,
      ),
    );
    return rows.filter(
      (a: any) => !(a.rejectedTreatment && !a.rejectedTreatmentWithSignature) && 'planned' !== a.treatmentType,
    );
  }

  /** Berlin summer time is UTC+2, so a Berlin day D runs `[D-1 22:00Z, D 22:00Z)`. */
  static berlinDayStartUtc(day: string): string {
    const previous = new Date(`${day}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return `${previous.toISOString().slice(0, 10)}T22:00:00+00:00`;
  }

  static berlinDayEndUtc(day: string): string {
    return `${day}T21:59:00+00:00`;
  }
}
