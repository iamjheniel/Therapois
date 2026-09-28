import { APIRequestContext, expect } from '@playwright/test';

/**
 * Personio therapist absences across the three boards (RC 3.12 epic #3394).
 *
 * The epic has no ACs of its own — it has SHARED RULES that its three sub-tickets must all obey
 * (#3395 sync + T Board Kalender, #3396 Therapeuten-Orga, #3397 Management), and a sequencing rule:
 * "E2 owns the [absence-rate] definition, E3 matches it". All three shipped in `d10e8f075`, so what
 * is worth testing at the epic level is the rules that cut ACROSS them — which is what no
 * sub-ticket's own ACs cover.
 *
 * | shared rule | where it is decidable |
 * |---|---|
 * | backfill from 2026-01-01, horizon +12 months | `GET /absence-days` date range |
 * | three buckets: Krank / Urlaub / Sonstige | `absenceType.bucket` |
 * | half-day counts 0.5 | `dayPortion` — **no live instance, every row is FULL** |
 * | Fehlquote = (Krank + Urlaub) ÷ Soll, Sonstige excluded | the quotas, three surfaces |
 * | E2 and E3 use the SAME formula | Orga trend vs Management card vs working-hours table |
 * | approved only, pending never counted | not decidable — Personio is the source |
 *
 * **The route is `/absence-days`, not `/absence_days`** — the entity declares an explicit
 * `uriTemplate`, so the snake_case form every other collection uses answers 404 here. The
 * collection filters only by `user`; there is no date filter, so a window has to be walked.
 *
 * **The quota is reconstructible, which is what makes the parity check meaningful.**
 * `/kpis/management/working-hours` carries `krankMinutes`, `urlaubMinutes`,
 * `sonstigeAbwesenheitMinutes` and `sollMinutes` per therapist, so the board's ratio can be
 * recomputed from the minutes rather than compared against itself.
 */

export const API = 'https://api.staging.therapios.de';

export type AbsenceDay = { date: string; typeName: string; bucket: string; portion: string };
export type AbsenceQuotas = {
  krankenquote: number | null;
  urlaubsquote: number | null;
  fehlquote: number | null;
  sonstigeAbwesenheitMinutes: number | null;
};
export type WorkingHoursRow = {
  therapistId: number;
  krankMinutes: number;
  urlaubMinutes: number;
  sonstigeAbwesenheitMinutes: number;
  sollMinutes: number;
};

export class AbsencesPage {
  static readonly API = API;
  /** The only buckets the epic defines. */
  static readonly BUCKETS = ['KRANK', 'URLAUB', 'SONSTIGE'];

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private async json(path: string, timeout = 300_000): Promise<any> {
    const response = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  /** Every synced absence day. ~9.5k rows on staging; the collection has no date filter. */
  async absenceDays(): Promise<AbsenceDay[]> {
    const rows: AbsenceDay[] = [];
    for (let page = 1; ; page++) {
      const body = await this.json(`/absence-days?page=${page}&itemsPerPage=300`);
      const members = AbsencesPage.members(body);
      if (!members.length) break;
      for (const row of members) {
        rows.push({
          date: String(row.date ?? '').slice(0, 10),
          typeName: row.absenceType?.name ?? '?',
          bucket: row.absenceType?.bucket ?? '?',
          portion: String(row.dayPortion ?? ''),
        });
      }
      if (members.length < 300) break;
    }
    return rows;
  }

  /** The Management board's absence tiles (E3). */
  async managementQuotas(from: string, to: string): Promise<AbsenceQuotas> {
    const body = await this.json(`/kpis/management?pagination=false&from=${from}&to=${to}`);
    const row = AbsencesPage.members(body)[0] ?? body;
    return {
      krankenquote: row.krankenquote ?? null,
      urlaubsquote: row.urlaubsquote ?? null,
      fehlquote: row.fehlquote ?? null,
      sonstigeAbwesenheitMinutes: row.sonstigeAbwesenheitMinutes ?? null,
    };
  }

  /**
   * The Therapeuten-Orga board's Verlauf series (E2), which carries `krankenquote` and `fehlquote`
   * per period. Note it always returns 12 TRAILING periods — unlike the Management trend it has no
   * `rangeFrom` tiling (see the finding in the spec), so the caller picks the bucket it wants.
   */
  async orgaTrend(level: 'tag' | 'woche' | 'monat', to: string): Promise<
    { periodStart: string; periodEnd: string; krankenquote: number | null; fehlquote: number | null }[]
  > {
    const body = await this.json(`/kpis/management/orga-trend?pagination=false&level=${level}&to=${to}`);
    return AbsencesPage.members(body).map((row: any) => ({
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      krankenquote: row.gesamt?.krankenquote ?? null,
      fehlquote: row.gesamt?.fehlquote ?? null,
    }));
  }

  /** Per-therapist absence and target minutes — the numbers the quotas are built from. */
  async workingHours(from: string, to: string): Promise<WorkingHoursRow[]> {
    const body = await this.json(`/kpis/management/working-hours?pagination=false&from=${from}&to=${to}`);
    return AbsencesPage.members(body).map((row: any) => ({
      therapistId: row.therapistId,
      krankMinutes: row.krankMinutes ?? 0,
      urlaubMinutes: row.urlaubMinutes ?? 0,
      sonstigeAbwesenheitMinutes: row.sonstigeAbwesenheitMinutes ?? 0,
      sollMinutes: row.sollMinutes ?? 0,
    }));
  }

  /** Raw HTTP, for the route-shape probe. */
  async status(path: string): Promise<number> {
    const response = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout: 120_000 });
    return response.status();
  }

  static sum(rows: WorkingHoursRow[], key: keyof WorkingHoursRow): number {
    return rows.reduce((total, row) => total + (row[key] as number), 0);
  }
}
