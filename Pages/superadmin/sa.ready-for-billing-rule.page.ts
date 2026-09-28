import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The one shared ready-for-billing population — RC 3.14 #3775 (PR **#3788**, merged to
 * `release/3.14.0` 2026-09-23T22:18Z).
 *
 * Three surfaces counted "finished VOs not yet billed" with their own rule; they now read one
 * population — status ∈ {Fertig Behandelt, Abgebrochen, Abgelaufen}, ≥1 signed treatment, not in a
 * billing submission — and each keeps its own age setting on top.
 *
 * | Surface | Endpoint | Age setting |
 * |---|---|---|
 * | Orga risk tile "Fertig > 30 T, nicht abger." | `/kpis/orga/risks` → `tiles.fertigNichtAbgerechnet` | > 30 days |
 * | Orga working-hours "Fertig n. abger." | `/kpis/management/working-hours` → `completedUnbilledCount` | none; its `completedUnbilledOver30Count` is > 30 days |
 * | Admin-Performance "Bereit zur Abrechnung" | `/kpis/admin-performance/risks` → `tiles.bereitZurAbrechnung` | none |
 *
 * ## The population change is directly measurable, because this suite measured the before
 *
 * `sa_to_risk_grouping.spec.ts` recorded `fertigNichtAbgerechnet = 1179` and
 * `unbilled-summary = {1179, 815939.73}` at midday on 2026-09-23 — hours before #3788 merged. The
 * same reads now answer **1625** and **{1625, 923960.98}**, and the tile's new `voStatus` field
 * splits that as Fertig Behandelt 1182 / Abgebrochen 165 / Abgelaufen 278. That is the ticket's
 * whole subject in one comparison, and no fixture had to be built for it.
 *
 * ## Traps
 *
 *  - **Comparing the three TILE TOTALS is not AC5 and will read as a failure.** 1,625 against
 *    2,266 is a *therapist population* difference: five `ZZPerf-*` load-test therapists carry 587
 *    ready VOs on Admin-Performance and appear on the Orga board at all. AC5 is scoped "for any one
 *    therapist", and per therapist the sets agree exactly. {@link zzPerfTherapists} names them.
 *  - **PKV must be excluded before the surfaces are compared** — AC5 says so, and AC6's last row is
 *    the reason: a PKV VO with an active invoice counts on the Orga surfaces and NOT on
 *    Admin-Performance. Nine live instances. Comparing with PKV in gives nine spurious
 *    disagreements, all of them the specified behaviour.
 *  - **`completedUnbilledCount` cannot be filtered by insurance type** — it is one number per
 *    therapist — so the working-hours comparison is made against the Admin-Performance set PLUS the
 *    PKV VOs that rule 3 excludes, rather than pretending the number can be narrowed.
 *  - The risk payload is ~3.4 MB and takes ~30 s; all three reads are cached per worker.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** AC1's three statuses, in the German the API serves (the ticket's Localization Reference). */
export const READY_STATUSES = ['Fertig Behandelt', 'Abgebrochen', 'Abgelaufen'] as const;

/** AC2's age setting for the two surfaces that have one. "More than 30", so 30 does not qualify. */
export const OVER_DAYS = 30;

/**
 * What this suite measured at midday on 2026-09-23, before PR #3788 merged that evening.
 *
 * Pinned as the before-reading rather than re-derived: it cannot be re-measured now, and it is what
 * makes the population change observable without building a fixture.
 */
export const BEFORE_3788 = { fertigTile: 1179, unbilledCount: 1179, unbilledRevenue: 815_939.73 } as const;

/**
 * The five load-test therapists on Admin-Performance but not the Orga board.
 *
 * `active: true` and `isTestAccount: false`, so #3182's test-account exclusion does not catch them;
 * they sit in synthetic "ZZPerf Entity …" Gesellschaften and carry no working-hours data, which is
 * what keeps them off a board built from `ManagementTherapistMetrics::queryTherapistIds`.
 */
export const ZZPERF_THERAPIST_IDS = [297, 298, 299, 301, 302] as const;

export type RiskRow = {
  prescriptionId: number;
  voNumber: string;
  tile: string;
  voStatus?: string | null;
  isPrivate?: boolean | null;
  daysSince?: number | null;
  activityCount?: number | null;
  therapistId?: number | null;
  therapistName?: string | null;
  patientName?: string | null;
};

