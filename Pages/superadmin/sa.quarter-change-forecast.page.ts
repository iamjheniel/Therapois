import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The one-off quarter-change ordering forecast — RC 3.14 #3773
 * (`app:report:quarter-change-order-forecast`, commit `17a654290` on `release/3.14.0`,
 * cherry-picked to `main` as `9002b2f78`).
 *
 * A READ-ONLY console report listing every VO that would become ready to order (Bestellen) between
 * 05.10. and 11.10.2026, so the operations team can order them before the 1 October quarter change
 * stops doctors prescribing. It writes a CSV and changes nothing.
 *
 * ## What is testable from a client, and what is not
 *
 * The command has no API surface at all, so neither the run nor its CSV is reachable. What IS
 * reachable is the RULE, and the ticket's own Testing Guidance asks for exactly that: *"Staging data
 * differs from production, so validate the formula itself here rather than the exact VO list."*
 * So `OrderReadyDateForecaster` is ported here and re-derived over live VOs.
 *
 * **The Blanko arm is verifiable end to end**, because every input it reads is serialized:
 * `blankoVO`, `date`, `followupStatus`, `orderingStatus` and `treatmentStatus`. The frequency arm is
 * not: **`decisionFrequencyPerWeek` is in no serialization group**, and the VO's own
 * `actualFrequency` is served as an empty object `{}`, so the projected date cannot be computed for
 * a real VO from outside. That arm is therefore driven as a pure function and its inputs
 * (`remainingTreatments`, the practice lead time) are checked against live data instead.
 *
 * ## The faithfulness check that matters, and it passes
 *
 * The forecaster's Blanko path does NOT call `evaluate()` — it re-applies two gates by hand and then
 * the 91-day rule. That is the obvious place for a divergence, and reading `evaluate()` settles it:
 * its order is `followupStatus` → `orderingStatus` → **`isBlankoVO()`** → treatment status →
 * frequency. The Blanko branch is reached BEFORE the treatment-status gate, so replicating only the
 * first two is correct, and omitting the third is not an oversight. (The command's own candidate
 * query excludes the five closed statuses anyway.)
 *
 * ## Traps
 *
 *  - **`blankoVO` is SILENTLY IGNORED as a filter**, and so is `exists[followupStatus]`: `true`,
 *    `false` and a nonsense control all return the whole 34,952-row book. A spec that narrowed by
 *    `blankoVO=true` would quietly forecast the entire book. Only the **`date[after]` /
 *    `date[before]`** filters work, which is why the Blanko population is reached through the ISSUE
 *    DATE window and filtered client-side. {@link assertFiltersPartition} pins this.
 *  - **`date[before]` is INCLUSIVE** (#3712), which happens to be what this window needs: issue
 *    dates 06.07.–12.07.2026 map exactly onto ready dates 05.10.–11.10.2026.
 *  - **`followupStatus` is omitted when null** (#3302), so the gate reads `undefined`, never `null`.
 *  - **`treatmentStatus NOT IN (:skipStatuses)` silently drops NULL rows** — no NULL satisfies a SQL
 *    `NOT IN` — so a VO carrying no treatment status can never be forecast. Same shape as #3731's
 *    `IN` finding; measured by {@link nullStatusCount}.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** `QuarterChangeOrderForecastCommand::DEFAULT_FROM/TO` — the ticket's window. */
export const WINDOW = { from: '2026-10-05', to: '2026-10-11' } as const;

/** The run day the ticket names (AC5: the report reaches the PM by 29 September 2026). */
export const RUN_DAY = '2026-09-29';

/** `PrescriptionIntervalEnum::TO_ORDER` — AC3's Blanko rule, "91 days from the issue date". */
export const TO_ORDER_DAYS = 91;

/** `PracticeLeadTimeCalculator` — the default and the clamp #3298 applies. */
export const LEAD_TIME = { standard: 21, min: 10, max: 30 } as const;

/** `QuarterChangeOrderForecastCommand::SKIP_STATUSES`, in the German the API serves. */
export const SKIP_STATUSES = [
  'Fertig Behandelt',
  'Abgelaufen',
  'Abgebrochen',
  'Abgerechnet',
  'Archiviert',
] as const;

/**
 * `FollowupOrderingStatus::BY_PRAXIS` / `BY_ER` — the two that take a VO out of the pipeline.
 *
 * **The backing values are NOT what the case names suggest**, and guessing them silently disables
 * the gate: the enum is `BY_ADMIN = 'By Admin'`, `BY_THERAPIST = 'By Therapist'`, but
 * `BY_PRAXIS = 'Praxis'` and `BY_ER = 'ER bestellt selbst'` — two of the four follow the "By X"
 * shape and two do not (#3749 records the same inconsistency as an open hygiene ticket, #3759).
 * A first version of this file used `['By Praxis', 'By ER']`, which matches nothing the API serves,
 * so the gate never fired and the forecast silently included VOs the report must skip.
 * {@link ORDERING_STATUSES} and its live assertion exist to stop that recurring.
 */
export const BLOCKED_ORDERING = ['Praxis', 'ER bestellt selbst'] as const;

/** Every `FollowupOrderingStatus` backing value, so the live population can be checked against it. */
export const ORDERING_STATUSES = ['By Admin', 'By Therapist', 'Praxis', 'ER bestellt selbst'] as const;

/** `QuarterChangeOrderForecastCommand::REPORT_HEADERS` — AC2's four columns, in order. */
export const REPORT_HEADERS = ['VO-Nummer', 'Patient', 'Praxis', 'Bestellen ab'] as const;

export type Vo = {
  id: number;
  prescriptionId?: string | null;
  blankoVO?: boolean | null;
  date?: string | null;
  followupStatus?: string | null;
  orderingStatus?: string | null;
  treatmentStatus?: string | null;
  remainingTreatments?: number | null;
  activityCount?: number | null;
  practice?: { id?: number; name?: string } | null;
  patient?: { id?: number; firstName?: string; lastName?: string } | null;
};

export type ForecastRow = {
  voNumber: string;
  patient: string;
  practice: string;
  readyDate: string;
  issueDate: string;
  treatmentStatus: string | null;
};

export class QuarterChangeForecastPage {
  private bearer: string | null = null;

  constructor(private request: APIRequestContext) {}

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

  // ─────────────────────────────── plumbing ───────────────────────────────

  private async get<T>(path: string, timeout = 300_000): Promise<T> {
    const token = await this.token();
    let res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout,
    });
    for (let attempt = 1; attempt <= 2 && res.status() >= 500; attempt++) {
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout,
      });
    }
    expect(res.status(), `GET ${path}`).toBe(200);
    return (await res.json()) as T;
  }

  async total(query: string): Promise<number> {
    const body = await this.get<{ totalItems?: number }>(`/prescriptions?itemsPerPage=1&${query}`);
    return body.totalItems ?? 0;
  }

  /**
   * **Proves the filters used below actually narrow anything**, before any count is believed.
   *
   * `/prescriptions` accepts an unregistered filter and returns the unfiltered book, so a bogus
   * control is the only way to tell a working filter from an ignored one. Here `blankoVO` and
   * `exists[followupStatus]` are both ignored and `date` is not.
   */
  async filterBehaviour(): Promise<{
    unfiltered: number;
    bogus: number;
    blankoTrue: number;
    blankoFalse: number;
    existsFollowupFalse: number;
    dateWindow: number;
  }> {
    const [unfiltered, bogus, blankoTrue, blankoFalse, existsFollowupFalse, dateWindow] = await Promise.all([
      this.total(''),
      this.total('zzzNotAFilter=1'),
      this.total('blankoVO=true'),
      this.total('blankoVO=false'),
      this.total('exists%5BfollowupStatus%5D=false'),
      this.total(`date%5Bafter%5D=${this.issueFrom()}&date%5Bbefore%5D=${this.issueTo()}`),
    ]);
    return { unfiltered, bogus, blankoTrue, blankoFalse, existsFollowupFalse, dateWindow };
  }

  // ───────────────────────── the window arithmetic ────────────────────────

  /** The issue dates whose +91 lands inside the report window — the only server-side narrowing. */
  issueFrom(): string {
    return QuarterChangeForecastPage.addDays(WINDOW.from, -TO_ORDER_DAYS);
  }

  issueTo(): string {
    return QuarterChangeForecastPage.addDays(WINDOW.to, -TO_ORDER_DAYS);
  }

  static addDays(iso: string, days: number): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  static day(iso: string): string {
    return iso.slice(0, 10);
  }

  // ───────────────────────────── the forecaster ───────────────────────────

  /**
   * `OrderReadyDateForecaster::forecastBlanko()`, ported.
   *
   * The two gates are `evaluate()`'s own first two, in its order; the treatment-status gate is
   * deliberately absent, because `evaluate()` reaches its Blanko branch before applying it.
   * Returns the ready date, or null when the VO is out of the pipeline or lands outside the window.
   */
  static forecastBlanko(vo: Vo, today: string, until: string): string | null {
    if (vo.followupStatus !== undefined && vo.followupStatus !== null) return null;
    if (BLOCKED_ORDERING.includes((vo.orderingStatus ?? '') as (typeof BLOCKED_ORDERING)[number])) return null;
    if (!vo.date) return null;
    const ready = QuarterChangeForecastPage.addDays(vo.date, TO_ORDER_DAYS);
    if (ready > until) return null;
    // `max($readyDate, $today)` — a VO already past its 91 days is reported as due today, which the
    // command then drops for being before the window.
    return ready > today ? ready : today;
  }

  /**
   * `OrderReadyDateForecaster::forecast()`'s frequency arm, ported.
   *
   * The smallest k ≥ 1 within the look-ahead where
   * `remaining <= ((lead + k) / 7) * frequency`, returned as `today + k`. Null when it never
   * triggers inside the window. `k` starts at 1 because k = 0 is "already due", which
   * `evaluate()` answers and the command excludes.
   */
  static forecastByFrequency(
    remainingTreatments: number,
    decisionFrequencyPerWeek: number,
    leadTimeDays: number,
    today: string,
    until: string,
  ): string | null {
    if (decisionFrequencyPerWeek <= 0) return null;
    for (let k = 1; ; k++) {
      const day = QuarterChangeForecastPage.addDays(today, k);
      if (day > until) return null;
      if (remainingTreatments <= ((leadTimeDays + k) / 7) * decisionFrequencyPerWeek) return day;
    }
  }

  /** `TransitionToOrderService::evaluate()`'s own threshold — k = 0, "already due today". */
  static alreadyDue(remainingTreatments: number, decisionFrequencyPerWeek: number, leadTimeDays: number): boolean {
    return decisionFrequencyPerWeek > 0 && remainingTreatments <= (leadTimeDays / 7) * decisionFrequencyPerWeek;
  }

  /** The command's candidate query, client-side. `treatmentStatus` NULL is excluded by SQL `NOT IN`. */
  static isCandidate(vo: Vo): boolean {
    if (vo.followupStatus !== undefined && vo.followupStatus !== null) return false;
    if (vo.treatmentStatus === undefined || vo.treatmentStatus === null) return false;
    if (SKIP_STATUSES.includes(vo.treatmentStatus as (typeof SKIP_STATUSES)[number])) return false;
    // `(t.bv = true OR SIZE(p.activities) > 0)` — a Blanko VO, or one that has been treated.
    return vo.blankoVO === true || (vo.activityCount ?? 0) > 0;
  }

  // ─────────────────────────────── live reads ─────────────────────────────

  /**
   * Static, not per-instance: each test builds its own page object, so an instance field would make
   * every one of them re-walk the 453-row window (~1 min each). The window is immutable within a
   * run, so one walk per worker is both correct and four minutes cheaper.
   */
  private static windowCache: Promise<Vo[]> | null = null;

  /**
   * Every VO issued inside the window that feeds the Blanko arm.
   *
   * **Paged at 100, not fetched in one 500-row page.** A `itemsPerPage=500` request for this window
   * carries ~450 VOs with their embedded patient and practice and **504s** — measured, and it took
   * two retries and 2.3 minutes to fail. Smaller pages answer comfortably, and the walk asserts it
   * collected `totalItems` so a truncated read can never masquerade as a short forecast.
   */
  async vosIssuedInBlankoWindow(): Promise<Vo[]> {
    if (!QuarterChangeForecastPage.windowCache) QuarterChangeForecastPage.windowCache = this.walkWindow();
    return await QuarterChangeForecastPage.windowCache;
  }

  private async walkWindow(): Promise<Vo[]> {
    const base = `/prescriptions?date%5Bafter%5D=${this.issueFrom()}&date%5Bbefore%5D=${this.issueTo()}&itemsPerPage=100`;
    const out: Vo[] = [];
    let total = 0;
    for (let page = 1; page <= 30; page++) {
      const body = await this.get<{ member?: Vo[]; totalItems?: number }>(`${base}&page=${page}`);
      total = body.totalItems ?? total;
      const rows = body.member ?? [];
      out.push(...rows);
      if (rows.length === 0 || out.length >= total) break;
    }
    // An incomplete walk would invent a short forecast, which is worse than failing outright.
    expect(out.length, 'the issue-date window was walked completely').toBe(total);
    return out;
  }

  /** The complete Blanko forecast for the window, re-derived from live data. */
  async blankoForecast(today = RUN_DAY): Promise<ForecastRow[]> {
    const rows = await this.vosIssuedInBlankoWindow();
    const out: ForecastRow[] = [];
    for (const vo of rows) {
      if (vo.blankoVO !== true) continue;
      if (!QuarterChangeForecastPage.isCandidate(vo)) continue;
      const ready = QuarterChangeForecastPage.forecastBlanko(vo, today, WINDOW.to);
      if (ready === null || ready < WINDOW.from) continue;
      out.push({
        voNumber: vo.prescriptionId ?? '',
        patient: [vo.patient?.lastName, vo.patient?.firstName].filter(Boolean).join(', '),
        practice: vo.practice?.name ?? '',
        readyDate: ready,
        issueDate: QuarterChangeForecastPage.day(vo.date ?? ''),
        treatmentStatus: vo.treatmentStatus ?? null,
      });
    }
    return out.sort((a, b) => (a.readyDate === b.readyDate ? a.voNumber.localeCompare(b.voNumber) : a.readyDate < b.readyDate ? -1 : 1));
  }

  /** How many VOs in the issue window carry no treatment status — the SQL `NOT IN` blind spot. */
  async nullStatusCount(): Promise<{ total: number; nullStatus: number }> {
    const rows = await this.vosIssuedInBlankoWindow();
    return { total: rows.length, nullStatus: rows.filter((v) => v.treatmentStatus === undefined || v.treatmentStatus === null).length };
  }

  /** `/practices` lead times — #3298's `leadTimeDays`, `leadTimeSource`, `leadTimeClamped`. */
  async practiceLeadTimes(limit = 200): Promise<{ days: number; source: string | null; clamped: boolean | null }[]> {
    const body = await this.get<{ member?: { leadTimeDays?: number; leadTimeSource?: string; leadTimeClamped?: boolean }[] }>(
      `/practices?itemsPerPage=${limit}`,
    );
    return (body.member ?? []).map((p) => ({
      days: p.leadTimeDays ?? LEAD_TIME.standard,
      source: p.leadTimeSource ?? null,
      clamped: p.leadTimeClamped ?? null,
    }));
  }

  /** AC1's baseline — automatic moves into `order`, which the report must never produce. */
  async orderTransitionLog(limit = 1000): Promise<{ at: string; to: string | null; automatic: boolean }[]> {
    const body = await this.get<{ member?: Record<string, unknown>[] }>(
      `/prescription_logs?type=follow_up_status_change&itemsPerPage=${limit}&order%5Bid%5D=desc`,
    );
    return (body.member ?? []).map((row) => {
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      return {
        at: (row.createdAt as string) ?? '',
        to: (meta.to as string) ?? null,
        automatic: meta.type !== 'manual',
      };
    });
  }
}
