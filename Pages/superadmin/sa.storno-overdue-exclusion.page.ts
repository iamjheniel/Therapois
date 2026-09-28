import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The nightly overdue check must never move a Storno — RC 3.14 #3799, commit `7c2b3b030`
 * (2026-09-25 05:44, on `release/3.14.0` AND `release/3.15.0`, no PR).
 *
 * A Storno is a credit the billing team issued, not a debt, so an Overdue Storno shows money owed
 * that does not exist. The whole API change is **two lines** — `andWhere('i.originalInvoice IS
 * NULL')` on each of `app:invoice:check-overdue`'s two queries — plus `Version20260925090000`, which
 * returns Stornos the old check already moved back to Sent at deploy.
 *
 * ## `originalInvoice` is the relational truth, never the `S` prefix (#3449)
 *
 * Both the fix and this file identify a Storno by the relation. #3449 established that the prefix is
 * an inference; on staging the two agree on all 601 invoices, but the fix deliberately uses the
 * relation and so does everything here.
 *
 * ## THE SERIALIZATION MAZE — three groups, and none of them carries everything
 *
 * | field | default | `invoice-list:read` | `billing:read` |
 * |---|---|---|---|
 * | `originalInvoice` (embedded object) | **yes** | no | no |
 * | `originalInvoiceId` | no | **yes** | no |
 * | `sentDate` / `overdueDate` / `remindedDate` | **yes** | no | yes |
 * | `totalOnHoldDays` | **yes** | no | no |
 * | `stornoStatus` / `stornoNumber` (on the ORIGINAL's row) | no | **yes** | no |
 *
 * Every one of those is also **OMITTED when null**, so a key read from the wrong group is
 * indistinguishable from a real null. This file's first measurement of "no Storno has a sentDate"
 * was taken from `invoice-list:read`, which does not serialize `sentDate` at all — the answer
 * happened to be right and the reading was worthless. {@link datesFor} always uses the default group.
 *
 * **`stornoStatus` lives on the ORIGINAL invoice's row**, which is exactly what AC4's billing tabs
 * render — the Storno has no billing row of its own (#2867).
 *
 * ## What staging can and cannot show
 *
 * All 17 Stornos are `not_sent`, none has ever carried a `status_change` log, and there were **0**
 * Overdue Stornos for the migration to correct. So the bug never fired here and the correction left
 * no fingerprint — deployment is **not client-decidable**, and AC1/AC3 have no live instance. What
 * IS decidable: the rule as a pure function ({@link selectedByStep1}/{@link selectedByStep2},
 * ported in both versions), the standing invariant that no Storno sits in a status only the check
 * could have produced, and AC2's control that the check demonstrably still moves real invoices.
 */

export const API = API_BASE;

/** `Invoice::PAYMENT_WINDOW_DAYS_GKV` / `_PKV` and `REMINDER_PAYMENT_DAYS`, verbatim. */
export const PAYMENT_WINDOW_DAYS_GKV = 21;
export const PAYMENT_WINDOW_DAYS_PKV = 30;
export const REMINDER_PAYMENT_DAYS = 14;

/** The statuses only the overdue check produces. A Storno in one of these is the bug. */
export const CHECK_PRODUCED_STATUSES = ['overdue', 'to_send_to_dc'] as const;

/** #2868 / the Out of Scope: a Storno's status is hand-set and offers exactly these two. */
export const STORNO_SELECTABLE_STATUSES = ['not_sent', 'sent'] as const;

/**
 * The ticket's staging fixture — and a warning it makes itself.
 *
 * Staging has its own invoice numbering: **its `S126-6` is a different Storno from production's**
 * (original `R126-84` here, `R126-20` in the billing team's screenshot). Reading the ticket's
 * production numbers against staging finds a real but unrelated Storno.
 */
export const STAGING_FIXTURE = { storno: 'S126-6', original: 'R126-84', stornoId: 670, originalId: 479 } as const;

export type InvoiceRow = {
  id: number;
  invoiceNumber: string;
  invoiceType: string;
  status: string;
  /** Present only on a Storno (omitted when null). */
  originalInvoiceId?: number | null;
  /** Present only on an ORIGINAL that has a Storno — AC4's column. */
  stornoStatus?: string | null;
  stornoNumber?: string | null;
};

export type InvoiceDates = {
  id: number;
  sentDate: string | null;
  overdueDate: string | null;
  remindedDate: string | null;
  totalOnHoldDays: number;
  isStorno: boolean;
};

/** The shape the two ported queries select on. */
export type Candidate = {
  status: string;
  isStorno: boolean;
  sentDate: string | null;
  remindedDate: string | null;
  copaymentAmount: number | null;
  totalOnHoldDays: number;
};

export class StornoOverdueExclusionPage {
  private bearer: string | null = null;
  private book: InvoiceRow[] | null = null;

  constructor(private request: APIRequestContext) {}

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  async get<T>(path: string, tries = 3): Promise<T> {
    const token = await this.token();
    let last = 0;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const res = await this.request.get(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout: 300_000,
        failOnStatusCode: false,
      });
      last = res.status();
      if (last < 500) {
        expect(last, `GET ${path}`).toBe(200);
        return (await res.json()) as T;
      }
      if (attempt < tries) await new Promise((r) => setTimeout(r, 10_000 * attempt));
    }
    throw new Error(`GET ${path} -> ${last}`);
  }

  async total(path: string): Promise<number> {
    return (await this.get<{ totalItems?: number }>(path)).totalItems ?? 0;
  }

  private async walk<T>(path: string, per = 200): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const b = await this.get<{ member?: T[]; totalItems?: number }>(`${path}${sep}itemsPerPage=${per}&page=${page}`);
      const m = b.member ?? [];
      out.push(...m);
      if (!m.length || out.length >= (b.totalItems ?? 0)) {
        expect(out.length, `walked ${path} completely`).toBe(b.totalItems ?? out.length);
        return out;
      }
    }
  }

  // ─────────────────────────────── the surfaces ───────────────────────────────

  /** The whole book in `invoice-list:read` — the only group carrying BOTH `originalInvoiceId` and `stornoStatus`. */
  async invoices(): Promise<InvoiceRow[]> {
    if (!this.book) this.book = await this.walk<InvoiceRow>('/invoices?groups%5B%5D=invoice-list%3Aread');
    return this.book;
  }

  async stornos(): Promise<InvoiceRow[]> {
    return (await this.invoices()).filter((i) => i.originalInvoiceId != null);
  }

  async nonStornos(): Promise<InvoiceRow[]> {
    return (await this.invoices()).filter((i) => i.originalInvoiceId == null);
  }

  /**
   * The date fields the two queries select on — DEFAULT group only, and omitted when null.
   *
   * `originalInvoice` (the embedded object) is in this group too, which is what makes one read
   * enough to know both the dates and whether the row is a Storno.
   */
  async datesFor(invoiceId: number): Promise<InvoiceDates> {
    const r = await this.get<Record<string, unknown>>(`/invoices/${invoiceId}`);
    return {
      id: invoiceId,
      sentDate: (r.sentDate as string) ?? null,
      overdueDate: (r.overdueDate as string) ?? null,
      remindedDate: (r.remindedDate as string) ?? null,
      totalOnHoldDays: Number(r.totalOnHoldDays ?? 0),
      isStorno: r.originalInvoice != null,
    };
  }

  /** Every `status_change` log, joined to its invoice id. */
  async statusChangeLogs(): Promise<{ invoiceId: number; oldValue: string; newValue: string; createdAt: string; meta: Record<string, unknown> | null; author: string | null }[]> {
    const logs = await this.walk<Record<string, unknown>>('/invoice_logs?type=status_change');
    return logs.map((l) => ({
      invoiceId: Number(String(l.invoice ?? '').split('/').pop()),
      oldValue: String(l.oldValue ?? ''),
      newValue: String(l.newValue ?? ''),
      createdAt: String(l.createdAt ?? ''),
      meta: (l.meta as Record<string, unknown>) ?? null,
      author: ((l.createdBy as { fullName?: string } | null)?.fullName) ?? null,
    }));
  }

  // ───────────────────── the overdue check, ported both ways ──────────────────

  /**
   * Step 1's DQL selection — SENT past the 21-day prefilter.
   *
   * `withStornoExclusion` is the ONLY difference the fix makes. The per-invoice
   * `getPaymentWindowDays()` guard that follows in the command (21 GKV / 30 otherwise) is NOT
   * ported: `getBilledInsuranceType()` is not serialized, and it is irrelevant here because the
   * Storno exclusion sits in the query, ahead of it.
   */
  static selectedByStep1(c: Candidate, withStornoExclusion: boolean, now = new Date()): boolean {
    if (withStornoExclusion && c.isStorno) return false;
    if (c.status !== 'sent') return false;
    if (!c.sentDate) return false;
    return StornoOverdueExclusionPage.effectiveDays(c.sentDate, c.totalOnHoldDays, now) >= PAYMENT_WINDOW_DAYS_GKV;
  }

  /** Step 2's DQL selection — REMINDED, non-copayment, past `REMINDER_PAYMENT_DAYS`. */
  static selectedByStep2(c: Candidate, withStornoExclusion: boolean, now = new Date()): boolean {
    if (withStornoExclusion && c.isStorno) return false;
    if (c.status !== 'reminded') return false;
    if (c.copaymentAmount !== null) return false;
    if (!c.remindedDate) return false;
    return StornoOverdueExclusionPage.effectiveDays(c.remindedDate, c.totalOnHoldDays, now) >= REMINDER_PAYMENT_DAYS;
  }

  /** `DATE_DIFF(:now, date) - totalOnHoldDays`, the command's own arithmetic. */
  static effectiveDays(from: string, onHoldDays: number, now = new Date()): number {
    const days = Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000);
    return days - onHoldDays;
  }

  static daysAgo(n: number, now = new Date()): string {
    return new Date(now.getTime() - n * 86_400_000).toISOString();
  }

  // ────────────────────────────── filter guards ───────────────────────────────

  /** Proves the filters and the group split before any count from them is believed. */
  async assertSurfacesPartition(): Promise<void> {
    const all = await this.total('/invoice_logs?itemsPerPage=1');
    const bogus = await this.total('/invoice_logs?zzzNotAFilter=1&itemsPerPage=1');
    expect(bogus, 'an unknown filter on /invoice_logs is IGNORED, not rejected').toBe(all);
    const notes = await this.total('/invoice_logs?type=note&itemsPerPage=1');
    expect(notes, '`type` IS registered').toBeLessThan(all);

    // The group split: a Storno's originalInvoiceId is ONLY in invoice-list:read, and its dates are
    // ONLY in the default group. Reading either from the wrong group returns undefined, which is
    // indistinguishable from a real null.
    const listRow = await this.get<Record<string, unknown>>(
      `/invoices/${STAGING_FIXTURE.stornoId}?groups%5B%5D=invoice-list%3Aread`,
    );
    const defaultRow = await this.get<Record<string, unknown>>(`/invoices/${STAGING_FIXTURE.stornoId}`);
    expect(listRow.originalInvoiceId, 'originalInvoiceId is in invoice-list:read').toBe(STAGING_FIXTURE.originalId);
    expect(defaultRow.originalInvoiceId, 'and NOT in the default group').toBeUndefined();
    expect('totalOnHoldDays' in defaultRow, 'totalOnHoldDays is in the default group').toBe(true);
    expect('totalOnHoldDays' in listRow, 'and not in invoice-list:read').toBe(false);
  }
}
