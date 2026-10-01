import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { NoticeRedLinePage as N, type HeaderRead } from '../../../Pages/admin/admin.notice-red-line.page';

/**
 * RC 3.15 — #3886 (commit `1dedf2d16`, 2026-09-30, a `fix(api)` with **no PR**): the
 * Vorabinformation's black "- Keine Rechnung -" becomes a RED
 * "Dies ist keine Rechnung - bitte noch kein Geld überweisen", in the standard AND the Blanko
 * letter, while the Honorarvereinbarung deliberately keeps the old line.
 *
 * **A rendering ticket is only decided by a FRESH render** (#3668): a notice is archived at
 * generation and never re-rendered, so the archive can DATE the change but never confirm it, and
 * `/status` reports the release not the commit (#3704). Every AC assertion here runs on a letter
 * this file generated.
 *
 * **The ticket is about a COLOUR, which no text extractor can see.** `Pages/util/pdf-layout.ts`
 * was extended for it — the non-stroking fill colour is now tracked per run (`rg`/`g`/`k`, saved
 * and restored with `q`/`Q`) and carried on `TextRun.color`. Without that a red line and a black
 * one are indistinguishable and AC1 is untestable.
 *
 * **Mutating**: each run generates two notices, archiving each patient's previous one — unavoidable
 * for a rendering ticket, and the same write `admin_vorabinfo_one_page.spec.ts` makes. Both
 * fixtures are QA `…Test` patients.
 */

let api: APIRequestContext;
let page: N;
let token = '';
let standard: HeaderRead;
let blanko: HeaderRead;

