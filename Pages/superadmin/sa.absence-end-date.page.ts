import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Personio absence periods ending one day too late (RC 3.13 #3663).
 *
 * `AbsenceService::resolveDays()` treated Personio's `ends_at.date_time` as the last absent day.
 * It is an EXCLUSIVE boundary instant: a period ending at local midnight ends on the day BEFORE
 * that midnight. Every synced absence therefore carried one extra trailing day.
 *
 * **The bug has a measurable signature, and that signature is the test.** A Mon–Fri absence
 * wrongly extended to Saturday, so before the fix **690 of 1,856 periods ended on a Saturday while
 * only 5 started on one**. Nothing about real absence data produces that asymmetry — people do not
 * systematically end absences on Saturday without also starting them there. So the weekday
 * distribution of period boundaries is a permanent detector for this whole bug class, and it needs
 * no Personio access to evaluate.
 *
 * **A "period" here is a contiguous run of days for one user and one absence type**, rebuilt
 * client-side. That is NOT necessarily the sync's own notion of a period — two adjacent Personio
 * periods of the same type merge under this definition, and the counts will not match the command's
 * report exactly (this file measures 1,601 where Jarn's run reported 1,863). The distribution is
 * what carries the evidence, not the absolute count, and the tests assert shape rather than parity
 * with a figure produced elsewhere.
 *
 * **Fetching is the awkward part.** The route is **`/absence-days`** — kebab-case, because the
 * entity sets an explicit `uriTemplate`; the snake_case form every other collection uses answers
 * **404** and reads exactly like "not deployed" (#3394). The collection filters ONLY by `user` and
 * — critically — **the serialized row carries no user at all** (`date`, `absenceType`, `dayPortion`
 * and nothing else), so days cannot be attributed from one bulk read: the population must be swept
 * one user at a time.
 */

export type AbsenceDay = { date: string; type: string | null; bucket: string | null; portion: string | null };
export type Period = { userId: string; type: string | null; start: string; end: string; days: number };

/** The pre-fix staging figures the ticket records, kept so the comparison is explicit. */
export const PRE_FIX = { saturdayEnding: 690, totalPeriods: 1856, saturdayStarting: 5 };

/** `Mon…Sun`, indexed the way `Date.getUTCDay()` is not — see `weekday()`. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** The ticket's named staging example: a sick leave Mon 16 Mar – Fri 20 Mar, 5 days not 6. */
export const AC1_EXAMPLE = { start: '2026-03-16', expectedEnd: '2026-03-20', expectedDays: 5 };

export class AbsenceEndDatePage {
  private token: string | null = null;

  constructor(private request: APIRequestContext, token?: string) {
    this.token = token ?? null;
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.token = (await res.json()).token;
    return this.token!;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.bearer();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120_000,
      });
      if (res.ok()) return (await res.json()) as T;
      if (res.status() === 401) this.token = null;
      if (attempt === 2) throw new Error(`GET ${path} -> ${res.status()}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error('unreachable');
  }

  /** Mon=0 … Sun=6, from a plain `YYYY-MM-DD` read as UTC so no local timezone can shift it. */
  weekday(iso: string): number {
    return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  }

  async userIds(): Promise<number[]> {
    const body = await this.get<{ member: { id: number }[] }>('/users?itemsPerPage=500');
    return body.member.map((u) => u.id);
  }

  /** Total rows, for a cheap sanity check before the per-user sweep. */
  async totalAbsenceDays(): Promise<number> {
    const body = await this.get<{ totalItems: number }>('/absence-days?itemsPerPage=1');
    return body.totalItems;
  }

  /** Every absence day for one user. Throws on a truncated page rather than under-counting. */
  async daysFor(userId: number): Promise<AbsenceDay[]> {
    const body = await this.get<{ member: Record<string, any>[]; totalItems: number }>(
      `/absence-days?user=${userId}&itemsPerPage=1000`,
    );
    if ((body.totalItems ?? 0) > body.member.length) {
      throw new Error(`absence-days truncated for user ${userId}: ${body.totalItems} > ${body.member.length}`);
    }
    return body.member.map((m) => ({
      date: m.date,
      type: m.absenceType?.name ?? null,
      bucket: m.absenceType?.bucket ?? null,
      portion: m.dayPortion ?? null,
    }));
  }

  /** The whole population, keyed by user — the sweep the missing `user` field forces. */
  async sweep(userIds: number[]): Promise<Map<string, AbsenceDay[]>> {
    const out = new Map<string, AbsenceDay[]>();
    for (const id of userIds) {
      const days = await this.daysFor(id);
      if (days.length) out.set(String(id), days);
    }
    return out;
  }

  /** Contiguous runs per user + absence type. See the class docblock on what this does NOT mean. */
  toPeriods(byUser: Map<string, AbsenceDay[]>): Period[] {
    const periods: Period[] = [];
    for (const [userId, rows] of byUser) {
      const byType = new Map<string, AbsenceDay[]>();
      for (const r of rows) {
        const key = r.type ?? '<none>';
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(r);
      }
      for (const [type, list] of byType) {
        list.sort((a, b) => a.date.localeCompare(b.date));
        let run: AbsenceDay[] = [list[0]];
        for (let i = 1; i < list.length; i++) {
          const prev = Date.parse(`${list[i - 1].date}T00:00:00Z`);
          const cur = Date.parse(`${list[i].date}T00:00:00Z`);
          if (cur - prev === 86_400_000) run.push(list[i]);
          else {
            periods.push({ userId, type, start: run[0].date, end: run.at(-1)!.date, days: run.length });
            run = [list[i]];
          }
        }
        periods.push({ userId, type, start: run[0].date, end: run.at(-1)!.date, days: run.length });
      }
    }
    return periods;
  }

  /** Weekday histogram of period first days and last days — where the bug is visible. */
  boundaryHistogram(periods: Period[]): { start: number[]; end: number[] } {
    const start = new Array(7).fill(0);
    const end = new Array(7).fill(0);
    for (const p of periods) {
      start[this.weekday(p.start)]++;
      end[this.weekday(p.end)]++;
    }
    return { start, end };
  }

  /** Periods whose last day is a Saturday — a signal to inspect, never a verdict. See below. */
  saturdayEnding(periods: Period[]): Period[] {
    return periods.filter((p) => this.weekday(p.end) === 5);
  }

  /**
   * Treated activity by one therapist on one calendar day.
   *
   * This is the ticket's OWN criterion for a wrongly-marked day — its third production example is
   * "marks Wednesday 2 Sep absent even though the therapist documented a full day of treatments on
   * the Wednesday". It is the only per-period evidence obtainable without Personio.
   *
   * **Trap:** `?date=` is NOT a registered filter on `/activities` — it is accepted and IGNORED, so
   * the query silently returns that therapist's ENTIRE history and every day looks busy. Only the
   * range forms are registered, and `date[before]` excludes the boundary day, so a single day is
   * `date[after]=D & date[strictly_before]=D+1`.
   */
  async activitiesOn(therapistId: string, isoDay: string): Promise<number> {
    const next = new Date(Date.parse(`${isoDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const body = await this.get<{ totalItems: number }>(
      `/activities?therapist=${therapistId}&date%5Bafter%5D=${isoDay}&date%5Bstrictly_before%5D=${next}&itemsPerPage=1`,
    );
    return body.totalItems ?? 0;
  }
}
