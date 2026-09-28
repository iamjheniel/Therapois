import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The back-dated price-entry warning (RC 3.13 #3650).
 *
 * A back-dated Heilmittel price silently changed the amount on 65 already-issued copayment invoices
 * earlier in 2026 (122,96 EUR, written off). The fix adds a pre-save warning listing every issued
 * invoice whose amount would change, plus an automatic refresh of Not Sent drafts after the save.
 *
 * **The preflight is the ideal test surface, and it is exact rather than modelled.**
 * `POST /treatments/price-change-invoice-impact` INSERTS the candidate `treatment_price_history`
 * rows, runs the REAL `ActivityTreatmentSnapshotRecalculator`, reads the new invoice amounts, and
 * rolls the whole transaction back. So the preview is the actual recompute, and calling it writes
 * nothing — verified here by re-reading the price history afterwards.
 *
 * **Payload** — `{ entries: [{ treatmentId, tariffType, effectiveDate, price }] }`, max 200 entries.
 * `tariffType` is the `TreatmentTariffType` enum (`GKV`, `PRIVAT`, `PRIVAT_BASIS`, `BEIHILFE`, `BG`),
 * NOT the insurance type; `effectiveDate` is parsed with `setTime(0,0,0)`.
 *
 * **AC3's table is not the implemented rule, and the difference is worth knowing.** The AC lists six
 * statuses as included and two as excluded. The code uses `InvoiceStatusEnum::issued()`, which is
 * "everything except NOT_SENT and CANCELLED" — so it also covers statuses the table never mentions
 * (`on_hold`, `sent_to_optica`). It additionally includes a **NOT_SENT invoice that HAS been
 * DATEV-synced**, deliberately: the after-save draft refresh is draft-tier only (NOT_SENT **and**
 * never synced), so a synced draft would otherwise fall between the two halves of this ticket.
 * Stornos are excluded by `originalInvoice IS NULL`.
 */

export type ImpactedInvoice = {
  prescriptionId: number;
  prescriptionNumber: string;
  invoiceNumber: string;
  date: string | null;
  currentAmount: number;
  recomputedAmount: number;
};

export type PriceEntry = { treatmentId: number; tariffType: string; effectiveDate: string; price: number };

/** `TreatmentPriceChangeInvoiceImpact::MAX_ENTRIES`. */
export const MAX_ENTRIES = 200;

/** The statuses AC3's table names as included. The code's set is wider — see the class docblock. */
export const AC3_INCLUDED = ['sent', 'overdue', 'reminded', 'to_send_to_dc', 'sent_to_dc', 'paid'] as const;

/** `InvoiceStatusEnum::issued()` — everything except these two. */
export const NEVER_ISSUED = ['not_sent', 'cancelled'] as const;

/** A treatment used widely enough on invoiced VOs to make a back-dated change bite. */
export const KG_TREATMENT_ID = 71;

export class PriceChangeImpactPage {
  private bearerToken: string | null = null;

  constructor(private request: APIRequestContext, token?: string) {
    this.bearerToken = token ?? null;
  }

  private async auth(): Promise<string> {
    if (this.bearerToken) return this.bearerToken;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.bearerToken = (await res.json()).token;
    return this.bearerToken!;
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

  /** The preflight. Writes nothing — the rehearsal is rolled back. */
  async impact(entries: PriceEntry[]): Promise<{ status: number; count: number; invoices: ImpactedInvoice[]; detail: string }> {
    const token = await this.auth();
    const res = await this.request.post(`${API_BASE}/treatments/price-change-invoice-impact`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { entries },
      timeout: 180_000,
    });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    return {
      status: res.status(),
      count: body?.count ?? 0,
      invoices: body?.invoices ?? [],
      detail: body?.detail ?? body?.message ?? '',
    };
  }

  /** The whole invoice book keyed by number, for checking the statuses the preflight returned. */
  async invoiceBook(): Promise<Map<string, { status: string; invoiceType: string }>> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      '/invoices?itemsPerPage=1000&groups%5B%5D=invoice-list:read',
    );
    return new Map(body.member.map((i) => [i.invoiceNumber, { status: i.status, invoiceType: i.invoiceType }]));
  }

  /** Whether an invoice has reached DATEV — the discriminator for the synced-draft case. */
  async datevSyncedAt(invoiceNumber: string): Promise<string | null> {
    const book = await this.get<{ member: Record<string, any>[] }>(
      '/invoices?itemsPerPage=1000&groups%5B%5D=invoice-list:read',
    );
    const row = book.member.find((i) => i.invoiceNumber === invoiceNumber);
    if (!row) return null;
    const item = await this.get<Record<string, any>>(`/invoices/${row.id}`);
    return item.datevSyncedAt ?? null;
  }

  /** Price-history entries for one treatment — the no-write check. */
  async priceHistory(treatmentId: number): Promise<{ tariffType: string; effectiveDate: string; price: number }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/treatment_price_histories?treatment=${treatmentId}&itemsPerPage=100`,
    );
    return body.member.map((m) => ({
      tariffType: m.tariffType,
      effectiveDate: String(m.effectiveDate ?? '').slice(0, 10),
      price: m.price,
    }));
  }
}
