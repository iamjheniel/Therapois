import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The notice shown when reactivating an expired VO clears its "Bestellen" status (RC 3.13 #3561).
 *
 * #3197 already clears `followupStatus` and `orderDate` when an Abgelaufen VO goes back to Aktiv;
 * nothing told the admin. This ticket adds the notice — per VO on a single reactivation, and one
 * summary with a count on a bulk one. The clearing itself is unchanged.
 *
 * **Two deployed surfaces carry the whole thing, and neither needs a reactivation to inspect.**
 *
 * 1. `POST /prescriptions/status/bulk` now answers `{count, clearedFollowupCount}` — the count the
 *    bulk notice renders (AC3/AC4). **A payload naming an id that matches nothing is a completely
 *    safe live probe of it:** the controller's `findBy(['id' => …])` returns an empty set, the loop
 *    body never runs, and no `PrescriptionLog` is written — so the field can be confirmed on the
 *    deployed API with zero side effects. Note the log IS written unconditionally inside the loop,
 *    so a "harmless" post of Aktiv onto an already-Aktiv VO is NOT side-effect free.
 * 2. The single-VO notice is decided client-side by `reactivationClearedFollowup()`:
 *    `initial === Abgelaufen && submitted.voStatus === Aktiv && submitted.fvoStatus === Bestellen
 *    && response.followupStatus == null`. It reads the PATCH RESPONSE rather than recomputing, so
 *    the notice cannot drift from the clearing — and the API contract it depends on is that a
 *    cleared `followupStatus` is **omitted from the payload entirely** (#3302), not serialized null.
 *
 * **The notice text is one i18n pair used by both paths** —
 * `notifications.reactivation_cleared_followup_count_one` / `_other`, interpolating `{{count}}`, so
 * a single reactivation renders the singular of the same string the bulk summary uses.
 *
 * **Traps:** the bundle escapes non-ASCII, so the German values must be grepped in escaped form
 * (#3611); and `treatmentStatus` / `followupStatus` are registered filters on `/prescriptions` but
 * the values are the GERMAN status strings (`Abgelaufen`), while `followupStatus` takes the enum
 * (`order`).
 */

export type BulkStatusResult = { status: number; count: number | null; clearedFollowupCount: number | null; detail: string };

/** The two i18n keys the notice renders, in both locales. */
export const NOTICE_KEYS = [
  'reactivation_cleared_followup_count_one',
  'reactivation_cleared_followup_count_other',
] as const;

/** Distinctive fragments of the shipped German values, checked in escaped form. */
export const GERMAN_FRAGMENTS = ['reaktivierten VO entfernt', 'reaktivierten VOs entfernt'] as const;

export class ReactivationNoticePage {
  private bearer: string | null = null;

  constructor(private request: APIRequestContext, token?: string) {
    this.bearer = token ?? null;
  }

  private async auth(): Promise<string> {
    if (this.bearer) return this.bearer;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.bearer = (await res.json()).token;
    return this.bearer!;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.auth();
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  /**
   * The bulk status endpoint.
   *
   * **Only ever call this with ids that match nothing** unless you intend to change real VOs — the
   * loop writes a `treatment_status_change` log for every prescription it finds, even when the
   * status is unchanged.
   */
  async bulkStatus(ids: number[], treatmentStatus: string): Promise<BulkStatusResult> {
    const token = await this.auth();
    const res = await this.request.post(`${API_BASE}/prescriptions/status/bulk`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { id: ids, treatmentStatus },
      timeout: 120_000,
    });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    return {
      status: res.status(),
      count: body?.count ?? null,
      clearedFollowupCount: body?.clearedFollowupCount ?? null,
      detail: body?.detail ?? body?.error ?? body?.message ?? '',
    };
  }

  /** How many VOs are in a given state — the fixture pool for a reactivation test. */
  async countWhere(query: string): Promise<number> {
    const body = await this.get<{ totalItems: number }>(`/prescriptions?${query}&itemsPerPage=1`);
    return body.totalItems;
  }

  /** VOs in the AC1/AC3 fixture state: Abgelaufen AND Folge-VO Status "Bestellen". */
  async reactivationCandidates(limit = 10): Promise<{ id: number; number: string; followupStatus: string | null; orderDate: string | null }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?treatmentStatus=Abgelaufen&followupStatus=order&itemsPerPage=${limit}`,
    );
    return body.member.map((m) => ({
      id: m.id,
      number: m.prescriptionId,
      followupStatus: m.followupStatus ?? null,
      orderDate: m.orderDate ?? null,
    }));
  }

  /** Whether a VO serializes `followupStatus` at all — the contract the notice keys off. */
  async serializesFollowupStatus(prescriptionId: number): Promise<{ present: boolean; value: unknown }> {
    const body = await this.get<Record<string, unknown>>(`/prescriptions/${prescriptionId}`);
    return { present: 'followupStatus' in body, value: body.followupStatus };
  }

  /** The served entry bundle, for the notice strings. */
  async bundle(): Promise<string> {
    const html = await (await this.request.get('https://staging.therapios.de/', { timeout: 120_000 })).text();
    const src = [...html.matchAll(/src="([^"]*entry[^"]*\.js)"/g)].map((m) => m[1])[0];
    if (!src) throw new Error('no entry bundle found');
    const url = src.startsWith('http') ? src : `https://staging.therapios.de${src}`;
    return (await this.request.get(url, { timeout: 180_000 })).text();
  }

  /** Occurrences of a literal, matched in the bundle's escaped non-ASCII form (#3611). */
  escapedCount(source: string, needle: string): number {
    const escaped = [...needle]
      .map((c) => (c.charCodeAt(0) < 128 ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
      .join('');
    return source.split(escaped).length - 1;
  }
}
