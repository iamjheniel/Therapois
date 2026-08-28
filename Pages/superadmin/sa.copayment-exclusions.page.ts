import { Page, expect } from '@playwright/test';

/**
 * TheOrg-invoiced Blanko VOs excluded from copayment invoice generation — RC 3.11.1 #3426.
 *
 * #3276 made imported Blanko VOs eligible for copayment invoicing on the assumption that the
 * previous system (TheOrg) never invoiced a Blanko copayment. A cross-check against TheOrg's own
 * `Rez_Rechn_Nr_Zuza_Kasse` column found 33 VOs where it did. #3426 makes both automatic paths —
 * the one-time catch-up run and the ongoing eligibility check — permanently skip those 33, while
 * leaving manual admin creation available for them.
 *
 * **Staging carries the same VO numbers as production**, which is why the production list can be
 * driven here directly (the PM verified the mechanism the same way).
 *
 * Surfaces, all verified live on staging:
 *  - `GET /prescriptions?prescriptionId={number}&groups[]=billing:read` — one VO by its VO number,
 *    carrying `imported`, `blankoVO`, `copaymentLiable`, `validationStatus`, `treatmentStatus`,
 *    `copaymentAmount` and the current `invoice`.
 *  - `GET /prescriptions?copaymentBilling=true&groups[]=billing:read` — the Zuzahlungsverwaltung
 *    candidate set itself (14 rows on staging today). This is the population the ongoing generation
 *    draws from, so "eligible but uninvoiced" is decidable from it.
 *  - `GET /invoice_logs?invoice.prescription=/prescriptions/{id}` — **the discriminator this spec
 *    turns on**. An `invoice_created` entry carries `meta.type: "manual" | "automatic"`, its
 *    `createdAt` and `createdBy`. Nothing on the invoice itself says how it came to exist; this log
 *    does, so "was an invoice generated automatically after the fix shipped?" is answerable without
 *    guessing from timestamps.
 *  - `PATCH /prescriptions/{id}` `{validationStatus}` — the billing-validation write that re-fires
 *    the ongoing eligibility check (AC6's re-evaluation). Round-tripping `validated → for_fixing →
 *    validated` leaves the VO exactly as found.
 *  - `POST /prescriptions/{id}/generate-invoice` — the manual "Rechnung neu erstellen" action
 *    (AC4). Against a VO that already holds a `not_sent` draft it replaces that draft in place and
 *    answers `{"success":true,"invoiceId":…,"invoiceNumber":…}` with the number preserved, so it is
 *    safe to re-run.
 */

export type ExcludedVo = { number: string; theOrgInvoice: string; theOrgAmount: number };

/** Backfill Exclusions — 18 VOs the held one-time catch-up run would invoice today. */
export const BACKFILL_EXCLUSIONS: ExcludedVo[] = [
  { number: '4436-8', theOrgInvoice: '126-3003', theOrgAmount: 169.8 },
  { number: '5580-2', theOrgInvoice: '426-153', theOrgAmount: 10.0 },
  { number: '5686-2', theOrgInvoice: '426-1973', theOrgAmount: 107.6 },
  { number: '5695-7', theOrgInvoice: '326-2315', theOrgAmount: 115.1 },
  { number: '6043-2', theOrgInvoice: '526-487', theOrgAmount: 10.0 },
  { number: '6045-2', theOrgInvoice: '526-499', theOrgAmount: 10.0 },
  { number: '6504-1', theOrgInvoice: '326-2201', theOrgAmount: 58.6 },
  { number: '6536-1', theOrgInvoice: '226-1064', theOrgAmount: 69.9 },
  { number: '6598-1', theOrgInvoice: '226-1213', theOrgAmount: 69.9 },
  { number: '6671-1', theOrgInvoice: '326-2404', theOrgAmount: 63.98 },
  { number: '7083-2', theOrgInvoice: '226-1215', theOrgAmount: 71.26 },
  { number: '7106-1', theOrgInvoice: '226-1219', theOrgAmount: 91.98 },
  { number: '7172-1', theOrgInvoice: '226-1216', theOrgAmount: 63.98 },
  { number: '7275-1', theOrgInvoice: '326-2314', theOrgAmount: 141.5 },
  { number: '7285-1', theOrgInvoice: '226-1214', theOrgAmount: 46.22 },
  { number: '7396-1', theOrgInvoice: '226-1212', theOrgAmount: 63.98 },
  { number: '7733-1', theOrgInvoice: '426-1916', theOrgAmount: 36.3 },
  { number: '7973-1', theOrgInvoice: '426-1290', theOrgAmount: 10.0 },
];

