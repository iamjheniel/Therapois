import { test, expect } from '../../fixtures/session';
import {
  DUPLIKAT,
  DuplikatProcessPage,
  FIXTURES,
  OPEN_STATUSES,
  OVERDUE_WEEKS,
  RC_313_STAGING_DEPLOY,
  SELECTABLE_STATUSES,
  STATUS_BACKGROUND,
} from '../../../Pages/superadmin/sa.duplikat-process.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';
import { STAGING_CREDENTIALS, mintUiSession } from '../../../Pages/util/api-token';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.13 #3503 (Duplikat status lifecycle on the Therapeuten-Orga board) and #3504 (the per-VO
 * activity log), which shipped as one commit (`d58085d8d`) plus one AC-gap PR (#3537).
 *
 * Deployed on staging since 2026-09-09 02:38 UTC — and completely unexercised there, which is the
 * fact this file is built around: it MANUFACTURES the population it asserts on, through the same
 * `POST /prescriptions/{id}/duplikat-status` route the board's dropdown posts, and dismisses its
 * fixtures again at the end (AC6's own way out, which restores the tile and the worklist).
 *
 * Fixtures owned here: `OVERDUE` (VO 3114-4) and `TIE_MID` (VO 5366-2). Nothing else touches them,
 * so this file can run beside the other two Duplikat specs — every count assertion is an invariant
 * over one payload rather than a hard-coded total.
 */
test.describe('#3503/#3504 — Duplikat status lifecycle and activity log', () => {
  test.describe.configure({ mode: 'serial' });

  let duplikat: DuplikatProcessPage;

  test.beforeEach(async ({ page }) => {
    duplikat = new DuplikatProcessPage(page);
    await duplikat.connect();
  });

  // ─────────────────────────────── deployment + the empty baseline ───────────────────────────────

  test(
    'AC1/AC8 the Duplikat surfaces are deployed and serve the documented row shape',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async ({ page }) => {
      const risks = await duplikat.orgaRisks();
      expect(
        Object.keys(risks.tiles),
        'the Therapeuten-Orga board must carry a fourth "Duplikat offen" tile',
      ).toContain('duplikatOffen');

      // The row shape is what #3503 AC8 and #3507 AC1 are read off, so it is pinned here once
      // rather than re-derived in every later assertion.
      expect(risks.rows.length, 'the Orga board must serve rows').toBeGreaterThan(0);
      for (const field of [
        'duplikatStatus', 'practiceName', 'duplikatChangedAt',
        'issueDate', 'region', 'billingDeadline', 'daysToDeadline',
      ]) {
        expect(Object.keys(risks.rows[0]), `risk rows must carry \`${field}\``).toContain(field);
      }

      // #3505's endpoint answers for a Super Admin and returns the single-element collection the
      // client reads `member[0].rows` from.
      const worklist = await duplikat.worklist();
      expect(Array.isArray(worklist), 'GET /kpis/duplikat/worklist must serve rows').toBe(true);
      console.log(
        `#3501 deployment: duplikatOffen tile = ${risks.tiles.duplikatOffen}, ` +
          `worklist rows = ${worklist.length}, orga rows = ${risks.rows.length}`,
      );
    },
  );

  test(
    'the localization table ships in the deployed dictionary',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async ({ page }) => {
      const { de } = await new TranslationsPage(page).loadDictionaries();

      // #3503's own localization table. The six status words are enum VALUES, not keys — they are
      // stored as the German label — so the dictionary only has to carry the chrome around them.
      const expected: Record<string, string> = {
        'flowBoards.riskDuplikatTitle': 'Duplikat offen',
        'flowBoards.duplikatPraxis': 'Praxis',
        'flowBoards.duplikatLetzteAktivitaet': 'Letzte Aktivität',
        'flowBoards.duplikatStatus': 'Duplikat-Status',
        'flowBoards.duplikatAnfordernAction': 'Duplikat anfordern',
        // #3504's table.
        'flowBoards.duplikatVerlauf': 'Verlauf ({{count}})',
        'flowBoards.duplikatSystem': 'System',
        'flowBoards.duplikatKommentarPlaceholder': 'Kommentar hinzufügen...',
      };
      for (const [key, value] of Object.entries(expected)) {
        expect(de[key], `de.json ${key}`).toBe(value);
      }
    },
  );

  test(
    'AC2/AC3 the six-week trigger has no candidate on staging — every ended VO predates the cutover',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      // AC3 is implemented as a NULL column rather than a configured release date: the migration
      // created `treatment_ended_at` empty, `PrescriptionTreatmentEndListener` stamps it the first
      // time a VO reaches an ending status, and `findDuplikatOverdueCandidates()` skips nulls. So a
      // VO that ended before the deploy can never be flagged automatically — which is exactly what
      // AC3 asks for, and is checked here on VOs that have been ended for the better part of a year.
      for (const fixture of [FIXTURES.OVERDUE, FIXTURES.TIE_MID, FIXTURES.FAR]) {
        const vo = await duplikat.vo(fixture.id);
        expect(
          ['Fertig Behandelt', 'Abgebrochen', 'Abgelaufen'],
          `VO ${fixture.vo} must be an ended VO for this to mean anything`,
        ).toContain(vo.treatmentStatus);
        expect(
          vo.treatmentEndedAt,
          `VO ${fixture.vo} ended long before ${RC_313_STAGING_DEPLOY}, so treatmentEndedAt must be unset`,
        ).toBeUndefined();
      }

      // And the other half of the same fact: the sweep has never written an entry. An automatic
      // entry is a `duplikat_status_change` with NO author (#3504 AC2's discriminator), so counting
      // author-less entries counts everything the sweep and the auto-close have ever done.
      const all = await duplikat.logs(FIXTURES.OVERDUE.id);
      const automatic = all.filter(DuplikatProcessPage.isAutomaticEntry);
      console.log(
        `#3503 AC2: cut-off would be ${OVERDUE_WEEKS} weeks before today; ` +
          `automatic entries on the fixture VO: ${automatic.length} of ${all.length}`,
      );
      expect(
        automatic,
        'every Duplikat entry on staging was made by a person — the sweep has never run here',
      ).toHaveLength(0);
    },
  );

  test(
    'AC7 the API refuses to set or leave Abgerechnet by hand, and rejects nonsense',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      // Read-only in effect: all three are refused before anything is written, which the closing
      // assertion re-checks.
      const before = await duplikat.duplikatStatusOf(FIXTURES.OVERDUE.id);

      const billed = await duplikat.setStatus(FIXTURES.OVERDUE.id, DUPLIKAT.ABGERECHNET);
      expect(billed.status, 'Abgerechnet must not be selectable').toBe(422);
      expect(billed.body.detail).toContain('is set automatically and cannot be chosen');

      const bogus = await duplikat.setStatus(FIXTURES.OVERDUE.id, 'Bogus');
      expect(bogus.status).toBe(422);
      expect(bogus.body.detail).toContain('Unknown Duplikat status');

      const missing = await duplikat.setStatus(FIXTURES.OVERDUE.id, undefined as unknown as string);
      expect(missing.status).toBe(422);
      expect(missing.body.detail).toContain('"status" string is required');

      const emptyComment = await duplikat.addComment(FIXTURES.OVERDUE.id, '   ');
      expect(emptyComment.status, 'a whitespace-only comment must be refused').toBe(422);
      expect(emptyComment.body.detail).toContain('non-empty "comment" is required');

      expect(await duplikat.duplikatStatusOf(FIXTURES.OVERDUE.id), 'no refused call may have written').toBe(before);
      expect(SELECTABLE_STATUSES, 'Abgerechnet is not manually selectable').not.toContain(DUPLIKAT.ABGERECHNET);
    },
  );

  test(
    'AC4/AC5/AC6 the write route is gated to board staff — but wider than either board it serves',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      const therapist = await duplikat.tokenFor(STAGING_CREDENTIALS.therapist);
      const admin = await duplikat.tokenFor(STAGING_CREDENTIALS.admin);

      // A therapist reaches nothing: neither board, neither write route.
      expect(await duplikat.worklistStatus(therapist), 'therapist on the Ärzte worklist').toBe(403);
      const therapistWrite = await duplikat.setStatus(FIXTURES.OVERDUE.id, DUPLIKAT.ANFORDERN, therapist);
      expect(therapistWrite.status, 'therapist on the write route').toBe(403);
      expect(therapistWrite.body.detail).toContain('Only Therapeuten-Orga or Ärzte-Management staff');

      // A plain ROLE_ADMIN is denied BOTH board reads…
      expect(await duplikat.worklistStatus(admin), 'admin on the Ärzte worklist').toBe(403);

      // …but `denyUnlessBoardStaff()` grants `ROLE_ADMIN`, so the same account is accepted by the
      // write route and only stopped by validation. A 422 here IS the authorization passing: it is
      // the "Unknown Duplikat status" branch, which runs after the gate. Deliberate per #3537's
      // notes, and reported: an admin who can see neither worklist can still move any VO through
      // the process and comment on it.
      const adminWrite = await duplikat.setStatus(FIXTURES.OVERDUE.id, 'Bogus', admin);
      expect(
        adminWrite.status,
        'a plain admin gets past the Duplikat write gate (see the finding on AC4-AC6)',
      ).toBe(422);
      expect(adminWrite.body.detail).toContain('Unknown Duplikat status');
    },
  );

  test(
    '#3504 a therapist cannot read the Duplikat history of a VO that is not theirs',
    { tag: ['@SuperAdmin', '@DuplikatProcess', '@ReadOnly'] },
    async () => {
      // `PrescriptionLogTherapistExtension` widens the two Duplikat log types to holders of either
      // board attribute only. A therapist has neither, so the widened OR-branch must not apply and
      // the own-VOs clause stands — a therapist still sees the history of a VO of their own, which
      // is why this asserts SCOPE rather than emptiness.
      const therapist = await duplikat.tokenFor(STAGING_CREDENTIALS.therapist);
      const visible = await duplikat.logIdsVisibleTo(therapist);
      const mine = await duplikat.logs(FIXTURES.OVERDUE.id);
      expect(mine.length, 'precondition: the fixture VO has a Duplikat history').toBeGreaterThan(0);
      expect(
        visible.filter((id) => mine.some((entry) => entry.id === id)),
        `a therapist must not read the Duplikat history of VO ${FIXTURES.OVERDUE.vo}, which is not theirs`,
      ).toHaveLength(0);
      console.log(`#3505: the therapist sees ${visible.length} Duplikat log entries (their own VOs only)`);
    },
  );

  // ─────────────────────────────────── the lifecycle itself ───────────────────────────────────

  test.describe('the process, driven end to end', () => {
    test.describe.configure({ mode: 'serial' });

    test.afterAll(async ({ browser }) => {
      // AC6's dismissal is the product's own way out and is what restores both boards.
      const page = await browser.newPage();
      const cleanup = new DuplikatProcessPage(page);
      await cleanup.connect();
      for (const id of [FIXTURES.OVERDUE.id, FIXTURES.TIE_MID.id]) {
        await cleanup.dismiss(id);
      }
      await page.close();
    });

    test(
      'AC2/AC8 a VO entering the process appears on the worklist with Praxis and Letzte Aktivität',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        const fixture = FIXTURES.OVERDUE;
        await duplikat.enterProcess(fixture.id, DUPLIKAT.ANFORDERN);

        // Polled, not read once: the write reaches the boards as soon as the KPI cache entry is
        // dropped, which is prompt but not synchronous — up to 9 s on a loaded staging.
        const row = await duplikat.waitForWorklistRow(fixture.id, DUPLIKAT.ANFORDERN);
        // AC8's Praxis reads the VO's DIRECT practice FK first (#3537 fixed it from doctor.practice).
        expect(row.practiceName, 'Praxis comes from the VO\'s own practice').toBe(fixture.practiceName);
        // AC8's "Letzte Aktivität" is the day the status last moved — today, since we just moved it.
        expect(row.duplikatChangedAt).toBe(new Date().toISOString().slice(0, 10));
        // GDPR: the row never carries a patient name.
        expect(row.patientInitials).toMatch(/^[A-ZÄÖÜ]\. [A-ZÄÖÜ]\.$/);
      },
    );

    test(
      'AC4/AC5 Request → Received → Sent, each transition logged exactly once',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        const id = FIXTURES.OVERDUE.id;
        await duplikat.setStatusOk(id, DUPLIKAT.ANFORDERN);

        const before = await duplikat.logCount(id);
        await duplikat.setStatusOk(id, DUPLIKAT.ERHALTEN);
        expect(await duplikat.duplikatStatusOf(id)).toBe(DUPLIKAT.ERHALTEN);
        await duplikat.setStatusOk(id, DUPLIKAT.VERSENDET);
        expect(await duplikat.duplikatStatusOf(id)).toBe(DUPLIKAT.VERSENDET);

        const entries = await duplikat.logs(id);
        // Counts accumulate across runs, so the assertion is on the delta and on the two newest
        // values rather than on an absolute N.
        expect(entries.length - before, 'two transitions must add exactly two entries').toBe(2);
        expect(entries.slice(-2).map((e) => e.value)).toEqual([
          `${DUPLIKAT.ANFORDERN} -> ${DUPLIKAT.ERHALTEN}`,
          `${DUPLIKAT.ERHALTEN} -> ${DUPLIKAT.VERSENDET}`,
        ]);

        // Repeating a status is a no-op, not an error: `apply()` returns early, so the route still
        // answers 200 with the same state and stacks no second entry.
        const repeat = await duplikat.setStatus(id, DUPLIKAT.VERSENDET);
        expect(repeat.status).toBe(200);
        expect(repeat.body.duplikatStatus).toBe(DUPLIKAT.VERSENDET);
        expect(await duplikat.logCount(id), 'a repeated status must not stack a history entry').toBe(entries.length);
      },
    );

    test(
      'AC6 both dismissals take the VO off the worklist and out of the tile',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        const id = FIXTURES.OVERDUE.id;

        for (const dismissal of [DUPLIKAT.ORIGINAL_LIEGT_VOR, DUPLIKAT.NICHT_MOEGLICH]) {
          await duplikat.setStatusOk(id, DUPLIKAT.ANFORDERN);
          await duplikat.waitForWorklistRow(id, DUPLIKAT.ANFORDERN);

          await duplikat.setStatusOk(id, dismissal);
          await duplikat.waitForWorklistWithout(id);
        }

        // And the tile agrees, as an invariant that holds whatever else is in the process: the count
        // is the number of OPEN rows in the same payload, and the dismissed VO is in neither.
        const risks = await duplikat.orgaRisks();
        const duplikatRows = DuplikatProcessPage.duplikatRows(risks.rows);
        const open = duplikatRows.filter((r) => OPEN_STATUSES.includes(r.duplikatStatus!));
        expect(risks.tiles.duplikatOffen, 'the tile counts exactly the open rows').toBe(open.length);
        expect(duplikatRows.some((r) => r.prescriptionId === id)).toBe(false);
      },
    );

    test(
      'the API enforces no transition ladder — skips, backwards moves and dismissed → open all pass',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        // AC4/AC5 describe Request → Received → Sent, and #3537's notes record the missing ladder as
        // a deliberate inherited deviation. Pinned here so a later ladder shows up as a change, and
        // reported: a VO can reach "Versendet" without ever having been "Erhalten", and a VO written
        // off as "Original liegt vor" can be silently pulled back into the open worklist.
        const id = FIXTURES.OVERDUE.id;
        await duplikat.setStatusOk(id, DUPLIKAT.ORIGINAL_LIEGT_VOR);
        await duplikat.setStatusOk(id, DUPLIKAT.ANFORDERN);
        await duplikat.setStatusOk(id, DUPLIKAT.VERSENDET);
        await duplikat.setStatusOk(id, DUPLIKAT.ANFORDERN);
        await duplikat.setStatusOk(id, DUPLIKAT.ORIGINAL_LIEGT_VOR);
      },
    );

    test(
      '#3504 AC1/AC3 a comment joins the same history, with its author and text',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        const id = FIXTURES.TIE_MID.id;
        await duplikat.enterProcess(id, DUPLIKAT.ANFORDERN);

        const before = await duplikat.logs(id);
        const note = `QA #3504 ${Date.now()}`;
        const res = await duplikat.addComment(id, note);
        expect(res.status).toBe(200);

        const after = await duplikat.logs(id);
        expect(after.length - before.length, 'a comment adds exactly one entry').toBe(1);
        const added = after[after.length - 1];
        expect(added.type).toBe('duplikat_comment');
        expect(added.value).toBe(note);
        expect(added.createdByName, 'AC3 requires the entry to name who wrote it').toBe('SA Jhen');
        expect(added.createdAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));

        // AC2's discriminator: a comment is never "automatic", and neither is a person's status
        // change — only an author-less status change is.
        expect(DuplikatProcessPage.isAutomaticEntry(added)).toBe(false);
        expect(after.filter(DuplikatProcessPage.isAutomaticEntry)).toHaveLength(0);
      },
    );

    test(
      '#3503 AC8 vs #3504 — a comment does not move "Letzte Aktivität"',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async () => {
        // AC8 words the column as "the date of the VO's last Duplikat-**related activity**", and
        // #3503 points at #3504's log for what those activities are. What ships is
        // `duplikatStatusChangedAt` — "when the Duplikat status last moved" — so a comment, which
        // #3504 puts in the very same history, leaves the column showing an older date.
        // Reported as a wording/behaviour divergence rather than asserted as correct.
        const id = FIXTURES.TIE_MID.id;
        await duplikat.setStatusOk(id, DUPLIKAT.ANFORDERN);
        await duplikat.setStatusOk(id, DUPLIKAT.ERHALTEN);
        const stamped = (await duplikat.vo(id)).duplikatStatusChangedAt;

        const note = `QA #3504 letzte-aktivitaet ${Date.now()}`;
        const res = await duplikat.addComment(id, note);
        expect(res.status).toBe(200);
        const afterComment = (await duplikat.vo(id)).duplikatStatusChangedAt;

        expect(afterComment, 'the shipped column tracks the status change only').toBe(stamped);

        // And the column is exactly the newest STATUS CHANGE, while a newer comment sits in the very
        // same history it is supposed to summarise. `createdAt` has second precision, so the comment
        // can land in the same second as the transition — hence `>=` rather than a strict compare.
        const entries = await duplikat.logs(id);
        const lastStatusChange = [...entries].reverse().find((e) => 'duplikat_status_change' === e.type)!;
        const ourComment = entries.find((e) => note === e.value)!;
        expect(lastStatusChange.createdAt, 'the column IS the last status change').toBe(stamped);
        expect(ourComment.createdAt >= lastStatusChange.createdAt, 'the comment is the newer entry').toBe(true);
      },
    );
  });

  // ─────────────────────────────────────── the board itself ───────────────────────────────────────

  test.describe('the Therepeuten-Orga board', () => {
    test.describe.configure({ mode: 'serial' });

    test.afterAll(async ({ browser }) => {
      const page = await browser.newPage();
      const cleanup = new DuplikatProcessPage(page);
      await cleanup.connect();
      await cleanup.dismiss(FIXTURES.OVERDUE.id);
      await page.close();
    });

    test(
      'AC1/AC3/AC8 the tile, its value at risk, and the manual backlog entry',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        // `/kpis/orga/risks` carries all four tiles' rows (5,481 on staging) and measures ~22 s cold;
        // the board mounts five aggregations behind it.
        test.setTimeout(420_000);

        const fixture = FIXTURES.OVERDUE;
        await duplikat.setStatusOk(fixture.id, DUPLIKAT.ANFORDERN);

        await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
        const boards = new FlowBoardsPage(page);
        await boards.open();
        await boards.openTab('Therapeuten-Orga');

        const tile = page.getByTestId(DuplikatProcessPage.UI.tile);
        await expect(tile, 'the "Duplikat offen" tile').toBeVisible({ timeout: 180_000 });
        // Retry the section's own control when `/kpis/orga/risks` fails: #3233 suppresses the tiles
        // and the worklist together on a failed read, so a bare wait reports "element(s) not found".
        await duplikat.waitForSectionOrRetry(DuplikatProcessPage.UI.worklist);

        // AC1: the count and the value at risk are both read off the very rows the worklist below
        // shows, so the two can never disagree — which is what the assertion checks.
        const painted = await duplikat.paintedRowIds();
        expect(painted, 'the fixture must be painted on the Orga board').toContain(fixture.id);

        const tileText = (await tile.innerText()).replace(/\n/g, ' | ');
        expect(tileText, 'the tile is titled per the localization table').toContain('Duplikat offen');
        const count = Number(tileText.match(/\|\s*(\d+)\s*\|/)?.[1]);
        expect(count, `tile text: ${tileText}`).toBe(painted.length);

        const subtitle = await page.getByTestId(DuplikatProcessPage.UI.tileSubtitle).innerText();
        const shown = Number(subtitle.replace(/[^\d,]/g, '').replace(/\./g, '').replace(',', '.'));
        const rows = DuplikatProcessPage.duplikatRows((await duplikat.orgaRisks()).rows);
        const openSum = rows
          .filter((r) => OPEN_STATUSES.includes(r.duplikatStatus!))
          .reduce((total, r) => total + (r.revenue ?? 0), 0);
        expect(subtitle, 'the subtitle is the value at risk').toMatch(/^Wert: /);
        expect(shown, `subtitle ${subtitle} vs open rows`).toBeCloseTo(openSum, 1);

        // AC8's colour table, read back from the rendered status cell.
        const cell = await duplikat.statusCellBackground(fixture.id);
        expect(cell.status).toBe(DUPLIKAT.ANFORDERN);
        expect(cell.background, 'Anfordern renders red').toBe(STATUS_BACKGROUND.Anfordern);
        expect(cell.interactive, 'a non-billed row offers the dropdown').toBe(true);

        // AC3: the manual entry point for the known backlog. Every Fertig>30 row carries
        // "Duplikat anfordern" EXCEPT the ones already in the process — and the suppression is what
        // makes the action a route into the process rather than a way to re-flag a live case.
        const actions = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="risk-duplikat-request-"]')].map((el) =>
            Number(el.getAttribute('data-testid')!.replace('risk-duplikat-request-', '')),
          ),
        );
        expect(actions.length, 'Fertig>30 rows must offer the manual entry').toBeGreaterThan(0);
        expect(
          actions,
          `VO ${fixture.vo} is already in the process, so its action must be suppressed`,
        ).not.toContain(fixture.id);
        await expect(page.getByTestId(DuplikatProcessPage.UI.manualEntry(actions[0]))).toHaveText('Duplikat anfordern');

        // Selecting the tile drops the three other tiles' worklist and leaves only the Duplikat one.
        await tile.click();
        await expect(page.getByTestId(DuplikatProcessPage.UI.worklist)).toBeVisible();
        expect(
          await page.evaluate(() => document.querySelectorAll('[data-testid^="risk-duplikat-request-"]').length),
          'the shared risk worklist is hidden while the Duplikat tile is selected',
        ).toBe(0);
      },
    );

    test(
      '#3504 AC1/AC2/AC3 the Verlauf expander renders the whole history and takes a new note',
      { tag: ['@SuperAdmin', '@DuplikatProcess', '@Mutating'] },
      async ({ page }) => {
        test.setTimeout(420_000);
        const fixture = FIXTURES.OVERDUE;
        await duplikat.setStatusOk(fixture.id, DUPLIKAT.ANFORDERN);
        const entries = await duplikat.logs(fixture.id);

        await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
        const boards = new FlowBoardsPage(page);
        await boards.open();
        await boards.openTab('Therapeuten-Orga');
        await duplikat.waitForSectionOrRetry(DuplikatProcessPage.UI.worklist);

        // AC1: the count on the collapsed row is the number of entries behind it.
        const toggle = page.getByTestId(DuplikatProcessPage.UI.historyToggle(fixture.id));
        await expect(toggle).toContainText(`Verlauf (${entries.length})`, { timeout: 60_000 });

        await toggle.click();
        await expect(page.getByTestId(DuplikatProcessPage.UI.historyPanel(fixture.id))).toBeVisible({ timeout: 30_000 });

        const rendered = await duplikat.panelEntries(fixture.id);
        expect(rendered.map((e) => e.id), 'the panel renders the API\'s entries, oldest first')
          .toEqual(entries.map((e) => e.id));
        expect(rendered[rendered.length - 1].text).toContain('SA Jhen');

        // AC2 asks automatic entries to be greyed out. Every entry a client can create carries an
        // author, so none of these renders greyed — see the finding.
        expect(rendered.some((e) => e.italic || e.greyed)).toBe(false);

        // AC3: the comment box, gated on non-empty input.
        const input = page.getByTestId(DuplikatProcessPage.UI.commentInput(fixture.id));
        const submit = page.getByTestId(DuplikatProcessPage.UI.commentSubmit(fixture.id));
        await expect(input).toHaveAttribute('placeholder', 'Kommentar hinzufügen...');
        await expect(submit, 'submit is disabled while the field is empty').toHaveAttribute('aria-disabled', 'true');

        const note = `QA #3504 ui ${Date.now()}`;
        await input.fill(note);
        await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
        await submit.click();

        await expect(
          page.getByTestId(DuplikatProcessPage.UI.historyPanel(fixture.id)),
          'the new note joins the rendered history',
        ).toContainText(note, { timeout: 60_000 });
        const afterApi = await duplikat.logs(fixture.id);
        expect(afterApi[afterApi.length - 1].value, 'and reaches the shared log').toBe(note);
      },
    );
  });

  // ───────────────────────────────── what cannot be reached here ─────────────────────────────────
});
