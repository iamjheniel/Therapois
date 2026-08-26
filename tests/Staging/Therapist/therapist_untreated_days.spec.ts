import { test, expect } from '@playwright/test';
import {
  UntreatedDaysPage,
  OVERDUE_DAYS,
  NO_VALUE_DASH,
  TICKET_TERMINAL_STATUSES,
  IMPLEMENTED_TERMINAL_STATUSES,
  BoardRow,
} from '../../../Pages/therapist/therapist.untreated-days.page';

/**
 * RC 3.11.1 (#3471) — "Tage seit Beh." is a property of the PATIENT, not of a VO row.
 *
 * The measure feeds three surfaces: the "14+ Tage nicht behandelt" hint in the Hinweise panel, the
 * BEHANDLUNGSLÜCKE filter ("Seit 14+ Tagen unbehandelt") and the sortable "Tage seit Beh." column.
 * All three used to read a per-VO figure that kept accruing on VOs which will never be treated
 * again, and the hint counted VO rows while its label said "Patienten".
 *
 * These tests drive the therapist's own board and check the corrected measure end to end: the API
 * response the board itself loads (so the rows asserted are exactly the rows painted) against the
 * rendered column, the hint, the filter and the sort.
 *
 * **Read-only.** Nothing here documents a treatment, orders a VO or edits a patient; the only state
 * touched is the board's own filter/sort selection, which lives for the visit.
 *
 * Two properties the assertions lean on, both verified live:
 *  - a patient's value is `null` — the API omits the field, the column paints a dash "–" — when they
 *    have no treated, still-treatable VO. That is not the same fact as "treated today";
 *  - the rollup is computed over the VOs in the response, i.e. this therapist's caseload. See
 *    `sa_untreated_days.spec.ts` for what that means when a patient is split across two therapists.
 */
