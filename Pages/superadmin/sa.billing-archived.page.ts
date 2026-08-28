import { Page, expect } from '@playwright/test';
import { settleAfter } from '../util/settle';

/**
 * Finding invoices of archived VOs on Zuzahlungsverwaltung and PKV-Abrechnung — RC 3.11 #3277.
 *
 * A VO auto-archives ~30 days after it is billed, and its row used to vanish from both billing lists
 * even though the invoice is untouched and keeps its own status. #3277 adds "Archiviert" to the VO
 * Status filter on both tabs and makes search return archived rows even when that filter is not set.
 *
 * **Everything here is a GET.** The UI half only opens a tab and a dropdown.
 *
 * The screen is `/billing`, which carries four tabs — **Validierung / GKV-Abrechnung /
 * Zuzahlungsverwaltung (n) / PKV-Abrechnung (n)**. Do not confuse the default Validierung tab with
 * either billing list: it drives a different query (`exclude[treatmentStatus][]=Archiviert&…`) and
 * its VO Status dropdown offers a different set of options entirely (Pending / Bereit / Aktiv /
 * Abgebrochen / Fertig Behandelt / For Review) — reading *that* dropdown is the easy way to
 * mistakenly conclude "Archiviert" is missing.
 *
 * Query surface, all confirmed live:
 *  - `GET /prescriptions?copaymentBilling=true` — the Zuzahlungsverwaltung list (14 rows by default,
 *    matching the tab badge). `pkvBilling=true` is the PKV list.
 *  - `…&copaymentBilling[treatmentStatus]=Archiviert` — the filter this ticket exposes (380 rows;
 *    `pkvBilling[treatmentStatus]` gives 118). The value is the **German** status string:
 *    `archived` returns 0.
 *  - `…&search[<property>]=<value>` — the search box. `search` is an **array keyed by property**,
 *    not a free-text scalar: a bare `search=` answers *"search must be an array"* and `search[]=`
 *    answers *"The property "0" does not exist"*. The three paths AC4 names are
 *    `search[prescriptionId]`, `search[patient.lastName]` and **`search[invoices.invoiceNumber]`** —
 *    note the plural; `search[invoice.invoiceNumber]` is rejected as a non-existent association.
 */

export const BILLING_URL = '/billing';

export const TAB_COPAYMENT = 'Zuzahlungsverwaltung';
export const TAB_PKV = 'PKV-Abrechnung';

export const ARCHIVED = 'Archiviert';

/** The statuses the default (unfiltered) billing lists are restricted to. */
export const DEFAULT_STATUSES = ['Fertig Behandelt', 'Abgerechnet', 'Abgebrochen'];

/**
 * The invoice's own status set, as the API spells it — the nine the ticket lists in English.
 *
 * Used as a *cross-check that logs*, never as the hard assertion: the set is the product's to grow,
 * and pinning it turns a new status into a false failure. (Guessing `to_dc` for "To Send to Debt
 * Collector" did exactly that; the API says `to_send_to_dc`.) What AC3 actually requires is the
 * negative below — an invoice never picks up the VO's archived state.
 */
export const INVOICE_STATUSES = [
  'not_sent',
  'sent',
  'overdue',
  'reminded',
  'to_send_to_dc',
  'sent_to_dc',
  'paid',
  'cancelled',
  'on_hold',
];

/** Invoices have no archived state at all — this is the property AC3 turns on. */
export function looksArchived(invoiceStatus: string): boolean {
  return /archiv/i.test(invoiceStatus);
}

export type BillingRow = {
  id: number;
  number: string;
  treatmentStatus: string;
  insuranceType: string | null;
  invoice: { invoiceNumber: string; status: string } | null;
};

export type ListKind = 'copaymentBilling' | 'pkvBilling';

export class BillingArchivedPage {
  static readonly API = 'https://api.staging.therapios.de';

