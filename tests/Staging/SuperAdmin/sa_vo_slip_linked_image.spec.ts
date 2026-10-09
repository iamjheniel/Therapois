import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import { SaveRefreshPage } from '../../../Pages/superadmin/sa.save-refresh.page';

/**
 * RC 3.15 #3868 — the billing validation page's "VO Slip" shows the front image LINKED to the VO
 * (the one the VO form shows as "Vorderseite Upload-ID"), falling back to the old search by the VO
 * number typed at upload only when no image is linked. Fix `6a539ccff` (VOSlip.tsx).
 *
 * READ-ONLY: pages are opened and read; nothing is linked, uploaded or validated. The oracle is the
 * API — the linked image is `prescriptionImages[0].uploadId` on `GET /prescriptions/{id}` (the same
 * pick the VO form uses), the fallback `GET /prescription_images?search[prescriptionNumber]=<VO>`.
 * The slip is read off the screen as its "Upload ID" row plus the image title
 * "Verordnungsbild - <id>", and the image itself is required to have LOADED (naturalWidth > 0).
 *
 * Trap (PM observation): on a re-open the slip can paint the PREVIOUS image for ~1 s before the
 * fresh VO arrives, so the read is polled to a stable value, never taken once.
 */
const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

type Expect = { vo: string; id: number; linked: string | null; byNumber: string | null; want: string | null };

async function readSlip(page: Page): Promise<{ uploadId: string | null; title: string | null; imageLoaded: boolean; controls: string[] }> {
  return page.evaluate(() => {
    const own = (e: Element) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
    const els = [...document.querySelectorAll('#root *')].filter((e) => e.getBoundingClientRect().height > 0 && own(e));
    const slip = els.find((e) => own(e) === 'VO Slip')?.getBoundingClientRect();
    if (!slip) return { uploadId: null, title: null, imageLoaded: false, controls: [] };
    const inSlip = els.filter((e) => { const b = e.getBoundingClientRect(); return b.left >= slip.left - 20 && b.top >= slip.top - 5; });
    const label = inSlip.find((e) => own(e) === 'Upload ID');
    let uploadId: string | null = null;
    if (label) {
      const y = label.getBoundingClientRect().top;
      uploadId = inSlip.filter((e) => Math.abs(e.getBoundingClientRect().top - y) < 8 && e !== label).map(own)[0] ?? null;
    }
    const title = inSlip.map(own).find((t) => t.startsWith('Verordnungsbild - ')) ?? null;
    // A JPEG upload paints as an <img>; a PDF upload as an <iframe> on the same S3 object — accept
    // either, but require it to be actually rendered (a loaded image, or a sized frame).
    const img = [...document.querySelectorAll('img')].find((i) => /prescription_i/.test(i.src) && i.getBoundingClientRect().width > 100) as HTMLImageElement | undefined;
    const frame = [...document.querySelectorAll('iframe')].find((f) => /prescription_i/.test(f.src) && f.getBoundingClientRect().width > 100 && f.getBoundingClientRect().height > 100);
    const controls = ['Vorderseite', 'Rückseite', 'VO Nr oder Upload ID suchen...', 'Bild hochladen'].filter((c) => els.some((e) => own(e) === c));
    return { uploadId, title, imageLoaded: (!!img && img.complete && img.naturalWidth > 0) || !!frame, controls };
  });
}

