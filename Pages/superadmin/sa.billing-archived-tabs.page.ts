import { APIRequestContext, Page, expect } from '@playwright/test';
import { STAGING_CREDENTIALS, mintUiSession, type Credentials } from '../util/api-token';

const API = 'https://api.staging.therapios.de';

export type ListKind = 'copaymentBilling' | 'pkvBilling';

export type BillingRow = {
  id: number;
  number: string;
  treatmentStatus: string;
  insuranceType: string | null;
  copaymentLiable: boolean | null;
  imported: boolean | null;
  blankoVO: boolean | null;
  invoice: { invoiceNumber: string; status: string } | null;
};

export type TabQuery = {
  /** The status tabs — `invoiceStatus=error` is the "Fehler" tab, not a status. */
  invoiceStatus?: string;
  /** Register mode: the "Alle mit Rechnung" tab. */
  allWithInvoice?: boolean;
  /** The VO Status dropdown. The value is the GERMAN string (#3277). */
  treatmentStatus?: string;
  /** The new checkbox. */
  hideArchived?: boolean;
  /** The property-keyed search box (#3277): `{ prescriptionId: '7943-3' }`. */
  search?: Record<string, string>;
};

/**
 * RC 3.15 #3835 — invoices of archived VOs on PKV-Abrechnung and Zuzahlungsverwaltung.
 *
 * A VO auto-archives ~30 days after billing while its invoice stays open, so by #3277 the invoice
 * fell off every tab and could only be found through the "Archiviert" VO Status filter or a search.
 * This ticket makes an archived VO follow the **Abgerechnet rule** — listed on the tab of its
 * invoice's status, never when it has no invoice — and adds "Archivierte VOs ausblenden" to take
 * them back out.
 *
 * Shipped as two commits on `release/3.15.0`, both `Ref #3835`, **no PR**:
 * `afe4de25055` (api) and `22fc8807c28` (app).
 *
 * ## The query surface
 *
 * All three filters take the same new override, confirmed live:
 *
 *  - `GET /prescriptions?pkvBilling=true&pkvBilling[hideArchived]=true`
 *  - `GET /prescriptions?copaymentBilling=true&copaymentBilling[hideArchived]=true`
 *  - `GET /invoices?cancelledRegister=true&cancelledRegister[hideArchived]=true`
 *
 * **An unregistered key is accepted and silently ignored** (`pkvBilling[zzzNot]=true` returns the
 * unfiltered 151), so "it answered 200" proves nothing — the deployment probe has to be that
 * `hideArchived=true` NARROWS, against a bogus-key control that does not. That control is the whole
 * reason the first test exists.
 *
 * ## Traps
 *
 * **`invoice` is `getActiveInvoice()`, which skips cancelled invoices and Stornos** (#3535). AC1
 * lists an archived VO that carries "an open one, **or only a cancelled one**", so eight archived
 * copayment VOs serve `invoice: null` and four of them are correctly listed. Reading that field to
 * decide "has an invoice" reports those four as a defect — the predicate is the filter's own
 * `invoice.id IS NOT NULL OR EXISTS cancelled original`, which from a client means asking
 * `/invoices?prescription=`.
 *
 * **The checkbox has no `aria-checked`.** It renders `role="checkbox"` but `accessibilityState`
 * never reaches the DOM (the RNW gap of #3400 / #3343 / #3505), so the state is the Material glyph:
 * **U+F0131 blank, U+F0132 marked**. It also has no accessible name, and there are 12 `role=checkbox`
 * elements on the page (one per row plus the header) — so it is located by its LABEL's position.
 *
 * **Clicking the label does nothing.** Only the box itself toggles; a click on
 * "Archivierte VOs ausblenden" leaves the glyph, the chips and the requests untouched, which reads
 * exactly like the checkbox being inert.
 *
 * **The i18n key is `hide_archived`, not the Developer Reference's `all_with_archived`** — that one
 * is a different, pre-existing key ("Alle inkl. Archivierte", 8 occurrences), so a probe written
 * from the reference finds a healthy count for the wrong thing.
 *
 * **The tab labels differ by page**: PKV-Abrechnung is German (Nicht gesendet / Überfällig /
 * Storniert), Zuzahlungsverwaltung is English (Not Sent / Overdue / Cancelled). The ticket's own
 * Localization Reference says so and this ticket does not change it.
 */
