import { Page } from '@playwright/test';
import { AppPage } from '../base/app.page';
import { pdfPages, pageText, PdfPage, TextRun } from '../util/pdf-layout';

/**
 * The ePIN letter layout, across the document types that share it — RC 3.11.3 #3522/#3523/#3525,
 * and the two order forms of #3524 that deliberately do NOT share it.
 *
 * All four tickets are backend Twig changes, which has two consequences that shape this whole file:
 *
 *  1. **The app version cannot gate them.** The frontend bundle still reports `3.11.0` while the
 *     API renders 3.11.2's rebrand banner, so a version string says nothing about which template is
 *     deployed. Every spec here decides deployment by READING THE RENDERED PDF instead.
 *  2. **A stored PDF keeps whatever it was rendered with.** Invoice downloads are served from the
 *     store (#3332) and a Vorabinformation is archived at generation, so re-reading an existing
 *     document shows the OLD layout. Anything asserting a rendering change has to generate.
 *
 * That second point is also what makes the archive valuable: a patient's notice history is a
 * timeline of the template, so the exact deploy that changed a letter is observable. On staging the
 * layout changed between the 2026-08-26 and 2026-08-27 renders.
 */

export interface NoticeRef {
  id: number;
  createdAt: string;
  url: string | null;
}

export interface LetterRead {
  label: string;
  buffer: Buffer | null;
  pages: PdfPage[];
}

export class LetterLayoutPage extends AppPage {
  static readonly API = 'https://api.staging.therapios.de';

  /** The rebrand banner headline (#3481), reused by #3524. */
  static readonly BANNER = /Therapios\s+heißt\s+jetzt\s+Curano/;

  /**
   * Patients whose single active Physiotherapie VO carries exactly THREE prescribed treatments —
   * #3522 AC1's population. Chosen from the 253 active VOs with three, restricted to patients with
   * exactly one PT VO so the generated letter's table is unambiguous.
   */
  static readonly THREE_TREATMENT_PATIENTS = [8474, 8472, 8468] as const;

