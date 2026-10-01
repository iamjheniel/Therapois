import { Page, APIRequestContext, request as pwRequest } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3872 — the Admin Board sorts search results by VO NUMBER (highest first) instead of by
 * issue date, while a search is active and the admin has not picked a column.
 *
 * Two surfaces, because the ticket has two halves:
 *
 *  - **the API**, where `order[voNumber]` is a brand-new filter on `/v2/prescriptions` (and on
 *    nothing else — the v1 `/prescriptions` path is deliberately untouched, which is what keeps
 *    the Billing Validation Queue on its issue-date sort);
 *  - **the board**, where `resolveSort()` decides which `order[...]` key the request carries. That
 *    key IS the feature, so the file reads the board's OWN request rather than inferring the sort
 *    from the painted rows (#3471's technique) — and reads the painted rows beside it.
 */
export class SearchVoSortPage {
  private api!: APIRequestContext;
  private token = '';
  /** Every `/v2/prescriptions` query string the board has issued, oldest first. */
  readonly requests: string[] = [];

  static readonly API = 'https://api.staging.therapios.de';
  static readonly WEB = 'https://staging.therapios.de';
  /** The ticket's own placeholder, verbatim from its Localization Reference. */
  static readonly SEARCH_PLACEHOLDER = 'Patient, VO-Nr. suchen …';
  /** AC6's seven tabs, left→right. "Gelöscht" (#3671) is Admin + Super Admin only. */
  static readonly TABS = [
    'Folge-VO erhalten', 'Keine Folge-VO', 'Fertig behandelt', 'Zur Prüfung',
    'Alle VOs', 'Alle inkl. Archivierte', 'Gelöscht',
  ] as const;
  /** What the board itself appends on the default "Alle VOs" tab. */
  static readonly BOARD_SUFFIX =
    '&exclude%5BtreatmentStatus%5D%5B%5D=Archiviert&groups%5B%5D=prescription-list%3Aread';

  constructor(private page: Page) {}

  /** The driven page, for the few viewport/text reads a spec does directly. */
  get ui(): Page { return this.page; }

  // ---------------------------------------------------------------- API

  async initApi(): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: SearchVoSortPage.API });
    const res = await this.api.post('/auth', {
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async disposeApi(): Promise<void> { await this.api?.dispose(); }

  /**
   * A GET that retries a 5xx AND a thrown transport error.
   *
   * Retrying only on a status is not enough: staging drops connections under load, and a
   * `socket hang up` throws before there is any status to inspect — which fails the test for a
   * reason that has nothing to do with the ticket (it did here, once).
   */
  async get<T>(path: string, timeout = 400_000): Promise<T> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.api.get(path, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
          timeout,
        });
        if (res.ok()) return (await res.json()) as T;
        if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
        last = `${res.status()}`;
      } catch (e: any) {
        if (/-> \d{3}$/.test(e?.message ?? '')) throw e;   // a real 4xx, not a transport blip
        last = e?.message ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed after retries: ${last}`);
  }

  /** The status code alone, retried on a transport error for the same reason as `get`. */
  async status(path: string): Promise<number> {
    let last = 0;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.api.get(path, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
          timeout: 400_000,
        });
        // A 5xx is the server being unhealthy, which must never be scored as a verdict here —
        // this test's whole point is that one particular combination used to answer 500.
        if (res.status() < 500) return res.status();
        last = res.status();
      } catch { last = 0; }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    return last;
  }

  /** `/v2/prescriptions` returns a Hydra collection; the VO numbers in served order. */
  async voNumbers(query: string): Promise<string[]> {
    const b = await this.get<any>(`/v2/prescriptions?${query}`);
    const m = Array.isArray(b) ? b : (b.member ?? b['hydra:member'] ?? []);
    return m.map((x: any) => x.prescriptionId ?? null);
  }

  async totalItems(query: string): Promise<number> {
    const b = await this.get<any>(`/v2/prescriptions?${query}`);
    return b.totalItems ?? b['hydra:totalItems'] ?? 0;
  }

  /** Exactly the query the board builds, so an API assertion speaks about what the admin sees. */
  static boardQuery(opts: { search?: string; order?: string; page?: number; perPage?: number }): string {
    const { search, order = 'order%5BvoNumber%5D=desc', page = 1, perPage = 30 } = opts;
    const s = search === undefined ? ''
      : `&search%5BprescriptionId%5D=${encodeURIComponent(search)}` +
        `&search%5Bpatient.fullName%5D=${encodeURIComponent(search)}`;
    return `page=${page}&itemsPerPage=${perPage}&${order}${s}${SearchVoSortPage.BOARD_SUFFIX}`;
  }

  // ---------------------------------------------------------------- the two sort oracles

  /**
   * AC1's rule: patient number, then sequence, BOTH as integers. A VO number that is not
   * `<digits>-<digits>` sorts last in either direction (the PR's documented decision — the
   * `uniqid('VO-')` fallback, unmatched imports and #3675's nulled numbers).
   */
  static naturalKey(vo: string | null): [number, number, number] {
    const m = /^(\d+)-(\d+)$/.exec(vo ?? '');
    return m ? [0, Number(m[1]), Number(m[2])] : [1, 0, 0];
  }

  /** What the stock `OrderFilter` on a text column would have produced — the rejected ordering. */
  static lexicographic(vos: (string | null)[]): (string | null)[] {
    return [...vos].sort((a, b) => String(b ?? '').localeCompare(String(a ?? '')));
  }

  static natural(vos: (string | null)[]): (string | null)[] {
    return [...vos].sort((a, b) => {
      const ka = SearchVoSortPage.naturalKey(a), kb = SearchVoSortPage.naturalKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];           // malformed last
      return kb[1] - ka[1] || kb[2] - ka[2];               // then numerically, highest first
    });
  }

  static isDescending(vos: (string | null)[]): boolean {
    const k = vos.map(SearchVoSortPage.naturalKey);
    for (let i = 0; i + 1 < k.length; i++) {
      const a = k[i], b = k[i + 1];
      if (a[0] !== b[0]) { if (a[0] > b[0]) return false; continue; }
      if (a[1] !== b[1]) { if (a[1] < b[1]) return false; continue; }
      if (a[2] < b[2]) return false;
    }
    return true;
  }

  static isMalformed(vo: string | null): boolean { return !/^\d+-\d+$/.test(vo ?? ''); }

  // ---------------------------------------------------------------- the board

  /**
   * ONE navigation per spec file: `mintUiSession` spends a single-use refresh token (#3460), so a
   * reload lands on the login form. Request capture is installed before the first paint.
   */
  async open(): Promise<void> {
    this.page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/v2/prescriptions')) {
        this.requests.push(decodeURIComponent(u.split('/v2/prescriptions')[1] ?? ''));
      }
    });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto(`${SearchVoSortPage.WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    await this.page.getByText('VO #', { exact: true }).first().waitFor({ timeout: 240_000 });
    await this.page.waitForTimeout(12_000);
    this.requests.length = 0;
  }

  /** The `order[...]=...` key of the newest captured request, or null when none has fired. */
  lastOrder(): string | null {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const m = /order\[([^\]]+)\]=(\w+)/.exec(this.requests[i]);
      if (m) return `${m[1]}:${m[2]}`;
    }
    return null;
  }

  /** Newest request, whatever it carried. */
  lastRequest(): string | null {
    return this.requests.length ? this.requests[this.requests.length - 1] : null;
  }

  forget(): void { this.requests.length = 0; }

  /**
   * Waits for the board to answer an interaction.
   *
   * A repeat of a query the client already holds fires NO request at all (React Query serves it
   * from cache) — three header clicks in a row and a click on the already-active tab both do this.
   * So this returns on a new request OR on the painted rows settling, and the caller asserts on
   * whichever signal its AC is actually about.
   */
  async settle(ms = 30_000): Promise<void> {
    const before = this.requests.length;
    const deadline = Date.now() + ms;
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1_200);
      const now = JSON.stringify(await this.paintedVos());
      if (now === last) { stable++; if (stable >= 2 && this.requests.length > before) return; }
      else { stable = 0; last = now; }
      if (stable >= 4) return;
    }
  }

  searchBox() { return this.page.getByPlaceholder(/suchen/i).first(); }

  async search(query: string): Promise<void> {
    const box = this.searchBox();
    await box.click();
    await box.fill(query);
    await this.page.keyboard.press('Enter');
    await this.settle(60_000);
  }

  /** AC3's first route out: the "✕" the search box grows once it has text. */
  async clearSearchWithX(): Promise<void> {
    await this.page.getByText('✕', { exact: true }).first().click({ force: true, timeout: 30_000 });
    await this.settle(60_000);
  }

  async selectTab(label: string): Promise<void> {
    await this.page.getByText(label, { exact: true }).first().click({ force: true, timeout: 30_000 });
    await this.settle(60_000);
  }

  async clickHeader(label: string): Promise<void> {
    await this.page.getByText(label, { exact: true }).first().click({ force: true, timeout: 30_000 });
    await this.settle(45_000);
  }

  /**
   * The header row, left→right, as `{text, x}` leaves — including the sort glyphs, which are their
   * own leaves sitting just right of the label they belong to.
   *
   * Identified by the "VO #" leaf's own y-band: the headers are one visual row but are NOT one DOM
   * subtree, and `innerText` returns the scrollable headers after the whole table body.
   */
  async headerBand(): Promise<{ t: string; x: number }[]> {
    return this.page.evaluate(() => {
      const anchor = [...document.querySelectorAll('*')]
        .find((e) => e.children.length === 0 && e.textContent?.trim() === 'VO #');
      if (!anchor) return [];
      const ar = anchor.getBoundingClientRect();
      return [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          const t = (e.textContent || '').trim();
          return t && Math.abs(r.top - ar.top) < 14 && r.width > 0
            ? { t, x: Math.round(r.left) } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.x - b.x) as { t: string; x: number }[];
    });
  }

  /**
   * AC7's surface: each header's sort glyph. `↓`/`↑` mark the ACTIVE sort, `↕` means
   * "sortable, not active" and an absent entry means the column offers no sort at all.
   */
  async arrows(): Promise<Record<string, string | null>> {
    const band = await this.headerBand();
    const isGlyph = (t: string) => ['↓', '↑', '↕'].includes(t);
    const out: Record<string, string | null> = {};
    for (let i = 0; i < band.length; i++) {
      if (isGlyph(band[i].t)) continue;
      const next = band[i + 1];
      out[band[i].t] = next && isGlyph(next.t) ? next.t : null;
    }
    return out;
  }

  /**
   * The painted VO column, top→bottom.
   *
   * Taken from the leaves sitting under the "VO #" header and within its left region, because the
   * table has no per-cell testid; a VO number is the only thing in that band shaped `<x>-<n>`.
   */
  async paintedVos(): Promise<string[]> {
    return this.page.evaluate(() => {
      const anchor = [...document.querySelectorAll('*')]
        .find((e) => e.children.length === 0 && e.textContent?.trim() === 'VO #');
      if (!anchor) return [];
      const ar = anchor.getBoundingClientRect();
      return [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          const t = (e.textContent || '').trim();
          return /^[A-Za-z0-9]+-[0-9]+$/.test(t) && r.top > ar.bottom - 2
            && r.left < ar.left + 200 && r.width > 0
            ? { t, y: Math.round(r.top) } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.y - b.y)
        .map((o: any) => o.t) as string[];
    });
  }

  /** The heading's own total ("Verordnungen (VO) · N gesamt"). */
  async headerTotal(): Promise<number | null> {
    const txt = await this.page.locator('#root').innerText().catch(() => '');
    const m = /Verordnungen \(VO\) · ([\d.]+) gesamt/.exec(txt.replace(/ /g, ' '));
    return m ? Number(m[1].replace(/\./g, '')) : null;
  }
}
