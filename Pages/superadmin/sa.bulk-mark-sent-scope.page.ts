import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Therapist scoping on `POST /prescriptions/report-send/bulk` (RC 3.13 #3549, PR #3688).
 *
 * The endpoint marked therapy reports "sent" for ARBITRARY VO ids: the lookup was a bare `findBy`
 * on the posted ids with no therapist predicate, while every sibling bulk endpoint (organizer,
 * transfer, ordering-status) already narrowed non-admins to their own caseload. The fix adds
 * `p.therapist = :therapist` for non-admins, joined through the report's NOT NULL prescription.
 *
 * **The write side was the worse half, and it is what this page object is built to check.** Every
 * marked report also persisted a `PrescriptionLog` attributed to the CALLER against a VO they do
 * not own — a forged audit trail, not just an unauthorised state change. So `markSentLogs()` reads
 * that trail back: a foreign VO must gain no entry at all.
 *
 * **Semantics are silent exclusion, not 403** — deliberately, matching `BulkPostOrganizerController`:
 * out-of-caseload ids drop out of the query, the response stays 200 with a reduced count. A 403
 * would break the partial-batch contract and would confirm that a given VO id exists.
 *
 * **THE TEST-DESIGN TRAP, and it makes a broken build look fixed.** The query also filters
 * `tr.sentAt IS NULL AND tr.archivedDate IS NULL`. So a foreign VO whose report is ALREADY SENT is
 * excluded for a reason that has nothing to do with authorization, and a count of 0 proves nothing.
 * Every fixture here must be an **unsent, unarchived** report — `unsentReportsFor()` enforces that —
 * and the admin control re-posts the SAME id to show it really was eligible.
 *
 * **The fixture pool is consumable.** Marking a report sent is forward-only with no client-reachable
 * undo, so each mutating run burns one own-VO report and (in the admin control) one foreign report.
 * `unsentReportsFor()` reports the remaining pool so a run can skip rather than fail when it dries up.
 *
 * **Traps:** `/therapy_reports` exposes only `prescription.therapist` and `prescription.patient` as
 * filters — there is none for `sent`/`archived`, so the pool is filtered client-side; an embedded
 * `therapist` carries `@id` but **no bare `id`**, so owner comparison goes through `fullName` or the
 * IRI; and the mark-sent trail is `type=field_change` with `therapyReportStatus` only in the meta,
 * which no filter reaches — the collection holds **463k** field_change rows, so a full-history sweep
 * is not affordable and `markSentLogs()` scans a bounded recent window instead.
 */

export type ReportRow = { id: number; prescriptionId: number; sent: boolean; archived: boolean };

export type MarkSentLog = {
  at: string;
  prescriptionId: number;
  byId: number | null;
  byName: string | null;
};

/** `BulkPostMarkSentController::MAX_BULK_IDS` — the batch guard shared with the other bulk routes. */
export const MAX_BULK_IDS = 500;

export class BulkMarkSentScopePage {
  private bearerCache = new Map<string, string>();

  constructor(private request: APIRequestContext) {}

  async tokenFor(creds: Credentials): Promise<string> {
    const hit = this.bearerCache.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()}`);
    const token = (await res.json()).token as string;
    this.bearerCache.set(creds.email, token);
    return token;
  }

  therapistToken = () => this.tokenFor(STAGING_CREDENTIALS.therapist);
  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);

  private async get<T>(path: string, token: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  /** Who the caller is, so the fixture can be stated in ids rather than assumed. */
  async me(token: string): Promise<{ id: number; roles: string[] }> {
    const body = await this.get<{ id: number; roles: string[] }>('/me', token);
    return { id: body.id, roles: body.roles ?? [] };
  }

  /**
   * Reports for one therapist that the endpoint would actually act on.
   *
   * Unsent AND unarchived — see the class docblock: any other report is excluded by a non-authorization
   * clause, which would make a zero count meaningless as evidence.
   */
  async unsentReportsFor(therapistId: number, token: string): Promise<ReportRow[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/therapy_reports?prescription.therapist=${therapistId}&itemsPerPage=300`,
      token,
    );
    return body.member
      .filter((r) => !r.sent && !r.archived)
      .map((r) => ({
        id: r.id,
        prescriptionId: Number(String(r.prescription ?? '').split('/').pop()),
        sent: Boolean(r.sent),
        archived: Boolean(r.archived),
      }))
      .filter((r) => Number.isFinite(r.prescriptionId));
  }

  async report(reportId: number, token: string): Promise<ReportRow> {
    const r = await this.get<Record<string, any>>(`/therapy_reports/${reportId}`, token);
    return {
      id: r.id,
      prescriptionId: Number(String(r.prescription ?? '').split('/').pop()),
      sent: Boolean(r.sent),
      archived: Boolean(r.archived),
    };
  }

  /** The mark-sent audit entries on one VO — the forged-trail check. */
  async markSentLogs(prescriptionId: number, token: string): Promise<MarkSentLog[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescription_logs?prescription=${prescriptionId}&type=field_change&itemsPerPage=100`,
      token,
    );
    return body.member
      .filter((l) => String(l.value ?? '').includes('therapyReportStatus'))
      .map((l) => ({
        at: String(l.createdAt ?? '').slice(0, 19),
        prescriptionId,
        byId: l.createdBy?.id ?? null,
        byName: l.createdBy?.fullName ?? null,
      }));
  }

  /** The VO's owning therapist, by name — an embedded relation carries no bare `id`. */
  async ownerName(prescriptionId: number, token: string): Promise<string | null> {
    const p = await this.get<Record<string, any>>(`/prescriptions/${prescriptionId}?groups%5B%5D=billing:read`, token);
    return p.therapist?.fullName ?? null;
  }

  /** The endpoint under test. Returns the status and the processed count. */
  async bulkMarkSent(ids: number[], token: string): Promise<{ status: number; count: number | null; detail: string }> {
    const res = await this.request.post(`${API_BASE}/prescriptions/report-send/bulk`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { id: ids },
      timeout: 120_000,
    });
    let count: number | null = null;
    let detail = '';
    try {
      const body = await res.json();
      count = typeof body?.count === 'number' ? body.count : null;
      detail = body?.detail ?? body?.message ?? '';
    } catch {
      /* a non-JSON error body */
    }
    return { status: res.status(), count, detail };
  }
}
