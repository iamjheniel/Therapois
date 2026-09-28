import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The patient merge command driven by a reviewed list — RC 3.14 #3804, commit `16a321f7f`
 * (2026-09-25), extending #3131's `app:patient:merge-duplicates`.
 *
 * #3131's engine keyed every group on a SHARED INSURANCE NUMBER, so it could only merge the fixed
 * list reviewed in July. This takes a CSV at run time (`group;role;patientId;lastName;birthDate;
 * insuranceNumber`), previews by default, and skips any group whose records no longer match the
 * snapshot the operations team reviewed.
 *
 * ## The command is console-only, but its OUTCOME is fully readable
 *
 * | What | Where |
 * |---|---|
 * | the merge happened | `patient_logs?type=patient_merged` — `oldValue`/`newValue` are patient NUMBERS, `meta` carries `removedPatientId`/`removedName`/`removedBirthDate`/`removedInsuranceNumber` |
 * | VOs moved and renumbered | the survivor's `/prescriptions?patient.id=` |
 * | the old VO number stays findable | **`formerNumbers`** on the VO (default group): `[{number, createdAt}]` |
 * | the merged record is gone | `GET /patients/{id}` → 404 |
 * | a skipped group is untouched | both records still resolve, with no `patient_merged` log |
 *
 * **The report itself is NOT reachable** — verified against the whole API entrypoint, which exposes
 * only `CrmActivityReport`, `SyncFacilityReport` and `TherapyReport`; there is no merge report
 * resource (the #3783 lesson applied: look for a report before concluding, but here there is none).
 *
 * ## THE TRAP: a patient NUMBER is not a patient ID
 *
 * The ticket and the PM notes say "patient 8864", "patient 99693". Those are the UI patient NUMBER,
 * serialized as **`patient.patientId`**, not the API id — 99693 is API id **8993**, and
 * `GET /patients/99693` is a 404 here (on #3790's fixtures the same mistake resolved to a
 * *different real patient*, which is worse). {@link resolveByPatientNumber} does it properly.
 *
 * ## The sharpest evidence for AC2 is a TIMESTAMP
 *
 * The dev team's staging run previewed at ~14:07 UTC and applied at 14:10:22. The former number and
 * the merge log both carry **14:10:22** — so the preview demonstrably wrote nothing. A "preview
 * changed nothing" claim cannot be made any other way after the fact.
 */

export const API = API_BASE;

/** The dev team's staging FT fixtures (25 Sep 2026), by UI patient NUMBER. */
export const FT = {
  /** Group FT1 — merged. */
  keep: 99693,
  merged: 99694,
  /** Group FT2 — skipped, because `keep`'s last name was changed after the list was written. */
  skipKeep: 99695,
  skipMerge: 99696,
} as const;

/** The real run's instant; the preview ran ~3 minutes earlier and must have left no trace. */
export const REAL_RUN_AT = '2026-09-25T14:10:22+00:00';

export type PatientLog = {
  id: number;
  type: string;
  createdAt: string;
  oldValue: string | null;
  newValue: string | null;
  meta: Record<string, unknown> | null;
};

export class PatientMergeListPage {
  private bearer: string | null = null;

  constructor(private request: APIRequestContext) {}

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  /** A GET that returns the status rather than throwing, so 404 can be an assertion. */
  async raw(path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const token = await this.token();
    const res = await this.request.get(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
      failOnStatusCode: false,
    });
    if (res.status() >= 400) return { status: res.status(), body: null };
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
  }

  async get<T>(path: string): Promise<T> {
    const r = await this.raw(path);
    expect(r.status, `GET ${path}`).toBe(200);
    return r.body as unknown as T;
  }

  // ─────────────────────────── number ↔ id, the trap ──────────────────────────

  /**
   * The UI patient NUMBER → the API id, by walking `patientId`.
   *
   * Never pass a patient number to `/patients/{id}`: here it 404s, and on #3790's fixtures the same
   * mistake silently resolved to an unrelated real patient.
   */
  async resolveByPatientNumber(patientNumber: number, searchFrom = 8_900, searchTo = 9_050): Promise<number | null> {
    for (let id = searchFrom; id <= searchTo; id++) {
      const r = await this.raw(`/patients/${id}`);
      if (r.status === 200 && Number(r.body?.patientId) === patientNumber) return id;
    }
    return null;
  }

  /** The same lookup done cheaply when a VO number of that patient is known. */
  async patientIdForVo(voNumber: string): Promise<{ patientId: number; patientNumber: number; fullName: string } | null> {
    const body = await this.get<{ member?: Record<string, unknown>[] }>(
      `/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(voNumber)}&groups%5B%5D=billing%3Aread&itemsPerPage=1`,
    );
    const row = (body.member ?? [])[0];
    if (!row) return null;
    const p = row.patient as Record<string, unknown>;
    return { patientId: Number(p.id), patientNumber: Number(p.patientId ?? 0), fullName: String(p.fullName ?? '') };
  }

  // ──────────────────────────────── the outcome ───────────────────────────────

  async patient(id: number): Promise<{ status: number; body: Record<string, unknown> | null }> {
    return await this.raw(`/patients/${id}`);
  }

  async vosFor(patientId: number): Promise<Record<string, unknown>[]> {
    const body = await this.get<{ member?: Record<string, unknown>[] }>(
      `/prescriptions?patient.id=${patientId}&itemsPerPage=50`,
    );
    return (body.member ?? []).sort((a, b) => Number(a.id) - Number(b.id));
  }

  async logsFor(patientId: number, type?: string): Promise<PatientLog[]> {
    const body = await this.get<{ member?: PatientLog[] }>(
      `/patient_logs?patient=${patientId}${type ? `&type=${type}` : ''}&itemsPerPage=100`,
    );
    return body.member ?? [];
  }

  /** Every merge Flow has ever recorded — #3131's July batch and this ticket's runs alike. */
  async allMergeLogs(): Promise<PatientLog[]> {
    const body = await this.get<{ member?: PatientLog[]; totalItems?: number }>(
      '/patient_logs?type=patient_merged&itemsPerPage=500',
    );
    return body.member ?? [];
  }

  /** `formerNumbers` on a VO — `[{number, createdAt}]`, the AC4 trace a renumbering leaves. */
  static formerNumbers(vo: Record<string, unknown>): { number: string; createdAt: string }[] {
    return ((vo.formerNumbers as Record<string, unknown>[]) ?? []).map((f) => ({
      number: String(f.number),
      createdAt: String(f.createdAt),
    }));
  }

  /** Report resources the API actually exposes — AC5's reachability, measured not assumed. */
  async reportResources(): Promise<string[]> {
    const docs = await this.get<Record<string, unknown>>('/docs.jsonld');
    const text = JSON.stringify(docs);
    return [...new Set([...text.matchAll(/"([A-Za-z]*Report[A-Za-z]*)"/g)].map((m) => m[1]))].sort();
  }
}
