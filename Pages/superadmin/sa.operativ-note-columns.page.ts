import { Page, expect } from '@playwright/test';
import { WorkingHoursAbrechnungPage } from './sa.working-hours-abrechnung.page';

/**
 * RC 3.15 #3871 — the Operativ view gives its spare width to Problem / Thema and
 * Maßnahme, and shows two lines of each note.
 *
 * Frontend only (`WorkingHoursTable.tsx`), so `GET /status` cannot answer for it at
 * all (#3705) and there is no serialized field to read. The subject IS the geometry,
 * so the geometry is both the deployment probe and the assertion — and the two
 * candidate layouts are disjoint, which makes one measurement decide it: before the
 * fix the note columns were a fixed {@link NOTE_COLUMN_WIDTH} and the name cell took
 * all the spare width (~1,050 px at 1920); after, the notes share it and the name
 * sits at its Details width.
 *
 * **NOTHING HERE IS PINNED TO A PIXEL COUNT.** The name column is sized to the longest
 * therapist name and the notes split whatever is left, so every absolute number drifts
 * with the data — the PM measured 315/450 and 330/480 on 2 Oct and this file measures
 * 320/460 and 333/488 the next day, from the same correct build. The assertions are
 * relationships (`notes > 180`, `Maßnahme > Problem / Thema`, `name in Operativ ===
 * name in Details`), which hold whatever the roster looks like.
 *
 * The one safe constant is 180: `NOTE_COLUMN_WIDTH` in the source, still used by the
 * Details and Abrechnung views and by Operativ once the table no longer fits.
 *
 * TRAPS, each pinned by a test:
 *  - The board opens in **Gruppen** view, whose rows are `team-toggle-g<id>` rather
 *    than `working-hours-name-t<id>` (#3718/#3725) — polling for the therapist id
 *    never resolves and the timeout reads as the whole feature being absent.
 *  - The headers are CSS-uppercased and German ß uppercases to SS, so `innerText`
 *    gives `MASSNAHME`, matching neither /Maßnahme/ nor /Maßnahme/i (#3718/#3770).
 *  - There is **no `role="dialog"`** on the note panel, so AC5 is checked by the full
 *    text arriving in the DOM, not by a dialog appearing.
 */

/** The fixed note width the fix widens away from — `NOTE_COLUMN_WIDTH` in the source. */
export const NOTE_COLUMN_WIDTH = 180;

/** The three Operativ columns the ticket's Out of Scope freezes. */
export const UNTOUCHED_OPERATIV_COLUMNS = ['Effizienz', 'Krank %', 'Fertig n. abger.'] as const;

export type ColumnMode = 'Details' | 'Operativ' | 'Abrechnung';
export type RowView = 'Gruppen' | 'Therapeut:innen';

export type Geometry = {
  name: number | null;
  problem: number | null;
  massnahme: number | null;
  nameSticky: string | null;
  scrollWidth?: number;
  clientWidth?: number;
  /** Distinct widths of each note-cell kind, so "all of them moved" is checkable. */
  emptyWidths: number[];
  openWidths: number[];
  addWidths: number[];
  /** Width of each frozen Out-of-Scope column, keyed by its authored header. */
  otherColumns: Record<string, number>;
};

export type NoteCell = {
  testid: string;
  width: number;
  height: number;
  innerHeight: number;
  innerScrollHeight: number;
  /** The clamp genuinely cut the text, rather than merely being configured. */
  isCut: boolean;
  lineClamp?: string;
  whiteSpace?: string;
  preview: string;
};

export class OperativNoteColumnsPage {
  readonly table: WorkingHoursAbrechnungPage;

  constructor(private readonly page: Page) {
    this.table = new WorkingHoursAbrechnungPage(page);
  }

  async open(width = 1920, height = 1080): Promise<void> {
    await this.page.setViewportSize({ width, height });
    await this.table.open();
  }

  /** Switch mode and view together, then let the layout settle. */
  async show(mode: ColumnMode, view: RowView): Promise<void> {
    await this.table.selectMode(mode);
    await this.table.selectView(view);
    await this.page.waitForTimeout(2_000);
  }

  async resize(width: number, height = 1000): Promise<void> {
    await this.page.setViewportSize({ width, height });
    // A resize re-lays-out the flex row; read only once it has settled, or the note
    // width comes back mid-transition and the comparison against 180 is meaningless.
    await this.page.waitForTimeout(2_500);
  }

