import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * ETI submissions under each Gesellschaft's own account and API key (RC 3.13 #3473).
 *
 * Flow used one shared ETI account for every PKV invoice; ETI requires one account per
 * Gesellschaft because each has its own bank account and their bookkeeping must stay separate.
 * `EtiClient` now holds an `array<int, string>` of **Gesellschaft id → API key** and
 * `EtiSubmissionController` resolves the key per invoice inside the batch loop.
 *
 * **This page object NEVER submits.** `POST /invoices/eti/submit` sends a real claim to a real
 * debt-collection partner; even flagged `test: true` that is an outward-facing action against a
 * third party, and it is not reversible from here. Everything below reads the **outcome** of
 * submissions other people already made — which is possible because the result is durable:
 * `etiTransactionId` is serialized on the invoice, and every status move is in `invoice_logs`.
 *
 * **What external evidence can and cannot establish.** A distinct `etiTransactionId` per
 * Gesellschaft proves each submission was accepted and separately tracked. It does **not** prove
 * the claim landed in the *right* ETI account — only ETI's own portal can show that. So the tests
 * assert what is decidable (every Gesellschaft has its own accepted, distinctly-tracked
 * submission; no id is reused) and the docblocks say plainly where the evidence stops.
 *
 * **Two shapes in the data that look like defects and are not the same thing:**
 * - an invoice at `to_send_to_dc` that HAS a transaction id — it was submitted and later moved
 *   back (see `revertedAfterSubmission()`), so status alone is not evidence of "never submitted";
 * - an invoice at `sent_to_dc` with NO transaction id — set by hand, never submitted, so status
 *   alone is not evidence of "was submitted" either.
 *
 * **Traps:** `/invoice_logs/{id}` has **no item GET** (404, like `/activities/{id}` — #3398), so a
 * log referenced from `invoice.logs` must be read through the collection with `?invoice=<id>`;
 * `etiTransactionId` lives only in the DEFAULT serialization group, while `invoiceType` is only in
 * `invoice-list:read` (#3604), so the book needs two reads merged; and `billingEntity` is the
 * filter that partitions by Gesellschaft (#3493).
 */

export type EtiInvoice = {
  id: number;
  invoiceNumber: string;
  status: string;
  entityId: number;
  etiTransactionId: string | null;
  sentToDcDate: string | null;
  toDcDate: string | null;
};

export type LogEntry = { createdAt: string; type: string; oldValue: string | null; newValue: string | null; meta: string };

/** The two ETI stages an invoice passes through. */
export const DC_STATUSES = ['to_send_to_dc', 'sent_to_dc'] as const;

/** The blocked-invoice message the controller returns when a Gesellschaft has no key (AC3). */
export const NO_ACCOUNT_ERROR = 'Kein ETI-Konto für diese Gesellschaft hinterlegt';

/** The seven Gesellschaften; the ETI account mapping is keyed on this id, never on the name. */
export const ENTITY_COUNT = 7;

export class EtiPerGesellschaftPage {
  private token: string | null = null;

  constructor(
    private request: APIRequestContext,
    token?: string,
  ) {
    this.token = token ?? null;
  }

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
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120_000,
      });
      if (res.ok()) return (await res.json()) as T;
      if (res.status() === 401) this.token = null;
      if (attempt === 2) throw new Error(`GET ${path} -> ${res.status()}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error('unreachable');
  }

  async entities(): Promise<{ id: number; name: string }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>('/entities?itemsPerPage=50');
    return body.member.map((e) => ({ id: e.id, name: e.name }));
  }

  /**
   * Every invoice at either ETI stage, with its Gesellschaft and transaction id.
   *
   * Partitioned with `billingEntity` so the Gesellschaft is the SERVER's answer rather than one
   * re-derived through the invoice → prescription → entity chain the controller walks.
   */
  async dcInvoices(): Promise<EtiInvoice[]> {
    const out: EtiInvoice[] = [];
    for (let entityId = 1; entityId <= ENTITY_COUNT; entityId++) {
      const list = await this.get<{ member: Record<string, any>[] }>(
        `/invoices?billingEntity=${entityId}&itemsPerPage=1000&groups%5B%5D=invoice-list:read`,
      );
      const staged = list.member.filter((i) => (DC_STATUSES as readonly string[]).includes(i.status));
      for (const row of staged) {
        // etiTransactionId is not in invoice-list:read — the item read under the default group is
        // the only way to get it.
        const item = await this.get<Record<string, any>>(`/invoices/${row.id}`);
        out.push({
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          status: item.status,
          entityId,
          etiTransactionId: item.etiTransactionId ?? null,
          sentToDcDate: item.sentToDcDate ?? null,
          toDcDate: item.toDcDate ?? null,
        });
      }
    }
    return out;
  }

  /** The log trail for one invoice, oldest first. `/invoice_logs/{id}` is 404 — use the collection. */
  async logs(invoiceId: number): Promise<LogEntry[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/invoice_logs?invoice=${invoiceId}&itemsPerPage=50&order%5BcreatedAt%5D=asc`,
    );
    return body.member.map((l) => ({
      createdAt: l.createdAt ?? '',
      type: String(l.type ?? ''),
      oldValue: l.oldValue ?? null,
      newValue: l.newValue ?? null,
      meta: String(l.value ?? ''),
    }));
  }

  /** Status moves only, in order — the sequence that shows whether a submission stuck. */
  async statusTrail(invoiceId: number): Promise<LogEntry[]> {
    return (await this.logs(invoiceId)).filter((l) => l.type === 'status_change');
  }

  /**
   * Invoices that carry a transaction id but sit back at `to_send_to_dc`.
   *
   * Reached Sent to DC on submission, then were moved back — so their id is real but their status
   * no longer shows the transition AC1 describes.
   */
  revertedAfterSubmission(rows: EtiInvoice[]): EtiInvoice[] {
    return rows.filter((r) => r.status === 'to_send_to_dc' && r.etiTransactionId !== null);
  }

  /** Invoices at Sent to DC with no transaction id — status set by hand, never submitted. */
  markedWithoutSubmission(rows: EtiInvoice[]): EtiInvoice[] {
    return rows.filter((r) => r.status === 'sent_to_dc' && r.etiTransactionId === null);
  }

  /** Gesellschaft id → its accepted, tracked submissions. */
  submissionsByEntity(rows: EtiInvoice[]): Map<number, EtiInvoice[]> {
    const m = new Map<number, EtiInvoice[]>();
    for (const r of rows) {
      if (!r.etiTransactionId) continue;
      if (!m.has(r.entityId)) m.set(r.entityId, []);
      m.get(r.entityId)!.push(r);
    }
    return m;
  }
}