test.describe('Therapist Board — days since last treatment (#3471)', () => {
  test(
    'Every VO row of a patient reports the same days-since-treatment value',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      expect(rows.length, 'the board must load VOs to assert anything about them').toBeGreaterThan(0);

      const groups = UntreatedDaysPage.byPatient(rows);
      const multi = [...groups.values()].filter((vos) => vos.length > 1);
      console.log(`board: ${rows.length} VOs · ${groups.size} patients · ${multi.length} with >1 VO`);
      test.skip(multi.length === 0, 'no patient on this board carries more than one VO');

      // AC1: one number per patient, stamped on every one of their rows — terminal ones included.
      const disagreeing = multi.filter((vos) => new Set(vos.map((v) => String(v.days))).size > 1);
      for (const vos of disagreeing.slice(0, 5)) {
        console.log(
          `DISAGREES — patient ${vos[0].patientId} ${vos[0].patientName}: ` +
            vos.map((v) => `${v.vo}[${v.status}]=${v.days}`).join(' '),
        );
      }
      expect(
        disagreeing.length,
        'a patient\'s VO rows must all carry the same days-since-treatment value',
      ).toBe(0);

      // The same claim on the painted table: patients whose rows are visible together must agree.
      const rendered = await measure.renderedRows();
      const voToPatient = new Map(rows.map((r) => [r.vo, r.patientId]));
      const byPatientOnScreen = new Map<number, string[]>();
      for (const row of rendered) {
        const patient = voToPatient.get(row.vo);
        if (patient === undefined) continue;
        byPatientOnScreen.set(patient, [...(byPatientOnScreen.get(patient) ?? []), row.days]);
      }
      const painted = [...byPatientOnScreen.entries()].filter(([, cells]) => cells.length > 1);
      console.log(`painted rows: ${rendered.length}; patients with >1 row on screen: ${painted.length}`);
      for (const [patient, cells] of painted) {
        expect(new Set(cells).size, `patient ${patient}'s rows must paint one value, got ${cells}`).toBe(1);
      }
    },
  );

  test(
    'The value is the patient\'s most recent treatment on a VO that can still be treated',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      const groups = UntreatedDaysPage.byPatient(rows);
      expect(groups.size, 'the board must hold patients').toBeGreaterThan(0);

      // Recomputed independently from each VO's own lastTreatmentDate, never from the served value.
      const wrong: string[] = [];
      let derivedFromTerminal = 0;
      for (const vos of groups.values()) {
        const eligible = UntreatedDaysPage.latestEligibleTreatment(vos);
        const served = vos[0].days;

        if (eligible === null) {
          if (served !== null) {
            wrong.push(`${vos[0].patientId} ${vos[0].patientName}: no treatable VO but served ${served}`);
          }
          continue;
        }
        if (served === null) {
          wrong.push(
            `${vos[0].patientId} ${vos[0].patientName}: last treatable treatment ` +
              `${eligible.toISOString().slice(0, 10)} but served no value`,
          );
          continue;
        }
        if (!UntreatedDaysPage.daysAgrees(eligible, served)) {
          wrong.push(
            `${vos[0].patientId} ${vos[0].patientName}: served ${served} for ` +
              `${eligible.toISOString().slice(0, 10)} — ` +
              vos.map((v) => `${v.vo}[${v.status}]${v.lastTreatment?.toISOString().slice(0, 10) ?? '-'}`).join(' '),
          );
        }

        // AC2 from the other side: a terminal VO dated LATER than the eligible one must not win.
        const laterTerminal = vos.some(
          (v) =>
            IMPLEMENTED_TERMINAL_STATUSES.includes(v.status as never) &&
            v.lastTreatment !== null &&
            v.lastTreatment > eligible,
        );
        if (laterTerminal) derivedFromTerminal++;
      }
      for (const line of wrong.slice(0, 8)) console.log(`MISMATCH — ${line}`);
      console.log(
        `patients checked: ${groups.size}; patients whose most recent treatment sits on a ` +
          `terminal VO that was correctly ignored: ${derivedFromTerminal}`,
      );
      expect(wrong.length, 'every patient\'s value must be their latest treatable treatment').toBe(0);
    },
  );

  test(
    'A patient with no treatable VO left reports no value, and the column shows a dash',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      const groups = UntreatedDaysPage.byPatient(rows);

      const noValue = [...groups.values()].filter((vos) => vos[0].days === null);
      console.log(`patients with no value: ${noValue.length} of ${groups.size}`);
      test.skip(noValue.length === 0, 'every patient on this board has a treated, treatable VO');

      // AC2: none of them has a treatable treatment to report — the dash is a fact, not a gap of 0.
      for (const vos of noValue) {
        expect(
          UntreatedDaysPage.latestEligibleTreatment(vos),
          `patient ${vos[0].patientId} reports no value, so they can have no treatable treatment`,
        ).toBeNull();
      }

      // And the column paints it as a dash rather than "0" — the pre-fix value for the same state.
      const rendered = await measure.renderedRows();
      const noValueVos = new Set(noValue.flatMap((vos) => vos.map((v) => v.vo)));
      const painted = rendered.filter((r) => noValueVos.has(r.vo));
      console.log(`rows on screen for those patients: ${painted.length}`);
      test.skip(painted.length === 0, 'none of those patients has a row painted right now');
      for (const row of painted.slice(0, 10)) {
        expect(row.days, `${row.vo} must render "${NO_VALUE_DASH}", not a number`).toBe(NO_VALUE_DASH);
      }
    },
  );

  test(
    'The 14+ hint counts distinct patients, not VO rows',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();

      // The hint counts against the board's top-level rows — the ones the table paints.
      const overdue = UntreatedDaysPage.overdue(UntreatedDaysPage.topLevel(rows));
      const patients = UntreatedDaysPage.distinctPatients(overdue);
      const allOverdue = UntreatedDaysPage.overdue(rows);
      console.log(
        `at ${OVERDUE_DAYS}+ weekdays: ${overdue.length} top-level rows ` +
          `(${allOverdue.length} incl. revealable ones) across ${patients} patients`,
      );
      test.skip(overdue.length === 0, 'no VO on this board is at 14+ weekdays untreated');

      await measure.board.openHinweise();
      const headline = await measure.untreatedHeadline();
      console.log(`headline: ${headline}`);
      expect(headline, 'the Hinweise panel must carry the untreated reminder').not.toBeNull();
      expect(headline!, 'and it must be labelled in patients').toMatch(
        /^\d+ Patienten seit 14\+ Tagen nicht behandelt$/,
      );

      // AC5: the number is the patient count, not the row count.
      const announced = UntreatedDaysPage.headlineCount(headline!);
      expect(announced, 'the hint announces the number of distinct patients').toBe(patients);
      expect(announced!, 'and never more than the rows it was derived from').toBeLessThanOrEqual(
        overdue.length,
      );
      if (overdue.length > patients) {
        console.log(
          `dedupe is doing work here: ${overdue.length} rows collapse to ${patients} patients`,
        );
      } else {
        console.log('no patient on this board has two overdue rows — the counts coincide today');
      }

      // The hint's own "Diese anzeigen" still filters to VO ROWS, so the number it announces and the
      // list it opens deliberately differ once a patient carries two overdue VOs. Recorded rather
      // than asserted: the ACs ask for a patient count in the label and say nothing about the list.
      await measure.board.hinweiseShowAll(0).click({ timeout: 30_000 });
      await page.waitForTimeout(5000);
      const listed = await measure.renderedRows();
      console.log(
        `"Diese anzeigen" lists ${listed.length} rows behind the "${announced} Patienten" headline`,
      );
      expect(listed.length, 'the hint filter must open the rows behind the count').toBeGreaterThanOrEqual(
        Math.min(announced!, 1),
      );
    },
  );

  test(
    'The Behandlungslücke filter returns exactly the rows at 14+ weekdays',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      const overdue = UntreatedDaysPage.overdue(UntreatedDaysPage.topLevel(rows));
      console.log(`expecting ${overdue.length} rows: ${overdue.map((r) => `${r.vo}=${r.days}`).join(' ')}`);
      test.skip(overdue.length === 0, 'no VO on this board is at 14+ weekdays untreated');

      const preview = await measure.applyGapFilter();
      console.log(`panel preview: ${preview}`);
      expect(preview, 'the panel previews the filtered count').toBe(overdue.length);

      const painted = await measure.renderedRows();
      console.log(`painted: ${painted.map((r) => `${r.vo}=${r.days}`).join(' ')}`);
      // A long board renders a window of its rows, so the painted count is a floor, not the total;
      // the panel's own preview is the number that must match the rule exactly.
      expect(painted.length, 'the filtered table must paint rows').toBeGreaterThan(0);
      expect(painted.length, 'and never more than qualify').toBeLessThanOrEqual(overdue.length);

      // AC4 (at/above the threshold passes) and AC3 (below it does not) as one claim over the set.
      for (const row of painted) {
        const value = parseInt(row.days, 10);
        expect(Number.isFinite(value), `${row.vo} must carry a number, got "${row.days}"`).toBe(true);
        expect(value, `${row.vo} passed the filter, so it must be at ${OVERDUE_DAYS}+`).toBeGreaterThanOrEqual(
          OVERDUE_DAYS,
        );
      }
      const paintedVos = new Set(painted.map((r) => r.vo));
      if (painted.length === overdue.length) {
        const missed = overdue.filter((r) => !paintedVos.has(r.vo));
        expect(missed.map((r) => r.vo), 'no qualifying row may be left out').toEqual([]);
      } else {
        console.log(`${overdue.length - painted.length} qualifying rows are outside the render window`);
      }

      // The boundary itself, when the board happens to hold one. 13 must not pass, 14 must.
      const atThreshold = rows.filter((r) => r.days === OVERDUE_DAYS);
      const belowThreshold = rows.filter((r) => r.days === OVERDUE_DAYS - 1);
      console.log(
        `boundary fixtures on this board: ${atThreshold.length} at ${OVERDUE_DAYS}, ` +
          `${belowThreshold.length} at ${OVERDUE_DAYS - 1}`,
      );
      const overdueVos = new Set(overdue.map((r) => r.vo));
      for (const row of atThreshold.filter((r) => r.list === 'prescriptions')) {
        expect(overdueVos.has(row.vo), `${row.vo} sits exactly at ${OVERDUE_DAYS} and must qualify`).toBe(true);
      }
      for (const row of belowThreshold) {
        expect(
          paintedVos.has(row.vo),
          `${row.vo} sits at ${OVERDUE_DAYS - 1} and must not pass the filter`,
        ).toBe(false);
      }

      await measure.clearGapFilter();
      const restored = await measure.renderedRows();
      console.log(`after clearing: ${restored.length} rows`);
      expect(restored.length, 'clearing the filter restores the board').toBeGreaterThan(painted.length);
    },
  );

  test(
    'Sorting the Tage seit Beh. column orders by the corrected value',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      test.skip(rows.length === 0, 'the board is empty');

      const first = await measure.sortByDays();
      const ascending = UntreatedDaysPage.numeric(await measure.renderedRows());
      console.log(`sort "${first}": ${ascending.join(' ')}`);

      const second = await measure.sortByDays();
      const descending = UntreatedDaysPage.numeric(await measure.renderedRows());
      console.log(`sort "${second}": ${descending.join(' ')}`);
      expect(first, 'the header must toggle its direction').not.toBe(second);

      // A dash sorts as 0 — the comparator reads `daysSinceLastTreatment ?? 0` — so it is compared
      // as the value the board actually sorts by, not skipped.
      const asNumber = (values: (number | null)[]) => values.map((v) => v ?? 0);
      const up = asNumber(ascending);
      const down = asNumber(descending);
      expect(up.length, 'the sorted table must still hold rows').toBeGreaterThan(1);

      const sortedUp = [...up].sort((a, b) => a - b);
      const sortedDown = [...down].sort((a, b) => b - a);
      // Whichever direction the first click produced, one of the two renders must be each order.
      const oneIsAscending =
        JSON.stringify(up) === JSON.stringify(sortedUp) || JSON.stringify(down) === JSON.stringify([...down].sort((a, b) => a - b));
      const oneIsDescending =
        JSON.stringify(down) === JSON.stringify(sortedDown) || JSON.stringify(up) === JSON.stringify([...up].sort((a, b) => b - a));
      expect(oneIsAscending, 'one click must order the column ascending').toBe(true);
      expect(oneIsDescending, 'and the other descending').toBe(true);

      // The values sorted on are the corrected per-patient ones: a patient with two rows keeps them
      // together, which a per-VO value would not guarantee.
      const voToPatient = new Map(rows.map((r) => [r.vo, r.patientId]));
      const order = (await measure.renderedRows()).map((r) => voToPatient.get(r.vo));
      const seen = new Set<number | undefined>();
      let split = 0;
      let previous: number | undefined;
      for (const patient of order) {
        if (patient !== previous && seen.has(patient)) split++;
        seen.add(patient);
        previous = patient;
      }
      console.log(`patients whose rows are split apart by the sort: ${split}`);
      expect(split, 'rows of one patient carry one value, so the sort keeps them adjacent').toBe(0);
    },
  );

  test.fixme(
    'AC2 as written: only Fertig Behandelt / Abgerechnet / Archiviert stop the clock',
    { tag: ['@Therapist', '@TBoardV2', '@UntreatedDays'] },
    async ({ page }) => {
      /**
       * FINDING — the fix excludes MORE statuses than the ticket asks for.
       *
       * AC2 names three: Fertig Behandelt (Finished), Abgerechnet (Invoiced), Archiviert (Archived).
       * `PatientTreatmentRecencyCalculator::TERMINAL_STATUSES` also holds **Abgelaufen** (Expired)
       * and **Abgebrochen** (Cancelled). The reasoning generalises — neither will be treated again —
       * but the effect is not cosmetic: a patient whose only documented treatment sits on a
       * cancelled or expired VO now reports NO value at all, paints "–", and can never appear in the
       * "14+ Tage nicht behandelt" hint, where the ticket's own rule would have shown them a gap.
       *
       * Measured live on staging 2026-08-25, three caseloads:
       *   Sandra Zeibig  — 6 of 49 patients affected, e.g. 8259 Lisa MontanaTest (947201-1
       *                    [Abgebrochen], last treated 2026-07-20): ticket rule 26, board shows "–".
       *                    Also 8428 Leonila QAtest (7 → "–"), 8426 Penn SalaTest (22 → "–"),
       *                    7827 KimSeokjin Test (33 → "–").
       *   Kevin Mischke  — 1 of 208 patients: 1881 Märy-Jeannette Pfeifer (2041-11 [Abgelaufen],
       *                    2026-06-12): ticket rule 52, board shows "–".
       *   Mara Nagel     — 0 of 32.
       *
       * Left `fixme` rather than asserted either way: which set is right is the PM's call. Un-fixme
       * this test if the ticket's three are confirmed; delete it if the wider set is confirmed.
       */
      test.setTimeout(300_000);
      const measure = new UntreatedDaysPage(page);
      const rows = await measure.open();
      const groups = UntreatedDaysPage.byPatient(rows);

      const affected: BoardRow[][] = [];
      for (const vos of groups.values()) {
        const byTicket = UntreatedDaysPage.latestEligibleTreatment(vos, TICKET_TERMINAL_STATUSES);
        const byImplementation = UntreatedDaysPage.latestEligibleTreatment(vos);
        if (byTicket !== null && byImplementation === null) affected.push(vos);
      }
      for (const vos of affected) {
        console.log(
          `${vos[0].patientId} ${vos[0].patientName}: ` +
            vos.map((v) => `${v.vo}[${v.status}]${v.lastTreatment?.toISOString().slice(0, 10) ?? '-'}`).join(' '),
        );
      }
      expect(
        affected.length,
        'under AC2 as written a cancelled or expired VO still dates the patient\'s last treatment',
      ).toBe(0);
    },
  );
});
