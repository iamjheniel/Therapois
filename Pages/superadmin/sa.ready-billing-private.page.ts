import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3796 — Privat Basis follows the PKV invoice rule on the Admin-Performance
 * "Bereit zur Abrechnung" tile, and an expired PKV or Privat Basis VO with carried-out
 * sessions can be invoiced (PR #3823, on `release/3.15.0`).
 *
 * **READ-ONLY, and that is a decision rather than a convenience.** The ticket is almost
 * entirely about CREATING INVOICES, and an invoice consumes a number that is never
 * released; cancelling one leaves a `cancelled` row behind for good (#3449). So this
 * file creates nothing. It does not have to: the PM's 3 Oct run left ~20 fixtures and a
 * dozen invoices on staging, and every one of those carries a dated, attributable
 * footprint — which turns most of this ticket from "needs a write" into "read the
 * record", the technique #3821 used for a console command.
 *
 * **THE PROVENANCE FLAG SEPARATES ALL THREE ROWS OF AC2.** `invoice_logs` carries
 * `meta.type` on its `invoice_created` entry (#3426), so for any invoice it is a fact,
 * not an inference, whether a human asked for it:
 *
 * | Footprint | AC2 row |
 * |---|---|
 * | `automatic`, stamped the same second as a validation while the VO was already Abgelaufen | row 1 — validated while expired |
 * | the `treatment_expired` entry carries no invoice at all | row 2 — the expiry itself creates nothing |
 * | `manual`, hours after the expiry | row 3 — an admin clicked "Rechnung erstellen" |
 *
 * **AC5 IS PROVEN BY TWO INVOICES THAT COULD NOT EXIST BEFORE THE FIX**, which is a
 * stronger thing than a passing check: the old guard priced the VO's PRESCRIBED
 * Heilmittel at the PKV tariff, so a Privat Basis VO on a Heilmittel with no PKV price
 * computed 0,00 €, and a Blanko VO (0 prescribed units) computed 0,00 € under either
 * tariff. Both now hold invoices priced from carried-out sessions at their own tariff.
 *
 * **Cheap reads matter here.** The converse of AC1 — "no PKV-style VO with a live
 * invoice is on the tile" — is asked of the INVOICE book (622 rows, each embedding its
 * VO with `insuranceType`), never of the 35,000-row VO book: a per-VO walk of the PKV
 * population did not finish in two minutes.
 *
 * **Traps:**
 *  - A VO can be off the tile for reasons that have nothing to do with this ticket —
 *    #3775's population is `Fertig Behandelt | Abgebrochen | Abgelaufen`, ≥1 signed
 *    session, **in no billing batch**. Two cancelled-only VOs (5714-3, 3277-4) are off
 *    it because they are batched, and the GKV control 99977-1 left it when validating
 *    put it in batch 63. Absence is only evidence once those are excluded.
 *  - A Storno is not a live invoice. Exclude `cancelled`, and exclude the reversal
 *    itself by its relation, not only by its `S` number prefix (#3449).
 *  - The signed-session predicate reads `rejectedTreatment` /
 *    `rejectedTreatmentWithSignature`; the short names do not exist on an Activity, so a
 *    predicate built on them excludes nothing (#3649, #3814).
 */

export type InvoiceRow = {
  id: number;
  invoiceNumber: string;
  status: string;
  invoiceType?: string;
  invoiceAmount?: number;
  prescription?: { prescriptionId: string; insuranceType: string };
};

export type TileRow = {
  tile: string;
  voNumber: string;
  prescriptionId: number;
  isPrivate: boolean;
  voStatus: string;
  revenue?: number;
};

/** The insurance types that bill through the PKV route (`pkvBillingValues()`). */
export const PKV_BILLING_TYPES = ['private', 'privat_basis'] as const;

/** #3775's population for the tile, unchanged by this ticket. */
export const READY_STATUSES = ['Fertig Behandelt', 'Abgebrochen', 'Abgelaufen'] as const;

/** The PM's 3 Oct fixtures, each pinned with the AC row it demonstrates. */
export const FIXTURES = {
  /** PKV, live invoice -> off the tile (AC1 row 1, as before the fix). */
  pkvWithInvoice: '99915-1',
  /** Privat Basis, live invoice -> off the tile. THE NEW RULE (AC1 row 2). */
  privatBasisWithInvoice: '99917-1',
  /** Only a cancelled invoice -> on the tile (AC1 row 3). */
  pkvCancelledOnly: '99916-1',
  privatBasisCancelledOnly: '99972-1',
  /** BG, no invoice -> on the tile (AC1 row 5). */
  bg: '99912-1',
  /** Validated, then expired by the nightly run; invoice came later, manually (AC2 rows 2+3). */
  expiredThenInvoicedManually: '99815-1',
  /** Already Abgelaufen, then validated -> automatic invoice (AC2 row 1). */
  validatedWhileExpired: '99816-1',
  /** Privat Basis on a Heilmittel with NO PKV price (AC5 row 1). */
  privatBasisOnlyPrice: '99978-1',
  /** Privat Basis Blanko, 0 prescribed units (AC5 row 2). */
  privatBasisBlanko: '99979-1',
  /** No carried-out session, in four statuses (AC3 / AC5 row 3). */
  noSession: ['99975-1', '99976-1', '99980-1', '99981-1'],
  /** One save changed the insurance type AND validated (AC6). */
  typeChangeSave: '99982-1',
  /** GKV, expired, sessions — joined a submission at validation, no copayment invoice (AC4). */
  gkvExpired: '99977-1',
} as const;

export class ReadyBillingPrivatePage {
  private token: string | null = null;

  constructor(private readonly request: APIRequestContext) {}

  async authenticate(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  private async get(path: string): Promise<{ status: number; body: any }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout: 120_000,
      });
      if (res.status() >= 500) continue;
      const text = await res.text();
      try {
        return { status: res.status(), body: JSON.parse(text) };
      } catch {
        return { status: res.status(), body: text.slice(0, 300) };
      }
    }
    throw new Error(`GET ${path} kept answering 5xx`);
  }

  static members(body: any): any[] {
    if (!body || typeof body !== 'object') return [];
    return body.member ?? body['hydra:member'] ?? (Array.isArray(body) ? body : []);
  }

  /** The Admin-Performance rows. The payload wraps tiles+rows in ONE member (#3774). */
  async tileRows(): Promise<{ count: number; rows: TileRow[] }> {
    const res = await this.get('/kpis/admin-performance/risks');
    expect(res.status, 'the Admin-Performance board must be readable for this role').toBe(200);
    const payload = ReadyBillingPrivatePage.members(res.body)[0] ?? res.body;
    const rows = (payload?.rows ?? []).filter((r: TileRow) => r.tile === 'bereitZurAbrechnung');
    return { count: payload?.tiles?.bereitZurAbrechnung, rows };
  }

  /** The whole invoice book, each row embedding its VO and that VO's insurance type. */
  async invoices(): Promise<InvoiceRow[]> {
    let rows: InvoiceRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.get(`/invoices?itemsPerPage=100&page=${page}&groups%5B%5D=invoice-list:read`);
      const batch = ReadyBillingPrivatePage.members(res.body);
      if (!batch.length) break;
      rows = rows.concat(batch);
      if (rows.length >= (res.body?.totalItems ?? 0)) break;
    }
    return rows;
  }

  /** A live invoice: not cancelled, and not the reversal of one. */
  static isLive(invoice: InvoiceRow): boolean {
    if (invoice.status === 'cancelled') return false;
    if (invoice.invoiceType === 'storno') return false;
    return !String(invoice.invoiceNumber ?? '').startsWith('S');
  }

  async vo(number: string): Promise<any> {
    const res = await this.get(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`);
    return ReadyBillingPrivatePage.members(res.body)[0];
  }

  async invoicesOf(prescriptionId: number): Promise<InvoiceRow[]> {
    // NOTE: on /invoices the per-VO key is the BARE `prescription=`; `prescription.id=`
    // is silently ignored and returns the whole book. The opposite holds on
    // /prescription_billing_batches (#3821).
    const res = await this.get(
      `/invoices?prescription=${prescriptionId}&itemsPerPage=30&groups%5B%5D=invoice-list:read`,
    );
    return ReadyBillingPrivatePage.members(res.body);
  }

  async invoiceCreationLog(invoiceId: number): Promise<any | undefined> {
    const res = await this.get(`/invoice_logs?invoice=${invoiceId}&itemsPerPage=20`);
    return ReadyBillingPrivatePage.members(res.body).find((l: any) => l.type === 'invoice_created');
  }

  async voLog(prescriptionId: number): Promise<any[]> {
    const res = await this.get(`/prescription_logs?prescription=${prescriptionId}&itemsPerPage=80`);
    return ReadyBillingPrivatePage.members(res.body);
  }

  /** Sessions that count as carried out — #3649's predicate, with the field names that exist. */
  async signedSessions(prescriptionId: number): Promise<{ signed: number; total: number }> {
    const res = await this.get(`/activities?prescription=${prescriptionId}&itemsPerPage=100`);
    const acts = ReadyBillingPrivatePage.members(res.body);
    const signed = acts.filter(
      (a: any) =>
        !(a.rejectedTreatment && !a.rejectedTreatmentWithSignature) && a.treatmentType !== 'planned',
    ).length;
    return { signed, total: acts.length };
  }

  /** Prove a filter narrows before believing any zero from it. */
  async assertInsuranceFilterNarrows(): Promise<void> {
    const all = (await this.get('/prescriptions?itemsPerPage=1')).body.totalItems;
    const bogus = (await this.get('/prescriptions?zzzNotAFilter=1&itemsPerPage=1')).body.totalItems;
    const basis = (await this.get('/prescriptions?insuranceType=privat_basis&itemsPerPage=1')).body.totalItems;
    expect(bogus, 'an unknown key is accepted and IGNORED, which is the control').toBe(all);
    expect(basis, 'insuranceType genuinely narrows').toBeLessThan(all);
  }
}
