import { APIRequestContext, Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * VO soft deletion, exclusion, restore and anonymization — RC 3.14 epic #3670
 * (#3671 delete, #3672 exclusion, #3673 job skips, #3674 restore, #3675 anonymization).
 *
 * **The whole epic is deployed on staging** — `GET /status` reports `3.14.0` on the API and the
 * served entry bundle carries the delete dialog, the Gelöscht tab and #3674's restore dialog
 * (`parent_choice_keep`, "Die Frist von 30 Tagen"). Those are two independent deploys and both have
 * to be checked: `/status` says nothing about the frontend (#3705).
 *
 * **Deletion is a soft delete, so a delete/restore round trip is self-restoring** — which is what
 * makes this epic testable end to end rather than by inspection. `PrescriptionDeletionService`
 * stamps `deletedAt` and leaves `treatmentStatus` exactly as it was; `PrescriptionRestoreService`
 * clears the four deletion columns and puts the follow-up link back from the snapshot. Verified
 * live on 9634-17: delete → `deletedAt` set, status still `Abgelaufen`; restore → `deletedAt` null,
 * status `Abgelaufen`, back in every collection, counts back to their starting values.
 *
 * **What a round trip does NOT undo, and it is the reason every fixture here is chosen the way it
 * is:**
 *
 *  - **A draft invoice cancelled on delete stays cancelled.** #3671 AC 12 cancels every draft-tier
 *    invoice silently, and nothing un-cancels one. So a delete fixture must carry **no invoice at
 *    all** — `deletionPreflight().draftInvoice` must be null.
 *  - **A CHILD follow-up link is severed and never restored.** Delete nulls `followupPrescription`
 *    (#3671 AC 7) and restore only ever re-links the PARENT (#3674 AC 3 — the snapshot's `childId`
 *    is written but never read back). So a delete fixture must have `childLink === null`, and the
 *    gap itself is reported as a finding.
 *  - **Two `prescription_log` rows and one `PrescriptionDeletionRecord` are permanent**, by design
 *    (#3671 AC 13/14). That is the whole residue of a round trip.
 *
 * A parent link IS fully reversible: delete with `unchanged` + restore with `keep` puts the
 * parent's `followupStatus` and `receivedDate` back from `linkSnapshot`.
 *
 * ## The guardrail matrix is READ-ONLY
 *
 * `GET /prescriptions/{id}/deletion-preflight` runs the **same** `resolveBlocker()` the confirm
 * re-runs and writes nothing, so #3671 AC 2's three blocking conditions are driven over the live
 * population without deleting anything — the #3576 `preview-creation-validation` technique. Live
 * fixtures exist for all three, and two of them prove the PRECEDENCE, which no AC states and which
 * only shows up on a VO that satisfies more than one condition: VO 6523 (4207-2) is `validated`
 * **and** carries a sent invoice and reports `invoice_sent`; VO 6974 (4193-2) is `validated` **and**
 * batched and reports `billing_batch`.
 *
 * ## Traps
 *
 *  - **`?patient=` is silently ignored on `/prescriptions` and `/v2/prescriptions`** and returns the
 *    unfiltered 34k-row book, which reads exactly like "this patient has every VO". The registered
 *    filter is **`patient.id=`**. `assertPatientFilterPartitions()` proves it before any membership
 *    check is believed. (On `/activities` the registered name is `prescription[]`, and on
 *    `/therapy_reports` there is no per-VO filter at all — only `prescription.patient` and
 *    `prescription.therapist`.)
 *  - **`exists[deletedAt]=true` is the ONLY door to a deleted VO**, and it fails closed: a therapist
 *    sending the same filter gets `totalItems: 0`, because `PrescriptionNotDeletedExtension` adds
 *    its own `IS NULL` on top of the filter's `IS NOT NULL`. So an empty Gelöscht tab does not mean
 *    "nothing is deleted" unless the caller is an admin.
 *  - **A deleted VO's item read 404s for a therapist and 200s for an admin.** Both directions are
 *    part of AC 15/17 and of #3672's tablet arm.
 *  - **`POST /activities/bulk` takes a BARE JSON ARRAY**, not `{activities: […]}`, and each row
 *    needs its own `therapist` IRI — a wrapped payload answers 400 "expected a JSON array" and a
 *    row without a therapist answers 400 before the deleted-VO constraint is ever reached, which
 *    reads exactly like the constraint being absent. `POST /activities` itself is **405** (#3398's
 *    missing item operations are not the only gap on that resource).
 *  - **The deletion record is not an API resource** (`PrescriptionDeletionRecord` deliberately
 *    carries no `#[ApiResource]` — it is read by the DPO out of the database), so #3671 AC 14 has
 *    no client surface at all.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** AC 2's dialog heading, the one that replaces the confirmation step when a guardrail fires. */
export const BLOCKED_DIALOG_HEADING = 'VO kann nicht gelöscht werden';

/** `Prescription::DELETION_RESTORE_WINDOW_DAYS` — one constant behind the dialog, the banner, the restore guard and the nightly job. */
export const RESTORE_WINDOW_DAYS = 30;

/** `PrescriptionDeletionService` — AC 2's three blocking conditions, in the order it resolves them. */
export const BLOCKED = {
  invoiceSent: 'invoice_sent',
  billingBatch: 'billing_batch',
  validated: 'validated',
} as const;

/** `PrescriptionDeletionReasonEnum` — AC 9. `other` is the only one that additionally needs a note. */
export const DELETION_REASONS = ['duplicate', 'incorrect_data', 'other'] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/** `PrescriptionDeletionService::PARENT_CHOICES` — AC 6, what happens to the parent VO on delete. */
export const DELETE_PARENT_CHOICES = ['order', 'no_follow_up', 'unchanged'] as const;
export type DeleteParentChoice = (typeof DELETE_PARENT_CHOICES)[number];

/** `PrescriptionRestoreService::PARENT_CHOICES` — #3674 AC 3, what happens to it on restore. */
export const RESTORE_PARENT_CHOICES = ['keep', 'different', 'standalone'] as const;
export type RestoreParentChoice = (typeof RESTORE_PARENT_CHOICES)[number];

/** `PrescriptionRestoreService` — #3674 AC 5 / #3675 AC 4, why a restore is refused. */
export const RESTORE_BLOCKED = {
  notDeleted: 'not_deleted',
  windowExpired: 'window_expired',
  anonymized: 'anonymized',
} as const;

/**
 * Live fixtures, all re-verified by the specs that use them rather than trusted.
 *
 * The three blocked ones are ordinary production-shaped VOs and are only ever READ. The two
 * mutating ones belong to obvious QA patients ("Offline Testpatient S3", "KimNamjoon Test") and
 * satisfy the round-trip conditions in the class docblock: no invoice, no child link, no batch.
 */
export const FIXTURES = {
  /** AC 2 — a sent invoice (426-14). Also carries a parent AND a child, so it can never be a delete fixture. */
  blockedByInvoice: { id: 28106, vo: '5674-9', invoiceNumber: '426-14' },
  /** AC 2 — in billing batch E-2026-857-001, and `validated` as well: the batch wins. */
  blockedByBatch: { id: 6974, vo: '4193-2', batchName: 'E-2026-857-001' },
  /** AC 2 — `validated` with nothing else on it, so this is the only one of the three that isolates that arm. */
  blockedByValidation: { id: 1719, vo: '3188-1' },
  /** AC 2 precedence — `validated` AND invoiced; must report `invoice_sent`. */
  validatedAndInvoiced: { id: 6523, vo: '4207-2' },

  /** The delete/restore round-trip fixture: QA patient, 2 documented treatments, no links, no invoice. */
  roundTrip: { id: 30493, vo: '905301-1', patientId: 7826, therapistId: 198, therapistName: 'Jhenqa Test' },
  /** A second clean QA VO, used where the round-trip one is already in play. */
  spare: { id: 34187, vo: '9634-17', patientId: 8430 },
  /** #3674 AC 3 — a follow-up whose PARENT link is the thing under test; no child of its own. */
  childWithParent: { id: 34170, vo: '9634-11', patientId: 8430, parentId: 34162, parentVo: '9634-10' },
  /** #3671 AC 7 — a VO that is a PARENT. Read-only here: deleting it would sever a link restore never puts back. */
  withChildLink: { id: 34162, vo: '9634-10', childId: 34170, childVo: '9634-11' },

  // ── #3675 — the three FT fixtures the dev's 2026-09-22 back-date-and-run left behind ──
  //
  // All three belong to QA patient 8950 ("FT-PKV Control-Sep22") and were deleted within the same
  // minute (09:25–09:26 UTC on 2026-09-22); two were then back-dated with raw SQL, which is the
  // only way a `deletedAt` older than the epic's own deploy can exist. They are read ONLY — the
  // anonymized one cannot be written to at all, and un-deleting the candidate would destroy the
  // single live instance of the state this ticket is about.

  /** The FIRST anonymized VO in Flow. `app:prescription:anonymize-deleted`, 2026-09-22 10:22 UTC. */
  anonymized: {
    id: 34978,
    vo: '99653-2',
    patientId: 8950,
    /** From the PM's run notes; not client-readable — every admin door adds `anonymizedAt IS NULL`. */
    anonymizedAt: '2026-09-22T10:22:23+00:00',
  },
  /** Deleted in the same minute and NOT back-dated: the control that keeps every AC 4 / AC 2 zero honest. */
  anonymizeControl: { id: 34979, vo: '99653-3', patientId: 8950 },
  /**
   * Back-dated to 2026-08-22 as #3674 AC 5's expired-window fixture, and so, incidentally, the
   * first VO the NIGHTLY job ever had to act on by itself. Watched across the boundary on
   * 2026-09-23: readable at 03:16:02Z, `404` at 03:18:07Z with the Gelöscht tab down 7 → 6.
   *
   * It is the more valuable of the two anonymized fixtures, for two reasons: its scrub was
   * unattended (the other was a hand-run command), and its number carried the HIGHEST suffix on
   * its patient, which is the only arrangement that can show what anonymizing does to the VO-number
   * allocator. It did: `next-id` went 99653-5 → 99653-4. See the FINDING test.
   */
  anonymizedByNightly: { id: 34980, vo: '99653-4', patientId: 8950, deletedAt: '2026-08-22T09:26:31+00:00' },
} as const;

export type DeletionPreflight = {
  blocked: { type: string; invoiceNumber?: string | null; batchName?: string | null } | null;
  summary: {
    prescriptionEntityId: number;
    prescriptionId: string | null;
    patientName: string | null;
    treatmentStatus: string | null;
    therapistName: string | null;
    entityName: string | null;
  };
  documentedTreatments: number;
  parentLink: { id: number; prescriptionId: string | null; followupStatus: string | null } | null;
  childLink: { id: number; prescriptionId: string | null } | null;
  documentCount: number;
  draftInvoice: { id: number; invoiceNumber: string | null } | null;
  restoreWindowDays: number;
};

export type RestorePreflight = {
  blocked: { type: string } | null;
  summary: {
    prescriptionEntityId: number;
    prescriptionId: string | null;
    patientName: string | null;
    treatmentStatus: string | null;
    deletedAt: string | null;
    deletedByName: string | null;
    restorableUntil: string | null;
  };
  previousParent: {
    id: number;
    prescriptionId: string | null;
    snapshotFollowupStatus: string | null;
    currentFollowupStatus: string | null;
    keepAvailable: boolean;
    keepUnavailableReason: string | null;
  } | null;
  restoreWindowDays: number;
};

export type DashboardCounts = {
  received: number;
  noFollowUp: number;
  completed: number;
  forReview: number;
  all: number;
  allWithArchived: number;
  deleted: number;
};

export type PrescriptionRow = {
  id: number;
  prescriptionId?: string | null;
  treatmentStatus?: string | null;
  followupStatus?: string | null;
  receivedDate?: string | null;
  validationStatus?: string | null;
  deletedAt?: string | null;
  deletionReason?: string | null;
  deletionReasonNote?: string | null;
  activityCount?: number | null;
  followupPrescription?: { id?: number; prescriptionId?: string } | string | null;
};

export type LogRow = {
  id: number;
  type: string | null;
  reason: string | null;
  createdAt: string | null;
  createdByName: string | null;
  meta: Record<string, unknown> | null;
};

export type ApiResult<T> = { status: number; body: T | null };

export class VoDeletionPage {
  private bearerCache = new Map<string, string>();

  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async tokenFor(creds: Credentials): Promise<string> {
    const hit = this.bearerCache.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      // The field is `username` even though the value is an address (#3460's migration note).
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()} ${await res.text()}`);
    const token = (await res.json()).token as string;
    this.bearerCache.set(creds.email, token);
    return token;
  }

  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);
  therapistToken = () => this.tokenFor(STAGING_CREDENTIALS.therapist);

  // ─────────────────────────────── plumbing ───────────────────────────────

  /** A GET that reports its status rather than throwing, because several assertions here ARE the status. */
  async raw<T>(path: string, token: string): Promise<ApiResult<T>> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status(), body: body as T | null };
  }

  private async get<T>(path: string, token: string): Promise<T> {
    const { status, body } = await this.raw<T>(path, token);
    if (status < 200 || status >= 300) throw new Error(`GET ${path} -> ${status} ${JSON.stringify(body)?.slice(0, 200)}`);
    return body as T;
  }

  private async patch<T>(path: string, data: unknown, token: string): Promise<ApiResult<T>> {
    const res = await this.request.patch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json' },
      data: data as Record<string, unknown>,
      timeout: 180_000,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status(), body: body as T | null };
  }

  private async post<T>(path: string, data: unknown, token: string): Promise<ApiResult<T>> {
    const res = await this.request.post(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: data as Record<string, unknown>,
      timeout: 180_000,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status(), body: body as T | null };
  }

  private static members<T>(body: unknown): T[] {
    const d = body as { member?: T[]; 'hydra:member'?: T[] } | T[] | null;
    if (Array.isArray(d)) return d;
    return d?.member ?? d?.['hydra:member'] ?? [];
  }

  private static total(body: unknown): number {
    const d = body as { totalItems?: number; 'hydra:totalItems'?: number } | null;
    return d?.totalItems ?? d?.['hydra:totalItems'] ?? 0;
  }

  // ─────────────────────────── #3671 delete ───────────────────────────

  deletionPreflightRaw = (voId: number, token: string) =>
    this.raw<DeletionPreflight>(`/prescriptions/${voId}/deletion-preflight`, token);

  deletionPreflight = (voId: number, token: string) =>
    this.get<DeletionPreflight>(`/prescriptions/${voId}/deletion-preflight`, token);

  /**
   * `PATCH /prescriptions/{id}/delete`.
   *
   * A Patch with a body rather than a Doctrine DELETE: the row survives 30 days for #3674, and the
   * body carries the reason, the optional note and the parent choice. `deserialize: false` on the
   * operation means none of it is merge-patched onto the entity.
   */
  deleteVo(
    voId: number,
    payload: { reason?: string; note?: string; parentChoice?: string },
    token: string,
  ): Promise<ApiResult<PrescriptionRow & { blocked?: { type: string }; message?: string }>> {
    return this.patch(`/prescriptions/${voId}/delete`, payload, token);
  }

  // ─────────────────────────── #3674 restore ───────────────────────────

  restorePreflightRaw = (voId: number, token: string) =>
    this.raw<RestorePreflight>(`/prescriptions/${voId}/restore-preflight`, token);

  restorePreflight = (voId: number, token: string) =>
    this.get<RestorePreflight>(`/prescriptions/${voId}/restore-preflight`, token);

  restoreVo(
    voId: number,
    payload: { parentChoice?: string; parentId?: number },
    token: string,
  ): Promise<ApiResult<PrescriptionRow & { blocked?: { type: string }; message?: string }>> {
    return this.patch(`/prescriptions/${voId}/restore`, payload, token);
  }

  /**
   * Restore a VO no matter how a test left it, for an `afterAll` that must not itself fail.
   *
   * Returns what it found, so the caller can log the outcome instead of swallowing it. Deliberately
   * tolerant of `not_deleted`: a test that already restored has nothing to undo.
   */
  async ensureRestored(voId: number, parentChoice: RestoreParentChoice, token: string): Promise<string> {
    const vo = await this.raw<PrescriptionRow>(`/prescriptions/${voId}`, token);
    if (vo.status !== 200) return `GET /prescriptions/${voId} -> ${vo.status}, nothing to do`;
    if (!vo.body?.deletedAt) return 'already live';
    const res = await this.restoreVo(voId, { parentChoice }, token);
    return `restore -> ${res.status} deletedAt=${res.body?.deletedAt ?? 'null'}`;
  }

  // ─────────────────────── reads used across the epic ───────────────────────

  prescription = (voId: number, token: string) => this.raw<PrescriptionRow>(`/prescriptions/${voId}`, token);

  async dashboardCounts(token: string): Promise<DashboardCounts> {
    return this.get<DashboardCounts>('/prescriptions/dashboard-counts', token);
  }

  /** The Gelöscht tab's own request: `exists[deletedAt]=true`, the one door past the default exclusion. */
  async deletedTab(token: string, itemsPerPage = 50): Promise<{ total: number; rows: PrescriptionRow[] }> {
    const body = await this.get<unknown>(`/prescriptions?exists%5BdeletedAt%5D=true&itemsPerPage=${itemsPerPage}`, token);
    return { total: VoDeletionPage.total(body), rows: VoDeletionPage.members<PrescriptionRow>(body) };
  }

  /** Same request a non-admin can send. Must fail closed — see the class docblock. */
  deletedTabRaw = (token: string) => this.raw<unknown>('/prescriptions?exists%5BdeletedAt%5D=true&itemsPerPage=5', token);

  async prescriptionsForPatient(patientId: number, token: string): Promise<{ total: number; ids: number[] }> {
    const body = await this.get<unknown>(`/prescriptions?patient.id=${patientId}&itemsPerPage=100`, token);
    return { total: VoDeletionPage.total(body), ids: VoDeletionPage.members<PrescriptionRow>(body).map((m) => m.id) };
  }

  async v2ForPatient(patientId: number, token: string): Promise<{ total: number; ids: number[] }> {
    const body = await this.get<unknown>(`/v2/prescriptions?patient.id=${patientId}&itemsPerPage=100`, token);
    return { total: VoDeletionPage.total(body), ids: VoDeletionPage.members<{ id: number }>(body).map((m) => m.id) };
  }

  /**
   * Proves `patient.id` actually partitions before any "the VO is gone" claim is believed.
   *
   * `?patient=` is accepted and IGNORED on both collections (it returns the whole 34k book), so a
   * membership check written against it silently says "present" for every VO in the system.
   */
  async patientFilterPartitions(patientId: number, token: string): Promise<{ scoped: number; ignored: number; book: number }> {
    const scoped = VoDeletionPage.total(await this.get<unknown>(`/prescriptions?patient.id=${patientId}&itemsPerPage=1`, token));
    const ignored = VoDeletionPage.total(await this.get<unknown>(`/prescriptions?patient=${patientId}&itemsPerPage=1`, token));
    const book = VoDeletionPage.total(await this.get<unknown>('/prescriptions?itemsPerPage=1', token));
    return { scoped, ignored, book };
  }

  /** `GET /activities?prescription[]=` — the collection the therapist tablet pulls. */
  async activitiesFor(voId: number, token: string): Promise<number> {
    return VoDeletionPage.total(await this.get<unknown>(`/activities?prescription%5B%5D=${voId}&itemsPerPage=1`, token));
  }

  /** `GET /invoices?prescription=` — the PKV / copayment lists' backing collection. */
  async invoicesFor(voId: number, token: string): Promise<number> {
    return VoDeletionPage.total(await this.get<unknown>(`/invoices?prescription=${voId}&itemsPerPage=1`, token));
  }

  /** The Document Center's own rows (`DocumentCenterRowProvider`, an explicit `p.deletedAt IS NULL`). */
  async documentCenterTotal(token: string): Promise<number> {
    return VoDeletionPage.total(await this.get<unknown>('/document_center/documents?itemsPerPage=1', token));
  }

  /** The F.VO linking lists. Both need `patient` AND `issueDate`, or they answer 400. */
  async childVoCandidates(patientId: number, issueDate: string, token: string): Promise<number[]> {
    const body = await this.get<unknown>(`/prescriptions/child-vo-candidates?patient=${patientId}&issueDate=${issueDate}`, token);
    return VoDeletionPage.members<{ id: number }>(body).map((m) => m.id);
  }

  async parentVoCandidates(patientId: number, issueDate: string, token: string): Promise<number[]> {
    const body = await this.get<unknown>(`/prescriptions/parent-vo-candidates?patient=${patientId}&issueDate=${issueDate}`, token);
    return VoDeletionPage.members<{ id: number }>(body).map((m) => m.id);
  }

  /** `exact[prescriptionId]` — does this VO NUMBER still resolve to anything at all? */
  async findByNumber(number: string, token: string): Promise<number[]> {
    const body = await this.get<unknown>(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`, token);
    return VoDeletionPage.members<{ id: number }>(body).map((m) => m.id);
  }

  /**
   * The SAME search scoped to the Gelöscht door — the only one that shows a deleted VO's number at
   * all. `exists[deletedAt]=true` carries the extension's `anonymizedAt IS NULL` with it.
   */
  async findDeletedByNumber(number: string, token: string): Promise<number[]> {
    const body = await this.get<unknown>(
      `/prescriptions?exists%5BdeletedAt%5D=true&exact%5BprescriptionId%5D=${encodeURIComponent(number)}`,
      token,
    );
    return VoDeletionPage.members<{ id: number }>(body).map((m) => m.id);
  }

  /**
   * `/therapy_reports` registers NO per-VO filter — only `prescription.patient` and
   * `prescription.therapist` — so AC 2's therapy-report clause is read per PATIENT and is only
   * meaningful on a patient whose every VO is in play (which 8950's are).
   */
  async therapyReportsForPatient(patientId: number, token: string): Promise<number> {
    return VoDeletionPage.total(await this.get<unknown>(`/therapy_reports?prescription.patient=${patientId}&itemsPerPage=1`, token));
  }

  /** #3672 AC 4 — the VO-number allocator, the one read that must KEEP seeing deleted VOs. */
  async nextPrescriptionId(patientId: number, token: string): Promise<string | null> {
    const body = await this.get<{ nextPrescriptionId?: string }>(`/prescriptions/next-id?patient=${patientId}`, token);
    return body.nextPrescriptionId ?? null;
  }

  /** The VO's Verlauf. `prescription_logs` is NOT one of the extension's via-prescription arms, so it stays readable. */
  async logs(voId: number, token: string): Promise<LogRow[]> {
    const body = await this.get<unknown>(`/prescription_logs?prescription=${voId}&itemsPerPage=50`, token);
    return VoDeletionPage.members<Record<string, unknown>>(body).map((m) => ({
      id: m.id as number,
      type: (m.type as string) ?? null,
      reason: (m.reason as string) ?? null,
      createdAt: (m.createdAt as string) ?? null,
      createdByName:
        typeof m.createdBy === 'object' && m.createdBy !== null
          ? ((m.createdBy as { fullName?: string }).fullName ?? null)
          : ((m.createdBy as string) ?? null),
      meta: (m.meta as Record<string, unknown>) ?? null,
    }));
  }

  /**
   * #3672 AC 3 — the offline replay. A bare JSON ARRAY, each row carrying its own therapist IRI.
   *
   * On a deleted VO this must answer **422** with the `controls.activity.vo_deleted` violation and
   * write nothing; a wrapped payload or a missing therapist answers 400 first and proves nothing.
   */
  postActivityAgainst(voId: number, therapistId: number, token: string, date = '2026-09-17T08:00:00+00:00') {
    return this.post<{ violations?: { propertyPath: string; message: string }[] }>(
      '/activities/bulk',
      [
        {
          prescription: `/prescriptions/${voId}`,
          therapist: `/users/${therapistId}`,
          date,
          treatmentType: 'done',
          note: '#3672 AC3 probe — must be refused',
        },
      ],
      token,
    );
  }

  /**
   * #3671 AC 18 — the bulk status writer, probed with an id that matches nothing.
   *
   * `findBy(['id' => …])` returns an empty set so the loop body never runs and nothing is written
   * (#3561's technique); what the call still proves is whether the status VALUE is accepted at all.
   */
  bulkStatus(ids: number[], treatmentStatus: string, token: string) {
    return this.post<{ count: number }>('/prescriptions/status/bulk', { id: ids, treatmentStatus }, token);
  }

  // ─────────────────────────── the deployed bundle ───────────────────────────

  async entryBundle(): Promise<string> {
    const html = await (await this.request.get(`${STAGING_WEB}/`, { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3670: no entry bundle in the served HTML');
    return await (await this.request.get(`${STAGING_WEB}${src}`, { timeout: 240_000 })).text();
  }

  static occurrences(bundle: string, needle: string): number {
    return bundle.split(needle).length - 1;
  }

  /**
   * A German literal as the bundle actually stores it.
   *
   * Metro escapes every non-ASCII character, so a grep for `"Gelöscht"` returns 0 and reads exactly
   * like "never shipped" (#3611). `Gel\xf6scht` is what is really in the file.
   *
   * **Two escape forms, and getting this wrong fakes a failure.** Latin-1 characters use `\xNN`
   * (`ö` → `\xf6`), but anything above U+00FF uses `\uXXXX` — and this epic's strings are full of
   * them: the restore refusal contains an EM DASH (`—` → `—`) and the delete dialog's parent
   * choices contain German quotation marks (`„` → `„`, `“` → `“`). A `\x`-only converter
   * reports 0 occurrences for those and reads as "the string never shipped".
   */
  static escaped(literal: string): string {
    return [...literal]
      .map((c) => {
        const code = c.codePointAt(0) ?? 0;
        if (code < 128) return c;
        if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
        return `\\u${code.toString(16).padStart(4, '0')}`;
      })
      .join('');
  }

  static escapedCount(bundle: string, literal: string): number {
    return VoDeletionPage.occurrences(bundle, VoDeletionPage.escaped(literal));
  }

  // ─────────────────────────────── the screen ───────────────────────────────

  /**
   * Open a VO's edit form and wait until it has actually painted.
   *
   * Two reasons this is a helper rather than a `goto`. First, the form is slow and paints in
   * stages, so looking for "Löschen" straight away resolves 0 elements and the failure says
   * "the action is missing" when the page simply had not finished — which is how a run that passed
   * an hour earlier fails on a busier staging. Waiting on the VO NUMBER first splits those two
   * cases apart. Second, **one form per test**: the app does not remount on a navigation between
   * two `/vo-management/{id}/edit` URLs (the trap #3535 records), so a second call in the same test
   * finds nothing at all.
   */
  async openVoForm(voId: number, timeoutMs = 180_000): Promise<void> {
    const page = this.requirePage();
    await page.goto(`${STAGING_WEB}/vo-management/${voId}/edit?id=${voId}`, { waitUntil: 'domcontentloaded' });
    // "Speichern" is the form's own action row and is on every VO regardless of its state, so it
    // separates "the page has not painted" from "this VO offers no Löschen". The VO NUMBER is not a
    // usable readiness signal: it renders as an exact leaf on some VOs and only inside a larger
    // string on others, so waiting for it times out on a form that is fully painted.
    await page.getByText('Speichern', { exact: true }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByText(GERMAN.deleteAction, { exact: true }).first().waitFor({ state: 'visible', timeout: 90_000 });
  }

  /**
   * Click "Löschen" and wait for whichever dialog it opens.
   *
   * **Retried, because a single click is not reliable here.** The form keeps repainting as its
   * validation panel and its related-VO lists land, and a click that arrives mid-repaint is
   * swallowed — no dialog, no error, and the wait that follows then reports "element(s) not found",
   * which reads exactly like the action being broken. (Same shape as #3400's date-basis popover.)
   *
   * Returns which of the two opened: the confirmation step, or AC 2's blocking message.
   */
  async openDeleteDialog(attempts = 4): Promise<'confirm' | 'blocked'> {
    const page = this.requirePage();
    const confirm = page.getByText(GERMAN.dialogTitle, { exact: true }).first();
    const blocked = page.getByText(BLOCKED_DIALOG_HEADING, { exact: true }).first();

    for (let i = 0; i < attempts; i++) {
      await page.getByText(GERMAN.deleteAction, { exact: true }).first().click();
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (await blocked.isVisible().catch(() => false)) return 'blocked';
        if (await confirm.isVisible().catch(() => false)) return 'confirm';
        await page.waitForTimeout(500);
      }
    }
    throw new Error(`#3671: "${GERMAN.deleteAction}" opened no dialog after ${attempts} attempts`);
  }

  /** The Admin Board's tab strip. The Gelöscht tab is AC 15's subject and sits last, after "Alle inkl. Archivierte". */
  async boardTabLabels(): Promise<string[]> {
    const page = this.requirePage();
    const strip = page.locator('div[role="tablist"], [data-testid="dashboard-tabs"]').first();
    const text = (await strip.count())
      ? await strip.innerText()
      : await page.locator('body').innerText();
    return text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('VoDeletionPage was constructed without a Page — UI helpers are unavailable');
    return this.page;
  }
}

/**
 * The German the epic ships, checked against the DEPLOYED dictionary rather than `de.json` in the
 * repo. Every one of these is stored escaped in the bundle — see `escaped()`.
 */
export const GERMAN = {
  tabDeleted: 'Gelöscht',
  tabAllWithArchived: 'Alle inkl. Archivierte',
  deleteAction: 'Löschen',
  restoreAction: 'Wiederherstellen',
  dialogTitle: 'VO löschen',
  acknowledge: 'Ich habe die Folgen verstanden und möchte diese VO löschen.',
  blockedInvoice: 'Diese VO hat die Rechnung {{invoiceNumber}}. Stornieren Sie zuerst die Rechnung (Storno), dann können Sie die VO löschen.',
  blockedBatch: 'Diese VO ist Teil des Abrechnungslaufs {{batchName}}. Entfernen Sie sie zuerst aus dem Abrechnungslauf.',
  blockedValidated: 'Diese VO ist für die Abrechnung validiert. Setzen Sie zuerst die Abrechnungsvalidierung zurück.',
  treatmentsWarning:
    'Diese VO hat {{count}} dokumentierte Behandlungen. Sie werden mit der VO gelöscht und aus allen Berichten und KPIs entfernt. Stellen Sie sicher, dass tatsächlich durchgeführte Behandlungen zuerst auf der richtigen VO dokumentiert werden.',
  childInfo: 'Diese VO ist mit einer Folge-VO verknüpft. Die Verknüpfung wird entfernt; die Folge-VO bleibt als eigenständige VO bestehen.',
  documentsInfo: 'An dieser VO hinterlegte Dokumente werden zusammen mit ihr gelöscht.',
  restoreWindow: 'Die VO kann innerhalb von {{days}} Tagen wiederhergestellt werden. Danach werden ihre Patientendaten endgültig entfernt.',
  deletedBanner: 'Gelöscht am {{date}} von {{name}}, Grund: {{reason}}, wiederherstellbar bis {{until}}',
  reasonDuplicate: 'Doppelte VO',
  reasonIncorrect: 'Fehlerhafte Daten',
  reasonOther: 'Anderer Grund',
  voDeleted: 'VO wurde gelöscht',
  restoreTitle: 'VO wiederherstellen',
  restoreWindowExpired: 'Die Frist von 30 Tagen ist abgelaufen — diese VO kann nicht mehr wiederhergestellt werden.',
  restoreAnonymized: 'Die Daten dieser VO wurden bereits endgültig entfernt.',
  restoreKeepParent: 'Verknüpfung mit VO {{parentVo}} beibehalten',
  restoreStandalone: 'Ohne Verknüpfung wiederherstellen',
  restoreDifferent: 'Andere Vorgänger-VO suchen',
} as const;

/**
 * i18n keys the epic adds. A translated string nothing references is not shipped behaviour (#3337).
 *
 * **Two shapes, and they are not interchangeable.** A dotted path only appears in the bundle when a
 * component passes it to `translate()` as a literal — `dashboard.tabs.deleted` and
 * `vo_management.restore.parent_choice_keep` do. The DICTIONARY itself stores keys nested, so a
 * leaf like `vo_deleted` appears twice (de + en) while its full path `controls.activity.vo_deleted`
 * appears **zero** times: that one is never written out in code because the API returns it as the
 * violation message and the frontend translates whatever it is handed. A search for the full path
 * therefore reads as "the string was never shipped" when it is shipped and working.
 */
export const I18N_KEYS = {
  tab: 'dashboard.tabs.deleted',
  pill: 'dashboard.pills.deleted',
  /** Leaf only — the full path `controls.activity.vo_deleted` is nowhere in the bundle. See above. */
  activityRefusalLeaf: 'vo_deleted',
  /** What the API actually returns as the violation message. */
  activityRefusal: 'controls.activity.vo_deleted',
  deleteTitle: 'vo_management.delete.title',
  restoreTitle: 'vo_management.restore.title',
  keepChoice: 'vo_management.restore.parent_choice_keep',
  logDeleted: 'prescription_deleted',
  logRestored: 'prescription_restored',
} as const;
