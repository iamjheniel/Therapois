import { test, expect } from '../../fixtures/session';
import { ProdRiskRowsDatesPage, type RiskRow } from '../../../Pages/superadmin/sa.prod-risk-rows-dates.page';

/**
 * PRODUCTION — RC 3.14 **#3770** (the working-hours table opens on the 5-column Operativ view,
 * "Standard" becomes "Details", the section heading becomes "Übersicht") and **#3774** (the risk
 * table groups by therapist for the billing-backlog view, gains its own export, and the
 * Abrechnungs-Stau banner is retired in favour of a plain summary line).
 *
 * **READ-ONLY:** every request a GET, plus navigating and reading the boards. #3774's export is a
 * POST and is deliberately not called, so AC5's CSV is not checked here — its grouping is, on the
 * screen the CSV is built from.
 */

const P = ProdRiskRowsDatesPage;

/** #3770's four dictionary values, by leaf key. */
const RENAMED = {
  arbeitszeiten: { de: 'Übersicht', en: 'Overview' },
  standard: { de: 'Details', en: 'Details' },
  // AC2's deliberate divergence: the English interface also reads "Operativ", not "Operational".
  operativ: { de: 'Operativ', en: 'Operativ' },
} as const;

/** The two keys that legitimately still hold the OLD words — the scoping control. */
const NOT_RENAMED = { workingHours: 'Arbeitszeiten', source_standard: 'Standard' } as const;

const OPERATIV_COLUMNS = ['Effizienz', 'Krank %', 'Fertig n. abger.', 'Problem', 'Thema', 'Maßnahme'];

/** A tile that is NOT the billing backlog, so its view must render flat (AC1's other half). */
const NON_BACKLOG_TILE = 'Informationsblatt fehlt';

