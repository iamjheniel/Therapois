import { test, expect } from '@playwright/test';
import {
  FollowUpChange,
  MAX_PULL_FORWARD_DAYS,
  ORDER_STATUS,
  OrderingLeadTimePage,
  PULLED_FORWARD_DAYS,
  PULL_FORWARD_META,
  PULL_FORWARD_SHIPPED_AT,
  WEDNESDAY_ISO_DAY,
} from '../../../Pages/superadmin/sa.ordering-lead-time.page';

/**
 * RC 3.11 #3299 — "Wednesday Pull-Forward: Thursday–Sunday Ordering Flips Happen on Wednesday".
 *
 * #3298 moves a follow-up VO into "Bestellen" on the day its practice's lead time is reached.
 * #3299 says that if that day falls Thursday–Sunday, the nightly job moves it on the preceding
 * Wednesday instead (at most 4 days early, never before the VO's issue date), so the VO is already
 * on the board for the team's Wednesday ordering round. Mon/Tue/Wed triggers are untouched.
 *
 * **Read-only: every request is a GET.**
 *
 * The observable trace is the audit log. The fix stamps a `follow_up_status_change` entry with
 * `wednesday_pull_forward`, `pull_forward_days` and `regular_ready_date`, and the reason string
 * carries "Mittwochs-Vorzug". That is what these tests look for.
 *
 * **Most of them cannot run on staging today, and skip loudly rather than passing vacuously.** The
 * feature only leaves a trace when the nightly job runs *on a Wednesday* and finds a VO due
 * Thursday–Sunday, and neither precondition currently holds — see the findings logged by the
 * inventory test and the `fixme` at the bottom. A green run with an empty population would be
 * exactly the misleading signal this suite is meant to avoid.
 */

/** How far back the log is walked. 200 rows/page; the collection needs its `type` filter. */
const LOG_PAGES = 60;

