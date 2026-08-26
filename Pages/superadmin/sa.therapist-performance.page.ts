import { Page } from '@playwright/test';
import { AppPage } from '../base/app.page';

export type PerfRow = {
  id: number;
  fullName: string;
  performanceStatus: 'unassigned' | 'needs_attention' | 'monitor' | 'on_track' | string;
  efficiencyPercent?: number;
  qualifyingDays: number;
  windowStart?: string;
  windowEnd?: string;
};

export type BucketRow = {
  therapistId: number;
  bucket: 'grau' | 'rot' | 'gelb' | 'gruen' | string;
  active: boolean;
};

/**
 * The efficiency traffic light and the window it is calculated over (RC 3.11.2, #3486).
 *
 * Surface notes, all verified live on staging:
 *  - **The traffic light's own data is an API resource**, `GET /therapist-performance`, so the day
 *    count the tooltip renders does not have to be hovered for: each row carries
 *    `qualifyingDays`, `windowStart`, `windowEnd`, `efficiencyPercent` and `performanceStatus`.
 *    TO Management → Auslastung fetches it twice (a paged read for the table and one
 *    `itemsPerPage=10000` read that the header counts and the Therapeuten-Gesundheit filter work
 *    off client-side — which is why that filter needs no API parameter).
 *  - **The Therapeuten-Orga board's groupings are `GET /kpis/management/efficiency-buckets`**
 *    (note the `/management` segment — bare `/kpis/efficiency-buckets` 404s). Rows are
 *    `{therapistId, bucket, active}` with German bucket names.
 *  - **The two collections are not the same population.** The buckets endpoint returns 236 rows
 *    including inactive therapists; `/therapist-performance` returns the 163 on the TO Management
 *    screen. AC5 is therefore asserted over the INTERSECTION, keyed by therapist id.
 *  - **`efficiencyPercent` is omitted, not zeroed,** when there are no qualifying days — so a
 *    "no data" therapist reads `undefined`, never `0`.
 *
 * Status ↔ colour mapping, confirmed 1:1 live across 161 therapists:
 *   `needs_attention` = rot, `monitor` = gelb, `on_track` = gruen, `unassigned` = grau.
 */
export class TherapistPerformancePage extends AppPage {
  static readonly API = 'https://api.staging.therapios.de';

  /** The cap #3486 restores: at most this many qualifying days feed the traffic light. */
  static readonly MAX_WINDOW_DAYS = 5;

  /** Thresholds #3486 explicitly does NOT change (AC6). */
  static readonly THRESHOLDS = { green: 85, yellowLow: 70 } as const;

  /** The bucket name each performance status must map to (AC5). */
  static readonly STATUS_TO_BUCKET: Record<string, string> = {
    needs_attention: 'rot',
    monitor: 'gelb',
    on_track: 'gruen',
    unassigned: 'grau',
  };

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(6_000);
  }

  private async json(path: string): Promise<{ status: number; json: any }> {
    return await this.page.evaluate(
      async ([base, p]: [string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* the caller asserts on the status */
        }
        const r = await fetch(`${base}${p}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        });
        const t = await r.text();
        try {
          return { status: r.status, json: JSON.parse(t) };
        } catch {
          return { status: r.status, json: t.slice(0, 300) };
        }
      },
      [TherapistPerformancePage.API, path],
    );
  }

  /** Every therapist row behind TO Management → Auslastung. */
  async performanceRows(): Promise<PerfRow[]> {
    const res = await this.json('/therapist-performance?page=1&itemsPerPage=10000');
    if (res.status !== 200) throw new Error(`GET /therapist-performance -> ${res.status}`);
    return res.json.member ?? res.json['hydra:member'] ?? [];
  }

  /** The Therapeuten-Orga board's efficiency groupings. */
  async efficiencyBuckets(): Promise<BucketRow[]> {
    const res = await this.json('/kpis/management/efficiency-buckets');
    if (res.status !== 200) throw new Error(`GET /kpis/management/efficiency-buckets -> ${res.status}`);
    return res.json.member ?? res.json['hydra:member'] ?? [];
  }

  /** The four Auslastung header counts, read off the rendered screen. */
  async healthCounts(): Promise<Record<string, number | null>> {
    await this.page.goto('/to-management', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(15_000);
    const t = await this.page.locator('#root').innerText();
    const out: Record<string, number | null> = {};
    for (const label of ['Red Therapists', 'Yellow Therapists', 'Green Therapists', 'Gray Therapists']) {
      const m = t.match(new RegExp(`${label}\\s*\\n\\s*(\\d+)`));
      out[label] = m ? Number(m[1]) : null;
    }
    return out;
  }

  /** Inclusive calendar span of a row's window, in days; null when it has no window. */
  static windowSpanDays(r: PerfRow): number | null {
    if (!r.windowStart || !r.windowEnd) return null;
    return (Date.parse(r.windowEnd) - Date.parse(r.windowStart)) / 86_400_000 + 1;
  }

  /** The traffic-light colour a percentage should produce under the unchanged thresholds. */
  static expectedStatus(percent: number): 'on_track' | 'monitor' | 'needs_attention' {
    if (percent > TherapistPerformancePage.THRESHOLDS.green) return 'on_track';
    if (percent >= TherapistPerformancePage.THRESHOLDS.yellowLow) return 'monitor';
    return 'needs_attention';
  }
}
