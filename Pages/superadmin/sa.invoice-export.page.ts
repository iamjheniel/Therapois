import { Page, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';

/**
 * Rechnungsexport — the per-Gesellschaft date-range invoice export (RC 3.12 #3493, PR #3521).
 *
 * A dedicated audit screen at **`/invoice-export`** (drawer entry "Rechnungsexport", beside
 * Abrechnung) plus one new endpoint. Three surfaces have to agree, and this page object addresses
 * all three so a spec can compare them:
 *
 * | surface | how it is addressed |
 * |---|---|
 * | the file | `POST /invoices/audit/export` with `{entity, from, to}` → `text/csv` |
 * | the on-screen table | `GET /invoices?billingEntity=&issuedFrom=&issuedTo=&groups[]=invoice-list:read` — the exact request the screen makes |
 * | the screen itself | `/invoice-export`, driven through the row `aria-label`s |
 *
 * **Traps.**
 * - The export body's field is **`entity`**, not `billingEntity` — and its dates are `from`/`to`,
 *   not the list's `issuedFrom`/`issuedTo`. Getting it wrong answers `400` with a readable `detail`.
 * - Row actions sit inside an `aria-disabled="true"` row container, so Playwright considers them
 *   "not enabled" and — with `actionTimeout: 0` project-wide — a plain `.click()` HANGS for the
 *   whole test budget. Every click here is `{ force: true }` with an explicit timeout.
 * - The log modal has **no `role="dialog"`**; it is identified by its heading
 *   "Rechnungsprotokoll — <invoice number>".
 * - Only one overlay can be open at a time: leaving the PDF or log modal up makes the next click
 *   land on it, which is how an "export does nothing" false finding appears. `closeOverlay()`.
 * - The table is paginated at 25 rows ("1-25 of 83"), ordered `order[invoiceDate]=asc`, so a row of
 *   interest is often not on the first page — `gotoPageContaining()`.
 */

export type CsvExport = {
  status: number;
  contentType: string | undefined;
  filename: string | null;
  /** The UTF-8 BOM Excel needs to read the umlauts — the house CSV shape. */
  hasBom: boolean;
  header: string[];
  rows: string[][];
  /** `detail` from the problem+json body when the request was rejected. */
  detail: string | null;
};

export type InvoiceRow = {
  id: number;
  invoiceNumber: string;
  status: string;
  invoiceType: string;
  invoiceAmount: number | null;
  issueDate: string | null;
  createdAt: string | null;
  patient: string | null;
  stornoNumber: string | null;
  originalInvoiceId: number | null;
};

/** The columns AC7 asks for, in the order the export writes them. */
export const EXPORT_COLUMNS = [
  'Rechnungsnummer',
  'Datum',
  'Status',
  'Betrag',
  'Versicherungsart',
  'Patient:in',
  'Gesellschaft',
  'Stornorechnung',
] as const;

/** Column index by name, for readable assertions on a row array. */
export const COL = Object.fromEntries(EXPORT_COLUMNS.map((c, i) => [c, i])) as Record<
  (typeof EXPORT_COLUMNS)[number],
  number
>;

export class InvoiceExportPage {
  static readonly API = 'https://api.staging.therapios.de';
  static readonly ROUTE = '/invoice-export';
  static readonly TITLE = 'Rechnungsexport';
  static readonly EXPORT_BUTTON = 'Exportieren (CSV)';
  static readonly PLACEHOLDER = 'Gesellschaft auswählen...';
  static readonly HINT = 'Gesellschaft und Zeitraum auswählen, um die Rechnungen anzuzeigen';

  private token: string | null = null;

  constructor(private page: Page) {}

  // ──────────────────────────────── sessions ─────────────────────────────────

  /** API-only entry: a bearer token, tolerating a spent storageState. */
  async connect(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials: STAGING_CREDENTIALS.superadmin });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  /** UI entry: mints a session the browser can actually boot with, then opens the screen. */
  async openScreen(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = await mintUiSession(this.page, credentials);
    await this.page.goto(InvoiceExportPage.ROUTE, { waitUntil: 'domcontentloaded' });
    await this.page
      .getByText(InvoiceExportPage.TITLE, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** A token for another role, so access control can be asserted from the same test. */
  async tokenFor(credentials: Credentials): Promise<string> {
    const res = await this.page.request.post(`${InvoiceExportPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password },
      timeout: 60_000,
    });
    expect(res.status(), `login as ${credentials.email}`).toBe(200);
    return (await res.json()).token;
  }

  private auth(token?: string) {
    return { Authorization: `Bearer ${token ?? this.token}` };
  }

  // ────────────────────────────────── API ────────────────────────────────────

  /** The Gesellschaften the selector offers. */
  async entities(): Promise<{ id: number; name: string }[]> {
    const res = await this.page.request.get(`${InvoiceExportPage.API}/entities?pagination=false&order%5Bid%5D=asc`, {
      headers: { ...this.auth(), Accept: 'application/ld+json' },
    });
    expect(res.status(), 'GET /entities').toBe(200);
    const body = await res.json();
    return (body.member ?? body['hydra:member'] ?? []).map((m: any) => ({ id: m.id, name: m.name }));
  }

  /**
   * The list behind the on-screen table — the same filters, group and ordering the screen sends.
   * `perPage` is deliberately allowed to exceed the screen's 25 so a spec can compare whole sets.
   */
  async list(
    entity: number,
    from: string,
    to: string,
    opts: { page?: number; perPage?: number; token?: string } = {},
  ): Promise<{ status: number; total: number; rows: InvoiceRow[] }> {
    const query =
      `?page=${opts.page ?? 1}&itemsPerPage=${opts.perPage ?? 200}&order%5BinvoiceDate%5D=asc` +
      `&billingEntity=${entity}&issuedFrom=${from}&issuedTo=${to}&groups%5B%5D=invoice-list%3Aread`;
    const res = await this.page.request.get(`${InvoiceExportPage.API}/invoices${query}`, {
      headers: { ...this.auth(opts.token), Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    if (res.status() !== 200) return { status: res.status(), total: 0, rows: [] };
    const body = await res.json();
    return {
      status: 200,
      total: body.totalItems ?? 0,
      rows: (body.member ?? []).map((m: any) => ({
        id: m.id,
        invoiceNumber: m.invoiceNumber,
        status: m.status,
        invoiceType: m.invoiceType,
        invoiceAmount: m.invoiceAmount ?? null,
        issueDate: m.issueDate ?? null,
        createdAt: m.createdAt ?? null,
        patient: m.prescription?.patient?.fullName ?? null,
        stornoNumber: m.stornoNumber ?? null,
        originalInvoiceId: m.originalInvoiceId ?? null,
      })),
    };
  }

  /**
   * `POST /invoices/audit/export` — the file itself.
   *
   * The body is `{entity, from, to}` with `Y-m-d` dates; anything else is rejected with a `detail`
   * that names the offending field, which is worth asserting rather than just the 400.
   */
  async exportCsv(entity: number | string, from: string, to: string, token?: string): Promise<CsvExport> {
    const res = await this.page.request.post(`${InvoiceExportPage.API}/invoices/audit/export`, {
      headers: { ...this.auth(token), 'Content-Type': 'application/json' },
      data: { entity, from, to },
      timeout: 300_000,
    });
    const buffer = await res.body();
    if (res.status() !== 200) {
      let detail: string | null = null;
      try {
        detail = JSON.parse(buffer.toString('utf8')).detail ?? null;
      } catch {
        detail = buffer.toString('utf8').slice(0, 200) || null;
      }
      return {
        status: res.status(),
        contentType: res.headers()['content-type'],
        filename: null,
        hasBom: false,
        header: [],
        rows: [],
        detail,
      };
    }
    const hasBom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const [header, ...rows] = InvoiceExportPage.parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
    return {
      status: 200,
      contentType: res.headers()['content-type'],
      filename: res.headers()['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] ?? null,
      hasBom,
      header: header ?? [],
      rows,
      detail: null,
    };
  }

  /**
   * A semicolon CSV with quoted cells — small enough to parse here rather than pull in a dependency
   * (the repo has none for CSV, and the export quotes only the two name columns).
   */
  static parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === ';') {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c !== '\r') cell += c;
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v !== ''));
  }

  /** Every invoice in the system, paged out — the population the export must not under-report. */
  async listEveryInvoice(perPage = 100): Promise<InvoiceRow[]> {
    const rows: InvoiceRow[] = [];
    for (let page = 1; ; page++) {
      const res = await this.page.request.get(
        `${InvoiceExportPage.API}/invoices?page=${page}&itemsPerPage=${perPage}&groups%5B%5D=invoice-list%3Aread`,
        { headers: { ...this.auth(), Accept: 'application/ld+json' }, timeout: 120_000 },
      );
      expect(res.status(), `GET /invoices page ${page}`).toBe(200);
      const body = await res.json();
      const member = body.member ?? body['hydra:member'] ?? [];
      for (const m of member) {
        rows.push({
          id: m.id,
          invoiceNumber: m.invoiceNumber,
          status: m.status,
          invoiceType: m.invoiceType,
          invoiceAmount: m.invoiceAmount ?? null,
          issueDate: m.issueDate ?? null,
          createdAt: m.createdAt ?? null,
          patient: m.prescription?.patient?.fullName ?? null,
          stornoNumber: m.stornoNumber ?? null,
          originalInvoiceId: m.originalInvoiceId ?? null,
        });
      }
      if (!member.length || rows.length >= (body.totalItems ?? 0)) return rows;
    }
  }

  /**
   * Which Gesellschaft an invoice is exported under.
   *
   * There is no field for it on the invoice — the export resolves it through the prescription — so
   * it is read back out of the exports themselves, once, and memoised for the rest of the test.
   */
  private ownership: Map<string, number> | null = null;
  async entityOfInvoice(invoiceNumber: string): Promise<number | null> {
    if (!this.ownership) {
      this.ownership = new Map();
      for (const entity of await this.entities()) {
        const csv = await this.exportCsv(entity.id, '2000-01-01', '2030-12-31');
        for (const row of csv.rows) this.ownership.set(row[0], entity.id);
      }
    }
    return this.ownership.get(invoiceNumber) ?? null;
  }

  /** The status-change log behind a row's "Log" action. */
  async invoiceLogs(invoiceId: number): Promise<{ status: number; total: number; entries: any[] }> {
    const res = await this.page.request.get(
      `${InvoiceExportPage.API}/invoice_logs?order%5BcreatedAt%5D=desc&invoice=${invoiceId}`,
      { headers: { ...this.auth(), Accept: 'application/ld+json' }, timeout: 60_000 },
    );
    if (res.status() !== 200) return { status: res.status(), total: 0, entries: [] };
    const body = await res.json();
    return { status: 200, total: body.totalItems ?? 0, entries: body.member ?? [] };
  }

  /** A row's PDF, by whichever of the two routes applies (a Storno is served via its ORIGINAL id). */
  async downloadPdf(path: string, token?: string): Promise<{ status: number; bytes: number; detail: string | null }> {
    const res = await this.page.request.get(`${InvoiceExportPage.API}${path}`, {
      headers: this.auth(token),
      timeout: 180_000,
    });
    const body = await res.body();
    let detail: string | null = null;
    if (res.status() !== 200) {
      try {
        detail = JSON.parse(body.toString('utf8')).detail ?? null;
      } catch {
        detail = null;
      }
    }
    return { status: res.status(), bytes: res.status() === 200 ? body.length : 0, detail };
  }

  // ─────────────────────────────────── UI ────────────────────────────────────

  async hintVisible(): Promise<boolean> {
    return (await this.page.evaluate(() => document.body.innerText)).includes(InvoiceExportPage.HINT);
  }

  /** The range control's label, e.g. "Von / Bis: 01.01.2026 - 31.12.2026". */
  async dateRangeLabel(): Promise<string | null> {
    const text = await this.page.evaluate(() => document.body.innerText);
    return text.match(/Von \/ Bis:[^\n]*/)?.[0] ?? null;
  }

  /**
   * Whether the export button is actually gated — read off the `<button>` ancestor, since the label
   * itself is a `div` that reports nothing.
   */
  async exportDisabled(): Promise<boolean> {
    return await this.page
      .getByText(InvoiceExportPage.EXPORT_BUTTON, { exact: true })
      .first()
      .evaluate((el) => {
        let node: HTMLElement | null = el as HTMLElement;
        for (let i = 0; i < 4 && node; i++) {
          if (node.tagName === 'BUTTON') return (node as HTMLButtonElement).disabled;
          node = node.parentElement;
        }
        return false;
      });
  }

  async openGesellschaftDropdown(): Promise<string[]> {
    await this.page
      .getByText(InvoiceExportPage.PLACEHOLDER, { exact: false })
      .first()
      .click({ timeout: 30_000 });
    await this.page.waitForTimeout(1500);
    return await this.page.evaluate(() =>
      [
        ...new Set(
          Array.from(document.querySelectorAll('div,span'))
            .map((e) => (e as HTMLElement).innerText?.trim())
            .filter((t): t is string => !!t && /^Curano /.test(t) && t.length < 60),
        ),
      ],
    );
  }

  /** Picks a Gesellschaft and waits for the table request it triggers to paint. */
  async selectGesellschaft(name: string): Promise<void> {
    await this.openGesellschaftDropdown();
    await this.page.getByText(name, { exact: true }).first().click({ timeout: 30_000 });
    await this.page
      .getByLabel('PDF anzeigen')
      .first()
      .waitFor({ state: 'attached', timeout: 60_000 })
      .catch(() => {}); // an empty Gesellschaft legitimately paints no rows
    await this.page.waitForTimeout(1500);
  }

  async tableHeaders(): Promise<string[]> {
    const text = await this.page.evaluate(() => document.body.innerText);
    const start = text.indexOf('Rechnungsnummer');
    if (start < 0) return [];
    return text
      .slice(start, start + 200)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 9);
  }

  /** "1-25 of 83" → 83. */
  async pagerTotal(): Promise<number | null> {
    const text = await this.page.evaluate(() => document.body.innerText);
    const match = text.match(/\d+\s*-\s*\d+\s+of\s+(\d+)/);
    return match ? Number(match[1]) : null;
  }

  /** The invoice numbers painted on the current page, in order. */
  async rowNumbers(): Promise<string[]> {
    return await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-label="PDF anzeigen"]'))
        .map((action) => {
          let row: HTMLElement | null = action as HTMLElement;
          for (let i = 0; i < 8 && row; i++) {
            const text = row.innerText ?? '';
            const match = text.match(/^\s*(S?R?\d+-\d+)\s*$/m);
            if (match) return match[1];
            row = row.parentElement;
          }
          return null;
        })
        .filter((n): n is string => !!n),
    );
  }

  /** The cells of one row, as the screen renders them (labels, not raw enum values). */
  async rowCells(invoiceNumber: string): Promise<string[] | null> {
    return await this.page.evaluate((number) => {
      const actions = Array.from(document.querySelectorAll('[aria-label="PDF anzeigen"]'));
      for (const action of actions) {
        let row: HTMLElement | null = action as HTMLElement;
        for (let i = 0; i < 8 && row; i++) {
          const lines = (row.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines[0] === number) return lines;
          row = row.parentElement;
        }
      }
      return null;
    }, invoiceNumber);
  }

  /** Pages forward until the wanted invoice number is painted. Returns the page index reached. */
  async gotoPageContaining(invoiceNumber: string, maxPages = 12): Promise<number> {
    for (let page = 1; page <= maxPages; page++) {
      if ((await this.rowNumbers()).includes(invoiceNumber)) return page;
      const next = this.page.locator('[aria-label="chevron-right"]').first();
      if (!(await next.count())) break;
      await next.click({ force: true, timeout: 30_000 });
      await this.page.waitForTimeout(3500);
    }
    return -1;
  }

  /**
   * Clicks a row's "PDF" or "Log" action.
   *
   * `force` is required: the row container carries `aria-disabled="true"` (a read-only table), and
   * with `actionTimeout: 0` a normal click would retry actionability until the test dies.
   */
  async clickRowAction(invoiceNumber: string, action: 'PDF anzeigen' | 'Log anzeigen'): Promise<boolean> {
    const index = (await this.rowNumbers()).indexOf(invoiceNumber);
    if (index < 0) return false;
    await this.page.getByLabel(action).nth(index).click({ force: true, timeout: 30_000 });
    await this.page.waitForTimeout(3000);
    return true;
  }

  /** The log modal's heading — it has no `role="dialog"` to wait on. */
  async logModalHeading(): Promise<string | null> {
    const text = await this.page.evaluate(() => document.body.innerText);
    return text.match(/Rechnungsprotokoll — [^\n]+/)?.[0] ?? null;
  }

  async closeOverlay(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(1200);
    const close = this.page.getByText('✕', { exact: true }).first();
    if (await close.count()) await close.click({ force: true, timeout: 10_000 }).catch(() => {});
    await this.page.waitForTimeout(800);
  }

  /** Clicks "Exportieren (CSV)" and returns the downloaded file's name and text, if any. */
  async clickExport(timeout = 120_000): Promise<{ filename: string | null; text: string | null }> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout }).catch(() => null),
      this.page
        .getByText(InvoiceExportPage.EXPORT_BUTTON, { exact: true })
        .first()
        .click({ force: true, timeout: 30_000 }),
    ]);
    if (!download) return { filename: null, text: null };
    const path = await download.path();
    const text = path ? readFileSync(path, 'utf8') : null;
    return { filename: download.suggestedFilename(), text };
  }

  /** Every visible label on the screen, for asserting that no mutating action is offered (AC6). */
  async labelsPresent(labels: string[]): Promise<Record<string, number>> {
    const text = await this.page.evaluate(() => document.body.innerText);
    return Object.fromEntries(labels.map((label) => [label, text.split(label).length - 1]));
  }
}
