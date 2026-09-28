import { Page, expect } from '@playwright/test';
import { FlowBoardsPage } from './sa.flow-boards.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The Übersicht section heading. **#3770 renamed it from "Arbeitszeiten" on 2026-09-22**, so both
 * spellings are accepted: staging serves "Übersicht", Production is still on the pre-3.14 build and
 * serves "Arbeitszeiten", and these page objects back mirrored specs in both projects.
 */
export const OVERVIEW_HEADING = /^(Übersicht|Arbeitszeiten)$/;

/**
 * The frozen therapist-name column on the Arbeitszeiten table — RC 3.14 #3718,
 * commit `efde53f00` (PR #3727).
 *
 * The table carries ~16 columns, so scrolling right to the Maßnahme (action item) column took the
 * therapist's name off screen and made it easy to type against the wrong row. The fix pins the name
 * cell with `position: sticky; left: 0`.
 *
 * ## The whole ticket is a computed style plus a geometry measurement
 *
 * There is no API surface: this is `WorkingHoursTable.tsx` and nothing else. So deployment is read
 * off the served bundle and the behaviour off the rendered page — `/status` cannot answer for a
 * frontend change at all (#3705), let alone a CSS one.
 *
 * The shipped style object, verbatim from the bundle:
 *
 * ```js
 * W = e => ({position:'sticky', left:0, zIndex:2, backgroundColor:e,
 *            borderRightWidth:1, borderRightColor: Colors.light.neutral3})
 * ```
 *
 * ## Traps, and the first two both read as "the feature is missing"
 *
 *  - **Only DATA rows and the header carry a testid.** `working-hours-name-${row.key}` is on
 *    therapist rows and `working-hours-name-header` on the header; the TEAM rows in Gruppen view
 *    got the frozen style but **no testid at all**. A locator built on the testid therefore finds
 *    exactly one element in Gruppen view, which reads as "the table has no rows". Every cell here
 *    is located by its computed `position: sticky` instead — which is also the AC's own property,
 *    so the locator and the assertion agree.
 *  - **The default view is Gruppen**, so a poll on `working-hours-name-t…` never resolves until the
 *    view is switched. Readiness is the HEADER testid, which is present in both views.
 *  - **The name cell's x is NOT invariant from scrollLeft 0.** `left: 0` pins it to the scroller's
 *    edge, and the row carries 16px of padding, so the cell sits at 57 unscrolled and snaps to 41
 *    on the first scroll, then holds. Asserting "x unchanged from rest" fails on a correct
 *    implementation; `xAcrossOffsets()` compares two SCROLLED positions instead, where the value is
 *    exactly invariant.
 *  - **AC2's divider is a BORDER, not a shadow.** The Developer Reference proposed `V2TableSticky`'s
 *    `boxShadow` seam; what shipped is `borderRightWidth: 1` (the commit's note: every other
 *    separator in this table is a border, and a border is inside the cell's width so nothing
 *    shifts). A probe looking for a box-shadow finds none and concludes AC2 failed.
 *  - The bundle writes `position:'sticky'` with SINGLE quotes — a `position:"sticky"` grep returns 0.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/**
 * The testids in play. **Two different prefixes, and that is the trap.**
 *
 * This commit adds `working-hours-name-*` to the header and to DATA rows only. The team rows in
 * Gruppen view are pinned by the same style but keep their pre-existing `team-toggle-g<teamId>`
 * testid from the group-expand work — so a locator built on the `working-hours-name-` prefix finds
 * exactly ONE element in Gruppen view (the header) and reads as "the table has no rows".
 */
export const TESTID = {
  header: 'working-hours-name-header',
  rowPrefix: 'working-hours-name-',
  /** Data rows only; `t<therapistId>` in Therapeut:innen view. */
  therapistRowPrefix: 'working-hours-name-t',
  /** Team rows in Gruppen view — a different prefix, predating this ticket. */
  teamRowPrefix: 'team-toggle-g',
} as const;

export type FrozenCell = {
  testid: string | null;
  position: string;
  left: string;
  zIndex: string;
  background: string;
  borderRightWidth: string;
  borderRightColor: string;
  x: number;
  width: number;
  text: string;
};

export type ScrollerInfo = { scrollWidth: number; clientWidth: number; maxScroll: number; overflowX: string };

export class WorkingHoursFrozenColumnPage {
  constructor(private page: Page) {}

