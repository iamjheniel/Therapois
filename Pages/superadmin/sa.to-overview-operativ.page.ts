import { expect, Page } from '@playwright/test';
import { FlowBoardsPage } from './sa.flow-boards.page';
import { API_BASE, Credentials, mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The Therapeuten-Orga board's **Übersicht** table — RC 3.14 #3770 (commit `73d5801cc`, PR #3781).
 *
 * The table opened on the 15-column "Standard" view; management switched away from it every time,
 * so it now opens on "Operativ"'s five columns, the wide view is relabelled **"Details"**, and the
 * section heading is renamed **"Arbeitszeiten" → "Übersicht"**. Nothing else moves: the same
 * columns live in each view, and the Gruppen / Therapeut:innen toggle is untouched.
 *
 * **Frontend-only, so `GET /status` cannot answer for it** — it reports the API release (#3704) and
 * says nothing about the bundle (#3705). Deployment is decided from the two surfaces that can: the
 * served dictionary's values, and the columns the table actually paints.
 *
 * ## Traps
 *
 *  - **The headers are CSS-uppercased, and German ß uppercases to SS.** `innerText` yields
 *    `MASSNAHME`, which matches neither `/Maßnahme/` nor `/Maßnahme/i` (simple case folding does
 *    not equate ß with SS), while `textContent` keeps the real `Maßnahme`. Both readings are
 *    returned by {@link columnHeaders} — and note the ticket's own Localization Reference writes
 *    "Massnahme" with ss, which is the PAINTED form, not the shipped string.
 *  - **The i18n KEY did not change, only its value.** `flowBoards.standard` now reads "Details" and
 *    `flowBoards.arbeitszeiten` reads "Übersicht". A probe looking for a `flowBoards.details` key
 *    finds nothing and concludes the rename never shipped.
 *  - **Two other keys still hold the old words and must not be touched**:
 *    `performanceDashboard.subTabs.workingHours` = "Arbeitszeiten" (the TO Verwaltung sub-tab) and
 *    `crm.lead_time.source_standard` = "Standard". They are the control that the rename was scoped
 *    rather than a blanket find-and-replace.
 *  - **The English half reads "Operativ", not "Operational".** The commit resolved that against
 *    AC2 and the Localization Reference, which give the German word for both interfaces.
 *  - **This ticket removed the table's horizontal overflow.** Operativ's five columns fit, so there
 *    is no scroller in the default view — which is what broke #3718's geometry spec (see
 *    `sa.working-hours-frozen-column.page.ts`, whose `open()` now selects Details).
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** AC5 — accepted in both spellings: Production is still on the pre-3.14 build. */
export const OVERVIEW_HEADING = /^(Übersicht|Arbeitszeiten)$/;

/**
 * AC1's five Operativ columns, as `textContent` serves them — so `Maßnahme` with the eszett, not
 * the AC's "Massnahme". The therapist/group name column is not one of them; it is always present.
 */
export const OPERATIV_COLUMNS = ['Effizienz', 'Krank %', 'Fertig n. abger.', 'Problem / Thema', 'Maßnahme'] as const;

/** AC3 — the 15 the "Details" view must still show, in painted order. */
export const DETAILS_COLUMNS = [
  'Effizienz',
  '€/Stunde',
  'Personio',
  'Vertraglich',
  'Soll (h)',
  'Behandlungszeit',
  'Sonstige',
  'Flow Gesamt',
  'Differenz',
  'Krank %',
  'Urlaub %',
  'Fehl %',
  'Fertig n. abger.',
  'Problem / Thema',
  'Maßnahme',
] as const;

/** The i18n keys the commit re-valued, and the two it deliberately left alone. */
export const I18N = {
  heading: 'flowBoards.arbeitszeiten',
  details: 'flowBoards.standard',
  operativ: 'flowBoards.operativ',
  untouchedHeading: 'performanceDashboard.subTabs.workingHours',
  untouchedStandard: 'crm.lead_time.source_standard',
} as const;

export type Dictionary = Record<string, string>;

export class ToOverviewOperativPage {
  private static dictCache: Promise<{ de: Dictionary; en: Dictionary; bundle: string; url: string }> | null = null;

  constructor(private page: Page) {}

  // ─────────────────────────── the deployed bundle ───────────────────────────

  /**
   * The served de/en dictionaries, evaluated out of the entry bundle (#3337's technique).
   *
   * Evaluating rather than grepping matters here: the bundle escapes non-ASCII, so `Übersicht` is
   * stored as `\xdcbersicht` and a raw search for the word finds nothing.
   */
  async dictionaries(): Promise<{ de: Dictionary; en: Dictionary; bundle: string; url: string }> {
    if (!ToOverviewOperativPage.dictCache) ToOverviewOperativPage.dictCache = this.fetchDictionaries();
    return await ToOverviewOperativPage.dictCache;
  }

  private async fetchDictionaries() {
    const shell = await this.page.request.get(`${STAGING_WEB}/`, { timeout: 60_000 });
    expect(shell.status(), 'GET / serves the app shell').toBe(200);
    const entry = (await shell.text()).match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    expect(entry, 'the shell references an entry bundle').toBeTruthy();
    const url = `${STAGING_WEB}${entry}`;
    const res = await this.page.request.get(url, { timeout: 180_000 });
    expect(res.status(), `GET ${entry}`).toBe(200);
    const bundle = await res.text();

    const dicts = ToOverviewOperativPage.extractDictionaries(bundle).filter(
      (d) => typeof d['controls.loading'] === 'string',
    );
    const de = dicts.find((d) => d['controls.loading'] !== 'Loading...');
    const en = dicts.find((d) => d['controls.loading'] === 'Loading...');
    expect(de, 'the bundle ships a German dictionary').toBeTruthy();
    expect(en, 'the bundle ships an English dictionary').toBeTruthy();
    return { de: de!, en: en!, bundle, url };
  }

  /** Every dependency-free `<v>.exports={…}` module big enough to be a locale file, flattened. */
  private static extractDictionaries(source: string): Dictionary[] {
    const out: Dictionary[] = [];
    const start = /__d\(function\([^)]*\)\{(\w+)\.exports=\{/g;
    let m: RegExpExecArray | null;
    while ((m = start.exec(source)) !== null) {
      const objectStart = m.index + m[0].length - 1;
      const tail = /\},(\d+),\[\]\);/g;
      tail.lastIndex = objectStart;
      const end = tail.exec(source);
      if (!end) continue;
      const literal = source.slice(objectStart, end.index);
      if (literal.length < 50_000) continue;
      try {
        out.push(ToOverviewOperativPage.flatten(new Function(`return ${literal};`)() as Record<string, unknown>));
      } catch {
        /* not a locale module */
      }
      start.lastIndex = end.index;
    }
    return out;
  }

  private static flatten(value: Record<string, unknown>, prefix = ''): Dictionary {
    const out: Dictionary = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object')
        Object.assign(out, ToOverviewOperativPage.flatten(entry as Record<string, unknown>, `${prefix}${key}.`));
      else out[`${prefix}${key}`] = String(entry);
    }
    return out;
  }

  /** Every key whose German value is exactly this string — used to prove the rename was scoped. */
  async keysHolding(value: string): Promise<string[]> {
    const { de } = await this.dictionaries();
    return Object.entries(de)
      .filter(([, v]) => v === value)
      .map(([k]) => k)
      .sort();
  }

  // ─────────────────────────────── the screen ────────────────────────────────

  /**
   * Open the Therapeuten-Orga board and wait for the Übersicht table to paint.
   *
   * Deliberately does NOT touch the column toggle — the default IS the subject of AC1, so anything
   * that selected a view first would destroy the measurement.
   *
   * `reloadSafe` swaps `mintUiSession` for #3761's seed. AC4 is a statement about a RELOAD, and
   * `mintUiSession` re-injects its refresh token on every navigation — the token is single-use
   * (#3460), so the second load replays a spent one and lands on the login form, which reads as the
   * table having lost its columns. {@link seedSession} installs the token once per token behind a
   * localStorage marker, so the app's own rotated replacement survives the reload untouched.
   */
  async open(opts: { reloadSafe?: boolean } = {}): Promise<FlowBoardsPage> {
    if (opts.reloadSafe) await this.seedSession();
    else await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(this.page);
    await boards.open();
    await boards.openTab('Therapeuten-Orga');
    await this.waitForTable();
    return boards;
  }

  /** #3761's reload-safe seed: writes the refresh token ONCE per token, keyed on a marker. */
  async seedSession(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.page.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    const refresh = (await res.json()).refresh_token as string;
    await this.page.addInitScript((token: string) => {
      try {
        if (localStorage.getItem('__qaSeededRefresh') !== token) {
          localStorage.setItem('auth-refresh-token', JSON.stringify(token));
          localStorage.setItem('__qaSeededRefresh', token);
        }
      } catch {
        /* a context that refuses storage cannot be signed in this way either */
      }
    }, refresh);
  }

  /**
   * Readiness is a PAINTED COLUMN, not the heading.
   *
   * The heading renders long before the working-hours read answers (it is the slowest pair on the
   * board together with the buckets — #3575), and reading columns early returns `[]`, which looks
   * exactly like the table having no columns at all.
   */
  async waitForTable(timeout = 300_000): Promise<void> {
    await expect(this.page.getByText(OVERVIEW_HEADING).first(), 'the Übersicht section').toBeVisible({ timeout });
    await expect
      .poll(async () => (await this.columnHeaders()).authored.length, { timeout, intervals: [2_000] })
      .toBeGreaterThan(2);
  }

  /**
   * The table's column headers, both ways round.
   *
   * `authored` is `textContent` (the shipped string, `Maßnahme`); `painted` is `innerText` (what the
   * CSS actually shows, `MASSNAHME`). Assertions use `authored`; `painted` is logged so a reader can
   * see why the AC's own spelling does not match.
   *
   * Located by the uppercase transform rather than a testid, because this table's header cells carry
   * none — and the transform is itself the reason the two readings differ.
   */
  async columnHeaders(): Promise<{ authored: string[]; painted: string[] }> {
    return await this.page.evaluate(() => {
      const authored: string[] = [];
      const painted: string[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!text) return;
        if (getComputedStyle(el).textTransform !== 'uppercase') return;
        authored.push(text);
        painted.push((el.innerText ?? '').trim());
      });
      return { authored, painted };
    });
  }

  /** The five column-mode / view labels as the toggle renders them, in painted order. */
  async toggleLabels(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const wanted = ['Details', 'Standard', 'Operativ', 'Gruppen', 'Therapeut:innen'];
      const seen: { text: string; x: number; y: number }[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!wanted.includes(text)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        seen.push({ text, x: r.x, y: r.y });
      });
      return seen.sort((a, b) => a.y - b.y || a.x - b.x).map((s) => s.text);
    });
  }

  /** Select a column mode. Accepts the pre-#3770 label so the Production mirror keeps working. */
  async setColumnMode(mode: 'Details' | 'Operativ'): Promise<void> {
    const label = mode === 'Details' ? /^(Details|Standard)$/ : /^Operativ$/;
    await this.page.getByText(label).first().click({ timeout: 30_000 });
    const expected = mode === 'Details' ? DETAILS_COLUMNS.length : OPERATIV_COLUMNS.length;
    await expect
      .poll(async () => (await this.columnHeaders()).authored.length, { timeout: 120_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(expected);
  }

  /**
   * Does the table overflow horizontally? `null` when it has no scroller at all.
   *
   * AC1's practical consequence, and the thing that broke #3718: Operativ fits, Details does not.
   */
  async maxScroll(): Promise<number | null> {
    return await this.page.evaluate(() => {
      let best: number | null = null;
      document.querySelectorAll('div').forEach((node) => {
        const el = node as HTMLElement;
        const over = getComputedStyle(el).overflowX;
        if (over !== 'auto' && over !== 'scroll') return;
        const max = el.scrollWidth - el.clientWidth;
        if (max > (best ?? 0)) best = max;
      });
      return best;
    });
  }
}
