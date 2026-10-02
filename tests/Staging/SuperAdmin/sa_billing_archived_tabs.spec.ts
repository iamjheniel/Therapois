import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { BillingArchivedTabsPage as B, type ListKind } from '../../../Pages/superadmin/sa.billing-archived-tabs.page';

/**
 * RC 3.15 — #3835, invoices of archived VOs on PKV-Abrechnung and Zuzahlungsverwaltung.
 *
 * A VO auto-archives ~30 days after billing while its invoice stays open, so #3277's rule dropped
 * the invoice off every tab. On the production copy of 25 Sep 2026 **all 254 overdue invoices sat
 * on archived VOs**, so both "Overdue" tabs showed 0 — the billing team chases open invoices from
 * exactly those tabs. This ticket lists an archived VO under the Abgerechnet rule and adds
 * "Archivierte VOs ausblenden" to take them back out.
 *
 * Shipped as `afe4de25055` (api) + `22fc8807c28` (app) on `release/3.15.0`, both `Ref #3835`,
 * **no PR**. Deployed on both halves.
 *
 * **Read-only.** Every API request is a GET; the screen is navigated, a checkbox is toggled and
 * rows are selected. AC5's bulk actions are deliberately NOT run — they write invoice status,
 * DATEV state and reminder letters — but AC6's substance is reachable without them, because
 * ticking the box PRUNES THE SELECTION, and that is what "the action covers only rows the list
 * still shows" reduces to.
 *
 * **The ticket's own Visual Reference is the before/after and it lands exactly:** it predicts the
 * PKV "Überfällig" tab showing 119 by default after the change and "back to today's 5" when the box
 * is ticked. Measured: 119 and 5, on the API and on the painted chip.
 */

const COPAY: ListKind = 'copaymentBilling';
const PKV: ListKind = 'pkvBilling';

/**
 * The eight archived copayment VOs that serve `invoice: null`.
 *
 * Four carry only a CANCELLED invoice (plus its Storno) and AC1 lists them; four carry no invoice
 * at all and AC1 excludes them. They are pinned because the split is the whole of AC1 and
 * re-deriving it costs a 383-row walk plus an invoice read per row — but each is re-classified
 * from its own `/invoices` rows before use, so a fixture that gains an invoice fails loudly.
 */
const ARCHIVED_NO_ACTIVE_INVOICE = [
  '8346-2', '8829-1', '9117-1', '9417-1',   // only a cancelled invoice -> listed
  '4958-9', '8986-1', '9034-1', '9218-1',   // no invoice at all        -> never listed
];

/** The ticket's own "known case that is not a bug" (AC7). */
const EXEMPT_AFTER_INVOICE = '6504-1';

/** #3277's archived fixture, used here for AC4's search clause. */
const SEARCH_FIXTURE = '7943-3';

let api: APIRequestContext;
let page: B;