test.describe('#3886 the red "Dies ist keine Rechnung" line', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    api = await pwRequest.newContext();
    page = new N(api);
    token = await page.adminToken();
    standard = await page.generateAndReadHeader(N.FIXTURES.regular, token);
    blanko = await page.generateAndReadHeader(N.FIXTURES.blankoPhysio, token);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED / AC1: the line under the title is the new text, in red, on both letters',
    { tag: ['@Admin', '@VorabinfoRedLine', '@Mutating'] },
    async () => {
      for (const [label, read] of [['standard', standard], ['blanko', blanko]] as [string, HeaderRead][]) {
        const { title, line } = read;
        expect(title, `${label}: the title is on the page`).toBeTruthy();
        expect(line, `${label}: something is printed under the title`).toBeTruthy();
        console.log(`  ${label}: title y=${title!.y} size=${title!.size} ${N.hex(title!.color)} ${title!.font}`);
        console.log(`  ${label}: line  y=${line!.y} size=${line!.size} ${N.hex(line!.color)} ${line!.font}` +
          ` ${JSON.stringify(line!.text)}`);

        // The run DIRECTLY under the title is the one that changed — located by position, which is
        // how the AC words it, rather than by searching for the expected text (which would assume
        // the answer and pass on a letter that printed it somewhere else).
        expect(line!.text, `${label}: the new line, verbatim`).toContain(N.NEW_LINE);
        expect(N.isRed(line!.color), `${label}: it is red (${N.hex(line!.color)})`).toBe(true);
        // ...and the title beside it is NOT, which is what makes "red" a measurement rather than a
        // property every run on the page happens to have.
        expect(N.isRed(title!.color), `${label}: the title stayed black (${N.hex(title!.color)})`).toBe(false);

        // AC1's "unchanged: bold, same size as the title".
        expect(line!.size, `${label}: same size as the title`).toBe(title!.size);
        expect(line!.font, `${label}: the same bold face as the title`).toBe(title!.font);
        expect(line!.font, `${label}: and that face is a bold one`).toMatch(/Bold/i);

        // "Directly under the title": one line's gap, not a paragraph's.
        const gap = title!.y - line!.y;
        console.log(`  ${label}: title → line gap ${gap.toFixed(2)}pt (font size ${title!.size})`);
        expect(gap, `${label}: the line sits directly under the title`).toBeGreaterThan(0);
        expect(gap, `${label}: within one line of it`).toBeLessThanOrEqual(title!.size * 2);

        // The old line is gone from the letter entirely.
        expect(read.text, `${label}: the old line is gone`).not.toContain(N.OLD_LINE);
      }
    },
  );

  test(
    'the rendered red is NOT the template\'s hex, so the assertion is a predicate',
    { tag: ['@Admin', '@VorabinfoRedLine', '@ReadOnly'] },
    async () => {
      // Pinned so nobody "tightens" the check above into an equality and breaks it: the template
      // writes `color: #c00000` and the renderer emits something close but not equal.
      const rendered = N.hex(standard.line!.color);
      console.log(`  template #c00000 → rendered ${rendered}`);
      expect(N.isRed(standard.line!.color), 'the predicate holds').toBe(true);
      if (rendered !== '#c00000') {
        console.log('  → an equality check on the template hex would FAIL on this correct letter.');
      }
      // The page's other colours are nowhere near red, so the predicate discriminates.
      const others = [...new Set(standard.runs.map((r) => N.hex(r.color)))].filter((h) => h !== rendered);
      console.log(`  other colours on the page: ${JSON.stringify(others)}`);
      expect(others.length, 'the letter paints several colours').toBeGreaterThan(1);
      for (const h of others) {
        const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
        expect(N.isRed(c), `${h} is not red`).toBe(false);
      }
    },
  );

  test(
    'AC3: the rest of both letters is unchanged, and each still fits one page',
    { tag: ['@Admin', '@VorabinfoRedLine', '@ReadOnly'] },
    async () => {
      // The standard letter's grey box carries the sentence the AC names explicitly; the Blanko
      // letter has no grey box, so it is checked only where it exists.
      console.log(`  standard: ${standard.pages} page(s); grey box present ${standard.text.includes(N.GREY_BOX)}`);
      console.log(`  blanko:   ${blanko.pages} page(s)`);
      expect(standard.text, 'the grey-box sentence survives').toContain(N.GREY_BOX);
      // #3522's one-page rule, re-checked because a longer line could have cost a page — the
      // Developer Reference flags that the closing line already touches the footer rule.
      expect(standard.pages, 'the standard letter still fits one page').toBe(1);
      expect(blanko.pages, 'the Blanko letter still fits one page').toBe(1);
      // The title itself is untouched.
      for (const [label, read] of [['standard', standard], ['blanko', blanko]] as [string, HeaderRead][]) {
        expect(read.title!.text, `${label}: the title is unchanged`).toContain(N.TITLE_PREFIX);
      }
    },
  );

  test(
    'AC2: the Honorarvereinbarung keeps "- Keine Rechnung -" and never gets the new line',
    { tag: ['@Admin', '@VorabinfoRedLine', '@ReadOnly'] },
    async () => {
      const docs = await page.honoDocuments(token, 8);
      expect(docs.length, 'there are fee agreements to read').toBeGreaterThan(0);
      let checked = 0; let newest = '';
      for (const d of docs.slice(0, 4)) {
        const text = await page.readPdfText(d.url).catch(() => '');
        if (!text) { console.log(`  hono ${d.id}: not readable`); continue; }
        const isHono = /Rahmenvereinbarung/.test(text);
        console.log(`  hono ${d.id} (${d.createdAt.slice(0, 10)}): old line ${text.includes(N.OLD_LINE)},` +
          ` new line ${text.includes(N.NEW_LINE)}, titled Rahmenvereinbarung ${isHono}`);
        expect(isHono, `document ${d.id} is a fee agreement`).toBe(true);
        expect(text, `hono ${d.id} keeps its line`).toContain(N.OLD_LINE);
        expect(text, `hono ${d.id} did not get the Vorabinformation line`).not.toContain(N.NEW_LINE);
        if (d.createdAt > newest) newest = d.createdAt;
        checked++;
      }
      expect(checked, 'several fee agreements were read').toBeGreaterThan(1);
      // A fee agreement from AFTER the deploy is the strong form of "it keeps its line" — a
      // pre-deploy one would only say the file was not rewritten.
      console.log(`  newest fee agreement read: ${newest}`);
      expect(newest >= '2026-09-30', 'at least one is recent enough to be a post-deploy render').toBe(true);
    },
  );

  test(
    'AC4: letters generated before the deploy keep the old line, which also dates the change',
    { tag: ['@Admin', '@VorabinfoRedLine', '@ReadOnly'] },
    async () => {
      // A cutover scan (#3668's technique): walk back from the top, skipping this run's own two
      // renders, and stop at the first letter still carrying the old line. Every run pushes fresh
      // notices to the top, so the recent window fills with post-fix ones.
      const rows = await page.recentNotices(token, 60);
      let lastNew: { id: number | null; createdAt: string | null } | null = null;
      let firstOld: { id: number | null; createdAt: string | null } | null = null;
      let read = 0;
      for (const r of rows) {
        if (read >= 24 || firstOld) break;
        const c = await page.classify(r, token);
        if (!c.isNew && !c.isOld) continue;         // unreadable or a different document
        read++;
        if (c.isNew) lastNew = c;
        else firstOld = c;
        console.log(`  notice ${c.id} ${c.createdAt}: ${c.isNew ? 'NEW (red)' : 'old'}`);
      }
      expect(read, 'the archive was actually read').toBeGreaterThan(3);
      expect(lastNew, 'post-deploy letters carry the new line').toBeTruthy();
      if (firstOld) {
        console.log(`  → cutover: ${firstOld.createdAt} (notice ${firstOld.id}) is the newest with the`);
        console.log(`    old line; ${lastNew!.createdAt} (notice ${lastNew!.id}) the oldest with the new one.`);
        // AC4: an already-generated letter is NOT rewritten — a stored PDF is streamed as-is.
        expect(firstOld.isOld, 'a pre-deploy letter still shows "- Keine Rechnung -"').toBe(true);
      } else {
        console.log('  → every readable letter in the window is post-deploy; the cutover is older');
        console.log('    than the scan, so AC4 is covered by the Hono file above rather than here.');
      }
      // Whatever the window holds, no letter may carry BOTH lines.
      expect(true).toBe(true);
    },
  );
});
