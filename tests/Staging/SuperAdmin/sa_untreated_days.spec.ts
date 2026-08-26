import { test, expect } from '@playwright/test';
import {
  UntreatedDaysPage,
  OVERDUE_DAYS,
  NO_VALUE_DASH,
} from '../../../Pages/therapist/therapist.untreated-days.page';

/**
 * RC 3.11.1 (#3471) — the ticket's own reproduction, driven from a Super Admin account.
 *
 * The ticket names patient **4258** (Sergej Marin), whose VO **4258-16** (Fertig Behandelt) showed
 * 176 days since last treatment while their VO **4258-15** (Aktiv) had been treated on 8 Jul 2026.
 * Reproducing that needs both boards it lives on, and the two VOs sit with **different therapists**:
 *
 *   - 4258-15 (Aktiv), 4258-14 (Fertig Behandelt), 4258-17 (Abgelaufen) → **Mara Nagel**
 *   - 4258-16 (Fertig Behandelt), plus eight Archiviert VOs                → **Kevin Mischke**
 *
 * A therapist account only ever sees its own caseload, so this runs as Super Admin, which is offered
 * the "Therapeut:in wählen" picker on the same Therapist Board v2 the therapists use. Everything is
 * **read-only**: pick a therapist, search, expand a group, open the Hinweise panel.
 *
 * The per-caseload split is not incidental — see the `@RollupScope` test at the bottom for the
 * question it raises against AC1.
 */

/** The ticket's patient and the two therapists their VOs are split across. */
const PATIENT = '4258';
const ACTIVE_VO_THERAPIST = 'Mara Nagel';
const FINISHED_VO_THERAPIST = 'Kevin Mischke';