  /** Every width this ticket governs, in one pass. */
  async geometry(): Promise<Geometry> {
    return this.page.evaluate((untouched: readonly string[]) => {
      const widthOf = (sel: string) => {
        const e = document.querySelector(sel) as HTMLElement | null;
        return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null;
      };
      const nameCell = document.querySelector('[data-testid="working-hours-name-header"]') as HTMLElement | null;
      const scroller = document.querySelector('[data-testid="working-hours-scroller"]') as HTMLElement | null;
      const ids = [...document.querySelectorAll('[data-testid]')].map((e) => (e as HTMLElement).dataset.testid!);
      const distinctWidths = (prefix: string) =>
        [...new Set(
          ids.filter((t) => t.startsWith(prefix)).map((t) => {
            const e = document.querySelector(`[data-testid="${t}"]`) as HTMLElement;
            return Math.round(e.getBoundingClientRect().width);
          }),
        )].sort((a, b) => a - b);

      // The frozen columns are read on the header row's own y-band: these header cells
      // carry no testid of their own, and the band is what keeps a same-named leaf
      // elsewhere on the board out of the reading.
      const otherColumns: Record<string, number> = {};
      const headerBox = nameCell?.getBoundingClientRect();
      if (headerBox) {
        [...document.querySelectorAll('*')].forEach((node) => {
          const el = node as HTMLElement;
          if (el.children.length !== 0) return;
          const text = (el.textContent ?? '').trim();
          if (!untouched.includes(text)) return;
          const r = el.getBoundingClientRect();
          if (Math.abs(r.top - headerBox.top) > 24) return;
          otherColumns[text] = Math.round(el.parentElement!.getBoundingClientRect().width);
        });
      }

      return {
        name: widthOf('[data-testid="working-hours-name-header"]'),
        problem: widthOf('[data-testid="working-hours-note-header-problemThema"]'),
        massnahme: widthOf('[data-testid="working-hours-note-header-callToAction"]'),
        nameSticky: nameCell ? getComputedStyle(nameCell).position : null,
        scrollWidth: scroller?.scrollWidth,
        clientWidth: scroller?.clientWidth,
        emptyWidths: distinctWidths('note-empty-'),
        openWidths: distinctWidths('note-open-'),
        addWidths: distinctWidths('note-add-'),
        otherColumns,
      };
    }, UNTOUCHED_OPERATIV_COLUMNS as unknown as string[]);
  }

  /** Every note cell that holds text, with enough to tell "clamped" from "actually cut". */
  async noteCells(prefix = 'note-open-'): Promise<NoteCell[]> {
    return this.page.evaluate((p: string) => {
      const out: NoteCell[] = [] as never;
      document.querySelectorAll(`[data-testid^="${p}"]`).forEach((node) => {
        const el = node as HTMLElement;
        const inner = el.querySelector('div,span') as HTMLElement | null;
        if (!inner) return;
        const style = getComputedStyle(inner);
        const box = el.getBoundingClientRect();
        (out as unknown as Record<string, unknown>[]).push({
          testid: el.dataset.testid!,
          width: Math.round(box.width),
          height: Math.round(box.height),
          innerHeight: inner.clientHeight,
          innerScrollHeight: inner.scrollHeight,
          isCut: inner.scrollHeight > inner.clientHeight + 1,
          lineClamp: style.webkitLineClamp,
          whiteSpace: style.whiteSpace,
          preview: (inner.innerText ?? '').slice(0, 80),
        });
      });
      return out;
    }, prefix);
  }

  /** Does the table overflow its scroller? */
  async overflows(): Promise<boolean> {
    const g = await this.geometry();
    return (g.scrollWidth ?? 0) > (g.clientWidth ?? 0);
  }

  /**
   * AC5: open a note and return the longest text on the page.
   *
   * There is no `role="dialog"`, so the panel is identified by what it brings — the
   * full note, where the cell showed a two-line prefix.
   */
  async openNoteAndReadFullest(testid: string): Promise<string> {
    await this.page.getByTestId(testid).first().click({ force: true, timeout: 30_000 });
    await this.page.waitForTimeout(3_000);
    return this.page.evaluate(() =>
      [...document.querySelectorAll('div,span,h1,h2,h3')]
        .filter((e) => e.children.length === 0)
        .map((e) => (e as HTMLElement).innerText ?? '')
        .sort((a, b) => b.length - a.length)[0] ?? '',
    );
  }

  /** Close whatever the note click opened, so the next read is of the table. */
  async closePanel(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(1_500);
  }

  async assertTablePainted(): Promise<void> {
    const g = await this.geometry();
    expect(g.name, 'the name header must be painted before anything is measured').not.toBeNull();
    expect(g.problem, 'the Problem / Thema header must be painted').not.toBeNull();
    expect(g.massnahme, 'the Maßnahme header must be painted').not.toBeNull();
  }
}
