import { APIRequestContext } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The ordering-round pull-forward's run day — RC 3.14 #3719, commit `c5adde88f` (PR #3720).
 *
 * #3299 pulled a VO whose projected reorder day fell Thursday–Sunday forward onto the **Wednesday**
 * run. The daily job runs at 20:15 UTC (22:15 Berlin), so the flip landed hours AFTER the Wednesday
 * ordering round it was meant to join and the team ordered the VO the following Wednesday anyway —
 * identical to having no pull-forward at all. #3719 moves the evaluation to **Tuesday** and widens
 * the window by one day with the base.
 *
 * ```php
 * // before: WEDNESDAY_ISO_DAY = 3, WEDNESDAY_PULL_FORWARD_MAX_DAYS = 4   → Thu..Sun
 * // after:  PULL_FORWARD_RUN_ISO_DAY = 2, PULL_FORWARD_MAX_DAYS = 5      → Wed..Sun
 * ```
 *
 * ## Option B, so nothing about the schedule changed
 *
 * `TransitionOrderTaskScheduleRule` is still `cron(15 20 * * ? *)` — daily, 20:15 UTC — and the
 * chain around it is untouched (`RecalculateOrderingMetrics` 19:15, `TrackingTransition` 21:00).
 * The whole ticket is two constants, which is why `runsOnBerlinTuesdayEvening()` below is worth
 * asserting: 20:15 UTC is 22:15 Berlin in summer and 21:15 in winter, and **both are still
 * Tuesday** — a later cron would roll the Berlin date into Wednesday and undo the ticket.
 *
 * ## What is and is not decidable from a client
 *
 * The two constants are serialized nowhere and the rule runs only inside a console command, so
 * **deployment is not client-decidable for this ticket** — `/status` reports the release, not the
 * commit (#3704). What IS decidable is the arithmetic: the change is entirely about WHICH target
 * weekdays qualify, and that is a pure function of the run day and the day-count cap. Both rules
 * are ported here and compared as sets, which is exactly AC2 (Wednesday gained), AC3 (Mon/Tue never)
 * and AC4 (nothing lost).
 *
 * **The threshold half is untouched**, and saying so matters: `remaining <= ((lead + k) / 7) × freq`
 * is #3298's inequality in both versions, so a VO's projected trigger day does not move — only
 * which of those days get pulled forward.
 *
 * ## Traps
 *
 *  - **The log marker is still `wednesday_pull_forward`** and the German reason still reads
 *    "Mittwochs-Vorzug", even though the run moved to Tuesday. Good for log continuity, confusing
 *    for a reader: a QA verifying "it now runs Tuesday" by looking for a Tuesday-named marker finds
 *    nothing. `MARKER` below is the key that is actually written.
 *  - **`decisionFrequencyPerWeek` is not served.** The VO exposes `actualFrequency`, but the rule
 *    reads the DECISION frequency, which `ActualFrequencyCalculator` may average differently. Any
 *    population estimate built from the served field is an approximation and is reported as one.
 *  - **The floor is compared against TODAY, not against the target day.** `issueDate > today` →
 *    no pull-forward. That is the correct reading of AC5 (the flip happens today, so today is what
 *    must not precede the issue date), but a port written against "the target day" would differ.
 */

/** `TransitionToOrderService` — the two constants this ticket changes. */
export const RULE = {
  /** #3719 — ISO weekday the pull-forward is evaluated on. 2 = Tuesday. */
  runIsoDay: 2,
  /** #3719 — how many days ahead the projected trigger may fall. */
  maxDays: 5,
} as const;

/** #3299's rule, kept so the two can be compared as sets. 3 = Wednesday. */
export const RULE_BEFORE = { runIsoDay: 3, maxDays: 4 } as const;

/** The daily job's schedule — unchanged by this ticket (Option B). */
export const SCHEDULE = { cron: 'cron(15 20 * * ? *)', utcHour: 20, utcMinute: 15 } as const;

/** The meta key the flip stamps. Still Wednesday-named after the move to Tuesday — see the docblock. */
export const MARKER = 'wednesday_pull_forward';

export const ISO_DAY_NAME: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export type PullForwardRule = { runIsoDay: number; maxDays: number };

export type OrderLogRow = { at: string; from: string | null; to: string | null; automatic: boolean; marker: boolean };

export class OrderingPullForwardPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
      timeout: 240_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  // ─────────────────────────── the ported rule ───────────────────────────

  /** ISO weekday (1 = Monday … 7 = Sunday), the same value PHP's `format('N')` gives. */
  static isoDay(date: Date): number {
    const js = date.getUTCDay(); // 0 = Sunday
    return js === 0 ? 7 : js;
  }

  /** The weekday a run on `runIsoDay` reaches by looking `k` days ahead. */
  static targetIsoDay(runIsoDay: number, k: number): number {
    return ((runIsoDay - 1 + k) % 7) + 1;
  }

  /**
   * Every weekday a rule's pull-forward can reach — the set AC2/AC3/AC4 are about.
   *
   * The whole behaviour change is this set widening by exactly one day, so comparing the two sets
   * is a more direct statement of the ACs than any single example VO could be.
   */
  static targetIsoDays(rule: PullForwardRule): number[] {
    return Array.from({ length: rule.maxDays }, (_, i) =>
      OrderingPullForwardPage.targetIsoDay(rule.runIsoDay, i + 1),
    );
  }

  static targetDayNames(rule: PullForwardRule): string[] {
    return OrderingPullForwardPage.targetIsoDays(rule).map((d) => ISO_DAY_NAME[d]);
  }

  /**
   * A faithful port of `orderingRoundPullForwardDays()` — the k it returns, or null.
   *
   * Three gates in the shipped order: the run day, the issue-date floor (compared against TODAY,
   * not the target), then the smallest k in 1..maxDays satisfying #3298's widened inequality.
   */
  static pullForwardDays(
    input: {
      today: Date;
      issueDate?: Date | null;
      remainingTreatments: number;
      decisionFrequencyPerWeek: number;
      leadTimeDays: number;
    },
    rule: PullForwardRule = RULE,
  ): number | null {
    if (OrderingPullForwardPage.isoDay(input.today) !== rule.runIsoDay) return null;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (input.issueDate && day(input.issueDate) > day(input.today)) return null;
    for (let k = 1; k <= rule.maxDays; k++) {
      if (input.remainingTreatments <= ((input.leadTimeDays + k) / 7) * input.decisionFrequencyPerWeek) return k;
    }
    return null;
  }

  /** #3298's own rule, which this ticket does not touch — the "would it flip anyway today?" test. */
  static wouldTransitionToday(remainingTreatments: number, decisionFrequencyPerWeek: number, leadTimeDays: number): boolean {
    return remainingTreatments <= (leadTimeDays / 7) * decisionFrequencyPerWeek;
  }

  /**
   * The Berlin wall-clock the 20:15 UTC run lands on, and the weekday it lands on there.
   *
   * AC1 is a claim about Berlin business hours, so the offset matters: CEST is UTC+2 and CET UTC+1,
   * and the flip must stay on the Tuesday EVENING under both — a later cron would roll the Berlin
   * date into Wednesday and put the flip back after the round.
   */
  static runsOnBerlinTuesdayEvening(utcOffsetHours: 1 | 2): { berlinHour: number; berlinIsoDay: number } {
    const berlinHour = SCHEDULE.utcHour + utcOffsetHours;
    // The run day is Tuesday; only an hour rolling past 24 would move the date.
    const berlinIsoDay = berlinHour >= 24 ? (RULE.runIsoDay % 7) + 1 : RULE.runIsoDay;
    return { berlinHour: berlinHour % 24, berlinIsoDay };
  }

  /** The next calendar date on which the rule would fire, from a given day. */
  static nextRunDate(from: Date, rule: PullForwardRule = RULE): Date {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    for (let i = 0; i < 8; i++) {
      if (OrderingPullForwardPage.isoDay(d) === rule.runIsoDay && i > 0) return d;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    throw new Error('#3719: no run day within a week');
  }

  // ─────────────────────────── live reads ───────────────────────────

  /**
   * Recent follow-up status changes, scanned for moves INTO `order` and for the pull-forward marker.
   *
   * The collection MUST carry its `type` filter — the unfiltered one is 851k rows and 504s from
   * page 2 (#3299). Even filtered it is ~38k rows, so the scan is bounded and reports its depth.
   */
  async orderTransitions(pages = 15, perPage = 200): Promise<{
    scanned: number;
    intoOrder: OrderLogRow[];
    marked: OrderLogRow[];
    newestRow: string | null;
  }> {
    const intoOrder: OrderLogRow[] = [];
    const marked: OrderLogRow[] = [];
    let scanned = 0;
    let newestRow: string | null = null;

    for (let page = 1; page <= pages; page++) {
      const body = await this.get<{ member: Record<string, any>[] }>(
        `/prescription_logs?type=follow_up_status_change&itemsPerPage=${perPage}&page=${page}&order%5BcreatedAt%5D=desc`,
      );
      const rows = body.member ?? [];
      if (rows.length === 0) break;
      scanned += rows.length;
      for (const r of rows) {
        const meta = r.meta ?? {};
        const row: OrderLogRow = {
          at: r.createdAt ?? '',
          from: r.oldValue ?? null,
          to: r.newValue ?? null,
          automatic: meta.type === 'automatic',
          marker: MARKER in meta,
        };
        newestRow ??= row.at;
        if (row.to === 'order') intoOrder.push(row);
        if (row.marker) marked.push(row);
      }
      if (rows.length < perPage) break;
    }
    return { scanned, intoOrder, marked, newestRow };
  }

  /** Per-practice lead times — the `leadTimeDays` the rule's inequality reads (#3298). */
  async leadTimes(limit = 200): Promise<{ standard: number; individual: number; distinct: number[] }> {
    const body = await this.get<{ member: Record<string, any>[] }>(`/practices?itemsPerPage=${limit}`);
    const rows = body.member ?? [];
    const days = new Set<number>();
    let standard = 0;
    let individual = 0;
    for (const p of rows) {
      if (typeof p.leadTimeDays === 'number') days.add(p.leadTimeDays);
      if (p.leadTimeSource === 'individual') individual++;
      else standard++;
    }
    return { standard, individual, distinct: [...days].sort((a, b) => a - b) };
  }
}
