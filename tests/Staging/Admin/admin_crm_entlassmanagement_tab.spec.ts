import { test, expect } from '../../fixtures/crm-serial';
import { request as pwRequest, type APIRequestContext } from '../../fixtures/session';
import { CrmEntlassmanagementPage as C, type Vo } from '../../../Pages/crm/crm.entlassmanagement.page';

/**
 * RC 3.15 — #3884 (the CRM "Entlassmanagement" tab) and #3885 (discharge VOs leave "Heute
 * bestellen" and the nightly run), shipped together in PR #3893 (merged into `release/3.15.0`
 * 2026-09-30). They ship together by necessity: #3885 alone would take discharge VOs out of the
 * ordering surfaces with nowhere to go.
 *
 * **Read-only** — every request is a GET; the CRM start page is loaded and read. Nothing orders,
 * postpones or changes a status, because each of those writes to a real VO.
 *
 * **The CRM's own requests are the contract**, so the start page is loaded once and they are
 * captured (#3471): #3885 AC1 is \"these surfaces exclude discharge VOs\" and AC7 is \"those ones do
 * not\", which is exactly the presence or absence of one parameter on each request. Asserting a
 * rebuilt query instead would test the ticket's prose rather than the screen.
 *
 * Imports `test` from `tests/fixtures/crm-serial` — the CRM group's cross-file lock.
 */

let api: APIRequestContext;
let apiPage: C;
let tabVos: Vo[];

