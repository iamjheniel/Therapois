import { test, expect } from '@playwright/test';
import {
  OrderingPullForwardPage,
  RULE,
  RULE_BEFORE,
  SCHEDULE,
  MARKER,
  ISO_DAY_NAME,
} from '../../../Pages/superadmin/sa.ordering-pull-forward.page';

/**
 * RC 3.14 — the ordering pull-forward moves to Tuesday so Wednesday's round includes it
 * (#3719, commit `c5adde88f`, PR #3720).
 *
 * #3299 pulled a VO whose projected reorder day fell Thursday–Sunday forward onto the **Wednesday**
 * run. The daily job fires at 20:15 UTC — 22:15 Berlin — so the flip landed hours AFTER the
 * Wednesday ordering round it was meant to join, and the team ordered the VO the following
 * Wednesday anyway: identical to having no pull-forward at all. This ticket moves the evaluation to
 * **Tuesday** and, with the base, widens the window by one day.
 *
 * **Merged into `release/3.14.0`; the arithmetic is verified exhaustively, the live outcome is not
 * observable on staging. 6 passed, 2 `fixme`.**
 *
 * ## Deployment is NOT client-decidable for this ticket, and that is stated rather than guessed
 *
 * The change is two constants inside a service that only a console command calls. Nothing is
 * serialized, and `/status` reports the release rather than the commit (#3704) — so unlike every
 * other RC 3.14 ticket in this suite there is no behavioural probe to reach for. What can be
 * verified is the rule itself, which is a pure function, and that is what this file does.
 *
 * ## The whole behaviour change is one set widening by one day
 *
 * ```
 * before: run Wednesday, k = 1..4  →  Thu Fri Sat Sun
 * after:  run Tuesday,   k = 1..5  →  Wed Thu Fri Sat Sun
 * ```
 *
 * Both rules are ported and compared **as sets**, which states AC2 (Wednesday gained), AC3 (Monday
 * and Tuesday in neither — they are 6 and 7 days out) and AC4 (nothing lost) more directly than any
 * single example VO could. The threshold half is untouched: `remaining <= ((lead + k) / 7) × freq`
 * is #3298's inequality in both versions, so a VO's projected trigger day does not move — only
 * which of those days get pulled forward.
 *
 * ## Option B, so the schedule is unchanged — and that is worth an assertion
 *
 * `TransitionOrderTaskScheduleRule` is still `cron(15 20 * * ? *)`, with the chain around it intact
 * (`RecalculateOrderingMetrics` 19:15, `TrackingTransition` 21:00). AC1's claim is about Berlin
 * business hours, so the offset matters: 20:15 UTC is **22:15 Berlin in summer and 21:15 in
 * winter, and both are still Tuesday**. A later cron would roll the Berlin date into Wednesday and
 * undo the ticket, which is exactly the failure #3299 had.
 *
 * ## FINDING: the marker and the German reason are still Wednesday-named
 *
 * The flip stamps `meta.wednesday_pull_forward` and the reason reads "— Mittwochs-Vorzug: regulär
 * fällig am …", unchanged by this ticket. Defensible (the pull-forward is still *for* the Wednesday
 * round, and the key keeps log history continuous), but the ticket's own QA step is "confirm in the
 * prescription's change log that it becomes orderable before Wednesday morning" — and the log a QA
 * reads on a **Tuesday** evening will say *Mittwochs*.
 *
 * ## Why the live outcome cannot be checked here
 *
 * Re-measured this run: **0 moves into `order` in the 3,000 most recent `follow_up_status_change`
 * rows**, automatic or manual, and **0 rows have ever carried the marker**. That is #3299's own
 * standing finding, unchanged — the nightly `app:prescription:transition-order` job produces no
 * order transitions on staging, so neither the old nor the new run day leaves a trace. The first
 * post-deploy Tuesday had not occurred when this was written either.
 *
 * **Read-only** — every request is a GET.
 */