/**
 * Future Exclusions — 15 VOs not yet billed. Three of them (2293-2, 5920-2, 7869-1) carry a €0.00
 * TheOrg amount; the ticket is explicit that a €0.00 TheOrg invoice still counts as "TheOrg
 * invoiced this" and must be excluded like every other row.
 */
export const FUTURE_EXCLUSIONS: ExcludedVo[] = [
  { number: '2293-2', theOrgInvoice: '126-2689', theOrgAmount: 0.0 },
  { number: '2421-10', theOrgInvoice: '126-2627', theOrgAmount: 10.0 },
  { number: '2604-8', theOrgInvoice: '126-3062', theOrgAmount: 98.1 },
  { number: '2824-6', theOrgInvoice: '326-2069', theOrgAmount: 310.0 },
  { number: '4565-9', theOrgInvoice: '326-2328', theOrgAmount: 167.7 },
  { number: '4868-3', theOrgInvoice: '326-2447', theOrgAmount: 178.1 },
  { number: '5714-3', theOrgInvoice: '126-2617', theOrgAmount: 10.0 },
  { number: '5920-2', theOrgInvoice: '326-833', theOrgAmount: 0.0 },
  { number: '6314-2', theOrgInvoice: '326-1762', theOrgAmount: 10.0 },
  { number: '6889-1', theOrgInvoice: '526-1027', theOrgAmount: 212.5 },
  { number: '6891-1', theOrgInvoice: '526-1029', theOrgAmount: 197.5 },
  { number: '6891-2', theOrgInvoice: '526-744', theOrgAmount: 10.0 },
  { number: '7118-1', theOrgInvoice: '526-1258', theOrgAmount: 287.5 },
  { number: '7869-1', theOrgInvoice: '426-1147', theOrgAmount: 0.0 },
  { number: '8077-2', theOrgInvoice: '526-1030', theOrgAmount: 197.5 },
];

export const ALL_EXCLUSIONS: ExcludedVo[] = [...BACKFILL_EXCLUSIONS, ...FUTURE_EXCLUSIONS];
export const EXCLUDED_NUMBERS = new Set(ALL_EXCLUSIONS.map((v) => v.number));

/**
 * When the exclusion landed on staging: the commit reference on issue #3426, 2026-08-20 07:14 UTC
 * (issue opened 05:32, PM sign-off 11:54 the same day).
 *
 * Everything the automatic paths created on staging BEFORE this is pre-fix residue and is expected
 * — a staging rehearsal of the catch-up run invoiced 16 of the 18 backfill-group VOs on
 * 2026-08-12 00:17, and 6891-1 on 2026-08-08. What the fix has to hold is that nothing automatic
 * has been created for any of the 33 *since*.
 */
export const FIX_SHIPPED_AT = new Date('2026-08-20T07:14:16Z');

/**
 * The control VO the PM used: an imported Blanko VO with the same profile as 5714-3 that is NOT on
 * the exclusion list. Its copayment invoice R426-89 was generated **automatically** at
 * 2026-08-20 11:52 UTC — after the fix — which is the live proof that #3426 narrowed the rule
 * rather than switching automatic generation off (AC5).
 */
export const CONTROL_VO = '4876-1';

/** Excluded VO kept in a fully eligible, still-uninvoiced state — the AC3/AC6 fixture. */
export const ELIGIBLE_UNINVOICED_VO = '6314-2';

/** Excluded VO holding a manually created `not_sent` draft — the AC4 fixture. */
export const MANUAL_DRAFT_VO = '5714-3';

/** VO states from which the ongoing generation would invoice a copayment. */
export const TERMINAL_STATUSES = ['Fertig Behandelt', 'Abgebrochen', 'Archiviert'];