test.describe('#3884 + #3885 the Entlassmanagement tab and the ordering surfaces', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    api = await pwRequest.newContext();
    apiPage = new C(api);
    await apiPage.init();
    tabVos = await apiPage.tabVos();
    console.log(`  the tab's population: ${tabVos.length} VOs — ` +
      JSON.stringify(tabVos.map((v) => v.prescriptionId)));
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: both new filters answer, and each is opt-in',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async () => {
      const all = await apiPage.total('/prescriptions?itemsPerPage=1');
      const bogus = await apiPage.total('/prescriptions?itemsPerPage=1&zzzNotAFilter=true');
      const tab = await apiPage.total(`/prescriptions?itemsPerPage=1&${C.TAB_FILTER}`);
      const excl = await apiPage.total(`/prescriptions?itemsPerPage=1&${C.EXCLUDE}`);
      const exclFalse = await apiPage.total('/prescriptions?itemsPerPage=1&excludeDischargeVos=false');
      console.log(`  all ${all} | unknown key ${bogus} | dischargeOrdering=true ${tab} | excludeDischargeVos=true ${excl} | =false ${exclFalse}`);
      // An unregistered filter is accepted and IGNORED (#3449), so "the filter exists" means it
      // narrows against that control — never that it answered 200.
      expect(bogus, 'the control confirms an unknown key is ignored').toBe(all);
      expect(tab, 'dischargeOrdering narrows').toBeLessThan(all);
      expect(excl, 'excludeDischargeVos narrows').toBeLessThan(all);
      // Both are opt-in: `false` is a no-op, which is WHY the `true` form has to be the probe.
      expect(exclFalse, 'excludeDischargeVos=false is a no-op, like the unknown key').toBe(all);
      console.log(`  → ${all - excl} discharge VOs exist; ${tab} of them are open for ordering`);
      expect(all - excl, 'staging has discharge VOs at all').toBeGreaterThan(0);
    },
  );

  test(
    '#3884 AC3: every listed VO satisfies the six conditions, and each condition excludes',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async () => {
      expect(tabVos.length, 'the tab lists something to check').toBeGreaterThan(0);
      for (const v of tabVos) {
        const r = C.satisfiesListingRule(v);
        console.log(`  ${String(v.prescriptionId).padEnd(9)} ${String(v.treatmentStatus).padEnd(12)}` +
          ` followup=${JSON.stringify(v.followupStatus ?? null)} ordering=${JSON.stringify(v.orderingStatus)}` +
          ` discharge=${v.isDischargeManagement}`);
        expect(r.why, `${v.prescriptionId} satisfies the listing rule`).toEqual([]);
      }

      // Each condition is then shown to EXCLUDE, by composing the tab filter with a filter that
      // selects the forbidden side — a rule that merely happens to hold on four rows is not a rule.
      const base = await apiPage.total(`/prescriptions?itemsPerPage=1&${C.TAB_FILTER}`);
      // Each probe is paired with the SAME query minus the tab filter: a zero only means the rule
      // excluded it if that side is populated. `followupStatus=ordered` is NOT usable for this —
      // it has 0 rows book-wide on staging today, so its zero would be vacuous (it failed here).
      for (const [label, q] of [
        ['followupStatus=received', 'followupStatus=received'],
        ['followupStatus=tracking', 'followupStatus=tracking'],
        ['followupStatus=no_follow_up', 'followupStatus=no_follow_up'],
        ['treatmentStatus=Archiviert', 'treatmentStatus=Archiviert'],
        ['orderingStatus=By Therapist', 'orderingStatus=By+Therapist'],
        ['orderingStatus=Praxis', 'orderingStatus=Praxis'],
        ['orderingStatus=ER bestellt selbst', 'orderingStatus=ER+bestellt+selbst'],
      ] as [string, string][]) {
        const inTab = await apiPage.total(`/prescriptions?itemsPerPage=1&${C.TAB_FILTER}&${q}`);
        const inBook = await apiPage.total(`/prescriptions?itemsPerPage=1&${q}`);
        console.log(`  tab ∩ ${label.padEnd(30)} = ${String(inTab).padStart(3)}   (book: ${inBook})`);
        expect(inBook, `${label} is populated, so its zero in the tab means something`).toBeGreaterThan(0);
        expect(inTab, `${label} is excluded from the tab`).toBe(0);
      }
      console.log(`  the tab holds ${base}; every forbidden side intersects it at 0`);
    },
  );

  test(
    '#3885 AC1/AC2: a practice whose only Bestellen VOs are discharge VOs leaves Heute bestellen',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async () => {
      // Composition rather than enumeration: the two counts differ by exactly the discharge VOs.
      const order = await apiPage.total('/prescriptions?itemsPerPage=1&followupStatus=order');
      const orderNoDischarge = await apiPage.total(`/prescriptions?itemsPerPage=1&followupStatus=order&${C.EXCLUDE}`);
      console.log(`  VOs in Bestellen: ${order}; excluding discharge VOs: ${orderNoDischarge}` +
        ` → ${order - orderNoDischarge} discharge VOs are in Bestellen`);
      expect(order - orderNoDischarge, 'discharge VOs are in Bestellen, so the rule has work to do')
        .toBeGreaterThan(0);

      // The CRM's own practice query for "Heute bestellen".
      const todayIds = new Set((await apiPage.crmPractices('practiceTodayOrder=true&hasCrmPrescriptions=true'))
        .map((p: any) => p.id));
      const crmRows = await apiPage.crmPractices('page=1');

      // Every practice behind a listed discharge VO: it must be absent from Heute bestellen when
      // discharge VOs are its only Bestellen ones, and its "Ausstehende Bestellungen" must be 0.
      let checked = 0;
      for (const v of tabVos) {
        const pid = typeof v.practice === 'object' ? v.practice?.id : Number(String(v.practice).split('/').pop());
        if (!pid) continue;
        const others = await apiPage.total(
          `/prescriptions?itemsPerPage=1&followupStatus=order&${C.EXCLUDE}&practice=${pid}`);
        const row = crmRows.find((p: any) => p.id === pid);
        console.log(`  VO ${String(v.prescriptionId).padEnd(9)} practice ${pid} ` +
          `${JSON.stringify(String(v.practice?.name ?? row?.name ?? '').slice(0, 38))}: ` +
          `other Bestellen VOs ${others}, in Heute bestellen ${todayIds.has(pid)}, ` +
          `Ausstehende Bestellungen ${row?.pendingOrders}`);
        if (others === 0) {
          expect(todayIds.has(pid), `practice ${pid} is not in Heute bestellen`).toBe(false);
          expect(row?.pendingOrders, `practice ${pid}'s Ausstehende Bestellungen counts no discharge VO`).toBe(0);
          checked++;
        }
      }
      expect(checked, "AC2's case — a discharge-only practice — occurs on staging").toBeGreaterThan(0);

      // The ticket's own named staging fixture, by name rather than by id, since ids drift.
      const mauritius = crmRows.find((p: any) => /Mauritius Therapieklinik/i.test(String(p.name ?? '')));
      if (mauritius) {
        console.log(`  ticket fixture: Mauritius Therapieklinik (${mauritius.id}) ` +
          `pendingOrders=${mauritius.pendingOrders}, in Heute bestellen ${todayIds.has(mauritius.id)}`);
        expect(todayIds.has(mauritius.id), 'the ticket\'s own fixture left Heute bestellen').toBe(false);
        expect(mauritius.pendingOrders, 'and its column reads 0').toBe(0);
      }
    },
  );

  test(
    '#3885 AC3/AC7: the practice Ordering tab and every follow-up surface are untouched',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async () => {
      // AC3: a discharge VO comes back WITHOUT the opt-in — that is what keeps it in the practice's
      // Bestellung tab, and it is the half that shows the exclusion is opt-in rather than global.
      for (const v of tabVos.slice(0, 3)) {
        const pid = typeof v.practice === 'object' ? v.practice?.id : null;
        if (!pid) continue;
        const withOut = await apiPage.total(`/prescriptions?itemsPerPage=1&followupStatus=order&practice=${pid}`);
        const withIn = await apiPage.total(`/prescriptions?itemsPerPage=1&followupStatus=order&${C.EXCLUDE}&practice=${pid}`);
        console.log(`  practice ${pid}: Bestellen VOs ${withOut} → ${withIn} with the exclusion`);
        expect(withOut, 'the practice Ordering tab still sees the discharge VO').toBeGreaterThan(withIn);
      }

      // AC7: the follow-up population is NOT narrowed — `buildActionableVoDql` serves both status
      // sets and the exclusion is a parameter only two of its four callers pass.
      const fu = await apiPage.total('/prescriptions?itemsPerPage=1&pendingFollowUp=true&orderingStatus=By+Admin');
      const fuExcl = await apiPage.total(`/prescriptions?itemsPerPage=1&pendingFollowUp=true&orderingStatus=By+Admin&${C.EXCLUDE}`);
      console.log(`  Heute nachverfolgen population: ${fu}; with the exclusion it would be ${fuExcl}`);
      expect(fu, 'the follow-up population exists').toBeGreaterThan(0);
    },
  );

  test(
    'the CRM start page: the tab row, the counts, and which requests carry the exclusion',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async ({ page }) => {
      const ui = new C(api, page);
      await ui.open();

      // #3884 AC1 — directly right of Heute bestellen, the others in their old order.
      const tabs = await ui.tabRow();
      console.log(`  tab row: ${JSON.stringify(tabs)}`);
      expect(tabs.map((t) => t.replace(/ \(\d+\)$/, '')), 'the six tabs in the ticket\'s order')
        .toEqual([...C.TABS]);

      // #3884 AC2 — the label carries the VO count, and it IS the tab's own query.
      const label = tabs.find((t) => t.startsWith('Entlassmanagement'))!;
      const painted = C.countOf(label);
      const served = await apiPage.total(`/prescriptions?itemsPerPage=1&${C.TAB_FILTER}&includePostponed=false`);
      console.log(`  "${label}" against dischargeOrdering=true&includePostponed=false = ${served}`);
      expect(painted, 'the label carries a count').not.toBeNull();
      expect(painted, 'and it is the tab query\'s own count').toBe(served);

      // #3885 AC1 — the two ORDER cards opt out; AC7 — the follow-up ones do not. This is the
      // assertion the captured requests exist for.
      const orderCards = ui.matching('/prescriptions/count', 'followupStatus=order', 'orderingStatus=By Admin');
      console.log(`  order-card requests (${orderCards.length}):`);
      for (const r of orderCards) console.log(`    ${r.slice(0, 190)}`);
      expect(orderCards.length, 'both order cards were requested').toBeGreaterThanOrEqual(2);
      for (const r of orderCards) {
        expect(r, 'an order card excludes discharge VOs').toContain('excludeDischargeVos=true');
      }
      const followUpCards = ui.matching('/prescriptions/count').filter((r) =>
        r.includes('pendingFollowUp=true') || r.includes('followupStatus[]=tracking'));
      console.log(`  follow-up-card requests (${followUpCards.length}):`);
      for (const r of followUpCards) console.log(`    ${r.slice(0, 190)}`);
      expect(followUpCards.length, 'the follow-up cards were requested').toBeGreaterThan(0);
      for (const r of followUpCards) {
        expect(r, 'a follow-up card is untouched (AC7)').not.toContain('excludeDischargeVos');
      }

      // #3884 AC9's postponed rule ships as a parameter on the tab's own count.
      const tabCount = ui.matching('/prescriptions/count', 'dischargeOrdering=true');
      console.log(`  tab-count request: ${tabCount[0]}`);
      expect(tabCount.length, 'the tab count is its own request').toBeGreaterThan(0);
      expect(tabCount[0], 'postponed VOs are left out of the label (AC9)')
        .toContain('includePostponed=false');
    },
  );

  test(
    '#3884 AC6/AC7: the tab paints the eight columns, oldest issue date first',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async ({ page }) => {
      const ui = new C(api, page);
      await ui.open();
      await ui.openTab('Entlassmanagement');
      const text = await page.locator('#root').innerText();
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const i = lines.findIndex((l) => /^VO( Nr\.?| #)?$/i.test(l) || l === 'VO');
      console.log(`  around the header: ${JSON.stringify(lines.slice(Math.max(0, i - 1), i + 14))}`);
      for (const c of C.COLUMNS) {
        expect(text, `the column "${c}"`).toContain(c);
      }
      // Three of the eight are NOT what the ticket's Localization Reference names them — the tab
      // reuses Flow's existing column vocabulary instead. Reported, since a QA checking the AC
      // literally would file it.
      for (const [shipped, perTicket] of Object.entries(C.COLUMNS_PER_TICKET)) {
        console.log(`  column reads ${JSON.stringify(shipped)}; the ticket writes ${JSON.stringify(perTicket)}`);
        expect(text, `the shipped label "${shipped}"`).toContain(shipped);
      }
      expect(text, 'and the Reference\'s own "Ausstellungsdatum" is not what is painted')
        .not.toContain('Ausstellungsdatum');

      // AC7 — oldest issue date on top, read off the PAINTED order. An earlier version compared
      // `tabVos()`, which sends no `order` key and so comes back in id order — on 2026-10-06 ids
      // 100132+ (issued 02.10) sit before 100017 (01.09) and that read "fails" on a correct tab.
      const tabReqs = ui.matching('/v2/prescriptions', C.TAB_FILTER);
      console.log(`  the tab's own list requests: ${JSON.stringify(tabReqs.slice(-2))}`);
      const served = await apiPage.tabVos(100);
      const dateOf = new Map(served.map((v) => [String(v.prescriptionId), String(v.date ?? '').slice(0, 10)]));
      const painted: string[] = [];
      for (const l of lines) {
        const m = /\[?(\d{3,7}-\d{1,3})\]?/.exec(l);
        if (m && dateOf.has(m[1]) && !painted.includes(m[1])) painted.push(m[1]);
      }
      const dates = painted.map((n) => dateOf.get(n)!);
      console.log(`  painted VOs ${painted.length}, issue dates in painted order: ${JSON.stringify(dates)}`);
      expect(painted.length, 'the tab painted rows').toBeGreaterThan(3);
      expect(dates, 'the tab paints oldest issue date first').toEqual([...dates].sort());
    },
  );

  test(
    '#3884 AC6 "Gültig bis": every row shows the valid-until date its own VO form shows (PR #3951)',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async ({ page }) => {
      // The PM's 5 Oct run FAILED this row: the tab filled the cell from the 12-day discharge
      // window alone, which #3830 AC4 gives to GKV and Privat Basis only, so a BG VO (100031-1)
      // and one with no insurance type (100038-1) painted "—" while their forms showed a date.
      // PR #3951 (merged 2026-10-05 10:04Z) uses getValidityDate() instead. The earlier AC6 test
      // only checked that the header exists, which is how the defect passed it — so this one
      // compares VALUES: the tab's own v2 rows against each VO's item-level validityDate.
      const day = (s: any) => (s ? String(s).slice(0, 10) : null);
      const de = (iso: string) => iso.split('-').reverse().join('.');
      const raw = await apiPage.get<any>(
        '/v2/prescriptions?page=1&itemsPerPage=100&dischargeOrdering=true&includePostponed=true');
      const rows: Vo[] = Array.isArray(raw) ? raw : (raw.member ?? raw['hydra:member'] ?? []);
      expect(rows.length, 'the tab lists VOs').toBeGreaterThan(0);
      const q = rows.map((r) => `prescriptionId[]=${encodeURIComponent(r.prescriptionId)}`).join('&');
      const v1 = await apiPage.get<any>(`/prescriptions?itemsPerPage=200&${q}`);
      const form = new Map<string, Vo>((v1.member ?? v1['hydra:member']).map((p: Vo) => [p.prescriptionId, p]));

      const byType: Record<string, { n: number; dated: number }> = {};
      const mismatches: string[] = [];
      for (const r of rows) {
        const p = form.get(r.prescriptionId);
        const type = p?.insuranceType ?? 'none';
        byType[type] ??= { n: 0, dated: 0 };
        byType[type].n++;
        if (day(r.validityDate)) byType[type].dated++;
        if (day(r.validityDate) !== day(p?.validityDate)) {
          mismatches.push(`${r.prescriptionId} (${type}) tab ${day(r.validityDate)} form ${day(p?.validityDate)}`);
        }
      }
      console.log(`  per insurance type (rows / dated): ${JSON.stringify(byType)}`);
      expect(mismatches, 'the tab and the VO form agree on every row').toEqual([]);
      // Anti-vacuity: the fix is about the types OUTSIDE the discharge window, so at least one
      // must be present and dated, or this test cannot tell the old rule from the new one.
      const outside = ['accident', 'none'].filter((t) => (byType[t]?.dated ?? 0) > 0);
      expect(outside.length, 'a BG or no-insurance-type row carries a date (the pre-fix "—" case)')
        .toBeGreaterThan(0);
      // PKV is the one case AC6 wants blank.
      for (const r of rows.filter((x) => form.get(x.prescriptionId)?.insuranceType === 'private')) {
        expect(day(r.validityDate), `PKV ${r.prescriptionId} stays empty`).toBeNull();
      }

      // On screen: the dated non-window rows paint their date beside their VO number.
      const ui = new C(api, page);
      await ui.open();
      await ui.openTab('Entlassmanagement');
      // The table is laid out COLUMN-major in the DOM (the VO-number column is its own frozen
      // stack), so text following the VO number is the next column's header, not the row's cells.
      // Match by geometry: the leaf vertically overlapping the VO-number leaf, under "Gültig bis".
      const rowCells = (vo: string) => page.evaluate((vo) => {
        const leaves = [...document.querySelectorAll('#root *')].filter(
          (e) => e.children.length === 0 && (e.textContent ?? '').trim());
        const box = (e: Element) => e.getBoundingClientRect();
        const anchor = leaves.find((e) => (e.textContent ?? '').trim() === `[${vo}]`);
        const header = leaves.find((e) => (e.textContent ?? '').trim() === 'Gültig bis');
        if (!anchor || !header) return null;
        const a = box(anchor); const h = box(header);
        // The row is ~100px tall and the anchor sits near its top; take the row band around it.
        const top = a.top - 20; const bottom = a.top + 80;
        const inRow = leaves.filter((e) => { const b = box(e); return b.height > 0 && b.top < bottom && b.bottom > top; });
        const valid = inRow.find((e) => { const b = box(e); return b.left < h.right + 40 && b.right > h.left - 40; });
        return { cells: inRow.map((e) => (e.textContent ?? '').trim()), validUntil: valid ? (valid.textContent ?? '').trim() : null };
      }, vo);
      let checked = 0;
      for (const r of rows) {
        const p = form.get(r.prescriptionId);
        if (!['accident', undefined, null].includes(p?.insuranceType) || !day(r.validityDate)) continue;
        const got = await rowCells(r.prescriptionId);
        if (!got) { console.log(`  ${r.prescriptionId} is not on the painted page (10 rows a page)`); continue; }
        console.log(`  ${r.prescriptionId} (${p?.insuranceType ?? 'none'}): ${JSON.stringify(got.cells)}`);
        expect(got.validUntil, `${r.prescriptionId} paints Gültig bis ${de(day(r.validityDate)!)}`)
          .toBe(de(day(r.validityDate)!));
        checked++;
      }
      expect(checked, 'at least one BG / no-type row was read off the screen').toBeGreaterThan(0);
    },
  );

  test(
    'FINDING: the v1 /practices count still includes discharge VOs',
    { tag: ['@Admin', '@CRMEntlassmanagement', '@ReadOnly'] },
    async () => {
      // Reported, not failed: #3885 AC1 is scoped to the CRM START PAGE, whose practice rows come
      // from `/v2/practices` — and those read 0 correctly. But the v1 `/practices` serves a field
      // of the same name from a third path: `PracticeNormalizer` carries the exclusion and only
      // runs when a therapist filter is present (`if (empty($therapistIds)) return;`), so a plain
      // read falls through to the entity's own count, which has none.
      const crmRows = await apiPage.crmPractices('page=1');
      let diverged = 0;
      for (const v of tabVos) {
        const pid = typeof v.practice === 'object' ? v.practice?.id : null;
        if (!pid) continue;
        const others = await apiPage.total(
          `/prescriptions?itemsPerPage=1&followupStatus=order&${C.EXCLUDE}&practice=${pid}`);
        if (others !== 0) continue;
        const v1 = await apiPage.practice(pid);
        const v2 = crmRows.find((p: any) => p.id === pid);
        console.log(`  practice ${pid} ${JSON.stringify(String(v1.name).slice(0, 40))}: ` +
          `/v2/practices pendingOrders=${v2?.pendingOrders}  /practices pendingOrders=${v1.pendingOrders}`);
        expect(v2?.pendingOrders, 'the CRM start page is correct').toBe(0);
        if (v1.pendingOrders !== 0) diverged++;
      }
      console.log(`  practices where the two endpoints disagree: ${diverged}`);
      console.log('  → Outside AC1\'s stated surface (the CRM start page), so a PM question rather');
      console.log('    than a defect — but the same field name reads 0 on one endpoint and more on');
      console.log('    the other for the same practice, and the PR itself flags that the pending-');
      console.log('    orders rule is "asked in five places and two dialects" and was not unified.');
      expect(diverged, 'the divergence is real on this build').toBeGreaterThan(0);
    },
  );
});