  private token: string | null = null;

  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
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
    expect(this.token, 'the session must carry a bearer token for the billing API').toBeTruthy();
  }

  private static shape(row: any): BillingRow {
    return {
      id: row.id,
      number: row.prescriptionId,
      treatmentStatus: row.treatmentStatus,
      insuranceType: row.insuranceType ?? null,
      invoice: row.invoice?.invoiceNumber
        ? { invoiceNumber: row.invoice.invoiceNumber, status: row.invoice.status }
        : null,
    };
  }

  /**
   * One page of a billing list.
   *
   * `treatmentStatus` applies the VO Status filter; `search` is the property-keyed search box.
   * Omitting both is the default view AC5 is about.
   */
  async list(
    kind: ListKind,
    options: { treatmentStatus?: string; search?: Record<string, string>; page?: number; perPage?: number } = {},
  ): Promise<{ total: number; rows: BillingRow[]; status: number; error: string | null }> {
    const params = [
      `page=${options.page ?? 1}`,
      `itemsPerPage=${options.perPage ?? 100}`,
      'groups%5B%5D=billing%3Aread',
      `${kind}=true`,
    ];
    if (options.treatmentStatus) {
      params.push(`${kind}%5BtreatmentStatus%5D=${encodeURIComponent(options.treatmentStatus)}`);
    }
    for (const [property, value] of Object.entries(options.search ?? {})) {
      params.push(`search%5B${encodeURIComponent(property)}%5D=${encodeURIComponent(value)}`);
    }
    const res = await this.page.request.get(`${BillingArchivedPage.API}/prescriptions?${params.join('&')}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (res.status() !== 200) {
      return { total: 0, rows: [], status: res.status(), error: (await res.text()).slice(0, 250) };
    }
    const body = await res.json();
    return {
      total: body.totalItems ?? 0,
      rows: (body.member ?? []).map(BillingArchivedPage.shape),
      status: 200,
      error: null,
    };
  }

  /** Walks a filtered list looking for one VO — the archived copayment set runs to several pages. */
  async findInList(kind: ListKind, treatmentStatus: string, number: string, maxPages = 6): Promise<{ row: BillingRow | null; page: number; scanned: number }> {
    let scanned = 0;
    for (let page = 1; page <= maxPages; page++) {
      const { rows } = await this.list(kind, { treatmentStatus, page });
      scanned += rows.length;
      const hit = rows.find((r) => r.number === number);
      if (hit) return { row: hit, page, scanned };
      if (rows.length < 100) break;
    }
    return { row: null, page: -1, scanned };
  }

  // ────────────────────────────────── UI half ────────────────────────────────

  /**
   * Runs a navigation/interaction and waits for the requests it fires to come back, instead of
   * sleeping a flat guess. `fallbackMs` is the sleep this replaced, kept only as the upper bound.
   * See `Pages/util/settle.ts` for why the network signal is what makes "the page has stopped
   * changing" trustworthy.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 12_000) });
  }

  async openBilling(): Promise<void> {
    await this.settle(() => this.page.goto(BILLING_URL, { waitUntil: 'domcontentloaded' }), 18_000);
  }

  /** Tab labels carry a count ("Zuzahlungsverwaltung (14)"), so they are matched by prefix. */
  async openTab(label: string): Promise<void> {
    await this.settle(
      () => this.page.getByText(new RegExp(`^${label}( \\(\\d+\\))?$`)).first().click({ timeout: 20_000 }),
      9_000,
    );
  }

  /** The options behind "VO Status: (Auswählen)" on whichever tab is open. */
  async voStatusOptions(): Promise<string[]> {
    await this.page.getByText(/VO Status/).filter({ visible: true }).first().click({ timeout: 20_000 });
    await this.page.waitForTimeout(3_000);
    const dialog = this.page.locator('[role="dialog"]').first();
    await expect(dialog, 'the VO Status dropdown must open').toBeVisible({ timeout: 15_000 });
    const text = await dialog.innerText();
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(1_500);
    return text.split('\n').map((line) => line.trim()).filter(Boolean);
  }
}
