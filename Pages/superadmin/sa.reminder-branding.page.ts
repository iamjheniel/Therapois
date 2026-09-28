import { APIRequestContext } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';
import { pdfDocText, pdfPageCount } from '../util/pdf-layout';

/**
 * The Zahlungserinnerung's branding source — RC 3.14 #3714, commit `a371c19f2` (PR #3726).
 *
 * A reminder letter used to print the branding **frozen on the original invoice**; it now prints
 * the entity's branding as it is at generation time. The invoice PDF is untouched and keeps its
 * snapshot, which is what makes the two documents comparable.
 *
 * ## The whole ticket is one comparison, and it needs no mutation
 *
 * `ZahlungserinnerungRenderer` changed two arguments:
 *
 * ```php
 * // before: $this->brandingResolver->resolve($invoice->isCuranoBrandingSnapshot(), …, $invoice->isRebrandBannerSnapshot())
 * // after:  $isCurano = $entity?->isRebranded() ?? $invoice->isCuranoBrandingSnapshot();
 * //         $this->brandingResolver->resolve($isCurano, …, $this->featureFlags->isEnabled('rebrand_banner_enabled'))
 * ```
 *
 * So for one invoice whose snapshot says Therapios while its entity is now Curano, the reminder and
 * the invoice must disagree — and that disagreement is AC1, AC2 and AC4 in a single measurement,
 * with nothing written anywhere. Downloading a reminder writes nothing (#3559: the controller
 * renders and returns, no persist, no flush) and neither does downloading an invoice.
 *
 * ## FOUR independent markers, because one variable could go wrong on its own
 *
 * `DocumentBrandingResolver::resolve()` returns `brand_name`, `brand_email`, `brand_website`,
 * `letter_date` and `show_rebrand_banner`. `brandMarkers()` reads four of them out of the rendered
 * text, so a build that fixed the email but not the date line still fails:
 *
 *  - `info@curano.de` vs `info@therapios.de`
 *  - `www.curano.de` vs `www.therapios.de`
 *  - the banner headline "Therapios heißt jetzt Curano"
 *  - **the date line's SHAPE** — Curano renders "City, DD.MM.YYYY" and Therapios a bare
 *    "DD.MM.YYYY". That one is easy to miss and is the only marker that is pure formatting.
 *
 * ## Traps
 *
 *  - **`pdfText()` drops a line of this letter** (#3559): it renders the Inkasso sentence as "…die
 *    Forderung an ein gestellt." Use `pdfDocText()` from `pdf-layout.ts`, as this page object does.
 *  - **The issuer NAME stays frozen on the reminder.** Only branding went live; `entity_name`,
 *    address, IBAN and BIC still come from `getIssuerNameSnapshot()`. So a correct letter is headed
 *    "Therapios Hamburg 1 GmbH" while announcing "Therapios heißt jetzt Curano!" — deliberate, and
 *    reported as a finding rather than asserted as a defect.
 *  - **A naive date-line regex swallows the preceding sentence.** "…zahlen Sie nichts. Hamburg,
 *    20.09.2026" will match as a 28-character "city" if the pattern allows spaces and periods;
 *    `cityDateLine()` requires a capitalised word (optionally hyphenated) immediately before the
 *    comma.
 *  - **The branding snapshots are serialized in NO group** — not `billing:read`, not
 *    `invoice-list:read` — so "what did this invoice freeze?" cannot be read from the API at all.
 *    It is read from the invoice's own rendered PDF instead, which is the authoritative answer
 *    anyway.
 *  - **The banner flag is not togglable from a client.** `rebrand_banner_enabled` resolves through
 *    `FeatureFlagService`, Unleash is not provisioned in any deployed environment, and the value
 *    arrives as the ECS env var `REBRAND_BANNER_ENABLED` — **staging ON, production OFF**. There is
 *    no `/feature_flags` endpoint (404, along with `/settings`, `/system_settings`,
 *    `/configurations`), so AC3's banner-off state is an ops change, not a test step.
 */

/** The rebrand banner's headline (#3481), the same pattern `LetterLayoutPage.BANNER` uses. */
export const BANNER = /Therapios\s+heißt\s+jetzt\s+Curano/;

export type BrandMarkers = {
  /** `brand_email` — the sharpest single marker; the two values share no substring. */
  email: 'curano' | 'therapios' | null;
  /** `brand_website`. */
  website: 'curano' | 'therapios' | null;
  /** `show_rebrand_banner`. */
  banner: boolean;
  /** The "City, DD.MM.YYYY" line Curano branding produces, or null when the date stands alone. */
  cityDateLine: string | null;
  /** Every bare date in the document, for reporting which one the letter is anchored on. */
  dates: string[];
};

export type DocumentRead = {
  label: string;
  status: number;
  pages: number;
  text: string;
  markers: BrandMarkers;
  /** The issuer block's first line — still the frozen snapshot on both documents. */
  issuerLine: string | null;
};

