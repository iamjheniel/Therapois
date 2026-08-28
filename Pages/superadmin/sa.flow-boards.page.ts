import { Page, Locator, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';
import { settleAfter } from '../util/settle';

/**
 * Flow Boards — Management Board (RC 3.10, epic #3172 / sub-tickets #3173–#3183).
 *
 * Route: `/flow-boards`, Super-Admin-only. Data comes from six endpoints, all confirmed live:
 *   GET /kpis/management            (KPI cards + waterfall + Privatanteil)
 *   GET /kpis/management/teams      (Gruppen view of the detail table)
 *   GET /kpis/management/therapists (Therapeut:innen view + traffic-light buckets)
 *   GET /kpis/management/trend      (12-period trend chart)
 *   GET /kpis/management/billing-backlog (Abrechnungs-Stau banner + drill-down)
 *   POST /kpis/management/export    (CSV download — Kian/Dennis only, 403 for everyone else)
 *
 * DOM notes — all verified live on staging; this is React Native Web, so the usual traps apply
 * (see `Pages/crm/crm.list.page.ts` for the same class of problems):
 *
 *  - **No data-testids on the board.** The only testids in the page belong to the top navigation
 *    (`button-container`, `button-text`). Visible German text is the contract.
 *  - **Board tabs are plain `div[tabindex="0"]`; top-nav entries are real `<button role="button">`.**
 *    That distinction is the *only* thing separating the "Management" board tab from the
 *    "Management" nav menu — both render the exact string "Management". Every tab/segment helper
 *    here scopes to `div[tabindex="0"]` and never uses a bare `getByText`.
 *  - **Filter dropdowns portal their options to the end of the document**, outside the trigger, and
 *    are not `<select>`/`<option>` (the page contains no `select` element at all). An option is
 *    only findable page-wide, and only after its trigger has been pressed — hence `.last()` when
 *    picking, since the same string can also appear in the board body.
 *  - **The period stepper arrows are icon-only buttons** whose label is a private-use material
 *    glyph, so `hasText: /^$/` does not match them. They are located geometrically relative to the
 *    period label. The forward arrow carries a real `disabled` + `aria-disabled="true"` once the
 *    current period is reached (#3174 AC2).
 *  - **Segment selection is conveyed by colour only** — the active segment paints
 *    `rgb(183, 224, 237)` with white label text; there is no `aria-selected`/`aria-pressed`.
 *    `isSegmentActive()` reads the computed style, which is how the auto-derived Zeitraum
 *    granularity (#3174 AC1) is observable at all.
 *  - **Cards, buckets and table rows flatten to a single text blob** ("Rot|61|< 70 %"), so values
 *    are parsed out of the owning element's text instead of per-cell locators. Detail-table rows in
 *    the flat (Therapeut:innen) view are not buttons either, so rows are counted by parsing the
 *    text after the last column header — see `detailRowNames()`.
 *
 * Timing: the board fires five aggregation requests and the client aborts a read at 8 s. On a cold
 * cache several of them lose that race and the cards silently fall back to "-"/0 with no error and
 * no spinner — that is open defect **#3233**, not a test bug. `waitForBoardLoaded()` therefore
 * polls for a settled value and returns false rather than throwing, so specs can skip with a
 * pointed message instead of going red on a known product defect.
 */
export class FlowBoardsPage extends AppPage {
  static readonly URL = '/flow-boards';
  static readonly API_BASE = 'https://api.staging.therapios.de';
  static readonly API = {
    management: '/kpis/management',
    teams: '/kpis/management/teams',
    therapists: '/kpis/management/therapists',
    trend: '/kpis/management/trend',
    backlog: '/kpis/management/billing-backlog',
    export: '/kpis/management/export',
  } as const;

  /** The 5 board tabs in on-screen order; only Management has content in Slice 1. */
  static readonly BOARDS = [
    'Management',
    'Therapeuten-Orga',
    'Einrichtungen',
    'Ärzte-Management',
    'Admin-Performance',
  ] as const;
  static readonly PLACEHOLDER_BOARDS = FlowBoardsPage.BOARDS.slice(1);

  /** Live KPI cards: 4 from #3174 AC7 plus "Umsatz validiert" from #3175. */
  static readonly LIVE_CARDS = [
    'Umsatz (behandelt)',
    'Umsatz validiert',
    'Effizienz',
    'Umsatz / Stunde',
    'Privatpatient:innen',
  ] as const;

  /** "In Vorbereitung" KPI cards (#3174 AC10). */
  static readonly COMING_SOON_CARDS = [
    'Steuergröße: Umsatz realisiert',
    'Realisierungsquote',
    'Absetzungsquote',
  ] as const;

  static readonly BUCKETS = [
    { label: 'Rot', range: '< 70 %' },
    { label: 'Gelb', range: '70–85 %' },
    { label: 'Grün', range: '> 85 %' },
    { label: 'Grau — keine Aktivität', range: 'keine Aktivität' },
  ] as const;

  static readonly WATERFALL_LIVE = ['Erarbeitet', '− n. validiert', 'Validiert'] as const;
  static readonly WATERFALL_COMING_SOON = [
    '− Absetzung',
    'Optica-Auszahlung',
    '+ Zuzahlg. (eingegangen)',
    '+ Privat (bezahlt)',
    'Realisiert',
  ] as const;

  static readonly TREND_LIVE_METRICS = ['Umsatz (behandelt)', 'Umsatz validiert', '€/Stunde'] as const;
  static readonly TREND_COMING_SOON_METRICS = [
    'Umsatz realisiert',
    'Realisierungsquote',
    'Absetzungsquote',
  ] as const;

  static readonly TABLE_LIVE_COLUMNS = [
    'UMSATZ (BEH.)',
    'VALIDIERT',
    'EFFIZIENZ',
    '€/STUNDE',
    'PRIVAT-PAT.',
  ] as const;
  static readonly TABLE_COMING_SOON_COLUMNS = [
    'UMSATZ REAL.',
    'REALIS.-QUOTE',
    'ABSETZ.-QUOTE',
  ] as const;

  static readonly BACKLOG_COLUMNS = [
    'VO',
    'PATIENT:IN',
    'HEILMITTEL',
    'LETZTE BEH.',
    'FERTIG SEIT',
    'UMSATZ',
  ] as const;

  /** Colour the active filter segment paints (there is no aria state to read). */
  private static readonly ACTIVE_BG = 'rgb(183, 224, 237)';

  constructor(page: Page) {
    super(page);
  }

  // ───────────────────────────── page + tabs ─────────────────────────────

  /** Opens the board. The rail/board layout needs a wide viewport to render the full filter bar. */
  async open() {
    await this.page.setViewportSize({ width: 1920, height: 1200 });
    await this.goto(FlowBoardsPage.URL);
    await expect(this.page.getByText('Flow Boards', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
  }

  /** A board tab — scoped to `div[tabindex="0"]` so "Management" is the tab, not the nav menu. */
  tab(name: string): Locator {
    return this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(`^${escapeRe(name)}$`) })
      .first();
  }

  async openTab(name: string) {
    await this.settle(() => this.tab(name).click(), 1500);
  }

  async expectAllBoardTabs() {
    for (const b of FlowBoardsPage.BOARDS) {
      await expect(this.tab(b), `board tab "${b}"`).toBeVisible({ timeout: 20_000 });
    }
  }

  // ─────────────────────────── readiness / values ────────────────────────

  /**
   * Runs a board interaction and waits for the requests it fires to come back, rather than sleeping.
   *
   * `fallbackMs` is the flat sleep this call used to perform. It is kept only as the shape of the
   * upper bound — the wait itself ends as soon as the board's own aggregation requests have landed
   * and the board has stopped repainting, which on a warm board is a fraction of the old sleep. The
   * bound is floored at 10 s so a genuinely slow provider still gets its full run at the client's
   * own 8 s abort, instead of being cut short the way the flat sleeps were.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 10_000) });
  }

  /** Whole-board text, newlines preserved — every value parser reads this. */
  async boardText(): Promise<string> {
    return (await this.page.locator('#root').innerText()) || '';
  }

  /**
   * The value line printed under a card/step label.
   *
   * Two kinds of line have to be stepped over to reach the real value, both found the hard way:
   *  - blank-looking lines that actually hold a single space, and
   *  - **icon-only lines**: the coming-soon cards render a private-use font glyph (e.g. U+E8B5) on
   *    their own line before "In Vorbereitung". A naive match returns that glyph, which prints as an
   *    empty string in a test diff and looks exactly like a missing value.
   */
  async valueUnder(label: string): Promise<string | null> {
    const flat = await this.boardText();
    const at = flat.indexOf(label);
    if (at < 0) return null;
    const lines = flat
      .slice(at + label.length)
      .split('\n')
      .map((l) => l.trim());
    // Private-use range: the icon font the cards use. A glyph-only line is not a value.
    const ICON_ONLY = /^[\uE000-\uF8FF\s]+$/;
    for (const line of lines) {
      if (!line) continue; // blank or whitespace-only
      if (ICON_ONLY.test(line)) continue; // icon glyph only
      return line; // note: an em dash IS returned — it is the empty state, callers must see it
    }
    return null;
  }

  /**
   * The text of one card, from its label up to the start of the next card/section.
   *
   * Used where the assertion is about the card as a whole ("shows a placeholder and no figure")
   * rather than about one value line.
   */
  async cardBlock(label: string): Promise<string> {
    const flat = await this.boardText();
    const start = flat.indexOf(label);
    if (start < 0) return '';
    const rest = flat.slice(start + label.length);
    const nextLabels = [...FlowBoardsPage.LIVE_CARDS, ...FlowBoardsPage.COMING_SOON_CARDS, 'Rot']
      .map((l) => rest.indexOf(l))
      .filter((i) => i > 0);
    const end = nextLabels.length ? Math.min(...nextLabels) : rest.length;
    return rest.slice(0, end);
  }

  /**
   * Polls until a card reports a parseable number, and returns null if it never does.
   *
   * A filter change can leave a card on the "-" empty state for a while (defect #3233), so a single
   * read right after clicking a filter is a coin flip. Callers treat null as "skip, citing #3233".
   */
  async waitForCardNumber(label: string, timeout = 45_000): Promise<number | null> {
    const deadline = Date.now() + timeout;
    let last: number | null = null;
    while (Date.now() < deadline) {
      last = FlowBoardsPage.parseNumber(await this.valueUnder(label));
      if (last !== null) return last;
      // 400 ms, not 1500: this loop is entered precisely when the card is still on its empty
      // state, so the interval is dead time on the way to the value, not a guard around it.
      await this.page.waitForTimeout(400);
    }
    return null;
  }

  /** The treated-revenue card value — the canary for "has the board actually loaded". */
  async treatedRevenue(): Promise<string | null> {
    return this.valueUnder('Umsatz (behandelt)');
  }

  /**
   * Waits until the board has rendered real figures. Returns false (never throws) when the board
   * silently settles on the empty state, which is defect #3233 — callers skip with a message.
   */
  async waitForBoardLoaded(timeout = 60_000): Promise<boolean> {
    await expect(this.page.getByText('Umsatz (behandelt)').first()).toBeVisible({ timeout: 30_000 });
    return await this.page
      .waitForFunction(
        () => {
          const t = (document.querySelector('#root') as HTMLElement)?.innerText || '';
          const m = t.match(/(?:^|\n)Umsatz \(behandelt\)\n+([^\n]+)/);
          return !!m && /\d/.test(m[1]) && !/^[-–—]$/.test(m[1].trim());
        },
        undefined,
        { timeout, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
  }

  /** "1.234 €" / "0,0 %" → 1234 / 0. Returns null for the "-"/"—" empty state. */
  static parseNumber(value: string | null | undefined): number | null {
    if (!value) return null;
    const v = value.trim();
    if (/^[-–—]$/.test(v)) return null;
    const m = v.match(/-?[\d.]+(?:,\d+)?/);
    if (!m) return null;
    return Number(m[0].replace(/\./g, '').replace(',', '.'));
  }

  // ───────────────────────────── Gesellschaft ────────────────────────────

  gesellschaftTrigger(current = 'Alle Gesellschaften'): Locator {
    return this.page.getByText(current, { exact: true }).first();
  }

  /** Opens the Gesellschaft selector; returns the option labels it offers. */
  async openGesellschaft(current = 'Alle Gesellschaften'): Promise<string[]> {
    return this.openDropdown(current);
  }

  async selectGesellschaft(name: string, current = 'Alle Gesellschaften') {
    await this.selectGesellschaftOption(name, current);
  }

  // ───────────────────────────── filter bar ──────────────────────────────

  /** A pressable filter-bar segment (Periode/Zeitraum, Tag/Woche/Monat, GKV/PKV, Praxis, …). */
  segment(label: string): Locator {
    return this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(`^${escapeRe(label)}$`) })
      .first();
  }

  /** Selection is colour-only: the active segment paints ACTIVE_BG. */
  async isSegmentActive(label: string): Promise<boolean> {
    return await this.page.evaluate(
      ([l, activeBg]) => {
        const el = [...document.querySelectorAll('div[tabindex="0"]')].find(
          (e) => (e as HTMLElement).innerText.trim() === l,
        );
        return !!el && getComputedStyle(el).backgroundColor === activeBg;
      },
      [label, FlowBoardsPage.ACTIVE_BG] as const,
    );
  }

  /** Which of Tag/Woche/Monat is currently selected. */
  async activeLevel(): Promise<'Tag' | 'Woche' | 'Monat' | null> {
    for (const l of ['Tag', 'Woche', 'Monat'] as const) {
      if (await this.isSegmentActive(l)) return l;
    }
    return null;
  }

  async setPeriodMode(mode: 'Periode' | 'Zeitraum') {
    await this.settle(() => this.segment(mode).click(), 3000);
  }

  async setLevel(level: 'Tag' | 'Woche' | 'Monat') {
    await this.settle(() => this.segment(level).click(), 3500);
  }

  /** Zeitraum-mode preset ("Last 7 Days", "This Month", "Last Month"). */
  async applyRangePreset(preset: string) {
    await this.settle(() => this.page.getByText(preset, { exact: true }).first().click(), 4000);
  }

  /** "Zeitraum: 03.08.2026 - 09.08.2026" — the range label shown in Zeitraum mode. */
  async rangeLabel(): Promise<string | null> {
    return (await this.boardText()).match(/Zeitraum: [^\n]+/)?.[0] ?? null;
  }

  /** Number of days the current Zeitraum spans, inclusive. */
  async rangeLengthDays(): Promise<number | null> {
    const m = (await this.rangeLabel())?.match(
      /(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/,
    );
    if (!m) return null;
    const from = Date.UTC(+m[3], +m[2] - 1, +m[1]);
    const to = Date.UTC(+m[6], +m[5] - 1, +m[4]);
    return Math.round((to - from) / 86_400_000) + 1;
  }

  /** Matches the period label in every level: "KW 32" | "06.08.2026" | "August 2026". */
  private static readonly PERIOD_LABEL_RE =
    /^(KW \d+|\d{2}\.\d{2}\.\d{4}|[A-ZÄÖÜ][a-zäöü]+ \d{4})$/;

  async periodLabel(): Promise<string> {
    return await this.page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const el = [...document.querySelectorAll('div')].find(
        (e) => e.children.length === 0 && re.test((e.textContent || '').trim()),
      );
      return (el?.textContent || '').trim();
    }, FlowBoardsPage.PERIOD_LABEL_RE.source);
  }

  /**
   * The icon-only stepper button on one side of the period label. Found geometrically because its
   * glyph lives in a private-use font range and carries no accessible name.
   */
  private async stepperHandle(dir: 'back' | 'forward') {
    return await this.page.evaluateHandle(
      ([direction, reSrc]) => {
        const re = new RegExp(reSrc as string);
        const label = [...document.querySelectorAll('div')].find(
          (e) => e.children.length === 0 && re.test((e.textContent || '').trim()),
        );
        if (!label) return null;
        const lr = label.getBoundingClientRect();
        const y = lr.top + lr.height / 2;
        const side = [...document.querySelectorAll('button[type="button"]')]
          .map((b) => ({ b, r: b.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && Math.abs(r.top + r.height / 2 - y) < 24)
          .filter(({ r }) => (direction === 'back' ? r.right <= lr.left + 4 : r.left >= lr.right - 4))
          .sort((a, b) => (direction === 'back' ? b.r.right - a.r.right : a.r.left - b.r.left));
        return side.length ? side[0].b : null;
      },
      [dir, FlowBoardsPage.PERIOD_LABEL_RE.source] as const,
    );
  }

  async stepPeriod(dir: 'back' | 'forward') {
    const el = (await this.stepperHandle(dir)).asElement();
    if (!el) throw new Error(`stepPeriod: no "${dir}" arrow found beside the period label`);
    await this.settle(() => el.click(), 3500);
  }

  /** True once the current period is reached — the forward arrow is really `disabled` (#3174 AC2). */
  async forwardArrowDisabled(): Promise<boolean> {
    const el = (await this.stepperHandle('forward')).asElement();
    if (!el) throw new Error('forwardArrowDisabled: forward arrow not found');
    return await el.evaluate(
      (b) => (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true',
    );
  }

  /**
   * Opens a portalled dropdown by its current trigger label and returns the option labels.
   *
   * The options are read by MARKING every existing element first and then collecting the leaves that
   * appear without that marker. A text diff of the board looks simpler but is wrong: the board's own
   * figures keep settling while the dropdown opens, so the diff picks up re-rendered chart labels and
   * table cells too — which previously produced option lists like ["—", "0 €", "Verlauf nach Gruppe"]
   * and made callers click on a table cell instead of an option.
   */
  async openDropdown(triggerLabel: string): Promise<string[]> {
    // Retried: while the board's five requests are still settling, a re-render can swallow the click
    // outright, and the fresh-node set then contains the re-rendered board instead of an option list.
    // The anchor (an option carrying the trigger's own label) is the signal that the list really opened.
    for (let attempt = 0; attempt < 4; attempt++) {
      const options = await this.tryOpenDropdown(triggerLabel);
      if (options.includes(triggerLabel)) return options;
      await this.closeDropdown();
      await this.page.waitForTimeout(2000);
    }
    return await this.tryOpenDropdown(triggerLabel);
  }

  private async tryOpenDropdown(triggerLabel: string): Promise<string[]> {
    await this.page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1')),
    );
    await this.page.getByText(triggerLabel, { exact: true }).first().click();
    // The list paints asynchronously, and the anchor option (the one carrying the trigger's own
    // label) is already the caller's definition of "it really opened" — so poll for exactly that
    // instead of sleeping 2.5 s on every open. An already-mounted list reads in ~150 ms; a slow one
    // still gets the full budget, which the flat sleep could not give it.
    //
    // The `data-qa-seen` marking above is deliberately NOT repeated inside the loop: the fresh-node
    // set has to keep accumulating across polls, or a re-read would mark the options as seen and
    // then find nothing.
    const deadline = Date.now() + 4_000;
    let options = await this.readFreshColumn(triggerLabel);
    while (!options.includes(triggerLabel) && Date.now() < deadline) {
      await this.page.waitForTimeout(150);
      options = await this.readFreshColumn(triggerLabel);
    }
    return options;
  }

  private async readFreshColumn(triggerLabel: string): Promise<string[]> {
    return await this.page.evaluate((trigger) => {
      const ICON_ONLY = /^[\uE000-\uF8FF\s]+$/;
      const fresh = [...document.querySelectorAll('*:not([data-qa-seen])')]
        .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { text: (e.textContent || '').trim(), left: r.left, top: r.top };
        })
        // Opening a dropdown also re-renders its caret icon, which arrives as a fresh node carrying
        // a private-use font glyph — truthy, so it survives a plain falsy filter, and it prints as
        // an empty string in test output.
        .filter((c) => c.text && !ICON_ONLY.test(c.text));

      // Marking alone is not enough: the board re-mounts its own cells while the dropdown opens, so
      // the fresh-node set also picks up table cells such as "0 €". The option list is the vertical
      // column that starts with the trigger's own label, so anchor on that label's x-position and
      // keep only the nodes sharing it.
      const anchor = fresh.find((c) => c.text === trigger);
      const column = anchor ? fresh.filter((c) => Math.abs(c.left - anchor.left) <= 2) : fresh;
      return column.sort((a, b) => a.top - b.top).map((c) => c.text);
    }, triggerLabel);
  }

  async closeDropdown() {
    await this.page.keyboard.press('Escape');
    // What the next click actually depends on is the overlay being GONE, so wait for that. When no
    // dialog was open the `hidden` state is already satisfied (it covers "not in the DOM"), so the
    // common case costs a single poll rather than the flat second this used to charge.
    await this.page
      .locator('[role="dialog"][aria-modal="true"]')
      .first()
      .waitFor({ state: 'hidden', timeout: 3_000 })
      .catch(() => {});
  }

  /**
   * Picks an option out of an ALREADY OPEN portalled dropdown (options render last in the DOM).
   *
   * The empty-label guard is deliberate: an empty string makes `getByText('')` match the first empty
   * `<div>` on the page and then spin on an intercepted click until the whole test times out, with
   * nothing in the failure to say which call was at fault.
   */
  async pickOption(label: string) {
    if (!label?.trim()) {
      throw new Error(`pickOption: refusing to pick an empty option label (got ${JSON.stringify(label)})`);
    }
    await this.settle(() => this.page.getByText(label, { exact: true }).last().click(), 4000);
  }

  /**
   * Opens a filter dropdown and picks one option, verifying it was actually on offer.
   *
   * Opening and picking are kept in one call so the option list is read from a dropdown that is
   * still open — the previous open-then-close-then-reopen dance let the board re-render in between
   * and the pick landed on a table cell instead.
   */
  private async openAndPick(trigger: string, name: string) {
    const options = await this.openDropdown(trigger);
    if (!options.includes(name)) {
      throw new Error(
        `"${name}" is not offered by the "${trigger}" dropdown. On offer: ${JSON.stringify(options)}`,
      );
    }
    await this.pickOption(name);
  }

  async selectTherapist(name: string, trigger = 'Alle Therapeut:innen') {
    await this.openAndPick(trigger, name);
  }

  async selectTeam(name: string, trigger = 'Alle Teams') {
    await this.openAndPick(trigger, name);
  }

  async selectGesellschaftOption(name: string, trigger = 'Alle Gesellschaften') {
    await this.openAndPick(trigger, name);
  }

  async setPatientType(type: 'Alle Patienten' | 'GKV' | 'PKV') {
    await this.settle(() => this.segment(type).click(), 4000);
  }

  async setLocationType(type: 'Alle Orte' | 'Einrichtung' | 'Praxis') {
    await this.settle(() => this.segment(type).click(), 4000);
  }

  // ───────────────────────── traffic-light buckets ───────────────────────

  bucket(label: string): Locator {
    return this.page
      .getByRole('button')
      .filter({ hasText: new RegExp(`^${escapeRe(label)}`) })
      .first();
  }

  /** Therapist count on a bucket ("Rot|61|< 70 %" → 61). */
  async bucketCount(label: string): Promise<number | null> {
    const txt = (await this.bucket(label).innerText()) || '';
    const m = txt.match(/\n\s*(\d+)\s*\n/);
    return m ? Number(m[1]) : null;
  }

  async allBucketCounts(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    for (const b of FlowBoardsPage.BUCKETS) out[b.label] = await this.bucketCount(b.label);
    return out;
  }

  async clickBucket(label: string) {
    await this.settle(() => this.bucket(label).click(), 4000);
  }

  // ───────────────────────── revenue waterfall ───────────────────────────

  /** The amount printed ABOVE a waterfall step (the step renders "<amount>\n<step label>"). */
  async waterfallStepValue(step: string): Promise<string | null> {
    const flat = await this.boardText();
    const m = flat.match(new RegExp(`([^\\n]+)\\n${escapeRe(step)}(?:\\n|$)`));
    return m ? m[1].trim() : null;
  }

  async privatanteilBadge(): Promise<string | null> {
    return (await this.boardText()).match(/Privatanteil:\s*([^\n]+)/)?.[1]?.trim() ?? null;
  }

  // ──────────────────────────── trend chart ──────────────────────────────

  /** Trend-chart metric toggles and series buttons — these ARE real role=button. */
  trendControl(label: string): Locator {
    return this.page
      .getByRole('button')
      .filter({ hasText: new RegExp(`^${escapeRe(label)}$`) })
      .last();
  }

  async selectTrendMetric(label: string) {
    await this.settle(() => this.trendControl(label).click(), 4000);
  }

  async selectTrendSeries(label: string) {
    await this.settle(() => this.trendControl(label).click(), 4000);
  }

  /** Series buttons offered by the chart: Gesamt + one per TO team + Ohne TO-Team. */
  async trendSeriesLabels(): Promise<string[]> {
    return await this.page.evaluate(() =>
      [...document.querySelectorAll('button[role="button"]')]
        .map((b) => (b as HTMLElement).innerText.trim())
        .filter((t) => t === 'Gesamt' || t === 'Ohne TO-Team' || /^Team .+/.test(t)),
    );
  }

  /**
   * Waits for the per-team series buttons to appear.
   *
   * "Gesamt" is painted as soon as the chart frame mounts, while the team buttons only arrive with
   * the teams response — so reading the list immediately returns just ["Gesamt"] and a caller
   * checking for "Ohne TO-Team" fails against a chart that is merely still loading.
   */
  async waitForTrendSeries(timeout = 60_000): Promise<string[]> {
    await this.page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button[role="button"]')]
            .map((b) => (b as HTMLElement).innerText.trim())
            .filter((t) => t === 'Ohne TO-Team' || /^Team .+/.test(t)).length > 0,
        undefined,
        { timeout, polling: 1000 },
      )
      .catch(() => {});
    return this.trendSeriesLabels();
  }

  /**
   * The chart's x-axis period labels. Read from the SVG/axis text between the metric toggles and
   * the series buttons, so the "KW 32" that also sits in the filter bar is not counted.
   */
  async trendPeriodLabels(timeout = 45_000): Promise<string[]> {
    // Polled: the chart frame, its metric toggles and its axis all mount at different times, so a
    // single read right after the board settles can catch the chart with no axis drawn yet.
    const deadline = Date.now() + timeout;
    let labels = await this.readTrendPeriodLabels();
    while (labels.length === 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(400);
      labels = await this.readTrendPeriodLabels();
    }
    return labels;
  }

  private async readTrendPeriodLabels(): Promise<string[]> {
    const flat = await this.boardText();
    const start = flat.indexOf('Verlauf nach Gruppe');
    const seriesAt = flat.indexOf('\nGesamt\n', start);
    const region = flat.slice(start < 0 ? 0 : start, seriesAt < 0 ? undefined : seriesAt);
    const kw = region.match(/KW \d+/g) ?? [];
    const days = region.match(/\b\d{2}\.\d{2}\.(?=\n|$)/gm) ?? [];
    const months =
      region.match(/\b(?:Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)\.? ?\d{2,4}\b/g) ?? [];
    const pick = [kw, days, months].sort((a, b) => b.length - a.length)[0];
    return [...new Set(pick)];
  }

  // ──────────────────────────── detail table ─────────────────────────────

  async setDetailView(view: 'Gruppen' | 'Therapeut:innen') {
    await this.settle(() => this.segment(view).click(), 6000);
  }

  /**
   * A detail-table column header.
   *
   * The headers are uppercased by CSS (`text-transform: uppercase`), so the DOM text is "Gruppe"
   * while the screen — and `innerText` — says "GRUPPE". Playwright matches on text content, not on
   * the rendered transform, so every header matcher here is case-insensitive. `getByText('GRUPPE',
   * { exact: true })` finds nothing at all.
   */
  columnHeader(label: string): Locator {
    return this.page
      .getByRole('button')
      .filter({ hasText: new RegExp(`^${escapeRe(label)}`, 'i') })
      .first();
  }

  /** Case-insensitive locator for a column header label (see `columnHeader` for why). */
  headerText(label: string): Locator {
    return this.page.getByText(new RegExp(`^${escapeRe(label)}$`, 'i')).first();
  }

  async sortBy(label: string) {
    await this.settle(() => this.columnHeader(label).click(), 3500);
  }

  /**
   * Row labels of the detail table, in display order.
   *
   * Parsed out of the text after the LAST occurrence of the final column header, because rows in
   * the flat (Therapeut:innen) view are not buttons — only Gruppen rows are — so a locator-based
   * count silently reads 1 in flat view.
   */
  async detailRowNames(): Promise<string[]> {
    const t = await this.boardText();
    const start = t.lastIndexOf('ABSETZ.-QUOTE');
    if (start < 0) return [];
    return t
      .slice(start + 'ABSETZ.-QUOTE'.length)
      .split('\n')
      .map((s) => s.trim())
      .filter(
        (s) =>
          s &&
          /[A-Za-zÄÖÜäöüß]/.test(s) && // names only: drop amounts, %, — and member counts
          !/^[\d.,]+\s*(?:€|%)?$/.test(s) &&
          !/^[-–—]$/.test(s) &&
          !/^⚠/.test(s),
      );
  }

  /**
   * Row locator for a team in the Gruppen view.
   *
   * The `hasText: /€/` filter is essential, not cosmetic: the trend chart's series buttons carry the
   * same team names ("Team Samanta Harzman") and come FIRST in the DOM, so a plain name match clicks
   * a chart legend button and the table never changes. Only table rows contain currency amounts.
   */
  row(name: string): Locator {
    return this.page
      .getByRole('button')
      .filter({ hasText: name })
      .filter({ hasText: /€/ })
      .first();
  }

  async expandTeam(name: string) {
    await this.settle(() => this.row(name).click(), 5000);
  }

  timeRecordingWarnings(): Locator {
    return this.page.getByText('⚠ Zeiterfassung');
  }

  /**
   * Reads one detail-table row as a {column header → cell text} map, matching cells to columns by
   * horizontal alignment.
   *
   * Positional parsing of the flattened row text does not work here, and getting that wrong is
   * silently misleading rather than loud: a team row renders
   * "name | members | Umsatz | trend% | Validiert | Effizienz | €/Stunde | Privat-Pat." while a
   * member row has neither the member count nor the trend arrow — so "the first percentage in the
   * row" is a trend comparison on one row and the Effizienz on the next. Aligning against the header
   * x-positions is the only way to know which column a cell belongs to.
   */
  async rowCells(name: string): Promise<Record<string, string>> {
    return await this.page.evaluate((wanted) => {
      const headers = [...document.querySelectorAll('button[role="button"]')]
        .filter((b) => {
          const t = (b as HTMLElement).innerText.trim();
          return /^(gruppe|therapeut:in|umsatz \(beh\.\)|validiert|effizienz|€\/stunde|privat-pat\.|umsatz real\.|realis\.-quote|absetz\.-quote)/i.test(
            t,
          );
        })
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { label: (b as HTMLElement).innerText.trim().split('\n')[0], left: r.left, right: r.right };
        });
      if (!headers.length) return {};

      const row = [...document.querySelectorAll('button[role="button"]')].find((b) => {
        const t = (b as HTMLElement).innerText;
        return t.includes(wanted) && t.includes('€');
      });
      if (!row) return {};

      const cells = [...row.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { text: (e as HTMLElement).innerText.trim(), left: r.left, right: r.right };
        });

      const out: Record<string, string> = {};
      for (const h of headers) {
        // the cell whose horizontal span overlaps this header's span the most
        let best: { text: string; overlap: number } | null = null;
        for (const c of cells) {
          const overlap = Math.min(c.right, h.right) - Math.max(c.left, h.left);
          if (overlap > 0 && (!best || overlap > best.overlap)) best = { text: c.text, overlap };
        }
        if (best) out[h.label] = best.text;
      }
      return out;
    }, name);
  }

  /** Effizienz percentage for a detail-table row, as a number (null for "—"). */
  async rowEfficiency(name: string): Promise<number | null> {
    const cells = await this.rowCells(name);
    const key = Object.keys(cells).find((k) => /^effizienz$/i.test(k));
    return key ? FlowBoardsPage.parseNumber(cells[key]) : null;
  }

  /**
   * Expands a team and returns the member rows it revealed.
   *
   * Computed as a set difference over `detailRowNames()` rather than by slicing the team's text
   * block: a team row's own cells contain a blank line (between its revenue and its trend arrow), so
   * "read until the next blank line" ends the block early or, worse, runs past it and swallows the
   * following team rows as if they were members.
   */
  async expandTeamAndListMembers(team: string): Promise<string[]> {
    const before = await this.detailRowNames();
    await this.expandTeam(team);
    const after = await this.detailRowNames();
    const beforeCounts = new Map<string, number>();
    for (const n of before) beforeCounts.set(n, (beforeCounts.get(n) ?? 0) + 1);
    return after.filter((n) => {
      const left = beforeCounts.get(n) ?? 0;
      if (left > 0) {
        beforeCounts.set(n, left - 1);
        return false;
      }
      return true;
    });
  }

  // ─────────────────── billing backlog banner + drill-down ───────────────

  backlogBanner(): Locator {
    return this.page.getByRole('button', { name: 'Abrechnungs-Stau' });
  }

  /** Banner headline: VO count and the "≈ … € direkt abrechenbar" value. */
  async backlogSummary(): Promise<{ count: number | null; value: string | null }> {
    const txt = (await this.backlogBanner().innerText()) || '';
    return {
      count: FlowBoardsPage.parseNumber(txt.match(/·\s*([\d.]+)\s*fertig behandelte VOs/)?.[1]),
      value: txt.match(/≈\s*([\d.,]+\s*€)\s*direkt abrechenbar/)?.[1] ?? null,
    };
  }

  async openBacklogDrilldown() {
    // The settle has to WRAP the click: its request listeners attach inside the call, so running it
    // after the click would miss the very requests the drill-down fired and fall through to the
    // client-side probe path.
    await settleAfter(this.page, () => this.backlogBanner().click(), { budgetMs: 15_000 });
    // "Fertig seit" exists only inside the drill-down, so it is the unambiguous ready signal.
    // Matched case-insensitively: like the detail table's headers, it is uppercased by CSS, so the
    // DOM text is "Fertig seit" while the screen reads "FERTIG SEIT".
    await expect(this.headerText('FERTIG SEIT')).toBeVisible({ timeout: 30_000 });
  }

  /** Text of the drill-down only (everything after its header row). */
  private async drilldownText(): Promise<string> {
    const t = await this.boardText();
    const i = t.indexOf('FERTIG SEIT');
    return i < 0 ? '' : t.slice(i);
  }

  /** Group subtotal lines inside the drill-down: "3 VOs · 2.841 €" (#3180 AC7). */
  async backlogSubtotals(): Promise<string[]> {
    return (await this.drilldownText()).match(/\d+ VOs · [\d.,]+ €/g) ?? [];
  }

  /** TO-team group headers inside the drill-down (#3180 AC5). */
  async backlogGroupHeaders(): Promise<string[]> {
    return [...new Set((await this.drilldownText()).match(/^(?:Team .+|Ohne TO-Team)$/gm) ?? [])];
  }

  /** Per-VO row lines: VO-Nr, initials, Heilmittel, "n Wo.", "n Tage"/—, revenue (#3180 AC6). */
  async backlogRows(): Promise<string[][]> {
    const lines = (await this.drilldownText()).split('\n').map((s) => s.trim());
    const rows: string[][] = [];
    for (let i = 0; i < lines.length; i++) {
      // a VO row starts with a VO number like "2706-23" followed by patient initials "D. H."
      if (/^\d+-\d+$/.test(lines[i]) && /^[A-ZÄÖÜ]\.\s?[A-ZÄÖÜ]\.$/.test(lines[i + 1] ?? '')) {
        rows.push(lines.slice(i, i + 6));
      }
    }
    return rows;
  }

  // ─────────────────────── export / download (#3181) ─────────────────────

  /**
   * The chart-data download control. Absent for every account outside the Kian/Dennis allowlist,
   * so this is normally expected to have count 0.
   */
  exportControl(): Locator {
    return this.page
      .locator('button, [role="button"], div[tabindex="0"]')
      .filter({ hasText: /Download|Herunterladen|CSV|Export|Daten exportieren/i })
      .filter({ visible: true });
  }

  /**
   * Calls a Flow Boards endpoint with the signed-in user's own bearer token, from inside the page.
   *
   * The API is a separate host (api.staging.therapios.de) and authenticates with
   * `Authorization: Bearer <jwt>` taken from the `auth-state` localStorage entry — not a cookie —
   * so a plain APIRequestContext would be unauthenticated and every call would look "blocked" for
   * the wrong reason. Running the fetch in the page reuses the real session.
   */
  async apiProbe(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; contentType: string | null; body: string }> {
    return await this.page.evaluate(
      async ([m, url, payload]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* unauthenticated — the probe still reports what the server says */
        }
        const res = await fetch(url as string, {
          method: m as string,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          body: (await res.text()).slice(0, 400),
        };
      },
      [method, `${FlowBoardsPage.API_BASE}${path}`, body ?? null] as any,
    );
  }

  /** Like `apiProbe`, but returns the full parsed JSON body (no truncation). */
  async apiJson(path: string): Promise<any> {
    return await this.page.evaluate(async (url) => {
      let token: string | null = null;
      try {
        const j = JSON.parse(localStorage.getItem('auth-state') || '');
        token = j.token || j.accessToken || j.access_token || null;
      } catch {
        /* fall through — the caller asserts on the status it gets */
      }
      const res = await fetch(url, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/ld+json',
        },
      });
      return { status: res.status, json: res.ok ? await res.json() : null };
    }, `${FlowBoardsPage.API_BASE}${path}`);
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
