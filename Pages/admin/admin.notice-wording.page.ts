import { APIRequestContext, Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, mintUiSession } from '../util/api-token';
import { pdfDocText, pdfPageCount } from '../util/pdf-layout';
import { pdfText } from '../util/pdf-text';

/**
 * The Vorabinformation's exemption block, as it is actually printed — RC 3.14 #3668,
 * commit `9fd6fa547`.
 *
 * Three sentences change in the copayment-exemption block of the standard letter and the
 * equivalent three in the Blanko variant (Ergotherapie and Physiotherapie, from #3228).
 *
 * ## A rendering ticket has exactly one authoritative surface: a FRESHLY GENERATED PDF
 *
 * A notice is archived at generation and **never re-rendered**, so every letter already in the
 * Document Center keeps the wording it was made with — the ticket says so itself, and it is why
 * reading the archive can only ever date the change, never confirm it. `generateNotice()` makes a
 * new one; that is a real write (it archives the patient's previous notice) and is the same one
 * `admin_vorabinfo_one_page.spec.ts` and `admin_letter_country_marker.spec.ts` already make, for
 * the same reason.
 *
 * Deployment is decided the same way. These are Twig templates on the API side, and `GET /status`
 * reports the RELEASE rather than the commit (#3704), so it cannot answer for a template change —
 * the rendered text is the only surface that can.
 *
 * ## Traps, and the first one silently deletes the sentence under test
 *
 *  - **`pdfText()` drops the AC1 line.** On this letter it renders the callout as "…die Rechnung
 *    erhalten Sie erst nach Sie haben eine Zuzahlungsbefreiung?" — the phrase AC1 is about is gone,
 *    and an assertion on it fails while the letter is correct. `pdfDocText()` (positioned runs, from
 *    `pdf-layout.ts`) recovers it. Same defect the #3559 reminder letter hit. **Use `docText()`.**
 *  - **AC1's separator is an EN DASH, not the comma the AC quotes.** The ticket writes "Bitte
 *    überweisen Sie noch kein Geld**,** die Rechnung…"; the template has always used `&ndash;`, and
 *    this ticket changed only the ending phrase. Asserting the AC's literal sentence therefore fails
 *    on a correct implementation — the same shape as #3666's `÷`-vs-`/`. Every sentence here is
 *    matched on its **parts**, with the separator normalised.
 *  - **The email is entity-driven.** `brand_email` renders `info@curano.de` for a Curano entity and
 *    `info@therapios.de` for a Therapios one — both appear across the fixtures. The ACs quote the
 *    Therapios address literally, so the address is matched as a pattern, never as a constant.
 *  - Generating is **per discipline**: the endpoint is
 *    `POST /patients/{id}/generate-pre-treatment-notice/{discipline}` with `{variant}` in the body,
 *    and the response does not carry a usable signed URL — re-read the archive for the newest row.
 */

export const NOTICE_API = API_BASE;

/**
 * The wording this ticket installs, in parts.
 *
 * Parts rather than whole sentences on purpose: the separators in the shipped text do not match the
 * AC's prose (see the class docblock), and an exact-sentence assertion would fail on a correct
 * letter. Each entry is everything that must be present, in order.
 */
export const WORDING = {
  /** AC1 — standard letter, the callout headline. */
  ac1: ['Bitte überweisen Sie noch kein Geld', 'die Rechnung erhalten Sie erst nach Ende Ihrer Behandlung.'],
  /** AC2 — standard letter, the instruction under the question. */
  ac2: ['Sie haben eine Zuzahlungsbefreiung?', 'Bitte senden Sie uns eine Kopie Ihrer Befreiungskarte an'],
  /** AC3 / AC6 — the new sentence, identical in both letters. */
  alwaysNeeded: 'Diese benötigen wir in jedem Fall, selbst wenn die Befreiung Ihrer Wohneinrichtung bereits vorliegt.',
  /** AC4 — Blanko letter, the final-invoice sentence. */
  ac4: 'Sie erhalten die finale Rechnung nach Ende Ihrer Behandlung; berechnet werden dabei nur tatsächlich durchgeführte Behandlungen.',
  /** AC5 — Blanko letter, the instruction, with its unchanged neighbours. */
  ac5Before: 'Dann zahlen Sie nichts.',
  ac5: 'Bitte senden Sie uns eine Kopie Ihrer Befreiungskarte an',
  ac5After: 'Eine Zuzahlungsbefreiung können Sie bei Ihrer Krankenkasse beantragen.',
} as const;