test.describe('Therapist Board — #3471 reproduction on patient 4258', () => {
  test(
    'The patient\'s active and finished VO rows all read the same number',
    { tag: ['@SuperAdmin', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(420_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open({ therapist: ACTIVE_VO_THERAPIST });

      const patientRows = rows.filter((r) => r.vo.startsWith(`${PATIENT}-`));
      console.log(
        `${ACTIVE_VO_THERAPIST}: ` +
          patientRows
            .map((r) => `${r.vo}[${r.status}] served=${r.days} own=${r.lastTreatment?.toISOString().slice(0, 10) ?? '-'}`)
            .join(' | '),
      );
      test.skip(patientRows.length === 0, `patient ${PATIENT} is no longer on ${ACTIVE_VO_THERAPIST}'s board`);

      // AC1: one value for the patient, taken from the VO that can still be treated — not from each
      // row's own last treatment, which differs by a day here and by months on the archived VOs.
      const served = new Set(patientRows.map((r) => String(r.days)));
      expect(served.size, `every one of patient ${PATIENT}'s rows must carry one value`).toBe(1);

      const eligible = UntreatedDaysPage.latestEligibleTreatment(patientRows);
      expect(eligible, 'the patient must have a treatable VO with a treatment on it').not.toBeNull();
      // The server counts from its own "today"; pin the candidate that explains the served value and
      // measure every other date against that same day, so a VO whose own treatment is one day
      // earlier cannot pass by borrowing a different "today".
      const today = UntreatedDaysPage.resolveToday(eligible!, patientRows[0].days!);
      expect(
        today,
        `the value must be the weekdays since ${eligible!.toISOString().slice(0, 10)}, ` +
          `got ${patientRows[0].days}`,
      ).not.toBeNull();

      // The closed VOs' own, older treatment dates must NOT be what the rows report.
      const closed = patientRows.filter((r) => r.lastTreatment && r.lastTreatment < eligible!);
      expect(closed.length, 'the repro needs a closed VO treated before the active one').toBeGreaterThan(0);
      for (const row of closed) {
        const own = UntreatedDaysPage.weekdaysBetween(row.lastTreatment!, today!);
        console.log(
          `${row.vo} [${row.status}] last treated ${row.lastTreatment!.toISOString().slice(0, 10)} ` +
            `(${own} weekdays of its own) reports ${row.days} — the patient's number, not its own`,
        );
        expect(own, `${row.vo} must not report its own last treatment`).not.toBe(row.days);
      }

      // And the same claim on screen: search the patient, reveal their previous VOs, read the cells.
      await measure.board.search(PATIENT);
      const revealed = await measure.revealPreviousVos();
      const painted = await measure.renderedRows();
      console.log(`painted (previous VOs revealed: ${revealed}): ${painted.map((r) => `${r.vo}=${r.days}`).join(' | ')}`);
      expect(painted.length, 'the search must paint the patient\'s rows').toBeGreaterThan(0);
      expect(
        new Set(painted.map((r) => r.days)).size,
        'the column paints one value across the patient\'s rows',
      ).toBe(1);
    },
  );

  test(
    'The finished VO that showed 176 days now reports no value at all',
    { tag: ['@SuperAdmin', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(420_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open({ therapist: FINISHED_VO_THERAPIST });

      const patientRows = rows.filter((r) => r.vo.startsWith(`${PATIENT}-`));
      console.log(
        `${FINISHED_VO_THERAPIST}: ` +
          patientRows
            .map((r) => `${r.vo}[${r.status}] served=${r.days} own=${r.lastTreatment?.toISOString().slice(0, 10) ?? '-'}`)
            .join(' | '),
      );
      test.skip(patientRows.length === 0, `patient ${PATIENT} is no longer on ${FINISHED_VO_THERAPIST}'s board`);

      // AC2: every VO this therapist holds for the patient is terminal, so there is no treatment to
      // date the gap from — the answer is "no value", not the 176 days the VO used to accrue.
      expect(
        UntreatedDaysPage.latestEligibleTreatment(patientRows),
        'all of this therapist\'s VOs for the patient are terminal',
      ).toBeNull();
      for (const row of patientRows) {
        expect(row.days, `${row.vo} must report no days at all`).toBeNull();
      }

      // The inactive group ships collapsed, so the row has to be revealed before it can be read.
      await measure.board.search(PATIENT);
      await measure.expandGroup('Inaktive Patienten');
      const painted = await measure.renderedRows();
      console.log(`painted: ${painted.map((r) => `${r.vo}=${r.days}`).join(' | ')}`);
      test.skip(painted.length === 0, 'the search painted no row for this patient');
      for (const row of painted) {
        expect(row.days, `${row.vo} must render "${NO_VALUE_DASH}"`).toBe(NO_VALUE_DASH);
      }
    },
  );

  test(
    'On a large caseload the 14+ hint announces patients, not the rows behind them',
    { tag: ['@SuperAdmin', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(420_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open({ therapist: FINISHED_VO_THERAPIST });

      const topLevel = UntreatedDaysPage.overdue(UntreatedDaysPage.topLevel(rows));
      const everyRow = UntreatedDaysPage.overdue(rows);
      const patients = UntreatedDaysPage.distinctPatients(topLevel);
      console.log(
        `${FINISHED_VO_THERAPIST}: ${rows.length} VOs · at ${OVERDUE_DAYS}+ weekdays ` +
          `${topLevel.length} top-level rows (${everyRow.length} incl. revealable) ` +
          `across ${patients} patients`,
      );
      test.skip(topLevel.length === 0, 'this caseload holds nothing at 14+ weekdays untreated');

      await measure.board.openHinweise();
      const headline = await measure.untreatedHeadline();
      console.log(`headline: ${headline}`);
      expect(headline, 'the panel must carry the untreated reminder').not.toBeNull();
      expect(UntreatedDaysPage.headlineCount(headline!), 'it announces distinct patients').toBe(patients);

      // This is the caseload the ticket's "60 Patienten" complaint was about: the row counts are far
      // larger than the patient count, so a row-based number would be visibly wrong here.
      expect(everyRow.length, 'and the rows behind it are more numerous').toBeGreaterThan(patients);
    },
  );

  test(
    'The 14-weekday threshold is read off the corrected value',
    { tag: ['@SuperAdmin', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(420_000);
      const measure = new UntreatedDaysPage(page);
      // This caseload is large enough to hold a patient sitting exactly ON the threshold, which
      // neither therapist's own board does — AC4 is otherwise only assertable as a rule.
      const rows = await measure.open({ therapist: FINISHED_VO_THERAPIST });

      const at = UntreatedDaysPage.topLevel(rows).filter((r) => r.days === OVERDUE_DAYS);
      const below = UntreatedDaysPage.topLevel(rows).filter((r) => r.days === OVERDUE_DAYS - 1);
      console.log(
        `fixtures: ${at.length} rows at exactly ${OVERDUE_DAYS} ` +
          `(${at.map((r) => `${r.vo} ${r.patientName}`).join(', ') || 'none'}), ` +
          `${below.length} at ${OVERDUE_DAYS - 1}`,
      );
      test.skip(
        at.length === 0 && below.length === 0,
        'this caseload holds no patient at the 13/14-weekday boundary today',
      );

      const preview = await measure.applyGapFilter();
      console.log(`filter preview: ${preview}`);
      expect(preview, 'the filter must promise the rows the rule selects').toBe(
        UntreatedDaysPage.overdue(UntreatedDaysPage.topLevel(rows)).length,
      );

      // A long board paints a WINDOW of its rows, so "is this VO on screen?" is only meaningful
      // once the boundary VO is searched for — otherwise the assertion turns on where it happened
      // to land in the list.
      const survivesFilter = async (vo: string) => {
        await measure.board.search(vo);
        const painted = await measure.renderedRows();
        await measure.board.clearSearch();
        return painted.some((r) => r.vo === vo);
      };

      // AC4: exactly 14 weekdays qualifies.
      for (const row of at) {
        expect(
          await survivesFilter(row.vo),
          `${row.vo} (${row.patientName}) sits exactly at ${OVERDUE_DAYS} and must pass the filter`,
        ).toBe(true);
      }
      // AC3: one weekday short does not. No fixture on staging today — logged, not silently passed.
      if (below.length === 0) {
        console.log(`no row sits at ${OVERDUE_DAYS - 1}, so the negative half of the boundary is not exercised`);
      }
      for (const row of below) {
        expect(await survivesFilter(row.vo), `${row.vo} sits at ${OVERDUE_DAYS - 1} and must not pass`).toBe(
          false,
        );
      }

      await measure.clearGapFilter();
    },
  );

  test.fixme(
    'AC1 as written: the value spans all of a patient\'s VOs, not just one therapist\'s',
    { tag: ['@SuperAdmin', '@TBoardV2', '@UntreatedDays', '@RollupScope'] },
    async ({ page }) => {
      /**
       * FINDING — the rollup is scoped to the caseload being served, which AC1 does not say.
       *
       * AC1 asks for "the days since the patient's most recent treatment **across all their VOs**".
       * The fix rolls up only over the VOs in the response — deliberately, per the provider comment:
       * "querying the patient's other VOs would show a therapist a figure derived from another
       * therapist's caseload."
       *
       * Patient 4258 is exactly that case, measured live on staging 2026-08-25:
       *   - Mara Nagel's board:    4258-15 / -17 / -14 all read **34** (last treated 2026-07-08).
       *   - Kevin Mischke's board: 4258-16 reads **"–"**, although the patient WAS treated 34
       *     weekdays ago — just on a VO he does not hold.
       *
       * So the same patient is "34 weekdays untreated" on one board and "unknown" on another, and
       * neither board shows the 176-day figure the ticket complained about. Whether that is the
       * intended reading of AC1 is the PM's call — privacy (not leaking another therapist's
       * caseload) argues for what shipped, and "across all their VOs" argues for the other. Left
       * `fixme` with the evidence rather than asserted, since either resolution makes it correct.
       */
      test.setTimeout(600_000);
      const measure = new UntreatedDaysPage(page);

      const onActive = (await measure.open({ therapist: ACTIVE_VO_THERAPIST })).filter((r) =>
        r.vo.startsWith(`${PATIENT}-`),
      );
      const onFinished = (await measure.open({ therapist: FINISHED_VO_THERAPIST })).filter((r) =>
        r.vo.startsWith(`${PATIENT}-`),
      );
      console.log(`${ACTIVE_VO_THERAPIST}: ${onActive.map((r) => `${r.vo}=${r.days}`).join(' ')}`);
      console.log(`${FINISHED_VO_THERAPIST}: ${onFinished.map((r) => `${r.vo}=${r.days}`).join(' ')}`);

      const truth = onActive[0]?.days ?? null;
      expect(truth, 'the patient has a real, recent treatment').not.toBeNull();
      for (const row of onFinished) {
        expect(row.days, `${row.vo} must report the patient's real gap, not "no value"`).toBe(truth);
      }
    },
  );
});
