import { Page, Locator, Response, expect } from '@playwright/test';
import { TherapistBoardV2Page } from './therapist.board-v2.page';
import { settleAfter } from '../util/settle';

/**
 * "Tage seit Beh." — the days-since-last-treatment measure on the Therapist Board (RC 3.11.1 #3471).
 *
 * The measure drives three surfaces at once: the "14+ Tage nicht behandelt" hint, the
 * BEHANDLUNGSLÜCKE ("Seit 14+ Tagen unbehandelt") filter and the sortable "Tage seit Beh." column.
 * Before the fix each was computed **per VO** from that VO's own last activity and kept accruing on
 * VOs that were already closed, so the same patient could read 176 days on a finished VO and a few
 * days on their active one; the hint then counted VO rows while its label said "Patienten".
 *
 * After the fix the number belongs to the PATIENT: the board's provider rolls the figure up across
 * the patient's non-terminal VOs and stamps the same value on every row of that patient, terminal
 * rows included. Two consequences the assertions here depend on:
 *
 *  - **Null is a value.** A patient with no treated, still-treatable VO gets `null`, which the API
 *    OMITS from the payload (so it reads `undefined`, never `null` or `0`) and the column renders as
 *    a dash "–". That is deliberately not the same fact as "treated today".
 *  - **The rollup only sees the VOs in the response.** It is computed over the caseload being
 *    served, so the same patient can read a number on one therapist's board and a dash on another's
 *    — see the `@RollupScope` test for why that is worth knowing.
 *
 * Everything here is read-only: it reads the board's own `GET /therapist-prescription-groups`
 * response as the page loads it (never a hand-built query, so the rows asserted are exactly the rows
 * painted) and drives filter/sort/hint controls that live for the visit only.
 */

/** The 14-weekday threshold the hint, the filter and the row highlight all share. */
export const OVERDUE_DAYS = 14;

/** What the column renders when the patient has no treated, still-treatable VO. */
export const NO_VALUE_DASH = '–';

/**
 * The three statuses #3471 names: a Finished, Invoiced or Archived VO will never be treated again,
 * so it must not source a patient's "most recent treatment".
 */
export const TICKET_TERMINAL_STATUSES = ['Fertig Behandelt', 'Abgerechnet', 'Archiviert'] as const;

/**
 * What the fix actually excludes — the ticket's three **plus Abgelaufen and Abgebrochen**
 * (`PatientTreatmentRecencyCalculator::TERMINAL_STATUSES`). An expired or cancelled VO cannot be
 * treated again either, so the wider set is defensible, but it is a scope change the ACs do not
 * mention and it is observable: a patient whose only treatment sits on a cancelled VO reads "–"
 * rather than a real gap, and so never reaches the 14+ hint.
 */
export const IMPLEMENTED_TERMINAL_STATUSES = [
  ...TICKET_TERMINAL_STATUSES,
  'Abgelaufen',
  'Abgebrochen',
] as const;

/** One VO as the board's own payload carries it. */
export type BoardRow = {
  patientId: number;
  patientName: string;
  /** `active` = the patient has an open VO; `others` = the inactive group. */
  bucket: 'active' | 'others';
  /** `prescriptions` rows are the board's top-level rows; `completed` ones hang off them. */
  list: 'prescriptions' | 'completed';
  vo: string;
  status: string;
  /** The patient-level rollup. `null` when the payload omits it — see the class doc. */
  days: number | null;
  /** This VO's OWN last treatment, which is what the rollup is derived from. */
  lastTreatment: Date | null;
};

/** A rendered table row: its VO number and whatever the "Tage seit Beh." cell shows. */
export type RenderedRow = { vo: string; days: string };

export class UntreatedDaysPage {
  readonly board: TherapistBoardV2Page;

  /** The board's own "Meine VOs" payload, captured as the page requests it. */
  private payload: unknown = null;

  /** The response listener currently collecting it, so a re-open can detach the previous one. */
  private captureHandler: ((response: Response) => Promise<void>) | null = null;

  constructor(private page: Page) {
    this.board = new TherapistBoardV2Page(page);
  }

  // ───────────────────────────── weekday arithmetic ──────────────────────────