test.describe('Wednesday pull-forward for ordering flips (#3299)', () => {
  let ordering: OrderingLeadTimePage;

  test.beforeEach(async ({ page }) => {
    ordering = new OrderingLeadTimePage(page);
    await ordering.open();
  });

  test(
    'the follow-up status history is queryable and "Bestellen" is a live population',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const changes = await ordering.followUpStatusChanges(2);
      const inOrder = await ordering.orderPopulation();

      console.log(
        `[#3299] ${changes.length} follow_up_status_change rows read; ` +
          `${inOrder} VOs currently in "${ORDER_STATUS}" (Bestellen)`,
      );

      expect(changes.length, 'the audit log must be readable — it is the only trace of the flip').toBeGreaterThan(0);
      expect(
        changes.every((c) => c.createdAt instanceof Date && !Number.isNaN(c.createdAt.getTime())),
        'every entry carries a usable timestamp',
      ).toBe(true);
      expect(inOrder, 'VOs sit in Bestellen, so the status this ticket schedules is in use').toBeGreaterThan(0);
    },
  );

  test(
    'inventory — how VOs entered "Bestellen", and whether any carries the pull-forward marker',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      const changes = await ordering.followUpStatusChanges(LOG_PAGES);
      const intoOrder = changes.filter((c) => c.newValue === ORDER_STATUS);
      const automatic = intoOrder.filter(OrderingLeadTimePage.isAutomatic);
      const marked = changes.filter((c) => c.meta[PULL_FORWARD_META] !== undefined);

      const oldest = changes.length ? changes[changes.length - 1].createdAt.toISOString().slice(0, 10) : '-';
      const newest = changes.length ? changes[0].createdAt.toISOString().slice(0, 10) : '-';
      const byMonth: Record<string, number> = {};
      for (const change of intoOrder) {
        const key = change.createdAt.toISOString().slice(0, 7);
        byMonth[key] = (byMonth[key] ?? 0) + 1;
      }

      console.log(
        `[#3299] scanned ${changes.length} status changes, ${newest} back to ${oldest}\n` +
          `        ${intoOrder.length} moved INTO "${ORDER_STATUS}" — ${automatic.length} of them automatic\n` +
          `        by month: ${JSON.stringify(byMonth)}\n` +
          `        entries carrying "${PULL_FORWARD_META}": ${marked.length}`,
      );

      // The surface is sound and the inventory is the point of this test; it makes no claim about
      // the feature either way. The assertions below it are the ones that need a population.
      expect(changes.length, 'the scan must reach a meaningful depth').toBeGreaterThan(1000);

      if (!automatic.length) {
        console.log(
          `[#3299] FINDING: not one of the ${intoOrder.length} moves into "${ORDER_STATUS}" in this window is ` +
            'automatic — every one is meta.type "manual". The nightly job has left no trace here, so #3299 ' +
            'has nothing to be observed on.',
        );
      }
      if (!marked.length) {
        console.log(
          `[#3299] FINDING: no entry in ${changes.length} rows carries "${PULL_FORWARD_META}". ` +
            'The pull-forward has never stamped a log row in this window.',
        );
      }
    },
  );

  test(
    'AC1 — no automatic move into "Bestellen" lands Thursday–Sunday',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      const changes = await ordering.followUpStatusChanges(LOG_PAGES);
      const allAutomatic = changes.filter((c) => c.newValue === ORDER_STATUS && OrderingLeadTimePage.isAutomatic(c));
      // Two filters, both essential:
      //  - manual moves are a person's choice of day and outside this rule entirely — counting them
      //    would flag ordinary Thursday admin work as a pull-forward failure;
      //  - anything logged before the fix shipped predates the rule. Staging's whole automatic
      //    ordering history is January–February 2026, so without this cutoff its 255 Thu–Sun moves
      //    read as violations of a rule that did not exist yet.
      const automatic = allAutomatic.filter((c) => c.createdAt >= PULL_FORWARD_SHIPPED_AT);

      const preFix = allAutomatic.length - automatic.length;
      console.log(
        `[#3299] ${allAutomatic.length} automatic moves into "${ORDER_STATUS}"; ` +
          `${preFix} predate the fix (${PULL_FORWARD_SHIPPED_AT.toISOString().slice(0, 10)}), ${automatic.length} follow it`,
      );

      test.skip(
        automatic.length === 0,
        `no automatic move into "${ORDER_STATUS}" since the fix shipped — all ${allAutomatic.length} ` +
          `in ${changes.length} scanned rows predate it, so the Wednesday rule has had nothing to act on`,
      );

      const byWeekday: Record<number, number> = {};
      for (const change of automatic) {
        const day = OrderingLeadTimePage.isoWeekday(change.createdAt);
        byWeekday[day] = (byWeekday[day] ?? 0) + 1;
      }
      console.log(`[#3299] automatic moves by ISO weekday (1=Mon): ${JSON.stringify(byWeekday)}`);

      const late = automatic.filter((c) => PULLED_FORWARD_DAYS.includes(OrderingLeadTimePage.isoWeekday(c.createdAt)));
      expect(
        late.map((c) => `${c.prescription} ${c.createdAt.toISOString().slice(0, 10)}`),
        'a VO due Thursday–Sunday must have been moved on the preceding Wednesday instead',
      ).toEqual([]);
    },
  );

  test(
    'AC1/AC2/AC3 — every pull-forward entry moves a Thu–Sun trigger onto a Wednesday, by at most 4 days',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);

      const changes = await ordering.followUpStatusChanges(LOG_PAGES);
      const marked = changes.filter((c) => c.meta[PULL_FORWARD_META]);

      test.skip(
        marked.length === 0,
        `no entry carrying "${PULL_FORWARD_META}" in ${changes.length} scanned rows — the nightly job ` +
          'has not pulled a VO forward on this environment',
      );

      const problems: string[] = [];
      for (const entry of marked) {
        const days = Number(entry.meta.pull_forward_days);
        const regular = entry.meta.regular_ready_date ? new Date(entry.meta.regular_ready_date) : null;
        const actualDay = OrderingLeadTimePage.isoWeekday(entry.createdAt);
        const label = `${entry.prescription} @${entry.createdAt.toISOString().slice(0, 10)}`;

        // AC1's table, read back off the data: the flip happened on a Wednesday, the day it would
        // otherwise have happened was Thu–Sun, and the move was 1–4 days and only ever earlier.
        if (actualDay !== WEDNESDAY_ISO_DAY) problems.push(`${label}: flipped on ISO day ${actualDay}, not Wednesday`);
        if (!(days >= 1 && days <= MAX_PULL_FORWARD_DAYS)) problems.push(`${label}: pull_forward_days ${days}`);
        if (!regular) problems.push(`${label}: no regular_ready_date`);
        else {
          if (!PULLED_FORWARD_DAYS.includes(OrderingLeadTimePage.isoWeekday(regular))) {
            problems.push(`${label}: regular date ${regular.toISOString().slice(0, 10)} is not Thu–Sun (AC3)`);
          }
          if (regular <= entry.createdAt) problems.push(`${label}: pull-forward did not move the date earlier`);
        }
      }

      console.log(`[#3299] ${marked.length} pull-forward entries checked, ${problems.length} problems`);
      expect(problems, 'every pull-forward entry must satisfy AC1\'s weekday table').toEqual([]);
    },
  );

  /**
   * **Why the two assertions above cannot run on staging today.**
   *
   * A pull-forward only happens when the nightly `app:transition-to-order` job runs *on a Wednesday*
   * and finds a VO whose practice lead time places it Thursday–Sunday. Neither input is present:
   *
   *  - **No automatic ordering activity since the fix.** Across 12,000 `follow_up_status_change`
   *    rows back to 2026-01-17 there are 2,464 moves into "Bestellen", 633 of them automatic — but
   *    every single one falls in **January–February 2026**, before the fix merged on 2026-08-12. The
   *    window 2026-06-30 → 2026-08-18 — which contains Wednesday 2026-08-12, the day the PM records
   *    the job being run — holds **zero** moves into "Bestellen" of any kind. (Those 633 pre-fix
   *    moves include 255 on a Thursday–Sunday, which is exactly what the rule now prevents and
   *    exactly why the assertion is scoped to entries after the ship date.)
   *  - **No marker anywhere.** None of those 12,000 rows carries `wednesday_pull_forward`,
   *    `pull_forward_days` or `regular_ready_date`; every `meta` is `{type: …}` and nothing else.
   *  - **No Individual lead times to trigger against.** All 1,459 staging practices read 21 days /
   *    Standard (see `sa_order_flag_reset.spec.ts`), so #3298's per-practice date — the input this
   *    ticket shifts — is not in play.
   *
   * None of that shows the feature is broken: the fix ships with unit tests over all seven weekday
   * scenarios and the reviewer traced the code path. It shows the *evidence* is absent here, so the
   * PM's AC2 observation (CRM "Heute bestellen" rising 155 → 177 on Wed 2026-08-12) cannot be
   * corroborated from the data, and #3299 is not re-verifiable read-only until the nightly job runs
   * on a Wednesday against populated Individual lead times.
   */
  test.fixme(
    'AC2 — a VO due Saturday appears under "Heute bestellen" on the preceding Wednesday',
    { tag: ['@SuperAdmin', '@OrderPullForward', '@ReadOnly'] },
    async () => {
      // Needs the nightly job to have run on a Wednesday with Individual lead times populated;
      // neither holds on staging today. See the block comment above for the evidence.
    },
  );
});