test.describe('#3868 the VO Slip shows the image linked to the VO', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(400_000);
  let api: APIRequestContext;
  let H: Record<string, string>;
  const get = async (p: string) => (await api.get(`${API}${p}`, { headers: H, timeout: 120_000 })).json();

  async function expected(vo: string): Promise<Expect> {
    const v = (await get(`/prescriptions?exact[prescriptionId]=${vo}`)).member[0];
    const item = await get(`/prescriptions/${v.id}`);
    const linked = item.prescriptionImages?.[0]?.uploadId ?? null;
    const s = await get(`/prescription_images?itemsPerPage=5&search[prescriptionNumber]=${encodeURIComponent(vo)}`);
    const byNumber = s.member?.[0]?.uploadId ?? null;
    return { vo, id: v.id, linked, byNumber, want: linked ?? byNumber };
  }

  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext();
    const r = await api.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
    });
    H = { Authorization: `Bearer ${(await r.json()).token}`, Accept: 'application/ld+json' };
  });
  test.afterAll(async () => { await api?.dispose(); });

  /**
   * Each fixture is a fresh `page.goto`, and `mintUiSession`'s refresh token is single-use (#3460):
   * the second navigation lands on the login form. #3761's seed installs the token ONCE per token,
   * so the app's own rotated replacement survives every later navigation.
   */
  async function signIn(page: Page) {
    await new SaveRefreshPage(api, page).seedSession();
  }

  async function checkSlip(page: Page, e: Expect, label: string) {
    await page.goto(`${WEB}/billing/validate/${e.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('VO Slip').first().waitFor({ timeout: 180_000 });
    // Poll to a STABLE reading that matches, so a briefly painted previous image cannot pass or fail it.
    let last: Awaited<ReturnType<typeof readSlip>> | null = null;
    await expect.poll(async () => {
      const r = await readSlip(page);
      const ok = e.want ? r.uploadId === e.want && r.imageLoaded : r.uploadId === null && r.controls.includes('Bild hochladen');
      const stable = !!last && JSON.stringify(last) === JSON.stringify(r);
      last = r;
      return ok && stable;
    }, { timeout: 60_000, intervals: [1_000] }).toBe(true).catch((err) => {
      console.log(`  ${label} ${e.vo}: linked ${e.linked ?? '—'}, by number ${e.byNumber ?? '—'} → slip READ ${JSON.stringify(last)}`);
      throw err;
    });
    console.log(`  ${label} ${e.vo}: linked ${e.linked ?? '—'}, by number ${e.byNumber ?? '—'} → slip ${last!.uploadId ?? 'empty'} | ${last!.title ?? ''} | image loaded ${last!.imageLoaded}`);
    if (e.want) expect(last!.title, `${e.vo}: the image title names the same upload`).toBe(`Verordnungsbild - ${e.want}`);
    return last!;
  }

  test('AC1 + AC5: a linked image shows without search — 1344-5 and 6174-5, whose number search finds nothing', {
    tag: ['@SuperAdmin', '@VoSlip', '@ReadOnly'],
  }, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await signIn(page);
    for (const [vo, upload] of [['1344-5', '186-274'], ['6174-5', '98-19']] as const) {
      const e = await expected(vo);
      expect([e.linked, e.byNumber], `${vo}: linked, and the number search finds nothing (the bug's case)`).toEqual([upload, null]);
      await checkSlip(page, e, 'AC1');
    }
  });

  test('AC2 + AC3 + AC5: number fallback, empty slip, the linked image winning, and the unchanged match', {
    tag: ['@SuperAdmin', '@VoSlip', '@ReadOnly'],
  }, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await signIn(page);
    const fallback = await expected('2337-14');
    expect([fallback.linked, fallback.byNumber]).toEqual([null, '251-46']);
    await checkSlip(page, fallback, 'AC2 fallback');
    const empty = await expected('100002-1');
    expect([empty.linked, empty.byNumber]).toEqual([null, null]);
    await checkSlip(page, empty, 'AC2 empty');
    const wins = await expected('100009-1');
    expect(wins.linked, 'linked and a DIFFERENT image under its number').not.toBe(wins.byNumber);
    expect(wins.byNumber).not.toBeNull();
    await checkSlip(page, wins, 'AC3 linked wins');
    await checkSlip(page, await expected('2752-20'), 'AC5 unchanged');
  });

  test('AC1 at scale: VOs whose linked image was uploaded under ANOTHER number (the bug\'s population) all show it', {
    tag: ['@SuperAdmin', '@VoSlip', '@ReadOnly'],
  }, async ({ page }) => {
    // Find linked images whose typed number is not their VO's number — the slip could never find
    // these before the fix. Recent pages of the image table, a few fixtures, read-only.
    const found: Expect[] = [];
    const total = (await get('/prescription_images?itemsPerPage=1')).totalItems;
    for (let p = Math.max(1, Math.floor(total / 30) - 1); found.length < 4 && p > 0; p -= 7) {
      const page30 = (await get(`/prescription_images?itemsPerPage=30&page=${p}`)).member ?? [];
      for (const img of page30) {
        const voNo = img.prescription?.prescriptionId;
        if (!voNo || img.prescriptionNumber === voNo || found.some((f) => f.vo === voNo)) continue;
        const e = await expected(voNo);
        if (e.linked && e.linked !== e.byNumber) found.push(e);
        if (found.length >= 4) break;
      }
    }
    console.log(`  discovered: ${found.map((f) => `${f.vo}→${f.linked} (number search: ${f.byNumber ?? 'none'})`).join(', ')}`);
    expect(found.length, 'the population exists on staging').toBeGreaterThan(0);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await signIn(page);
    for (const e of found) await checkSlip(page, e, 'AC1 sample');
  });

  test('AC4: search field, "Bild hochladen" and the Rückseite side are still there', {
    tag: ['@SuperAdmin', '@VoSlip', '@ReadOnly'],
  }, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await signIn(page);
    const e = await expected('100009-1');
    const r = await checkSlip(page, e, 'AC4');
    expect(r.controls).toEqual(expect.arrayContaining(['Vorderseite', 'Rückseite', 'VO Nr oder Upload ID suchen...']));
    // "Bild hochladen" is offered on the empty slip (checked in AC2); here, the back side switch:
    await page.getByText('Rückseite', { exact: true }).first().click({ timeout: 30_000 });
    await expect(page.getByText(/^Upload suchen/).first(), 'the back side shows its own search').toBeVisible({ timeout: 15_000 });
    await page.getByText('Vorderseite', { exact: true }).first().click({ timeout: 30_000 });
    await expect.poll(async () => (await readSlip(page)).uploadId, { timeout: 15_000 }).toBe(e.want);
  });
});