  /**
   * Weekdays (Mon–Fri) between two dates, mirroring
   * `PatientTreatmentRecencyCalculator::weekdaysBetween()` — including its swap, so a
   * FUTURE-dated treatment (staging carries a few) counts forward from today rather than negative.
   */
  static weekdaysBetween(from: Date, to: Date): number {
    const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    let start = day(from);
    let end = day(to);
    if (start > end) [start, end] = [end, start];

    const totalDays = Math.round((end - start) / 86_400_000);
    if (totalDays === 0) return 0;

    let weekdays = Math.floor(totalDays / 7) * 5;
    const remaining = totalDays % 7;
    // ISO weekday of the start date: 1 (Mon) … 7 (Sun).
    const startDow = ((new Date(start).getUTCDay() + 6) % 7) + 1;
    for (let i = 1; i <= remaining; i++) {
      if (((startDow + i - 1) % 7) + 1 <= 5) weekdays++;
    }
    return weekdays;
  }

  /**
   * The "today" the server counted from, as candidates rather than one date.
   *
   * The API stamps `new DateTimeImmutable('today')` in ITS timezone; a runner in another zone can
   * sit a calendar day either side of it. Asserting against a single local date would make a
   * green suite depend on the hour it ran, so the expectation is satisfied by any candidate and
   * the test logs which one matched.
   */
  static todayCandidates(): Date[] {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    return [today, new Date(today.getTime() - 86_400_000), new Date(today.getTime() + 86_400_000)];
  }

  /** True when `served` is the weekday count from `date` under any plausible server "today". */
  static daysAgrees(date: Date, served: number): boolean {
    return UntreatedDaysPage.resolveToday(date, served) !== null;
  }

  /**
   * Which "today" makes `served` the weekday count since `date`, or null if none does.
   *
   * Comparing a SECOND date against the same served value has to reuse this one — checking each
   * date against the whole candidate list independently lets two dates a day apart both "agree",
   * which quietly weakens "this row does not report its own treatment date" to nothing.
   */
  static resolveToday(date: Date, served: number): Date | null {
    return (
      UntreatedDaysPage.todayCandidates().find(
        (today) => UntreatedDaysPage.weekdaysBetween(date, today) === served,
      ) ?? null
    );
  }

  // ──────────────────────────── opening the board ────────────────────────────

  /**
   * Opens the board and returns the rows out of its own API response.
   *
   * `therapist` picks another therapist's board from the "Therapeut:in wählen" dialog, which only
   * an Admin / Super Admin is offered — a therapist account lands straight on their own board.
   */
  async open(options: { therapist?: string; width?: number; height?: number } = {}): Promise<BoardRow[]> {
    const { therapist, width = 1600, height = 1000 } = options;

    this.startCapture();
    await this.page.setViewportSize({ width, height });
    await this.page.goto('/therapist/', { waitUntil: 'domcontentloaded' });

    if (therapist) await this.selectTherapist(therapist);

    await expect
      .poll(() => (this.payload === null ? 0 : 1), {
        timeout: 180_000,
        message: 'the board must load its own therapist-prescription-groups payload',
      })
      .toBe(1);
    // The payload lands before the table paints; the rows are what the assertions compare against.
    await this.waitForRows();
    return this.rows();
  }

  /**
   * Collects the board's "Meine VOs" response.
   *
   * The board fires the same endpoint twice — once with `therapist=` for the therapist's own VOs
   * and once with `shared=` for the "Geteilte VOs" tab. Only the first is what the table paints.
   */
  private startCapture() {
    this.payload = null;
    // Re-opening the board (a second therapist, say) must not leave the previous visit's listener
    // running — it would overwrite the new payload with a late-arriving old response.
    if (this.captureHandler) this.page.off('response', this.captureHandler);
    this.captureHandler = async (response) => {
      const url = response.url();
      if (!url.includes('therapist-prescription-groups')) return;
      if (!url.includes('therapist=')) return;
      try {
        this.payload = await response.json();
      } catch {
        /* a non-JSON body is a failed request; the poll above reports it as "never loaded" */
      }
    };
    this.page.on('response', this.captureHandler);
  }