  /**
   * Open the Therapeuten-Orga board and wait for the Arbeitszeiten table to paint.
   *
   * Stays on the board's DEFAULT period on purpose: this ticket is period-agnostic, and stepping
   * to a fixed month costs a dozen clicks against the slowest KPI reads on staging for no gain.
   */
  async open(): Promise<void> {
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(this.page);
    await boards.open();
    await boards.openTab('Therapeuten-Orga');
    await expect(
      this.page.getByText(OVERVIEW_HEADING).first(),
      'the Übersicht section (named "Arbeitszeiten" before #3770)',
    ).toBeVisible({ timeout: 240_000 });
    // Readiness is the HEADER testid: it is present in both views, where a row testid is not.
    await expect(
      this.page.locator(`[data-testid="${TESTID.header}"]`),
      'the Übersicht table header',
    ).toHaveCount(1, { timeout: 300_000 });
    await this.setColumnMode('Details');
  }

  /**
   * The column-mode toggle — and since **#3770 (2026-09-22) this table opens on `Operativ`**, every
   * measurement here has to select `Details` first.
   *
   * Not a preference: Operativ's five columns FIT, so the table has no horizontal scroller at all
   * and `scroller()` returns null. A sticky column is only observable against columns that move,
   * so #3718's AC3 has nothing to measure in the default view — the spec failed with "the table has
   * a horizontal scroller / Received: null" the day #3770 shipped, which reads like the frozen
   * column being gone rather than like the table having become narrow.
   *
   * Worth knowing beyond this file: #3718's behaviour is therefore **invisible in the view the
   * board now opens on**, and only applies once an admin switches to Details.
   *
   * The labels renamed with the same ticket ("Standard" → "Details"), so both are accepted for the
   * Production mirror, which is still on the pre-3.14 build.
   */
  async setColumnMode(mode: 'Details' | 'Operativ'): Promise<void> {
    const label = mode === 'Details' ? /^(Details|Standard)$/ : /^Operativ$/;
    const toggle = this.page.getByText(label).first();
    if ((await toggle.count()) === 0) return;
    await toggle.click({ timeout: 30_000 });
    // The re-render is local, but the row cells remount — wait for the pinned cells to come back.
    await expect
      .poll(async () => (await this.frozenCells()).length, { timeout: 120_000, intervals: [1_000] })
      .toBeGreaterThan(1);
  }

  /** The table's own view toggle. `Gruppen` is the default. */
  async setView(view: 'Gruppen' | 'Therapeut:innen'): Promise<void> {
    await this.page.getByText(view, { exact: true }).first().click();
    if (view === 'Therapeut:innen') {
      await expect
        .poll(async () => this.page.locator(`[data-testid^="${TESTID.therapistRowPrefix}"]`).count(), {
          timeout: 300_000,
          intervals: [2_000],
        })
        .toBeGreaterThan(2);
    } else {
      await expect
        .poll(async () => (await this.frozenCells()).length, { timeout: 300_000, intervals: [2_000] })
        .toBeGreaterThan(1);
    }
  }

