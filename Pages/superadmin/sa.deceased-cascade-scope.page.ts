import { APIRequestContext } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The deceased cascade must only cancel VOs still in progress — RC 3.14 #3731, commit `574922695`
 * on `release/3.14.0` (a `Ref` trailer, no PR), plus the one-time repair command
 * `app:prescription:correct-deceased-cancellations`, run on staging 2026-09-18 08:13 UTC.
 *
 * Marking a patient deceased ran every VO that was not already cancelled or archived through
 * `terminate()`, so VOs already billed, fully treated, expired or sent back to the therapist were
 * overwritten with **Abgebrochen** — unbilling finished work. The follow-up chain had the same
 * hole. The rule now lives in ONE place,
 * `PrescriptionStatusEnum::cancellableOnTermination() = [PENDING, IN_TREATMENT, ACTIVE, FOR_REVIEW]`,
 * read by the cascade, the follow-up chain, the undo snapshot AND both dialog endpoints.
 *
 * ## What is client-decidable, and how
 *
 * **The code fix, through the two dialog endpoints.** They are the only client surfaces that ask
 * "which VOs would a deceased marking terminate?", and the commit moved both from
 * `findActiveByPatient()` (everything but cancelled/archived) to `findCancellableByPatient()` (the
 * four in-progress statuses). On a patient holding both kinds the two rules give different answers,
 * so {@link activeVosCount} and {@link activeVosList} are a dual oracle for a fix that otherwise
 * only runs inside a write nobody should make. `/status` cannot help — it reports the release, not
 * the commit (#3704).
 *
 * **The repair, through its own log block.** Every restoration is a `field_change` on
 * `treatmentStatus` with `meta.type: automatic` and NO author, and the run wrote them in one
 * transaction — so they occupy a CONTIGUOUS id range ({@link CORRECTION_RUN}), which is what makes
 * all 76 readable individually and the whole run re-derivable rather than taken from the PM note.
 *
 * ## Traps
 *
 *  - **`/prescription_logs` cannot be listed unfiltered, and `type=field_change` 504s too** — that
 *    type alone holds ~460k rows (#3549). Only `type=prescription_termination` (3.6k) and
 *    `type=treatment_status_change` (161k) answer in bulk; everything else must be read per VO with
 *    `?prescription=`, or by id with the item GET (which, unlike `/invoice_logs/{id}`, exists).
 *  - **The repair wrote `field_change`, not `treatment_status_change`.** Walking the latter into the
 *    run's window finds NOTHING and reads exactly like "the command never ran".
 *  - **The log's `reason` column is not serialized.** The command's own cascade signature
 *    (`Kaskade: Eltern-VO … beendet`) is therefore invisible from the API, so the cascade-path VOs
 *    cannot be enumerated the way the command does — the id block is what covers them instead.
 *  - **43 VOs carry a NULL treatmentStatus** and the rule matches with `IN`, which no NULL
 *    satisfies — so they are never cancelled. That is deliberate ("nothing records what it would
 *    have to be restored to") and is why the ten statuses do not sum to the book.
 *  - **The deceased reason is free text.** The command matches the English `"deceased"` inside the
 *    termination log's value, and staging also holds `Patient verstorben`, `Pat. verstorben`,
 *    `verstorben`, `Pat. verstroben` … — this file mirrors the command's own substring so the
 *    population is the one the command acted on, not a wider guess.
 */

/** `PrescriptionStatusEnum::cancellableOnTermination()` — the only statuses a termination may overwrite. */
export const CANCELLABLE = ['Pending', 'Bereit', 'Aktiv', 'For Review'] as const;

/** AC1's "left unchanged" rows that are not already terminal. */
export const PROTECTED = ['Fertig Behandelt', 'Abgerechnet', 'Abgelaufen', 'Sent Back to Therapist'] as const;

/** Already terminal, and excluded before and after the fix. */
export const TERMINAL = ['Abgebrochen', 'Archiviert'] as const;

export const ALL_STATUSES = [...CANCELLABLE, ...PROTECTED, ...TERMINAL] as const;

/**
 * The repair run on staging: one contiguous block of `field_change` logs, all at one timestamp.
 *
 * Pinned rather than rediscovered because the block IS the run — an id outside it is somebody
 * else's edit, and the boundaries are what prove the run touched 76 VOs and no more.
 */
export const CORRECTION_RUN = {
  firstLogId: 891329,
  lastLogId: 891404,
  at: '2026-09-18T08:13:52',
  /** The dev's reported split, re-derived here rather than trusted. */
  restoredTo: { Abgelaufen: 50, Abgerechnet: 20, 'Fertig Behandelt': 6 } as Record<string, number>,
} as const;

/**
 * Patients holding BOTH a cancellable VO and a protected one — the only shape where the old rule
 * and the new one disagree, so the only shape that can decide whether the fix is live.
 */
export const DIALOG_FIXTURES = [
  { patient: 2128, cancellable: 1, oldRule: 5, note: 'Aktiv 1 + Fertig Behandelt 3 + Abgelaufen 1' },
  { patient: 1240, cancellable: 1, oldRule: 4, note: 'Aktiv 1 + Fertig Behandelt 3' },
  { patient: 1665, cancellable: 1, oldRule: 3, note: 'Aktiv 1 + Fertig Behandelt 1 + Abgelaufen 1' },
  { patient: 1499, cancellable: 1, oldRule: 2, note: 'Aktiv 1 + Sent Back to Therapist 1 — the rare status' },
  { patient: 96, cancellable: 1, oldRule: 2, note: 'Aktiv 1 + Fertig Behandelt 1' },
  { patient: 1471, cancellable: 1, oldRule: 2, note: 'Aktiv 1 + Fertig Behandelt 1' },
] as const;

export type LogRow = {
  id: number;
  type: string;
  createdAt: string;
  prescriptionId: number | null;
  oldValue: string | null;
  newValue: string | null;
  meta: Record<string, unknown> | null;
  author: string | null;
};

export class DeceasedCascadeScopePage {
  /** Shared across the file's page objects: one sign-in, and #3462 throttles `/auth` at 5/min. */
  private static sharedToken: string | null = null;

  constructor(private request: APIRequestContext) {}

  /** One token for the whole file — and a retry, because `/auth` itself 504s under load. */
  async bearer(): Promise<string> {
    if (DeceasedCascadeScopePage.sharedToken) return DeceasedCascadeScopePage.sharedToken;
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await this.request.post(`${API_BASE}/auth`, {
        headers: { 'Content-Type': 'application/json' },
        data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
        timeout: 90_000,
      });
      if (res.ok()) {
        DeceasedCascadeScopePage.sharedToken = (await res.json()).token as string;
        return DeceasedCascadeScopePage.sharedToken;
      }
      last = `POST /auth -> ${res.status()}`;
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
    throw new Error(last);
  }

  /** A GET with a retry — the log and VO collections are among staging's heaviest reads. */
  private async get<T>(path: string, attempts = 3): Promise<T> {
    let last: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
          timeout: 240_000,
        });
        if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
        return (await res.json()) as T;
      } catch (error) {
        last = error;
        if (attempt === attempts) break;
        await new Promise((r) => setTimeout(r, attempt * 5_000));
      }
    }
    throw new Error(`GET ${path} failed: ${String(last).slice(0, 180)}`);
  }

  // ───────────────────────────── statuses ─────────────────────────────

  async countByStatus(status: string): Promise<number> {
    const body = await this.get<{ totalItems?: number }>(
      `/prescriptions?treatmentStatus=${encodeURIComponent(status)}&itemsPerPage=1`,
    );
    return body.totalItems ?? -1;
  }

  async totalPrescriptions(): Promise<number> {
    return (await this.get<{ totalItems?: number }>('/prescriptions?itemsPerPage=1')).totalItems ?? -1;
  }

  /** Every VO of one patient, as `{status -> count}` plus the raw rows. */
  async patientVos(patientId: number): Promise<{ counts: Record<string, number>; rows: { id: number; vo: string; status: string | null }[] }> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?patient.id=${patientId}&itemsPerPage=200`,
    );
    const rows = (body.member ?? []).map((x) => ({
      id: x.id as number,
      vo: (x.prescriptionId as string) ?? '',
      status: (x.treatmentStatus as string) ?? null,
    }));
    const counts: Record<string, number> = {};
    for (const r of rows) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
    return { counts, rows };
  }

  // ───────────────────────────── the two dialog endpoints ─────────────────────────────

  /** `/patients/{id}/active-vos-count` — the number the therapist escalation dialog states. */
  async activeVosCount(patientId: number): Promise<number> {
    const body = await this.get<{ count?: number }>(`/patients/${patientId}/active-vos-count`);
    return body.count ?? -1;
  }

  /** `/patients/{id}/active-vos` — the list the "Als verstorben markieren" dialog shows. */
  async activeVosList(patientId: number): Promise<{ id: number; vo: string; status: string | null }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(`/patients/${patientId}/active-vos`);
    return (body.member ?? []).map((x) => ({
      id: x.id as number,
      vo: (x.prescriptionId as string) ?? '',
      status: (x.treatmentStatus as string) ?? null,
    }));
  }

  // ───────────────────────────── logs ─────────────────────────────

  private static toRow(l: Record<string, any>): LogRow {
    return {
      id: l.id as number,
      type: (l.type as string) ?? '',
      createdAt: ((l.createdAt as string) ?? '').slice(0, 19),
      prescriptionId: l.prescription ? Number(String(l.prescription).split('/').pop()) : null,
      oldValue: (l.oldValue as string) ?? null,
      newValue: (l.newValue as string) ?? null,
      meta: (l.meta as Record<string, unknown>) ?? null,
      author: (l.createdBy?.fullName as string) ?? null,
    };
  }

  /** One log by id — the item GET exists here, unlike `/invoice_logs/{id}` (#3473). */
  async log(id: number): Promise<LogRow> {
    return DeceasedCascadeScopePage.toRow(await this.get<Record<string, any>>(`/prescription_logs/${id}`));
  }

  /**
   * The whole correction block, read ONCE per file run and cached.
   *
   * Sequential in small batches rather than 76 parallel item GETs: a burst of that size draws a
   * 504 out of staging (seen on the first run of this file, on `/auth` of all things), which reads
   * as a failing assertion rather than as the load it is.
   */
  private static blockCache: LogRow[] | null = null;

  async correctionBlock(firstId: number, lastId: number): Promise<LogRow[]> {
    if (DeceasedCascadeScopePage.blockCache) return DeceasedCascadeScopePage.blockCache;
    const rows: LogRow[] = [];
    for (let id = firstId; id <= lastId; id += 8) {
      const batch: Promise<LogRow>[] = [];
      for (let n = id; n <= Math.min(id + 7, lastId); n++) batch.push(this.log(n));
      rows.push(...(await Promise.all(batch)));
    }
    DeceasedCascadeScopePage.blockCache = rows;
    return rows;
  }

  /** Every log of one VO. The only way to read `field_change` rows, which cannot be listed in bulk. */
  async logsFor(prescriptionId: number): Promise<LogRow[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescription_logs?prescription=${prescriptionId}&itemsPerPage=200`,
    );
    return (body.member ?? []).map(DeceasedCascadeScopePage.toRow);
  }

  /**
   * Every VO the deceased flow terminated, by the command's own signature: a
   * `prescription_termination` log whose value contains the English `"deceased"`.
   */
  async deceasedTerminations(): Promise<{ voId: number; at: string }[]> {
    const out: { voId: number; at: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.get<{ member: Record<string, any>[] }>(
        `/prescription_logs?type=prescription_termination&itemsPerPage=500&page=${page}`,
      );
      const rows = body.member ?? [];
      for (const l of rows) {
        const reasons = String((l.meta as any)?.reasons ?? '');
        if (!reasons.toLowerCase().includes('deceased')) continue;
        out.push({ voId: Number(String(l.prescription).split('/').pop()), at: String(l.createdAt).slice(0, 19) });
      }
      if (rows.length < 500) break;
    }
    return out;
  }

  /** Current status for many VOs at once — `id[]` is a registered filter on `/prescriptions`. */
  async statusOf(ids: number[]): Promise<Map<number, { vo: string; status: string | null }>> {
    const out = new Map<number, { vo: string; status: string | null }>();
    for (let i = 0; i < ids.length; i += 50) {
      const q = ids
        .slice(i, i + 50)
        .map((id) => `id%5B%5D=${id}`)
        .join('&');
      const body = await this.get<{ member: Record<string, any>[] }>(`/prescriptions?${q}&itemsPerPage=50`);
      for (const x of body.member ?? []) {
        out.set(x.id as number, { vo: (x.prescriptionId as string) ?? '', status: (x.treatmentStatus as string) ?? null });
      }
    }
    return out;
  }

  /** Seconds between two `YYYY-MM-DDTHH:MM:SS` stamps. */
  static secondsApart(a: string, b: string): number {
    return Math.abs(Date.parse(`${a}Z`) - Date.parse(`${b}Z`)) / 1000;
  }
}