export type WorkingHoursRow = {
  therapistId?: number | null;
  therapistName?: string | null;
  completedUnbilledCount?: number | null;
  completedUnbilledOver30Count?: number | null;
};

export class ReadyForBillingRulePage {
  private static cache = new Map<string, Promise<unknown>>();
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

  // ─────────────────────────────── the reads ──────────────────────────────

  /** A cached GET. These are the slowest reads on staging, and a 5xx is retried rather than scored. */
  private async cachedGet<T>(path: string): Promise<T> {
    const hit = ReadyForBillingRulePage.cache.get(path);
    if (hit) return (await hit) as T;
    const promise = this.fetch<T>(path);
    ReadyForBillingRulePage.cache.set(path, promise as Promise<unknown>);
    return await promise;
  }

  private async fetch<T>(path: string): Promise<T> {
    const token = await this.token();
    const opts = {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    };
    let res = await this.request.get(`${API_BASE}${path}`, opts);
    for (let attempt = 1; attempt <= 2 && res.status() >= 500; attempt++) {
      console.log(`  GET ${path} -> ${res.status()}; retrying (${attempt}/2)`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      res = await this.request.get(`${API_BASE}${path}`, opts);
    }
    expect(res.status(), `GET ${path}`).toBe(200);
    return (await res.json()) as T;
  }

  /** API Platform wraps a single-item DTO collection on these routes but not on every sibling. */
  private static unwrap<T>(body: unknown): T {
    const b = body as { member?: T[] };
    return Array.isArray(b?.member) ? b.member[0] : (body as T);
  }

  async orgaRisks(): Promise<{ rows: RiskRow[]; tiles: Record<string, number> }> {
    const dto = ReadyForBillingRulePage.unwrap<{ rows?: RiskRow[]; tiles?: Record<string, number> }>(
      await this.cachedGet('/kpis/orga/risks'),
    );
    return { rows: dto.rows ?? [], tiles: dto.tiles ?? {} };
  }

  async adminPerformanceRisks(): Promise<{ rows: RiskRow[]; tiles: Record<string, number> }> {
    const dto = ReadyForBillingRulePage.unwrap<{ rows?: RiskRow[]; tiles?: Record<string, number> }>(
      await this.cachedGet('/kpis/admin-performance/risks'),
    );
    return { rows: dto.rows ?? [], tiles: dto.tiles ?? {} };
  }

  async workingHours(): Promise<WorkingHoursRow[]> {
    const body = await this.cachedGet<{ member?: WorkingHoursRow[] }>('/kpis/management/working-hours');
    return body.member ?? [];
  }

  async unbilledSummary(): Promise<{ count: number; totalRevenue: number }> {
    const dto = ReadyForBillingRulePage.unwrap<{ count: number; totalRevenue: number }>(
      await this.cachedGet('/kpis/management/unbilled-summary'),
    );
    return { count: dto.count, totalRevenue: dto.totalRevenue };
  }

  /** The VO rows behind a sample of tile entries, for AC1's billing-submission clause. */
  async prescriptions(ids: number[]): Promise<Record<string, unknown>[]> {
    const query = ids.map((id) => `id[]=${id}`).join('&');
    const body = await this.fetch<{ member?: Record<string, unknown>[] }>(
      `/prescriptions?${query}&itemsPerPage=${Math.max(ids.length, 1)}`,
    );
    return body.member ?? [];
  }

  // ─────────────────────────────── selectors ──────────────────────────────

  static fertigRows(rows: RiskRow[]): RiskRow[] {
    return rows.filter((r) => r.tile === 'fertigNichtAbgerechnet');
  }

  static bereitRows(rows: RiskRow[]): RiskRow[] {
    return rows.filter((r) => r.tile === 'bereitZurAbrechnung');
  }

  static nonPkv(rows: RiskRow[]): RiskRow[] {
    return rows.filter((r) => !r.isPrivate);
  }

  static byTherapist(rows: RiskRow[]): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>();
    for (const r of rows) {
      const id = r.therapistId;
      if (typeof id !== 'number') continue;
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(r.voNumber);
    }
    return out;
  }

  static countBy<T>(rows: T[], key: (r: T) => string | null | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(key(r))] = (out[String(key(r))] ?? 0) + 1;
    return out;
  }
}
