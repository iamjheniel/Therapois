import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { SaveRefreshPage as P, type Screen } from '../../../Pages/superadmin/sa.save-refresh.page';

/**
 * RC 3.15 #3797 — every screen shows the saved values right after a save.
 * e568e9cf2 (the shared MutationCache invalidates the mutated resource) + PR #3946 (merged
 * 2026-10-03 23:39Z), which fixed the PM's one failure, AC1 row 4: a browser reload 0.6–1.5 s
 * after a save showed the OLD value for ~70 s, because the persisted query cache is written on a
 * 3 s throttle and the restored pre-save copy counted as fresh for the 60 s staleTime.
 *
 * MUTATING, on the PM's own fixtures only — facility 275 "FT3797 Dritte Einrichtung", insurer 1089
 * "FT3797 Testkasse…", ICD code 46283 "Z99.97" — each restored through the API in `afterAll`.
 * Creates and deletes (AC1 rows 5/6), AC3 and the tablet (AC4) are the PM's passing rows and are
 * not re-driven: a create cannot be undone on these resources.
 *
 * The RELOAD is the subject, and `mintUiSession`'s token is single-use (#3460), so the tab is
 * signed in with `seedSession()` (#3761), which survives a reload.
 */
const FACILITY: Screen = {
  key: 'facility', listPath: '/ech', apiPath: '/elderly_care_homes', id: 275,
  search: 'FT3797 Dritte', rowAnchor: 'FT3797 Dritte Einrichtung', fieldLabel: 'Einrichtungs ID', apiField: 'echId',
};
const INSURER: Screen = {
  key: 'insurer', listPath: '/insurance-provider', apiPath: '/insurance_providers', id: 1089,
  search: '979700097', rowAnchor: '979700097', fieldLabel: 'Name *', apiField: 'name',
};
const ICD: Screen = {
  key: 'icd', listPath: '/icd-code', apiPath: '/icd_codes', id: 46283,
  search: 'Z99.97', rowAnchor: 'Z99.97', fieldLabel: 'Beschreibung *', apiField: 'description',
};
const OURS = /^QA3797|QA-[A-Z]$/;