test.describe('#3719 the ordering pull-forward runs on Tuesday', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC2/AC3/AC4 the target weekdays: Wednesday gained, nothing lost, Monday and Tuesday still never',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      const before = OrderingPullForwardPage.targetDayNames(RULE_BEFORE);
      const after = OrderingPullForwardPage.targetDayNames(RULE);
      console.log(`#3719 before (run ${ISO_DAY_NAME[RULE_BEFORE.runIsoDay]}, k=1..${RULE_BEFORE.maxDays}): ${before.join(' ')}`);
      console.log(`#3719 after  (run ${ISO_DAY_NAME[RULE.runIsoDay]}, k=1..${RULE.maxDays}): ${after.join(' ')}`);

      // The rule's own shape: Tuesday base, five days.
      expect(RULE.runIsoDay, 'the run day is Tuesday').toBe(2);
      expect(RULE.maxDays, 'and the window is five days').toBe(5);

      expect(before, "#3299's window").toEqual(['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].slice(1));
      expect(after, "#3719's window").toEqual(['Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

      // AC4 — every day that qualified before still qualifies.
      for (const day of before) expect(after, `AC4: ${day} still qualifies`).toContain(day);
      // AC2 — and exactly one day was added, Wednesday itself.
      const gained = after.filter((d) => !before.includes(d));
      console.log(`#3719 AC2 gained: ${JSON.stringify(gained)}`);
      expect(gained, 'AC2: Wednesday-due prescriptions are now in scope').toEqual(['Wednesday']);
      // AC3 — Monday and Tuesday are 6 and 7 days from a Tuesday, outside the cap, in both rules.
      for (const day of ['Monday', 'Tuesday']) {
        expect(after, `AC3: ${day} is never pulled forward`).not.toContain(day);
        expect(before, `AC3: ${day} was not before either`).not.toContain(day);
      }
      expect(OrderingPullForwardPage.targetIsoDay(RULE.runIsoDay, 6), 'Monday is 6 days out').toBe(1);
      expect(OrderingPullForwardPage.targetIsoDay(RULE.runIsoDay, 7), 'Tuesday is 7 days out').toBe(2);
    },
  );

  test(
    'AC1 the rule fires on Tuesday and no other day, so the flip precedes the round',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      // A VO whose trigger is one day out, run on each weekday in turn. Only Tuesday may pull it.
      const fired: string[] = [];
      for (let isoDay = 1; isoDay <= 7; isoDay++) {
        // 2026-09-21 is a Monday, so +(isoDay-1) days walks the week.
        const today = new Date(Date.UTC(2026, 8, 20 + isoDay));
        expect(OrderingPullForwardPage.isoDay(today), `fixture day ${isoDay}`).toBe(isoDay);
        const k = OrderingPullForwardPage.pullForwardDays({
          today,
          issueDate: new Date(Date.UTC(2026, 0, 1)),
          remainingTreatments: 15,
          decisionFrequencyPerWeek: 7,
          leadTimeDays: 14,
        });
        if (k !== null) fired.push(`${ISO_DAY_NAME[isoDay]}:k=${k}`);
      }
      console.log(`#3719 AC1 the rule fired on: ${JSON.stringify(fired)}`);
      expect(fired, 'AC1: only the Tuesday run pulls forward').toEqual(['Tuesday:k=1']);

      // And the Tuesday run lands on Tuesday EVENING in Berlin under both offsets — a later cron
      // would roll the date into Wednesday and reintroduce exactly #3299's defect.
      for (const offset of [1, 2] as const) {
        const { berlinHour, berlinIsoDay } = OrderingPullForwardPage.runsOnBerlinTuesdayEvening(offset);
        console.log(
          `#3719 AC1 ${SCHEDULE.cron} at UTC+${offset} → ${String(berlinHour).padStart(2, '0')}:15 ${ISO_DAY_NAME[berlinIsoDay]} Berlin`,
        );
        expect(berlinIsoDay, `AC1: still Tuesday at UTC+${offset}`).toBe(RULE.runIsoDay);
        expect(berlinHour, 'in the evening, before Wednesday morning').toBeGreaterThanOrEqual(20);
        expect(berlinHour, 'and before midnight').toBeLessThan(24);
      }
    },
  );

  test(
    'AC5 the issue-date floor is untouched: a VO is never pulled forward before it exists',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      const tuesday = new Date(Date.UTC(2026, 8, 22));
      expect(OrderingPullForwardPage.isoDay(tuesday), 'the fixture day is a Tuesday').toBe(2);
      const base = { today: tuesday, remainingTreatments: 15, decisionFrequencyPerWeek: 7, leadTimeDays: 14 };

      // Issued in the past, and on the run day itself: both allowed.
      expect(
        OrderingPullForwardPage.pullForwardDays({ ...base, issueDate: new Date(Date.UTC(2026, 8, 1)) }),
        'AC5: a VO issued earlier is pulled forward normally',
      ).toBe(1);
      expect(
        OrderingPullForwardPage.pullForwardDays({ ...base, issueDate: tuesday }),
        'AC5: issued today is not "before its own issue date"',
      ).toBe(1);
      // Issued after the run day: refused.
      expect(
        OrderingPullForwardPage.pullForwardDays({ ...base, issueDate: new Date(Date.UTC(2026, 8, 23)) }),
        'AC5: a VO issued tomorrow is never pulled forward onto today',
      ).toBeNull();
      // No issue date at all is not a refusal — the guard is `null !== issueDate && …`.
      expect(
        OrderingPullForwardPage.pullForwardDays({ ...base, issueDate: null }),
        'a VO with no issue date is not blocked by the floor',
      ).toBe(1);
    },
  );

  test(
    'the #3298 threshold is untouched, so a VO\'s projected trigger day does not move',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      // "Trigger in k days" is #3298's inequality with the lead window widened by k. Both rules use
      // the identical expression, so the only thing this ticket can change is which k values are
      // accepted — that is what keeps AC3's "reorder date is unaffected" true by construction.
      const lead = 14;
      const freq = 7;
      for (let remaining = 13; remaining <= 22; remaining++) {
        const now = OrderingPullForwardPage.pullForwardDays(
          { today: new Date(Date.UTC(2026, 8, 22)), remainingTreatments: remaining, decisionFrequencyPerWeek: freq, leadTimeDays: lead },
          RULE,
        );
        const then = OrderingPullForwardPage.pullForwardDays(
          { today: new Date(Date.UTC(2026, 8, 23)), remainingTreatments: remaining, decisionFrequencyPerWeek: freq, leadTimeDays: lead },
          RULE_BEFORE,
        );
        // With freq 7 and lead 14 the threshold is `remaining <= 14 + k`, so remaining = 14 + k is a
        // VO whose trigger is exactly k days out — the fixture arithmetic the unit tests use.
        const expectedK = remaining <= lead ? 1 : remaining - lead;
        console.log(
          `#3719 remaining=${remaining}: Tuesday run k=${now ?? '—'} (target ${now ? ISO_DAY_NAME[OrderingPullForwardPage.targetIsoDay(RULE.runIsoDay, now)] : '—'}), ` +
            `Wednesday run k=${then ?? '—'}`,
        );
        if (expectedK <= RULE.maxDays) {
          expect(now, `remaining=${remaining}: the Tuesday rule finds the trigger ${expectedK} days out`).toBe(expectedK);
        } else {
          expect(now, `remaining=${remaining}: beyond the window`).toBeNull();
        }
        // The same VO under the old rule, one day later: the same arithmetic, one day less of room.
        if (expectedK <= RULE_BEFORE.maxDays) {
          expect(then, `remaining=${remaining}: the old rule also found it`).toBe(expectedK);
        }
      }

      // The unchanged #3298 rule: a VO already at the threshold flips on its own day regardless.
      expect(OrderingPullForwardPage.wouldTransitionToday(14, 7, 14), 'remaining = lead → flips today anyway').toBe(true);
      expect(OrderingPullForwardPage.wouldTransitionToday(15, 7, 14), 'one more → needs the pull-forward').toBe(false);
    },
  );

  test(
    'the live trace: no move into `order` and no marker has ever been written on staging',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly', '@Slow'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new OrderingPullForwardPage(request);

      // Re-measured every run so the `fixme` below cannot go stale: the moment this job starts
      // producing order transitions on staging, the live ACs become testable.
      const scan = await api.orderTransitions();
      console.log(
        `#3719 scanned ${scan.scanned} follow_up_status_change rows (newest ${scan.newestRow}): ` +
          `${scan.intoOrder.length} moves into \`order\`, ${scan.marked.length} carrying \`${MARKER}\``,
      );
      expect(scan.scanned, 'the scan actually read rows').toBeGreaterThan(500);

      if (scan.intoOrder.length === 0) {
        console.log(
          '#3719 the nightly app:prescription:transition-order job produces NO order transitions on staging — ' +
            "#3299's standing finding, unchanged. Neither the old Wednesday run nor the new Tuesday run leaves a " +
            'trace here, so the live half of AC1/AC2/AC4 is unobservable until that changes.',
        );
      } else {
        const automatic = scan.intoOrder.filter((r) => r.automatic);
        console.log(`#3719 newest automatic move into order: ${automatic[0]?.at ?? 'none'}`);
      }

      // If a marked row ever appears, it must obey the new rule — a Tuesday stamp with k in 1..5.
      for (const row of scan.marked) {
        const isoDay = OrderingPullForwardPage.isoDay(new Date(row.at));
        console.log(`#3719 marked row ${row.at} (${ISO_DAY_NAME[isoDay]})`);
        expect(isoDay, 'a pull-forward is stamped on the run day').toBe(RULE.runIsoDay);
      }
    },
  );

  test(
    'the lead times the rule reads, and the next date it would fire',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new OrderingPullForwardPage(request);

      // `leadTimeDays` is the other half of the inequality (#3298). All-Standard means every VO on
      // staging is evaluated at the same 21 days, which is worth knowing before anyone reads a
      // population count off this environment (#3302 recorded the same).
      const lead = await api.leadTimes();
      console.log(`#3719 practice lead times: ${JSON.stringify(lead)}`);
      expect(lead.distinct.length, 'lead times are populated').toBeGreaterThan(0);

      const today = new Date();
      const next = OrderingPullForwardPage.nextRunDate(today);
      console.log(
        `#3719 today is ${ISO_DAY_NAME[OrderingPullForwardPage.isoDay(today)]} ${today.toISOString().slice(0, 10)}; ` +
          `the next pull-forward run is ${ISO_DAY_NAME[OrderingPullForwardPage.isoDay(next)]} ${next.toISOString().slice(0, 10)} at ${SCHEDULE.cron}`,
      );
      expect(OrderingPullForwardPage.isoDay(next), 'the next run is a Tuesday').toBe(RULE.runIsoDay);
    },
  );

});
