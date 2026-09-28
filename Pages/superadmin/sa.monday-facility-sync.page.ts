import { APIRequestContext, expect } from '@playwright/test';

/**
 * The nightly Monday.com facility sync's rename guard (RC 3.12 #3344).
 *
 * `SyncMondayFacilitiesCommand` matches Flow facilities to Monday.com rows on the Einrichtungs-ID
 * and renames in place when the names differ. #3344 adds a guard: a facility with at least one
 * patient or VO keeps its Flow name and the mismatch goes to the report instead.
 *
 * **The sync is a console command, so nothing here can run it.** What IS observable from a client is
 * its *inputs and outcomes* — which facility each Einrichtungs-ID resolves to, how many records are
 * attached to it, and whether `mondayItemId` was written (the command sets it on **every** match, so
 * its presence is a reliable footprint of a facility the sync actually reached).
 *
 * **Counting attachments: what the API can and cannot mirror.** The guard counts
 * `Patient.elderlyCareHome` AND `Prescription.elderlyCareHome`. Only the second is reachable —
 * `/prescriptions?elderlyCareHome=` filters on the prescription's own FK. `/patients` registers **no
 * facility filter at all**, and API Platform ignores an unknown one **silently**: both
 * `?elderlyCareHome=` and `?patient.elderlyCareHome=` come back with the full 8,364-patient total,
 * which reads exactly like "this facility has every patient". Always compare a filtered total against
 * the unfiltered one before believing it. VO count is therefore a one-way proxy: `vos > 0` proves the
 * guard applies; `vos === 0` does not prove it does not.
 *
 * Note `?patient.elderlyCareHome=` on `/prescriptions` is a *different* filter and returns different
 * numbers — a VO carries its own facility, which need not be its patient's.
 */

export type Facility = {
  id: number;
  echId: string;
  name: string;
  status: boolean;
  /** Written by the sync on every match, so its absence means the sync never reached this row. */
  mondayItemId: string | null;
  /** #3783 pairs on this, so it is the field the whole ticket turns on. */
  address: string | null;
  /** `care_home` | `practice`. Rule 4 keeps a practice's ID, name and address. */
  type: string | null;
};

export type SyncReport = {
  id: number;
  runDate: string;
  matchedCount: number;
  createdCount: number;
  mismatchCount: number;
  gapCount: number;
  filePath: string;
};

/** AC6's seven columns, verbatim. */
export type ReportRow = {
  category: string;
  echId: string;
  flow_name: string;
  monday_name: string;
  address: string;
  monday_item_id: string;
  reason: string;
};

export type FacilityAttachments = Facility & {
  /** VOs whose own `elderlyCareHome` is this facility — the half of the guard's count we can see. */
  vos: number;
};

export class MondayFacilitySyncPage {
  static readonly API = 'https://api.staging.therapios.de';

