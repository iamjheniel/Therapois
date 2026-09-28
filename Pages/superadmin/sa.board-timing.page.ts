import { Page, expect } from '@playwright/test';
import { STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';

/**
 * Flow Boards load times — RC 3.12 #3401 ("every board section loads within 10 seconds and never
 * fails from slowness").
 *
 * The fix shipped inside commit `e87c91bad` (the same commit as #3399/#3400): a rewritten revenue
 * CTE, three ORM-hydration paths replaced with SQL, memoised therapist metrics, a de-Cartesianed
 * risk fetch and one merged validation pass.
 *
 * **Measuring this is the whole test, so the method matters more than usual.**
 *
 * 1. **A repeat of the same window measures the CACHE, not the computation.** Results are cached
 *    ~5 minutes keyed by from/to/entity, so the second identical request returns in well under a
 *    second. Every "cold" sample here therefore uses a DISTINCT window of the same shape (three
 *    different months / weeks / days), which is also exactly what a user does when they step through
 *    periods — the case the ticket is about.
 * 2. **Staging response times vary by ~4x between runs** (see CLAUDE.md), so a single sample proves
 *    nothing in either direction. Sections are sampled three times over three windows and judged on
 *    the median, with the max reported alongside.
 * 3. **The board fires its sections concurrently**, and they contend with each other on a small
 *    staging box. `mountBoard()` reproduces that pattern (the wall clock a user actually waits) and
 *    is reported separately from the isolated numbers, because they answer different questions.
 * 4. **Two coincident 30 s ceilings turn slowness into an outright failure**: the client aborts a KPI
 *    read at `KPI_READ_TIMEOUT_MS` (30 s, read out of the deployed bundle by `clientReadTimeoutMs()`
 *    rather than assumed) and the load balancer's idle timeout is also 30 s. A section over that
 *    ceiling does not just look slow — it renders "Daten konnten nicht geladen werden", which is
 *    what AC2 forbids.
 *
 * Every request here is a GET; nothing writes.
 */

export type Section = {
  /** The on-screen section this endpoint feeds. */
  label: string;
  path: string;
  /** `range` takes from/to, `trend` takes level/to, `static` takes neither. */
  kind: 'range' | 'trend' | 'static';
};

export type Timing = { path: string; label: string; status: number; ms: number; bytes: number };
export type SectionSamples = {
  board: string;
  section: Section;
  level: Level;
  samples: number[];
  statuses: number[];
  median: number;
  max: number;
};
export type Level = 'tag' | 'woche' | 'monat';
export type Window = { from: string; to: string; label: string };

export class BoardTimingPage {
  static readonly API = 'https://api.staging.therapios.de';
  static readonly ROUTE = '/flow-boards';

  /** AC1's hard ceiling and its design target. */
  static readonly CEILING_MS = 10_000;
  static readonly TARGET_MS = 3_000;

  /** The German copy AC2 forbids as an outcome of slowness. */
  static readonly LOAD_ERROR = 'Daten konnten nicht geladen werden';

  /**
   * The sections each board loads, as captured live from the app's own traffic (2026-08-31).
   *
   * Note `/kpis/management` and `/kpis/management/billing-backlog` are requested by BOTH the
   * Management and Therapeuten-Orga boards; they are listed once, under Management, so a section is
   * not timed twice.
   */
  static readonly BOARDS: Record<string, Section[]> = {
    Management: [
      { label: 'KPI-Karten + Umsatz-Realisierung', path: '/kpis/management', kind: 'range' },
      { label: 'Detailtabelle (Gruppen)', path: '/kpis/management/teams', kind: 'range' },
      { label: 'Detailtabelle (Therapeut:innen)', path: '/kpis/management/therapists', kind: 'range' },
      { label: 'Abrechnungs-Stau', path: '/kpis/management/billing-backlog', kind: 'range' },
      { label: 'Verlauf nach Gruppe', path: '/kpis/management/trend', kind: 'trend' },
    ],
    'Therapeuten-Orga': [
      { label: 'Risiken-Worklist', path: '/kpis/orga/risks', kind: 'range' },
      { label: 'Arbeitszeiten', path: '/kpis/management/working-hours', kind: 'range' },
      { label: 'Orga-Verlauf', path: '/kpis/management/orga-trend', kind: 'trend' },
      { label: 'Effizienz-Buckets', path: '/kpis/management/efficiency-buckets', kind: 'static' },
      { label: 'Orga-Notizen', path: '/kpis/orga/notes', kind: 'static' },
    ],
    'Admin-Performance': [
      { label: 'Validiert gesamt + Bearbeiter:innen', path: '/kpis/admin-performance', kind: 'range' },
      { label: 'Admin-Risiken', path: '/kpis/admin-performance/risks', kind: 'range' },
      { label: 'Validiert im Zeitverlauf', path: '/kpis/admin-performance/trend', kind: 'trend' },
    ],
  };

  private token: string | null = null;

  constructor(private page: Page) {}

  async connect(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials: STAGING_CREDENTIALS.superadmin });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  /** UI entry — the board needs a browser session, which storageState no longer provides. */
  async openScreen(): Promise<void> {
    this.token = await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.setViewportSize({ width: 1920, height: 1200 });
    await this.page.goto(BoardTimingPage.ROUTE, { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByText('Flow Boards', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  }

  /** The token, for the rare spec that needs to issue a request this page object does not wrap. */
  async bearer(): Promise<string> {
    expect(this.token, 'connect() or openScreen() must run first').toBeTruthy();
    return this.token!;
  }

  // ──────────────────────────────── windows ──────────────────────────────────

  /**
   * `count` distinct windows of the given granularity, spread over past months.
   *
   * Distinct on purpose: the API caches by from/to, so sampling the same window three times would
   * measure the cache. These are all in the past and fixed, so a run is reproducible, and they are
   * far enough apart that one sample cannot warm another.
   */
  static windows(level: Level, count = 3): Window[] {
    const months = [
      { from: '2026-05-01', to: '2026-05-31' },
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-07-01', to: '2026-07-31' },
      { from: '2026-04-01', to: '2026-04-30' },
    ];
    const weeks = [
      { from: '2026-06-01', to: '2026-06-07' },
      { from: '2026-06-15', to: '2026-06-21' },
      { from: '2026-07-06', to: '2026-07-12' },
      { from: '2026-05-04', to: '2026-05-10' },
    ];
    const days = [
      { from: '2026-06-03', to: '2026-06-03' },
      { from: '2026-06-17', to: '2026-06-17' },
      { from: '2026-07-15', to: '2026-07-15' },
      { from: '2026-05-06', to: '2026-05-06' },
    ];
    const source = level === 'monat' ? months : level === 'woche' ? weeks : days;
    return source.slice(0, count).map((w) => ({ ...w, label: `${level} ${w.from}` }));
  }

  /** The window the ticket itself was filed about: Admin-Performance, Monat, July 2026. */
  static readonly TICKET_WINDOW: Window = { from: '2026-07-01', to: '2026-07-31', label: 'Monat Juli 2026' };

  private url(section: Section, level: Level, window: Window): string {
    const base = `${BoardTimingPage.API}${section.path}?pagination=false`;
    if (section.kind === 'static') return base;
    if (section.kind === 'trend') return `${base}&level=${level}&to=${window.to}`;
    return `${base}&from=${window.from}&to=${window.to}`;
  }

  // ──────────────────────────────── timing ───────────────────────────────────

  /** One section, one window, timed end to end. */
  async time(section: Section, level: Level, window: Window): Promise<Timing> {
    const started = Date.now();
    const res = await this.page.request.get(this.url(section, level, window), {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      // Deliberately far above the client's own 30s ceiling: the point is to MEASURE how long a
      // section takes, including when that is longer than the app would ever wait.
      timeout: 180_000,
    });
    const body = await res.body().catch(() => Buffer.alloc(0));
    return {
      path: section.path,
      label: section.label,
      status: res.status(),
      ms: Date.now() - started,
      bytes: body.length,
    };
  }

  /** Samples a section over `windows.length` distinct cold windows and reports the median. */
  async sample(board: string, section: Section, level: Level, windows = BoardTimingPage.windows(level)): Promise<SectionSamples> {
    const timings: Timing[] = [];
    for (const window of windows) timings.push(await this.time(section, level, window));
    const ms = timings.map((t) => t.ms).sort((a, b) => a - b);
    return {
      board,
      section,
      level,
      samples: timings.map((t) => t.ms),
      statuses: timings.map((t) => t.status),
      median: ms[Math.floor(ms.length / 2)],
      max: ms[ms.length - 1],
    };
  }

  /**
   * Fires a board's sections the way the board does — all at once — and reports each one plus the
   * wall clock until the last finished. That wall clock is what a user experiences as "the board
   * loaded"; the isolated numbers are what a developer can attribute.
   */
  async mountBoard(board: string, level: Level, window: Window): Promise<{ wallMs: number; sections: Timing[] }> {
    const sections = BoardTimingPage.BOARDS[board];
    const started = Date.now();
    const sectionTimings = await Promise.all(sections.map((section) => this.time(section, level, window)));
    return { wallMs: Date.now() - started, sections: sectionTimings };
  }

  // ─────────────────────────── the client's ceiling ──────────────────────────

  /**
   * `KPI_READ_TIMEOUT_MS` as the DEPLOYED app defines it — the point past which a slow section stops
   * being slow and becomes "Daten konnten nicht geladen werden". Read from the bundle so the spec
   * cannot drift from the build it is testing.
   */
  async clientReadTimeoutMs(): Promise<number | null> {
    const index = await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 });
    const entry = (await index.text()).match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!entry) return null;
    const bundle = await (await this.page.request.get(`https://staging.therapios.de${entry}`, { timeout: 120_000 })).text();
    // The constants are minified to `const n=[…],o=8e3,s=3e4,c=3e4;` in the module that exports
    // DEFAULT_FETCH_TIMEOUT_MS / DEFAULT_MUTATION_TIMEOUT_MS / KPI_READ_TIMEOUT_MS in that order, so
    // the export order is what identifies which literal is which.
    const exported = bundle.match(/"KPI_READ_TIMEOUT_MS",\{enumerable:!0,get:function\(\)\{return (\w+)\}\}/);
    if (!exported) return null;
    const name = exported[1];
    // The three timeout constants are declared together as `…,o=8e3,s=3e4,c=3e4;` — that trio is what
    // identifies them, because a bare `c=…` matches hundreds of unrelated minified assignments.
    const trio = bundle.match(/(\w)=8e3,(\w)=(\d+e\d+|\d+),(\w)=(\d+e\d+|\d+);/);
    if (!trio) return null;
    const values: Record<string, string> = { [trio[1]]: '8e3', [trio[2]]: trio[3], [trio[4]]: trio[5] };
    const raw = values[name];
    return raw ? Number(raw) : null;
  }

  // ────────────────────────────────── UI ────────────────────────────────────

  boardTab(name: string) {
    return this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
      .first();
  }

  /** Board tab or granularity segment — both are plain `div[tabindex="0"]` on this board. */
  async clickSegment(label: string): Promise<void> {
    await this.boardTab(label).click({ force: true, timeout: 30_000 });
  }

  /**
   * Watches a board load in the browser: how long each KPI request took, whether any was aborted,
   * and whether the load-error copy ever appeared.
   *
   * The error check is polled DURING the load rather than only at the end, because the board retries
   * and a failed section can be replaced by data a moment later — the user still saw the error.
   */
  async observeBoardLoad(
    board: string,
    level: string | null,
    settleMs = 45_000,
  ): Promise<{ requests: { url: string; ms: number; status: number }[]; failed: string[]; errorSeen: boolean; spinnerSeen: boolean }> {
    const started = new Map<string, number>();
    const requests: { url: string; ms: number; status: number }[] = [];
    const failed: string[] = [];
    const onRequest = (request: { url(): string; method(): string }) => {
      if (/\/kpis\//.test(request.url())) started.set(request.url(), Date.now());
    };
    const onResponse = (response: { url(): string; status(): number }) => {
      const at = started.get(response.url());
      if (at) requests.push({ url: response.url().replace(BoardTimingPage.API, ''), ms: Date.now() - at, status: response.status() });
    };
    const onFailed = (request: { url(): string; failure(): { errorText: string } | null }) => {
      if (!/\/kpis\//.test(request.url())) return;
      // The elapsed time is the load-bearing part: an abort at ~30s is the client's own
      // KPI_READ_TIMEOUT_MS giving up on a slow section (what AC2 forbids), while an abort at 2s is
      // just a re-render cancelling a request nobody is waiting for any more.
      const at = started.get(request.url());
      const after = at ? Date.now() - at : null;
      failed.push(
        `${request.url().replace(BoardTimingPage.API, '')} — ${request.failure()?.errorText ?? 'unknown'}` +
          `${after === null ? '' : ` after ${after}ms`}`,
      );
    };
    this.page.on('request', onRequest as never);
    this.page.on('response', onResponse as never);
    this.page.on('requestfailed', onFailed as never);

    let errorSeen = false;
    let spinnerSeen = false;
    try {
      if (board !== 'Management') await this.clickSegment(board);
      if (level) await this.clickSegment(level);
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        const state = await this.page.evaluate((needle) => ({
          error: document.body.innerText.includes(needle),
          spinner: !!document.querySelector('[role="progressbar"], [aria-busy="true"]'),
        }), BoardTimingPage.LOAD_ERROR);
        errorSeen = errorSeen || state.error;
        spinnerSeen = spinnerSeen || state.spinner;
        await this.page.waitForTimeout(700);
      }
    } finally {
      this.page.off('request', onRequest as never);
      this.page.off('response', onResponse as never);
      this.page.off('requestfailed', onFailed as never);
    }
    return { requests, failed, errorSeen, spinnerSeen };
  }

  /**
   * AC5: is the page still usable while a section is computing?
   *
   * Answered by clicking a granularity segment while KPI requests are in flight and timing how long
   * the UI takes to acknowledge it (the segment paints as active). A frozen main thread cannot
   * repaint, so this measures the thing AC5 is about rather than the request that follows.
   */
  async measureResponsivenessDuringLoad(startLevel: string, level: string): Promise<{ inFlight: number; ackMs: number | null }> {
    let inFlight = 0;
    const onRequest = (request: { url(): string }) => {
      if (/\/kpis\//.test(request.url())) inFlight += 1;
    };
    const onResponse = (response: { url(): string }) => {
      if (/\/kpis\//.test(response.url())) inFlight -= 1;
    };
    this.page.on('request', onRequest as never);
    this.page.on('response', onResponse as never);
    try {
      // Start a load and only then interact: measuring while nothing is in flight would report the
      // idle case, which is not what AC5 is about.
      await this.clickSegment(startLevel);
      const deadline = Date.now() + 15_000;
      while (inFlight === 0 && Date.now() < deadline) await this.page.waitForTimeout(100);
      const pending = inFlight;
      const started = Date.now();
      await this.clickSegment(level);
      const acknowledged = await this.page
        .waitForFunction(
          (label) => {
            const segment = Array.from(document.querySelectorAll('div[tabindex="0"]')).find(
              (node) => (node as HTMLElement).innerText?.trim() === label,
            ) as HTMLElement | undefined;
            if (!segment) return false;
            const background = getComputedStyle(segment).backgroundColor;
            return background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent';
          },
          level,
          { timeout: 15_000, polling: 200 },
        )
        .then(() => Date.now() - started)
        .catch(() => null);
      return { inFlight: pending, ackMs: acknowledged };
    } finally {
      this.page.off('request', onRequest as never);
      this.page.off('response', onResponse as never);
    }
  }

  /** Formats a sample row for the log — every timing test prints its numbers, pass or fail. */
  static describe(row: SectionSamples): string {
    return (
      `${row.board.padEnd(18)}${row.level.padEnd(6)}${row.section.label.padEnd(36)}` +
      `median ${String(row.median).padStart(6)}ms  max ${String(row.max).padStart(6)}ms  ` +
      `samples ${JSON.stringify(row.samples)}  ${row.section.path}`
    );
  }
}
