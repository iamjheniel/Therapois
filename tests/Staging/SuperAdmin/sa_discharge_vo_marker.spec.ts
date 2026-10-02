import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { DischargeVoMarkerPage as D, type Vo } from '../../../Pages/superadmin/sa.discharge-vo-marker.page';

/**
 * RC 3.15 — #3819 (the "Entlassmanagement" badge) and #3820 (Folge-VO "Bestellen" at creation).
 *
 * Two tickets over one population, which the PM notes "can pass or fail QA separately": a discharge
 * VO carries the hospital's numbers but its follow-up is requested through the ER, so #3819 marks
 * it where follow-ups are ordered and #3820 puts it into "Bestellen" at once instead of waiting an
 * average 4.7 days for the nightly run.
 *
 * `04df30f59aa` (app, `Ref #3819`) and `b103c748dbc` (api, `Ref #3820`), both on `release/3.15.0`,
 * 2026-09-26 — **neither names its issue in the subject**, so a commit search on the number finds
 * nothing and they are pinned by sha.
 *
 * **Read-only.** Every request is a GET; the Admin Board is navigated, searched and read. #3820's
 * AC1/AC3 need a VO to be created or a checkbox ticked, and **ticking is not reversible in the way
 * that counts** — AC4 says unticking leaves the status alone, so the write is one-way per VO. Those
 * are left to `docs/manual-test-3819-3820-discharge-marker.md`; everything else is verified here.
 *
 * **#3819's CRM half is in `tests/Staging/Admin/admin_crm_discharge_badge.spec.ts`** — it drives the
 * shared practice and so needs the `crm-serial` lock, which owns its own timeout.
 */

/**
 * The discharge VOs this file reads, pinned.
 *
 * `isDischargeManagement` is NOT a registered filter (#3800) — `=true`, `=false` and a bogus key all
 * return the whole 35k book — so the population can only be walked, which costs ~7 minutes. These
 * are re-classified from their own rows before use, so a fixture that loses the flag fails loudly.
 */
const DISCHARGE_VOS = [
  '9489-1', '9594-1', '9612-1', '9612-2',                                   // pre-deploy, not guarded
  '99664-1', '99665-1', '99667-1', '99669-1', '99671-1', '99672-1',         // QA Test ER (praxis_vo)
  '99673-1', '99674-1', '99675-1', '99679-1',
  '99699-1', '99700-1', '99701-1', '99703-1', '99709-1',                    // created AFTER the deploy
];

/** #3820's own log reason, from the ticket's Localization Reference. */
const REASON = 'Entlassmanagement-VO: Folge-VO sofort bestellen';

/** Created after `b103c748dbc` landed on staging — the only VOs that can show #3820 working. */
const POST_DEPLOY = ['99699-1', '99700-1', '99701-1', '99703-1', '99709-1'];

let api: APIRequestContext;
let page: D;
let vos: Vo[] = [];

