import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import { SaveRefreshPage } from '../../../Pages/superadmin/sa.save-refresh.page';

/**
 * RC 3.15 #3964 (fix `4780ad9ff`, both `PeopleFacilitiesSection`s): opening an existing VO must no
 * longer swap its Gesellschaft to the Hauptbehandler's CURRENT one. The form opened empty, then
 * loaded the VO and its therapist — which looked like a therapist change, so the "therapist changed
 * → set their Gesellschaft" rule fired and any later save stored the swap (117 VOs on production).
 * Now, in edit mode, the Gesellschaft follows the therapist only after a real pick.
 *
 * READ-ONLY, and the reason is the method: the bug lived in the FORM STATE the save sends, so AC1 is
 * observed on the field itself across both forms (v2 `/vo-management/<id>/edit`, v1
 * `/v1/vo-management/<id>/edit`) on VOs whose Gesellschaft differs from their therapist's — the only
 * population the bug can touch — watched for 8 s after load, when the swap used to happen. AC2 picks
 * another Hauptbehandler, checks the field follows, and leaves with "Abbrechen"; the VO is re-read
 * through the API afterwards to prove nothing was stored. The PM ran the real saves (12 rows).
 */
const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';
const FORMS = [{ name: 'v2', path: (id: number) => `/vo-management/${id}/edit` }, { name: 'v1', path: (id: number) => `/v1/vo-management/${id}/edit` }];

type Fixture = { vo: string; id: number; voEntity: string; therapist: string; therapistEntity: string };

async function fieldValue(page: Page, label: 'Gesellschaft' | 'Hauptbehandler'): Promise<string | null> {
  return page.evaluate((label) => {
    const own = (e: Element) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
    const els = [...document.querySelectorAll('#root *')].filter((e) => e.getBoundingClientRect().height > 0);
    const lab = els.find((e) => own(e).replace(/\s*\*$/, '') === label);
    if (!lab) return null;
    const b = lab.getBoundingClientRect();
    const v = els.find((e) => { const r = e.getBoundingClientRect(); return r.top > b.top && r.top < b.top + 70 && Math.abs(r.left - b.left) < 30 && own(e); });
    return v ? own(v) : null;
  }, label);
}