test.describe('#3797 every screen shows the saved values right after a save', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: APIRequestContext;
  let page: Page;
  let ui: P;
  const original: Record<string, string> = {};

  test.beforeAll(async ({ browser, playwright }) => {
    test.setTimeout(300_000);
    api = await playwright.request.newContext();
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    ui = new P(api, page);
    await ui.init();
    const fallback: Record<string, string> = {
      facility: 'FT3797W', insurer: 'FT3797 Testkasse geaendert', icd: 'FT3797 Testcode zweite Aenderung',
    };
    for (const s of [FACILITY, INSURER, ICD]) {
      const v = String((await ui.read(s))[s.apiField] ?? '');
      // A run that died mid-way leaves one of OUR values behind — put the known original back.
      if (OURS.test(v)) await ui.patch(s, { [s.apiField]: fallback[s.key] });
      original[s.key] = String((await ui.read(s))[s.apiField]);
    }
    console.log(`  fixtures: ${JSON.stringify(original)}`);
    await ui.seedSession();
  });

  test.afterAll(async () => {
    try {
      for (const s of [FACILITY, INSURER, ICD]) {
        const now = String((await ui.read(s))[s.apiField]);
        if (now !== original[s.key]) {
          const r = await ui.patch(s, { [s.apiField]: original[s.key] });
          console.log(`  restored ${s.key}: ${now} → ${original[s.key]} (${r.status})`);
        }
      }
    } finally {
      await page?.close();
      await api?.dispose();
    }
  });

  test('deployment: #3946 ships, an over-long facility ID is refused (not a 500), and which reads still allow HTTP caching', {
    tag: ['@SuperAdmin', '@SaveRefresh', '@ReadOnly'],
  }, async () => {
    const html = await (await api.get('https://staging.therapios.de/')).text();
    const entry = /\/_expo\/static\/js\/web\/entry-[^"]+\.js/.exec(html)![0];
    const js = await (await api.get(`https://staging.therapios.de${entry}`, { timeout: 120_000 })).text();
    // #3946's new empty-list wording — frontend-only, so the bundle is the probe (#3705).
    expect(js.includes('Keine Einrichtungen gefunden'), 'Facilities list empty state').toBe(true);
    expect(js.includes('Keine Praxen gefunden'), 'Practices list empty state').toBe(true);

    // #3946 also caps the facility ID at 9: a 10-character value used to crash the save with a
    // server error. A refused write — the API value is re-read to show nothing moved.
    const r = await ui.patch(FACILITY, { echId: 'QA3797XXXX' });
    console.log(`  10-char echId → ${r.status} ${r.body.slice(0, 200)}`);
    expect(r.status, 'refused as a validation error, not a 500').toBe(422);
    expect((await ui.read(FACILITY)).echId).toBe(original.facility);

    // Developer Reference step 4: a refetch must not be answered by the browser's HTTP cache.
    for (const p of ['/elderly_care_homes/275', '/icd_codes/46283', '/entities/6', '/users?itemsPerPage=1',
      '/insurance_providers/1089', '/insurance_providers?itemsPerPage=1', '/treatments?itemsPerPage=1']) {
      console.log(`  Cache-Control ${p.padEnd(38)} ${await ui.cacheControl(p)}`);
    }
  });

  test('AC1 rows 1–3 (facility): the earlier search, another search and the reopened form all show the saved ID at once', {
    tag: ['@SuperAdmin', '@SaveRefresh', '@Mutating'],
  }, async () => {
    await ui.openList(FACILITY);
    await ui.search(FACILITY);
    expect(await ui.rowTexts(FACILITY), 'the row shows the current ID').toContain(original.facility);
    await ui.openForm(FACILITY);
    expect(await ui.fieldValue(FACILITY, original.facility)).toBe(original.facility);
    const saved = await ui.save(FACILITY, 'QA3797A');
    expect(saved.status).toBe(200);
    const persistMs = await ui.persistedWithin('QA3797A');
    console.log(`  persisted cache holds the new ID ${persistMs} ms after the PATCH answered`);
    await page.waitForURL((u) => !u.pathname.includes('/edit'), { timeout: 30_000 });

    // Row 1 — the search typed before the save, typed again on the list shown after it.
    await ui.search(FACILITY);
    await expect.poll(() => ui.rowTexts(FACILITY), { timeout: 15_000 }).toContain('QA3797A');
    // Row 2 — any other search.
    await ui.search(FACILITY, 'Dritte Einrichtung');
    await expect.poll(() => ui.rowTexts(FACILITY), { timeout: 15_000 }).toContain('QA3797A');
    // Row 3 — the edit form, reopened.
    await ui.openForm(FACILITY);
    expect(await ui.fieldValue(FACILITY, 'QA3797A'), 'the reopened form').toBe('QA3797A');
    expect((await ui.read(FACILITY)).echId).toBe('QA3797A');
  });

  for (const delay of [300, 1200]) {
    test(`AC1 row 4 (facility, the PM's FAIL): a reload ${delay} ms after the save shows the saved ID`, {
      tag: ['@SuperAdmin', '@SaveRefresh', '@Mutating'],
    }, async () => {
      const value = delay === 300 ? 'QA3797B' : 'QA3797C';
      if (!page.url().includes(`/ech/${FACILITY.id}/edit`)) {
        await ui.openList(FACILITY);
        await ui.search(FACILITY);
        await ui.openForm(FACILITY);
      }
      // Warm the very query the PM saw go stale: the searched list, cached before the save.
      const saved = await ui.save(FACILITY, value);
      expect(saved.status).toBe(200);
      const wait = saved.at + delay - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const reloadedAt = Date.now() - saved.at;
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(`  reloaded ${reloadedAt} ms after the PATCH answered; landed on ${new URL(page.url()).pathname}`);
      if (page.url().includes('/edit')) {
        expect(await ui.fieldValue(FACILITY, value), 'the form after the reload').toBe(value);
        await ui.openList(FACILITY);
      } else {
        await ui.waitForList();
      }
      await ui.search(FACILITY);
      const row = await ui.rowTexts(FACILITY);
      console.log(`  searched list after the reload: ${JSON.stringify(row)}`);
      expect(row, 'the list after the reload shows the saved ID').toContain(value);
      await ui.openForm(FACILITY);
      expect(await ui.fieldValue(FACILITY, value), 'and so does the reopened form').toBe(value);
    });
  }

  for (const s of [ICD]) {
    test(`AC2 (${s.key}): the list, the reopened form and a reload 500 ms after the save show the saved value`, {
      tag: ['@SuperAdmin', '@SaveRefresh', '@Mutating'],
    }, async () => {
      const name = s.key === 'insurer' ? 'Versicherung' : 'ICD-Code';
      const v1 = s.key === 'insurer' ? 'FT3797 Testkasse QA-A' : 'FT3797 Testcode QA-A';
      const v2 = s.key === 'insurer' ? 'FT3797 Testkasse QA-B' : 'FT3797 Testcode QA-B';
      await ui.openList(s);
      await ui.search(s);
      expect(await ui.rowTexts(s), `the ${name} row shows the current value`).toContain(original[s.key]);
      await ui.openForm(s);
      expect(await ui.fieldValue(s, original[s.key])).toBe(original[s.key]);

      // At once, no reload: the same search and the reopened form.
      expect((await ui.save(s, v1)).status).toBe(200);
      await page.waitForURL((u) => !u.pathname.includes('/edit'), { timeout: 30_000 });
      await ui.search(s);
      await expect.poll(() => ui.rowTexts(s), { timeout: 15_000, message: 'the searched list' }).toContain(v1);
      await ui.openForm(s);
      expect(await ui.fieldValue(s, v1), 'the reopened form').toBe(v1);

      // Reload straight after a second save.
      const saved = await ui.save(s, v2);
      expect(saved.status).toBe(200);
      const wait = saved.at + 500 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (page.url().includes('/edit')) {
        expect(await ui.fieldValue(s, v2), 'the form after the reload').toBe(v2);
        await ui.openList(s);
      } else {
        await ui.waitForList();
      }
      await ui.search(s);
      const row = await ui.rowTexts(s);
      console.log(`  ${s.key} searched list after the reload: ${JSON.stringify(row)}`);
      expect(row, 'the list after the reload').toContain(v2);
      await ui.openForm(s);
      expect(await ui.fieldValue(s, v2), 'the reopened form after the reload').toBe(v2);
      expect(String((await ui.read(s))[s.apiField])).toBe(v2);
    });
  }

  test('AC1 rows 1–2 / AC2 (insurer): the searched list shows the saved name at once — no HTTP-cache replay (PR #3990)', {
    tag: ['@SuperAdmin', '@SaveRefresh', '@Mutating'],
  }, async () => {
    // HISTORY: this was a FINDING test. `/insurance_providers` sent `Cache-Control: max-age=60`
    // (from the resource's own `cacheHeaders`, a second source the CacheControlListener fix did not
    // cover), so Chrome answered the post-save list refetch FROM ITS DISK CACHE with the pre-save
    // body and the list showed the old name for up to 60 s (new name first painted at +66 s).
    // PR #3990 set `max_age => 0` on the editable resources (`/doctors` too), keeping the response
    // revalidatable (a 304 still saves the body), so the refetch now reaches the server.
    expect(await ui.cacheControl('/insurance_providers?itemsPerPage=1'), 'the list is no longer fresh for 60 s').toMatch(/max-age=0|no-cache/);
    expect(await ui.cacheControl('/doctors?itemsPerPage=1'), '/doctors had the same latent defect').toMatch(/max-age=0|no-cache/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const urls = new Map<string, string>();
    const listHits: { fromDiskCache: boolean; status: number }[] = [];
    let saved = false;
    cdp.on('Network.requestWillBeSent', (e: any) => { urls.set(e.requestId, `${e.request.method} ${e.request.url}`); });
    cdp.on('Network.responseReceived', (e: any) => {
      const u = urls.get(e.requestId) ?? '';
      if (saved && /^GET .*\/insurance_providers\?/.test(u)) listHits.push({ fromDiskCache: !!e.response.fromDiskCache, status: e.response.status });
    });
    const v = 'FT3797 Testkasse QA-C';
    await ui.openList(INSURER);
    await ui.search(INSURER);
    await ui.openForm(INSURER);
    expect((await ui.save(INSURER, v)).status).toBe(200);
    saved = true;
    expect((await ui.read(INSURER)).name, 'the save landed').toBe(v);
    await page.waitForURL((u) => !u.pathname.includes('/edit'), { timeout: 30_000 });
    // Typed again straight away — this is the request that used to come from the disk cache.
    await ui.search(INSURER);
    await expect.poll(() => ui.rowTexts(INSURER), { timeout: 15_000, message: 'the searched list shows the saved name' }).toContain(v);
    console.log(`  list GETs after the save: ${listHits.length}, from disk cache: ${listHits.filter((h) => h.fromDiskCache).length}, statuses ${JSON.stringify(listHits.map((h) => h.status))}`);
    expect(listHits.length, 'the list was refetched').toBeGreaterThan(0);
    expect(listHits.filter((h) => h.fromDiskCache), 'no post-save list read is replayed from the HTTP cache').toEqual([]);
    await ui.openForm(INSURER);
    expect(await ui.fieldValue(INSURER, v), 'the reopened form').toBe(v);
  });
});
