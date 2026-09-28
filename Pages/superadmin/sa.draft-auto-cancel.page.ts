import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Automatic cancellation of a draft invoice with no billable sessions left (RC 3.13 #3649).
 *
 * A draft (Not Sent, never DATEV-synced) used to sit at a stale amount once its VO ran out of
 * billable sessions. The fix cancels it — `SERVICE_NOT_RENDERED`, an invoice-log note, no Storno —
 * on every trigger that already refreshed a draft's amount, plus VO expiry as a seventh.
 *
 * **The whole rule is a SESSION COUNT, and reproducing it is what this page object is for.** The
 * decision is `Prescription::countBillableSessions() === 0`, deliberately neither the amount (a
 * partly exempt GKV VO can be worth 0,00 with its sessions genuinely delivered — "Leistung nicht
 * erbracht" would be a false statement on a patient's invoice) nor the VO's status (AC4). So the
 * only way to know which drafts the rule applies to is to re-derive the count, and there are three
 * gates around it that no AC mentions:
 *
 * | gate | source | effect |
 * |---|---|---|
 * | `isDraftTier()` | `status === NOT_SENT && datevSyncedAt === null` | AC3 — a sent or synced invoice is never touched |
 * | `validationStatus === VALIDATED` | `cancelDraftWithNoBillableSessions()` | **in no AC** — #3204 keeps a Not Sent draft through a validation reset so its reserved number survives; cancelling would burn the number through another door |
 * | `countBillableSessions() !== null` | GKV or `usesPkvBilling()` only | UV/BG is priced by neither engine and answers **null**, which must NOT read as "nothing left to bill" |
 *
 * **THE TRAP, and it manufactures false findings in the obvious direction.** "Delivered" is
 * `isDeliveredSession()`: NOT (rejected && !rejectedWithSignature), AND `treatmentType !== PLANNED`.
 * It is a *negative* test against PLANNED — so a session whose `treatmentType` is **absent from the
 * payload counts as DELIVERED**. An oracle written as `treatmentType === 'done'` (the reading the
 * PM's own AC6 row states, "activities with status done") under-counts: on staging the field is
 * `done` 3,177 times, `planned` 10 times and **omitted twice**, and those two sit on one VO —
 * 9634-5, whose draft R126-118 then looks like a stranded zero-session draft and is not one.
 * The naive predicate is wrong in both directions — too HIGH on a rejected-without-signature
 * session (which does carry `done`), too LOW on an omitted one — and only the second matters: at
 * zero it invents a cancellable draft. `deliveredSessions()` implements the real predicate;
 * `DELIVERED_BY_DONE_ONLY` is kept only to show the two apart.
 *
 * Second trap: a rejected session is excluded only **without** a signature. VO 8954-1 carries two
 * rejected sessions, one of each flavour, so it has exactly one billable session, not zero.
 *
 * **Fetching:** `/activities?prescription[]=…` accepts MANY ids in one request (verified: two VOs
 * with 6 sessions each answer `totalItems: 12`), and `/prescriptions?id[]=…` likewise — which is
 * what makes a 404-draft sweep affordable at all instead of 800 sequential reads. Note
 * `?prescription.id=` is silently ignored (#3533); the filter is `prescription`.
 *
 * Read-only throughout — every request is a GET.
 */

/** A draft invoice in the tier this ticket governs. */
export type DraftRow = {
  invoiceNumber: string;
  invoiceType: string;
  amount: number | null;
  status: string;
  prescriptionId: string | null;
  prescriptionNumber: string | null;
  /** Set only once the nightly transfer has pushed it — its presence takes the row OUT of the draft tier. */
  datevSyncStatus: string | null;
};

export type VoState = {
  id: string;
  number: string | null;
  validationStatus: string | null;
  insuranceType: string | null;
  treatmentStatus: string | null;
};

export type ActivityRow = {
  prescriptionId: string;
  treatmentType: string | null;
  rejectedTreatment: boolean;
  rejectedTreatmentWithSignature: boolean;
};

/** The scored result for one draft: everything the shipped rule reads, re-derived. */
export type ScoredDraft = DraftRow & {
  vo: VoState | null;
  sessions: number;
  delivered: number;
  /** `countBillableSessions()` — null where neither billing engine prices the type. */
  billableSessions: number | null;
  /** All three gates satisfied, i.e. the next trigger WOULD cancel this draft. */
  wouldCancel: boolean;
};

/** The insurance types the two billing engines price; anything else answers null. */
export const PRICED_INSURANCE_TYPES = ['public', 'private', 'privat_basis'] as const;

/** The three invoiced tariff types AC5 requires to behave alike. */
export const AC5_TYPES = ['public', 'private', 'privat_basis'] as const;

/** The note `cancelDraftWithNoBillableSessions()` writes; AC1's observable footprint. */
export const AUTO_CANCEL_NOTE = 'cancelled automatically: no billable sessions left.';

/** The one staging invoice that is Not Sent yet DATEV-synced — AC3's only discriminating fixture. */
export const SYNCED_NON_DRAFT = { invoiceNumber: 'R126-86', prescriptionNumber: '3899-13' };

/** VO statuses that close a VO; AC4 says none of them may cancel a draft on its own. */
export const CLOSED_STATUSES = ['Abgebrochen', 'Abgelaufen', 'Archiviert', 'Fertig Behandelt', 'Abgerechnet'];

export class DraftAutoCancelPage {
  private token: string | null = null;

  constructor(
    private request: APIRequestContext,
    token?: string,
  ) {
    this.token = token ?? null;
  }

  /**
   * The JWT's TTL is 3600 s (#3460) and the full sweep runs well inside that — but a re-mint on 401
   * costs one request and removes a whole class of mid-sweep failure that looks like missing data.
   */
  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.token = (await res.json()).token;
    return this.token!;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.bearer();
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 150_000,
      });
      if (res.ok()) return (await res.json()) as T;
      lastError = `${res.status()} on ${path.slice(0, 110)}`;
      // A 401 here means the hour-long JWT expired mid-sweep; mint a new one rather than fail.
      if (res.status() === 401) this.token = null;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    // Never swallow: a helper that returns {} on failure produces an oracle that agrees with
    // nothing and reports a clean pass over zero rows (#3560).
    throw new Error(`GET failed after 4 attempts — ${lastError}`);
  }

  /** Every invoice, with the fields that decide the draft tier. */
  async allInvoices(): Promise<DraftRow[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      '/invoices?itemsPerPage=1000&groups%5B%5D=invoice-list:read',
    );
    return body.member.map((i) => {
      const pr = i.prescription;
      const iri: string | null = typeof pr === 'string' ? pr : (pr?.['@id'] ?? null);
      return {
        invoiceNumber: i.invoiceNumber,
        invoiceType: i.invoiceType,
        amount: i.invoiceAmount ?? null,
        status: i.status,
        prescriptionId: iri ? iri.split('/').pop()! : null,
        prescriptionNumber: typeof pr === 'object' ? (pr?.prescriptionId ?? null) : null,
        datevSyncStatus: i.datevSyncStatus ?? null,
      };
    });
  }

  /**
   * The draft tier as the code defines it: Not Sent, never DATEV-synced, and not itself a Storno.
   *
   * The S-number exclusion is not cosmetic — all 10 Storno documents on staging are `not_sent` AND
   * `datevSyncStatus: synced`, so a naive "status === not_sent" draft set pulls in ten reversals.
   */
  draftTier(book: DraftRow[]): DraftRow[] {
    return book.filter(
      (i) => i.status === 'not_sent' && !i.datevSyncStatus && !(i.invoiceNumber ?? '').startsWith('S'),
    );
  }

  /** VO state for many ids at once. */
  async voStates(ids: string[]): Promise<Map<string, VoState>> {
    const out = new Map<string, VoState>();
    for (let i = 0; i < ids.length; i += 40) {
      const q = ids.slice(i, i + 40).map((id) => `id%5B%5D=${id}`).join('&');
      const body = await this.get<{ member: Record<string, any>[] }>(
        `/prescriptions?${q}&groups%5B%5D=billing:read&itemsPerPage=100`,
      );
      for (const m of body.member) {
        out.set(String(m.id), {
          id: String(m.id),
          number: m.prescriptionId ?? null,
          validationStatus: m.validationStatus ?? null,
          insuranceType: m.insuranceType ?? null,
          treatmentStatus: m.treatmentStatus ?? null,
        });
      }
    }
    return out;
  }

  /** Every session of many VOs at once, grouped by VO. */
  async activitiesFor(ids: string[]): Promise<Map<string, ActivityRow[]>> {
    const out = new Map<string, ActivityRow[]>();
    for (const id of ids) out.set(id, []);
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const q = chunk.map((id) => `prescription%5B%5D=${id}`).join('&');
      const body = await this.get<{ member: Record<string, any>[]; totalItems: number }>(
        `/activities?${q}&itemsPerPage=1000`,
      );
      // A truncated page would silently under-count sessions and invent zero-session VOs.
      if ((body.totalItems ?? 0) > body.member.length) {
        throw new Error(`activities page truncated: totalItems ${body.totalItems} > ${body.member.length}`);
      }
      for (const a of body.member) {
        const pr = a.prescription;
        const iri: string = typeof pr === 'string' ? pr : (pr?.['@id'] ?? '');
        const key = iri.split('/').pop() ?? '';
        if (!out.has(key)) out.set(key, []);
        out.get(key)!.push({
          prescriptionId: key,
          treatmentType: a.treatmentType ?? null,
          rejectedTreatment: Boolean(a.rejectedTreatment),
          rejectedTreatmentWithSignature: Boolean(a.rejectedTreatmentWithSignature),
        });
      }
    }
    return out;
  }

  /**
   * A faithful port of `Prescription::isDeliveredSession()`.
   *
   * Note the shape: the `treatmentType` test is a NEGATIVE one against PLANNED, so an absent value
   * counts as delivered. See the class docblock.
   */
  isDeliveredSession(a: ActivityRow): boolean {
    if (a.rejectedTreatment && !a.rejectedTreatmentWithSignature) return false;
    return (a.treatmentType ?? '').toLowerCase() !== 'planned';
  }

  deliveredSessions(rows: ActivityRow[]): number {
    return rows.filter((a) => this.isDeliveredSession(a)).length;
  }

  /** The wrong predicate, kept so a test can show what it would have concluded. */
  DELIVERED_BY_DONE_ONLY = (rows: ActivityRow[]): number =>
    rows.filter((a) => a.treatmentType === 'done').length;

  /** A port of `Prescription::countBillableSessions()`, null branch included. */
  countBillableSessions(vo: VoState | null, rows: ActivityRow[]): number | null {
    if (!vo || !PRICED_INSURANCE_TYPES.includes(vo.insuranceType as any)) return null;
    return this.deliveredSessions(rows);
  }

  /** Re-derive the whole shipped decision for every draft-tier invoice. */
  async scoreDraftTier(): Promise<ScoredDraft[]> {
    const book = await this.allInvoices();
    const drafts = this.draftTier(book);
    const ids = [...new Set(drafts.map((d) => d.prescriptionId).filter((v): v is string => Boolean(v)))];
    const [states, acts] = await Promise.all([this.voStates(ids), this.activitiesFor(ids)]);

    return drafts.map((d) => {
      const vo = d.prescriptionId ? (states.get(d.prescriptionId) ?? null) : null;
      const rows = d.prescriptionId ? (acts.get(d.prescriptionId) ?? []) : [];
      const billable = this.countBillableSessions(vo, rows);
      return {
        ...d,
        vo,
        sessions: rows.length,
        delivered: this.deliveredSessions(rows),
        billableSessions: billable,
        wouldCancel: billable === 0 && vo?.validationStatus === 'validated',
      };
    });
  }

  /** Every invoice-log note, for AC1's footprint and AC7's no-Storno claim. */
  async notes(): Promise<{ createdAt: string; invoice: string | null; value: string; author: string | null }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      '/invoice_logs?type=note&itemsPerPage=1500&order%5BcreatedAt%5D=desc',
    );
    return body.member.map((m) => ({
      createdAt: m.createdAt,
      invoice: typeof m.invoice === 'string' ? m.invoice : (m.invoice?.['@id'] ?? null),
      value: m.value ?? '',
      author: m.createdBy?.fullName ?? null,
    }));
  }
}
