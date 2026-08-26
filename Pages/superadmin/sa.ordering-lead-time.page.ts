import { Page, expect } from '@playwright/test';

/**
 * Per-practice ordering lead times and the follow-up "Bestellen" flag — RC 3.11 #3298 and #3302.
 *
 * #3298 replaced the flat 21-day lookahead that decides when a follow-up VO moves into "Bestellen"
 * with a per-practice value, recalculated **daily** from that practice's completed order cycles in
 * the last 4 weeks: ≥3 cycles gives it an Individual value (median turnaround + a 4-day buffer,
 * clamped to 10–30 days), fewer keeps the 21-day Standard. #3302 is the one-time command that
 * re-evaluated the VOs already sitting in "Bestellen" against those new values.
 *
 * Surfaces, both read-only and both verified live on staging:
 *  - `GET /practices` — carries #3298's three new fields: `leadTimeDays`, `leadTimeSource`
 *    (`standard` | `individual`) and `leadTimeClamped`.
 *  - `GET /prescriptions?prescriptionId={number}` — the VO's `followupStatus` and `orderingStatus`.
 *    **`followupStatus` is omitted from the payload entirely when it is not set**, so a VO reset out
 *    of "Bestellen" reads as `undefined`, not `null` or `''`. `orderingStatus` stays `By Admin` /
 *    `By Therapist` and is what marks a VO the team has already acted on.
 *
 * Note the lead time is a *rolling* measure. It is not a stable fixture: a practice measured at 25
 * days can be back on the 21-day Standard weeks later simply because its 4-week window emptied.
 */

/** The value every practice falls back to without enough recent order history (#3298 AC4). */
export const STANDARD_LEAD_TIME = 21;

/** #3298's clamp — an Individual value never leaves this range. */
export const LEAD_TIME_MIN = 10;
export const LEAD_TIME_MAX = 30;

/** The status value that means "ready to order" — the German UI reads "Bestellen". */
export const ORDER_STATUS = 'order';

/** ISO weekday numbers the Wednesday pull-forward (#3299) moves a trigger off. */
export const PULLED_FORWARD_DAYS = [4, 5, 6, 7];
export const WEDNESDAY_ISO_DAY = 3;
export const MAX_PULL_FORWARD_DAYS = 4;

/**
 * Meta keys #3299 stamps on a `follow_up_status_change` entry it pulled forward, per the fix
 * commit's own reference: `wednesday_pull_forward` (bool), `pull_forward_days`, `regular_ready_date`.
 */
export const PULL_FORWARD_META = 'wednesday_pull_forward';

/**
 * When #3299 shipped — fix commit `198470991`, merged 2026-08-12T01:51:14Z.
 *
 * Anything logged before this predates the rule, so the weekday table cannot be asserted against it.
 * Staging's entire automatic ordering history sits in January–February 2026, i.e. **all of it is
 * pre-fix** — scoping to this instant is what stops that history reading as 255 AC1 violations.
 */
export const PULL_FORWARD_SHIPPED_AT = new Date('2026-08-12T01:51:14Z');

export type FollowUpChange = {
  id: number;
  prescription: string;
  createdAt: Date;
  oldValue: string | null;
  newValue: string | null;
  /** `{type: 'manual'}` on a human-driven change; the pull-forward adds its own keys. */
  meta: Record<string, any>;
  createdBy: string | null;
};

export type PracticeLeadTime = {
  id: number;
  name: string;
  leadTimeDays: number | null;
  leadTimeSource: string | null;
  leadTimeClamped: boolean | null;
};

export type VoOrdering = {
  id: number;
  number: string;
  /** `'order'` while the VO sits in "Bestellen"; **absent** once it has been reset out. */
  followupStatus: string | null;
  orderingStatus: string | null;
  blankoVO: boolean;
  treatmentStatus: string;
  practiceId: number | null;
};

export class OrderingLeadTimePage {
  static readonly API = 'https://api.staging.therapios.de';

