import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The Zahlungserinnerung (payment reminder letter) for overdue PKV invoices (RC 3.13 #3559).
 *
 * An Overdue PKV or Privat Basis invoice gains a ready-to-send reminder letter, singly or in bulk,
 * and the automatic Reminded → To Debt Collector timer moves from 7 to 14 days.
 *
 * **Downloading a letter writes NOTHING, and that is worth stating because the ticket's own PM
 * notes say otherwise** ("remindedDate field stamped once on download"). `ReminderLetterDownloadController`
 * checks the audit voter, calls `isReminderLetterAvailable()`, renders and returns — no `persist`,
 * no `flush`, and the same is true of the bulk controller and the renderer. Verified live as well:
 * the fixtures' `remindedDate`, `status` and `updatedAt` are unchanged after both downloads. This
 * matters beyond tidiness — stamping on download would mark the invoice Reminded before the admin
 * has sent anything, starting the 14-day debt-collection clock early and contradicting the ticket's
 * "does NOT change the manual action admins already use to mark an invoice Reminded".
 *
 * **The one eligibility rule, `Invoice::isReminderLetterAvailable()`**, is all three ACs at once:
 * `status === OVERDUE` (AC1/AC9) `&& remindedDate === null` (AC5) `&& insuranceType.usesPkvBilling()`
 * (AC2; copayment/GKV never — AC10). Both endpoints apply it, so the bulk path cannot diverge.
 *
 * **Traps:**
 * - the bulk payload key is **`id`**, not `invoiceIds` (#3333's convention); `invoiceIds` answers
 *   `400 Invalid payload: "id" (array) is required`;
 * - **`/invoices?id[]=` is SILENTLY IGNORED** — it returns the whole 587-row book, so a "fetch these
 *   invoices" helper written that way reports whatever the first page holds. `/prescriptions?id[]=`
 *   and `/patients?id[]=` DO work, so the convention does not carry across collections;
 * - `remindedDate` and `totalOnHoldDays` are in the DEFAULT group only, while `invoiceType` is in
 *   `invoice-list:read` only (#3604) — the population needs two reads;
 * - the transition is `>= REMINDER_PAYMENT_DAYS` **minus `totalOnHoldDays`**, so "exactly 14 days"
 *   only reads cleanly on an invoice with no on-hold days.
 *
 * Read-only: every request is a GET except the bulk download, which is a POST that renders and
 * returns a zip without touching a row.
 */

export type OverdueInvoice = {
  id: number;
  invoiceNumber: string;
  status: string;
  invoiceType: string | null;
  insuranceType: string | null;
  remindedDate: string | null;
  totalOnHoldDays: number | null;
  invoiceAmount: number | null;
};

/** `Invoice::REMINDER_PAYMENT_DAYS` — the window this ticket moved from 7. */
export const REMINDER_PAYMENT_DAYS = 14;

/** The 409 body both endpoints return for an ineligible invoice. */
export const NOT_AVAILABLE = 'No reminder letter is available for this invoice.';

export class ReminderLetterPage {
  private token: string | null = null;

  constructor(
    private request: APIRequestContext,
    token?: string,
  ) {
    this.token = token ?? null;
  }

  /**
   * The bearer this page object is using; exposed so a spec can make a one-off read.
   *
   * Named `bearerToken`, not `token`: the private FIELD below is already called `token`, and a
   * method of the same name is silently overwritten by the constructor's `this.token = …`, so it
   * reads back as `null` and the call site fails with "token is not a function".
   */
  async bearerToken(): Promise<string> {
    return this.bearer();
  }

  /** One invoice under the DEFAULT group — where `remindedDate` and `totalOnHoldDays` live. */
  async invoice(id: number): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(`/invoices/${id}`);
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

  /** Every overdue invoice, with the three fields the eligibility rule reads. */
  async overdueInvoices(): Promise<OverdueInvoice[]> {
    const list = await this.get<{ member: Record<string, any>[] }>(
      '/invoices?status=overdue&itemsPerPage=300&groups%5B%5D=invoice-list:read',
    );
    const out: OverdueInvoice[] = [];
    for (const row of list.member) {
      // No id[] filter on this collection (see the class docblock) — read the items.
      const item = await this.get<Record<string, any>>(`/invoices/${row.id}?groups%5B%5D=billing:read`);
      const presc = item.prescription ?? {};
      out.push({
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        status: item.status,
        invoiceType: row.invoiceType ?? null,
        insuranceType: typeof presc === 'object' ? (presc.insuranceType ?? null) : null,
        remindedDate: item.remindedDate ?? null,
        totalOnHoldDays: item.totalOnHoldDays ?? null,
        invoiceAmount: item.invoiceAmount ?? null,
      });
    }
    return out;
  }

  /** A faithful port of `Invoice::isReminderLetterAvailable()`. */
  isReminderLetterAvailable(inv: OverdueInvoice): boolean {
    return (
      inv.status === 'overdue' &&
      inv.remindedDate === null &&
      (inv.insuranceType === 'private' || inv.insuranceType === 'privat_basis')
    );
  }

  /** Download one letter. Returns the raw bytes so the caller can read the rendered text. */
  async reminderLetter(invoiceId: number): Promise<{ status: number; contentType: string; body: Buffer; detail: string }> {
    const token = await this.bearer();
    const res = await this.request.get(`${API_BASE}/invoices/${invoiceId}/reminder-letter`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 180_000,
    });
    const body = Buffer.from(await res.body());
    let detail = '';
    if (!res.ok()) {
      try {
        detail = JSON.parse(body.toString('utf8')).detail ?? '';
      } catch {
        /* a PDF body is not JSON */
      }
    }
    return { status: res.status(), contentType: res.headers()['content-type'] ?? '', body, detail };
  }

  /** AC3 — several letters as one zip. The payload key is `id`, not `invoiceIds`. */
  async bulkReminderLetters(invoiceIds: number[]): Promise<{ status: number; contentType: string; body: Buffer }> {
    const token = await this.bearer();
    const res = await this.request.post(`${API_BASE}/invoices/reminder-letters/bulk/download`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { id: invoiceIds },
      timeout: 300_000,
    });
    return { status: res.status(), contentType: res.headers()['content-type'] ?? '', body: Buffer.from(await res.body()) };
  }

  /** The status moves for one invoice, oldest first — how the 14-day timing is measured. */
  async statusTrail(invoiceId: number): Promise<{ at: string; from: string | null; to: string | null; automatic: boolean }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/invoice_logs?invoice=${invoiceId}&itemsPerPage=50&order%5BcreatedAt%5D=asc`,
    );
    return body.member
      .filter((l) => String(l.type) === 'status_change')
      .map((l) => ({
        at: l.createdAt ?? '',
        from: l.oldValue ?? null,
        to: l.newValue ?? null,
        automatic: String(l.value ?? '').includes('"automatic"'),
      }));
  }

  /** Whole days between the reminded stamp and the automatic move to To Debt Collector. */
  daysToDebtCollector(remindedDate: string, movedAt: string): number {
    const a = new Date(remindedDate.slice(0, 10) + 'T00:00:00Z').getTime();
    const b = new Date(movedAt.slice(0, 10) + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86_400_000);
  }
}