export class BillingArchivedTabsPage {
  /** Blank box / marked box, as the Material icon font encodes them. */
  static readonly GLYPH_UNTICKED = 'U+F0131';
  static readonly GLYPH_TICKED = 'U+F0132';

  static readonly CHECKBOX_LABEL_DE = 'Archivierte VOs ausblenden';
  static readonly CHECKBOX_LABEL_EN = 'Hide archived VOs';

  /** The invoice statuses each page gives a tab, in the order the chips are painted. */
  static readonly STATUS_TABS = [
    'not_sent', 'sent', 'overdue', 'sent_to_optica', 'reminded',
    'to_send_to_dc', 'sent_to_dc', 'paid', 'on_hold',
  ];

  /** The statuses the list was restricted to BEFORE this ticket — i.e. what ticking must reproduce. */
  static readonly PRE_3835_STATUSES = ['Fertig Behandelt', 'Abgerechnet', 'Abgebrochen'];

  private token = '';

  constructor(private request: APIRequestContext) {}

  async init(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  /** A GET that retries a thrown transport error and a 5xx — neither means "absent". */
  async get<T = any>(path: string, timeout = 300_000): Promise<{ status: number; body: T | null }> {
    let last = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
        last = res.status();
        if (last < 500) return { status: last, body: (await res.json().catch(() => null)) as T };
      } catch {
        last = 0;
      }
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
    return { status: last, body: null };
  }

  /** Build one tab's query string for a billing list. */
  static query(kind: ListKind, q: TabQuery = {}): string {
    const parts = [`${kind}=true`];
    if (q.invoiceStatus) parts.push(`${kind}%5BinvoiceStatus%5D=${encodeURIComponent(q.invoiceStatus)}`);
    if (q.allWithInvoice) parts.push(`${kind}%5BallWithInvoice%5D=true`);
    if (q.treatmentStatus) parts.push(`${kind}%5BtreatmentStatus%5D=${encodeURIComponent(q.treatmentStatus)}`);
    if (q.hideArchived) parts.push(`${kind}%5BhideArchived%5D=true`);
    for (const [k, v] of Object.entries(q.search ?? {})) {
      parts.push(`search%5B${encodeURIComponent(k)}%5D=${encodeURIComponent(v)}`);
    }
    return parts.join('&');
  }

  /** `totalItems` for one tab — which IS the number the chip paints (one query drives both). */
  async total(kind: ListKind, q: TabQuery = {}): Promise<number> {
    const { body } = await this.get<any>(
      `/prescriptions?itemsPerPage=1&${BillingArchivedTabsPage.query(kind, q)}`);
    return body?.totalItems ?? -1;
  }

  /** The "Storniert"/"Cancelled" tab is invoice-rooted (#3427), not a prescription query. */
  async cancelledRegisterTotal(hideArchived = false): Promise<number> {
    const extra = hideArchived ? '&cancelledRegister%5BhideArchived%5D=true' : '';
    const { body } = await this.get<any>(`/invoices?itemsPerPage=1&cancelledRegister=true${extra}`);
    return body?.totalItems ?? -1;
  }

  async rows(kind: ListKind, q: TabQuery = {}, itemsPerPage = 400): Promise<BillingRow[]> {
    const { body } = await this.get<any>(
      `/prescriptions?itemsPerPage=${itemsPerPage}&${BillingArchivedTabsPage.query(kind, q)}&groups%5B%5D=billing%3Aread`);
    return (body?.member ?? []).map((r: any) => ({
      id: r.id,
      number: r.prescriptionId,
      treatmentStatus: r.treatmentStatus,
      insuranceType: r.insuranceType ?? null,
      copaymentLiable: r.copaymentLiable ?? null,
      imported: r.imported ?? null,
      blankoVO: r.blankoVO ?? null,
      invoice: r.invoice?.invoiceNumber
        ? { invoiceNumber: r.invoice.invoiceNumber, status: r.invoice.status }
        : null,
    }));
  }

