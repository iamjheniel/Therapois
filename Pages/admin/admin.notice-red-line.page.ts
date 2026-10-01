import { APIRequestContext } from '@playwright/test';
import { NoticeWordingPage, FIXTURES, type NoticeRow } from './admin.notice-wording.page';
import { pdfPages, pdfPageCount, pdfDocText, type TextRun } from '../util/pdf-layout';

const API = 'https://api.staging.therapios.de';

export type HeaderRead = {
  pages: number;
  title: TextRun | null;
  line: TextRun | null;
  text: string;
  runs: TextRun[];
};

/**
 * RC 3.15 #3886 — the Vorabinformation's "- Keine Rechnung -" line becomes a RED
 * "Dies ist keine Rechnung - bitte noch kein Geld überweisen", in both variants, with the
 * Honorarvereinbarung deliberately keeping the old line.
 *
 * **The ticket is about a COLOUR**, which no text extractor can see — so `pdf-layout.ts` was
 * extended to track the non-stroking fill colour per run (`rg`/`g`/`k`, saved and restored with
 * `q`/`Q`). That is what makes AC1 checkable at all; without it a red line and a black one read
 * identically.
 *
 * Composes `NoticeWordingPage` (#3668) for generation and the archive, because a rendering ticket
 * is only ever decided by a FRESH render.
 */
export class NoticeRedLinePage {
  readonly notices: NoticeWordingPage;

  static readonly FIXTURES = FIXTURES;

  /** The shipped line, verbatim from the Localization Reference (a plain ASCII hyphen). */
  static readonly NEW_LINE = 'Dies ist keine Rechnung - bitte noch kein Geld überweisen';
  /** What it replaces, and what the Honorarvereinbarung keeps. */
  static readonly OLD_LINE = '- Keine Rechnung -';
  /** AC3's grey-box sentence, which must survive untouched. */
  static readonly GREY_BOX = 'Bitte überweisen Sie noch kein Geld';
  static readonly TITLE_PREFIX = 'Vorabinformation über beginnende Heilmittelbehandlung';

  constructor(private request: APIRequestContext) {
    this.notices = new NoticeWordingPage(request);
  }

  adminToken = () => this.notices.adminToken();

  /**
   * Red, as a PREDICATE rather than an exact value.
   *
   * The template says `#c00000`; the renderer emits **`#c50000`**, so an equality check on the
   * template's hex fails on a correct letter. The page's other colours are nowhere near — the body
   * is `#080a0a` and the rebrand banner `#061a43`/`#1b2c52` — so a predicate separates them
   * cleanly while surviving a renderer that rounds differently.
   */
  static isRed([r, g, b]: [number, number, number]): boolean {
    return r > 0.5 && g < 0.2 && b < 0.2;
  }

  static hex(c: [number, number, number]): string {
    return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }

  /** The PDF of the newest notice a fixture has, after generating a fresh one. */
  async generateAndReadHeader(
    fixture: typeof FIXTURES[keyof typeof FIXTURES],
    token: string,
  ): Promise<HeaderRead> {
    await this.notices.generateAndRead(fixture, token);
    const [newest] = await this.notices.notices(fixture.patientId, token, 1);
    if (!newest?.url) throw new Error('no stored notice after generating');
    return this.readHeader(newest, token);
  }

  /** Title + the line under it, with their colour, size and font. */
  async readHeader(row: NoticeRow, token: string): Promise<HeaderRead> {
    const res = await this.request.get(row.url as string, { timeout: 300_000 });
    if (!res.ok()) throw new Error(`PDF fetch -> ${res.status()}`);
    const buf = Buffer.from(await res.body());
    const pages = pdfPages(buf);
    const runs = pages[0]?.runs ?? [];
    const title = runs.find((r) => r.text.includes(NoticeRedLinePage.TITLE_PREFIX)) ?? null;
    // The line directly under the title: the nearest run BELOW it, which is how the AC words its
    // position — never "the run containing the expected text", which would assume the answer.
    const below = runs
      .filter((r) => title && r.y < title.y && r.text.trim())
      .sort((a, b) => b.y - a.y);
    return {
      pages: pdfPageCount(buf),
      title,
      line: below[0] ?? null,
      text: pdfDocText(buf).replace(/\s+/g, ' ').trim(),
      runs,
    };
  }

  /** The archive, newest first. */
  recentNotices(token: string, limit = 60) { return this.notices.recentNotices(token, limit); }

  /** Whether an archived letter carries the new line, the old one, or neither. */
  async classify(row: NoticeRow, token: string): Promise<{ id: number | null; createdAt: string | null; isNew: boolean; isOld: boolean }> {
    const read = await this.notices.readNotice(row, token);
    return {
      id: read.noticeId,
      createdAt: read.createdAt,
      isNew: read.text.includes(NoticeRedLinePage.NEW_LINE),
      isOld: read.text.includes(NoticeRedLinePage.OLD_LINE),
    };
  }

  /** Fee agreements with a downloadable PDF — AC2's "No, it keeps its line". */
  async honoDocuments(token: string, limit = 8): Promise<{ id: string; createdAt: string; url: string }[]> {
    const res = await this.request.get(
      `${API}/document_center/documents?type=hv&itemsPerPage=${limit}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' }, timeout: 300_000 },
    );
    if (!res.ok()) throw new Error(`GET /document_center/documents -> ${res.status()}`);
    const body = await res.json();
    return (body.member ?? [])
      .filter((d: any) => d.contentUrl)
      .map((d: any) => ({ id: String(d.documentId ?? d.id), createdAt: String(d.createdAt ?? ''), url: d.contentUrl }));
  }

  async readPdfText(url: string): Promise<string> {
    const res = await this.request.get(url, { timeout: 300_000 });
    if (!res.ok()) throw new Error(`PDF fetch -> ${res.status()}`);
    return pdfDocText(Buffer.from(await res.body())).replace(/\s+/g, ' ').trim();
  }
}