/** The wording this ticket replaces. A fresh render must contain none of it in the exemption block. */
export const SUPERSEDED = {
  /** AC1's old ending, and AC4's. */
  behandlungsende: 'nach Behandlungsende',
  /** AC2's old instruction. */
  ac2: 'Senden Sie uns bitte eine Kopie an',
  /** AC5's old instruction, and the word the two templates disagreed on. */
  befreiungsausweis: 'Befreiungsausweis',
} as const;

/**
 * Fixtures, shared with `admin_vorabinfo_one_page.spec.ts` (#3522) on purpose: each has exactly
 * three prescribed treatments on one PT VO, so the generated letter fits one page and the
 * page-count regression this ticket risks is observable on the same rows #3522 pinned.
 */
export const FIXTURES = {
  regular: { patientId: 8474, discipline: 'physiotherapy', variant: 'regular' },
  blankoPhysio: { patientId: 8472, discipline: 'physiotherapy', variant: 'blanko' },
  blankoErgo: { patientId: 8468, discipline: 'ergotherapy', variant: 'blanko' },
} as const;

export type NoticeRow = { id: number; createdAt: string; url: string | null; patient: string | null };

export type LetterRead = {
  label: string;
  noticeId: number | null;
  createdAt: string | null;
  pages: number;
  /** The complete text, from positioned runs. */
  text: string;
  /** What `pdfText()` sees — kept only so the extractor gap can be demonstrated, never asserted on. */
  naiveText: string;
};

