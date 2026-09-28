import { type Page, type APIRequestContext, request as pwRequest, expect } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';
import { boardSearchBox } from '../base/app.page';

const STAGING_WEB = 'https://staging.therapios.de';

export type Vo = {
  id: number;
  prescriptionId: string;
  date: string;
  treatmentStatus?: string;
  insuranceType?: string;
  therapyType?: string;
  isDischargeManagement?: boolean;
  blankoVO?: boolean;
  urgentTreatmentNeed?: boolean;
  treatmentStartDeadline?: string;
  validityDate?: string;
  patient?: { patientId?: number; firstName?: string; lastName?: string };
  therapist?: { fullName?: string };
};

/**
 * AC2's session axis. NOT a single label for the whole table: AC2's four rows are not mutually
 * exclusive — a closed VO also has a session history — so "closed" is a SEPARATE predicate. A
 * one-label classifier files a closed VO that started late under "closed", leaving AC2's third row
 * empty and reporting a coverage gap that is not there.
 */
export type SessionState = 'no-session' | 'started-in-time' | 'started-late';

export type CheckRow = { validation: string; passed: boolean | null; autoNote: string | null };

/**
 * RC 3.14 #3830 — a discharge VO (Entlassmanagement) must SHOW the same window the #3800 nightly
 * check enforces: start deadline on day 7 and valid-until on day 12 after the issue date.
 *
 * Two commits, two independently deployed halves, and `GET /status` answers for neither (it gives
 * the API release, not the commit — #3704 — and nothing at all about the app bundle — #3705):
 *
 *   - `4b1722ce7` (api) adds `App\Util\DischargeWindow` as the single definition and points the
 *     presenter's start deadline, the validity date, #3800's nightly reason, the waitlist, the TO
 *     risk board and the V2 list at it. Probe: the two SERIALIZED fields read issue+7 / issue+12
 *     on a GKV discharge VO, against a non-discharge control at issue+28.
 *   - `a394b0af8` (app) adds `isDischargeManagement` to the start-deadline check's dependency list
 *     and fixes a timezone bug in the expiring banner. Probe: the dependency array in the served
 *     bundle, which survives minification as an object literal of string keys.
 *
 * THE DAY-MEANING TRAP, which the commit's own notes warn about: the ordinary rules expire a VO ON
 * the shown date, while #3800's discharge rule expires the day AFTER — so day 7 and day 12 are the
 * LAST VALID days, and the shown dates must equal #3800's printed `Frist` and `Ende`. A spec that
 * "aligns" the two off by one reports a defect that is not there.
 */
export class DischargeDatesPage {
  static readonly API = 'https://api.staging.therapios.de';

  /** The window, from the ticket's own table. */
  static readonly START_DAYS = 7;
  static readonly VALIDITY_DAYS = 12;

  /** AC3: only these two insurance types get the new dates (the #3800 set). */
  static readonly DISCHARGE_TYPES = ['public', 'privat_basis'];

  /** `start_deadline_warning` — the VO-form check of AC6. Found by `description`, not `code`. */
  static readonly START_DEADLINE_WARNING = 'start_deadline_warning';
  /** `treatment_start_deadline` — the BILLING check AC9 freezes at the ordinary 28/14 days. */
  static readonly BILLING_START_DEADLINE = 'treatment_start_deadline';

  /** The exact note AC6 requires, from the Localization Reference. */
  static readonly START_DEADLINE_NOTE = 'Die Startfrist ist abgelaufen. Die VO kann automatisch verfallen.';

  /** AC2's closed statuses. */
  static readonly CLOSED = ['Abgelaufen', 'Fertig Behandelt', 'Abgebrochen', 'Abgerechnet', 'Archiviert'];

