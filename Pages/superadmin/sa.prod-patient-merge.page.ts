import { type APIRequestContext, request as pwRequest } from '@playwright/test';
import { type Credentials, STAGING_CREDENTIALS } from '../util/api-token';

export const PROD_API = 'https://api.app.therapios.de';

/** A merge log, with the identifying half of `meta` deliberately not modelled. */
export type MergeLog = {
  id: number;
  createdAt: string;
  /** The MERGED patient's number. */
  oldValue: string | null;
  /** The SURVIVOR's number. */
  newValue: string | null;
  removedPatientId: string | null;
  metaKeys: string[];
  author: unknown;
};

/**
 * PRODUCTION side of RC 3.14 #3804 — the patient merge command takes a reviewed list at run time.
 *
 * **READ-ONLY, and PII-minimising by construction.** Every request is a GET. A `patient_merged`
 * log's `meta` carries `removedName`, `removedBirthDate` and `removedInsuranceNumber` for a REAL
 * person; {@link MergeLog} models only the numbers and the meta KEY NAMES, so the identifying
 * values cannot reach an assertion, a log line or a trace. Nothing here reads a patient record for
 * anything but its existence and its VO count.
 *
 * **THE NUMBER-VS-ID TRAP, demonstrated on production rather than described.** The ticket and the
 * list CSV both say "patient 8181 / 8864", and its column is literally named `patientId` — but that
 * is the UI patient NUMBER, serialized as `patient.patientId`, NOT the API id. On production,
 * number **8181 is API id 6922** and number **8864 is id 7630**, so `GET /patients/8181` returns an
 * unrelated real patient and reads like a perfectly good fixture. `?patientId=` is silently IGNORED
 * on `/patients` (every value returns all 9,715 rows), so the cheap correct route is the VO number:
 * a VO is `<patientNumber>-<n>`, and `?prescriptionId[]=` IS a registered multi-value filter.
 */
export class ProdPatientMergePage {
  /** The pair AC6 names for the first production list. Patient NUMBERS, not API ids. */
  static readonly AC6 = { keep: '8181', merge: '8864' } as const;

  /** #3131's one-off batch, which is what production's merge history holds today. */
  static readonly BATCH_3131_DAY = '2026-08-05';

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

  async status(): Promise<{ version: string }> {
    return this.get('/status', 60_000);
  }

  /** Every merge log, stripped to its non-identifying fields at the boundary. */
  async mergeLogs(): Promise<MergeLog[]> {
    const out: MergeLog[] = [];
    for (let page = 1; page <= 8; page++) {
      const body = await this.get<{ member?: Record<string, any>[] }>(
        `/patient_logs?type=patient_merged&itemsPerPage=300&page=${page}`,
      );
      const m = body.member ?? [];
      for (const r of m) {
        const meta = r.meta ?? {};
        out.push({
          id: r.id,
          createdAt: r.createdAt,
          oldValue: r.oldValue == null ? null : String(r.oldValue),
          newValue: r.newValue == null ? null : String(r.newValue),
          removedPatientId: meta.removedPatientId == null ? null : String(meta.removedPatientId),
          metaKeys: Object.keys(meta).sort(),
          author: r.author ?? null,
        });
      }
      if (m.length < 300) break;
    }
    return out;
  }

  /** Whether a filter narrows `/patients`, so a count from it can be believed. */
  async patientFilterIsHonoured(query: string): Promise<{ all: number; hit: number }> {
    const all = (await this.get<{ totalItems: number }>('/patients?itemsPerPage=1')).totalItems;
    const hit = (await this.get<{ totalItems: number }>(`/patients?${query}&itemsPerPage=1`)).totalItems;
    return { all, hit };
  }

  /**
   * Patient NUMBER → API id, via that patient's own VO numbers. Cheap (one request for many
   * patients) and needs no walk of the 9,715-row collection, which is what the ignored `patientId`
   * filter would otherwise force.
   */
  async apiIdsByPatientNumber(numbers: readonly string[], suffixes = [1, 2, 3]): Promise<Map<string, Set<number>>> {
    const ids = numbers.flatMap((n) => suffixes.map((s) => `${n}-${s}`));
    const q = ids.map((v) => `prescriptionId%5B%5D=${encodeURIComponent(v)}`).join('&');
    const body = await this.get<{ member?: { prescriptionId: string; patient?: any }[] }>(
      `/prescriptions?${q}&itemsPerPage=${Math.max(ids.length, 30)}`,
    );
    const out = new Map<string, Set<number>>();
    for (const n of numbers) out.set(n, new Set());
    for (const vo of body.member ?? []) {
      const num = vo.prescriptionId.split('-')[0];
      const pr = vo.patient;
      const id = typeof pr === 'number' ? pr : Number(String(pr?.['@id'] ?? pr).split('/').pop());
      if (out.has(num) && Number.isFinite(id)) out.get(num)!.add(id);
    }
    return out;
  }

  /** VO numbers belonging to a patient number, and which patient id each now sits on. */
  async vosOfPatientNumber(number: string, suffixes = [1, 2, 3, 4, 5]): Promise<{ vo: string; patientId: number }[]> {
    const q = suffixes.map((s) => `prescriptionId%5B%5D=${number}-${s}`).join('&');
    const body = await this.get<{ member?: { prescriptionId: string; patient?: any }[] }>(
      `/prescriptions?${q}&itemsPerPage=30`,
    );
    return (body.member ?? []).map((vo) => {
      const pr = vo.patient;
      return {
        vo: vo.prescriptionId,
        patientId: typeof pr === 'number' ? pr : Number(String(pr?.['@id'] ?? pr).split('/').pop()),
      };
    });
  }

  /** Has a merge run since #3131's batch? That is the whole question for AC6 today. */
  static mergesAfter(logs: readonly MergeLog[], day: string): MergeLog[] {
    return logs.filter((l) => l.createdAt.slice(0, 10) > day);
  }
}
