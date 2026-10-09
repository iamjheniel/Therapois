import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';

/**
 * RC 3.15 #3793 — the treatment history ("Dokumentation (Behandlungsverlauf)") shows a Blanko
 * session's Heilmittel codes joined with "+" and its minutes in brackets; a regular VO's codes stay
 * without minutes; a Blanko double session shows the DOUBLED minutes on the first of its two rows.
 * Fix + QA fix `86b56b0b5` on release/3.15.0.
 *
 * READ-ONLY: the window is opened and read; nothing is documented. The oracle is the API, never a
 * hardcoded string — each session's codes are `activityTreatments[].treatment.code` and its minutes
 * `calculatedTreatmentDuration` (already doubled for a V1 double session, #3711), so the painted
 * cell is compared against what the server says the session holds. The fixtures are the PM's: the
 * ticket's own VO 4823-6 (Stephanie Möller's board) and Karsten Jahns's purpose-built Blanko VOs.
 *
 * Reached as Super Admin through the T Board's "Therapeut:in wählen" picker. The window is a portal
 * OUTSIDE #root, and its column headers are CSS-uppercased (#3718), so cells are located by the
 * header's x-band in the whole document and read as textContent.
 */
const API = 'https://api.staging.therapios.de';
const FIXTURES: Record<string, string[]> = {
  'Stephanie Möller': ['4823-6'],
  'Karsten Jahns': ['99825-1', '99827-1', '99831-1', '99834-1', '99837-1', '99991-1'],
};

type Row = { heilmittel: string; notes: string };

async function expectedRows(api: APIRequestContext, H: Record<string, string>, vo: string) {
  const v = (await (await api.get(`${API}/prescriptions?exact[prescriptionId]=${vo}`, { headers: H })).json()).member[0];
  const acts = (await (await api.get(`${API}/activities?prescription=${v.id}&itemsPerPage=100`, { headers: H })).json()).member;
  const rows: { heilmittel: string; minutesTag: number | null }[] = [];
  for (const a of acts) {
    const codes = (a.activityTreatments ?? []).map((t: any) => t.treatment?.code).filter(Boolean).join(' + ');
    const double = a.doubleTreatment === true; // omitted when false (#3602)
    rows.push({ heilmittel: v.blankoVO ? `${codes} (${a.calculatedTreatmentDuration} min)` : codes, minutesTag: double ? a.calculatedTreatmentDuration : null });
    if (double) rows.push({ heilmittel: codes, minutesTag: null }); // the second row: codes only
  }
  return { blanko: v.blankoVO === true, rows };
}

async function readHistory(page: Page): Promise<Row[]> {
  return page.evaluate(() => {
    // A cell's text is its OWN text nodes: a header carries a sibling element (sort icon), so it is
    // not a leaf, and a leaf-only read misses it entirely.
    const t = (e: Element) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöü]/g, '');
    // The window is a portal outside #root; scope every read to its own rectangle, located from
    // its title, so a same-named label on the board behind it can never be picked up.
    const all = [...document.querySelectorAll('body *')].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && t(e);
    });
    const title = all.find((e) => t(e) === 'Dokumentation (Behandlungsverlauf)');
    // The window paints its title and a spinner before its table; until the headers exist there is
    // nothing to read yet — return [] so the caller's poll waits, rather than throwing (a throw
    // ends an expect.poll immediately).
    if (!title || !all.some((e) => norm(t(e)) === 'bemerkungen')) return [];
    // Climb from the title to the first ancestor that also holds the table's headers — that is the
    // dialog; everything outside it (the board behind) is ignored.
    let box: Element = title;
    const hasNotes = (el: Element) => all.some((e) => el.contains(e) && norm(t(e)) === 'bemerkungen');
    while (box.parentElement && !hasNotes(box)) box = box.parentElement;
    const leaves = all.filter((e) => box.contains(e));
    const head = (label: string) => {
      const h = leaves.find((e) => norm(t(e)) === norm(label));
      if (!h) throw new Error(`no "${label}" header in the window`);
      return h;
    };
    const hm = head('Heilmittel').getBoundingClientRect();
    const notes = head('Bemerkungen').getBoundingClientRect();
    const doku = head('Doku Typ').getBoundingClientRect();
    const dates = leaves.filter((e) => /^\d{2}\.\d{2}\.\d{4}$/.test(t(e)) && e.getBoundingClientRect().top > hm.bottom
      && e.getBoundingClientRect().left < hm.left);
    return dates.map((d) => {
      const y = d.getBoundingClientRect().top + d.getBoundingClientRect().height / 2;
      const inBand = (l: number, r: number) => leaves.filter((e) => {
        const b = e.getBoundingClientRect();
        return b.left >= l - 4 && b.left < r - 4 && Math.abs(b.top + b.height / 2 - y) < 30;
      }).map(t).join(' ');
      return { heilmittel: inBand(hm.left, notes.left), notes: inBand(notes.left, doku.left) };
    });
  });
}

