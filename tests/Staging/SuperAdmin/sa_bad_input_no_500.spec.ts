import { test, expect, type APIRequestContext } from '../../fixtures/session';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 #3913 — bad or edge-case input must answer 4xx, never 500 (Sentry P3 triage of
 * 2026-10-01). Fix build `71b6ca11c` on release/3.15.0.
 *
 * Effectively READ-ONLY: every write sent here is one the fix must REFUSE, and a refused request
 * writes nothing (the #3549/#3899 shape — a refusal that turned into a write IS the defect). Each
 * write-shaped test re-reads its target afterwards:
 *   - AC2's VO creates are sent with NO patient/therapist/etc., so even a broken build could not
 *     persist them — only the nested-treatment violation is under test (Symfony collects every
 *     violation in one pass, so it is named alongside the missing top-level fields);
 *   - AC4's termination is sent with an unknown status to the PM's VO 100900-1, which stays Aktiv;
 *   - AC6's duplicate length is PATCHed onto practice line 47 and refused, so it keeps its 35 min.
 * AC5 is read from the PM's 5 Oct footprint (the queued offer text voided on assign), AC7 is driven
 * on screen with the user request forced to 500 in the browser only, AC8 is read from the source.
 */
const API = 'https://api.staging.therapios.de';
const VO_TERMINATE = { id: 35715, number: '100900-1' };

test.describe('#3913 bad or edge-case input answers 4xx, never 500', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
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

  const get = async (path: string) => { const r = await api.get(`${API}${path}`, { headers: H, timeout: 120_000 }); return { status: r.status(), body: await r.text() }; };
  const send = async (method: string, path: string, data?: string, ct = 'application/json') => {
    const r = await api.fetch(`${API}${path}`, { method, headers: { ...H, ...(data !== undefined ? { 'Content-Type': ct } : {}) }, data, timeout: 120_000 });
    return { status: r.status(), body: await r.text() };
  };
  const json = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };

  test('AC1: a list of VO numbers returns the matching VOs; a nested or keyed list is 400', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    const two = json((await get('/prescriptions?itemsPerPage=5&exact[prescriptionId][]=100900-1&exact[prescriptionId][]=100120-1')).body);
    expect(two.member.map((v: any) => v.prescriptionId).sort()).toEqual(['100120-1', '100900-1']);
    const withUnknown = json((await get('/prescriptions?itemsPerPage=5&exact[prescriptionId][]=100900-1&exact[prescriptionId][]=9999999-9')).body);
    expect(withUnknown.totalItems, 'an unknown number is simply not matched').toBe(1);
    for (const q of ['exact[prescriptionId][][]=100900-1', 'exact[prescriptionId][x]=100900-1', 'exact[prescriptionId][a][b]=100900-1']) {
      const r = await get(`/prescriptions?${q}`);
      expect(r.status, q).toBe(400);
      expect(json(r.body).detail).toBe('exact[prescriptionId] must be a value or a list of values.');
    }
  });

  test('AC2: a treatment line without its Heilmittel is 422 naming the line; no VO is created; a missing status saves as N/A', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    const total = async () => json((await get('/prescriptions?itemsPerPage=1')).body).totalItems;
    const before = await total();
    for (const [label, lines, idx] of [
      ['a line with counts but no treatment', [{ numberOfTreatments: '6', frequencyPerWeek: '2' }], 0],
      ['an empty line', [{}], 0],
      ['a valid line, then one without treatment', [{ treatment: '/treatments/71', numberOfTreatments: '6' }, { numberOfTreatments: '6' }], 1],
    ] as const) {
      const r = await send('POST', '/prescriptions', JSON.stringify({ prescribedTreatments: lines }), 'application/ld+json');
      const v = (json(r.body).violations ?? []).map((x: any) => `${x.propertyPath}: ${x.message}`);
      console.log(`  ${label}: ${r.status} ${v.filter((x: string) => x.startsWith('prescribedTreatments')).join(' | ')}`);
      expect(r.status, label).toBe(422);
      expect(v, `${label} names the nested field`).toContain(`prescribedTreatments[${idx}].treatment: This value should not be null.`);
    }
    expect(await total(), 'no VO was created by the refused requests').toBe(before);
    // The "no status → N/A" half needs a real create; the PM's controls 100910-12/-13 are its record.
    const saved = json((await get('/prescriptions?exact[prescriptionId][]=100910-12&exact[prescriptionId][]=100910-13')).body).member;
    for (const v of saved) {
      expect((v.prescribedTreatments ?? []).map((t: any) => t.status), `${v.prescriptionId} was created with no status`).toEqual(['N/A']);
    }
  });

  test('AC3: /preview with an empty or malformed body is 400 and it accepts POST only', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    for (const body of ['', '{bad', 'null', '[]', '{}', '123', '{"template":"order"}', '{"template":"order","data":"x"}']) {
      expect((await send('POST', '/preview', body)).status, `body ${JSON.stringify(body)}`).toBe(400);
    }
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) expect((await send(m, '/preview')).status, m).toBe(405);
  });

  test('AC4: unknown statuses and invalid issue dates are 400 — Document Center, termination, parent/child VO lists', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    for (const type of ['hv', 'va', 'ib', 'tb', 'ze']) {
      expect((await get(`/document_center/documents?type=${type}&status=zzzBogus`)).status, `${type} status=zzzBogus`).toBe(400);
      expect((await get(`/document_center/documents?type=${type}&status[]=a`)).status, `${type} status[]`).toBe(400);
      expect((await get(`/document_center/documents?type=${type}&search[]=a`)).status, `${type} search[]`).toBe(400);
    }
    expect((await get('/document_center/documents?type=hv&status=signed&itemsPerPage=1')).status, 'a valid status still works').toBe(200);
    for (const p of ['parent-vo', 'parent-vo-candidates', 'child-vo-candidates']) {
      for (const d of ['notadate', '2026-13-45']) expect((await get(`/prescriptions/${p}?patient=9517&issueDate=${d}`)).status, `${p} ${d}`).toBe(400);
      expect((await get(`/prescriptions/${p}?patient=9517&issueDate=2026-09-01`)).status, `${p} valid date`).toBe(200);
    }
    for (const field of ['treatmentStatus', 'followupStatus']) {
      const r = await send('PATCH', `/prescriptions/${VO_TERMINATE.id}/terminate`,
        JSON.stringify({ immediate: true, reasons: ['x'], [field]: 'bogus' }), 'application/merge-patch+json');
      expect(r.status, `terminate with an unknown ${field}`).toBe(400);
    }
    const vo = json((await get(`/prescriptions/${VO_TERMINATE.id}`)).body);
    expect([vo.prescriptionId, vo.treatmentStatus], 'the VO was not terminated').toEqual([VO_TERMINATE.number, 'Aktiv']);
  });

  test('AC5 (footprint): assigning a freed slot to an already-texted patient reused the offer and voided its queued text', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    // The PM's 5 Oct run on Praxis practice PFT: offer text 195 queued by "Einzeln anbieten",
    // then "Zuweisen" on the same patient. Pre-fix the assign inserted a second offer and crashed.
    const t = json((await get('/text_messages/195')).body);
    console.log(`  text 195: ${t.template} ${t.status} ${t.errorCode} at ${t.statusChangedAt}`);
    expect([t.template, t.status, t.errorCode]).toEqual(['freed_slot_offer', 'failed', 'subject_gone']);
  });

  test('AC6: a duplicate Praxis treatment length is 422 with a message, and nothing is saved', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    const line1 = json((await get('/practice_treatments/1')).body);
    const before = json((await get('/practice_treatments/47')).body);
    expect(before.treatment, 'line 47 is the same Heilmittel as line 1').toBe(line1.treatment);
    const r = await send('PATCH', '/practice_treatments/47',
      JSON.stringify({ calendarMinutes: line1.calendarMinutes, privatePosition: line1.privatePosition }), 'application/merge-patch+json');
    expect(r.status).toBe(422);
    expect(json(r.body).violations?.[0]?.message).toBe('This practice already offers this treatment with this length.');
    const after = json((await get('/practice_treatments/47')).body);
    expect([after.calendarMinutes, after.privatePosition]).toEqual([before.calendarMinutes, before.privatePosition]);
  });

  test('AC7: when the user fails to load, the Team form shows the error once and goes back once (no render loop)', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async ({ page }) => {
    // The Aktion column sits past 1600 px inside a horizontally scrolling table; at 1600 the pencil is
    // off-screen and a click lands on nothing.
    await page.setViewportSize({ width: 2200, height: 1000 });
    const loopErrors: string[] = [];
    page.on('console', (m) => { if (/Maximum update depth/.test(m.text())) loopErrors.push(m.text()); });
    let failed = 0;
    await page.route(/\/users\/2(\?|$)/, (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      failed++;
      return r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"QA forced failure"}' });
    });
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
    await page.goto('https://staging.therapios.de/team', { waitUntil: 'domcontentloaded' });
    const row = page.getByText(/^Admin Updated/).first();
    await row.waitFor({ timeout: 120_000 });
    // The pencil is the row's rightmost focusable element; the form opens on the same route, so
    // it is detected by its title ("Edit User" / "Nutzer bearbeiten"), not by the URL.
    const pt = await page.evaluate(() => {
      const leaf = [...document.querySelectorAll('#root *')].find((e) => {
        const b = e.getBoundingClientRect();
        return e.children.length === 0 && b.height > 0 && /^Admin Updated/.test((e.textContent ?? '').trim());
      })!;
      const r = leaf.getBoundingClientRect();
      const c = [...document.querySelectorAll('#root [tabindex="0"]')].map((e) => e.getBoundingClientRect())
        .filter((b) => b.height > 0 && b.width < 80 && Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) < 20)
        .sort((a, b) => b.left - a.left)[0];
      return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
    });
    await page.mouse.click(pt.x, pt.y);
    const toast = page.getByText('Failed to load user data!');
    const formTitle = page.getByText(/^(Edit User|Nutzer bearbeiten)$/);
    let appearances = 0, wasVisible = false, maxAtOnce = 0, formOpenings = 0, formShown = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const n = await toast.count();
      const vis = n > 0 && await toast.first().isVisible().catch(() => false);
      if (vis && !wasVisible) appearances++;
      wasVisible = vis; maxAtOnce = Math.max(maxAtOnce, n);
      const f = (await formTitle.count()) > 0 && await formTitle.first().isVisible().catch(() => false);
      if (f && !formShown) formOpenings++;
      formShown = f;
      await page.waitForTimeout(200);
    }
    const sawForm = formOpenings > 0;
    const backToList = sawForm && !formShown ? 1 : 0;
    console.log(`  forced 500s: ${failed}; message appearances ${appearances} (max ${maxAtOnce} at once); form opened ${formOpenings}x, back to the list ${backToList}x; "Maximum update depth" errors ${loopErrors.length}`);
    expect(failed, 'the user request was actually failed').toBeGreaterThan(0);
    expect(appearances, 'the error shows once').toBe(1);
    expect(maxAtOnce).toBeLessThanOrEqual(1);
    expect(formOpenings, 'the form opened once (it does not keep re-mounting)').toBe(1);
    expect(backToList, 'and the app went back to the list').toBe(1);
    await expect(page.getByText('Benutzer verwalten').first(), 'ending on the Team list').toBeVisible();
    expect(loopErrors, 'no render loop').toEqual([]);
  });

  test('AC8: the "opening a freed slot failed" log carries appointment id, slot id, origin and send time (allow-listed)', {
    tag: ['@SuperAdmin', '@BadInput', '@ReadOnly'],
  }, async () => {
    // Developer log content — no client surface; the failure cannot be triggered on staging.
    // Read from the shipped source (needs an authenticated `gh`; skip rather than fail without it).
    const { execSync } = await import('child_process');
    let opener = '', phi = '';
    try {
      const read = (f: string) => execSync(`gh api "repos/therapios/monorepo/contents/${f}?ref=release/3.15.0" --jq .content | base64 -d`, { encoding: 'utf8' });
      opener = read('api/src/Service/Praxis/FreedSlotOpener.php');
      phi = read('api/src/Regex/PhiPatterns.php');
    } catch { test.skip(true, 'no authenticated gh to read the source'); }
    const call = /'Praxis: opening a freed slot failed',\s*\[([\s\S]*?)\]\);/.exec(opener)?.[1] ?? '';
    for (const k of ['appointment_id', 'freed_slot_id', 'origin', 'send_at']) {
      expect(call, `the log line carries ${k}`).toContain(`'${k}'`);
      expect(phi, `${k} is on the PHI allow-list, so the log filter keeps it`).toContain(`'${k}'`);
    }
  });
});
