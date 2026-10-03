import { test, expect } from '@playwright/test';
import {
  OperativNoteColumnsPage,
  NOTE_COLUMN_WIDTH,
  UNTOUCHED_OPERATIV_COLUMNS,
} from '../../../Pages/superadmin/sa.operativ-note-columns.page';

/**
 * RC 3.15 #3871 — "Therapeuten-Orga: Operativ View Gives Its Spare Width to
 * Problem/Thema and Maßnahme" (fix commit `00cc51d24`).
 *
 * On a wide screen the Operativ view's name column took all the spare width and both
 * note columns were cut after one line, leaving the area next to the names empty —
 * management's screenshot of 29 Sep. The fix stops the name growing, lets the two note
 * columns share the spare width with Maßnahme taking the larger share, and shows two
 * lines of each note.
 *
 * **Deployed; all six ACs verified, plus the three Out-of-Scope freezes the PM's own
 * table does not cover.**
 *
 * READ-ONLY. Every request is a GET: the board is opened, the mode and view toggles are
 * clicked, the window is resized and one note is opened to read its full text. Nothing
 * is written — deliberately, because the PM's run created two real
 * `therapist-performance-notes` to get a long note, and the board already carries
 * plenty (169 note cells, several genuinely cut).
 *
 * **WHY NOTHING IS PINNED TO A PIXEL.** The name column is sized to the longest
 * therapist name and the notes divide what is left, so every absolute number moves with
 * the roster: the PM measured 315/450 (Gruppen) and 330/480 (Therapeut:innen) on 2 Oct,
 * this file measures 320/460 and 333/488 on 3 Oct, from the same correct build. Pinning
 * either set would fail on a working board within days. The assertions are relationships
 * instead. The single constant is 180 — `NOTE_COLUMN_WIDTH` in the source, still the
 * width in Details and Abrechnung and in Operativ once the table stops fitting.
 */

