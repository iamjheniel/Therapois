import { Page, expect, test } from '@playwright/test';
import { apiBearerToken, STAGING_CREDENTIALS } from '../util/api-token';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Invoice PDF downloads — RC 3.11 #3332 ("Invoices Download Instantly from Stored PDFs").
 *
 * Invoice PDFs used to be rendered on every download. They are now rendered once, when the invoice's
 * content is created or changed, and the download endpoints hand over the stored file.
 *
 * **How "stored vs rebuilt" is decided here.** Not by a stopwatch: a stored 774KB PDF took between
 * 1.2s and 14s to arrive depending on size and network, which overlaps the pre-fix 14–18s baseline
 * entirely. Two properties settle it objectively:
 *  - the PDF's own `/CreationDate`, stamped by Ghostscript at render time — a rebuilt-on-demand file
 *    carries *now*, a stored one carries the moment it was rendered (13–14 Aug 2026 for everything
 *    the backfill covered);
 *  - byte-identity across two consecutive downloads — two renders of the same invoice differ at
 *    least in that timestamp.
 *
 * Endpoints, all verified live on staging:
 *  - `GET /invoices/{id}/download` — copayment and PKV single-invoice download
 *  - `GET /invoices/{id}/storno/download` — the cancellation document for a cancelled invoice
 *  - `POST /prescriptions/{prescriptionId}/generate-invoice` — the "Rechnung neu erstellen" →
 *    "Entwurf ersetzen" path in Abrechnung → Zuzahlungsverwaltung (manual draft regeneration, AC2).
 *    The dialog states the draft is replaced in place, the invoice number is kept and no Storno is
 *    created.
 *  - `POST /invoices/bulk/download?disposition=inline` with `{"id": [...], "type": "copayment"|"pkv"}`
 *    — the "Rechnungen herunterladen" action on both billing tabs, returning a zip (#3333).
 */

export type InvoiceRef = { id: number; invoiceNumber: string; status: string; createdAt: string; updatedAt: string };
export type PdfDownload = {
  status: number;
  ms: number;
  bytes: number;
  contentType: string | undefined;
  filename: string | null;
  /** `/CreationDate` out of the PDF trailer — when this file was actually rendered. */
  createdAt: Date | null;
  sha256: string;
  /** `detail` out of the API's problem+json body on a non-200 — e.g. the #3495 409's message. */
  detail: string | null;
};

export type BulkZip = {
  status: number;
  ms: number;
  bytes: number;
  contentType: string | undefined;
  error: string | null;
  entries: string[];
  dir: string | null;
  /** `Fehlerbericht.txt` from inside the zip — the "could not be created" report (#3495 AC3). */
  report: string | null;
};

export class InvoicePdfsPage {
  static readonly API = 'https://api.staging.therapios.de';

  private token: string | null = null;

  constructor(private page: Page) {}

  /**
   * Establishes a bearer token for the invoice API.
   *
   * The page load is best-effort now. The current staging build keeps the access token in memory and
   * spends the saved `auth-refresh-token` on the first boot, so a storageState that has already been
   * used lands on the login screen with nothing in `localStorage` to read. `apiBearerToken()` falls
   * back to `POST /auth`, which is what keeps these API tests running against a spent session — see
   * `Pages/util/api-token.ts`.
   */
  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials: STAGING_CREDENTIALS.superadmin });
    expect(this.token, 'the session must carry a bearer token for the invoice API').toBeTruthy();
  }

  private get auth() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${InvoicePdfsPage.API}${path}`, {
      headers: { ...this.auth, Accept: 'application/ld+json' },
    });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  // ───────────────────────────────── fixtures ────────────────────────────────

  /** Invoices from the collection, oldest first (the API ignores `order[id]`). */
  async invoices(page = 1, itemsPerPage = 30): Promise<{ total: number; rows: InvoiceRef[] }> {
    const body = await this.json(`/invoices?page=${page}&itemsPerPage=${itemsPerPage}`);
    return {
      total: body.totalItems ?? 0,
      rows: (body.member ?? body['hydra:member'] ?? []).map((m: any) => ({
        id: m.id,
        invoiceNumber: m.invoiceNumber,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    };
  }

  async invoice(id: number): Promise<InvoiceRef> {
    const m = await this.json(`/invoices/${id}`);
    return { id: m.id, invoiceNumber: m.invoiceNumber, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt };
  }

  /** Cancelled invoices — the ones that own a Storno document (AC5). */
  async cancelledInvoices(limit = 5): Promise<InvoiceRef[]> {
    const body = await this.json(`/invoices?itemsPerPage=${limit}&status=cancelled`);
    return (body.member ?? []).map((m: any) => ({
      id: m.id,
      invoiceNumber: m.invoiceNumber,
      status: m.status,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  /**
   * Draft (`not_sent`) copayment invoices with the prescription that owns them — the regeneration
   * endpoint is addressed by prescription, not by invoice.
   */
  async draftCopaymentInvoices(limit = 10): Promise<{ prescriptionId: number; prescriptionNumber: string; invoice: InvoiceRef }[]> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=${limit}&copaymentBilling=true` +
        `&copaymentBilling%5BinvoiceStatus%5D=not_sent&groups%5B%5D=billing%3Aread`,
    );
    return (body.member ?? [])
      .filter((m: any) => m.invoice?.id)
      .map((m: any) => ({
        prescriptionId: m.id,
        prescriptionNumber: m.prescriptionId,
        invoice: {
          id: m.invoice.id,
          invoiceNumber: m.invoice.invoiceNumber,
          status: m.invoice.status,
          createdAt: m.invoice.issueDate ?? '',
          updatedAt: '',
        },
      }));
  }

  /** PKV invoices with their prescription — the PKV-Abrechnung half of the ticket's scope. */
  async pkvInvoices(limit = 8): Promise<{ prescriptionId: number; prescriptionNumber: string; invoice: InvoiceRef }[]> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=${limit}&pkvBilling=true&groups%5B%5D=billing%3Aread`,
    );
    return (body.member ?? [])
      .filter((m: any) => m.invoice?.id)
      .map((m: any) => ({
        prescriptionId: m.id,
        prescriptionNumber: m.prescriptionId,
        invoice: {
          id: m.invoice.id,
          invoiceNumber: m.invoice.invoiceNumber,
          status: m.invoice.status,
          createdAt: m.invoice.issueDate ?? '',
          updatedAt: '',
        },
      }));
  }

  /** The current invoice on a prescription — re-resolved after a regeneration replaces the draft. */
  async invoiceOfPrescription(prescriptionId: number): Promise<InvoiceRef | null> {
    const m = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    if (!m.invoice?.id) return null;
    return {
      id: m.invoice.id,
      invoiceNumber: m.invoice.invoiceNumber,
      status: m.invoice.status,
      createdAt: m.invoice.issueDate ?? '',
      updatedAt: '',
    };
  }

  // ───────────────────────────────── downloads ───────────────────────────────

  async downloadInvoice(id: number): Promise<PdfDownload> {
    return await this.download(`/invoices/${id}/download`);
  }

  async downloadStorno(id: number): Promise<PdfDownload> {
    return await this.download(`/invoices/${id}/storno/download`);
  }

  private async download(path: string): Promise<PdfDownload> {
    const started = Date.now();
    const res = await this.page.request.get(`${InvoicePdfsPage.API}${path}`, { headers: this.auth, timeout: 120_000 });
    const buffer = res.status() === 200 ? await res.body() : Buffer.alloc(0);
    // A failure carries API Platform's `problem+json`, whose `detail` is the message #3495 specifies
    // ("No stored PDF exists for this invoice."). It is read here rather than in the callers so a
    // 409 is never reported as a bare status code.
    let detail: string | null = null;
    if (res.status() !== 200) {
      const body = await res.text().catch(() => '');
      detail = (() => {
        try {
          return JSON.parse(body).detail ?? null;
        } catch {
          return body.slice(0, 200) || null;
        }
      })();
    }
    const ms = Date.now() - started;
    const text = buffer.toString('latin1');
    return {
      status: res.status(),
      ms,
      bytes: buffer.length,
      contentType: res.headers()['content-type'],
      filename: res.headers()['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] ?? null,
      createdAt: InvoicePdfsPage.pdfCreationDate(text),
      sha256: createHash('sha256').update(buffer).digest('hex'),
      detail,
    };
  }

  /**
   * Status + filename for a download without transferring the file — the API answers `HEAD` on both
   * download routes, and the response still carries the real `content-disposition`
   * (`Zuzahlung_Lange_R426-67.pdf`), which is only knowable by resolving the stored file. That makes
   * it a sound probe for "is a stored PDF there", and a ~6x cheaper one: 1.2s against 7.4s for the
   * same 790KB invoice.
   */
  async headDownload(id: number, opts: { storno?: boolean } = {}): Promise<{ status: number; filename: string | null; ms: number }> {
    const started = Date.now();
    const res = await this.page.request.head(
      `${InvoicePdfsPage.API}/invoices/${id}/${opts.storno ? 'storno/download' : 'download'}`,
      { headers: this.auth, timeout: 120_000 },
    );
    return {
      status: res.status(),
      filename: res.headers()['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] ?? null,
      ms: Date.now() - started,
    };
  }

  /** Every invoice in the collection, paged out. */
  async allInvoices(perPage = 100): Promise<InvoiceRef[]> {
    const rows: InvoiceRef[] = [];
    for (let page = 1; ; page++) {
      const body = await this.json(`/invoices?page=${page}&itemsPerPage=${perPage}`);
      const member = body.member ?? body['hydra:member'] ?? [];
      for (const m of member) {
        rows.push({ id: m.id, invoiceNumber: m.invoiceNumber, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt });
      }
      if (!member.length || rows.length >= (body.totalItems ?? 0)) return rows;
    }
  }

  /**
   * `HEAD`s a download route for every id, a few at a time — the population-level answer to "does
   * any invoice on this environment have no stored PDF" (#3495 AC2/AC5).
   */
  async sweepDownloads(ids: number[], opts: { storno?: boolean; concurrency?: number } = {}): Promise<Map<number, { status: number; filename: string | null }>> {
    const results = new Map<number, { status: number; filename: string | null }>();
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const head = await this.headDownload(id, { storno: opts.storno });
        results.set(id, { status: head.status, filename: head.filename });
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
    return results;
  }

  /** Copayment-eligible VOs that carry no invoice yet — the only source of a missing-PDF window. */
  async uninvoicedCopaymentCandidates(limit = 30): Promise<{ prescriptionId: number; prescriptionNumber: string; treatmentStatus: string }[]> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=${limit}&copaymentBilling=true&groups%5B%5D=billing%3Aread`,
    );
    return (body.member ?? [])
      .filter((m: any) => !m.invoice?.id)
      .map((m: any) => ({ prescriptionId: m.id, prescriptionNumber: m.prescriptionId, treatmentStatus: m.treatmentStatus }));
  }

  /** `GET /status` — unauthenticated, and the one place the API states its own version. */
  async apiVersion(): Promise<string | null> {
    const res = await this.page.request.get(`${InvoicePdfsPage.API}/status`, { timeout: 60_000 });
    if (res.status() !== 200) return null;
    return (await res.json().catch(() => ({})))?.version ?? null;
  }

  /**
   * The deployed web bundle's source, for the client half of #3495 (the 409 branch and the German
   * message live in the frontend, not the API — `api/` has no translator).
   */
  async appBundle(): Promise<string> {
    const index = await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 });
    const html = await index.text();
    const entry = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    expect(entry, 'the staging index must reference an entry bundle').toBeTruthy();
    const bundle = await this.page.request.get(`https://staging.therapios.de${entry}`, { timeout: 120_000 });
    return await bundle.text();
  }

  /** Parses a PDF `/CreationDate (D:20260814003250Z00'00')` into a Date. */
  static pdfCreationDate(pdf: string): Date | null {
    const raw = pdf.match(/\/CreationDate\s*\(D:(\d{14})/)?.[1];
    if (!raw) return null;
    const [, y, mo, d, h, mi, s] = raw.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)!;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }

  /** Minutes between a PDF's render time and now — the "was this built for me just now?" measure. */
  static ageMinutes(download: PdfDownload): number {
    if (!download.createdAt) return NaN;
    return (Date.now() - download.createdAt.getTime()) / 60_000;
  }

  // ─────────────────────────────── bulk download ─────────────────────────────

  /**
   * The bulk zip behind "Rechnungen herunterladen" on Zuzahlungsverwaltung (`copayment`) and
   * PKV-Abrechnung (`pkv`) — #3333.
   *
   * `headersMs` separates the server's work from the transfer: the zip is streamed, so a large
   * download's wall clock is mostly bytes on the wire, not assembly. Measured from a UK-ish link the
   * same staging zips run at ~0.4MB/s, which is why timing alone says nothing about whether the PDFs
   * inside were stored or rebuilt — `zipEntries()` and the entries' own `/CreationDate` do.
   */
  async bulkDownload(ids: number[], type: 'copayment' | 'pkv'): Promise<BulkZip> {
    const started = Date.now();
    const res = await this.page.request.post(`${InvoicePdfsPage.API}/invoices/bulk/download?disposition=inline`, {
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      data: { id: ids, type },
      timeout: 600_000,
    });
    const body = await res.body();
    const ms = Date.now() - started;
    if (res.status() !== 200) {
      return { status: res.status(), ms, bytes: body.length, contentType: res.headers()['content-type'], error: body.toString('utf8').slice(0, 300), entries: [], dir: null, report: null };
    }
    const dir = test.info().outputPath(`bulk-${type}-${ids.length}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'invoices.zip');
    writeFileSync(file, body);
    const entries = InvoicePdfsPage.zipEntries(file);
    return {
      status: 200,
      ms,
      bytes: body.length,
      contentType: res.headers()['content-type'],
      error: null,
      entries,
      dir,
      report: entries.some((e) => e === 'Fehlerbericht.txt') ? InvoicePdfsPage.zipTextEntry(file, 'Fehlerbericht.txt') : null,
    };
  }

  /**
   * Entry names inside a zip, via the `unzip` CLI (no third-party dependency in this repo).
   *
   * An empty zip is a legitimate answer — a selection of ids that match no eligible invoice returns
   * a valid 22-byte archive — and `unzip -Z` exits non-zero on it, so that case returns `[]` rather
   * than throwing.
   */
  static zipEntries(zipPath: string): string[] {
    try {
      const listing = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8' });
      return listing.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch (error) {
      const output = String((error as { stdout?: string; stderr?: string }).stdout ?? '') +
        String((error as { stderr?: string }).stderr ?? '');
      if (/empty|zipfile is empty|End-of-central-directory/i.test(output)) return [];
      const entries = output.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('warning'));
      if (entries.length) return entries;
      throw error;
    }
  }

  /** One text entry out of a zip, via `unzip -p` — used for the bulk `Fehlerbericht.txt` (AC3). */
  static zipTextEntry(zipPath: string, entry: string): string | null {
    try {
      return execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
    } catch {
      return null;
    }
  }

  /** Extracts a zip and reads each PDF's `/CreationDate` — the stored-vs-rebuilt evidence again. */
  static zipPdfCreationDates(zipPath: string, into: string): Record<string, Date | null> {
    mkdirSync(into, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', into]);
    const dates: Record<string, Date | null> = {};
    for (const name of readdirSync(into)) {
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      dates[name] = InvoicePdfsPage.pdfCreationDate(readFileSync(join(into, name)).toString('latin1'));
    }
    return dates;
  }

  /**
   * Same request through the browser, reporting when the response *headers* arrived versus when the
   * last byte did — the only way from here to tell slow assembly from a slow pipe.
   */
  async bulkDownloadTiming(ids: number[], type: 'copayment' | 'pkv'): Promise<{ status: number; size: number; headersMs: number; totalMs: number }> {
    return await this.page.evaluate(
      async ([base, token, idList, kind]: [string, string, number[], string]) => {
        const started = performance.now();
        const res = await fetch(`${base}/invoices/bulk/download?disposition=inline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: idList, type: kind }),
        });
        const headers = performance.now();
        const blob = await res.blob();
        return {
          status: res.status,
          size: blob.size,
          headersMs: Math.round(headers - started),
          totalMs: Math.round(performance.now() - started),
        };
      },
      [InvoicePdfsPage.API, this.token!, ids, type] as [string, string, number[], string],
    );
  }

  /** Invoice ids of every copayment row that has an invoice, across as many pages as asked for. */
  async copaymentInvoiceIds(pages = 1, perPage = 100): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; page <= pages; page++) {
      const body = await this.json(
        `/prescriptions?page=${page}&itemsPerPage=${perPage}&copaymentBilling=true` +
          `&copaymentBilling%5BallWithInvoice%5D=true&groups%5B%5D=billing%3Aread`,
      );
      for (const row of body.member ?? []) if (row.invoice?.id) ids.push(row.invoice.id);
    }
    return ids;
  }

  // ──────────────────────────────── mutations ────────────────────────────────

  /**
   * The manual draft regeneration behind "Rechnung neu erstellen" → "Entwurf ersetzen" (AC2).
   *
   * Replaces the draft in place; the dialog states the invoice number is preserved and no Storno is
   * created. Only ever called against a `not_sent` draft.
   */
  /**
   * Creates the copayment invoice for a VO that has none — the same
   * `POST /prescriptions/{id}/generate-invoice` the draft regeneration uses, which returns
   * `{success, invoiceId, invoiceNumber}`.
   *
   * **This is the only client-reachable way to produce an invoice with no stored PDF.** The file is
   * written by an async worker, so for the ~30s until it lands `pdf_path` is NULL — which is exactly
   * the state #3495's ACs describe. Measured on staging: the 409 was live 2.6s after the POST and
   * the stored file arrived 28s after it.
   *
   * It is also irreversible: invoices cannot be deleted (the epic has a separate no-deletion
   * ticket), so each call permanently consumes an invoice number. Never call it from an ungated
   * test.
   */
  async createInvoiceForPrescription(prescriptionId: number): Promise<{ status: number; invoiceId: number | null; invoiceNumber: string | null }> {
    const res = await this.page.request.post(
      `${InvoicePdfsPage.API}/prescriptions/${prescriptionId}/generate-invoice`,
      { headers: { ...this.auth, 'Content-Type': 'application/json' }, data: {}, timeout: 120_000 },
    );
    const body = await res.json().catch(() => ({}) as any);
    return { status: res.status(), invoiceId: body?.invoiceId ?? null, invoiceNumber: body?.invoiceNumber ?? null };
  }

  async regenerateDraft(prescriptionId: number): Promise<number> {
    const res = await this.page.request.post(
      `${InvoicePdfsPage.API}/prescriptions/${prescriptionId}/generate-invoice`,
      { headers: { ...this.auth, 'Content-Type': 'application/json' }, data: {}, timeout: 120_000 },
    );
    return res.status();
  }
}