test.describe('#3819 the Entlassmanagement badge + #3820 Bestellen at creation', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900_000);

  test.beforeAll(async () => {
    api = await pwRequest.newContext();
    page = new D(api);
    await page.init();
    vos = await page.vosByNumber(DISCHARGE_VOS);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'the fixtures are discharge VOs, and the flag is not selectable from the API',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async () => {
      // Prove the filter does nothing BEFORE any zero from it is believed (#3800) — otherwise a
      // population built on it silently returns the whole book and every later count is wrong.
      const base = await page.get<any>('/prescriptions?itemsPerPage=1');
      const yes = await page.get<any>('/prescriptions?itemsPerPage=1&isDischargeManagement=true');
      const no = await page.get<any>('/prescriptions?itemsPerPage=1&isDischargeManagement=false');
      const bogus = await page.get<any>('/prescriptions?itemsPerPage=1&zzzNotAFilter=1');
      console.log(`  /prescriptions total ${base.body?.totalItems}; =true ${yes.body?.totalItems}, =false ${no.body?.totalItems}, bogus ${bogus.body?.totalItems}`);
      expect(yes.body?.totalItems, 'isDischargeManagement=true is silently ignored').toBe(base.body?.totalItems);
      expect(no.body?.totalItems, 'and so is =false').toBe(base.body?.totalItems);

      const discharge = vos.filter((v) => v.isDischargeManagement);
      console.log(`  ${vos.length} fixtures read, ${discharge.length} carry the flag`);
      for (const v of discharge) {
        console.log(`    ${v.number.padEnd(11)} created ${String(v.createdAt).slice(0, 10)}  followup=${String(v.followupStatus).padEnd(12)} ordering=${String(v.orderingStatus).padEnd(18)} facility=${v.facility?.name} / ${v.facility?.orderingMode}`);
      }
      expect(discharge.length, 'the pinned fixtures still carry the flag').toBeGreaterThan(10);
      expect(vos.find((v) => v.number === D.TICKET_VO)?.isDischargeManagement,
        `${D.TICKET_VO} — the ticket's own QA fixture — is a discharge VO`).toBe(true);
    },
  );

  test(
    '#3819 DEPLOYED: the badge strings ship, and the component NAME proves nothing',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async () => {
      const { names, js } = await page.bundle();
      const de = D.occurrences(js, D.LABEL_DE);
      const en = D.occurrences(js, D.LABEL_EN);
      const key = D.occurrences(js, 'discharge_management');
      const field = D.occurrences(js, 'dischargeManagement');
      console.log(`  bundle ${names.join(',')} (${js.length} bytes)`);
      console.log(`  "${D.LABEL_DE}" ${de} · "${D.LABEL_EN}" ${en} · discharge_management ${key} · dischargeManagement ${field}`);
      expect(de, 'the German label ships').toBeGreaterThan(0);
      expect(en, 'the English label ships').toBeGreaterThan(0);
      expect(field, 'the row field the badge keys off is referenced').toBeGreaterThan(0);

      // DO NOT probe for the component name: minification renames it. `DeceasedBadge` has shipped
      // for releases and also reads 0, which is the control that makes that zero meaningless.
      const newBadge = D.occurrences(js, 'DischargeManagementBadge');
      const oldBadge = D.occurrences(js, 'DeceasedBadge');
      console.log(`  component names — DischargeManagementBadge ${newBadge}, DeceasedBadge ${oldBadge} (both minified away)`);
      expect(oldBadge, 'the long-shipped badge component is also absent by name').toBe(0);
      expect(newBadge, 'so the new one being absent by name says nothing either').toBe(0);
    },
  );

  test(
    '#3819 AC1/AC3: the badge renders on the Admin Board row, as an informational pill',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async ({ page: ui }) => {
      await D.openBoardAndSearch(ui, D.TICKET_VO);
      const badge = await D.badge(ui, D.LABEL_DE);
      console.log(`  badge: ${JSON.stringify(badge)}`);
      expect(badge, `the ${D.LABEL_DE} badge is painted on ${D.TICKET_VO}'s row`).toBeTruthy();
      expect(badge!.pill, 'and it sits on a pill').toBeTruthy();

      // AC1: "next to the VO number". The badge is STACKED UNDER the number inside the VO-number
      // cell — as the Verstorben badge sits under the patient name — so a left-to-right adjacency
      // check on the badge's own line finds no VO number and reports AC1 failing on a correct
      // build. The claim is about the CELL: it holds the number and the badge and nothing else.
      const cell = await D.voNumberCell(ui, D.TICKET_VO, D.LABEL_DE);
      console.log(`  VO-number cell: ${JSON.stringify(cell)}`);
      expect(cell, 'the VO number and the badge share one cell').toBeTruthy();
      expect(cell!.text.replace(/\s+/g, ''), 'and the cell holds exactly those two')
        .toBe(`${D.TICKET_VO}${D.LABEL_DE}`);
      expect(cell!.badgeY, 'the badge is below the VO number, not before it')
        .toBeGreaterThan(cell!.numberY);
      // The commit widened this column to fit the pill (v2 rail 112 -> 180).
      console.log(`  cell is ${cell!.w}x${cell!.h}px — the commit widened the v2 rail 112 -> 180`);
      expect(cell!.w, 'the column was widened to fit the pill').toBeGreaterThanOrEqual(170);
      const row = await D.rowLeaves(ui, badge!.y);
      console.log(`  badge line: ${row.map((l) => `${l.t}@${l.x}`).join(' | ')}`);

      // AC3: an informational pill, not an error one. Red dominating is what it must NOT be.
      const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(badge!.pill!.bg);
      expect(rgb, 'the pill has a real background colour').toBeTruthy();
      const [r, g, b] = [Number(rgb![1]), Number(rgb![2]), Number(rgb![3])];
      console.log(`  pill bg rgb(${r}, ${g}, ${b}) radius ${badge!.pill!.radius}`);
      expect(r, 'the pill does not read as an error — red does not dominate').toBeLessThanOrEqual(b);
      expect(badge!.pill!.radius, 'and it is a pill, not a box').toMatch(/999|50%/);
    },
  );

  test(
    '#3819 AC3: the same pill shape and size as the Verstorben badge',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async ({ page: ui }) => {
      // AC3 names the Verstorben badge explicitly, so it is measured rather than described: same
      // shape and size, DIFFERENT colour (that one is the error pair, this one informational).
      await D.openBoardAndSearch(ui, D.TICKET_VO);
      const discharge = await D.badge(ui, D.LABEL_DE);
      expect(discharge?.pill, 'the discharge badge is painted').toBeTruthy();

      const second = await ui.context().browser()!.newContext();
      const p2 = await second.newPage();
      await D.openBoardAndSearch(p2, D.DECEASED_VO);
      const deceased = await D.badge(p2, D.DECEASED_LABEL);
      console.log(`  Entlassmanagement: ${JSON.stringify(discharge)}`);
      console.log(`  Verstorben       : ${JSON.stringify(deceased)}`);
      expect(deceased?.pill, `the Verstorben badge is painted on ${D.DECEASED_VO}`).toBeTruthy();

      expect(discharge!.pill!.h, 'same pill height as Verstorben').toBe(deceased!.pill!.h);
      expect(discharge!.pill!.radius, 'same pill radius').toBe(deceased!.pill!.radius);
      expect(discharge!.fontSize, 'same text size').toBe(deceased!.fontSize);
      expect(discharge!.pill!.bg, 'but a different colour — informational, not the error pair')
        .not.toBe(deceased!.pill!.bg);
      await second.close();
    },
  );

  test(
    '#3819 AC1: the badge is on the card list at a small screen width',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async ({ page: ui }) => {
      await D.openBoardAndSearch(ui, D.TICKET_VO, undefined, 420);
      const badge = await D.badge(ui, D.LABEL_DE);
      console.log(`  at 420px: ${JSON.stringify(badge)}`);
      expect(badge, 'the badge is painted on the card').toBeTruthy();
      expect(badge!.x, 'and it is inside the narrow viewport').toBeLessThan(420);
      // A card is not a table row: the only claim AC1 makes here is that the badge is on the card.
      const row = await D.rowLeaves(ui, badge!.y, 24);
      console.log(`  card band: ${row.map((l) => l.t).join(' | ')}`);
      expect(row.some((l) => l.t.includes(D.TICKET_VO)) || row.length > 0,
        'the card carries content beside the badge').toBe(true);
    },
  );

  test(
    '#3819 AC2: a normal VO of the same hospital practice carries no badge',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async ({ page: ui }) => {
      // The AC calls this out because 18 of 30 hospital practices on the production copy have both
      // kinds — so a badge keyed off the PRACTICE rather than the VO would pass every other test.
      const all = await page.practiceVos(D.MIXED_PRACTICE.id);
      const normal = all.filter((v) => !v.isDischargeManagement);
      const discharge = all.filter((v) => v.isDischargeManagement);
      console.log(`  practice ${D.MIXED_PRACTICE.name}: ${all.length} VOs, ${discharge.length} discharge, ${normal.length} normal`);
      expect(discharge.length, 'the control practice really does issue discharge VOs too').toBeGreaterThan(0);
      // The control must be a row the board actually PAINTS, or "no badge" is vacuous: the default
      // board hides Archiviert, and a VO carrying no status at all never renders either.
      const visible = normal.filter((v) => v.treatmentStatus && v.treatmentStatus !== 'Archiviert');
      expect(visible.length, 'the practice has a board-visible normal VO to use as the control')
        .toBeGreaterThan(0);
      const control = visible[0];
      console.log(`  control: ${control.number} (${control.treatmentStatus}, discharge=${control.isDischargeManagement})`);

      await D.openBoardAndSearch(ui, control.number);
      // Prove the row is there before concluding anything from an absent badge.
      const painted = await D.rowLeaves(ui, 0, 10_000);
      const hasNumber = painted.some((l) => l.t.includes(control.number));
      console.log(`  row painted: ${hasNumber}; pager ${await D.pagerSummary(ui)}`);
      expect(hasNumber, `${control.number}'s row is painted — otherwise "no badge" proves nothing`).toBe(true);

      const badge = await D.badge(ui, D.LABEL_DE);
      console.log(`  badge on ${control.number}: ${badge ? 'PRESENT' : 'absent'}`);
      expect(badge, `${control.number} is a normal VO of a practice that also issues discharge VOs — no badge`)
        .toBeNull();
    },
  );

  test(
    '#3820: the guard the commit documents, which no AC states — and what it costs on staging',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async () => {
      // `b103c748dbc`: "a discharge VO at a facility that orders its own follow-ups (praxis_vo /
      // er_bestellt_selbst, #2617) keeps its status blank, as the nightly ordering run does."
      const discharge = vos.filter((v) => v.isDischargeManagement);
      const post = discharge.filter((v) => POST_DEPLOY.includes(v.number));
      expect(post.length, 'the post-deploy fixtures are present').toBeGreaterThan(0);

      const guarded = post.filter((v) => D.isGuarded(v));
      for (const v of post) {
        console.log(`  ${v.number.padEnd(9)} created ${String(v.createdAt).slice(0, 10)}  followup=${String(v.followupStatus).padEnd(6)} orderingStatus=${String(v.orderingStatus).padEnd(8)} facility=${v.facility?.name} (${v.facility?.orderingMode})  guarded=${D.isGuarded(v)}`);
      }
      console.log(`  -> ${guarded.length} of ${post.length} post-deploy discharge VOs sit behind the guard`);

      // Every guarded VO must keep a blank status — that IS the guard working.
      for (const v of guarded) {
        expect(v.followupStatus, `${v.number} is guarded, so its Folge-VO status stays blank`).toBeNull();
        expect(v.orderDate, `${v.number} has no order date either`).toBeNull();
      }

      // And the guard's two readings must agree, which is the claim the commit makes.
      for (const v of discharge) {
        const byFacility = v.facility?.orderingMode != null
          && D.SELF_ORDERING_MODES.includes(v.facility.orderingMode);
        const byVo = v.orderingStatus === 'Praxis' || v.orderingStatus === 'ER bestellt selbst';
        expect(byVo, `${v.number}: the facility's ordering mode and the VO's ordering status agree`)
          .toBe(byFacility);
      }

      // The finding: staging cannot exercise the positive path at all.
      expect(guarded.length, 'FINDING: every post-deploy discharge VO on staging is guarded')
        .toBe(post.length);
      console.log('  FINDING: the positive path of #3820 AC1 has no staging fixture — every');
      console.log('  discharge VO created since the deploy is at a praxis_vo facility, so a PM');
      console.log("  following the ticket's QA steps on these VOs sees no Bestellen and would");
      console.log('  report the ticket as broken. See docs/manual-test-3819-3820-discharge-marker.md');
    },
  );

  test(
    '#3820 AC5/AC6: a status already set is never overwritten, and existing data is not corrected',
    { tag: ['@SuperAdmin', '@DischargeMarker', '@ReadOnly'] },
    async () => {
      const discharge = vos.filter((v) => v.isDischargeManagement);

      // AC6: "VOs that exist today keep their Folge-VO status. There is no correction of existing
      // data." The evidence is the VOs that were ALREADY blank when the fix shipped and are blank
      // still — a backfill would have moved them.
      //
      // Their ORDER DATES are not evidence and must not be used as such: #3800's nightly expiry
      // sets a blank Folge-VO status to Bestellen as it expires a VO, so 99664-1 (created 09-25)
      // carries an order date of 09-26 and 99671-1 one of 10-01, both AFTER this fix shipped and
      // neither written by it. An "order date predates the deploy" check therefore fails on a
      // correct build.
      const pre = discharge.filter((v) => v.createdAt! < '2026-09-26');
      const stillBlank = pre.filter((v) => v.followupStatus === null);
      console.log(`  ${pre.length} discharge VOs predate the deploy, ${stillBlank.length} still blank:`);
      for (const v of pre) {
        console.log(`    ${v.number.padEnd(11)} created ${String(v.createdAt).slice(0, 10)} followup=${String(v.followupStatus).padEnd(12)} orderDate=${String(v.orderDate).slice(0, 10)}`);
      }
      expect(pre.length, 'there are pre-deploy discharge VOs to judge').toBeGreaterThan(0);
      expect(stillBlank.length, 'AC6: VOs that were blank at the deploy are blank still — no backfill')
        .toBeGreaterThan(0);

      // And nothing anywhere carries this fix's own reason — which is the other half of the
      // finding above: with every candidate behind the praxis_vo guard, #3820 has never fired on
      // staging, so its deployment is not decidable from a client at all.
      // Match the EXACT reason. A loose "Entlassmanagement" substring finds #3800's expiry reasons
      // ("Entlassmanagement: Behandlungsbeginn nicht innerhalb von 7 Tagen …") on most of these
      // VOs and reports them as this fix having fired — which it has not.
      let withReason = 0; let expiryReasons = 0;
      for (const v of discharge.slice(0, 12)) {
        const logs = await page.logs(v.id);
        for (const l of logs) {
          const blob = JSON.stringify(l);
          if (blob.includes(REASON)) { withReason += 1; console.log(`    ${v.number}: ${REASON}`); }
          else if (/Entlassmanagement: Behandlung/.test(blob)) expiryReasons += 1;
        }
      }
      console.log(`  entries carrying THIS fix's reason ("${REASON}"): ${withReason}`);
      console.log(`  entries carrying #3800's EXPIRY reason (a different thing): ${expiryReasons}`);
      expect(withReason, 'no discharge VO carries this fix\'s reason — it has never fired here').toBe(0);
      console.log('  -> #3820 has never fired here, so "deployed" and "not deployed" look identical');
      console.log('     from a client: the commit adds no route and no serialized field, and');
      console.log('     GET /status reports the release, not the commit (#3704).');

      // AC5: the nightly run only picks VOs whose Folge-VO status is empty, so a VO already in
      // "Bestellen" is never re-evaluated. Its own log is the evidence: one move into `order`.
      const inOrder = discharge.filter((v) => v.followupStatus === 'order');
      expect(inOrder.length, 'some discharge VOs are in Bestellen').toBeGreaterThan(0);
      //
      // Count moves across BOTH log types. #3800's expiry writes `field_change` on
      // `followupStatus`, not `follow_up_status_change`, so a check that reads only the latter
      // returns 0 on every one of these VOs and passes without testing anything.
      let checked = 0; let seenMoves = 0;
      for (const v of inOrder.slice(0, 8)) {
        const logs = await page.logs(v.id);
        const moves = logs.filter((l) => {
          if (l.newValue !== 'order') return false;
          if (l.type === 'follow_up_status_change') return true;
          return l.type === 'field_change' && l.meta?.field === 'followupStatus';
        });
        seenMoves += moves.length;
        console.log(`  ${v.number}: ${moves.length} move(s) into order via ${JSON.stringify(moves.map((m) => m.type))}`);
        expect(moves.length, `${v.number} was moved into order at most once — never re-evaluated`)
          .toBeLessThanOrEqual(1);
        checked += 1;
      }
      console.log(`  ${checked} VOs checked, ${seenMoves} moves into order seen in total`);
      expect(checked, 'logs were actually read').toBeGreaterThan(0);
      expect(seenMoves, 'and the check is not vacuous — real moves into order were found')
        .toBeGreaterThan(0);
    },
  );
});
