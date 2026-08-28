import { Page, expect } from '@playwright/test';
import { settleAfter } from '../util/settle';

/**
 * Old-format PKV invoices and the one-time DATEV push — RC 3.11.1 #3440.
 *
 * PKV invoices issued before the current numbering format was introduced carry a bare number like
 * `426-14` instead of `R426-64`. The nightly DATEV sync only picks up invoices whose number starts
 * with `R`, so these are permanently excluded, never reach DATEV, and never get a payment-status
 * pull back into Flow. #3440 is a one-time command that pushes them **under their existing number**
 * (Silvia's team filters for them in DATEV *by* the missing `R`, so renumbering is forbidden) plus
 * whatever mechanism keeps their payment status updating afterwards.
 *
 * **The command is console-only** — `app:datev:push-legacy-pkv-invoices`, run as a one-off Fargate
 * task on `therapios-staging-console` (preview by default, `--force` to execute). What is verifiable
 * from a browser is the population it must select, the pre-run state it must change, and — once it
 * has run — the per-invoice outcome. Every request here is a **GET**; nothing in this page object
 * writes.
 *
 * The selection rule the shipped command applies, confirmed against its 2026-08-24 staging preview:
 *
 * ```
 *   insuranceType = 'private'
 *   AND invoiceNumber NOT LIKE 'R%'
 *   AND invoiceNumber NOT LIKE 'S%'          -- stornos have their own sync path
 *   AND status IN (datev-syncable statuses)
 *   AND (datevSyncStatus IS NULL OR datevSyncStatus = FAILED)
 * ```
 *
 * Both boundary cases this page object guards are therefore closed in the implementation, and the
 * last clause makes the command idempotent — a re-run is the documented retry path.
 *
 * **An execute run is not possible on staging.** `DATEV_SYNC_ENABLED` is `false`
 * (SSM `/therapios/staging/datev-sync-enabled`; production is `true`), so `--force` aborts at the
 * guard and exits non-zero. That same parameter also drives the `State` of the three DATEV
 * EventBridge schedule rules, so flipping it would start the nightly push, payment pull and debtor
 * creation against staging data — and the Riecken gateway URL and username are **byte-identical to
 * production**, with only test Mandant 9999 separating the traffic. Staging stays preview-only; the
 * real delivery happens on production. This is also why the newest DATEV delivery here is
 * 2026-07-31: the nightly is switched off, not merely unscheduled.
 *
 * **How payment status keeps updating afterwards** (the ticket's second half): nothing is marked
 * "already delivered". `InvoiceRepository::findUnpaidForPaymentMatching()` widened from
 * `invoiceNumber LIKE 'R%'` to `LIKE 'R%' OR datevSyncStatus = SYNCED`, so an old-format invoice
 * becomes pollable only once the one-time push has actually set `datevSyncStatus`. The push
 * selection, `findPendingDatevSync()`, is **unchanged and still `R`-only** — which is what makes
 * AC5 structural rather than something to observe. There is no new job to watch: verification runs
 * against the existing payment-status polling.
 *
 * ## Where the DATEV state lives
 *
 * Two surfaces, and they disagree in a way that matters:
 *
 *  - `GET /invoices` — the invoice collection. `datevSyncStatus` / `datevSyncedAt` /
 *    `datevLastSyncAttemptAt` are **omitted from the payload entirely** while an invoice has never
 *    been pushed (the same shape trap as `followupStatus` in #3302), so "not synced" reads as
 *    `undefined`, never `null` or `'pending'`. Only `datevSyncAttempts` is always present, and it is
 *    `0` on all 534 staging invoices — it counts *failures*, so it can never stand in for "was this
 *    pushed?".
 *  - `GET /invoices?datevSyncStatus=synced` — the positive filter, and the reliable one: 84 rows.
 *    `datevSyncStatus=pending` and `=failed` both answer **0**, because there is no stored value to
 *    match. Do not read that 0 as "nothing is pending".
 *  - `GET /invoice_logs?type=datev_push_success` — the per-invoice audit trail. This is what makes
 *    "did the one-time command touch this invoice, and when?" answerable, and it is how AC2/AC6 are
 *    checked after the run. Each row carries a `batchId`, but it is **one id per push, not one per
 *    run**: 84 pushes across three days hold 84 distinct ids, so a run is identified by its
 *    `createdAt` cluster, never by a shared batch id.
 *
 * ## Traps
 *
 * 1. **Storno numbers also fail the "starts with R" test.** Seven staging invoices are numbered
 *    `S126-1`, `S426-2`, … — cancellation documents, not old-format invoices. A selection rule
 *    written as a bare `NOT LIKE 'R%'` sweeps them in. `isOldFormat()` excludes them explicitly.
 * 2. **The rule is only safe *with* the PKV filter.** 84 invoices are old-format; only 44 are PKV.
 *    Dropping the insurance scope would push 40 GKV copayment invoices the ticket puts out of scope.
 * 3. **Insurance type lives on the prescription, not the invoice.** `insuranceType: 'private'` is
 *    PKV, `'public'` is GKV; the invoice payload carries neither.
 * 4. **The UI's DATEV filter cannot find them.** PKV-Abrechnung offers `DATEV: Ausstehend /
 *    Synchronisiert / Fehlgeschlagen`, sending `pkvBilling[datevStatus]=pending|synced|failed`.
 *    `synced` works (83 rows); **`pending` returns 0 in every combination** even though the DATEV
 *    column renders "Ausstehend" for every unsynced row. That is a #2856 defect, but it is also the
 *    route the ticket's QA guidance implies, so the spec drives the archived-VO filter instead.
 * 5. **The 44 sit on archived VOs**, so they are absent from the default PKV-Abrechnung list (12
 *    rows). Reaching them in the UI needs `pkvBilling[treatmentStatus]=Archiviert` (#3277) or the
 *    "Alle mit Rechnung" mode.
 */

