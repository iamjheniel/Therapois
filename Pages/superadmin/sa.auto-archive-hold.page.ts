import type { APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3795 — the nightly auto-archive keeps an unbilled expired VO until it is billed or,
 * for GKV, its billing deadline has passed.
 *
 * `app:prescription:auto-archive` is console-only, so the RUN has no client surface — but its
 * OUTCOME does, twice over:
 *
 *  - **What it archived.** `prescription_log` carries one `treatment_status_change` per archive
 *    with the reason `Auto-archived: Abgelaufen threshold of 90 days exceeded`, system-written
 *    with no author, stamped 20:46 UTC. That dates every run and names every VO it took.
 *  - **What it HELD.** A VO past 90 days that is still Abgelaufen is one the job deliberately
 *    left, and under the pre-fix rule no such VO could exist — the Abgelaufen population was a
 *    rolling 90-day window. So a single held VO, beside a run that demonstrably took others the
 *    same night, is the fix working.
 *
 * AC5 is decidable outright: the Duplikat worklist serves `billingDeadline`, and the two
 * candidate rules land on DIFFERENT DAYS — the new one on the last day of the month (inclusive),
 * the old one on the first of the next (#3507 AC2) — so one row settles it.
 */

export const API_BASE = 'https://api.staging.therapios.de';

/** The reason the archiver writes; AC2 requires it to be unchanged. */
export const ARCHIVE_REASON = 'Auto-archived: Abgelaufen threshold of 90 days exceeded';

export type Vo = {
  id: number;
  number: string;
  expiredAt: string | null;
  insuranceType: string | null;
  activityCount: number;
  billingBatchCount: number;
  hasInvoice: boolean;
  treatmentStatus: string;
};

export type ArchiveLog = {
  prescriptionId: number | null;
  from: string;
  to: string;
  at: string;
  reason: string;
  author: boolean;
};

export type WorklistRow = {
  prescriptionId: number;
  voNumber: string;
  duplikatStatus: string;
  billingDeadline: string | null;
  daysToDeadline: number | null;
};

/** ───────────────── the rule, ported ───────────────── */

/**
 * The last billable day: the last day of the month 9 months after the last signed session.
 *
 * Built with `Date.UTC(y, m - 1 + 9 + 1, 0)` — day 0 of the month AFTER the target, which is the
 * target's last day — so there is no month overflow. That is the whole point of the shared
 * helper: PHP's `+9 months` turns 31 May into 31 Feb -> 3 Mar, and `last day of this month` then
 * lands a month late (the ticket's own example: 31 May 2026 must give 28 Feb 2027).
 */
export function lastBillableDay(lastSignedIso: string): string {
  const [y, m] = lastSignedIso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + 9 + 1, 0)).toISOString().slice(0, 10);
}

/** The PRE-#3795 Duplikat deadline (#3507 AC2): first day of the month after, +9 months. */
export function legacyDuplikatDeadline(lastIso: string): string {
  const [y, m] = lastIso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + 1 + 9, 1)).toISOString().slice(0, 10);
}

/**
 * AC1 as a predicate: should the nightly job HOLD this VO back?
 *
 * `hasSignedSession` and `lastSigned` come from the caller, because "signed" is #3775's rule
 * (carried out, not Geplant, not a refusal without the patient's signature) and needs the VO's
 * activities. `billed` is not a separate condition — AC1 says so outright: billing is what moves
 * a VO out of Abgelaufen, so a VO that is still Abgelaufen is by definition not billed.
 */
export function shouldHold(o: {
  expiredDaysAgo: number;
  hasSignedSession: boolean;
  lastSigned: string | null;
  insuranceType: string | null;
  today: string;
}): boolean {
  if (o.expiredDaysAgo < 90) return true; // not yet eligible at all — held as today
  if (!o.hasSignedSession) return false;
  // The deadline condition is GKV only. PKV, Privat Basis, BG and VOs with no insurance type
  // have none, so they stay Abgelaufen until billed.
  if (o.insuranceType !== 'public') return true;
  if (!o.lastSigned) return true;
  return lastBillableDay(o.lastSigned) >= o.today;
}

