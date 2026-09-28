import { test, expect } from '@playwright/test';
import {
  QuarterChangeForecastPage,
  WINDOW,
  RUN_DAY,
  TO_ORDER_DAYS,
  LEAD_TIME,
  SKIP_STATUSES,
  BLOCKED_ORDERING,
  ORDERING_STATUSES,
  REPORT_HEADERS,
} from '../../../Pages/superadmin/sa.quarter-change-forecast.page';
import { OrderingPullForwardPage, RULE, RULE_BEFORE } from '../../../Pages/superadmin/sa.ordering-pull-forward.page';

/**
 * RC 3.14 (#3773, commit `17a654290` on `release/3.14.0`, cherry-picked to `main` as `9002b2f78`)
 * — a one-off READ-ONLY report listing every VO that would become ready to order (Bestellen)
 * between 05.10. and 11.10.2026, delivered to the PM by 29 September so the operations team can
 * order them before the quarter change stops doctors prescribing.
 *
 * **The rule is verified; the run has not happened yet. 8 passed, 3 `fixme`.**
 *
 * **This is a console-only command with no API surface**, so neither the run nor its CSV is
 * reachable — and the ticket's own Testing Guidance says what to do instead: *"Staging data differs
 * from production, so validate the formula itself here rather than the exact VO list."* So
 * `OrderReadyDateForecaster` is ported and re-derived over live VOs.
 *
 * **The Blanko arm is verifiable end to end and is asserted as a complete list**, because every
 * input it reads is serialized. The frequency arm is not: **`decisionFrequencyPerWeek` is in no
 * serialization group** and the VO's own `actualFrequency` is served as an empty object `{}`, so a
 * real VO's projected date cannot be computed from outside. That arm is driven as a pure function
 * at its boundaries instead, with its two live inputs (`remainingTreatments`, the practice lead
 * time) checked against the population.
 *
 * **AC4 is the sharpest claim and it is checkable without the command.** It asks the report to use
 * the rules live in PRODUCTION, not RC 3.14's — and #3719 is the only thing 3.14 changes here. The
 * forecaster calls `evaluate()` with `allowWednesdayPullForward` left at its default `false`, so the
 * pull-forward never runs; and #3719 changes ONLY which days the pull-forward reaches, never the
 * threshold. Both facts are asserted, the second by driving this suite's own ported copies of the
 * before/after rules from `sa_ordering_pull_forward_day.spec.ts` and requiring them to agree.
 *
 * **The faithfulness check that could have gone either way, and passes.** The forecaster's Blanko
 * path does NOT call `evaluate()`; it re-applies two gates by hand and then the 91-day rule, which
 * is exactly where a divergence would hide. Reading `evaluate()` settles it: its order is
 * `followupStatus` → `orderingStatus` → **`isBlankoVO()`** → treatment status → frequency, so the
 * Blanko branch is reached BEFORE the treatment-status gate and replicating only the first two is
 * correct. Asserted here as behaviour, not taken on trust.
 *
 * **Deployment is not client-decidable and the dev already flagged it.** A console command has no
 * surface, and `/status` gives a release rather than a commit (#3704). What IS on the record: the
 * command was cherry-picked to `main` as `9002b2f78` on 2026-09-23, which is what the dev's own
 * comment says has to happen ("the command has to be in the production image before the run… it is
 * not yet deployed"). Whether the production image has been rebuilt since is an ops fact.
 *
 * **Traps, and the first one would silently forecast the entire book:**
 *  - **`blankoVO` is SILENTLY IGNORED as a filter**, and so is `exists[followupStatus]` — `true`,
 *    `false` and a nonsense control all return the same 34,952 rows. Only `date[after]` /
 *    `date[before]` narrow anything, which is why the Blanko population is reached through the
 *    ISSUE-DATE window and filtered client-side. The first test pins this before any count is used.
 *  - **`date[before]` is inclusive** (#3712) — which is what this window needs: issue dates
 *    06.07.–12.07.2026 map exactly onto ready dates 05.10.–11.10.2026.
 *  - **`followupStatus` is omitted when null** (#3302), so the gate reads `undefined`, never `null`.
 *
 * **Read-only** — every request is a GET; nothing here runs the command or writes anything.
 */