export const API = 'https://api.staging.therapios.de';

/** The one-time delivery command. Preview by default; `--force` executes (blocked on staging). */
export const COMMAND = 'app:datev:push-legacy-pkv-invoices';

/**
 * The 2026-08-24 staging preview run, for cross-checking the rule derived here against the rule the
 * command actually applies. Exit 0, 44 of 44 would be sent, 0 skipped, EUR 32,968.57 total.
 */
export const PREVIEW_2026_08_24 = { wouldSend: 44, skipped: 0, totalValue: 32968.57 } as const;

/** Invoice statuses that mean "outstanding" for AC4 — issued, not yet paid, not yet at Inkasso. */
export const OUTSTANDING_STATUSES = ['sent', 'overdue', 'reminded'];

/** The debt-collection step ("Inkasso"), which AC4 says must be preserved as-is. */
export const DEBT_COLLECTION_STATUSES = ['to_send_to_dc', 'sent_to_dc'];

/**
 * The population as measured on staging 2026-08-24, against the ticket's 20 Aug reference of 44.
 *
 * The **rule** is authoritative, not this snapshot — the ticket is explicit that the count may drift
 * and that selection must happen at run time. These are the expectations the spec asserts the rule
 * still reproduces, so a drift shows up as a readable diff instead of a silent pass.
 */
export const EXPECTED = {
  /** Old-format PKV invoices — the ticket's 44. */
  pkv: 44,
  /** …of which outstanding (all `overdue` today) — the ticket's 43. */
  pkvOutstanding: 43,
  /** …of which at the debt-collection step — the ticket's 1. */
  pkvDebtCollection: 1,
  /** Old-format GKV invoices, all out of scope. The ticket's narrative says 1; staging holds 40. */
  gkv: 40,
  /** Invoices already delivered to DATEV, all of them current-format. */
  synced: 84,
  /** Storno documents whose number starts with `S` — the selection-rule trap. */
  storno: 7,
} as const;

/**
 * The one PKV invoice already at the debt-collection step ("Inkasso"), named separately because
 * AC4 singles it out: the run must not knock it back to plain outstanding.
 */