export class NoticeWordingPage {
  private bearerCache = new Map<string, string>();

  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async tokenFor(creds: Credentials): Promise<string> {
    const hit = this.bearerCache.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()}`);
    const token = (await res.json()).token as string;
    this.bearerCache.set(creds.email, token);
    return token;
  }

  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);

  /** For the one test that drives a screen; harmless elsewhere. */
  async uiSession(): Promise<string> {
    if (!this.page) throw new Error('NoticeWordingPage was constructed without a Page');
    return mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
  }

  private headers(token: string) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' };
  }

  /**
   * Retry a request that staging drops.
   *
   * These letters are ~260 KB each and the S3 signed-URL fetches are the largest reads in this
   * file; `socket hang up` and `ECONNRESET` turn up on a busy staging and have nothing to do with
   * the ticket. In a `serial` describe one such blip cascades every remaining test to "did not
   * run", which reads far worse than the blip it is.
   */
  private static async retry<T>(label: string, attempts: number, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        console.log(`  retry ${i}/${attempts} — ${label}: ${String(e).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 3_000 * i));
      }
    }
    throw last;
  }

  // ──────────────────────────── the notice archive ────────────────────────────

  /** One patient's notices, newest first. */
  async notices(patientId: number, token: string, limit = 30): Promise<NoticeRow[]> {
    const body = await NoticeWordingPage.retry(`notices(${patientId})`, 3, async () => {
      const res = await this.request.get(
        `${API_BASE}/pre_treatment_notices?page=1&itemsPerPage=${limit}` +
          `&order%5BcreatedAt%5D=desc&patient=%2Fpatients%2F${patientId}`,
        { headers: this.headers(token), timeout: 120_000 },
      );
      if (!res.ok()) throw new Error(`GET /pre_treatment_notices -> ${res.status()}`);
      return res.json();
    });
    const rows = body.member ?? body['hydra:member'] ?? [];
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      createdAt: r.createdAt as string,
      url: (r.signedFileUrl as string) ?? null,
      patient: (r.patient as string) ?? null,
    }));
  }

  /** The whole archive, newest first, across all patients — for dating the change. */
  async recentNotices(token: string, limit = 60): Promise<NoticeRow[]> {
    const body = await NoticeWordingPage.retry('recentNotices', 3, async () => {
      const res = await this.request.get(
        `${API_BASE}/pre_treatment_notices?page=1&itemsPerPage=${limit}&order%5BcreatedAt%5D=desc`,
        { headers: this.headers(token), timeout: 120_000 },
      );
      if (!res.ok()) throw new Error(`GET /pre_treatment_notices -> ${res.status()}`);
      return res.json();
    });
    const rows = body.member ?? body['hydra:member'] ?? [];
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      createdAt: r.createdAt as string,
      url: (r.signedFileUrl as string) ?? null,
      patient: (r.patient as string) ?? null,
    }));
  }

  /**
   * The OLDEST notices in the archive.
   *
   * Deliberately the oldest rather than "recent but not mine": a run that generates three letters
   * pushes its own renders to the top, and re-running fills the recent window entirely with
   * post-fix ones — which is exactly how the archive check failed the first time. The far end of a
   * 3,700-row archive predates every template change by years and needs no date arithmetic.
   */
  async oldestNotices(token: string, limit = 12): Promise<NoticeRow[]> {
    const body = await NoticeWordingPage.retry('oldestNotices', 3, async () => {
      const res = await this.request.get(
        `${API_BASE}/pre_treatment_notices?page=1&itemsPerPage=${limit}&order%5BcreatedAt%5D=asc`,
        { headers: this.headers(token), timeout: 120_000 },
      );
      if (!res.ok()) throw new Error(`GET /pre_treatment_notices -> ${res.status()}`);
      return res.json();
    });
    const rows = body.member ?? body['hydra:member'] ?? [];
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      createdAt: r.createdAt as string,
      url: (r.signedFileUrl as string) ?? null,
      patient: (r.patient as string) ?? null,
    }));
  }

  /** Read one archived notice's PDF. */
  async readNotice(row: NoticeRow, token: string, label = `notice ${row.id}`): Promise<LetterRead> {
    if (!row.url) return { label, noticeId: row.id, createdAt: row.createdAt, pages: 0, text: '', naiveText: '' };
    const buf = await NoticeWordingPage.retry(`fetch ${label}`, 4, async () => {
      const res = await this.request.get(row.url as string, { timeout: 240_000 });
      if (!res.ok()) throw new Error(`PDF fetch -> ${res.status()}`);
      return Buffer.from(await res.body());
    }).catch(() => null);
    if (!buf) return { label, noticeId: row.id, createdAt: row.createdAt, pages: 0, text: '', naiveText: '' };
    return {
      label: `${label} (${row.createdAt})`,
      noticeId: row.id,
      createdAt: row.createdAt,
      pages: pdfPageCount(buf),
      text: NoticeWordingPage.flatten(pdfDocText(buf)),
      naiveText: NoticeWordingPage.flatten(pdfText(buf)),
    };
  }

  /**
   * Generate a FRESH notice and read it back.
   *
   * **Mutating by necessity** — only a new render shows the current template, and this archives the
   * patient's previous notice. The POST's own body does not carry a usable signed URL, so the
   * newest archive row is re-read.
   */
  async generateAndRead(
    fixture: { patientId: number; discipline: string; variant: string },
    token: string,
  ): Promise<LetterRead> {
    const label = `${fixture.variant}/${fixture.discipline} (patient ${fixture.patientId})`;
    await NoticeWordingPage.retry(`generate ${label}`, 3, async () => {
      const res = await this.request.post(
        `${API_BASE}/patients/${fixture.patientId}/generate-pre-treatment-notice/${fixture.discipline}`,
        {
          headers: { ...this.headers(token), 'Content-Type': 'application/json' },
          data: { variant: fixture.variant },
          timeout: 240_000,
        },
      );
      if (!res.ok()) throw new Error(`generate ${label} -> ${res.status()} ${(await res.text()).slice(0, 200)}`);
      return true;
    });
    const [newest] = await this.notices(fixture.patientId, token, 1);
    if (!newest) throw new Error(`generate ${label}: nothing in the archive afterwards`);
    return this.readNotice(newest, token, label);
  }

  // ──────────────────────────────── helpers ────────────────────────────────

  /** One line, single-spaced — PDF text arrives broken across positioned runs. */
  static flatten(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Whether every part appears, in order.
   *
   * Parts rather than a whole sentence because the shipped separators differ from the AC's prose
   * (an en dash where the AC writes a comma), so an exact match fails on a correct letter.
   */
  static containsInOrder(text: string, parts: readonly string[]): boolean {
    let at = 0;
    for (const part of parts) {
      const i = text.indexOf(part, at);
      if (i < 0) return false;
      at = i + part.length;
    }
    return true;
  }

  /** A window around a marker, for logging what a run actually saw. */
  static around(text: string, marker: string, before = 200, after = 320): string {
    const i = text.indexOf(marker);
    if (i < 0) return `«${marker}» not found`;
    return text.slice(Math.max(0, i - before), i + after);
  }
}