  /**
   * A patient with a long Vorabinformation archive AND more than three treatments (six), so it
   * serves two purposes: the before/after timeline, and AC1's explicit out-of-scope case (4+ rows
   * may still run to two pages).
   */
  static readonly HISTORY_PATIENT = 7793;

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.page
      .waitForFunction(() => !!localStorage.getItem('auth-state'), null, { timeout: 30_000 })
      .catch(() => {});
  }

  // ───────────────────────────────── transport ─────────────────────────────────

  private async json(path: string): Promise<{ status: number; json: any }> {
    return await this.page.evaluate(
      async ([base, p]: [string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* the caller asserts on the status */
        }
        const r = await fetch(`${base}${p}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        });
        const t = await r.text();
        try {
          return { status: r.status, json: JSON.parse(t) };
        } catch {
          return { status: r.status, json: t.slice(0, 300) };
        }
      },
      [LetterLayoutPage.API, path],
    );
  }

  /** Fetches a PDF. `absolute` addresses a pre-signed S3 URL, which must NOT carry the bearer. */
  private async pdf(path: string, absolute = false): Promise<Buffer | null> {
    const res = await this.page.evaluate(
      async ([base, p, abs]: [string, string, boolean]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* handled by the status check */
        }
        const r = await fetch(abs ? p : `${base}${p}`, abs ? {} : { headers: { Authorization: `Bearer ${token}` } });
        return { status: r.status, bytes: r.ok ? Array.from(new Uint8Array(await r.arrayBuffer())) : [] };
      },
      [LetterLayoutPage.API, path, absolute],
    );
    if (res.status !== 200 || !res.bytes.length) return null;
    const buf = Buffer.from(res.bytes);
    return buf.subarray(0, 5).toString() === '%PDF-' ? buf : null;
  }

  private static read(label: string, buffer: Buffer | null): LetterRead {
    return { label, buffer, pages: buffer ? pdfPages(buffer) : [] };
  }

  // ────────────────────────── Vorabinformation (#3522, #3525) ──────────────────────────

  /** A patient's notice archive, newest first. */
  async notices(patientId: number, limit = 30, order: 'asc' | 'desc' = 'desc'): Promise<NoticeRef[]> {
    const res = await this.json(
      `/pre_treatment_notices?page=1&itemsPerPage=${limit}` +
        `&order%5BcreatedAt%5D=${order}&patient=%2Fpatients%2F${patientId}`,
    );
    const rows = res.json?.member ?? res.json?.['hydra:member'] ?? [];
    return rows.map((r: any) => ({ id: r.id, createdAt: r.createdAt, url: r.signedFileUrl ?? null }));
  }

  async noticePdf(ref: NoticeRef): Promise<LetterRead> {
    if (!ref.url) return LetterLayoutPage.read(`notice ${ref.id}`, null);
    return LetterLayoutPage.read(`notice ${ref.id} (${ref.createdAt})`, await this.pdf(ref.url, true));
  }

  /**
   * Generates a FRESH Vorabinformation and returns it.
   *
   * Mutating by necessity: only a new render shows the current template. This archives the
   * patient's previous notice — the same write `admin_letter_country_marker.spec.ts` and
   * `admin_rebranding_banner.spec.ts` already make, for the same reason.
   */
  async generateNotice(
    patientId: number,
    variant: 'regular' | 'blanko' = 'regular',
    discipline: 'physiotherapy' | 'ergotherapy' | 'speech_therapy' = 'physiotherapy',
  ): Promise<LetterRead> {
    const res = await this.page.evaluate(
      async ([base, pid, disc, v]: [string, number, string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* handled by the status check */
        }
        const r = await fetch(`${base}/patients/${pid}/generate-pre-treatment-notice/${disc}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/ld+json' },
          body: JSON.stringify({ variant: v }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 200) };
      },
      [LetterLayoutPage.API, patientId, discipline, variant],
    );
    const label = `Vorabinformation ${variant} (patient ${patientId})`;
    if (res.status >= 300) return LetterLayoutPage.read(`${label} — generate ${res.status}`, null);
    // The POST response does not reliably carry a usable signed URL; re-read the archive.
    const [newest] = await this.notices(patientId, 1);
    if (!newest) return LetterLayoutPage.read(label, null);
    return LetterLayoutPage.read(`${label} — notice ${newest.id} ${newest.createdAt}`, await this.pdf(newest.url!, true));
  }

  // ─────────────────────────── invoices (#3523 regression, #3525 AC3) ───────────────────────────

  /** Recent invoices, newest first. */
  async invoices(limit = 6, query = ''): Promise<{ id: number; invoiceNumber: string }[]> {
    const res = await this.json(`/invoices?page=1&itemsPerPage=${limit}&order%5Bid%5D=desc${query}`);
    const rows = res.json?.member ?? res.json?.['hydra:member'] ?? [];
    return rows.map((r: any) => ({ id: r.id, invoiceNumber: r.invoiceNumber }));
  }

  /** An invoice PDF by id. Served from the STORE (#3332), so it shows the layout it was rendered with. */
  async invoicePdf(id: number, label = `invoice ${id}`): Promise<LetterRead> {
    return LetterLayoutPage.read(label, await this.pdf(`/invoices/${id}/download`));
  }

  // ───────────────────────────── order forms + Infoblatt (#3524) ─────────────────────────────

  /**
   * An order form straight from the renderer behind the CRM's "Generate … Order Form" preview.
   *
   * `POST /preview` is what the CRM modal itself calls (`downloadAsBlob('preview', {template, data})`).
   * Driving it directly rather than through the CRM avoids the practice walk — on staging no
   * practice in the first 25 rows has initial orders, so the UI route is not reliably reachable —
   * and it lets both `address` branches be exercised, which matters: the double comma of AC5 came
   * from `{% if address != 'ER' %}`, so a practice address is the case that used to break.
   */
  async orderForm(template: 'order' | 'follow_up', address: 'ER' | 'practice'): Promise<LetterRead> {
    const token = await this.page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('auth-state') || '').token as string;
      } catch {
        return null;
      }
    });
    const rows = [
      { patient: 'Mustermann, Max', voNumber: '1234-1', therapy: 'Physiotherapie', doctor: 'Dr. Test', lastTreatment: '01.08.2026' },
    ];
    const res = await this.page.request.post(`${LetterLayoutPage.API}/preview`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        template,
        data: {
          date: '27.08.2026',
          rows,
          address: address === 'ER' ? 'ER' : { name: 'Praxis Test', street: 'Teststr. 1', city: '12345 Berlin' },
          erName: 'QA Einrichtung',
        },
      },
      timeout: 120_000,
    });
    const label = `${template === 'order' ? 'Initial' : 'Follow-up'} order form (address=${address})`;
    if (res.status() !== 200) return LetterLayoutPage.read(`${label} — ${res.status()}`, null);
    const buf = await res.body();
    return LetterLayoutPage.read(label, buf.subarray(0, 5).toString() === '%PDF-' ? buf : null);
  }

  /** Infoblatt records, and the PDF behind one (`/ib_records/{id}/signed-url` → `contentUrl`). */
  async infoblattRecords(limit = 50): Promise<{ id: number; status: string; createdAt: string; file: string | null }[]> {
    const res = await this.json(`/ib_records?page=1&itemsPerPage=${limit}&order%5Bid%5D=desc`);
    const rows = res.json?.member ?? res.json?.['hydra:member'] ?? [];
    return rows.map((r: any) => ({ id: r.id, status: r.status, createdAt: r.createdAt, file: r.signedFileName ?? null }));
  }

  async infoblattPdf(id: number): Promise<LetterRead> {
    const su = await this.json(`/ib_records/${id}/signed-url`);
    const url = su.json?.contentUrl;
    if (!url) return LetterLayoutPage.read(`Infoblatt ${id} — no contentUrl (${su.status})`, null);
    return LetterLayoutPage.read(`Infoblatt ${id}`, await this.pdf(url, true));
  }

  // ─────────────────────────────── layout analysis ───────────────────────────────

  static text(read: LetterRead): string {
    return read.pages.map((p) => pageText(p)).join('\n');
  }

  static hasBanner(read: LetterRead): boolean {
    return LetterLayoutPage.BANNER.test(LetterLayoutPage.text(read));
  }

  /** 1-based page the closing sits on, or 0 when the letter has no closing. */
  static closingPage(read: LetterRead): number {
    return read.pages.findIndex((p) => /Mit freundlichen Grüßen/.test(pageText(p))) + 1;
  }

  /**
   * Rows of the "Anzahl / Behandlung / Preis" table — "<count><description><amount> €".
   *
   * A treatment row must carry a DESCRIPTION, not just numbers: the table's total line
   * ("74,08 €") also starts with digits and ends in a euro amount, so a purely numeric test
   * counts it as a fourth treatment and reports a 3-treatment letter as having four.
   */
  static treatmentRows(read: LetterRead): string[] {
    return LetterLayoutPage.text(read)
      .split('\n')
      .filter((l) => /^\d+\D.*€\s*$/.test(l) && /\p{L}{3,}/u.test(l));
  }

  /**
   * The y of the anchors #3522 AC3 must not move: the sender line inside the envelope window, the
   * date line, and the letter title — i.e. the fixed point where the body begins.
   */
  static anchors(read: LetterRead): { sender: number | null; date: number | null; title: number | null; salutation: number | null } {
    const runs = [...(read.pages[0]?.runs ?? [])].sort((a, b) => b.y - a.y);
    const y = (r?: TextRun) => (r ? +r.y.toFixed(2) : null);
    return {
      sender: y(runs.find((r) => r.size < 5.5)),
      date: y(runs.find((r) => /^\w+,\s*\d{2}\.\d{2}\.\d{4}$/.test(r.text))),
      title: y(runs.find((r) => /^Vorabinformation/.test(r.text))),
      salutation: y(runs.find((r) => /^Sehr geehrte/.test(r.text))),
    };
  }

  /**
   * Left x of each footer column on the document's last page.
   *
   * The footer is the band below 16% of the page height. Runs left of x=72 are excluded: the
   * machine-generated notice ("Dieses Schreiben wurde maschinell erstellt …") sits at x≈69.8,
   * slightly outside the footer table, and would otherwise read as a fifth column.
   */
  static footerColumns(read: LetterRead): number[] {
    const page = read.pages[read.pages.length - 1];
    if (!page) return [];
    const band = page.runs.filter((r) => r.y < page.height * 0.16 && r.x >= 72);
    const xs: number[] = [];
    for (const r of band.sort((a, b) => a.x - b.x)) if (!xs.some((x) => Math.abs(x - r.x) <= 3)) xs.push(+r.x.toFixed(1));
    return xs;
  }

  /**
   * Footer column offsets as a percentage of the footer's content width.
   *
   * 453pt is not a guess: the invoice footer's five columns measure 0 / 90.6 / 172.7 / 246.3 /
   * 370.9 pt, which over 453 is 0 / 20 / 38 / 54 / 82 % — exactly the 20/18/16/28/18 the shared
   * partial declares. That makes 453 the measured content width and lets the Vorabinformation's
   * four columns be compared against the same scale.
   */
  static readonly FOOTER_CONTENT_WIDTH = 453;

  static footerOffsetsPct(read: LetterRead): number[] {
    const xs = LetterLayoutPage.footerColumns(read);
    if (!xs.length) return [];
    return xs.map((x) => +(((x - xs[0]) / LetterLayoutPage.FOOTER_CONTENT_WIDTH) * 100).toFixed(1));
  }

  /** The lines of the footer's first column (the company-name column), top to bottom. */
  static footerFirstColumnLines(read: LetterRead): string[] {
    const page = read.pages[read.pages.length - 1];
    if (!page) return [];
    const xs = LetterLayoutPage.footerColumns(read);
    if (!xs.length) return [];
    const next = xs[1] ?? xs[0] + 100;
    return page.runs
      .filter((r) => r.y < page.height * 0.16 && r.x >= xs[0] - 2 && r.x < next - 2)
      .sort((a, b) => b.y - a.y)
      .map((r) => r.text);
  }

  // ─────────────────────────────── copayment FAQ (#3523) ───────────────────────────────

  /** The FAQ page of a copayment invoice: the page carrying the numbered questions. */
  static faqPage(read: LetterRead): PdfPage | null {
    return read.pages.find((p) => LetterLayoutPage.faqQuestions({ ...read, pages: [p] }).length >= 5) ?? null;
  }

  /** The numbered FAQ questions ("1. Was bedeutet …?"). */
  static faqQuestions(read: LetterRead): string[] {
    return LetterLayoutPage.text(read)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\s+\S/.test(l));
  }

  /** Font sizes on a page, by how many characters each renders — the dominant size is the body. */
  static sizeHistogram(page: PdfPage): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of page.runs) out[r.size] = (out[r.size] ?? 0) + r.text.length;
    return out;
  }

  /** The size that renders the most characters on a page. */
  static dominantSize(page: PdfPage): number {
    const hist = LetterLayoutPage.sizeHistogram(page);
    const [size] = Object.entries(hist).sort((a, b) => b[1] - a[1])[0] ?? ['0'];
    return Number(size);
  }

  /** Vertical extent of a page's content, and how much of the page it fills. */
  static contentExtent(page: PdfPage, ignoreBelow = 100): { top: number; bottom: number; span: number } {
    const ys = page.runs.filter((r) => r.y > ignoreBelow).map((r) => r.y);
    if (!ys.length) return { top: 0, bottom: 0, span: 0 };
    const top = Math.max(...ys);
    const bottom = Math.min(...ys);
    return { top: +top.toFixed(1), bottom: +bottom.toFixed(1), span: +(top - bottom).toFixed(1) };
  }

  /** `/CreationDate` out of the PDF — proves whether a download is a stored file or a fresh render. */
  static creationDate(read: LetterRead): string | null {
    return read.buffer?.toString('latin1').match(/\/CreationDate\s*\(([^)]*)\)/)?.[1] ?? null;
  }
}