  /** Waits until the table has painted rows (or has honestly none), rather than sleeping blind. */
  private async waitForRows(maxMs = 90_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if ((await this.page.locator('[data-testid="v2-rail-cell-prescriptionId"]').count()) > 0) break;
      const empty = await this.page
        .getByText('Keine VOs für diese Auswahl')
        .first()
        .isVisible()
        .catch(() => false);
      if (empty) break;
      await this.page.waitForTimeout(1000);
    }
    await this.page.waitForTimeout(2000);
  }

  /** Picks another therapist's board — Admin / Super Admin only. */
  async selectTherapist(name: string) {
    await this.page
      .getByRole('button', { name: /Therapeut:in wählen/ })
      .first()
      .click({ timeout: 60_000 });
    const dialog = this.page.locator('[role="dialog"]').first();
    await expect(dialog, 'the therapist picker must open').toBeVisible({ timeout: 30_000 });
    await dialog.locator('input').first().fill(name.split(' ')[0]);
    await this.page.waitForTimeout(2500);
    await dialog.getByText(new RegExp(name)).first().click({ timeout: 30_000 });
  }

  // ─────────────────────────── the payload, flattened ────────────────────────

  /** Every VO the board loaded, top-level rows and the finished ones they can reveal alike. */
  rows(): BoardRow[] {
    const root = (this.payload as any)?.member?.[0];
    if (!root) return [];
    const out: BoardRow[] = [];
    for (const bucket of ['active', 'others'] as const) {
      for (const group of root[bucket] ?? []) {
        for (const list of ['prescriptions', 'completed'] as const) {
          for (const p of group[list] ?? []) {
            out.push({
              patientId: group.patientId,
              patientName: group.patientName,
              bucket,
              list,
              vo: p.prescriptionId,
              status: p.treatmentStatus,
              // The API omits the field entirely for a patient with nothing to report.
              days: typeof p.daysSinceLastTreatment === 'number' ? p.daysSinceLastTreatment : null,
              lastTreatment: p.lastTreatmentDate ? new Date(p.lastTreatmentDate) : null,
            });
          }
        }
      }
    }
    return out;
  }

  /** The board's TOP-LEVEL rows — what the table paints and what the hints count against. */
  static topLevel(rows: BoardRow[]): BoardRow[] {
    return rows.filter((r) => r.list === 'prescriptions');
  }

  /** Rows grouped by their patient, in payload order. */
  static byPatient(rows: BoardRow[]): Map<number, BoardRow[]> {
    const map = new Map<number, BoardRow[]>();
    for (const row of rows) {
      const held = map.get(row.patientId);
      if (held) held.push(row);
      else map.set(row.patientId, [row]);
    }
    return map;
  }

  /**
   * The treatment a patient's value must be derived from: the most recent one on a VO that is not
   * terminal. `null` when they have none — which is the fix's `null`, i.e. the dash.
   */
  static latestEligibleTreatment(
    rows: BoardRow[],
    terminal: readonly string[] = IMPLEMENTED_TERMINAL_STATUSES,
  ): Date | null {
    let latest: Date | null = null;
    for (const row of rows) {
      if (terminal.includes(row.status)) continue;
      if (!row.lastTreatment) continue;
      if (!latest || row.lastTreatment > latest) latest = row.lastTreatment;
    }
    return latest;
  }

  /** Rows at or past the 14-weekday threshold — the hint's and the filter's own predicate. */
  static overdue(rows: BoardRow[]): BoardRow[] {
    return rows.filter((r) => (r.days ?? 0) >= OVERDUE_DAYS);
  }

  static distinctPatients(rows: BoardRow[]): number {
    return new Set(rows.map((r) => r.patientId)).size;
  }

  // ───────────────────────────── the rendered table ──────────────────────────

  /**
   * The painted rows as VO number → "Tage seit Beh." cell text.
   *
   * Matched by vertical position: the VO number lives in the frozen rail and the days cell in the
   * scrolling port, so they are siblings on screen but not in the DOM.
   */
  async renderedRows(): Promise<RenderedRow[]> {
    return await this.page.evaluate(() => {
      const vos = [...document.querySelectorAll('[data-testid="v2-rail-cell-prescriptionId"]')];
      const days = [...document.querySelectorAll('[data-testid="v2-cell-daysSinceLastTreatment"]')];
      return vos.map((v) => {
        const y = v.getBoundingClientRect().top;
        const cell = days.find((d) => Math.abs(d.getBoundingClientRect().top - y) < 20);
        return {
          // The rail cell also carries the row's "▸ n v. VOs" reveal control and its child marker.
          vo: ((v as HTMLElement).innerText || '').trim().split('\n')[0].trim(),
          days: (((cell as HTMLElement | undefined)?.innerText) || '').trim(),
        };
      });
    });
  }

  /** The days cell of one VO's row, as rendered — null when that VO is not on screen. */
  async renderedDays(vo: string): Promise<string | null> {
    const row = (await this.renderedRows()).find((r) => r.vo === vo);
    return row ? row.days : null;
  }

  /** The numeric days values in painted order; a dash reads as null. */
  static numeric(rows: RenderedRow[]): (number | null)[] {
    return rows.map((r) => (/^\d+$/.test(r.days) ? parseInt(r.days, 10) : null));
  }

  /**
   * Expands a collapsed row group ("Aktive Patienten" / "Inaktive Patienten").
   *
   * The inactive group ships COLLAPSED, so a patient whose VOs are all closed has a group header
   * and a count but no painted row until this is clicked. Matched title-case: the header is
   * CSS-uppercased, so it reads "INAKTIVE PATIENTEN" but its `textContent` — what Playwright's text
   * engine sees — stays "Inaktive Patienten".
   */
  async expandGroup(label: string): Promise<boolean> {
    const header = this.page.getByText(new RegExp(`^${label}$`, 'i')).first();
    if (!(await header.isVisible({ timeout: 15_000 }).catch(() => false))) return false;
    await this.settle(() => header.click({ timeout: 30_000 }), 6000);
    return true;
  }

  /**
   * Reveals a row's finished/previous VOs — the "▸ n v. VOs" control on the row itself.
   *
   * This is how a patient's terminal VOs reach the table at all, which is what makes the
   * "every row of the patient reads the same number" claim checkable in the UI.
   */
  async revealPreviousVos(): Promise<boolean> {
    const control = this.page.getByRole('button', { name: /v\. VOs/ }).first();
    if (!(await control.isVisible({ timeout: 15_000 }).catch(() => false))) return false;
    await this.settle(() => control.click({ timeout: 30_000 }), 5000);
    return true;
  }

  // ──────────────────────────── column sort control ──────────────────────────

  /** The sortable "Tage seit Beh." header. It IS the sort control — there is no inner button. */
  daysHeader(): Locator {
    return this.page.locator('[data-testid="v2-header-daysSinceLastTreatment"]').first();
  }

  /** Clicks the header and reports the direction glyph it settles on ("↕" / "↑" / "↓"). */
  /**
   * Runs an interaction and waits for the requests it fires to come back, rather than sleeping a
   * flat guess. `fallbackMs` is the sleep this replaced, kept only as the upper bound — see
   * `Pages/util/settle.ts` for why the network signal is what makes "the page has stopped changing"
   * trustworthy, and why a purely client-side interaction returns early instead of waiting it out.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 10_000) });
  }

  async sortByDays(): Promise<string> {
    await this.settle(() => this.daysHeader().click({ timeout: 30_000 }), 4500);
    const text = (await this.daysHeader().innerText().catch(() => '')) || '';
    return text.split('\n').map((l) => l.trim()).find((l) => ['↕', '↑', '↓'].includes(l)) ?? '';
  }

  // ──────────────────────────────── the 14+ hint ─────────────────────────────

  /** The "N Patienten seit 14+ Tagen nicht behandelt" headline, or null when nothing is due. */
  async untreatedHeadline(): Promise<string | null> {
    const headlines = await this.board.hinweiseHeadlines();
    return headlines.find((h) => /nicht behandelt/.test(h)) ?? null;
  }

  /** The count that headline announces. */
  static headlineCount(headline: string): number | null {
    const m = headline.match(/^(\d+)\s/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ─────────────────────────── the Behandlungslücke filter ───────────────────

  /** The panel's single BEHANDLUNGSLÜCKE option. */
  static readonly GAP_FILTER = 'Seit 14+ Tagen unbehandelt';

  /**
   * Applies the gap filter and returns the panel's own live "Ergebnis: N VOs" preview.
   *
   * Read before closing the panel: the preview is what the panel promises, and the caller then
   * compares it against the rows the table actually paints.
   */
  async applyGapFilter(): Promise<number | null> {
    await this.board.openFilterPanel();
    const option = this.board
      .panel()
      .getByRole('button', { name: UntreatedDaysPage.GAP_FILTER, exact: true });
    await this.settle(() => option.click({ timeout: 30_000 }), 3000);
    const preview = await this.board.filterResultCount();
    await this.board.closeFilterPanel();
    await this.settle(async () => {}, 3000);
    return preview;
  }

  /**
   * Clears the filter again.
   *
   * Opened by hand rather than through `TherapistBoardV2Page.openFilterPanel()`: once a filter is
   * applied the board grows an applied-filter chip bar carrying its OWN "Alle löschen", which that
   * helper reads as "the panel is already open" — so it never presses "Filter", and the click that
   * follows waits on a button inside a dialog that was never mounted. With `actionTimeout` at 0
   * that wait never rejects, and the test burns its whole budget on it.
   */
  async clearGapFilter() {
    const panel = this.board.panel();
    if (!(await panel.isVisible().catch(() => false))) {
      await this.page.getByRole('button', { name: 'Filter', exact: true }).click({ timeout: 30_000 });
      await expect(panel, 'the Filter panel must open to be cleared').toBeVisible({ timeout: 30_000 });
    }
    const clearAll = panel.getByRole('button', { name: 'Alle löschen', exact: true });
    await this.settle(() => clearAll.click({ timeout: 30_000 }), 2500);
    await this.board.closeFilterPanel();
    await this.settle(async () => {}, 3000);
  }
}