export const DEBT_COLLECTION_FIXTURE = { number: '126-4', vo: '91-2', amount: 78 };

/**
 * The 44 old-format PKV invoice numbers as of 2026-08-24 — **set-identical to the command's own
 * preview output** for that date, so this is a cross-check of the implemented rule and not just a
 * snapshot of the data. Held so AC2's "no renumbering" is checkable after the run: every number here
 * must still exist, on the same invoice id.
 */
export const OLD_FORMAT_PKV_NUMBERS = [
  '126-4', '426-14', '426-15', '426-16', '526-1', '226-1', '526-2', '426-17', '526-3', '126-5',
  '326-31', '426-18', '326-33', '126-6', '126-7', '326-34', '426-19', '426-20', '426-21', '426-22',
  '226-2', '226-3', '326-35', '526-4', '526-5', '326-36', '326-40', '426-32', '426-33', '126-12',
  '326-41', '426-34', '426-35', '326-42', '326-43', '126-14', '526-12', '126-15', '526-13', '426-36',
  '426-37', '126-16', '126-17', '326-44',
];

export type InvoiceRow = {
  id: number;
  number: string;
  status: string;
  amount: number;
  issueDate: string;
  prescriptionId: number | null;
  /** Present only once the invoice has been pushed — see the shape trap above. */
  datevSyncStatus: string | null;
  datevSyncedAt: string | null;
  datevSyncAttempts: number;
};

/** An invoice joined to the prescription that decides its insurance type. */
export type ScopedInvoice = InvoiceRow & {
  vo: string | null;
  /** `private` = PKV, `public` = GKV. */
  insuranceType: string | null;
  patient: string | null;
  entity: string | null;
  datevEnabled: boolean | null;
  treatmentStatus: string | null;
};

export type DatevPush = {
  invoiceId: number;
  createdAt: Date;
  batchId: string | null;
  /** `automatic` for the nightly sync — the only value present on staging today. */
  type: string;
};

/** A cancellation document, not an old-format invoice — excluded from the selection rule. */
export function isStorno(invoiceNumber: string): boolean {
  return /^S/.test(invoiceNumber);
}

/** The ticket's rule, with the Storno trap closed. */
export function isOldFormat(invoiceNumber: string): boolean {
  return !/^R/.test(invoiceNumber) && !isStorno(invoiceNumber);
}

/** The ticket's rule *plus* its insurance scope — the population the one-time command must select. */
export function isInScope(inv: ScopedInvoice): boolean {
  return isOldFormat(inv.number) && inv.insuranceType === 'private';
}

/** Whether this invoice has ever reached DATEV. */
export function isSynced(inv: InvoiceRow): boolean {
  return inv.datevSyncStatus === 'synced';
}