  /** AC8's fixtures, with the ticket's own "After this ticket" expectations. */
  static readonly AC8 = {
    gkvNoSession: { vo: '99699-1', id: 35048, issue: '2026-09-27', startDeadline: '2026-10-04', validity: '2026-10-09' },
    gkvStarted: { vo: '99700-1', id: 35049, issue: '2026-09-20', startDeadline: '2026-09-27', validity: '2026-10-02' },
    bg: { vo: '99671-1', id: 35008, startDays: 14 },
    noType: { vo: '99672-1', id: 35015, startDays: 28 },
  } as const;

  /** A non-discharge GKV control: ordinary 28-day deadline, validity from its FIRST treatment. */
  static readonly NON_DISCHARGE_CONTROL = '99680-1';
  /** A non-discharge GKV VO with NO session: validity is absent, which is the contrast AC1 creates. */
  static readonly NON_DISCHARGE_NO_SESSION = '99683-1';
  /** AC3's PKV discharge VO: no start deadline and no validity at all. */
  static readonly PKV_DISCHARGE = '99670-1';
  /** AC3's Privat Basis discharge VO. */
  static readonly PRIVAT_BASIS_DISCHARGE = '99669-1';
  /** AC4's Blanko discharge VO. */
  static readonly BLANKO_DISCHARGE = '99673-1';
  /** AC2's boundary pair: first session ON day 7, and on day 8. */
  static readonly STARTED_ON_DAY_7 = '99665-1';
  static readonly STARTED_ON_DAY_8 = '99667-1';

  /**
   * The discharge population, PINNED rather than walked.
   *
   * `?isDischargeManagement=` is accepted and silently IGNORED (#3800), so the population can only
   * be re-derived by walking the book — and that is not affordable here: one 100-row page of
   * `/prescriptions` measures ~26 s and throughput is flat (300 rows/37 s, 500 rows/55 s) while
   * `itemsPerPage=1000` answers **504**, so the 4,421 VOs issued since 2026-06-01 cost ~10 minutes.
   *
   * These 28 in-scope VOs ARE what that walk returned on 2026-09-28, and they span both therapy
   * types present, urgent and non-urgent, Blanko, five statuses and all five insurance types — so
   * the coverage is the same. It is sound to pin because the window is computed in ONE shared
   * `DischargeWindow` util, so a regression hits every discharge VO rather than one.
   *
   * To re-derive: walk `/prescriptions?date[after]=<d>&itemsPerPage=100` and keep the rows whose
   * `isDischargeManagement` is true (the FIELD is serialized even though the filter is not).
   */
  static readonly DISCHARGE_POPULATION = [
    // purpose-built for #3800/#3830
    '99663-1', '99664-1', '99665-1', '99666-1', '99667-1', '99668-1', '99669-1', '99670-1',
    '99671-1', '99672-1', '99673-1', '99674-1', '99675-1', '99677-1', '99678-1', '99679-1',
    '99699-1', '99700-1',
    // real discharge VOs, June-July 2026
    '4158-12', '8909-1', '8920-1', '8988-1', '9210-1', '9220-1', '9235-1', '9369-1',
    '9439-1', '9489-1', '9594-1', '9612-1', '9612-2',
  ] as const;

  /** Non-discharge controls, fetched in the same batch. */
  static readonly CONTROLS = ['99680-1', '99683-1'] as const;

  /** The therapist whose board carries the AC8 fixtures. */
  static readonly BOARD_THERAPIST = 'Sara Fischer';

  /** AC5's German labels. */
  static readonly GERMAN = {
    importantDates: 'Wichtige Termine',
    startDeadline: 'Behandlungsstartfrist',
    validityDate: 'Gültigkeitsdatum',
    boardStart: 'Startfrist',
    boardValid: 'Gültig bis',
    started: 'Begonnen',
  } as const;

  private api!: APIRequestContext;
  private token = '';

  constructor(private readonly page?: Page) {}

  private requirePage(): Page {
    if (!this.page) throw new Error('DischargeDatesPage needs a Page for the on-screen half');
    return this.page;
  }