test.describe('#3871 Operativ note columns take the spare width', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600_000);

  let op: OperativNoteColumnsPage;

  test.beforeEach(async ({ page }) => {
    op = new OperativNoteColumnsPage(page);
    await op.open(1920, 1080);
  });

  test(
    'AC1 + AC3 row 1 — at 1920 both note columns take the spare width, Maßnahme the larger share, and the table still fits',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      // Both toggle positions, because AC1 names them separately and they are laid out
      // by different row renderers (group rollups vs therapist rows).
      for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
        await op.show('Operativ', view);
        await op.assertTablePainted();
        const g = await op.geometry();

        // The deployment probe and the AC in one reading: the two candidate layouts are
        // disjoint, so a build without the fix shows 180/180 here and a name column of
        // roughly a thousand pixels.
        expect(g.problem!, `${view}: Problem / Thema widened past the old fixed width`).toBeGreaterThan(
          NOTE_COLUMN_WIDTH,
        );
        expect(g.massnahme!, `${view}: Maßnahme widened past the old fixed width`).toBeGreaterThan(
          NOTE_COLUMN_WIDTH,
        );
        expect(g.massnahme!, `${view}: AC3 — Maßnahme gets the LARGER share`).toBeGreaterThan(g.problem!);

        // AC3 row 1: no horizontal scrolling at this width.
        expect(g.scrollWidth, `${view}: the Operativ table fits at 1920`).toBe(g.clientWidth);

        console.log(
          `[#3871] Operativ/${view} @1920: name ${g.name}, Problem / Thema ${g.problem}, ` +
            `Maßnahme ${g.massnahme}, scroller ${g.scrollWidth}/${g.clientWidth}`,
        );
      }
    },
  );

  test(
    'AC2 — the name column keeps its Details width in Operativ, at every screen width',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      // This is the half that shows the CHANGE rather than a merely plausible layout:
      // before the fix the Operativ name cell had flexGrow 1 and swallowed the spare
      // width, so the two readings differed by hundreds of pixels at 1920.
      for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
        for (const width of [1920, 1440, 1100]) {
          await op.show('Details', view);
          await op.resize(width);
          const details = (await op.geometry()).name;

          await op.show('Operativ', view);
          await op.resize(width);
          const operativ = (await op.geometry()).name;

          expect(operativ, `${view} @${width}: Operativ name width === Details name width`).toBe(details);
          console.log(`[#3871] AC2 ${view} @${width}: Details ${details} === Operativ ${operativ}`);

          await op.resize(1920);
        }
      }
    },
  );

  test(
    'AC3 row 2 — once the table no longer fits, the notes return to 180 and the name stays frozen',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
        await op.show('Operativ', view);
        await op.resize(1100);
        const g = await op.geometry();

        expect(g.problem, `${view} @1100: Problem / Thema back to today's width`).toBe(NOTE_COLUMN_WIDTH);
        expect(g.massnahme, `${view} @1100: Maßnahme back to today's width`).toBe(NOTE_COLUMN_WIDTH);
        expect(g.scrollWidth!, `${view} @1100: the table scrolls sideways`).toBeGreaterThan(g.clientWidth!);
        // #3718's frozen name column, which this ticket keeps.
        expect(g.nameSticky, `${view} @1100: the name column stays frozen on the left`).toBe('sticky');

        console.log(
          `[#3871] AC3 ${view} @1100: notes ${g.problem}/${g.massnahme}, ` +
            `scroller ${g.scrollWidth}/${g.clientWidth}, name ${g.nameSticky}`,
        );
        await op.resize(1920);
      }
    },
  );

  test(
    "AC1 — a group row's EMPTY note cells follow the header width, so the columns stay aligned",
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      // AC1 says group rows "keep their empty note cells, as today". Width matters as
      // much as emptiness: if the header widened and the rollup cells did not, every
      // column below a group header would be out of line.
      await op.show('Operativ', 'Gruppen');
      const g = await op.geometry();

      expect(g.emptyWidths.length, 'the Gruppen view renders empty rollup note cells').toBeGreaterThan(0);
      expect(
        new Set(g.emptyWidths),
        'the rollup cells take exactly the two header widths',
      ).toEqual(new Set([g.problem!, g.massnahme!]));

      // ...and they are still empty, which is the clause itself.
      const filled = await op.noteCells('note-empty-');
      expect(filled.filter((c) => c.preview.trim().length > 0), 'rollup note cells carry no text').toEqual([]);

      console.log(`[#3871] Gruppen rollup note cells: ${JSON.stringify(g.emptyWidths)} vs header ${g.problem}/${g.massnahme}`);
    },
  );

  test(
    'AC4 — a note shows two lines and is genuinely cut, while the placeholder stays one line',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      await op.show('Operativ', 'Therapeut:innen');
      const notes = await op.noteCells('note-open-');
      expect(notes.length, 'the board must carry note text to measure').toBeGreaterThan(10);

      // Every note cell is clamped to two lines...
      const clamps = new Set(notes.map((n) => n.lineClamp));
      expect(clamps, 'every Operativ note is clamped to 2 lines').toEqual(new Set(['2']));
      expect(new Set(notes.map((n) => n.whiteSpace)), 'the text wraps').toEqual(new Set(['pre-wrap']));

      // ...and at least one is ACTUALLY cut, or "2 lines" is merely configured and the
      // AC's "before it is cut off with …" is never exercised.
      const cut = notes.filter((n) => n.isCut);
      expect(cut.length, 'at least one note is long enough to be cut').toBeGreaterThan(0);
      for (const n of cut) {
        expect(n.innerScrollHeight, `${n.testid}: the full text is taller than the two shown lines`)
          .toBeGreaterThan(n.innerHeight);
      }

      // Out of Scope: "Add issue..." / "Add call to action..." stay ONE line. They sit in
      // the same widened cell, so a blanket two-line change would have taken them too.
      const placeholders = await op.noteCells('note-add-');
      expect(placeholders.length, 'empty cells render their prompt').toBeGreaterThan(0);
      expect(
        new Set(placeholders.map((p) => p.lineClamp)),
        'Out of Scope: the prompts are NOT clamped to two lines',
      ).toEqual(new Set(['none']));
      expect(
        new Set(placeholders.map((p) => p.whiteSpace)),
        'Out of Scope: the prompts stay on one line',
      ).toEqual(new Set(['nowrap']));

      console.log(
        `[#3871] ${notes.length} note cells, all clamp=2/pre-wrap, ${cut.length} genuinely cut ` +
          `(e.g. ${cut[0].testid}: ${cut[0].innerHeight}px shown of ${cut[0].innerScrollHeight}px); ` +
          `${placeholders.length} prompts, all one-line nowrap`,
      );
    },
  );

  test(
    'AC5 — clicking a cut note opens the panel with the full text',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      await op.show('Operativ', 'Therapeut:innen');
      const cut = (await op.noteCells('note-open-')).filter((n) => n.isCut);
      expect(cut.length, 'a cut note is needed to show the panel adds anything').toBeGreaterThan(0);

      // Pick the most-truncated note, so "the panel shows more" cannot be a rounding
      // artefact of a note that almost fitted.
      const target = cut.sort((a, b) => b.innerScrollHeight - a.innerScrollHeight)[0];
      const fullest = await op.openNoteAndReadFullest(target.testid);

      // There is no role="dialog" on this panel (the RNW gap #3400/#3343/#3505 recorded
      // on this board family), so the panel is identified by what it brings: the whole
      // note, where the cell showed a two-line prefix.
      expect(fullest.length, 'the panel shows more text than the clamped cell did').toBeGreaterThan(
        target.preview.length,
      );
      const opening = target.preview.slice(0, 30).trim();
      expect(fullest, 'the fuller text is the same note').toContain(opening);

      console.log(
        `[#3871] AC5 ${target.testid}: cell showed ${target.preview.length} chars of a ` +
          `${target.innerScrollHeight}px-tall note; the panel shows ${fullest.length} chars`,
      );
      await op.closePanel();
    },
  );

  test(
    'AC6 — Details and Abrechnung keep today\'s 180px note columns and one-line notes',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      for (const mode of ['Details', 'Abrechnung'] as const) {
        for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
          await op.show(mode, view);
          const g = await op.geometry();
          expect(g.problem, `${mode}/${view}: Problem / Thema unchanged`).toBe(NOTE_COLUMN_WIDTH);
          expect(g.massnahme, `${mode}/${view}: Maßnahme unchanged`).toBe(NOTE_COLUMN_WIDTH);

          if (view === 'Therapeut:innen') {
            const notes = await op.noteCells('note-open-');
            expect(new Set(notes.map((n) => n.lineClamp)), `${mode}: notes are NOT clamped to 2`).toEqual(
              new Set(['none']),
            );
            expect(new Set(notes.map((n) => n.whiteSpace)), `${mode}: notes stay on one line`).toEqual(
              new Set(['nowrap']),
            );
          }
          console.log(`[#3871] AC6 ${mode}/${view}: notes ${g.problem}/${g.massnahme}`);
        }
      }
    },
  );

  test(
    "Out of Scope — the other three Operativ columns keep the width they have in Details",
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      // "What this ticket does NOT change: the other Operativ columns (Effizienz,
      // Krank %, Fertig n. abger.), their order and their widths." Those columns are
      // shared with Details, so Details is the reference the pre-fix build cannot have
      // drifted from — a widening of any of them would show here as a disagreement.
      for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
        await op.show('Details', view);
        const details = (await op.geometry()).otherColumns;
        await op.show('Operativ', view);
        const operativ = (await op.geometry()).otherColumns;

        for (const column of UNTOUCHED_OPERATIV_COLUMNS) {
          expect(details[column], `${view}: ${column} is measurable in Details`).toBeGreaterThan(0);
          expect(operativ[column], `${view}: ${column} keeps its width in Operativ`).toBe(details[column]);
        }

        // ...and their order within Operativ is the authored one.
        const headers = await op.table.headers();
        const seen = headers.filter((h) => (UNTOUCHED_OPERATIV_COLUMNS as readonly string[]).includes(h));
        expect(seen, `${view}: the three columns keep their order`).toEqual([...UNTOUCHED_OPERATIV_COLUMNS]);

        console.log(`[#3871] Out of Scope ${view}: ${JSON.stringify(operativ)} === Details ${JSON.stringify(details)}`);
      }
    },
  );

  test(
    'evidence — the wide layout begins at a width that MOVES with the data, and 1440 is just under it',
    { tag: ['@SuperAdmin', '@OperativNotes', '@ReadOnly'] },
    async () => {
      // AC3's table says "wider than the Operativ columns need at today's widths (for
      // example 1920)". That threshold is not a constant: the name column is sized to the
      // longest therapist name, so the width at which the notes start growing drifts with
      // the roster. On staging today the Operativ table needs more than 1440 gives, which
      // is why the PM recorded 1440 behaving like the narrow row — this measures it rather
      // than asserting a side, so the test cannot fail when the roster changes.
      const report: string[] = [];
      for (const view of ['Gruppen', 'Therapeut:innen'] as const) {
        await op.show('Operativ', view);
        for (const width of [1920, 1600, 1440, 1100]) {
          await op.resize(width);
          const g = await op.geometry();
          const wide = g.problem! > NOTE_COLUMN_WIDTH;
          report.push(
            `  ${view} @${width}: notes ${g.problem}/${g.massnahme}, needs ${g.scrollWidth} of ` +
              `${g.clientWidth} -> ${wide ? 'WIDE' : 'narrow'}${
                g.scrollWidth! > g.clientWidth! ? ` (overflows by ${g.scrollWidth! - g.clientWidth!})` : ''
              }`,
          );
          // The invariant that DOES hold at every width, whichever side of the
          // threshold we are on: the notes are never narrower than the old fixed width.
          expect(g.problem!, `${view} @${width}: never narrower than today's width`).toBeGreaterThanOrEqual(
            NOTE_COLUMN_WIDTH,
          );
          expect(g.massnahme!, `${view} @${width}: never narrower than today's width`).toBeGreaterThanOrEqual(
            NOTE_COLUMN_WIDTH,
          );
        }
        await op.resize(1920);
      }
      console.log(`[#3871] where the wide layout starts, measured:\n${report.join('\n')}`);
    },
  );
});
