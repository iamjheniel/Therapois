import { APIRequestContext, Page } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

export type Vo = Record<string, any>;

/**
 * RC 3.15 #3884 + #3885, which ship together in PR #3893 by necessity: #3885 takes discharge VOs
 * out of "Heute bestellen" and #3884 gives them the tab they move to.
 *
 * Both halves are reachable from the API, and the CRM's OWN requests name every parameter — the
 * start page is loaded once and its requests captured (#3471), so what is asserted is the query the
 * screen actually issued rather than one rebuilt from the ticket's prose.
 */
export class CrmEntlassmanagementPage {
  private token = '';
  /** Every CRM request the page issued, path + query, oldest first. */
  readonly requests: string[] = [];

  /** #3884 AC1's tab row, in order. */
  static readonly TABS = [
    'Heute bestellen', 'Entlassmanagement', 'Heute nachverfolgen',
    'Geplant', 'Mit Problemen', 'Alle',
  ] as const;

  /**
   * #3884 AC6's columns **as the tab actually paints them**.
   *
   * Three differ from the ticket's Localization Reference, which writes `VO number` / `Patient` /
   * `Ausstellungsdatum`: the tab reuses Flow's existing column vocabulary (`VO Nr.`, `Name`,
   * `Ausst. Datum` — the Admin Board's and the practice Ordering tab's own labels). Asserting the
   * Reference's wording fails on a correct build, the #3666/#3668 pattern.
   */
  static readonly COLUMNS = [
    'VO Nr.', 'Name', 'Einrichtung', 'Ausst. Datum', 'Startfrist', 'Gültig bis', 'Folge-VO Status',
  ] as const;

  /** What the ticket's Localization Reference calls the same three, for the divergence report. */
  static readonly COLUMNS_PER_TICKET: Record<string, string> = {
    'VO Nr.': 'VO number', Name: 'Patient', 'Ausst. Datum': 'Ausstellungsdatum',
  };

  /** The one parameter #3884 AC3's six conditions ship as. */
  static readonly TAB_FILTER = 'dischargeOrdering=true';
  /** #3885's opt-in exclusion. */
  static readonly EXCLUDE = 'excludeDischargeVos=true';

  constructor(private request: APIRequestContext, private page?: Page) {}

  async init(): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  /** A GET that retries a 5xx and a thrown transport error. */
  async get<T>(path: string, timeout = 500_000): Promise<T> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
        if (res.ok()) return (await res.json()) as T;
        if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
        last = String(res.status());
      } catch (e: any) {
        if (/-> \d{3}$/.test(e?.message ?? '')) throw e;
        last = e?.message ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  /** `totalItems` for a collection query — the cheap way to compose filters. */
  async total(path: string): Promise<number> {
    const b = await this.get<any>(path);
    if (Array.isArray(b)) return b.length;
    return b.totalItems ?? b['hydra:totalItems'] ?? 0;
  }

  /** The VOs the Entlassmanagement tab lists. */
  async tabVos(limit = 50): Promise<Vo[]> {
    const b = await this.get<any>(`/prescriptions?itemsPerPage=${limit}&${CrmEntlassmanagementPage.TAB_FILTER}`);
    return b.member ?? b['hydra:member'] ?? [];
  }

  async practice(id: number): Promise<any> { return this.get<any>(`/practices/${id}`); }

  /** The CRM practice list, as the start page requests it. */
  async crmPractices(tabParam: string): Promise<any[]> {
    const b = await this.get<any>(`/v2/practices?page=1&itemsPerPage=1500&${tabParam}`);
    return (b.member ?? b['hydra:member'] ?? b) as any[];
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /**
   * Opens the CRM start page ONCE and captures its requests.
   *
   * `mintUiSession` spends a single-use refresh token (#3460), so there is no reload — which is
   * also why the captured requests are the first load's.
   */
  async open(): Promise<void> {
    if (!this.page) throw new Error('constructed without a Page');
    this.page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith(API) && /\/(v2\/)?(practices|prescriptions)/.test(u)) {
        // `decodeURIComponent` does NOT turn `+` back into a space, so a captured
        // `orderingStatus=By+Admin` never matches a probe written `By Admin` — which reads as the
        // request never having been made (it did here). A real plus in a value arrives as `%2B`,
        // so this substitution is safe.
        this.requests.push(decodeURIComponent(u.slice(API.length)).replace(/\+/g, ' '));
      }
    });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto(`${WEB}/crm`, { waitUntil: 'domcontentloaded' });
    await this.page.getByText(/Heute bestellen/).first().waitFor({ timeout: 240_000 });
    // The tab labels paint before their counts land; wait for a count on the first tab.
    for (let i = 0; i < 60; i++) {
      if (/Heute bestellen \(\d+\)/.test(await this.page.locator('#root').innerText())) break;
      await this.page.waitForTimeout(2_000);
    }
    await this.page.waitForTimeout(6_000);
  }

  /** The tab row as painted, e.g. `["Heute bestellen (228)", "Entlassmanagement (4)", …]`. */
  async tabRow(): Promise<string[]> {
    const lines = (await this.page!.locator('#root').innerText()).split('\n').map((s) => s.trim());
    const out: string[] = [];
    for (const l of lines) {
      const m = /^([A-Za-zÄÖÜäöüß .-]+?)(?: \((\d+)\))?$/.exec(l);
      if (m && (CrmEntlassmanagementPage.TABS as readonly string[]).includes(m[1])) out.push(l);
    }
    // Keep the first occurrence of each label, in painted order.
    const seen = new Set<string>();
    return out.filter((l) => {
      const label = l.replace(/ \(\d+\)$/, '');
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
  }

  /** The count a tab's label carries, or null when it carries none. */
  static countOf(tabLabel: string): number | null {
    const m = / \((\d+)\)$/.exec(tabLabel);
    return m ? Number(m[1]) : null;
  }

  async openTab(label: string): Promise<void> {
    await this.page!.getByText(new RegExp(`^${label}( \\(\\d+\\))?$`)).first()
      .click({ force: true, timeout: 60_000 });
    await this.page!.waitForTimeout(8_000);
  }

  /** Every captured request whose path+query contains each of `parts`. */
  matching(...parts: string[]): string[] {
    return this.requests.filter((r) => parts.every((p) => r.includes(p)));
  }

  // ───────────────────────────── #3884 AC3, as an oracle ─────────────────────────────

  /**
   * The six conditions, re-derived from a VO's own payload.
   *
   * The ordering-mode condition ("the VO's ER has no Bestellmodus") is NOT on the VO, so it is
   * resolved from the facility and reported separately rather than folded in silently.
   */
  static satisfiesListingRule(vo: Vo): { ok: boolean; why: string[] } {
    const why: string[] = [];
    if (vo.isDischargeManagement !== true) why.push('not a discharge VO');
    const fs = vo.followupStatus ?? null;
    if (fs !== null && fs !== 'order') why.push(`followupStatus ${JSON.stringify(fs)}`);
    if (vo.treatmentStatus === 'Archiviert') why.push('archived');
    if (vo.deletedAt) why.push('deleted');
    if (vo.patient?.isDeceased === true) why.push('patient deceased');
    if (vo.orderingStatus !== 'By Admin') why.push(`orderingStatus ${JSON.stringify(vo.orderingStatus)}`);
    return { ok: why.length === 0, why };
  }
}