test.describe('#3835 archived VOs on the billing tabs', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  test.beforeAll(async () => {
    api = await pwRequest.newContext();
    page = new B(api);
    await page.init();
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: hideArchived narrows all three filters, against a bogus-key control that does not',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      // An unregistered key on these filters is accepted and SILENTLY IGNORED, so a 200 proves
      // nothing at all — the probe is that the new key narrows while a nonsense one does not.
      for (const kind of [PKV, COPAY] as ListKind[]) {
        const base = await page.total(kind);
        const hidden = await page.total(kind, { hideArchived: true });
        const { body: bogus } = await page.get<any>(
          `/prescriptions?itemsPerPage=1&${kind}=true&${kind}%5BzzzNotAFilter%5D=true`);
        const off = await page.total(kind, { hideArchived: false });
        console.log(`  ${kind}: default ${base}, hideArchived ${hidden}, bogus key ${bogus?.totalItems}, hideArchived=false ${off}`);
        expect(base, `${kind} has rows to narrow`).toBeGreaterThan(0);
        expect(hidden, `${kind}[hideArchived] must NARROW the list`).toBeLessThan(base);
        expect(bogus?.totalItems, 'an unregistered key is ignored — which is why the narrowing is the probe')
          .toBe(base);
        expect(off, 'hideArchived=false is the default, not a third behaviour').toBe(base);
      }
      const reg = await page.cancelledRegisterTotal(false);
      const regHidden = await page.cancelledRegisterTotal(true);
      console.log(`  cancelledRegister: ${reg} -> ${regHidden} with hideArchived`);
      expect(regHidden, 'cancelledRegister[hideArchived] must narrow the Storniert tab too').toBeLessThan(reg);
    },
  );

  test(
    'DEPLOYED (app): the checkbox and both its labels ship in the served bundle',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      // The frontend deploys independently of the API (#3705), so it needs its own probe.
      const html = await (await api.get('https://staging.therapios.de/', { timeout: 180_000 })).text();
      const names = [...new Set([...html.matchAll(/\/_expo\/static\/js\/web\/(entry-[A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]))];
      expect(names.length, 'the served page must name an entry bundle').toBeGreaterThan(0);
      let js = '';
      for (const n of names) {
        js += await (await api.get(`https://staging.therapios.de/_expo/static/js/web/${n}`, { timeout: 300_000 })).text();
      }
      const count = (s: string) => js.split(s).length - 1;
      const de = count(B.CHECKBOX_LABEL_DE);
      const en = count(B.CHECKBOX_LABEL_EN);
      const param = count('hideArchived');
      const key = count('hide_archived');
      console.log(`  bundle ${names.join(',')} (${js.length} bytes)`);
      console.log(`  "${B.CHECKBOX_LABEL_DE}" ${de} · "${B.CHECKBOX_LABEL_EN}" ${en} · hideArchived ${param} · hide_archived ${key}`);
      expect(de, 'the German label ships').toBeGreaterThan(0);
      expect(en, 'the English label ships').toBeGreaterThan(0);
      expect(param, 'the query parameter is referenced by the tab components').toBeGreaterThan(0);
      expect(key, 'the i18n key is hide_archived').toBeGreaterThan(0);
      // The Developer Reference proposes `all_with_archived` for the NEW key. That is a different,
      // pre-existing key ("Alle inkl. Archivierte"), so a probe written from the reference finds a
      // healthy count for the wrong string — pinned so nobody re-derives a false pass.
      const stale = count('all_with_archived');
      console.log(`  (the Developer Reference's suggested key all_with_archived: ${stale} — a DIFFERENT, pre-existing key)`);
      expect(stale, 'the pre-existing Alle-inkl-Archivierte key is untouched').toBeGreaterThan(0);
    },
  );

  test(
    'AC1: an archived VO is listed when it carries an invoice — including one that is only cancelled',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      // THE TRAP: `invoice` is getActiveInvoice(), which skips cancelled invoices and Stornos
      // (#3535), so all eight of these serve `invoice: null`. AC1 says the VO is listed when it
      // carries "an open one, OR ONLY A CANCELLED ONE" — so reading that field to decide "has an
      // invoice" reports the four correctly-listed VOs as a defect.
      const all = await page.rows(COPAY, {}, 400);
      const shown = new Set(all.map((r) => r.number));
      expect(all.length, 'the default copayment list was read').toBeGreaterThan(0);

      let withCancelled = 0; let withNone = 0;
      for (const num of ARCHIVED_NO_ACTIVE_INVOICE) {
        const id = await page.idOf(num);
        expect(id, `${num} must still exist`).toBeTruthy();
        const row = all.find((r) => r.number === num);
        const invoices = await page.invoicesOf(id!);
        const nonStorno = invoices.filter((i) => i.type !== 'storno');
        const hasAny = nonStorno.length > 0;
        const onlyCancelled = hasAny && nonStorno.every((i) => i.status === 'cancelled');
        const isShown = shown.has(num);
        console.log(`  ${isShown ? 'LISTED  ' : 'excluded'} ${num.padEnd(9)} invoice field=${row?.invoice?.invoiceNumber ?? 'null'}  invoices=${JSON.stringify(invoices.map((i) => `${i.number}/${i.status}`))}`);
        if (row) expect(row.invoice, `${num} serves no ACTIVE invoice — that is the trap`).toBeNull();
        expect(isShown, `${num}: listed iff it carries an invoice (${hasAny})`).toBe(hasAny);
        if (onlyCancelled) withCancelled += 1; else if (!hasAny) withNone += 1;
      }
      console.log(`  -> ${withCancelled} listed on a cancelled-only invoice, ${withNone} excluded for carrying none`);
      // Both halves must occur or the assertion is satisfied by one of them alone.
      expect(withCancelled, 'AC1\'s "or only a cancelled one" clause is exercised').toBeGreaterThan(0);
      expect(withNone, 'AC1\'s "never when it carries none" clause is exercised').toBeGreaterThan(0);
    },
  );

  test(
    'AC2: the tab truth table, on both pages and in both checkbox states',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      for (const kind of [PKV, COPAY] as ListKind[]) {
        const rowsDefault = await page.rows(kind, {}, 400);
        const rowsHidden = await page.rows(kind, { hideArchived: true }, 400);
        const archivedShown = rowsDefault.filter((r) => r.treatmentStatus === 'Archiviert');
        console.log(`  [${kind}] default ${rowsDefault.length} rows (${archivedShown.length} archived), hidden ${rowsHidden.length}`);

        // "All": archived listed by default (new), not listed when ticked.
        expect(archivedShown.length, `${kind} "Alle" lists archived VOs by default`).toBeGreaterThan(0);
        expect(rowsHidden.filter((r) => r.treatmentStatus === 'Archiviert'),
          `${kind} "Alle" lists no archived VO when the box is ticked`).toEqual([]);
        // Ticking must reproduce exactly the pre-#3835 world — the AC's "as today" column.
        const hiddenStatuses = [...new Set(rowsHidden.map((r) => r.treatmentStatus))].sort();
        console.log(`     ticked statuses: ${JSON.stringify(hiddenStatuses)}`);
        expect(hiddenStatuses.every((s) => B.PRE_3835_STATUSES.includes(s)),
          `ticked, ${kind} shows only ${B.PRE_3835_STATUSES}`).toBe(true);

        // The status tabs: each one loses exactly its archived rows.
        let movedTabs = 0;
        for (const status of B.STATUS_TABS) {
          const off = await page.total(kind, { invoiceStatus: status });
          const on = await page.total(kind, { invoiceStatus: status, hideArchived: true });
          expect(on, `${kind}/${status}: ticking can only narrow`).toBeLessThanOrEqual(off);
          if (off !== on) movedTabs += 1;
          if (off > 0) console.log(`     ${status.padEnd(16)} ${String(off).padStart(4)} -> ${String(on).padStart(4)}`);
        }
        expect(movedTabs, `${kind}: at least one status tab actually gains archived rows`).toBeGreaterThan(0);

        // "Fehler" (VOs without an invoice) must NOT move: an archived VO with an invoice is not
        // on it, and one without an invoice is on no tab at all.
        const errOff = await page.total(kind, { invoiceStatus: 'error' });
        const errOn = await page.total(kind, { invoiceStatus: 'error', hideArchived: true });
        console.log(`     Fehler            ${errOff} -> ${errOn} (must not move)`);
        expect(errOn, `${kind} "Fehler" is unchanged by the checkbox`).toBe(errOff);

        // "Alle mit Rechnung" already listed archived VOs (#3326) and NOW gains the checkbox.
        const regOff = await page.total(kind, { allWithInvoice: true });
        const regOn = await page.total(kind, { allWithInvoice: true, hideArchived: true });
        console.log(`     allWithInvoice    ${regOff} -> ${regOn}`);
        expect(regOn, `${kind} "Alle mit Rechnung" now honours the checkbox (new)`).toBeLessThan(regOff);
      }
      // "Storniert" is invoice-rooted (#3427) and needs the checkbox on its own request.
      const reg = await page.cancelledRegisterTotal(false);
      const regHidden = await page.cancelledRegisterTotal(true);
      console.log(`  Storniert (invoice-rooted): ${reg} -> ${regHidden}`);
      expect(regHidden, 'the Storniert register honours the checkbox (new)').toBeLessThan(reg);
    },
  );

  test(
    "AC4 (API half): the checkbox narrows search, and is INERT when Archiviert is chosen",
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      // #3277 widened search to reach archived rows; this ticket removes that widening because the
      // default now includes them — and the checkbox must take them out of search too.
      const found = await page.total(COPAY, { search: { prescriptionId: SEARCH_FIXTURE } });
      const hidden = await page.total(COPAY, { search: { prescriptionId: SEARCH_FIXTURE }, hideArchived: true });
      console.log(`  search[prescriptionId]=${SEARCH_FIXTURE}: ${found} -> ${hidden} with the box ticked`);
      expect(found, `${SEARCH_FIXTURE} is found by search in the default view`).toBeGreaterThan(0);
      expect(hidden, 'a ticked box leaves archived VOs out of search results').toBe(0);

      // AC4's last clause: choosing "Archiviert" shows archived VOs "as today", whatever the box says.
      for (const kind of [PKV, COPAY] as ListKind[]) {
        const archived = await page.total(kind, { treatmentStatus: 'Archiviert' });
        const both = await page.total(kind, { treatmentStatus: 'Archiviert', hideArchived: true });
        console.log(`  ${kind} VO Status=Archiviert: ${archived}, + ticked box: ${both}`);
        expect(archived, `${kind} has archived rows behind the filter`).toBeGreaterThan(0);
        expect(both, `${kind}: the explicit filter takes precedence over the checkbox`).toBe(archived);
      }
    },
  );

  test(
    'AC7: the page eligibility rules are untouched, and the ticket\'s known non-bug still holds',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async () => {
      // Zuzahlungsverwaltung is GKV-only and PKV-Abrechnung is PKV/Privat Basis only. Now that
      // archived rows are listed by default, that scoping is the thing most at risk.
      const copay = await page.rows(COPAY, {}, 400);
      const pkv = await page.rows(PKV, {}, 400);
      const copayTypes = [...new Set(copay.map((r) => r.insuranceType))].sort();
      const pkvTypes = [...new Set(pkv.map((r) => r.insuranceType))].sort();
      console.log(`  copayment insurance types: ${JSON.stringify(copayTypes)} over ${copay.length} rows`);
      console.log(`  PKV insurance types      : ${JSON.stringify(pkvTypes)} over ${pkv.length} rows`);
      expect(copayTypes, 'Zuzahlungsverwaltung stays GKV-only').toEqual(['public']);
      expect(pkvTypes.every((t) => t === 'private' || t === 'privat_basis'),
        'PKV-Abrechnung stays PKV / Privat Basis').toBe(true);
      expect(copay.filter((r) => r.treatmentStatus === 'Archiviert').length,
        'and the rows being checked include archived ones').toBeGreaterThan(0);

      // The ticket names this one explicitly: the patient's copayment exemption was entered after
      // the invoice, so copaymentLiable turned false. It is off the eligibility tabs for THAT
      // reason, not because it is archived — and it is still on "Alle mit Rechnung".
      const id = await page.idOf(EXEMPT_AFTER_INVOICE);
      const [vo] = await page.rows(COPAY, { allWithInvoice: true, search: { prescriptionId: EXEMPT_AFTER_INVOICE } }, 10);
      console.log(`  ${EXEMPT_AFTER_INVOICE} (id ${id}): ${JSON.stringify(vo)}`);
      expect(vo, `${EXEMPT_AFTER_INVOICE} must be on "Alle mit Rechnung"`).toBeTruthy();
      expect(vo.treatmentStatus, 'it is archived').toBe('Archiviert');
      expect(vo.copaymentLiable, 'and it is NOT liable for a copayment — that is why it is excluded').toBe(false);
      for (const q of [{}, { treatmentStatus: 'Archiviert' }]) {
        const n = await page.total(COPAY, { ...q, search: { prescriptionId: EXEMPT_AFTER_INVOICE } });
        expect(n, `${EXEMPT_AFTER_INVOICE} stays off the copayment eligibility tabs (${JSON.stringify(q)})`).toBe(0);
      }
    },
  );

  // ─────────────────────────────── on screen ───────────────────────────────

  test(
    'AC3: every tab counter equals what that tab lists, with the box unticked and ticked',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async ({ page: ui }) => {
      // AC3 is the claim that chip == list. On the API those are one query, so the real question is
      // whether the PAINTED number is that query's total — which is what this compares, tab by tab,
      // in both states.
      await B.openBillingTab(ui, 'PKV-Abrechnung');
      const expected = async (hide: boolean) => ({
        'Alle': await page.total(PKV, { hideArchived: hide }),
        'Alle mit Rechnung': await page.total(PKV, { allWithInvoice: true, hideArchived: hide }),
        'Fehler': await page.total(PKV, { invoiceStatus: 'error', hideArchived: hide }),
        'Nicht gesendet': await page.total(PKV, { invoiceStatus: 'not_sent', hideArchived: hide }),
        'Gesendet': await page.total(PKV, { invoiceStatus: 'sent', hideArchived: hide }),
        'Überfällig': await page.total(PKV, { invoiceStatus: 'overdue', hideArchived: hide }),
        'Gemahnt': await page.total(PKV, { invoiceStatus: 'reminded', hideArchived: hide }),
        'Inkasso': await page.total(PKV, { invoiceStatus: 'to_send_to_dc', hideArchived: hide }),
        'An Inkasso gesendet': await page.total(PKV, { invoiceStatus: 'sent_to_dc', hideArchived: hide }),
        'Bezahlt': await page.total(PKV, { invoiceStatus: 'paid', hideArchived: hide }),
        'Storniert': await page.cancelledRegisterTotal(hide),
        'Pausiert': await page.total(PKV, { invoiceStatus: 'on_hold', hideArchived: hide }),
      });

      for (const hide of [false, true]) {
        if (hide) await B.toggleCheckbox(ui);
        const painted = await B.chips(ui);
        const want = await expected(hide);
        console.log(`  [${hide ? 'ticked  ' : 'unticked'}] painted: ${painted.map((c) => `${c.label} ${c.count}`).join(' · ')}`);
        expect(painted.length, 'the chip row is painted').toBeGreaterThan(5);
        let compared = 0;
        for (const chip of painted) {
          const w = (want as Record<string, number>)[chip.label];
          if (w === undefined) { console.log(`     (no API mapping for "${chip.label}" — skipped)`); continue; }
          expect(chip.count, `${hide ? 'ticked' : 'unticked'}: chip "${chip.label}" must equal its own query`).toBe(w);
          compared += 1;
        }
        expect(compared, 'most chips were actually compared').toBeGreaterThan(8);
      }

      // The ticket's own Visual Reference, on the painted chip.
      const overdue = (await B.chips(ui)).find((c) => c.label === 'Überfällig');
      console.log(`  the ticket predicted "back to today's 5" when ticked — painted: ${overdue?.count}`);
      expect(overdue?.count, 'ticked, Überfällig is back to the pre-#3835 count').toBe(5);
    },
  );

  test(
    'AC4 (screen): placement, default unticked, kept across status tabs, one per page',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async ({ page: ui }) => {
      await B.openBillingTab(ui, 'PKV-Abrechnung');

      // "sits next to the VO Status filter" — asserted as x-order along the filter row.
      //
      // The raw row also carries the dropdown chevrons (empty leaves) and the checkbox's own
      // Material glyph, which sit BETWEEN the VO Status label and the checkbox label — so an
      // adjacency check on the raw leaves reports index 3 where it wants 1, on a correctly placed
      // control. Compare the labelled controls only.
      const raw = await B.filterRowOrder(ui);
      console.log(`  filter row: ${raw.map((l) => `${l.t}@${l.x}`).join(' | ')}`);
      const row = raw.filter((l) => /[A-Za-zÄÖÜäöüß]/.test(l.t));
      const labels = row.map((l) => l.t);
      console.log(`  labelled controls, left to right: ${JSON.stringify(labels)}`);
      const iStatus = row.findIndex((l) => /^VO Status/.test(l.t));
      const iBox = row.findIndex((l) => l.t === B.CHECKBOX_LABEL_DE);
      expect(iStatus, 'the VO Status filter is on the row').toBeGreaterThanOrEqual(0);
      expect(iBox, 'the checkbox is on the same row').toBeGreaterThanOrEqual(0);
      expect(iBox, 'and it is the next labelled control after VO Status').toBe(iStatus + 1);
      // Its box is drawn to the left of its own label, i.e. between the two controls.
      const glyphX = raw.find((l) => !/[A-Za-zÄÖÜäöüß]/.test(l.t) && l.x > row[iStatus].x && l.x < row[iBox].x && l.t.length === 1);
      expect(glyphX, 'the box itself is drawn between the two').toBeTruthy();

      // "is unticked whenever the page is opened"
      expect(await B.checkboxGlyph(ui), 'unticked on open').toBe(B.GLYPH_UNTICKED);

      // "keeps its setting while the admin switches between the tabs of the same page"
      await B.toggleCheckbox(ui);
      expect(await B.checkboxGlyph(ui), 'ticked').toBe(B.GLYPH_TICKED);
      await B.openStatusTab(ui, 'Überfällig');
      expect(await B.checkboxGlyph(ui), 'still ticked after a status tab switch').toBe(B.GLYPH_TICKED);
      const chips = await B.chips(ui);
      console.log(`  after switching to Überfällig, still ticked; chips ${chips.map((c) => `${c.label} ${c.count}`).join(' · ')}`);
      expect(chips.find((c) => c.label === 'Überfällig')?.count, 'and the list follows').toBe(5);

      // "Each page has its own." — PKV is ticked; Zuzahlungsverwaltung must open unticked.
      await B.switchTab(ui, 'Zuzahlungsverwaltung');
      expect(await B.checkboxGlyph(ui), 'the copayment page has its own, untouched checkbox')
        .toBe(B.GLYPH_UNTICKED);
      const zChips = await B.chips(ui);
      console.log(`  Zuzahlungsverwaltung chips: ${zChips.map((c) => `${c.label} ${c.count}`).join(' · ')}`);
      expect(zChips.find((c) => c.label === 'Alle')?.count, 'and it shows its own full list')
        .toBe(await page.total(COPAY));
    },
  );

  test(
    'AC4 (screen): the setting is not remembered between visits',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async ({ browser }) => {
      // A second VISIT needs a second context: `mintUiSession`'s refresh token is single-use
      // (#3460), so a reload in the same page lands on the login form.
      const first = await browser.newContext();
      const p1 = await first.newPage();
      await B.openBillingTab(p1, 'PKV-Abrechnung');
      await B.toggleCheckbox(p1);
      expect(await B.checkboxGlyph(p1), 'ticked in the first visit').toBe(B.GLYPH_TICKED);
      await first.close();

      const second = await browser.newContext();
      const p2 = await second.newPage();
      await B.openBillingTab(p2, 'PKV-Abrechnung');
      const glyph = await B.checkboxGlyph(p2);
      const chips = await B.chips(p2);
      console.log(`  on reopening: glyph ${glyph}, Alle ${chips.find((c) => c.label === 'Alle')?.count}`);
      expect(glyph, 'a new visit opens unticked — the setting is not remembered').toBe(B.GLYPH_UNTICKED);
      expect(chips.find((c) => c.label === 'Alle')?.count, 'and the full list is back')
        .toBe(await page.total(PKV));
      await second.close();
    },
  );

  test(
    'AC6: ticking the box drops hidden rows from the selection, so no bulk action can reach them',
    { tag: ['@SuperAdmin', '@BillingArchivedTabs', '@ReadOnly'] },
    async ({ page: ui }) => {
      // AC5's bulk actions write invoice status, DATEV state and reminder letters, so they are not
      // run here. AC6's substance does not need them: "the action covers only rows the list still
      // shows" is implemented as pruning the SELECTION, which is visible on its own.
      await B.openBillingTab(ui, 'PKV-Abrechnung');
      await B.openStatusTab(ui, 'Überfällig');   // 119 rows, of which 114 are archived
      expect(await B.selectionText(ui), 'nothing is selected to begin with').toBeNull();

      // The header box selects the page.
      const boxes = ui.locator('[role="checkbox"]');
      const n = await boxes.count();
      let header: number | null = null;
      for (let i = 0; i < n; i += 1) {
        const bb = await boxes.nth(i).boundingBox();
        if (bb && bb.y > 520) { header = i; break; }
      }
      expect(header, 'the row-selection column is painted').not.toBeNull();
      await boxes.nth(header!).click({ timeout: 60_000, force: true });
      await expect.poll(() => B.selectionText(ui), { timeout: 120_000 }).not.toBeNull();
      const selected = await B.selectionText(ui);
      console.log(`  selected: ${selected}`);
      const count = Number(/(\d+)/.exec(selected ?? '')?.[1] ?? 0);
      expect(count, 'a real selection was made').toBeGreaterThan(0);

      await B.toggleCheckbox(ui);
      const after = await B.selectionText(ui);
      const afterCount = after === null ? 0 : Number(/(\d+)/.exec(after)?.[1] ?? 0);
      console.log(`  after ticking "Archivierte VOs ausblenden": ${after ?? 'nothing selected'}`);

      // The survivors can only be rows the tab still shows, and the ticked Überfällig tab holds
      // just 5 — so this bounds the selection by the visible population rather than merely
      // observing that it shrank.
      const stillShown = await page.total(PKV, { invoiceStatus: 'overdue', hideArchived: true });
      console.log(`  the tab now shows ${stillShown} rows in total`);
      expect(afterCount, 'the hidden rows are dropped from the selection').toBeLessThan(count);
      expect(afterCount, 'and what survives cannot exceed what the list still shows')
        .toBeLessThanOrEqual(stillShown);
    },
  );
});