  /** Mints its own token: the API half drives no screen, so there is no localStorage to read. */
  async connect(
    credentials = { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
  ): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: DischargeDatesPage.API });
    const res = await this.api.post('/auth', { data: credentials, timeout: 60_000 });
    if (!res.ok()) throw new Error(`POST /auth ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 240_000): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      last = `${res.status()} ${path}`;
      // A 5xx is staging being unhealthy, never the route being absent.
      if (res.status() < 500) break;
      await new Promise((r) => setTimeout(r, 2_500 * (attempt + 1)));
    }
    throw new Error(`GET failed: ${last}`);
  }

  private async post<T>(path: string, body: unknown, timeout = 240_000): Promise<T> {
    const res = await this.api.post(path, {
      data: body,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout,
    });
    if (!res.ok()) throw new Error(`POST ${path} ${res.status()} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------ VOs

  private voCache = new Map<string, Vo>();
  private behCache = new Map<number, string | null>();

  /**
   * Many VOs by number in ONE request. `?prescriptionId[]=` is a registered multi-value filter and
   * 33 numbers come back in ~4 s, against ~1.8 s EACH for the single-VO form — which is what makes
   * this file's fixture set affordable.
   *
   * Note `exact[prescriptionId][]=` returns NOTHING: the `exact` filter takes a scalar, so the
   * array form silently matches nothing and reads exactly like the fixtures being absent.
   */
  async vosByNumbers(numbers: readonly string[], chunk = 40): Promise<Map<string, Vo>> {
    for (let i = 0; i < numbers.length; i += chunk) {
      const slice = numbers.slice(i, i + chunk).filter((n) => !this.voCache.has(n));
      if (slice.length === 0) continue;
      const q = slice.map((n) => `prescriptionId%5B%5D=${encodeURIComponent(n)}`).join('&');
      const body = await this.get<{ member?: Vo[]; totalItems: number }>(
        `/prescriptions?${q}&itemsPerPage=${Math.max(slice.length, 30)}`,
      );
      for (const vo of body.member ?? []) this.voCache.set(vo.prescriptionId, vo);
    }
    return this.voCache;
  }

  /** One VO, served from the prefetch cache when it is already there. */
  async voByNumber(number: string): Promise<Vo | null> {
    if (this.voCache.has(number)) return this.voCache.get(number)!;
    await this.vosByNumbers([number]);
    return this.voCache.get(number) ?? null;
  }

  /**
   * First completed session per VO, for many VOs in ONE request — `/activities` registers
   * `prescription[]`, so 33 VOs' activities come back in ~3 s against ~1.2 s each.
   */
  async firstTreatmentDates(voIds: readonly number[], chunk = 40): Promise<Map<number, string | null>> {
    for (let i = 0; i < voIds.length; i += chunk) {
      const slice = voIds.slice(i, i + chunk).filter((id) => !this.behCache.has(id));
      if (slice.length === 0) continue;
      const q = slice.map((id) => `prescription%5B%5D=${id}`).join('&');
      const body = await this.get<{
        member?: { date: string; rejected?: boolean; treatmentType?: string; prescription?: any }[];
      }>(`/activities?${q}&itemsPerPage=1000`);
      const byVo = new Map<number, string[]>();
      for (const a of body.member ?? []) {
        if (a.rejected || a.treatmentType === 'planned') continue;
        const pr = a.prescription;
        const id = typeof pr === 'number' ? pr : Number(String(pr?.['@id'] ?? pr).split('/').pop());
        if (!Number.isFinite(id)) continue;
        (byVo.get(id) ?? byVo.set(id, []).get(id)!).push(a.date.slice(0, 10));
      }
      // A VO with no row in the response genuinely has no completed session — record that, so the
      // absence is cached rather than re-requested one VO at a time.
      for (const id of slice) this.behCache.set(id, (byVo.get(id) ?? []).sort()[0] ?? null);
    }
    return this.behCache;
  }

  async voCount(query = ''): Promise<number> {
    const body = await this.get<{ totalItems: number }>(
      `/prescriptions?itemsPerPage=1${query ? `&${query}` : ''}`,
    );
    return body.totalItems;
  }

  /** The first completed session on one VO, from the batch cache. */
  async firstTreatmentDate(voId: number): Promise<string | null> {
    if (this.behCache.has(voId)) return this.behCache.get(voId)!;
    await this.firstTreatmentDates([voId]);
    return this.behCache.get(voId) ?? null;
  }

  /**
   * One round trip for every fixture this file reads, shared by all the API tests. Without it each
   * test re-fetches the same VOs one at a time, which is where the file's runtime went.
   */
  async prefetch(): Promise<Vo[]> {
    const numbers = [...DischargeDatesPage.DISCHARGE_POPULATION, ...DischargeDatesPage.CONTROLS];
    const vos = await this.vosByNumbers(numbers);
    const present = numbers.map((n) => vos.get(n)).filter((v): v is Vo => Boolean(v));
    await this.firstTreatmentDates(present.map((v) => v.id));
    return present;
  }

  /** The prefetched in-scope discharge VOs. */
  dischargePopulation(): Vo[] {
    return DischargeDatesPage.DISCHARGE_POPULATION.map((n) => this.voCache.get(n))
      .filter((v): v is Vo => Boolean(v))
      .filter((v) => DischargeDatesPage.inScope(v));
  }

  // ------------------------------------------------------- validation checks

  /** The registry, keyed by `description` — NOT `code`, which does not exist on this resource. */
  async validations(): Promise<Record<string, { '@id': string; id: number; timing: string; applicableInsuranceTypes: string[] }>> {
    const body = await this.get<{ member?: any[] }>('/validations?itemsPerPage=100');
    const out: Record<string, any> = {};
    for (const v of body.member ?? []) out[v.description] = v;
    return out;
  }

  /** A physiotherapy Heilmittel IRI, for the transient preview payload. */
  async physioTreatmentIri(): Promise<string> {
    const body = await this.get<{ member?: any[] }>('/treatments?itemsPerPage=200');
    const t = (body.member ?? []).find((x) => x.area === 'PT' && x.kind === 'treatment');
    if (!t) throw new Error('no PT treatment in the catalogue');
    return t['@id'];
  }

  /**
   * AC6, driven through the CREATE FORM'S OWN endpoint. `POST /prescriptions/preview-creation-validation`
   * hydrates a TRANSIENT Prescription and writes nothing (#3576), so the whole boundary can be driven
   * exactly — including combinations no VO on staging has.
   *
   * Do NOT send `changedFields`: sending it (even `[]`) switches the backend to `evaluateAffected()`
   * and re-runs nothing, which reads as "the check does not exist".
   */
  async previewCreationChecks(opts: {
    issueDate: string;
    discharge: boolean;
    insuranceType?: string;
    therapyType?: string;
    treatmentIri: string;
  }): Promise<{ checked: number; results: CheckRow[] }> {
    return this.post('/prescriptions/preview-creation-validation', {
      therapyType: opts.therapyType ?? 'physiotherapy',
      insuranceType: opts.insuranceType ?? 'public',
      date: opts.issueDate,
      isDischargeManagement: opts.discharge,
      prescribedTreatments: [{ treatment: opts.treatmentIri }],
    });
  }

  /** The stored BILLING verdicts for one VO and one check, if any were ever written. */
  async storedVerdicts(voId: number, validationId: number): Promise<{ passed: boolean | null }[]> {
    const body = await this.get<{ member?: { passed: boolean | null }[] }>(
      `/prescription_validations?prescription=${voId}&validation=${validationId}&itemsPerPage=10`,
    );
    return body.member ?? [];
  }

  // ------------------------------------------------------------- AC7 warning

  /**
   * The Therapeuten-Orga "VO läuft ab ≤ 7 T" tile, which reads `validityDate`.
   *
   * The payload is a Hydra collection whose single member carries `tiles` and `rows` — so a plain
   * `member` unwrap yields one element and a row scan over it finds nothing, which reads exactly
   * like an empty tile.
   */
  async laeuftAb(): Promise<{ tile: number; voNumbers: Set<string>; rows: any[] }> {
    const body = await this.get<{ member?: { tiles: Record<string, number>; rows: any[] }[] }>(
      '/kpis/orga/risks',
      420_000,
    );
    const inner = body.member?.[0];
    if (!inner) throw new Error('/kpis/orga/risks returned no member');
    const rows = inner.rows.filter((r) => r.tile === 'laeuftAb');
    return { tile: inner.tiles.laeuftAb, voNumbers: new Set(rows.map((r) => r.voNumber)), rows };
  }

  // ----------------------------------------------------------- bundle probe

  /** The served entry bundle — the ONLY surface that answers for a frontend change (#3705). */
  async entryBundle(): Promise<string> {
    const page = this.requirePage();
    const html = await (await page.request.get(`${STAGING_WEB}/`, { timeout: 120_000 })).text();
    const m = html.match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/);
    if (!m) throw new Error('no entry bundle in the served HTML');
    return (await page.request.get(`${STAGING_WEB}${m[0]}`, { timeout: 240_000 })).text();
  }

  static occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  // --------------------------------------------------------------- oracle

  static addDays(iso: string, days: number): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  static daysBetween(from: string, to: string): number {
    const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
    return Math.round((b - a) / 86_400_000);
  }

  static expectedStartDeadline(vo: Vo): string {
    return this.addDays(vo.date, this.START_DAYS);
  }

  static expectedValidity(vo: Vo): string {
    return this.addDays(vo.date, this.VALIDITY_DAYS);
  }

  static inScope(vo: Vo): boolean {
    return vo.isDischargeManagement === true && this.DISCHARGE_TYPES.includes(vo.insuranceType ?? '');
  }

  /** AC2's session axis, independent of whether the VO is closed. */
  static sessionState(vo: Vo, firstTreatment: string | null): SessionState {
    if (!firstTreatment) return 'no-session';
    return this.daysBetween(vo.date, firstTreatment) <= this.START_DAYS ? 'started-in-time' : 'started-late';
  }

  /** AC2's fourth row, as its own predicate. */
  static isClosed(vo: Vo): boolean {
    return this.CLOSED.includes(vo.treatmentStatus ?? '');
  }

  static iso(served?: string): string | null {
    return served ? served.slice(0, 10) : null;
  }

  /** DD.MM.YYYY, the format every screen uses. */
  static de(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
  }

  // --------------------------------------------------------- AC5 on screen

  /** Signs the browser in. Call BEFORE any navigation (#3460: the refresh token is single-use). */
  async signIn(): Promise<void> {
    await mintUiSession(this.requirePage(), STAGING_CREDENTIALS.superadmin);
  }

  /**
   * The VO form's "Wichtige Termine" side panel — AC5's second row and the ticket's own second
   * screenshot. Readiness is "Speichern", which is on every VO whatever its state; the VO NUMBER is
   * not usable, since it renders as an exact leaf on some VOs and inside a larger string on others.
   */
  async openVoForm(voId: number, timeoutMs = 240_000): Promise<void> {
    const page = this.requirePage();
    await page.goto(`${STAGING_WEB}/vo-management/${voId}/edit?id=${voId}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await page.getByText('Speichern', { exact: true }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    await page
      .getByText(DischargeDatesPage.GERMAN.importantDates, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
  }

  /**
   * Reads one labelled date out of the side panel by GEOMETRY: the label and its value are separate
   * leaves, so the value is the nearest leaf below the label inside the same column. Returns the
   * painted string, which is "–" when the field is empty.
   */
  async panelDate(label: string): Promise<string | null> {
    const page = this.requirePage();
    const lab = page.getByText(label, { exact: true }).first();
    await lab.waitFor({ state: 'visible', timeout: 90_000 });
    const box = await lab.boundingBox();
    if (!box) return null;

    return page.evaluate(
      ({ lx, ly, lw }) => {
        const leaves = [...document.querySelectorAll('*')].filter(
          (el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 0,
        );
        let best: { text: string; dy: number } | null = null;
        for (const el of leaves) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const dy = r.top - ly;
          // below the label, within a couple of rows, and horizontally overlapping its column
          if (dy < 2 || dy > 70) continue;
          if (r.left > lx + lw + 60 || r.right < lx - 20) continue;
          const text = (el.textContent ?? '').trim();
          if (!text) continue;
          if (!best || dy < best.dy) best = { text, dy };
        }
        return best?.text ?? null;
      },
      { lx: box.x, ly: box.y, lw: box.width },
    );
  }

  /**
   * The Therapist Board v2 deadlines cell for one VO row — AC5's first row.
   *
   * `deadlines` is a DEFAULT column, so nothing has to be enabled; the cell carries both dates under
   * the compact labels. Read with `textContent`, because the sub-labels are CSS-uppercased (#3718).
   */
  async openTherapistBoard(therapist: string, timeoutMs = 240_000): Promise<void> {
    const page = this.requirePage();
    await page.goto(`${STAGING_WEB}/therapist/`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const picker = page.getByRole('button', { name: /Therapeut:in wählen/ }).first();
    await picker.waitFor({ state: 'visible', timeout: timeoutMs });
    await picker.click({ timeout: 60_000 });
    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 60_000 });
    await dialog.getByText(therapist, { exact: true }).first().click({ timeout: 60_000 });
    // The board is ready when a data cell has painted, not when the chrome has.
    await page.locator('[data-testid="v2-cell-deadlines"]').first().waitFor({ state: 'visible', timeout: timeoutMs });
  }

  /**
   * Narrows the board to one VO with the board's own search, then returns its deadlines cell.
   *
   * TWO TRAPS, and the first makes the row unfindable while it is right there:
   *
   *  - the VO number is NOT in `v2-cell-prescriptionId` — that testid does not exist. The VO number
   *    and the patient live in the FROZEN RAIL (`v2-rail-cell-prescriptionId`), while the scrolling
   *    body carries `v2-cell-deadlines`; a lookup on the body testid finds nothing and reads exactly
   *    like the fixture being absent from the board.
   *  - the board renders only ~12 of its rows at a time, so a fixture on a 130-VO caseload is
   *    usually not painted. Searching is what makes the read deterministic — and it must be a
   *    search, not a reload, because `mintUiSession`'s refresh token is single-use (#3460).
   */
  async boardDeadlines(voNumber: string): Promise<string | null> {
    const page = this.requirePage();
    const box = boardSearchBox(page);
    await box.waitFor({ state: 'visible', timeout: 90_000 });
    await box.fill('', { timeout: 30_000 });
    await box.fill(voNumber, { timeout: 30_000 });
    await box.press('Enter', { timeout: 30_000 });

    // Poll for the rail to hold the VO: the search is a client-side narrow, so there is no request
    // to wait on and a fixed sleep would read the previous rows.
    const railText = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="v2-rail-cell-prescriptionId"]')].map(
          (e) => (e.textContent ?? '').trim(),
        ),
      );
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const rail = await railText();
      if (rail.some((t) => t.includes(voNumber))) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    return page.evaluate((vo) => {
      const ids = [...document.querySelectorAll('[data-testid="v2-rail-cell-prescriptionId"]')];
      const row = ids.find((c) => (c.textContent ?? '').trim().includes(vo));
      if (!row) return null;
      const y = row.getBoundingClientRect().top;
      const deadlines = [...document.querySelectorAll('[data-testid="v2-cell-deadlines"]')];
      let best: { text: string; dy: number } | null = null;
      for (const d of deadlines) {
        const dy = Math.abs(d.getBoundingClientRect().top - y);
        if (dy > 24) continue;
        if (!best || dy < best.dy) best = { text: (d.textContent ?? '').trim(), dy };
      }
      return best?.text ?? null;
    }, voNumber);
  }
}