export class AutoArchiveHoldPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  /** A GET that retries a 5xx AND a thrown transport error (a socket hang up throws, #3872). */
  private async get<T = any>(path: string): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
          timeout: 180_000,
        });
        if (res.ok()) return (await res.json()) as T;
        last = `status ${res.status()}`;
        if (res.status() < 500) break;
      } catch (e) {
        last = String(e).slice(0, 120);
      }
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  async totalItems(query: string): Promise<number> {
    const b = await this.get<{ totalItems?: number }>(`/prescriptions?${query}&itemsPerPage=1`);
    return b.totalItems ?? -1;
  }

  /**
   * Every VO in a status, walked.
   *
   * `expiredAt` is SERIALIZED but is NOT a registered filter in any form — `expiredAt[before]`,
   * `[after]`, `[strictly_before]`, `exists[expiredAt]` and a bare `expiredAt=` all return the
   * whole collection, byte-for-byte like a bogus key. So the 90-day population cannot be selected
   * server-side and has to be walked; `assertExpiredAtIsNotAFilter` proves that before any count
   * taken from it is believed.
   */
  async walkByStatus(status: string): Promise<Vo[]> {
    const out: Vo[] = [];
    let page = 1;
    let total = -1;
    for (;;) {
      const b = await this.get<{ totalItems: number; member: any[] }>(
        `/prescriptions?treatmentStatus=${encodeURIComponent(status)}&itemsPerPage=300&page=${page}`,
      );
      total = b.totalItems;
      const m = b.member ?? [];
      for (const v of m) {
        out.push({
          id: Number(v.id),
          number: String(v.prescriptionId ?? ''),
          expiredAt: v.expiredAt ? String(v.expiredAt) : null,
          insuranceType: v.insuranceType ?? null,
          activityCount: Number(v.activityCount ?? 0),
          billingBatchCount: Number(v.billingBatchCount ?? 0),
          hasInvoice: Boolean(v.invoice),
          treatmentStatus: String(v.treatmentStatus ?? ''),
        });
      }
      if (out.length >= total || m.length === 0) break;
      page++;
    }
    if (out.length !== total) throw new Error(`short walk of ${status}: ${out.length}/${total}`);
    return out;
  }

  /** `expiredAt` narrows nothing — asserted before the walk's counts are trusted. */
  async expiredAtFilterTotals(): Promise<Record<string, number>> {
    const base = 'treatmentStatus=Abgelaufen';
    const probes: Record<string, string> = {
      unfiltered: '',
      'expiredAt[before]': '&expiredAt[before]=2026-07-05',
      'expiredAt[after]': '&expiredAt[after]=2026-07-05',
      'expiredAt[strictly_before]': '&expiredAt[strictly_before]=2026-07-05',
      'exists[expiredAt]': '&exists[expiredAt]=true',
      bogusControl: '&zzzNotAFilter=1',
      'insuranceType (a REAL filter)': '&insuranceType=private',
    };
    const out: Record<string, number> = {};
    for (const [k, q] of Object.entries(probes)) out[k] = await this.totalItems(base + q);
    return out;
  }

  /**
   * The last SIGNED session per VO, batched.
   *
   * "Signed" is #3775's rule and the fields are `rejectedTreatment` /
   * `rejectedTreatmentWithSignature` — the short `rejected` / `rejectedWithSignature` do not
   * exist on an Activity, so a predicate written on them excludes nothing and silently degrades
   * to "the last treatment of any kind" (#3649, #3814). `lastAny` is returned beside it because
   * the pair is what makes the anchor change visible.
   */
  async lastSessions(ids: number[]): Promise<Map<number, { signed: string | null; any: string | null }>> {
    const out = new Map<number, { signed: string | null; any: string | null }>();
    for (const id of ids) out.set(id, { signed: null, any: null });
    for (let i = 0; i < ids.length; i += 60) {
      const q = ids.slice(i, i + 60).map((n) => `prescription[]=${n}`).join('&');
      const b = await this.get<{ member: any[] }>(`/activities?${q}&itemsPerPage=4000`);
      for (const a of b.member ?? []) {
        const pid = AutoArchiveHoldPage.idOf(a.prescription);
        if (pid === null || !a.date) continue;
        const d = String(a.date).slice(0, 10);
        const row = out.get(pid);
        if (!row) continue;
        if (!row.any || d > row.any) row.any = d;
        const planned = String(a.treatmentType ?? '') === 'planned';
        const signed = !planned && !(a.rejectedTreatment === true && a.rejectedTreatmentWithSignature !== true);
        if (signed && (!row.signed || d > row.signed)) row.signed = d;
      }
    }
    return out;
  }

  /**
   * The tail of the status-change log.
   *
   * `order[id]` is SILENTLY IGNORED on `/prescription_logs` and the collection is id-ascending
   * (#3800), so an `order[id]=desc` "newest N" read returns the OLDEST N — here that is 2025
   * history with no archiving in it, which reads exactly like the job never having run. Page from
   * `totalItems` instead.
   */
  async statusChangeTail(pages = 6): Promise<ArchiveLog[]> {
    const head = await this.get<{ totalItems: number }>(
      '/prescription_logs?type=treatment_status_change&itemsPerPage=1',
    );
    const per = 200;
    const last = Math.ceil(head.totalItems / per);
    const rows: ArchiveLog[] = [];
    for (let p = last; p > last - pages && p > 0; p--) {
      const b = await this.get<{ member: any[] }>(
        `/prescription_logs?type=treatment_status_change&itemsPerPage=${per}&page=${p}`,
      );
      for (const x of b.member ?? []) {
        rows.push({
          prescriptionId: AutoArchiveHoldPage.idOf(x.prescription),
          from: String(x.oldValue ?? ''),
          to: String(x.newValue ?? ''),
          at: String(x.createdAt ?? ''),
          reason: String(x.reason ?? x.meta?.reason ?? ''),
          author: Boolean(x.createdBy),
        });
      }
    }
    rows.sort((a, b) => a.at.localeCompare(b.at));
    return rows;
  }

  /**
   * The Duplikat worklist.
   *
   * TRAP: it wraps `rows` in a SINGLE Hydra member (#3774's shape), so the ordinary `member`
   * unwrap yields one element and a row scan finds nothing — which reads as an empty worklist.
   */
  async duplikatWorklist(): Promise<WorklistRow[]> {
    const b = await this.get<any>('/kpis/duplikat/worklist');
    const raw: any[] = b.rows ?? (Array.isArray(b.member) ? b.member[0]?.rows ?? [] : []);
    return raw.map((w) => ({
      prescriptionId: Number(w.prescriptionId),
      voNumber: String(w.voNumber ?? ''),
      duplikatStatus: String(w.duplikatStatus ?? ''),
      billingDeadline: w.billingDeadline ? String(w.billingDeadline).slice(0, 10) : null,
      daysToDeadline: w.daysToDeadline === null || w.daysToDeadline === undefined ? null : Number(w.daysToDeadline),
    }));
  }

  /** VOs by internal id, batched. */
  async byIds(ids: number[]): Promise<Vo[]> {
    const out: Vo[] = [];
    for (let i = 0; i < ids.length; i += 60) {
      const q = ids.slice(i, i + 60).map((n) => `id[]=${n}`).join('&');
      const b = await this.get<{ member: any[] }>(`/prescriptions?${q}&itemsPerPage=200`);
      for (const v of b.member ?? []) {
        out.push({
          id: Number(v.id),
          number: String(v.prescriptionId ?? ''),
          expiredAt: v.expiredAt ? String(v.expiredAt) : null,
          insuranceType: v.insuranceType ?? null,
          activityCount: Number(v.activityCount ?? 0),
          billingBatchCount: Number(v.billingBatchCount ?? 0),
          hasInvoice: Boolean(v.invoice),
          treatmentStatus: String(v.treatmentStatus ?? ''),
        });
      }
    }
    return out;
  }

  static idOf(iri: unknown): number | null {
    if (typeof iri === 'string') {
      const n = Number(iri.split('/').pop());
      return Number.isFinite(n) ? n : null;
    }
    if (iri && typeof iri === 'object' && 'id' in (iri as any)) return Number((iri as any).id);
    return null;
  }

  static daysAgo(iso: string, now: Date): number {
    return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
  }
}