test.describe('#3964 opening an existing VO keeps its Gesellschaft', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600_000);
  let api: APIRequestContext;
  let H: Record<string, string>;
  let fixtures: Fixture[] = [];
  let entityName: Map<number, string>;
  let users: any[] = [];
  const get = async (p: string) => (await api.get(`${API}${p}`, { headers: H, timeout: 120_000 })).json();
  const eid = (x: any) => Number(String(x?.['@id'] ?? x?.id ?? x ?? '').match(/(\d+)$/)?.[1]) || null;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(300_000);
    api = await playwright.request.newContext();
    const r = await api.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
    });
    H = { Authorization: `Bearer ${(await r.json()).token}`, Accept: 'application/ld+json' };
    entityName = new Map((await get('/entities?itemsPerPage=50')).member.map((e: any) => [e.id, e.name]));
    for (let p = 1; ; p++) {
      const b = await get(`/users?itemsPerPage=100&page=${p}`);
      users.push(...b.member);
      if (users.length >= b.totalItems || !b.member.length) break;
    }
    const byId = new Map(users.map((u) => [u.id, u]));
    // The bug's population: VO Gesellschaft ≠ therapist's current Gesellschaft. One fixture per
    // (VO company, therapist company) pair, so the sample spans the combinations staging has.
    const seen = new Set<string>();
    for (const st of ['Aktiv', 'Fertig Behandelt']) {
      for (const v of (await get(`/prescriptions?itemsPerPage=100&treatmentStatus=${encodeURIComponent(st)}&order[id]=desc`)).member) {
        const u = byId.get(v.therapist?.id);
        const ve = eid(v.entity), ue = eid(u?.entity);
        if (!ve || !ue || ve === ue || seen.has(`${ve}/${ue}`)) continue;
        seen.add(`${ve}/${ue}`);
        fixtures.push({ vo: v.prescriptionId, id: v.id, voEntity: entityName.get(ve)!, therapist: u.fullName, therapistEntity: entityName.get(ue)! });
      }
    }
    console.log(`  fixtures: ${fixtures.map((f) => `${f.vo} [${f.voEntity} vs ${f.therapist}: ${f.therapistEntity}]`).join(' | ')}`);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('AC1 — opening the form on both v1 and v2 keeps the VO\'s own Gesellschaft (never the therapist\'s)', {
    tag: ['@SuperAdmin', '@VoKeepsGesellschaft', '@ReadOnly'],
  }, async ({ page }) => {
    expect(fixtures.length, 'staging has VOs the bug could touch').toBeGreaterThan(1);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await new SaveRefreshPage(api, page).seedSession();
    for (const f of fixtures.slice(0, 5)) {
      for (const form of FORMS) {
        await page.goto(`${WEB}${form.path(f.id)}`, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => fieldValue(page, 'Hauptbehandler'), { timeout: 120_000 }).toBe(f.therapist);
        // Watch the field through the window in which the swap used to happen (therapist load → rule).
        const seen = new Set<string>();
        for (let t = 0; t < 32; t++) {
          seen.add(String(await fieldValue(page, 'Gesellschaft')));
          await page.waitForTimeout(250);
        }
        console.log(`  ${form.name} ${f.vo}: Gesellschaft read ${JSON.stringify([...seen])}`);
        expect([...seen], `${form.name} ${f.vo}: only the VO's own Gesellschaft, for 8 s`).toEqual([f.voEntity]);
      }
    }
  });

  test('AC2 — picking another Hauptbehandler still fills that therapist\'s Gesellschaft (Abbrechen, nothing stored)', {
    tag: ['@SuperAdmin', '@VoKeepsGesellschaft', '@ReadOnly'],
  }, async ({ page }) => {
    const f = fixtures[0];
    const before = await get(`/prescriptions/${f.id}`);
    // A therapist of a THIRD Gesellschaft, so the fill is distinguishable from both existing values.
    // NB: the therapist must HAVE a Gesellschaft (eid null would pass a bare `<= 7`, since null <= 7
    // is true in JS — a first run picked such a user and the field correctly emptied).
    const pick = users.find((u) => {
      const e = eid(u.entity);
      return (u.roles ?? []).includes('ROLE_THERAPIST') && u.active !== false && e !== null && e >= 1 && e <= 7
        && ![f.voEntity, f.therapistEntity].includes(entityName.get(e) ?? '');
    });
    expect(pick, 'a therapist of another Gesellschaft').toBeTruthy();
    const pickEntity = entityName.get(eid(pick.entity)!)!;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await new SaveRefreshPage(api, page).seedSession();
    await page.goto(`${WEB}${FORMS[0].path(f.id)}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => fieldValue(page, 'Hauptbehandler'), { timeout: 120_000 }).toBe(f.therapist);
    await page.getByText(f.therapist, { exact: true }).first().click({ timeout: 30_000 });
    const search = page.locator('[role="dialog"] input, input[placeholder*="uchen"]').last();
    await search.fill(pick.fullName.split(' ')[0], { timeout: 30_000 });
    await page.getByText(pick.fullName, { exact: true }).last().click({ timeout: 30_000 });
    await expect.poll(() => fieldValue(page, 'Hauptbehandler'), { timeout: 15_000 }).toBe(pick.fullName);
    await expect.poll(() => fieldValue(page, 'Gesellschaft'), { timeout: 15_000, message: 'the pick fills the new therapist\'s Gesellschaft' }).toBe(pickEntity);
    console.log(`  ${f.vo}: picked ${pick.fullName} → Gesellschaft ${pickEntity}`);
    await page.getByText('Abbrechen', { exact: true }).last().click({ timeout: 30_000 });
    for (const confirm of ['Verwerfen', 'Ja', 'Bestätigen']) {
      const b = page.getByText(confirm, { exact: true });
      if (await b.count()) { await b.last().click({ timeout: 5_000 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(3_000);
    const after = await get(`/prescriptions/${f.id}`);
    expect([eid(after.entity), after.therapist?.id], 'Abbrechen stored nothing').toEqual([eid(before.entity), before.therapist?.id]);
  });
});
