import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Owner-parity between `PATCH /prescriptions/{id}/activate` and `/terminate` (RC 3.13 #3550).
 *
 * #3469 (SEC-05.4) gave activate a care-relationship gate — an unrelated caller gets **404**,
 * existence non-disclosure. It left a residual: an **in-scope non-owner** (a therapist covering the
 * patient through a `SharedPatient` share) could still activate a follow-up VO belonging to someone
 * else. #3550 layers terminate's owner-or-admin rule after that gate, so an in-scope non-owner now
 * gets **403**.
 *
 * The two endpoints therefore answer a four-leg matrix, and the whole ticket is that matrix:
 *
 * | caller | activate | terminate |
 * |---|---|---|
 * | no care relationship at all | **404** | **403** |
 * | in-scope, not the owner | 403 | 403 |
 * | the owning therapist | reaches the body | reaches the body |
 * | admin | reaches the body | reaches the body |
 *
 * **Every leg is driven with an EMPTY body, and that is what makes this safe to run.** Both
 * controllers check authorization *before* parsing the payload, and both reject `{}` — activate
 * needs `activate`, terminate needs `immediate` + `reasons` — so "reached the body" registers as
 * **400** and no VO is ever activated or terminated. The refusals (403/404) never get that far
 * either. A test that sent a valid payload would have to terminate a real VO to prove a negative.
 *
 * **Why the in-scope leg needs a constructed fixture.** The dev's note on the PR is the key insight
 * and it is verified here rather than taken on trust: a test built like the terminate one — using an
 * unrelated colleague — proves nothing on activate, because that caller is stopped by the 404 gate
 * and never reaches the new rule. The caller must have a care relationship AND not own the VO.
 * `inScopeNonOwnerVo()` finds that pair from `/shared_patients`, whose rows read
 * `{ownerTherapist: <the sharer>, therapist: <the shared-with>, patient}` — so a row whose
 * `therapist` is our caller puts them in scope for a patient whose VOs belong to someone else.
 *
 * **Two silent-filter traps on `/prescriptions`, and they point opposite ways** (API Platform ignores
 * an unregistered filter and returns the UNFILTERED collection — 34,265 rows — which reads exactly
 * like "this patient has every VO"):
 *
 * | want | registered | silently ignored |
 * |---|---|---|
 * | by patient | **`patient.id=`** | `patient=`, `patientId=` |
 * | by therapist | **`therapist=`** | `therapist.id=`, `therapists.id=` |
 *
 * Note that is the mirror image of `/activities`, where `prescription=` is registered and
 * `prescription.id=` is ignored (#3533). Neither collection's convention predicts the other's;
 * `assertFiltersPartition()` proves both before any count is believed.
 */

export type Leg = { label: string; status: number; message: string };

/** The message the #3550 gate throws; also asserted to leak no patient data. */
export const ACTIVATE_DENIAL = 'You can only activate follow-ups for your own prescriptions.';

/** Terminate's long-standing equivalent, the idiom #3550 mirrors. */
export const TERMINATE_DENIAL = 'You can only cancel your own prescriptions.';

export class ActivateOwnerParityPage {
  constructor(private request: APIRequestContext) {}

  async tokenFor(creds: Credentials): Promise<string> {
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()}`);
    return (await res.json()).token;
  }

  therapistToken = () => this.tokenFor(STAGING_CREDENTIALS.therapist);
  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);

  private async json<T>(path: string, token: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  /**
   * One leg: PATCH with an empty body and report the status + message.
   *
   * Empty body by design — see the class docblock. This never changes a VO.
   */
  async leg(label: string, token: string, prescriptionId: number, endpoint: 'activate' | 'terminate'): Promise<Leg> {
    const res = await this.request.patch(`${API_BASE}/prescriptions/${prescriptionId}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json' },
      data: {},
      timeout: 60_000,
    });
    let message = '';
    try {
      const body = await res.json();
      message = body?.message ?? body?.detail ?? '';
    } catch {
      /* a 400 from BadRequestHttpException carries no JSON body */
    }
    return { label, status: res.status(), message };
  }

  /** `/users/{id}` for the caller behind a token, so the fixture can be stated in ids not names. */
  async me(token: string): Promise<{ id: number; roles: string[] }> {
    const body = await this.json<{ id: number; roles: string[] }>('/me', token);
    return { id: body.id, roles: body.roles ?? [] };
  }

  /**
   * Prove both filters partition before trusting any count they produce.
   *
   * An unregistered filter returns the whole collection, so a fixture search built on one finds
   * "every VO" and picks a wrong one — a failure that looks like real data.
   */
  async assertFiltersPartition(token: string): Promise<{ total: number; byPatient: number; byTherapist: number }> {
    const all = await this.json<{ totalItems: number }>('/prescriptions?itemsPerPage=1', token);
    const p = await this.json<{ totalItems: number }>('/prescriptions?patient.id=6001&itemsPerPage=1', token);
    const t = await this.json<{ totalItems: number }>('/prescriptions?therapist=198&itemsPerPage=1', token);
    return { total: all.totalItems, byPatient: p.totalItems, byTherapist: t.totalItems };
  }

  /**
   * A VO the caller is IN SCOPE for but does NOT own — the fixture the new rule needs.
   *
   * Reads `/shared_patients` for rows where the caller is the shared-WITH therapist, then takes a VO
   * of that patient whose own therapist is somebody else.
   */
  async inScopeNonOwnerVo(
    token: string,
    callerId: number,
  ): Promise<{ prescriptionId: number; voNumber: string; patientId: number; ownerId: number; shareId: number } | null> {
    const shares = await this.json<{ member: Record<string, any>[] }>('/shared_patients?itemsPerPage=3000', token);
    const mine = shares.member.filter((s) => s.therapist?.id === callerId);

    for (const share of mine) {
      const patientId = Number(String(share.patient ?? '').split('/').pop());
      if (!patientId) continue;
      const vos = await this.json<{ member: Record<string, any>[] }>(
        `/prescriptions?patient.id=${patientId}&itemsPerPage=20`,
        token,
      );
      const foreign = vos.member.find((v) => v.therapist?.id && v.therapist.id !== callerId);
      if (foreign) {
        return {
          prescriptionId: foreign.id,
          voNumber: foreign.prescriptionId,
          patientId,
          ownerId: foreign.therapist.id,
          shareId: share.id,
        };
      }
    }
    return null;
  }

  /** A VO the caller owns. */
  async ownedVo(token: string, callerId: number): Promise<{ prescriptionId: number; voNumber: string } | null> {
    const vos = await this.json<{ member: Record<string, any>[] }>(
      `/prescriptions?therapist=${callerId}&itemsPerPage=5`,
      token,
    );
    const own = vos.member.find((v) => v.therapist?.id === callerId);
    return own ? { prescriptionId: own.id, voNumber: own.prescriptionId } : null;
  }

  /**
   * A VO on a patient the caller has NO relationship to — the 404 leg.
   *
   * Confirmed negatively: the caller must not be able to READ it. An item read is scoped by
   * `CareRelationshipScopeExtension`, so a 404 there is the same non-disclosure the activate gate
   * applies, and it is a cheaper, side-effect-free way to establish "unrelated" than guessing.
   */
  async unrelatedVo(callerToken: string, adminToken: string, excludePatientIds: number[]): Promise<number | null> {
    const vos = await this.json<{ member: Record<string, any>[] }>('/prescriptions?itemsPerPage=40', adminToken);
    for (const v of vos.member) {
      const patientId = Number(String(v.patient?.['@id'] ?? v.patient ?? '').split('/').pop());
      if (!patientId || excludePatientIds.includes(patientId)) continue;
      const res = await this.request.get(`${API_BASE}/prescriptions/${v.id}`, {
        headers: { Authorization: `Bearer ${callerToken}` },
        timeout: 60_000,
      });
      if (res.status() === 404) return v.id;
    }
    return null;
  }

  /** The two fields either endpoint would move, for the no-write assertion. */
  async voState(prescriptionId: number, adminToken: string): Promise<{ treatmentStatus: string | null; followupStatus: string | null }> {
    const body = await this.json<Record<string, any>>(`/prescriptions/${prescriptionId}`, adminToken);
    return { treatmentStatus: body.treatmentStatus ?? null, followupStatus: body.followupStatus ?? null };
  }
}
