import { test, expect } from '../../fixtures/session';
import {
  AERZTE_ALLOWLIST,
  DuplikatStatus,
  DEADLINE_RED_AT_DAYS,
  DUPLIKAT,
  DuplikatProcessPage,
  DuplikatRow,
  FIXTURES,
  OPEN_STATUSES,
  STAGING_TEST_ACCOUNT_IDS,
  STATUS_BACKGROUND,
  TEST_ACCOUNT_CONTROL_VO,
} from '../../../Pages/superadmin/sa.duplikat-process.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';
import { STAGING_CREDENTIALS, mintUiSession } from '../../../Pages/util/api-token';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.13 #3505 (the Ärzte-Management board's "Duplikat-Anforderungen" section, PR #3558) and
 * #3507 (the worklist's four extra columns, sorting and default prioritization, PR #3555).
 *
 * The two are tested together because #3507's columns land in the ONE shared `DuplikatWorklist`
 * component both boards render, which is also what makes #3505 AC3 and #3507 AC6 true by
 * construction — and the only way to see that is to read both surfaces in one run.
 *
 * The fixture set is chosen for #3507 specifically: `TIE_HIGH` (4.347,09 €) and `TIE_LOW`
 * (250,08 €) share a billing deadline, `FAR` sits two months later, and `NO_DEADLINE` has no
 * documented treatment at all. That is the only arrangement that can tell AC5's
 * "soonest deadline first, highest value breaking a tie" apart from any other ordering — a set of
 * rows with distinct deadlines would pass under half a dozen wrong comparators.
 *
 * Fixtures owned here: `TIE_HIGH`, `TIE_LOW`, `FAR`, `NO_DEADLINE` and the test-account control.
 */