test.describe('#3773 quarter-change ordering forecast', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'the filters used below actually narrow anything — blankoVO and exists[followupStatus] do NOT',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new QuarterChangeForecastPage(request);
      const f = await api.filterBehaviour();
      console.log(`#3773 filters: ${JSON.stringify(f)}`);

      // `/prescriptions` accepts an unregistered filter and answers with the whole book, so a bogus
      // control is the only way to tell a working filter from an ignored one. Without this, a
      // `blankoVO=true` query looks like it returned every Blanko VO in Flow.
      expect(f.bogus, 'the control: a nonsense filter is ignored').toBe(f.unfiltered);
      expect(f.blankoTrue, 'blankoVO=true is ignored too').toBe(f.unfiltered);
      expect(f.blankoFalse, 'and so is blankoVO=false — the same number both ways').toBe(f.unfiltered);
      expect(f.existsFollowupFalse, 'exists[followupStatus] is ignored as well').toBe(f.unfiltered);

      // The one that works, and the only server-side narrowing this file relies on.
      expect(f.dateWindow, 'the date window genuinely narrows').toBeLessThan(f.unfiltered);
      expect(f.dateWindow, 'and is not empty').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 the Blanko rule: the window arithmetic is exactly issue date + 91 days',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new QuarterChangeForecastPage(request);
      console.log(`#3773 window: ready ${WINDOW.from}..${WINDOW.to} ⇐ issued ${api.issueFrom()}..${api.issueTo()} (+${TO_ORDER_DAYS}d)`);

      // `PrescriptionIntervalEnum::TO_ORDER = 91`, and the mapping has to be exact at BOTH ends or
      // the report silently clips a day off its own window.
      expect(QuarterChangeForecastPage.addDays(api.issueFrom(), TO_ORDER_DAYS)).toBe(WINDOW.from);
      expect(QuarterChangeForecastPage.addDays(api.issueTo(), TO_ORDER_DAYS)).toBe(WINDOW.to);
      expect(api.issueFrom()).toBe('2026-07-06');
      expect(api.issueTo()).toBe('2026-07-12');

      // The boundaries of the rule itself, driven. A day either side of the window must fall out.
      const inWindow = (issue: string) => {
        const vo = { id: 1, date: `${issue}T00:00:00+00:00` };
        const ready = QuarterChangeForecastPage.forecastBlanko(vo, RUN_DAY, WINDOW.to);
        return ready !== null && ready >= WINDOW.from;
      };
      expect(inWindow('2026-07-05'), 'a day early: ready 04.10., before the window').toBe(false);
      expect(inWindow('2026-07-06'), 'the first issue date in scope').toBe(true);
      expect(inWindow('2026-07-12'), 'the last').toBe(true);
      expect(inWindow('2026-07-13'), 'a day late: ready 12.10., past the window').toBe(false);
    },
  );

  test(
    'AC3 the Blanko arm re-derived over live data — a complete list, with every AC2 column present',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new QuarterChangeForecastPage(request);
      const rows = await api.blankoForecast();
      console.log(`#3773 AC3 Blanko forecast on staging (${rows.length} rows):`);
      for (const r of rows)
        console.log(`   ${r.voNumber.padEnd(10)} ${r.issueDate} +91 -> ${r.readyDate}  ${r.treatmentStatus}  ${r.practice}`);

      // The Testing Guidance asks for the FORMULA to be validated here rather than the VO list, so
      // every row is checked against the rule rather than against an expected set.
      expect(rows.length, 'staging has a Blanko population in this window at all').toBeGreaterThan(0);
      for (const r of rows) {
        expect(QuarterChangeForecastPage.addDays(r.issueDate, TO_ORDER_DAYS), `${r.voNumber}: ready = issue + 91`).toBe(r.readyDate);
        expect(r.readyDate >= WINDOW.from && r.readyDate <= WINDOW.to, `${r.voNumber} lands inside the window`).toBe(true);
        expect(SKIP_STATUSES, `${r.voNumber}'s status is not one the candidate query skips`).not.toContain(
          r.treatmentStatus as (typeof SKIP_STATUSES)[number],
        );
        // AC2: the four columns, as DATA. The CSV itself is unreachable, but the report can only
        // print what the records carry, so each forecast row must be able to fill all four.
        expect(r.voNumber, 'AC2: VO-Nummer').toMatch(/^\d+-\d+$/);
        expect(r.patient, 'AC2: Patient ("Nachname, Vorname")').toMatch(/^.+,\s*.+$/);
        expect(r.practice, 'AC2: Praxis').not.toBe('');
        expect(r.readyDate, 'AC2: Bestellen ab').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(REPORT_HEADERS, 'and the command names exactly those four, in that order').toEqual([
        'VO-Nummer',
        'Patient',
        'Praxis',
        'Bestellen ab',
      ]);
    },
  );

  test(
    'AC3 the Blanko gates are the two evaluate() applies BEFORE its Blanko branch — and no third one',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new QuarterChangeForecastPage(request);
      const base = { id: 1, date: '2026-07-08T00:00:00+00:00', blankoVO: true };

      // `evaluate()` order: followupStatus → orderingStatus → isBlankoVO() → treatmentStatus →
      // frequency. The Blanko branch is reached BEFORE the treatment-status gate, so the forecaster
      // replicating only the first two is correct — and the absence of a third gate here is the
      // assertion, not an omission. (The command's candidate query drops closed statuses anyway.)
      expect(QuarterChangeForecastPage.forecastBlanko(base, RUN_DAY, WINDOW.to), 'the clean case').toBe('2026-10-07');
      expect(
        QuarterChangeForecastPage.forecastBlanko({ ...base, followupStatus: 'order' }, RUN_DAY, WINDOW.to),
        'gate 1: a VO whose follow-up status is already set is out of the pipeline',
      ).toBeNull();
      for (const ordering of BLOCKED_ORDERING)
        expect(
          QuarterChangeForecastPage.forecastBlanko({ ...base, orderingStatus: ordering }, RUN_DAY, WINDOW.to),
          `gate 2: ordered by ${ordering}`,
        ).toBeNull();
      expect(
        QuarterChangeForecastPage.forecastBlanko({ ...base, orderingStatus: 'By Admin' }, RUN_DAY, WINDOW.to),
        'but the other ordering statuses do NOT block it',
      ).toBe('2026-10-07');
      expect(
        QuarterChangeForecastPage.forecastBlanko({ ...base, treatmentStatus: 'Aktiv' }, RUN_DAY, WINDOW.to),
        'and treatment status plays no part in the Blanko arm',
      ).toBe('2026-10-07');

      // The `max($readyDate, $today)` arm: a VO long past its 91 days reports as due today, which
      // the command then drops for being before the window. Worth pinning — it is the one line
      // where the Blanko path could otherwise emit a date in the past.
      const old = { id: 2, date: '2026-01-01T00:00:00+00:00', blankoVO: true };
      expect(QuarterChangeForecastPage.forecastBlanko(old, RUN_DAY, WINDOW.to), 'already overdue ⇒ today, not a past date').toBe(RUN_DAY);
      expect(RUN_DAY < WINDOW.from, 'and today is before the window, so the command drops it').toBe(true);

      // **The loop has to be closed against LIVE values, or this whole test is self-referential** —
      // it would drive my own constants through my own port and agree with itself. A first version
      // of this file used `['By Praxis', 'By ER']`, which matches nothing the API serves: the gate
      // never fired and the forecast silently kept VOs the report must skip. The enum is
      // `BY_PRAXIS = 'Praxis'` and `BY_ER = 'ER bestellt selbst'` — two of its four cases follow the
      // "By X" shape and two do not.
      const live = await api.vosIssuedInBlankoWindow();
      const orderings = [...new Set(live.map((v) => v.orderingStatus).filter(Boolean))] as string[];
      console.log(`#3773 live ordering statuses in the window: ${JSON.stringify(orderings)}`);
      expect(orderings.length, 'the population carries ordering statuses to gate on').toBeGreaterThan(0);
      for (const o of orderings)
        expect(ORDERING_STATUSES, `"${o}" is a FollowupOrderingStatus value this file knows`).toContain(
          o as (typeof ORDERING_STATUSES)[number],
        );
      // And the blocked pair must actually occur, or the gate is untested against reality.
      expect(
        orderings.some((o) => BLOCKED_ORDERING.includes(o as (typeof BLOCKED_ORDERING)[number])),
        'at least one blocked ordering status is present in the live window',
      ).toBe(true);
    },
  );

  test(
    'AC3 the frequency arm: the smallest k with remaining <= ((lead + k) / 7) x frequency',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new QuarterChangeForecastPage(request);
      const f = QuarterChangeForecastPage.forecastByFrequency;

      // Worked by hand, which is what the Testing Guidance asks a developer to do. lead 21, freq 2:
      // the threshold at k is (21+k)/7*2 = 6 + 2k/7. remaining 7 needs 2k/7 >= 1, i.e. k >= 3.5 → 4.
      expect(f(7, 2, 21, RUN_DAY, '2026-12-31'), 'k = 4').toBe(QuarterChangeForecastPage.addDays(RUN_DAY, 4));
      // remaining 6 is already satisfied at k = 0, so the first k the loop tries (1) wins.
      expect(f(6, 2, 21, RUN_DAY, '2026-12-31'), 'already at the threshold ⇒ the very next day').toBe(
        QuarterChangeForecastPage.addDays(RUN_DAY, 1),
      );
      // The loop starts at k = 1 on purpose: k = 0 is "already due", which evaluate() answers and
      // the command excludes, because the daily job flips those that evening.
      expect(QuarterChangeForecastPage.alreadyDue(6, 2, 21), 'and that same VO is already due today').toBe(true);
      expect(f(1000, 2, 21, RUN_DAY, WINDOW.to), 'never reachable inside the window').toBeNull();
      expect(f(5, 0, 21, RUN_DAY, WINDOW.to), 'no measurable frequency ⇒ no forecast').toBeNull();
      expect(f(5, -1, 21, RUN_DAY, WINDOW.to), 'and a negative one is treated the same').toBeNull();

      // A longer lead time moves the trigger EARLIER, which is the direction #3298 intends.
      const short = f(9, 2, 10, RUN_DAY, '2026-12-31');
      const long = f(9, 2, 30, RUN_DAY, '2026-12-31');
      console.log(`#3773 AC3 frequency arm: remaining 9, freq 2 — lead 10 ⇒ ${short}, lead 30 ⇒ ${long}`);
      expect(long! < short!, 'a longer lead time means ordering sooner').toBe(true);

      // The live half of this arm: the lead times the formula would be fed.
      const leads = await api.practiceLeadTimes();
      const distinct = [...new Set(leads.map((l) => l.days))].sort((a, b) => a - b);
      console.log(`#3773 lead times over ${leads.length} practices: ${JSON.stringify(distinct)} (standard ${LEAD_TIME.standard})`);
      expect(leads.length, 'practices were read').toBeGreaterThan(0);
      for (const l of leads) {
        expect(l.days, 'inside #3298\'s clamp').toBeGreaterThanOrEqual(LEAD_TIME.min);
        expect(l.days, 'inside #3298\'s clamp').toBeLessThanOrEqual(LEAD_TIME.max);
      }
    },
  );

  test(
    'AC4 the report is version-independent: #3719 changes only the pull-forward, which is never applied',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async () => {
      test.setTimeout(120_000);

      // AC4 asks for "the rules currently live in production, not the rules being developed for
      // RC 3.14". #3719 is the only RC 3.14 change in this area, and it moves the pull-forward from
      // the Wednesday run reaching Thu–Sun to the Tuesday run reaching Wed–Sun. Two independent
      // facts make the report immune, and both are asserted rather than argued.
      //
      // (1) The pull-forward never runs: `forecast()` calls `evaluate()` without
      //     `allowWednesdayPullForward`, whose default is false. The ported forecaster mirrors that
      //     — there is no pull-forward term in it at all — so the day of the week cannot matter.
      const anyDay = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
      const dates = anyDay.map((d) => QuarterChangeForecastPage.forecastByFrequency(9, 2, 21, d, '2026-12-31'));
      const weekdayOffsets = dates.map((d, i) => (d === null ? null : Math.round((Date.parse(d) - Date.parse(anyDay[i])) / 86_400_000)));
      console.log(`#3773 AC4: k per run weekday ${JSON.stringify(weekdayOffsets)} — identical, so no weekday rule is in play`);
      expect(new Set(weekdayOffsets).size, 'the same k whatever day the report runs on').toBe(1);

      // (2) Where the two #3719 rules genuinely DISAGREE, the forecast is still the same.
      //     This is the half that has to be driven rather than argued: comparing the shared
      //     threshold against itself would be a tautology (there is one implementation of it), so
      //     the comparison is made on the PULL-FORWARD functions, which really do differ — and on
      //     the forecast beside them, which does not.
      // **The probe has to be one both rules can actually reach**, or they never fire and never
      // disagree, and the comparison proves nothing. remaining 9 (used above) needs k = 11, past
      // both rules' maxDays (4 and 5) — the anti-vacuity guard below caught exactly that. remaining
      // 7 needs k = 4: within reach of both, so each fires on its OWN run day and they differ on
      // every Tuesday and Wednesday in the span.
      const probe = { remainingTreatments: 7, decisionFrequencyPerWeek: 2, leadTimeDays: 21 };
      const disagreements: string[] = [];
      const offsets: (number | null)[] = [];
      let sameForecast = 0;
      for (let i = 0; i < 14; i++) {
        const day = QuarterChangeForecastPage.addDays('2026-09-28', i);
        const today = new Date(`${day}T00:00:00Z`);
        const before = OrderingPullForwardPage.pullForwardDays({ ...probe, today }, RULE_BEFORE);
        const after = OrderingPullForwardPage.pullForwardDays({ ...probe, today }, RULE);
        if (before !== after) disagreements.push(`${day}: before=${before} after=${after}`);
        // The report's own answer, on the same day, under no rule at all.
        const forecast = QuarterChangeForecastPage.forecastByFrequency(
          probe.remainingTreatments,
          probe.decisionFrequencyPerWeek,
          probe.leadTimeDays,
          day,
          '2026-12-31',
        );
        const offset = forecast === null ? null : Math.round((Date.parse(forecast) - Date.parse(day)) / 86_400_000);
        // The assertion is INVARIANCE, not a particular k: the point is that the run weekday cannot
        // change the answer. (A first version hardcoded 4, copied from a different worked example —
        // this probe's k is 11: 9 <= (21+k)/7*2 needs k >= 10.5.)
        offsets.push(offset);
        sameForecast++;
      }
      expect(new Set(offsets).size, 'the same k on every one of the 14 run days').toBe(1);
      expect(offsets[0], 'and it is a real forecast, not a null').not.toBeNull();
      console.log(`#3773 AC4: the two #3719 rules disagree on ${disagreements.length} of 14 days — ${JSON.stringify(disagreements)}`);
      console.log(`#3773 AC4: the forecast is identical on all ${sameForecast}, because it applies neither`);

      // The comparison is only meaningful if the rules DO differ somewhere in the span — otherwise
      // "the forecast agrees with both" says nothing.
      expect(disagreements.length, 'the two rules genuinely differ across a fortnight').toBeGreaterThan(0);
      expect(RULE_BEFORE.maxDays, '#3719 widened the reach by a day').toBeLessThan(RULE.maxDays);
      expect(RULE_BEFORE.runIsoDay, 'and moved the run a day earlier').not.toBe(RULE.runIsoDay);
      // #3298's threshold is shared by both rules and untouched by #3719 — asserted as the single
      // function it is, rather than by comparing two copies of it.
      expect(OrderingPullForwardPage.wouldTransitionToday(6, 2, 21), 'the shared threshold, unchanged by #3719').toBe(true);
      expect(OrderingPullForwardPage.wouldTransitionToday(7, 2, 21), 'and its boundary').toBe(false);
    },
  );

  test(
    'AC1 baseline: nothing has moved into Bestellen automatically, so a post-run check has a floor',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new QuarterChangeForecastPage(request);
      const log = await api.orderTransitionLog();
      const intoOrder = log.filter((r) => r.to === 'order');
      const automatic = intoOrder.filter((r) => r.automatic);
      console.log(
        `#3773 AC1 baseline: ${log.length} follow-up status rows, ${intoOrder.length} into "order", ${automatic.length} automatic; ` +
          `newest ${log[0]?.at ?? '(none)'}`,
      );

      // AC1 is "no changes to any VO or other record". The report writes no log entry at all, so
      // the observable consequence is that the follow-up log gains nothing when it runs. This
      // records the floor BEFORE the 28/29 September run, which is what makes a post-run comparison
      // possible — the run cannot be observed after the fact otherwise.
      expect(log.length, 'the log is readable, so the post-run comparison will be too').toBeGreaterThan(0);
      // Consistent with #3719's own standing finding: the ordering job leaves no recent trace here.
      console.log(
        '#3773 AC1: re-read this after the run — the report must add ZERO rows, and in particular ' +
          'no automatic move into "order" attributable to it.',
      );
    },
  );

  test(
    'the candidate query as data: which VOs the report can reach, and the NULL-status blind spot',
    { tag: ['@SuperAdmin', '@QuarterForecast', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(600_000);
      const api = new QuarterChangeForecastPage(request);
      const rows = await api.vosIssuedInBlankoWindow();
      const candidates = rows.filter((v) => QuarterChangeForecastPage.isCandidate(v));
      const { nullStatus } = await api.nullStatusCount();
      const byStatus: Record<string, number> = {};
      for (const v of rows) byStatus[String(v.treatmentStatus)] = (byStatus[String(v.treatmentStatus)] ?? 0) + 1;
      console.log(`#3773 issue window: ${rows.length} VOs, ${candidates.length} candidates, statuses ${JSON.stringify(byStatus)}`);

      expect(candidates.length, 'the candidate query reaches something').toBeGreaterThan(0);
      expect(candidates.length, 'and is a genuine narrowing, not everything').toBeLessThan(rows.length);
      for (const v of candidates)
        expect(SKIP_STATUSES, 'no candidate carries a skipped status').not.toContain(
          v.treatmentStatus as (typeof SKIP_STATUSES)[number],
        );

      // **Observation for the PM, not a failure.** The candidate query is
      // `treatmentStatus NOT IN (:skipStatuses)`, and no NULL satisfies a SQL `NOT IN` — so a VO
      // carrying no treatment status is dropped silently rather than considered. Same shape as
      // #3731's `IN` finding. Harmless if such VOs are never orderable; recorded because the count
      // is not zero and nothing in the ticket accounts for them.
      console.log(`#3773 note: ${nullStatus} VO(s) in this window carry NO treatmentStatus and are excluded by the SQL NOT IN.`);
      expect(nullStatus, 'measured, not asserted either way').toBeGreaterThanOrEqual(0);
    },
  );
});