  /**
   * Every invoice a VO carries, cancelled ones and Stornos included.
   *
   * This is what AC1 turns on: the list's own predicate is "an active invoice OR a cancelled
   * original", and only this read can see the second half.
   */
  async invoicesOf(prescriptionId: number): Promise<{ number: string; status: string; type: string }[]> {
    const { body } = await this.get<any>(
      `/invoices?itemsPerPage=20&prescription=${prescriptionId}&groups%5B%5D=invoice-list%3Aread`);
    return (body?.member ?? []).map((i: any) => ({
      number: i.invoiceNumber, status: i.status, type: i.invoiceType,
    }));
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /**
   * Open /billing and switch to one billing tab.
   *
   * `mintUiSession` must run BEFORE the first navigation, and its refresh token is single-use
   * (#3460), so a spec that needs a second visit gets a second browser context rather than a
   * reload.
   */
  static async openBillingTab(
    page: Page, tab: 'PKV-Abrechnung' | 'Zuzahlungsverwaltung',
    creds: Credentials = STAGING_CREDENTIALS.superadmin,
  ): Promise<void> {
    await mintUiSession(page, creds);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/billing', { waitUntil: 'domcontentloaded' });
    await page.getByText(new RegExp(tab)).first().waitFor({ timeout: 180_000 });
    await page.getByText(new RegExp(`^${tab}`)).first().click({ timeout: 120_000 });
    // The checkbox is the readiness gate: it paints with the filter row, after the tab's own
    // request lands. Gating on the tab label alone hands the caller an unpainted screen, and
    // `chips()` then returns [] — which reads exactly like the counters being gone.
    await page.getByText(BillingArchivedTabsPage.CHECKBOX_LABEL_DE).first()
      .waitFor({ timeout: 180_000 });
    await BillingArchivedTabsPage.waitForChips(page);
  }

  /** Switch billing tab inside an already-open screen. */
  static async switchTab(page: Page, tab: string): Promise<void> {
    await page.getByText(new RegExp(`^${tab}`)).first().click({ timeout: 120_000 });
    await BillingArchivedTabsPage.waitForChips(page);
  }

  /** Click a status chip ("Überfällig", "Overdue", …). */
  static async openStatusTab(page: Page, label: string): Promise<void> {
    await page.getByText(label, { exact: true }).first().click({ timeout: 120_000 });
    await BillingArchivedTabsPage.waitForChips(page);
  }

  /**
   * Wait for the chip row to be PAINTED WITH ITS COUNTS.
   *
   * The chips render before their counts land, every one reading `(0)` — so a gate that merely
   * counts chips returns on a row of zeros and every AC3 comparison then fails with
   * `Expected 151, Received 0`, which reads exactly like the counters being broken. (That is how
   * this file first failed; the same shape as #3337's "0 von 0".)
   *
   * Readiness is therefore: enough chips, at least one non-zero count, and two consecutive
   * identical readings so a row caught mid-update is not taken as final.
   */
  private static async waitForChips(page: Page): Promise<void> {
    let previous = '';
    await expect
      .poll(async () => {
        const chips = await BillingArchivedTabsPage.chips(page);
        const signature = chips.map((c) => `${c.label}=${c.count}`).join('|');
        const ready = chips.length > 5 && chips.some((c) => c.count > 0) && signature === previous;
        previous = signature;
        return ready;
      }, { timeout: 240_000, intervals: [1_500] })
      .toBe(true);
  }

  /**
   * The painted tab chips as `{ label -> count }`.
   *
   * Each chip is TWO leaves — the label and its "(n)" — so they are paired by x-order along the
   * chip row, which is found by the y of the row holding "Alle".
   */
  static async chips(page: Page): Promise<{ label: string; count: number }[]> {
    return page.evaluate(() => {
      const leaves: { t: string; x: number; y: number }[] = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent || '').trim();
        if (!t) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        leaves.push({ t, x: r.x, y: r.y });
      });
      const anchor = leaves.find((l) => l.t === 'Alle' && l.y > 380);
      if (!anchor) return [];
      const row = leaves.filter((l) => Math.abs(l.y - anchor.y) < 12).sort((a, b) => a.x - b.x);
      const out: { label: string; count: number }[] = [];
      for (let i = 0; i < row.length; i += 1) {
        const m = /^\((\d+)\)$/.exec(row[i].t);
        if (m && out.length === 0 && i === 0) continue;
        if (m) {
          // the label is everything since the previous count
          let j = i - 1; const words: string[] = [];
          while (j >= 0 && !/^\(\d+\)$/.test(row[j].t)) { words.unshift(row[j].t); j -= 1; }
          out.push({ label: words.join(' '), count: Number(m[1]) });
        }
      }
      return out;
    });
  }

  /** The checkbox's state, read from its Material glyph — there is no `aria-checked`. */
  static async checkboxGlyph(page: Page): Promise<string> {
    return page.evaluate((label) => {
      const l = [...document.querySelectorAll('*')]
        .find((e) => !e.children.length && (e.textContent || '').trim() === label);
      if (!l) return 'NO-LABEL';
      const lr = l.getBoundingClientRect();
      let cp = 'NO-BOX';
      document.querySelectorAll('[role="checkbox"]').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (Math.abs(r.y - lr.y) < 30 && r.x < lr.x && r.x > lr.x - 120) {
          cp = 'U+' + ((e.textContent || '').trim().codePointAt(0) || 0).toString(16).toUpperCase();
        }
      });
      return cp;
    }, BillingArchivedTabsPage.CHECKBOX_LABEL_DE);
  }

  /**
   * Toggle the checkbox.
   *
   * Clicking the LABEL does nothing — only the box itself toggles — so the click is placed on the
   * box, 38px left of the label's own left edge.
   */
  static async toggleCheckbox(page: Page): Promise<void> {
    const before = await BillingArchivedTabsPage.checkboxGlyph(page);
    const lb = await page.getByText(BillingArchivedTabsPage.CHECKBOX_LABEL_DE).first().boundingBox();
    expect(lb, 'the checkbox label must be painted').toBeTruthy();
    await page.mouse.click(lb!.x - 38, lb!.y + lb!.height / 2);
    await expect
      .poll(() => BillingArchivedTabsPage.checkboxGlyph(page), { timeout: 120_000, intervals: [500] })
      .not.toBe(before);
    await BillingArchivedTabsPage.waitForChips(page);
  }

  /** Where the checkbox sits relative to the VO Status dropdown (AC4's placement clause). */
  static async filterRowOrder(page: Page): Promise<{ t: string; x: number }[]> {
    return page.evaluate(() => {
      const leaves: { t: string; x: number; y: number }[] = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 60) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        leaves.push({ t, x: r.x, y: r.y });
      });
      const anchor = leaves.find((l) => /^VO Status/.test(l.t));
      if (!anchor) return [];
      return leaves.filter((l) => Math.abs(l.y - anchor.y) < 14)
        .sort((a, b) => a.x - b.x).map((l) => ({ t: l.t, x: Math.round(l.x) }));
    });
  }

  /** The painted selection line ("9 VO ausgewählt"), or null when nothing is selected. */
  static async selectionText(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      let found: string | null = null;
      document.querySelectorAll('*').forEach((e) => {
        if (e.children.length) return;
        const t = (e.textContent || '').trim();
        if (t.length < 60 && /ausgew\u00e4hlt|selected/i.test(t)) found = t;
      });
      return found;
    });
  }

  /** Resolve a VO number to its API id. */
  async idOf(voNumber: string): Promise<number | null> {
    const { body } = await this.get<any>(
      `/prescriptions?itemsPerPage=2&exact%5BprescriptionId%5D=${encodeURIComponent(voNumber)}`);
    return (body?.member ?? [])[0]?.id ?? null;
  }
}