export type VoBilling = {
  id: number;
  number: string;
  imported: boolean;
  blankoVO: boolean;
  /** `public` = GKV (copayment applies), `private` = PKV. */
  insuranceType: string | null;
  copaymentLiable: boolean;
  copaymentAmount: number;
  validationStatus: string | null;
  treatmentStatus: string;
  invoice: { id: number; invoiceNumber: string; status: string; issueDate: string } | null;
};

export type InvoiceCreation = {
  invoice: string;
  /** `manual` when an admin pressed the button, `automatic` for catch-up/ongoing generation. */
  type: string;
  createdAt: Date;
  createdBy: string | null;
  invoiceNumber: string | null;
};

export class CopaymentExclusionsPage {
  static readonly API = 'https://api.staging.therapios.de';

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
    expect(this.token, 'the session must carry a bearer token for the billing API').toBeTruthy();
  }

  private get auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${CopaymentExclusionsPage.API}${path}`, { headers: this.auth });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  static shape(row: any): VoBilling {
    return {
      id: row.id,
      number: row.prescriptionId,
      imported: row.imported === true,
      blankoVO: row.blankoVO === true,
      insuranceType: row.insuranceType ?? null,
      copaymentLiable: row.copaymentLiable === true,
      copaymentAmount: Number(row.copaymentAmount ?? 0),
      validationStatus: row.validationStatus ?? null,
      treatmentStatus: row.treatmentStatus,
      invoice: row.invoice?.id
        ? {
            id: row.invoice.id,
            invoiceNumber: row.invoice.invoiceNumber,
            status: row.invoice.status,
            issueDate: row.invoice.issueDate ?? '',
          }
        : null,
    };
  }

  // ──────────────────────────────── VO lookup ────────────────────────────────

  /**
   * One VO by its VO number. The filter is a prefix match — `6891-1` also returns `6891-10` if it
   * exists — so the exact number is re-checked here.
   */
  async voByNumber(number: string): Promise<VoBilling | null> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=10&prescriptionId=${encodeURIComponent(number)}&groups%5B%5D=billing%3Aread`,
    );
    const hit = (body.member ?? []).find((m: any) => m.prescriptionId === number);
    return hit ? CopaymentExclusionsPage.shape(hit) : null;
  }

  async vo(id: number): Promise<VoBilling> {
    return CopaymentExclusionsPage.shape(await this.json(`/prescriptions/${id}?groups%5B%5D=billing%3Aread`));
  }

  /** The Zuzahlungsverwaltung candidate set — the population the ongoing generation draws from. */
  async copaymentCandidates(): Promise<VoBilling[]> {
    const rows: VoBilling[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.json(
        `/prescriptions?page=${page}&itemsPerPage=100&copaymentBilling=true&groups%5B%5D=billing%3Aread`,
      );
      const member = body.member ?? [];
      rows.push(...member.map(CopaymentExclusionsPage.shape));
      if (member.length < 100) break;
    }
    return rows;
  }

  /**
   * The profile a VO must be in for the ongoing generation to invoice it *today*: an imported
   * Blanko VO, copayment-liable with an amount to bill, billing-validated, and past treatment.
   *
   * Deliberately conservative — copayment-exempt rows (`copaymentLiable: false`, amount 0) are also
   * invoiced by the product, but they cannot be told apart from rows that are simply not yet due,
   * so they are left out rather than asserted on.
   */
  static wouldInvoiceToday(vo: VoBilling): boolean {
    return (
      vo.imported &&
      vo.blankoVO &&
      vo.copaymentLiable &&
      vo.copaymentAmount > 0 &&
      vo.validationStatus === 'validated' &&
      TERMINAL_STATUSES.includes(vo.treatmentStatus)
    );
  }

  // ───────────────────────────── creation provenance ─────────────────────────

  /** `invoice_created` log entries for a VO — how each of its invoices came to exist. */
  async invoiceCreations(prescriptionId: number): Promise<InvoiceCreation[]> {
    const body = await this.json(
      `/invoice_logs?invoice.prescription=%2Fprescriptions%2F${prescriptionId}&itemsPerPage=50`,
    );
    return (body.member ?? [])
      .filter((l: any) => l.type === 'invoice_created')
      .map((l: any) => ({
        invoice: l.invoice,
        type: l.meta?.type ?? 'unknown',
        createdAt: new Date(l.createdAt),
        createdBy: l.createdBy?.fullName ?? null,
        invoiceNumber: l.meta?.invoiceNumber ?? null,
      }));
  }

  static automaticSince(creations: InvoiceCreation[], since: Date): InvoiceCreation[] {
    return creations.filter((c) => c.type === 'automatic' && c.createdAt >= since);
  }


  /**
   * The Zuzahlungsverwaltung filter in its **`allWithInvoice`** mode — every VO that carries an
   * invoice, not just the ones still awaiting one.
   *
   * Trap: this mode returns **both** invoice types. 108 of the 520 rows on staging are imported
   * non-Blanko VOs, and every one of them is `insuranceType: 'private'` with `copaymentLiable:
   * false` and a €0 copayment — they hold a **PKV** invoice, not a copayment invoice. #3276 is about
   * GKV copayments only, so anything asserting "imported non-Blanko VOs get no invoice" has to scope
   * itself with `isCopaymentRow()` or it reads a PKV invoice as a violation.
   */
  async copaymentInvoicePopulation(): Promise<VoBilling[]> {
    const rows: VoBilling[] = [];
    for (let page = 1; page <= 12; page++) {
      const body = await this.json(
        `/prescriptions?page=${page}&itemsPerPage=100&copaymentBilling=true` +
          `&copaymentBilling%5BallWithInvoice%5D=true&groups%5B%5D=billing%3Aread`,
      );
      const member = body.member ?? [];
      rows.push(...member.map(CopaymentExclusionsPage.shape));
      if (member.length < 100) break;
    }
    return rows;
  }

  /** GKV rows — the only ones a copayment invoice can belong to. */
  static isCopaymentRow(vo: VoBilling): boolean {
    return vo.insuranceType === 'public';
  }

  /**
   * Every `invoice_created` entry, bucketed by calendar day and `manual`/`automatic`. A one-time
   * catch-up run shows up here as a single day with a large automatic count — the staging run of
   * #3276's command produced exactly 82 on 2026-08-12.
   */
  async invoiceCreationsByDay(): Promise<Record<string, number>> {
    const buckets: Record<string, number> = {};
    for (let page = 1; page <= 10; page++) {
      const body = await this.json(`/invoice_logs?type=invoice_created&itemsPerPage=200&page=${page}`);
      const member = body.member ?? [];
      for (const log of member) {
        const key = `${String(log.createdAt).slice(0, 10)}/${log.meta?.type ?? 'unknown'}`;
        buckets[key] = (buckets[key] ?? 0) + 1;
      }
      if (member.length < 200) break;
    }
    return buckets;
  }

  // ──────────────────────────────── mutations ────────────────────────────────

  /**
   * The billing-validation write that re-fires the ongoing eligibility check. Callers round-trip
   * back to the value they found, so nothing is left changed.
   */
  async setValidationStatus(id: number, status: 'validated' | 'for_fixing' | 'unable_to_validate'): Promise<number> {
    const res = await this.page.request.patch(`${CopaymentExclusionsPage.API}/prescriptions/${id}`, {
      headers: { ...this.auth, 'Content-Type': 'application/merge-patch+json' },
      data: { validationStatus: status },
      timeout: 60_000,
    });
    return res.status();
  }

  /**
   * The manual "Rechnung neu erstellen" action (AC4). Against a VO already holding a `not_sent`
   * draft this replaces the draft in place and keeps the invoice number.
   */
  async generateInvoice(id: number): Promise<{ status: number; success: boolean; invoiceId: number | null; invoiceNumber: string | null; body: string }> {
    const res = await this.page.request.post(`${CopaymentExclusionsPage.API}/prescriptions/${id}/generate-invoice`, {
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      data: {},
      timeout: 120_000,
    });
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON error bodies are reported raw */
    }
    return {
      status: res.status(),
      success: parsed.success === true,
      invoiceId: parsed.invoiceId ?? null,
      invoiceNumber: parsed.invoiceNumber ?? null,
      body: text.slice(0, 400),
    };
  }
}
