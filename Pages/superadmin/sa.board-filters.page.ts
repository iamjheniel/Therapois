import { Page, expect } from '@playwright/test';
import { createHash } from 'crypto';

/**
 * The board providers' shared filter parsing — RC 3.11 #3311 (`ManagementFilterResolver`).
 *
 * #3311 is a pure refactor: `resolveInsuranceTypes()` and the surrounding `from`/`to`/`timezone`/
 * `entity`/`therapist`/`team`/`patientType`/`location` parse block existed as **nine verbatim
 * copies**, one per board provider, and were consolidated into one shared service. The hard
 * constraint is zero behaviour change; the risk the ticket exists to remove is *copy-drift* — two
 * boards quietly disagreeing about what "Privat" means.
 *
 * AC1 and AC3 are source-level (no private helper survives; cache keys byte-identical) and AC2 is
 * the backend integration suite — none of that is reachable from a browser. What IS reachable, and
 * is the externally observable form of the same property, is that **all nine providers answer the
 * same filter the same way**. That is what this page object measures.
 *
 * The nine provider endpoints, captured live off `/flow-boards` (every one a GET — this whole
 * surface is read-only):
 *
 * | Provider (AC1)                    | Endpoint                              |
 * |-----------------------------------|---------------------------------------|
 * | `ManagementKpiProvider`            | `/kpis/management`                    |
 * | `ManagementTherapistProvider`      | `/kpis/management/therapists`         |
 * | `ManagementTeamProvider`           | `/kpis/management/teams`              |
 * | `ManagementTrendProvider`          | `/kpis/management/trend`              |
 * | `ManagementBillingBacklogProvider` | `/kpis/management/billing-backlog`    |
 * | `OrgaBoardRisksProvider`           | `/kpis/orga/risks`                    |
 * | `WorkingHoursRowProvider`          | `/kpis/management/working-hours`      |
 * | `EfficiencyBucketRowProvider`      | `/kpis/management/efficiency-buckets` |
 * | `OrgaTrendProvider`                | `/kpis/management/orga-trend`         |
 *
 * Filter values, as the board's own UI sends them: `patientType=gkv|pkv` (the control reads
 * "Alle Patienten / GKV / PKV" and sends **nothing** for "Alle"), `location=einrichtung|praxis`
 * ("Alle Orte" sends nothing). The resolver's documented passthrough — absent / `''` / `'all'` all
 * mean "no insurance filter" — is not reachable from the UI at all, so it is exercised here by
 * calling the endpoints directly.
 *
 * **Comparing two responses.** Raw bodies never match, for two reasons that have nothing to do with
 * filtering: every `member[]` entry carries a randomly generated `@id`
 * (`/.well-known/genid/<hex>`), and the JSON-LD `view` block echoes the request's own query string
 * back (and is omitted entirely when there is no query string at all). `canonical()` strips both, so
 * a difference that survives it is a real difference in the data.
 */

export type ProviderKey =
  | 'managementKpi'
  | 'therapists'
  | 'teams'
  | 'trend'
  | 'billingBacklog'
  | 'orgaRisks'
  | 'workingHours'
  | 'efficiencyBuckets'
  | 'orgaTrend';

export type ProviderSpec = {
  /** The PHP provider class named in AC1. */
  provider: string;
  path: string;
  /** Query string the board itself sends, minus the filters under test. */
  baseQuery: string;
};

/** The period the board opens on is "this week"; these tests pin one week so runs are comparable. */
export const PERIOD_FROM = '2026-08-17';
export const PERIOD_TO = '2026-08-23';

const PERIOD = `from=${PERIOD_FROM}&to=${PERIOD_TO}`;
const TREND = `level=woche&to=${PERIOD_TO}`;

