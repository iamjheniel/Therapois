import { type Page, type APIRequestContext, request as pwRequest, expect } from '@playwright/test';
import { type Credentials, mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

export const PROD_API = 'https://api.app.therapios.de';
export const PROD_WEB = 'https://app.therapios.de';

export type RiskRow = {
  tile: string;
  prescriptionId: number;
  voNumber: string;
  therapistName: string | null;
  teamName: string | null;
  revenue: number | null;
  statusDate: string | null;
  daysSince: number | null;
  voStatus: string | null;
  activityCount: number | null;
  totalTreatments: number | null;
  blankoVO: boolean | null;
  // `patientName` is also served. It is deliberately NOT in this type: nothing in this file may
  // read or log it (see the class docblock).
};

export type Activity = {
  id: number;
  date: string;
  treatmentType?: string;
  rejectedTreatment?: boolean;
  rejectedTreatmentWithSignature?: boolean;
  prescription?: unknown;
};

export type PaintedGroup = { name: string; count: number; revenue: number };

/**
 * PRODUCTION verification of RC 3.14 #3814 (ready-for-billing dates count from the last signed
 * treatment) and #3803 (the risk table lists each VO once with all its risks).
 *
 * **STRICTLY READ-ONLY, and that shapes what is checkable.** Every request here is a GET, plus
 * navigating and reading the board. `POST /kpis/orga/risks/export` is deliberately NOT called: it
 * persists nothing, but it is still a POST, so on production it is left for a human to run. That
 * costs two things, stated rather than glossed — #3814 AC5's "Fertig seit (Tage)" COLUMN and
 * #3803's CSV can only be seen through it. Both tickets' underlying rule is verified anyway,
 * because the column is `daysSince` and the CSV's one-row-per-VO is the same grouping the screen
 * paints.
 *
 * **NO PATIENT DATA.** The risks payload carries `patientName` with real full names on production.
 * Nothing here reads, asserts on, or logs it; every assertion is a count, a date or a VO number.
 *
 * **The signed-treatment predicate is `rejectedTreatment` / `rejectedTreatmentWithSignature`** —
 * NOT `rejected` / `rejectedWithSignature`. Those shorter names do not exist on an Activity, so a
 * predicate built on them excludes nothing, silently degrades to "last treatment of any kind" and
 * reports mismatches on a correct build (it did exactly that here: 4 false mismatches in 60 VOs,
 * every one a later rejected session). #3649's negative test, with the field names that matter.
 */
export class ProdRiskRowsDatesPage {
  /** #3814's corrected Thema texts, and what #3785 shipped before it. */
  static readonly TOPIC_AFTER_3814: Record<string, string> = {
    'Fertig Behandelt': 'Fertig behandelt, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
    Abgebrochen: 'Abgebrochen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
    Abgelaufen: 'Abgelaufen, letzte Beh. vor > 30 Tagen, nicht in Abrechnung',
  };

  static readonly TOPIC_BEFORE_3814: Record<string, string> = {
    'Fertig Behandelt': 'Fertig behandelt vor > 30 Tagen, nicht in Abrechnung',
    Abgebrochen: 'Abgebrochen vor > 30 Tagen, nicht in Abrechnung',
    Abgelaufen: 'Abgelaufen vor > 30 Tagen, nicht in Abrechnung',
  };

  /** The three end statuses the ready-for-billing tile spans since #3775. */
  static readonly END_STATUSES = ['Fertig Behandelt', 'Abgebrochen', 'Abgelaufen'];

  static readonly READY_TILE = 'fertigNichtAbgerechnet';
  /** #3803: the Duplikat tile's rows are excluded from the grouped view and the export. */
  static readonly DUPLIKAT_TILE = 'duplikatOffen';

  private api!: APIRequestContext;
  private token = '';

  constructor(private readonly page?: Page) {}

  private requirePage(): Page {
    if (!this.page) throw new Error('ProdRiskRowsDatesPage needs a Page for the on-screen half');
    return this.page;
  }

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: PROD_API });
    const res = await this.api.post('/auth', { data: { username: credentials.email, password: credentials.password }, timeout: 90_000 });
    if (!res.ok()) throw new Error(`POST ${PROD_API}/auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 600_000): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      last = `${res.status()} ${path}`;
      // A 5xx is the server being unhealthy, never the route being absent.
      if (res.status() < 500) break;
      await new Promise((r) => setTimeout(r, 4_000 * (attempt + 1)));
    }
    throw new Error(`GET failed: ${last}`);
  }

  async status(): Promise<{ version: string }> {
    return this.get('/status', 60_000);
  }

  /**
   * The board's own payload. `tiles` and `rows` are wrapped in a SINGLE Hydra member, so the
   * ordinary `member` unwrap yields one element and a row scan over it finds nothing — which reads
   * exactly like an empty board (#3774).
   */
  async risks(): Promise<{ tiles: Record<string, number>; rows: RiskRow[] }> {
    const body = await this.get<{ member?: { tiles: Record<string, number>; rows: RiskRow[] }[] }>(
      '/kpis/orga/risks',
    );
    const inner = body.member?.[0];
    if (!inner) throw new Error('/kpis/orga/risks returned no member');
    return inner;
  }

  /** Whether this account may open the Admin-Performance board — a per-account gate on production. */
  async boardAccess(): Promise<Record<string, unknown>> {
    return this.get('/me', 120_000);
  }

  /** Probe a KPI route's reachability without assuming it exists. */
  async probe(path: string): Promise<number> {
    const res = await this.api.get(path, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    return res.status();
  }

  /** #3775's third surface: the Arbeitszeiten row per therapist. */
  async workingHours(): Promise<{ therapistId: number; completedUnbilledCount: number | null; completedUnbilledOver30Count: number | null }[]> {
    const body = await this.get<{ member?: any[] }>('/kpis/management/working-hours');
    return (body.member ?? []).map((w) => ({
      therapistId: w.therapistId,
      completedUnbilledCount: w.completedUnbilledCount ?? null,
      completedUnbilledOver30Count: w.completedUnbilledOver30Count ?? null,
    }));
  }

  /** VOs by internal id, batched. `?id[]=` is registered on `/prescriptions`. */
  async vosByIds(ids: readonly number[], chunk = 30): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += chunk) {
      const q = ids.slice(i, i + chunk).map((x) => `id%5B%5D=${x}`).join('&');
      const body = await this.get<{ member?: any[] }>(`/prescriptions?${q}&itemsPerPage=${chunk + 10}`);
      out.push(...(body.member ?? []));
    }
    return out;
  }

  /** Activities for many VOs in one request — `/activities` registers `prescription[]`. */
  async activitiesFor(voIds: readonly number[], chunk = 30): Promise<Map<number, Activity[]>> {
    const out = new Map<number, Activity[]>();
    for (const id of voIds) out.set(id, []);
    for (let i = 0; i < voIds.length; i += chunk) {
      const slice = voIds.slice(i, i + chunk);
      const q = slice.map((id) => `prescription%5B%5D=${id}`).join('&');
      const body = await this.get<{ member?: Activity[] }>(`/activities?${q}&itemsPerPage=1000`);
      for (const a of body.member ?? []) {
        const pr = a.prescription;
        const id = typeof pr === 'number' ? pr : Number(String((pr as any)?.['@id'] ?? pr).split('/').pop());
        if (out.has(id)) out.get(id)!.push(a);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- oracles

  /**
   * #3775's signed-treatment predicate. A planned session is not one, and a REJECTED session counts
   * only when it carries a signature — a negative test, so an omitted flag means "signed".
   */
  static isSigned(a: Activity): boolean {
    if (a.treatmentType === 'planned') return false;
    if (a.rejectedTreatment && !a.rejectedTreatmentWithSignature) return false;
    return true;
  }

  /** The date #3814 requires the ready-for-billing dates to count from. */
  static lastSignedDate(acts: readonly Activity[]): string | null {
    const d = acts.filter((a) => ProdRiskRowsDatesPage.isSigned(a)).map((a) => a.date.slice(0, 10)).sort();
    return d[d.length - 1] ?? null;
  }

  /** The naive predicate #3814 must NOT be using, kept so the two can be compared. */
  static lastAnyDate(acts: readonly Activity[]): string | null {
    const d = acts.map((a) => a.date.slice(0, 10)).sort();
    return d[d.length - 1] ?? null;
  }

  static daysBetween(from: string, to: string): number {
    const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
    return Math.round((b - a) / 86_400_000);
  }

  /** The rows a selection puts in the grouped table. `null` = no tile selected. */
  static rowsFor(rows: readonly RiskRow[], tile: string | null): RiskRow[] {
    if (tile === null) return rows.filter((r) => r.tile !== ProdRiskRowsDatesPage.DUPLIKAT_TILE);
    return rows.filter((r) => r.tile === tile);
  }

  static plainName(name: string): string {
    return name.replace(/\s*\(Inaktiv\)\s*$/, '').trim();
  }

  /** Stored names are not clean — a double space collapses in HTML (#3579). */
  static normalizeName(name: string): string {
    return ProdRiskRowsDatesPage.plainName(name).replace(/\s+/g, ' ');
  }

  /**
   * #3803's oracle: one entry per therapist, counting DISTINCT VOs. Counting rows instead is the
   * pre-fix behaviour and is what the painted screen is compared against.
   */
  static groupBy(rows: readonly RiskRow[], mode: 'distinct' | 'rows'): Map<string, { count: number; revenue: number }> {
    const acc = new Map<string, { vos: Set<string>; rows: number; revenue: number }>();
    for (const r of rows) {
      const key = ProdRiskRowsDatesPage.normalizeName(r.therapistName ?? '(ohne)');
      const e = acc.get(key) ?? { vos: new Set<string>(), rows: 0, revenue: 0 };
      e.vos.add(r.voNumber);
      e.rows += 1;
      e.revenue += r.revenue ?? 0;
      acc.set(key, e);
    }
    const out = new Map<string, { count: number; revenue: number }>();
    for (const [k, v] of acc) out.set(k, { count: mode === 'distinct' ? v.vos.size : v.rows, revenue: Math.round(v.revenue * 100) / 100 });
    return out;
  }

  // ------------------------------------------------------------- the screen

  /** Signs in against PRODUCTION. Call before any navigation (#3460: single-use refresh token). */
  async openOrgaBoard(timeout = 420_000): Promise<void> {
    const page = this.requirePage();
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin, { api: PROD_API });
    await page.goto(`${PROD_WEB}/flow-boards`, { waitUntil: 'domcontentloaded', timeout });
    await page.getByText('Therapeuten-Orga', { exact: true }).first().click({ timeout: 120_000 });
    await expect(page.getByText('Offene Risiken', { exact: true }).first(), 'the risk section').toBeVisible({ timeout });
  }

  /**
   * Waits for the thing the CALLER is about to read, not merely for the section. The column headers
   * paint before the group rows, so a gate that accepts either is satisfied by the headers and
   * {@link paintedGroups} then returns `[]` — which reads exactly like the table not being grouped.
   */
  async waitForGroups(timeout = 420_000): Promise<void> {
    await expect
      .poll(async () => (await this.paintedGroups()).length, { timeout, intervals: [3_000] })
      .toBeGreaterThan(0);
  }

  /**
   * The painted group headers. The subtotal is its own leaf (`"{count} VOs · {amount} €"`), so it is
   * matched on that pattern and the name taken from the nearest leaf to its left on the same row.
   *
   * Only the therapist name, the count and the value are read — never a VO row, so no patient name
   * is ever pulled off the production screen.
   */
  async paintedGroups(): Promise<PaintedGroup[]> {
    return this.requirePage().evaluate(() => {
      const leaves: { text: string; x: number; y: number }[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!text) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        leaves.push({ text, x: r.x, y: r.y });
      });
      const subtotal = /^(\d[\d.]*)\s+VOs?\s+·\s+([\d.]+,\d{2})\s*€$/;
      const out: { name: string; count: number; revenue: number }[] = [];
      for (const leaf of leaves) {
        const m = leaf.text.match(subtotal);
        if (!m) continue;
        const name = leaves
          .filter((l) => Math.abs(l.y - leaf.y) < 24 && l.x < leaf.x && !subtotal.test(l.text))
          .sort((a, b) => b.x - a.x)[0];
        out.push({
          name: name?.text ?? '',
          count: Number(m[1].replace(/\./g, '')),
          revenue: Number(m[2].replace(/\./g, '').replace(',', '.')),
        });
      }
      return out;
    });
  }

  /** The served production bundle — the only surface that answers for a frontend change (#3705). */
  async entryBundle(): Promise<string> {
    const page = this.requirePage();
    const html = await (await page.request.get(`${PROD_WEB}/`, { timeout: 120_000 })).text();
    const m = html.match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/);
    if (!m) throw new Error('no entry bundle in the served production HTML');
    return (await page.request.get(`${PROD_WEB}${m[0]}`, { timeout: 300_000 })).text();
  }

  static occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  /**
   * The bundle ESCAPES non-ASCII, so `für` is stored as `f\xfcr` and a literal search for the
   * German string returns 0 — which reads exactly like "never shipped" (#3337, #3611). Counts both
   * forms, because whether a given string survives as UTF-8 or escaped depends on the minifier.
   */
  static escapedOccurrences(haystack: string, needle: string): number {
    const escaped = [...needle]
      .map((ch) => {
        const c = ch.codePointAt(0)!;
        return c < 128 ? ch : `\\x${c.toString(16).padStart(2, '0')}`;
      })
      .join('');
    return this.occurrences(haystack, needle) + (escaped === needle ? 0 : this.occurrences(haystack, escaped));
  }
}