test.describe('#3505/#3507 — Ärzte-Management Duplikat section, columns and sorting', () => {
  test.describe.configure({ mode: 'serial' });

  const OWNED = [FIXTURES.TIE_HIGH, FIXTURES.TIE_LOW, FIXTURES.FAR, FIXTURES.NO_DEADLINE];
  /** An ended, unbilled VO that is deliberately NEVER put into the process — AC1's negative half. */
  const NEVER_FLAGGED_VO = 8184;

  let duplikat: DuplikatProcessPage;

  test.beforeEach(async ({ page }) => {
    duplikat = new DuplikatProcessPage(page);
    await duplikat.connect();
  });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const setup = new DuplikatProcessPage(page);
    await setup.connect();
    for (const fixture of OWNED) await setup.enterProcess(fixture.id, DUPLIKAT.ANFORDERN);
    // The negative control: a VO on a therapist marked `isTestAccount` must stay off both boards.
    await setup.enterProcess(TEST_ACCOUNT_CONTROL_VO.id, DUPLIKAT.ANFORDERN);
    // Let the writes clear the KPI cache before any test reads a board, or the first one races them.
    for (const fixture of OWNED) await setup.waitForWorklistRow(fixture.id, DUPLIKAT.ANFORDERN);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    const cleanup = new DuplikatProcessPage(page);
    await cleanup.connect();
    for (const fixture of OWNED) await cleanup.dismiss(fixture.id);
    await cleanup.dismiss(TEST_ACCOUNT_CONTROL_VO.id);
    await page.close();
  });

  // ────────────────────────────────── #3505: the section's data ──────────────────────────────────

  test(
    'AC1 the section lists every VO in the process, and only those',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      const rows = await duplikat.worklist();
      const ids = rows.map((r) => r.prescriptionId);

      for (const fixture of OWNED) {
        expect(ids, `VO ${fixture.vo} is in the process and must be listed`).toContain(fixture.id);
      }
      expect(
        ids,
        `VO ${NEVER_FLAGGED_VO} has never had a Duplikat status, so it must not appear`,
      ).not.toContain(NEVER_FLAGGED_VO);

      // The list is "in the process": the three open statuses plus AC8's billed rows. The two
      // dismissals have left the process and are excluded in the candidate query, which is what the
      // other spec's AC6 test drives; here it is asserted as a property of the whole list.
      for (const row of rows) {
        expect(
          [...OPEN_STATUSES, DUPLIKAT.ABGERECHNET],
          `VO ${row.voNumber} carries ${row.duplikatStatus}`,
        ).toContain(row.duplikatStatus!);
      }
    },
  );

  test(
    '#3182 a VO on a test account stays off both boards',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      // `DuplikatWorklistCandidates` joins `user t ON … AND t.is_test_account = 0`. The Orga board
      // would drop the row anyway through its therapist population; the Ärzte board is unscoped, so
      // without the rule in the query itself it would show QA data to the doctor-management team.
      //
      // This is also the trap that makes the whole feature look broken: staging marks THREE accounts
      // as test accounts today — 6 (Sandra Zeibig), 31 and 198 (Jhenqa Test) — so a VO flagged on a
      // QA therapist's caseload is invisible everywhere.
      expect(STAGING_TEST_ACCOUNT_IDS).toContain(TEST_ACCOUNT_CONTROL_VO.therapistId);
      expect(await duplikat.duplikatStatusOf(TEST_ACCOUNT_CONTROL_VO.id), 'the control IS in the process')
        .toBe(DUPLIKAT.ANFORDERN);

      const worklist = await duplikat.worklist();
      expect(
        worklist.map((r) => r.prescriptionId),
        `VO ${TEST_ACCOUNT_CONTROL_VO.vo} is on a test account and must be excluded`,
      ).not.toContain(TEST_ACCOUNT_CONTROL_VO.id);

      const orga = DuplikatProcessPage.duplikatRows((await duplikat.orgaRisks()).rows);
      expect(orga.map((r) => r.prescriptionId)).not.toContain(TEST_ACCOUNT_CONTROL_VO.id);
    },
  );

  test(
    'AC3/AC6 both boards serve the same rows, field for field, in the same order',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      test.setTimeout(420_000);

      // The two reads are ~20 s apart (`/kpis/orga/risks` carries 5,000+ rows), so a sibling spec
      // writing in between would show up as a spurious mismatch. The pair is therefore only
      // compared once the worklist reads identically either side of it — the "two counts from
      // different renders" rule, applied to two endpoints.
      let worklist = await duplikat.worklist();
      let orga: DuplikatRow[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        orga = DuplikatProcessPage.duplikatRows((await duplikat.orgaRisks()).rows);
        const again = await duplikat.worklist();
        if (JSON.stringify(again) === JSON.stringify(worklist)) break;
        worklist = again;
      }

      // The two providers narrow one shared candidate query differently (the Orga board to its
      // therapist population, the Ärzte board not at all), so on a population whose therapists are
      // all active the two lists must be identical — which is #3505 AC3 and #3507 AC6 in one check.
      expect(orga.map((r) => r.prescriptionId), 'same rows, same order').toEqual(
        worklist.map((r) => r.prescriptionId),
      );
      const byId = new Map(orga.map((r) => [r.prescriptionId, r]));
      for (const row of worklist) {
        expect(byId.get(row.prescriptionId), `VO ${row.voNumber} field for field`).toEqual(row);
      }
    },
  );

  test(
    'AC3 a status change made against one board is what the other board reads',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      test.setTimeout(300_000);
      const fixture = FIXTURES.FAR;
      await duplikat.setStatusOk(fixture.id, DUPLIKAT.ERHALTEN);

      // Poll the fast endpoint until the write has cleared the KPI cache, THEN read the slow one —
      // reading either immediately after the POST races the invalidation.
      const onAerzte = await duplikat.waitForWorklistRow(fixture.id, DUPLIKAT.ERHALTEN);
      const onOrga = DuplikatProcessPage.duplikatRows((await duplikat.orgaRisks()).rows)
        .find((r) => r.prescriptionId === fixture.id);
      expect(onAerzte.duplikatStatus).toBe(DUPLIKAT.ERHALTEN);
      expect(onOrga?.duplikatStatus, 'there is one list, read twice').toBe(DUPLIKAT.ERHALTEN);

      await duplikat.setStatusOk(fixture.id, DUPLIKAT.ANFORDERN);
      await duplikat.waitForWorklistRow(fixture.id, DUPLIKAT.ANFORDERN);
    },
  );

  test(
    'AC4 the board is reachable by a Super Admin and by nobody outside the rule',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      // `FlowBoardVoter::AERZTE_MANAGEMENT` is `ROLE_SUPER_ADMIN OR email ∈ AERZTE_MANAGEMENT_ALLOWLIST`.
      // The Super-Admin arm is what this account exercises; see the fixme for why the allowlist arm
      // cannot be told apart from it here.
      expect(await duplikat.worklistStatus(await duplikat.tokenFor(STAGING_CREDENTIALS.superadmin))).toBe(200);
      expect(
        await duplikat.worklistStatus(await duplikat.tokenFor(STAGING_CREDENTIALS.admin)),
        'a plain admin is not doctor-management staff',
      ).toBe(403);
      expect(
        await duplikat.worklistStatus(await duplikat.tokenFor(STAGING_CREDENTIALS.therapist)),
      ).toBe(403);
    },
  );

  test(
    'AC4 the three named staff exist, and two of them can only get in through the allowlist',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      // Newly checkable: staging's `AERZTE_MANAGEMENT_ALLOWLIST` held only
      // `superadmin@test.therapios.com` — matching no staging user — until `80b2741a8` brought it in
      // line with the live stack on 2026-09-10. AC4's three staff are now on it.
      const users = await duplikat.usersByEmail();

      for (const staff of AERZTE_ALLOWLIST.staff) {
        const user = users.get(staff.email);
        expect(user, `AC4 names ${staff.email} — the account must exist on staging`).toBeTruthy();
        expect(user!.id, `${staff.email} id`).toBe(staff.userId);
        expect(user!.active, `${staff.email} must be active`).toBe(true);
        expect(user!.roles, `${staff.email} role`).toContain(staff.role);
      }

      // The distinction that decides what AC4 can actually demonstrate: `FlowBoardVoter` grants on
      // ROLE_SUPER_ADMIN **or** an allowlisted email, so a super admin on the list proves nothing
      // about the list. Two of the three are plain ROLE_ADMIN, and a plain ROLE_ADMIN *off* the list
      // is denied (the access test above) — so for those two the allowlist is the only thing that
      // could let them in.
      const viaAllowlistOnly = AERZTE_ALLOWLIST.staff.filter((s) => s.demonstratesAllowlist);
      expect(viaAllowlistOnly.length, 'at least one listed account must be a plain admin').toBeGreaterThan(0);
      for (const staff of viaAllowlistOnly) {
        expect(users.get(staff.email)!.roles, `${staff.email} must NOT be a super admin`).not.toContain('ROLE_SUPER_ADMIN');
      }
      console.log(
        `#3505 AC4: allowlist accounts on staging — ` +
          AERZTE_ALLOWLIST.staff
            .map((s) => `${users.get(s.email)!.fullName} (${users.get(s.email)!.roles.filter((r) => 'ROLE_USER' !== r).join('/')})`)
            .join(', ') +
          `; the allowlist arm is demonstrated only by ${viaAllowlistOnly.length} of them`,
      );
    },
  );

  test(
    'AC2/AC5 the localization table ships in the deployed dictionary',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async ({ page }) => {
      const { de } = await new TranslationsPage(page).loadDictionaries();
      const expected: Record<string, string> = {
        'flowBoards.duplikatAnforderungenTitle': 'Duplikat-Anforderungen',
        'flowBoards.duplikatAlleStatus': 'Alle Status',
        'flowBoards.duplikatEmptyForStatus': 'Keine VOs mit diesem Status.',
        'flowBoards.inVorbereitung': 'In Vorbereitung',
        // #3507's column heads. NOTE: the VO column is deliberately NOT in this list any more —
        // see the assertion below.
        'flowBoards.duplikatAusstellungsdatum': 'Ausstellungsdatum',
        'flowBoards.duplikatRegion': 'Region',
        'flowBoards.duplikatAbrechnungBis': 'Abrechnung möglich bis',
      };
      for (const [key, value] of Object.entries(expected)) {
        expect(de[key], `de.json ${key}`).toBe(value);
      }

      // `flowBoards.duplikatVo` ("VO-Nr.") was DELETED when #3774 moved both boards onto the one
      // shared RiskWorklist: the VO column is now rendered from the shared `drilldownVoNumber`
      // ("VO #"), which is why #3774's GROUP_COLUMNS records the header as "VO #" and not "VO-Nr.".
      // Asserted as a pair so a future re-introduction of a duplikat-specific key is visible rather
      // than silently reinstating two keys for one column — the exact drift #3711 flagged.
      expect(de['flowBoards.duplikatVo'], 'the duplikat-specific VO key is retired').toBeUndefined();
      expect(de['flowBoards.drilldownVoNumber'], 'and the shared one renders that column').toBe('VO #');
    },
  );

  test(
    'the Gesellschaft filter narrows by the VO\'s own entity',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      // The Ärzte board's header picker filters on `prescription.entity` (the Admin-Performance
      // convention), NOT on the therapist's entity the Orga board uses — a documented asymmetry.
      const all = await duplikat.worklist();
      const entities = new Set(OWNED.map((f) => f.entityId));
      for (const entityId of entities) {
        const scoped = await duplikat.worklist(entityId);
        const expectedIds = OWNED.filter((f) => f.entityId === entityId).map((f) => f.id);
        for (const id of expectedIds) {
          expect(scoped.map((r) => r.prescriptionId), `entity=${entityId} must keep VO ${id}`).toContain(id);
        }
        for (const row of scoped) {
          expect(all.map((r) => r.prescriptionId), 'a scoped row is always an unscoped row').toContain(row.prescriptionId);
        }
        expect(scoped.length, `entity=${entityId} narrows`).toBeLessThanOrEqual(all.length);
      }

      // A Gesellschaft id that does not exist answers 200 with an empty list, indistinguishable from
      // one that legitimately holds no Duplikat VOs — the same shape #3493 records for its export.
      expect(await duplikat.worklist(999_999), 'an unknown entity id is not an error').toHaveLength(0);
    },
  );

  // ─────────────────────────────── #3507: columns and prioritization ───────────────────────────────

  test(
    'AC2 the billing deadline is the first of the month after the last treatment, plus 9 months',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      // The ticket's own worked example, against the ported formula — this guards the oracle, not
      // the app.
      expect(DuplikatProcessPage.expectedBillingDeadline('2026-03-19')).toBe('2027-01-01');

      // And the app, against the oracle, over every row the worklist serves — each row's deadline
      // re-derived from that VO's own `lastTreatmentDate`, which is what the SQL sub-select computes.
      const rows = await duplikat.worklist();
      expect(rows.length, 'there must be rows to check').toBeGreaterThan(0);
      for (const row of rows) {
        const vo = await duplikat.vo(row.prescriptionId);
        const lastTreatment: string | null = vo.lastTreatmentDate ?? null;
        expect(
          row.billingDeadline,
          `VO ${row.voNumber}: last treatment ${lastTreatment} → deadline`,
        ).toBe(DuplikatProcessPage.expectedBillingDeadline(lastTreatment));
        expect(
          row.daysToDeadline,
          `VO ${row.voNumber}: days to ${row.billingDeadline}`,
        ).toBe(DuplikatProcessPage.expectedDaysToDeadline(row.billingDeadline));
      }

      // A VO with no documented treatment has no deadline at all — a dash on the board, and last in
      // the default order.
      const noDeadline = rows.find((r) => r.prescriptionId === FIXTURES.NO_DEADLINE.id);
      expect(noDeadline?.billingDeadline, `VO ${FIXTURES.NO_DEADLINE.vo} has no treatments`).toBeNull();
      expect(noDeadline?.daysToDeadline).toBeNull();
    },
  );

  test(
    'AC1 every row carries VO-Nr., Ausstellungsdatum, Region and the deadline',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      const rows = await duplikat.worklist();
      for (const fixture of OWNED) {
        const row = rows.find((r) => r.prescriptionId === fixture.id)!;
        expect(row.voNumber, 'VO-Nr.').toBe(fixture.vo);
        expect(row.issueDate, `Ausstellungsdatum on ${fixture.vo}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // AC1 is explicit that Region is the PRESCRIBING PRACTICE's region — Flow has no
        // therapist-level region — so it is checked against the practice, not the treating therapist.
        expect(row.region, `Region on ${fixture.vo} comes from practice ${fixture.practiceId}`).toBe(fixture.region);
        expect(row.practiceName).toBe(fixture.practiceName);
      }
    },
  );

  test(
    'AC5/AC6 the default order is soonest deadline first, highest value breaking a tie, no-deadline last',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
    async () => {
      test.setTimeout(300_000);
      const rows = await duplikat.worklist();

      // The whole list, against the ported comparator: an invariant that holds however many other
      // rows a parallel spec has put into the process.
      expect(
        rows.map((r) => r.prescriptionId),
        'the served order is `applyDefaultOrder`',
      ).toEqual(DuplikatProcessPage.applyDefaultOrder(rows).map((r) => r.prescriptionId));

      // And the arrangement that makes the rule falsifiable, spelled out. TIE_HIGH and TIE_LOW share
      // a deadline, so only the revenue tie-break can put them in this order; FAR's deadline is
      // later; NO_DEADLINE has none and must be last of the four.
      const index = (id: number) => rows.findIndex((r) => r.prescriptionId === id);
      const tieHigh = rows.find((r) => r.prescriptionId === FIXTURES.TIE_HIGH.id)!;
      const tieLow = rows.find((r) => r.prescriptionId === FIXTURES.TIE_LOW.id)!;
      expect(tieLow.billingDeadline, 'precondition: the two tie rows share a deadline').toBe(tieHigh.billingDeadline);
      expect(tieHigh.revenue).toBeGreaterThan(tieLow.revenue);
      expect(index(FIXTURES.TIE_HIGH.id), 'higher value first within a deadline tie')
        .toBeLessThan(index(FIXTURES.TIE_LOW.id));
      expect(index(FIXTURES.TIE_LOW.id), 'a later deadline sorts after an earlier one')
        .toBeLessThan(index(FIXTURES.FAR.id));
      expect(index(FIXTURES.FAR.id), 'a row with no deadline sorts last')
        .toBeLessThan(index(FIXTURES.NO_DEADLINE.id));

      // AC6: the Orga board applies the same order, from the same shared `applyDefaultOrder()`.
      const orga = DuplikatProcessPage.duplikatRows((await duplikat.orgaRisks()).rows);
      expect(orga.map((r) => r.prescriptionId)).toEqual(rows.map((r) => r.prescriptionId));
    },
  );

  // ───────────────────────────────────── the board on screen ─────────────────────────────────────

  test.describe('the Ärzte-Management board on screen', () => {
    test.describe.configure({ mode: 'serial' });

    let boards: FlowBoardsPage;
    let served: DuplikatRow[];

    test.beforeEach(async ({ page }) => {
      test.setTimeout(300_000);
      served = await duplikat.worklist();
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      boards = new FlowBoardsPage(page);
      await boards.open();
      await boards.openTab('Ärzte-Management');
      await expect(page.getByTestId(DuplikatProcessPage.UI.section)).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId(DuplikatProcessPage.UI.worklist)).toBeVisible({ timeout: 120_000 });
    });

    test(
      'AC1/AC5 the section replaces the placeholder for this list only, which stays below it',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        const section = page.getByTestId(DuplikatProcessPage.UI.section);
        await expect(section).toContainText('Duplikat-Anforderungen');

        // AC1: the painted rows are the served rows, in the served order (#3507 AC6).
        expect(await duplikat.paintedRowIds()).toEqual(served.map((r) => r.prescriptionId));

        // AC5: the rest of the board is untouched — "In Vorbereitung" and its description still
        // stand underneath the new section.
        await expect(page.getByText('In Vorbereitung', { exact: true }).first()).toBeVisible();
        await expect(
          page.getByText(/Hier kommt die Arzt-\/Verordner-Steuerung hin/),
          'the placeholder copy for the rest of the board',
        ).toBeVisible();
      },
    );

    test(
      'AC1/AC3 the ten columns of #3503 and #3507 render, populated, in the prototype order',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        const headers = await page.evaluate(() => {
          const table = document.querySelector('[data-testid="duplikat-worklist"]') as HTMLElement;
          return table.innerText.split('\n').filter(Boolean);
        });
        // The header rail is the first block of the flattened table text.
        for (const [i, head] of DuplikatProcessPage.COLUMN_HEADERS.entries()) {
          expect(headers[i], `column ${i}`).toBe(head);
        }

        // #3507 AC3: the countdown badge, red at 60 days or fewer (negative included), neutral
        // above, and absent when there is no deadline. Colours are read back with getComputedStyle
        // rather than eyeballed.
        for (const row of served) {
          const badge = await duplikat.deadlineBadge(row.prescriptionId);
          if (null === row.daysToDeadline) {
            expect(badge, `VO ${row.voNumber} has no deadline, so no badge`).toBeNull();
            continue;
          }
          expect(badge, `VO ${row.voNumber} must carry a countdown`).toBeTruthy();
          expect(badge!.text).toBe(`(${row.daysToDeadline} T.)`);
          const red = row.daysToDeadline <= DEADLINE_RED_AT_DAYS;
          expect(
            badge!.color,
            `VO ${row.voNumber} at ${row.daysToDeadline} days must be ${red ? 'red' : 'neutral'}`,
          ).toBe(red ? 'rgb(199, 46, 9)' : 'rgb(93, 93, 93)');
        }

        // #3503 AC8's colour table, asserted as a property of the PAINTED cell: the colour must
        // match the status the cell itself shows.
        //
        // Deliberately not joined to the `served` payload. That read happens at a different moment
        // from the render — and an earlier test in this file moves a fixture's status — so a payload
        // that says Anfordern against a cell that says Erhalten is two truths about two instants,
        // not a defect. (It failed exactly that way once: VO 3485-5 painted amber against a red
        // snapshot.) The internal check is also the stronger reading of AC8.
        for (const row of served) {
          const cell = await duplikat.statusCellBackground(row.prescriptionId);
          expect(cell.status, `VO ${row.voNumber} must paint a Duplikat status`).toBeTruthy();
          expect(
            cell.background,
            `VO ${row.voNumber} paints "${cell.status}", which AC8 colours ${STATUS_BACKGROUND[cell.status as DuplikatStatus]}`,
          ).toBe(STATUS_BACKGROUND[cell.status as DuplikatStatus]);
        }
        // And the population as a whole still shows only statuses AC8 has a colour for.
        const painted = await Promise.all(served.map((r) => duplikat.statusCellBackground(r.prescriptionId)));
        expect(
          [...new Set(painted.map((c) => c.status))].every((status) => status! in STATUS_BACKGROUND),
          'every painted status is one AC8 defines a colour for',
        ).toBe(true);
      },
    );

    test(
      'AC2 the status chips default to "Alle Status", narrow the list, and restore it',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        // The five chips the AC names.
        await expect(page.getByTestId(DuplikatProcessPage.UI.chipAll)).toHaveText('Alle Status');
        for (const status of [DUPLIKAT.ANFORDERN, DUPLIKAT.ERHALTEN, DUPLIKAT.VERSENDET, DUPLIKAT.ABGERECHNET]) {
          await expect(page.getByTestId(DuplikatProcessPage.UI.chip(status))).toHaveText(status);
        }

        const initial = await duplikat.chipSelection();
        expect(
          initial.find((c) => c.id === DuplikatProcessPage.UI.chipAll)?.selected,
          '"Alle Status" is selected by default',
        ).toBe(true);
        expect(initial.filter((c) => c.selected), 'exactly one chip is selected').toHaveLength(1);

        // Narrowing to a status that has rows.
        const present = served.find((r) => r.duplikatStatus === DUPLIKAT.ANFORDERN)!;
        await page.getByTestId(DuplikatProcessPage.UI.chip(DUPLIKAT.ANFORDERN)).click();
        await expect
          .poll(() => duplikat.paintedRowIds(), { timeout: 30_000 })
          .toEqual(served.filter((r) => r.duplikatStatus === DUPLIKAT.ANFORDERN).map((r) => r.prescriptionId));
        expect(await duplikat.paintedRowIds()).toContain(present.prescriptionId);

        // Narrowing to a status that has none: the section says so in its own words rather than
        // borrowing the worklist's "nothing is in the process" copy.
        await page.getByTestId(DuplikatProcessPage.UI.chip(DUPLIKAT.ABGERECHNET)).click();
        await expect(page.getByTestId(DuplikatProcessPage.UI.emptyForStatus)).toHaveText(
          'Keine VOs mit diesem Status.',
          { timeout: 30_000 },
        );
        expect(await duplikat.paintedRowIds()).toEqual([]);

        await page.getByTestId(DuplikatProcessPage.UI.chipAll).click();
        await expect
          .poll(() => duplikat.paintedRowIds(), { timeout: 30_000 })
          .toEqual(served.map((r) => r.prescriptionId));
      },
    );

    test(
      'AC4 the worklist sorts by therapist, practice and billing deadline, and a third press restores the server order',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        const serverOrder = served.map((r) => r.prescriptionId);
        const byNullableString = (rows: DuplikatRow[], pick: (r: DuplikatRow) => string | null, dir: 1 | -1) =>
          [...rows].sort((a, b) => {
            const x = pick(a);
            const y = pick(b);
            if (x === y) return 0;
            if (null == x) return 1;
            if (null == y) return -1;
            return x.localeCompare(y) * dir;
          }).map((r) => r.prescriptionId);

        const cases: Array<{ key: 'therapist' | 'praxis' | 'deadline'; pick: (r: DuplikatRow) => string | null }> = [
          { key: 'therapist', pick: (r) => r.therapistName },
          { key: 'praxis', pick: (r) => r.practiceName },
          { key: 'deadline', pick: (r) => r.billingDeadline },
        ];

        for (const { key, pick } of cases) {
          const header = page.getByTestId(DuplikatProcessPage.UI.sort(key));
          // First press is descending, second ascending, third clears back to AC5's server order.
          await header.click();
          await expect.poll(() => duplikat.paintedRowIds(), { timeout: 20_000 }).toEqual(byNullableString(served, pick, -1));
          await header.click();
          await expect.poll(() => duplikat.paintedRowIds(), { timeout: 20_000 }).toEqual(byNullableString(served, pick, 1));
          await header.click();
          await expect
            .poll(() => duplikat.paintedRowIds(), { timeout: 20_000 })
            .toEqual(serverOrder);
        }
      },
    );

    test(
      'the status chips carry no readable selected state for a screen reader',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        // `accessibilityState={{ selected }}` never reaches the DOM under React Native Web — the
        // same gap #3400 found on the date-basis popover's `aria-expanded` and #3343 found on the
        // export-problems marker. The chips are `role="radio"` inside a `role="radiogroup"`, so a
        // screen reader announces five radios and cannot say which one is active; the only signal is
        // the border colour. Reported rather than asserted as correct.
        const chips = await duplikat.chipSelection();
        expect(chips, 'the chips are radios in a radiogroup').not.toHaveLength(0);
        for (const chip of chips) {
          expect(chip.role, `${chip.id} role`).toBe('radio');
          expect(chip.ariaChecked, `${chip.id} has no aria-checked/aria-selected`).toBeNull();
        }
      },
    );
  });

  // ───────────────────────────────── what cannot be reached here ─────────────────────────────────
});