export const PROVIDERS: Record<ProviderKey, ProviderSpec> = {
  managementKpi: { provider: 'ManagementKpiProvider', path: '/kpis/management', baseQuery: `pagination=false&${PERIOD}` },
  therapists: { provider: 'ManagementTherapistProvider', path: '/kpis/management/therapists', baseQuery: `pagination=false&${PERIOD}` },
  teams: { provider: 'ManagementTeamProvider', path: '/kpis/management/teams', baseQuery: `pagination=false&${PERIOD}` },
  trend: { provider: 'ManagementTrendProvider', path: '/kpis/management/trend', baseQuery: `pagination=false&${TREND}` },
  billingBacklog: { provider: 'ManagementBillingBacklogProvider', path: '/kpis/management/billing-backlog', baseQuery: `pagination=false&${PERIOD}` },
  orgaRisks: { provider: 'OrgaBoardRisksProvider', path: '/kpis/orga/risks', baseQuery: `pagination=false&${PERIOD}` },
  workingHours: { provider: 'WorkingHoursRowProvider', path: '/kpis/management/working-hours', baseQuery: `pagination=false&${PERIOD}` },
  efficiencyBuckets: { provider: 'EfficiencyBucketRowProvider', path: '/kpis/management/efficiency-buckets', baseQuery: 'pagination=false' },
  orgaTrend: { provider: 'OrgaTrendProvider', path: '/kpis/management/orga-trend', baseQuery: `pagination=false&${TREND}` },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

/**
 * The four providers that report the same quantity — treated revenue for the filtered period — by
 * four independent routes. They must agree under every filter; disagreement is exactly the
 * copy-drift #3311 removes.
 */
export const REVENUE_PROVIDERS: ProviderKey[] = ['managementKpi', 'therapists', 'teams', 'workingHours'];

/** The insurance filter, including the two forms only reachable by calling the API directly. */
export const PATIENT_TYPE_PASSTHROUGH = [
  { label: 'absent', query: '' },
  { label: 'empty', query: '&patientType=' },
  { label: 'all', query: '&patientType=all' },
  { label: 'unknown value', query: '&patientType=zzz-not-a-type' },
];

export const LOCATION_PASSTHROUGH = [
  { label: 'absent', query: '' },
  { label: 'empty', query: '&location=' },
  { label: 'all', query: '&location=all' },
  { label: 'unknown value', query: '&location=zzz-not-a-place' },
];

export type Fetched = { status: number; ms: number; bytes: number; canonical: string; digest: string; body: any };

export class BoardFiltersPage {
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
    expect(this.token, 'the session must carry a bearer token for the KPI API').toBeTruthy();
  }

  /**
   * A response reduced to the part a filter can actually change: the item count and the members,
   * with the per-response random `@id`s removed. The JSON-LD `view` envelope is dropped because it
   * only echoes the request URL — it differs between two identical result sets purely because their
   * query strings differ, and is absent altogether when no query string is sent.
   */
  static canonical(body: any): string {
    const strip = (value: any): any => {
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          if (k === '@id') continue;
          out[k] = strip(v);
        }
        return out;
      }
      return value;
    };
    return JSON.stringify({ totalItems: body?.totalItems ?? null, member: strip(body?.member ?? []) });
  }

  /**
   * One GET. Nothing on this surface writes.
   *
   * A 5xx is retried ONCE. These providers are genuinely slow — `/kpis/orga/risks` measures ~11.6s
   * served on its own — and under the parallel suite the gateway times them out with a 504 that has
   * nothing to do with the resolver this spec is checking. (Verified: every provider that 504'd in a
   * full-suite run answered 200 when called by itself.) A second consecutive 5xx is reported as-is,
   * so a genuinely broken provider still fails.
   */
  async fetch(key: ProviderKey, filter = ''): Promise<Fetched> {
    const spec = PROVIDERS[key];
    const url = `${BoardFiltersPage.API}${spec.path}?${spec.baseQuery}${filter}`;
    const started = Date.now();
    let res = await this.page.request.get(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (res.status() >= 500) {
      // eslint-disable-next-line no-console
      console.log(`${spec.path}${filter} answered ${res.status()} — retrying once`);
      await this.page.waitForTimeout(5_000);
      res = await this.page.request.get(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout: 180_000,
      });
    }
    const text = await res.text();
    const ms = Date.now() - started;
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* an error body is reported through `status`, not parsed */
    }
    const canonical = res.status() === 200 ? BoardFiltersPage.canonical(body) : text.slice(0, 300);
    return {
      status: res.status(),
      ms,
      bytes: text.length,
      canonical,
      digest: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
      body,
    };
  }

  /**
   * Treated revenue for the filtered period, however this provider happens to expose it — one
   * number that four providers must agree on.
   */
  static revenue(key: ProviderKey, body: any): number | null {
    const member: any[] = body?.member ?? [];
    switch (key) {
      case 'managementKpi':
        return member[0]?.treatedRevenue ?? null;
      case 'therapists':
      case 'teams':
      case 'workingHours':
        return Number(member.reduce((sum, row) => sum + (row.revenue ?? 0), 0).toFixed(2));
      default:
        return null;
    }
  }
}