test.describe('#3793 Blanko sessions show their Heilmittel and minutes in the treatment history', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);
  let api: APIRequestContext;
  let H: Record<string, string>;

  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext();
    const r = await api.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
    });
    H = { Authorization: `Bearer ${(await r.json()).token}`, Accept: 'application/ld+json' };
  });
  test.afterAll(async () => { await api?.dispose(); });

  for (const [therapist, vos] of Object.entries(FIXTURES)) {
    test(`${therapist}: ${vos.join(', ')} — Heilmittel column vs the API, double-session tag`, {
      tag: ['@SuperAdmin', '@BlankoHistory', '@ReadOnly'],
    }, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Therapeut:in wählen/ }).first().click({ timeout: 180_000 });
      await page.locator('[role="dialog"]').first().getByText(therapist, { exact: true }).first().click({ timeout: 60_000 });
      await page.locator('[data-testid="v2-cell-deadlines"]').first().waitFor({ timeout: 240_000 });
      const board = new TherapistBoardV2Page(page);

      for (const vo of vos) {
        const want = await expectedRows(api, H, vo);
        await board.search(vo);
        await expect.poll(() => page.locator('[data-testid="v2-rail-cell-prescriptionId"]').allTextContents(), { timeout: 60_000 })
          .toEqual([expect.stringContaining(vo)]);
        await board.expandFirstRow();
        await board.openWeitere();
        await page.getByText('Doku öffnen', { exact: true }).last().click({ timeout: 30_000 });
        await page.getByText('Dokumentation (Behandlungsverlauf)').first().waitFor({ timeout: 60_000 });
        await expect.poll(async () => (await readHistory(page)).length, { timeout: 60_000 }).toBe(want.rows.length);
        const got = await readHistory(page);
        console.log(`  ${vo} (${want.blanko ? 'Blanko' : 'regular'}):`);
        got.forEach((r, i) => console.log(`     ${i + 1}. ${r.heilmittel}   | ${r.notes.slice(0, 60)}`));

        // AC1/AC2: the painted Heilmittel cells equal the API-derived ones (a multiset — two sessions
        // on the same day may paint in either order).
        expect([...got.map((r) => r.heilmittel)].sort(), `${vo}: Heilmittel column`)
          .toEqual([...want.rows.map((r) => r.heilmittel)].sort());
        if (!want.blanko) {
          for (const r of got) expect(r.heilmittel, `${vo}: a regular VO shows no minutes`).not.toMatch(/\(\d+ min\)/);
        }
        // AC3: the double-session tag stays in the notes and carries the SAME doubled minutes.
        for (const w of want.rows.filter((r) => r.minutesTag !== null)) {
          const row = got.find((r) => r.heilmittel === w.heilmittel)!;
          expect(row.notes, `${vo}: the first row's tag`).toMatch(new RegExp(`×2 · ${w.minutesTag} Min`, 'i'));
        }
        // AC2 row 4: the doubled minutes sit on the FIRST of the pair — the row carrying minutes is
        // painted directly above its minute-less twin.
        for (const w of want.rows.filter((r) => r.minutesTag !== null)) {
          const first = got.findIndex((r) => r.heilmittel === w.heilmittel);
          const bare = w.heilmittel.replace(/ \(\d+ min\)$/, '');
          expect(got[first + 1]?.heilmittel, `${vo}: the minutes are on the first row of the double pair`).toBe(bare);
        }
        if (want.rows.some((r) => r.minutesTag !== null)) {
          const second = got.filter((r) => !/\(\d+ min\)/.test(r.heilmittel));
          for (const r of second) expect(r.notes, `${vo}: the second row's tag has no minutes`).not.toMatch(/×2 · \d+ Min/i);
        }

        await page.keyboard.press('Escape');
        await page.getByText('Dokumentation (Behandlungsverlauf)').first().waitFor({ state: 'hidden', timeout: 10_000 })
          .catch(async () => { await page.locator('[aria-label="Schließen"], [aria-label="close"]').first().click({ timeout: 5_000 }).catch(() => {}); });
      }
    });
  }
});