  /**
   * Every pinned cell in the table, located by its computed `position: sticky`.
   *
   * By style rather than by testid, because the team rows in Gruppen view carry none — and because
   * "is this cell pinned?" is exactly what AC1 asks, so the locator and the assertion are the same
   * question.
   */
  async frozenCells(): Promise<FrozenCell[]> {
    return this.page.evaluate((headerTestId) => {
      const header = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement | null;
      if (!header) return [];
      // The table is the header cell's grandparent (cell → headerRow → table).
      const table = header.parentElement?.parentElement;
      if (!table) return [];
      const out: FrozenCell[] = [];
      const walk = (el: HTMLElement, depth: number) => {
        if (depth > 4) return;
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky') {
          const r = el.getBoundingClientRect();
          out.push({
            testid: el.getAttribute('data-testid'),
            position: cs.position,
            left: cs.left,
            zIndex: cs.zIndex,
            background: cs.backgroundColor,
            borderRightWidth: cs.borderRightWidth,
            borderRightColor: cs.borderRightColor,
            x: Math.round(r.x),
            width: Math.round(r.width),
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          });
          return; // a pinned cell's children are not themselves pinned
        }
        [...el.children].forEach((c) => walk(c as HTMLElement, depth + 1));
      };
      [...table.children].forEach((row) => walk(row as HTMLElement, 0));
      return out;
    }, TESTID.header);
  }

  /** The horizontal scroller around the table — the nearest ancestor that actually overflows. */
  async scroller(): Promise<ScrollerInfo | null> {
    return this.page.evaluate((headerTestId) => {
      let el = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement | null;
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 10) {
          const cs = getComputedStyle(el);
          return {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            maxScroll: el.scrollWidth - el.clientWidth,
            overflowX: cs.overflowX,
          };
        }
        el = el.parentElement;
      }
      return null;
    }, TESTID.header);
  }

  /**
   * The x of the pinned name cell and of a scrolling column, at each requested scroll offset.
   *
   * `columnIndex` counts cells within the row, so 0 is the pinned name and anything above it is a
   * scrolling column. The settle wait is deliberate: `scrollLeft` is applied synchronously but the
   * pinned element's box is only correct after the browser has laid out the frame.
   */
  async xAcrossOffsets(offsets: number[], columnIndex = 3): Promise<
    { offset: number; applied: number; nameX: number; columnX: number }[]
  > {
    const out: { offset: number; applied: number; nameX: number; columnX: number }[] = [];
    for (const offset of offsets) {
      out.push(
        await this.page.evaluate(
          async ([headerTestId, target, colIdx]: [string, number, number]) => {
            let scroller = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement | null;
            while (scroller && scroller !== document.body) {
              if (scroller.scrollWidth > scroller.clientWidth + 10) break;
              scroller = scroller.parentElement;
            }
            if (!scroller || scroller === document.body) throw new Error('#3718: no horizontal scroller');

            // A pinned DATA cell when there is one, else the header — Gruppen view has no row testid.
            const cell =
              (document.querySelector('[data-testid^="working-hours-name-t"]') as HTMLElement | null) ??
              (document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement);
            const row = cell.parentElement as HTMLElement;
            const column = (row.children[colIdx] ?? row.children[row.children.length - 1]) as HTMLElement;

            scroller.scrollLeft = Math.min(target, scroller.scrollWidth - scroller.clientWidth);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))));
            return {
              offset: target,
              applied: Math.round(scroller.scrollLeft),
              nameX: Math.round(cell.getBoundingClientRect().x),
              columnX: Math.round(column.getBoundingClientRect().x),
            };
          },
          [TESTID.header, offset, columnIndex] as [string, number, number],
        ),
      );
    }
    return out;
  }

  /** Reset the table to its unscrolled position, so one test does not inherit another's offset. */
  async resetScroll(): Promise<void> {
    await this.page.evaluate((headerTestId) => {
      let el = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement | null;
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 10) {
          el.scrollLeft = 0;
          return;
        }
        el = el.parentElement;
      }
    }, TESTID.header);
    await this.page.waitForTimeout(300);
  }

  /**
   * Column headers, as `textContent` — NOT `innerText`.
   *
   * The headers are `text-transform: uppercase`, so `innerText` returns the TRANSFORMED text and
   * German `ß` uppercases to `SS`: "Maßnahme" comes back as "MASSNAHME", which matches neither
   * `/Maßnahme/` nor `/Maßnahme/i` (simple case folding does not equate ß with SS). `textContent`
   * keeps the authored label. Same family as the suite's CSS-uppercase note on the board headings.
   */
  async columnHeaders(): Promise<{ authored: string[]; painted: string[] }> {
    return this.page.evaluate((headerTestId) => {
      const header = document.querySelector(`[data-testid="${headerTestId}"]`) as HTMLElement | null;
      const row = header?.parentElement;
      if (!row) return { authored: [], painted: [] };
      const cells = [...row.children] as HTMLElement[];
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
      return {
        authored: cells.map((c) => clean(c.textContent || '')),
        painted: cells.map((c) => clean(c.innerText || '')),
      };
    }, TESTID.header);
  }

  // ─────────────────────────── the deployed bundle ───────────────────────────

  async entryBundle(): Promise<string> {
    const html = await (await this.page.request.get(`${STAGING_WEB}/`, { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3718: no entry bundle in the served HTML');
    return await (await this.page.request.get(`${STAGING_WEB}${src}`, { timeout: 240_000 })).text();
  }

  static occurrences(bundle: string, needle: string): number {
    return bundle.split(needle).length - 1;
  }
}