  private token: string | null = null;

  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(6000);
    this.token = await this.page.evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '');
        return state.token || state.accessToken || state.access_token || null;
      } catch {
        return null;
      }
    });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${OrderingLeadTimePage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  /** A VO's ordering state. `followupStatus` comes back `null` here when the payload omits it. */
  async voByNumber(number: string): Promise<VoOrdering | null> {
    const body = await this.json(`/prescriptions?page=1&itemsPerPage=10&prescriptionId=${encodeURIComponent(number)}`);
    const row = (body.member ?? []).find((m: any) => m.prescriptionId === number);
    if (!row) return null;
    return {
      id: row.id,
      number: row.prescriptionId,
      followupStatus: row.followupStatus ?? null,
      orderingStatus: row.orderingStatus ?? null,
      blankoVO: row.blankoVO === true,
      treatmentStatus: row.treatmentStatus,
      practiceId: row.practice?.id ?? null,
    };
  }


  // ─────────────────── follow-up status history (#3299) ──────────────────────

  /**
   * `GET /prescription_logs?type=follow_up_status_change` — the audit trail a VO's move into
   * "Bestellen" writes, and the only place #3299's pull-forward marker can be observed.
   *
   * Two hard constraints found live:
   *  - The collection holds 851k rows and **must** be queried with the `type` filter. Paging the
   *    unfiltered collection answers **504** from page 2 onward.
   *  - Its only filters are `type`, `prescription` and `order[createdAt]`; there is no date filter,
   *    so a window is reached by paging `order[createdAt]=desc` and stopping on date.
   */
  async followUpStatusChanges(maxPages = 20, perPage = 200): Promise<FollowUpChange[]> {
    const rows: FollowUpChange[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.json(
        `/prescription_logs?page=${page}&itemsPerPage=${perPage}` +
          `&type=follow_up_status_change&order%5BcreatedAt%5D=desc`,
      );
      const member = body.member ?? [];
      for (const row of member) {
        rows.push({
          id: row.id,
          prescription: row.prescription,
          createdAt: new Date(row.createdAt),
          oldValue: row.oldValue ?? null,
          newValue: row.newValue ?? null,
          meta: row.meta && !Array.isArray(row.meta) ? row.meta : {},
          createdBy: row.createdBy?.fullName ?? null,
        });
      }
      if (member.length < perPage) break;
    }
    return rows;
  }

  /** How many VOs sit in "Bestellen" right now. */
  async orderPopulation(): Promise<number> {
    const body = await this.json('/prescriptions?page=1&itemsPerPage=1&followupStatus=order');
    return body.totalItems ?? 0;
  }

  /** ISO weekday (Mon=1 … Sun=7) in UTC, which is how the nightly job's 20:15 UTC run is stamped. */
  static isoWeekday(date: Date): number {
    return date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  }

  /** A change the nightly job made rather than a person — the only population #3299 governs. */
  static isAutomatic(change: FollowUpChange): boolean {
    return change.meta.type !== 'manual';
  }

  async practice(id: number): Promise<PracticeLeadTime> {
    const row = await this.json(`/practices/${id}`);
    return {
      id: row.id,
      name: row.name,
      leadTimeDays: row.leadTimeDays ?? null,
      leadTimeSource: row.leadTimeSource ?? null,
      leadTimeClamped: row.leadTimeClamped ?? null,
    };
  }

  /** Every practice's lead time — 1,459 rows on staging, ~15 pages. */
  async allPracticeLeadTimes(): Promise<PracticeLeadTime[]> {
    const rows: PracticeLeadTime[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.json(`/practices?page=${page}&itemsPerPage=100`);
      const member = body.member ?? [];
      for (const row of member) {
        rows.push({
          id: row.id,
          name: row.name,
          leadTimeDays: row.leadTimeDays ?? null,
          leadTimeSource: row.leadTimeSource ?? null,
          leadTimeClamped: row.leadTimeClamped ?? null,
        });
      }
      if (member.length < 100) break;
    }
    return rows;
  }
}