export class ReminderBrandingPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  // ───────────────────────────── branding readers ─────────────────────────────

  /**
   * Which brand a rendered document is printed in, from four independent markers.
   *
   * Four rather than one because `resolve()` sets each template variable separately — a build that
   * updated the email but not the date line would pass a single-marker check.
   */
  static brandMarkers(text: string): BrandMarkers {
    const flat = text.replace(/\s+/g, ' ');
    const email = flat.includes('info@curano.de')
      ? ('curano' as const)
      : flat.includes('info@therapios.de')
        ? ('therapios' as const)
        : null;
    const website = flat.includes('www.curano.de')
      ? ('curano' as const)
      : flat.includes('www.therapios.de')
        ? ('therapios' as const)
        : null;
    return {
      email,
      website,
      banner: BANNER.test(flat),
      cityDateLine: ReminderBrandingPage.cityDateLine(flat),
      dates: [...new Set(flat.match(/\d{2}\.\d{2}\.\d{4}/g) ?? [])],
    };
  }

  /**
   * The Curano date line, "City, DD.MM.YYYY".
   *
   * The city must be a capitalised word (hyphens allowed) sitting immediately before the comma. A
   * looser pattern swallows whatever precedes it — "…zahlen Sie nichts. Hamburg, 20.09.2026" reads
   * as a 28-character city — and then every document appears to carry a city date line.
   */
  static cityDateLine(text: string): string | null {
    const m = text.match(/(?:^|\s)([A-ZÄÖÜ][a-zäöüß]+(?:[- ][A-ZÄÖÜ][a-zäöüß]+)*),\s*(\d{2}\.\d{2}\.\d{4})/);
    return m ? `${m[1]}, ${m[2]}` : null;
  }

  /** Curano iff every marker says so; null when the document carries no branding at all. */
  static brandOf(m: BrandMarkers): 'curano' | 'therapios' | 'mixed' | null {
    const votes = [m.email, m.website, m.cityDateLine ? 'curano' : 'therapios'].filter(Boolean);
    if (votes.length === 0) return null;
    return votes.every((v) => v === 'curano')
      ? 'curano'
      : votes.every((v) => v === 'therapios')
        ? 'therapios'
        : 'mixed';
  }

  /** The issuer block's leading line, which is the frozen snapshot on both document types. */
  static issuerLine(text: string): string | null {
    return text.replace(/\s+/g, ' ').match(/^((?:Therapios|Curano)[^,]*,[^,]*,[^A-ZÄÖÜ]*)/)?.[1]?.trim() ?? null;
  }

  // ───────────────────────────── the two documents ─────────────────────────────

  /** `GET /invoices/{id}/reminder-letter` — rendered on demand, never stored, writes nothing. */
  async reminder(invoiceId: number): Promise<DocumentRead> {
    return this.read(`reminder ${invoiceId}`, `/invoices/${invoiceId}/reminder-letter`);
  }

  /** `GET /invoices/{id}/download` — the STORED invoice PDF (#3495), with its frozen branding. */
  async invoicePdf(invoiceId: number): Promise<DocumentRead> {
    return this.read(`invoice ${invoiceId}`, `/invoices/${invoiceId}/download`);
  }

  private async read(label: string, path: string): Promise<DocumentRead> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
      timeout: 240_000,
    });
    if (!res.ok()) {
      return { label, status: res.status(), pages: 0, text: '', markers: ReminderBrandingPage.brandMarkers(''), issuerLine: null };
    }
    const buf = Buffer.from(await res.body());
    // pdfDocText, never pdfText — the latter drops a line of this letter (#3559).
    const text = pdfDocText(buf).replace(/\s+/g, ' ').trim();
    return {
      label,
      status: res.status(),
      pages: pdfPageCount(buf),
      text,
      markers: ReminderBrandingPage.brandMarkers(text),
      issuerLine: ReminderBrandingPage.issuerLine(text),
    };
  }

  // ───────────────────────────── the population ─────────────────────────────

  /**
   * Overdue invoices that a reminder can actually be generated for.
   *
   * `Invoice::isReminderLetterAvailable()` = overdue AND no remindedDate AND PKV-billed (#3559).
   * The collection registers no `id[]` filter, so each row needs an item read for `remindedDate`.
   */
  async eligibleOverdue(limit = 8): Promise<{ id: number; invoiceNumber: string; insuranceType: string | null }[]> {
    const list = await this.get<{ member: Record<string, unknown>[] }>(
      '/invoices?status=overdue&itemsPerPage=40&groups%5B%5D=invoice-list:read',
    );
    const out: { id: number; invoiceNumber: string; insuranceType: string | null }[] = [];
    for (const row of list.member) {
      if (out.length >= limit) break;
      const item = await this.get<Record<string, any>>(`/invoices/${row.id}?groups%5B%5D=billing:read`);
      const insuranceType = (item.prescription?.insuranceType as string) ?? null;
      if (item.status !== 'overdue') continue;
      if (item.remindedDate) continue;
      if (insuranceType !== 'private' && insuranceType !== 'privat_basis') continue;
      out.push({ id: row.id as number, invoiceNumber: (row.invoiceNumber as string) ?? '', insuranceType });
    }
    return out;
  }

  /** Every entity's live rebrand state — `isRebranded()` is what the reminder now reads. */
  async entities(): Promise<{ id: number; name: string; isRebranded: boolean }[]> {
    const body = await this.get<{ member: Record<string, unknown>[] }>('/entities?itemsPerPage=50');
    return (body.member ?? []).map((e) => ({
      id: e.id as number,
      name: (e.name as string) ?? '',
      isRebranded: Boolean(e.isRebranded),
    }));
  }

  /** The surfaces a banner switch would live behind, none of which exists (#3481, re-measured). */
  async bannerSwitchProbes(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const path of ['/feature_flags', '/settings', '/system_settings', '/configurations', '/app_settings']) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${await this.bearer()}` },
        timeout: 60_000,
      });
      out[path] = res.status();
    }
    return out;
  }
}
