import { test, expect } from '../../fixtures/crm-serial';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { DischargeVoMarkerPage as D } from '../../../Pages/superadmin/sa.discharge-vo-marker.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 #3819 — the "Entlassmanagement" badge in the CRM practice order lists.
 *
 * AC1 names four places; the two Admin Board ones are in
 * `tests/Staging/SuperAdmin/sa_discharge_vo_marker.spec.ts`. These two are here because the CRM
 * practice detail is the shared surface the whole CRM group drives, so this file takes the
 * `crm-serial` lock — **which owns the timeout, so this file must not call `test.setTimeout()`**.
 *
 * The badge is the ticket's point: the team ordering follow-ups sees a discharge VO with Folge-VO
 * status "Bestellen" and, without it, cannot tell it apart from the VOs it orders from the
 * hospital.
 */

let api: APIRequestContext;
let apiPage: D;

test.describe('#3819 the Entlassmanagement badge in the CRM order lists', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    api = await pwRequest.newContext();
    apiPage = new D(api);
    await apiPage.init();
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'AC1: the Bestellung tab shows the badge in the VO-number cell',
    { tag: ['@Admin', '@CRMDischargeBadge', '@ReadOnly'] },
    async ({ page }) => {
      // The ticket's own QA step: practice "Mauritius Therapieklinik", Ordering tab, VO 9594-1.
      // It is that practice's ONLY VO, which is what makes it an unambiguous fixture.
      const vos = await apiPage.practiceVos(D.TICKET_PRACTICE.id);
      console.log(`  ${D.TICKET_PRACTICE.name}: ${vos.map((v) => `${v.number} (discharge=${v.isDischargeManagement}, followup=${v.followupStatus})`).join(', ')}`);
      const target = vos.find((v) => v.number === D.TICKET_VO);
      expect(target?.isDischargeManagement, `${D.TICKET_VO} is still a discharge VO`).toBe(true);
      expect(target?.followupStatus, 'and still in Bestellen, so the Ordering tab lists it').toBe('order');

      // Three things about reaching this screen, each of which otherwise reads as the badge
      // being absent:
      //
      // 1. The project's saved storageState is SINGLE-USE since the v3.12 auth migration (#3460),
      //    so the CRM list never paints without minting first. `CRMBasePage` does not mint — only
      //    the two newest CRM page objects do.
      // 2. `CRMBasePage.openCRM()` falls back to the "Mit Problemen" tab when rows are slow, and a
      //    search run there finds nothing. The practice list is per TAB.
      // 3. This practice is NOT on "Heute bestellen" — #3885 took discharge VOs off that tab —
      //    so "Alle" is the tab that can reach it. Searching the default tab returns 0 rows, which
      //    looks exactly like the practice being gone.
      await mintUiSession(page, STAGING_CREDENTIALS.admin);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/crm', { waitUntil: 'domcontentloaded' });
      await page.getByText(/Heute bestellen/).first().waitFor({ timeout: 240_000 });
      await expect
        .poll(async () => /Alle \(\d+\)/.test(await page.locator('#root').innerText()),
          { timeout: 180_000, intervals: [1_500] })
        .toBe(true);
      await page.getByText(/^Alle \(\d+\)$/).first().click({ timeout: 120_000 });
      await expect
        .poll(() => page.getByText('Anzeigen', { exact: true }).count(),
          { timeout: 180_000, intervals: [1_500] })
        .toBeGreaterThan(0);

      const search = page.getByRole('textbox').first();
      await search.fill('Mauritius');
      await search.press('Enter');
      await expect
        .poll(() => page.getByText('Anzeigen', { exact: true }).count(),
          { timeout: 180_000, intervals: [1_500] })
        .toBe(1);
      await page.getByText('Anzeigen', { exact: true }).first().click({ timeout: 120_000 });

      // The detail modal opens on Praxis-Infos; Bestellung is where the badge belongs.
      await page.getByText('Bestellung', { exact: true }).first().click({ timeout: 120_000 });
      await expect
        .poll(async () => (await page.locator('#root').innerText()).includes(D.TICKET_VO),
          { timeout: 180_000, intervals: [1_500] })
        .toBe(true);

      const badge = await D.badge(page, D.LABEL_DE);
      console.log(`  badge: ${JSON.stringify(badge)}`);
      expect(badge, `the ${D.LABEL_DE} badge is painted on ${D.TICKET_VO}'s row`).toBeTruthy();
      expect(badge!.pill, 'and it sits on a pill').toBeTruthy();

      // AC1's "next to the VO number": the badge shares the VO-number cell, stacked under it, as
      // on the Admin Board — so the claim is about the CELL, not left-to-right adjacency.
      const cell = await D.voNumberCell(page, D.TICKET_VO, D.LABEL_DE);
      console.log(`  VO-number cell: ${JSON.stringify(cell)}`);
      expect(cell, 'the VO number and the badge share one cell').toBeTruthy();
      const flat = cell!.text.replace(/\s+/g, '');
      expect(flat, 'the cell holds the VO number').toContain(D.TICKET_VO);
      expect(flat, 'and the badge').toContain(D.LABEL_DE);
      expect(flat.indexOf(D.LABEL_DE), 'with the badge after the number, nothing between')
        .toBe(flat.indexOf(D.TICKET_VO) + D.TICKET_VO.length + 1); // +1 for the closing bracket
      expect(cell!.badgeY, 'the badge is below the VO number, not before it')
        .toBeGreaterThan(cell!.numberY);
      // The commit widened this column to fit the pill (CRM/v1 100 -> 170); the pill is 145 wide,
      // so what is checked is that it fits rather than a specific declared width.
      console.log(`  cell ${cell!.w}x${cell!.h}px, pill ${badge!.pill!.w}px wide`);
      expect(cell!.w, 'the column fits the pill — it was widened for exactly this')
        .toBeGreaterThanOrEqual(badge!.pill!.w);

      // AC4: the row's own data is untouched — the Folge-VO status is still what it was.
      const rowText = await page.locator('#root').innerText();
      expect(rowText, 'the Folge-VO status is still on the row').toContain('Bestellen');
    },
  );

  test(
    'AC1: the Nachverfolgung tab — measured, and it has no discharge VO to show',
    { tag: ['@Admin', '@CRMDischargeBadge', '@ReadOnly'] },
    async () => {
      // AC1's second CRM row cannot be exercised on staging, and the reason is the DATA rather
      // than the feature: the Nachverfolgung tab lists VOs whose Folge-VO status is `received` or
      // `tracking`, and no discharge VO is in either state.
      //
      // Walked over the 10,236 VOs issued since 2026-04-01 (the flag is not a registered filter,
      // #3800): 46 discharge VOs, split `order` 21 / none 13 / `no_follow_up` 11 / `deceased` 1,
      // and ZERO in a Nachverfolgung state. The badge is rendered by the one shared DashboardTable
      // that the Bestellung tab above uses, so the surface is covered; what is missing is a row.
      const states = ['received', 'tracking'];
      let found = 0;
      for (const st of states) {
        const { body } = await apiPage.get<any>(
          `/prescriptions?itemsPerPage=1&followupStatus=${st}`);
        const total = body?.totalItems ?? 0;
        console.log(`  followupStatus=${st}: ${total} VOs book-wide`);
        expect(total, `the ${st} population exists, so the tab is not empty for other reasons`)
          .toBeGreaterThan(0);
      }
      // Re-check the pinned discharge VOs rather than trusting the walk's cached verdict.
      const vos = await apiPage.vosByNumber([
        '9489-1', '9594-1', '9612-1', '9612-2', '99664-1', '99665-1', '99667-1',
        '99669-1', '99671-1', '99672-1', '99673-1', '99674-1', '99675-1', '99679-1',
        '99699-1', '99700-1', '99701-1', '99703-1', '99709-1',
      ]);
      const discharge = vos.filter((v) => v.isDischargeManagement);
      const inNachverfolgung = discharge.filter((v) => states.includes(v.followupStatus ?? ''));
      console.log(`  of ${discharge.length} discharge VOs, ${inNachverfolgung.length} are in a Nachverfolgung state`);
      console.log(`  followupStatus split: ${JSON.stringify(discharge.reduce((a: any, v) => { const k = String(v.followupStatus); a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
      found = inNachverfolgung.length;
      expect(found, 'FINDING: AC1\'s Nachverfolgung row has no staging fixture — a data gap, not a defect')
        .toBe(0);
    },
  );
});
