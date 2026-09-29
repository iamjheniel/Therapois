import { type APIRequestContext, request as pwRequest } from '@playwright/test';
import { type Credentials, STAGING_CREDENTIALS } from '../util/api-token';

export const PROD_API = 'https://api.app.therapios.de';

export type Facility = {
  id: number;
  echId: string | null;
  name: string | null;
  status: boolean | null;
  mondayItemId: string | number | null;
  type: string | null;
};

export type SyncReport = {
  id: number;
  createdAt: string;
  runDate?: string;
  matchedCount: number | null;
  createdCount: number | null;
  mismatchCount: number | null;
  gapCount: number | null;
};

export type ReportRow = Record<string, string>;

/**
 * PRODUCTION side of RC 3.14 **#3783** — a facility must follow the Monday.com row NUMBER it keeps,
 * not its Einrichtungs-ID. The follow-up to #3344, whose standing finding it closes.
 *
 * **READ-ONLY:** every request is a GET, including the report's signed URL. The sync itself is a
 * console command on an EventBridge schedule and is never run here.
 *
 * **The run REPORT is the only observable**, since the command has no route: `GET /sync_facility_reports`
 * serves one row per run and `/{id}/signed-url` a CSV with seven columns
 * (`category, echId, flow_name, monday_name, address, monday_item_id, reason`).
 *
 * **THE PRODUCTION CSV IS COMMA-DELIMITED.** Parsing it with `;` yields one column per row whose
 * name is the whole header line and a `category` of `undefined` for every row — which reads exactly
 * like the category column having been removed.
 *
 * **Why deployment is NOT decidable here, unlike on staging:** the only thing the fix ADDS to a
 * report is a `conflict` row, and rule 9 raises one only when a Monday row is kept by two ACTIVE
 * facilities. Production has four duplicated rows and **every one has exactly one active facility**,
 * so a fixed build must also report `conflict: 0`. The count is therefore consistent with either
 * build, and {@link conflictConditionExists} is what says so rather than guessing.
 */
export class ProdMondaySyncPage {
  /** The categories a pre-#3783 report can emit. `conflict` is the one this ticket adds. */
  static readonly BASE_CATEGORIES = ['matched', 'created', 'name_updated', 'name_update_skipped', 'gap'];
  static readonly CONFLICT = 'conflict';
  static readonly CSV_HEADER = ['category', 'echId', 'flow_name', 'monday_name', 'address', 'monday_item_id', 'reason'];

  private api!: APIRequestContext;
  private token = '';

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: PROD_API });
    const res = await this.api.post('/auth', {
      data: { username: credentials.email, password: credentials.password },
      timeout: 90_000,
    });
    if (!res.ok()) throw new Error(`POST ${PROD_API}/auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 300_000): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      last = `${res.status()} ${path}`;
      if (res.status() < 500) break;
      await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
    }
    throw new Error(`GET failed: ${last}`);
  }

  async probe(path: string): Promise<number> {
    const res = await this.api.get(path, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    return res.status();
  }

  async facilities(): Promise<Facility[]> {
    const out: Facility[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.get<{ member?: Facility[] }>(`/elderly_care_homes?itemsPerPage=100&page=${page}`);
      const m = body.member ?? [];
      out.push(...m);
      if (m.length < 100) break;
    }
    return out;
  }

  /**
   * The newest run reports. **`order[id]=desc` is REJECTED on this collection** (a non-JSON error,
   * not a silent ignore), so the last page is reached by arithmetic.
   */
  async latestReports(count = 5): Promise<SyncReport[]> {
    const { totalItems } = await this.get<{ totalItems: number }>('/sync_facility_reports?itemsPerPage=1');
    const per = 30;
    const last = Math.ceil(totalItems / per);
    const body = await this.get<{ member?: SyncReport[] }>(`/sync_facility_reports?itemsPerPage=${per}&page=${last}`);
    return (body.member ?? []).slice(-count);
  }

  /** One report's CSV rows. Comma-delimited; the signed URL is fetched unauthenticated. */
  async reportRows(reportId: number): Promise<ReportRow[]> {
    const signed = await this.get<Record<string, string>>(`/sync_facility_reports/${reportId}/signed-url`);
    const url = signed.url ?? signed.signedUrl ?? signed.contentUrl;
    if (!url) throw new Error(`no signed url on report ${reportId}`);
    const res = await this.api.get(url, { timeout: 300_000 });
    if (!res.ok()) throw new Error(`report ${reportId} csv -> ${res.status()}`);
    return ProdMondaySyncPage.parseCsv((await res.body()).toString('utf8').replace(/^﻿/, ''));
  }

  /** A quote-aware comma parser: the `reason` column carries commas and quoted names. */
  static parseCsv(text: string): ReportRow[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    const clean = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (quoted) {
        if (c === '"') {
          if (clean[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift() ?? [];
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }

  static categories(rows: readonly ReportRow[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.category] = (out[r.category] ?? 0) + 1;
    return out;
  }

  /** Monday rows kept by more than one facility, with the active ones called out. */
  static duplicateMondayRows(fac: readonly Facility[]): { row: string; all: Facility[]; active: Facility[] }[] {
    const by = new Map<string, Facility[]>();
    for (const f of fac) {
      if (f.mondayItemId === null || f.mondayItemId === undefined || f.mondayItemId === '') continue;
      const k = String(f.mondayItemId);
      (by.get(k) ?? by.set(k, []).get(k)!).push(f);
    }
    return [...by.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([row, all]) => ({ row, all, active: all.filter((f) => f.status === true) }));
  }

  /** Einrichtungs-IDs held by more than one facility — #3344's finding. */
  static duplicateEchIds(fac: readonly Facility[]): { echId: string; facilities: Facility[] }[] {
    const by = new Map<string, Facility[]>();
    for (const f of fac) {
      if (!f.echId) continue;
      (by.get(f.echId) ?? by.set(f.echId, []).get(f.echId)!).push(f);
    }
    return [...by.entries()].filter(([, v]) => v.length > 1).map(([echId, facilities]) => ({ echId, facilities }));
  }

  /**
   * Whether rule 9's conflict condition exists at all — i.e. whether a fixed build COULD emit a
   * `conflict` row. Without this, `conflict: 0` looks like evidence and is not.
   */
  static conflictConditionExists(fac: readonly Facility[]): boolean {
    return this.duplicateMondayRows(fac).some((d) => d.active.length > 1);
  }

  /** A stable fingerprint, so "nothing the rules freeze may move" is a real regression guard. */
  static fingerprint(f: Facility): string {
    return JSON.stringify({ id: f.id, echId: f.echId, name: f.name, status: f.status, monday: String(f.mondayItemId ?? '') });
  }
}