export class DatevOldFormatPage {
  private token: string | null = null;

  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    // `auth-state` is written into localStorage from the .auth storageState BEFORE the page loads,
    // so the token is readable as soon as the document exists. The flat sleep this replaces was
    // waiting for nothing — it just delayed reading a value that was already there.
    await this.page
      .waitForFunction(() => !!localStorage.getItem('auth-state'), null, { timeout: 30_000 })
      .catch(() => {});
    this.token = await this.page.evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '');
        return state.token || state.accessToken || state.access_token || null;
      } catch {
        return null;
      }
    });
    expect(this.token, 'the session must carry a bearer token for the invoice API').toBeTruthy();
  }

  private get auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${API}${path}`, { headers: this.auth, timeout: 90_000 });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  static shape(row: any): InvoiceRow {
    return {
      id: row.id,
      number: String(row.invoiceNumber ?? ''),
      status: row.status,
      amount: Number(row.invoiceAmount ?? 0),
      issueDate: String(row.issueDate ?? ''),
      prescriptionId: row.prescription ? Number(String(row.prescription).replace('/prescriptions/', '')) : null,
      datevSyncStatus: row.datevSyncStatus ?? null,
      datevSyncedAt: row.datevSyncedAt ?? null,
      datevSyncAttempts: Number(row.datevSyncAttempts ?? 0),
    };
  }

  // ──────────────────────────────── population ───────────────────────────────

  /** Every invoice in the system (534 on staging today). */
  async allInvoices(): Promise<InvoiceRow[]> {
    const rows: InvoiceRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.json(`/invoices?page=${page}&itemsPerPage=100`);
      const member = body.member ?? body['hydra:member'] ?? [];
      rows.push(...member.map(DatevOldFormatPage.shape));
      if (member.length < 100) break;
    }
    return rows;
  }

  /**
   * Joins invoices to their prescription so the PKV/GKV scope can be applied. One GET per invoice —
   * fine for the ~91 non-`R` rows, deliberately not run over all 534.
   */
  async scope(invoices: InvoiceRow[]): Promise<ScopedInvoice[]> {
    const out: ScopedInvoice[] = [];
    for (const inv of invoices) {
      let p: any = null;
      if (inv.prescriptionId) {
        p = await this.json(`/prescriptions/${inv.prescriptionId}?groups%5B%5D=billing%3Aread`);
      }
      out.push({
        ...inv,
        vo: p?.prescriptionId ?? null,
        insuranceType: p?.insuranceType ?? null,
        patient: p?.patient?.fullName ?? null,
        entity: p?.entity?.name ?? null,
        datevEnabled: p?.entity?.datevEnabled ?? null,
        treatmentStatus: p?.treatmentStatus ?? null,
      });
    }
    return out;
  }

  /** The old-format invoices (Storno documents excluded), scoped with their insurance type. */
  async oldFormatInvoices(): Promise<ScopedInvoice[]> {
    const all = await this.allInvoices();
    return await this.scope(all.filter((i) => isOldFormat(i.number)));
  }

  /** Invoices the API itself reports as delivered to DATEV. */
  async syncedInvoices(): Promise<InvoiceRow[]> {
    const rows: InvoiceRow[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.json(`/invoices?datevSyncStatus=synced&page=${page}&itemsPerPage=100`);
      const member = body.member ?? [];
      rows.push(...member.map(DatevOldFormatPage.shape));
      if (member.length < 100) break;
    }
    return rows;
  }

  /** `totalItems` for one `datevSyncStatus` value, without paging the collection. */
  async syncedCount(value: 'synced' | 'pending' | 'failed'): Promise<number> {
    const body = await this.json(`/invoices?datevSyncStatus=${value}&itemsPerPage=1`);
    return Number(body.totalItems ?? 0);
  }

  // ─────────────────────────────── DATEV audit ───────────────────────────────

  /**
   * Every successful DATEV push. `batchId` is unique per push (not per run) — group by `createdAt`
   * to recover a run.
   */
  async datevPushes(): Promise<DatevPush[]> {
    const rows: DatevPush[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.json(`/invoice_logs?type=datev_push_success&page=${page}&itemsPerPage=200`);
      const member = body.member ?? [];
      for (const l of member) {
        rows.push({
          invoiceId: Number(String(l.invoice).replace('/invoices/', '')),
          createdAt: new Date(l.createdAt),
          batchId: l.batchId ?? null,
          type: l.meta?.type ?? 'unknown',
        });
      }
      if (member.length < 200) break;
    }
    return rows;
  }

  /** How many log rows exist for a log type — used to prove absence without paging. */
  async logCount(type: string): Promise<number> {
    const body = await this.json(`/invoice_logs?type=${encodeURIComponent(type)}&itemsPerPage=1`);
    return Number(body.totalItems ?? 0);
  }

  /** Every log entry on one invoice, for reading a single invoice's history. */
  async invoiceLogs(invoiceId: number): Promise<{ type: string; createdAt: Date; value: string }[]> {
    const body = await this.json(`/invoice_logs?invoice=%2Finvoices%2F${invoiceId}&itemsPerPage=50`);
    return (body.member ?? []).map((l: any) => ({
      type: l.type,
      createdAt: new Date(l.createdAt),
      value: String(l.value ?? ''),
    }));
  }

  // ───────────────────────────── billing-list UI ─────────────────────────────

  /**
   * The PKV-Abrechnung list as the screen queries it. `datevStatus` is the UI's DATEV dropdown;
   * `treatmentStatus: 'Archiviert'` is what it takes to see the old-format rows at all.
   */
  async pkvBillingCount(params: Record<string, string> = {}): Promise<number> {
    const qs = Object.entries(params)
      .map(([k, v]) => `pkvBilling%5B${k}%5D=${encodeURIComponent(v)}`)
      .join('&');
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=1&pkvBilling=true${qs ? `&${qs}` : ''}&groups%5B%5D=billing%3Aread`,
    );
    return Number(body.totalItems ?? 0);
  }

  /**
   * Runs a navigation/interaction and waits for the requests it fires to come back, instead of
   * sleeping a flat guess. `fallbackMs` is the sleep this replaced, kept only as the upper bound.
   * See `Pages/util/settle.ts` for why the network signal is what makes "the page has stopped
   * changing" trustworthy.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 12_000) });
  }

  /** Opens `/billing` on the PKV-Abrechnung tab and returns the rendered table text. */
  async openPkvTab(): Promise<string> {
    await this.settle(() => this.page.goto('/billing', { waitUntil: 'domcontentloaded' }), 12_000);
    await this.settle(
      () => this.page.getByText('PKV-Abrechnung', { exact: false }).first().click(),
      10_000,
    );
    return await this.page.evaluate(() => (document.body as HTMLElement).innerText);
  }

  /**
   * The DATEV dropdown's option list. It is a `[role="dialog"]` like every other panel on the
   * redesigned surfaces, and only one is mounted at a time.
   */
  async datevFilterOptions(): Promise<string[]> {
    await this.page.getByText('DATEV: Alle', { exact: true }).first().click();
    await this.page.waitForTimeout(3000);
    const text = await this.page.locator('[role="dialog"]').first().innerText();
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^DATEV:/.test(l));
  }
  // ───────────────────── #3499: the false-match collision surface ────────────
  //
  // #3499 fixes the payment matcher accepting a cleared bank item on a loose reference/amount match
  // without also confirming the DEBTOR. The debtor account itself is not exposed anywhere on the API
  // (no /datev_debtors, /debtors, /accounts_receivable or /bank_items resource; the invoice payload
  // carries no debtor field and the patient only an `insuranceNumber`), so the matching RULE cannot
  // be observed from a client in any environment. What can be measured is the collision surface the
  // rule has to survive — which is what makes the fix necessary and what these helpers expose.

  /**
   * Amounts shared by more than one invoice in a set, as `amount -> ["number/patient", …]`.
   *
   * A shared amount is exactly the coincidence the pre-fix matcher could act on.
   */
  static amountCollisionsWithin(invoices: ScopedInvoice[]): Map<number, string[]> {
    const round = (n: number) => Math.round(n * 100) / 100;
    const byAmount = new Map<number, string[]>();
    for (const i of invoices) {
      const key = round(i.amount);
      byAmount.set(key, [...(byAmount.get(key) ?? []), `${i.number}/${i.patient}`]);
    }
    return new Map([...byAmount.entries()].filter(([, who]) => who.length > 1));
  }

  /**
   * How many times each invoice's amount occurs across the WHOLE invoice book — the real exposure,
   * since a colliding booking need not itself be an old-format invoice.
   */
  static amountFrequency(subject: ScopedInvoice[], book: InvoiceRow[]): Map<string, number> {
    const round = (n: number) => Math.round(n * 100) / 100;
    const freq = new Map<number, number>();
    for (const i of book) freq.set(round(i.amount), (freq.get(round(i.amount)) ?? 0) + 1);
    return new Map(subject.map((i) => [i.number, freq.get(round(i.amount)) ?? 0]));
  }
}