  private cachedFacilities: Facility[] | null = null;

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private async json(path: string): Promise<any> {
    const response = await this.request.get(`${MondayFacilitySyncPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  /** Every facility. 245 on staging, so one page is enough. */
  async facilities(): Promise<Facility[]> {
    if (this.cachedFacilities) return this.cachedFacilities;
    const body = await this.json('/elderly_care_homes?page=1&itemsPerPage=500&order%5Bid%5D=asc');
    this.cachedFacilities = MondayFacilitySyncPage.members(body).map((row: any) => ({
      id: row.id,
      echId: String(row.echId ?? '').trim(),
      name: String(row.name ?? ''),
      status: row.status === true,
      mondayItemId: row.mondayItemId ?? null,
      address: row.address ?? null,
      type: row.type ?? null,
    }));
    return this.cachedFacilities;
  }

  /** How many VOs sit on this facility directly. */
  async voCount(facilityId: number): Promise<number> {
    const body = await this.json(`/prescriptions?page=1&itemsPerPage=1&elderlyCareHome=${facilityId}`);
    return body.totalItems ?? 0;
  }

  /** Every facility with its VO count. ~245 requests, so callers should cache it. */
  async facilitiesWithAttachments(): Promise<FacilityAttachments[]> {
    const out: FacilityAttachments[] = [];
    for (const facility of await this.facilities()) {
      out.push({ ...facility, vos: await this.voCount(facility.id) });
    }
    return out;
  }

  /**
   * Einrichtungs-IDs held by more than one facility.
   *
   * This is the shape the guard cannot see: the command builds `$echMap[$ech->getEchId()] = $ech`
   * over `findAll()`, so one row silently overwrites the other and only the survivor is ever
   * matched, guarded or renamed.
   */
  static duplicateEchIds<T extends Facility>(facilities: T[]): Map<string, T[]> {
    const byId = new Map<string, T[]>();
    for (const facility of facilities) {
      if (facility.echId === '') continue;
      byId.set(facility.echId, [...(byId.get(facility.echId) ?? []), facility]);
    }
    return new Map([...byId].filter(([, rows]) => rows.length > 1));
  }

  /** Proof that a `/patients` facility filter is ignored rather than empty. */
  async patientsTotal(query = ''): Promise<number> {
    const body = await this.json(`/patients?page=1&itemsPerPage=1${query}`);
    return body.totalItems ?? 0;
  }

  // ───────────────────── #3783: pairing by Monday ROW ──────────────────────

  /**
   * Active facilities that keep the SAME Monday row number — rule 9's conflict shape.
   *
   * This is the arrangement the pre-fix code could not express at all (it paired on the facility ID),
   * and the one the fix answers by changing nothing on either side. It is also how the pre-fix damage
   * is still visible: a facility that took another's address keeps that other facility's row.
   */
  static duplicateMondayRows<T extends Facility>(facilities: T[]): Map<string, T[]> {
    const byRow = new Map<string, T[]>();
    for (const facility of facilities) {
      if (!facility.status || !facility.mondayItemId) continue;
      const row = String(facility.mondayItemId);
      byRow.set(row, [...(byRow.get(row) ?? []), facility]);
    }
    return new Map([...byRow].filter(([, rows]) => rows.length > 1));
  }

  /**
   * Facilities sharing a name once punctuation, case and spacing are removed.
   *
   * The ticket's own description of the bug is that "an empty twin facility was created", so a twin
   * group with one populated and one empty side IS the defect's signature. Pinning the set means a
   * new twin appearing after the fix fails a test rather than going unnoticed for weeks.
   */
  static twinGroups<T extends Facility>(facilities: T[]): Map<string, T[]> {
    const byName = new Map<string, T[]>();
    for (const facility of facilities) {
      const key = (facility.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key === '') continue;
      byName.set(key, [...(byName.get(key) ?? []), facility]);
    }
    return new Map([...byName].filter(([, rows]) => rows.length > 1));
  }

  /**
   * Facilities that can only ever be paired by their ID: active, carrying an Einrichtungs-ID, and
   * keeping no Monday row. Rule 2 makes the ID a fallback *only* for these.
   */
  static idFallbackOnly<T extends Facility>(facilities: T[]): T[] {
    return facilities.filter((f) => f.status && f.echId !== '' && f.mondayItemId === null);
  }

  /** The raw item payload, for asserting which fields a facility does and does not carry. */
  async facilityRaw(id: number): Promise<Record<string, any>> {
    return await this.json(`/elderly_care_homes/${id}`);
  }

  // ───────────────── #3783: the run's own REPORT is a real surface ─────────────────

  /**
   * `GET /sync_facility_reports` — one row per run, with the CSV behind `/{id}/signed-url`.
   *
   * **This file previously asserted that no surface existed for a run**, having probed
   * `/elderly_care_home_logs`, `/facility_logs` and `/monday_sync_logs` (all 404) and concluded the
   * command was unobservable. That was wrong: it is a *report*, not a log, and the ticket's own
   * comment names it. The CSV carries the seven columns AC6 describes —
   * `category, echId, flow_name, monday_name, address, monday_item_id, reason`.
   */
  async reports(): Promise<SyncReport[]> {
    // `order[id]=desc` is REJECTED on this collection (a non-JSON error, not a silent ignore), so
    // the newest run is reached by paging to the end rather than by sorting.
    const first = await this.json('/sync_facility_reports?itemsPerPage=50&page=1');
    const total = first.totalItems ?? 0;
    const pages = Math.max(1, Math.ceil(total / 50));
    const out: SyncReport[] = [];
    for (let page = 1; page <= pages; page++) {
      const body = await this.json(`/sync_facility_reports?itemsPerPage=50&page=${page}`);
      for (const row of MondayFacilitySyncPage.members(body)) {
        out.push({
          id: row.id,
          runDate: String(row.runDate ?? ''),
          matchedCount: row.matchedCount ?? 0,
          createdCount: row.createdCount ?? 0,
          mismatchCount: row.mismatchCount ?? 0,
          gapCount: row.gapCount ?? 0,
          filePath: String(row.filePath ?? ''),
        });
      }
    }
    out.sort((a, b) => a.id - b.id);
    expect(out.length, 'walked every sync report').toBe(total);
    return out;
  }

  /** The most recent run. */
  async latestReport(): Promise<SyncReport> {
    const all = await this.reports();
    expect(all.length, 'staging has sync reports').toBeGreaterThan(0);
    return all[all.length - 1];
  }

  /** A run's CSV rows, fetched through its signed URL. */
  async reportRows(reportId: number): Promise<ReportRow[]> {
    const body = await this.json(`/sync_facility_reports/${reportId}/signed-url`);
    const url = String(body.contentUrl ?? '');
    expect(url, `report ${reportId} has a signed URL`).toContain('http');
    const res = await this.request.get(url, { timeout: 180_000 });
    expect(res.status(), `download report ${reportId}`).toBe(200);
    return MondayFacilitySyncPage.parseReportCsv(await res.text());
  }

  /** The CSV is comma-delimited with a UTF-8 BOM and quoted reasons. */
  static parseReportCsv(text: string): ReportRow[] {
    const body = text.replace(/^\uFEFF/, '').trim();
    const lines: string[][] = [];
    let field = '';
    let row: string[] = [];
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quoted) {
        if (c === '"' && body[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); lines.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); lines.push(row); }
    const header = lines.shift() ?? [];
    return lines.filter((l) => l.length > 1).map((l) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = l[i] ?? ''));
      return o as unknown as ReportRow;
    });
  }

  static countByCategory(rows: ReportRow[]): Record<string, number> {
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = (acc[r.category] ?? 0) + 1;
      return acc;
    }, {});
  }

  /** A stable, comparable fingerprint of everything the sync is able to write. */
  static fingerprint(facility: Facility): string {
    return JSON.stringify({
      echId: facility.echId,
      name: facility.name,
      address: facility.address,
      mondayItemId: facility.mondayItemId,
      status: facility.status,
    });
  }
}