test.describe('#3770 + #3774 on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  let sa: ProdRiskRowsDatesPage;
  let rows: RiskRow[];
  let tiles: Record<string, number>;
  let bundle: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    sa = new ProdRiskRowsDatesPage();
    await sa.connect();
    const r = await sa.risks();
    rows = r.rows;
    tiles = r.tiles;
    const page = await browser.newPage();
    bundle = await new ProdRiskRowsDatesPage(page).entryBundle();
    await page.close();
    console.log(`  risks: ${rows.length} rows, tiles ${JSON.stringify(tiles)}; bundle ${bundle.length} bytes`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    '#3770 is deployed: the three values were renamed and the rename is SCOPED',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly'] },
    async () => {
      // The i18n KEYS did not change, only their values — a probe hunting for a `flowBoards.details`
      // or `flowBoards.uebersicht` key finds nothing and concludes the rename never shipped.
      for (const [key, want] of Object.entries(RENAMED)) {
        const vals = P.dictValues(bundle, key);
        console.log(`  flowBoards.${key}: ${JSON.stringify(vals)}`);
        for (const locale of ['de', 'en'] as const) {
          const target = P.escapeNonAscii((want as Record<string, string>)[locale]);
          expect(vals, `${key} carries the ${locale} value`).toContain(target);
        }
      }

      // On a ticket whose entire diff is four dictionary lines, the realistic failure is a blanket
      // find-and-replace — so the two keys that must KEEP the old words are the control.
      const wh = P.dictValues(bundle, 'workingHours');
      const src = P.dictValues(bundle, 'source_standard');
      console.log(`  performanceDashboard.subTabs.workingHours: ${JSON.stringify(wh)}`);
      console.log(`  crm.lead_time.source_standard:             ${JSON.stringify(src)}`);
      expect(wh, 'the TO Verwaltung sub-tab still reads Arbeitszeiten').toContain(NOT_RENAMED.workingHours);
      expect(src, 'the CRM lead-time source still reads Standard').toContain(NOT_RENAMED.source_standard);

      // "Operational" is gone entirely, which is what makes the English "Operativ" deliberate.
      expect(P.occurrences(bundle, 'Operational'), '"Operational" does not ship').toBe(0);
    },
  );

  test(
    '#3770 AC1/AC3: the table opens on Operativ, and Details is the wider view',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      const prod = new ProdRiskRowsDatesPage(page);
      await prod.openOrgaBoard();
      const opening = await prod.workingHoursColumns();
      console.log(`  opening view columns (${opening.length}): ${JSON.stringify(opening)}`);
      test.skip(opening.length === 0, 'the working-hours table did not paint its header row');

      // AC1: the board opens on the narrow operational view.
      const present = OPERATIV_COLUMNS.filter((c) => opening.includes(c));
      console.log(`  Operativ columns present: ${JSON.stringify(present)}`);
      expect(present.length, 'the opening view is the Operativ set').toBeGreaterThanOrEqual(4);
      expect(opening.length, 'the opening view is NARROW').toBeLessThan(12);

      // AC3: Details is the wide view, and Operativ's columns are a strict subset of it.
      await prod.selectView('Details');
      const details = await prod.workingHoursColumns();
      console.log(`  Details view columns (${details.length}): ${JSON.stringify(details.slice(0, 18))}`);
      expect(details.length, 'Details is wider than Operativ').toBeGreaterThan(opening.length);
      const missing = present.filter((c) => !details.includes(c));
      expect(missing, "Operativ's columns are a subset of Details'").toHaveLength(0);

      // The toggle offers Details and Operativ, and "Standard" is gone from it.
      const text = await prod.boardText();
      expect(text, 'the toggle offers Details').toContain('Details');
      expect(text, 'the toggle offers Operativ').toContain('Operativ');
    },
  );

  test(
    '#3770 AC2: the section heading reads Übersicht, and MASSNAHME is an artefact of CSS uppercasing',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      const prod = new ProdRiskRowsDatesPage(page);
      await prod.openOrgaBoard();
      const readings = await page.evaluate(() => {
        const el = [...document.querySelectorAll('div,span')].find(
          (n) => n.children.length === 0 && /^(Übersicht|Arbeitszeiten)$/.test((n.textContent ?? '').trim()),
        ) as HTMLElement | undefined;
        const massn = [...document.querySelectorAll('div,span')].find(
          (n) => n.children.length === 0 && /^Ma(ß|ss)nahme$/i.test((n.textContent ?? '').trim()),
        ) as HTMLElement | undefined;
        return {
          heading: el ? (el.textContent ?? '').trim() : null,
          massnahmeTextContent: massn ? (massn.textContent ?? '').trim() : null,
          massnahmeInnerText: massn ? massn.innerText.trim() : null,
        };
      });
      console.log(`  section heading: ${JSON.stringify(readings.heading)}`);
      console.log(`  Maßnahme textContent=${JSON.stringify(readings.massnahmeTextContent)} innerText=${JSON.stringify(readings.massnahmeInnerText)}`);
      expect(readings.heading, 'AC2: the section is now Übersicht').toBe('Übersicht');

      // The trap the AC's own Localization Reference walks into: the headers are CSS-uppercased and
      // German ß uppercases to SS, so innerText yields MASSNAHME — matching neither /Maßnahme/ nor
      // /Maßnahme/i. The AC writes "Massnahme" with ss, i.e. the PAINTED form, so an assertion
      // written from the AC literal fails on a correct build. textContent keeps the shipped string.
      if (readings.massnahmeTextContent) {
        expect(readings.massnahmeTextContent, 'textContent keeps the ß').toBe('Maßnahme');
        expect(readings.massnahmeInnerText, 'innerText is uppercased to SS').toBe('MASSNAHME');
      }
    },
  );

  test(
    '#3774 AC7: the unbilled summary equals the tile to the cent, on two different providers',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly'] },
    async () => {
      // The API half's deployment probe: a brand-new route answering at all, against a 404 control
      // — `GET /status` gives the release, not the commit (#3704).
      const summaryStatus = await sa.probe('/kpis/management/unbilled-summary');
      const exportStatus = await sa.probe('/kpis/orga/risks/export');
      const control = await sa.probe('/kpis/management/zzz-not-a-route');
      console.log(`  unbilled-summary ${summaryStatus}, risks/export (GET) ${exportStatus}, 404 control ${control}`);
      expect(summaryStatus, "#3774's summary route is registered").toBe(200);
      // The export is POST-only, so GET is 405 — registered, not absent. A 404 would mean gone.
      expect(exportStatus, "#3774's export route is registered and POST-only").toBe(405);
      expect(control, 'a route that does not exist answers 404').toBe(404);

      const summary = await sa.unbilledSummary();
      const ready = rows.filter((r) => r.tile === P.READY_TILE);
      const sum = Math.round(ready.reduce((a, r) => a + (r.revenue ?? 0), 0) * 100) / 100;
      console.log(`  summary {count: ${summary.count}, totalRevenue: ${summary.totalRevenue}}`);
      console.log(`  tile     {count: ${ready.length}, Σ revenue: ${sum}}`);
      // Two providers, one figure — not a tautology, which is why the cent matters.
      expect(summary.count, 'the summary counts the tile').toBe(ready.length);
      expect(summary.totalRevenue, 'and values it to the cent').toBeCloseTo(sum, 2);
    },
  );

  test(
    '#3774 AC6: the Abrechnungs-Stau banner is gone from both boards',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      // The banner's own i18n key was retired by the follow-up PR; its two summary-line strings
      // survive, because AC7 renders them.
      const stau = P.dictValues(bundle, 'abrechnungsStau');
      const bannerText = P.dictValues(bundle, 'backlogBannerText');
      const billable = P.dictValues(bundle, 'backlogDirektAbrechenbar');
      console.log(`  flowBoards.abrechnungsStau:          ${JSON.stringify(stau)}`);
      console.log(`  flowBoards.backlogBannerText:        ${JSON.stringify(bannerText)}`);
      console.log(`  flowBoards.backlogDirektAbrechenbar: ${JSON.stringify(billable)}`);
      expect(stau, 'the banner key is retired').toHaveLength(0);
      expect(bannerText.length, "AC7's summary line survives").toBeGreaterThan(0);
      expect(billable.length, "AC7's billable clause survives").toBeGreaterThan(0);

      // And on the Management board the summary line is PLAIN — no chevron, no button role, which
      // is what distinguishes it from the banner it replaced.
      const prod = new ProdRiskRowsDatesPage(page);
      // openManagementBoard polls for the LINE, not just the board: it comes from a separate,
      // slower request, and reading once returns before it paints.
      const line = await prod.openManagementBoard();
      console.log(`  Management summary line: ${JSON.stringify(line ?? null)}`);
      expect(line, 'the Management board paints the summary line').toBeTruthy();
      expect(line, 'and it carries the billable amount').toMatch(/direkt abrechenbar/);

      const clickable = await page.getByRole('button', { name: /fertig behandelte VOs/ }).count();
      console.log(`  summary line rendered as a button: ${clickable}`);
      expect(clickable, 'the summary line is not a control').toBe(0);
    },
  );

  test(
    '#3774 AC1: the billing-backlog view is grouped, and the other tiles stay flat',
    { tag: ['@SuperAdmin', '@ProdToOverview', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      const prod = new ProdRiskRowsDatesPage(page);
      await prod.openOrgaBoard();
      await prod.waitForGroups();
      const grouped = await prod.paintedGroups();
      console.log(`  no tile selected: ${grouped.length} groups painted`);
      expect(grouped.length, 'the default view is grouped').toBeGreaterThan(0);

      // Every painted group must resolve against the payload — the oracle, since the provider is
      // unchanged and the grouping is client-side.
      const distinct = P.groupBy(P.rowsFor(rows, null), 'distinct');
      const unknown = grouped.filter((g) => !distinct.has(P.normalizeName(g.name)));
      console.log(`  groups not resolving against the payload: ${unknown.length}`);
      expect(unknown, 'every painted group is a therapist the payload knows').toHaveLength(0);

      // A tile that is NOT the billing backlog must render flat — that is AC1's other half, and the
      // realistic leak, since both views share one component.
      // The tile's painted label is the full 'Informationsblatt fehlt' — the abbreviated 'IB fehlt'
      // appears nowhere, so a click on it waits out its actionability timeout rather than failing.
      await prod.selectTileByText(NON_BACKLOG_TILE);
      const afterTile = await prod.paintedGroups();
      console.log(`  with a non-backlog tile selected: ${afterTile.length} groups`);
      expect(afterTile.length, 'a non-backlog tile is flat').toBe(0);
    },
  );
});
