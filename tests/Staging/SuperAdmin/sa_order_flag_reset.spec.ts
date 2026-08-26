import { test, expect } from '@playwright/test';
import {
  LEAD_TIME_MAX,
  LEAD_TIME_MIN,
  ORDER_STATUS,
  OrderingLeadTimePage,
  STANDARD_LEAD_TIME,
} from '../../../Pages/superadmin/sa.ordering-lead-time.page';

/**
 * RC 3.11 #3302 — "One-Time Reset of Early-Flagged VOs Under the New Lead Times" (and the #3298
 * per-practice lead times it re-evaluates against).
 *
 * #3298 replaced the flat 21-day lookahead with a per-practice value; #3302 is the one-time command
 * that moved VOs back out of "Bestellen" when they no longer qualified — except where the team had
 * already acted on the order.
 *
 * **Read-only — every request is a GET.** The command was run on staging in apply mode on
 * 2026-08-12 (1,269 RESET / 270 KEPT / 214 SKIPPED_BLANKO / 94 SKIPPED_LATER_CHANGE), so its
 * *outcome* is readable per VO even though the command, its preview mode and its CSV are not.
 * AC3–AC5 are `fixme`'d at the bottom.
 *
 * **What cannot be re-derived today.** The lead times are a *rolling* 4-week measure. When the PM
 * verified this on 2026-08-12 the three RESET fixtures sat at practices measuring 25, 15 and 30
 * days, and 848 evaluated rows resolved an Individual value. Today **all 1,459 staging practices
 * read 21 days / Standard** — the windows have emptied. So the reset's *decisions* can no longer be
 * recomputed from live data; what these tests pin is the outcome state each VO was left in, which
 * is what AC1 and AC2 are actually about.
 */

/** The nine VOs the PM's run recorded, one per outcome category. */
const RESET = ['2105-8', '644-31', '4350-7'];
const KEPT = ['5878-5', '5300-3'];
const TEAM_ACTED = ['5891-3', '8191-1'];
const SKIPPED_BLANKO = ['4849-5', '3202-6'];

test.describe('One-time reset of early-flagged VOs (#3302)', () => {
  let ordering: OrderingLeadTimePage;

  test.beforeEach(async ({ page }) => {
    ordering = new OrderingLeadTimePage(page);
    await ordering.open();
  });

  test(
    'AC1 — VOs that no longer qualified were moved back out of "Bestellen"',
    { tag: ['@SuperAdmin', '@OrderFlagReset', '@LeadTime'] },
    async () => {
      test.setTimeout(180_000);

      const stillFlagged: string[] = [];
      for (const number of RESET) {
        const vo = await ordering.voByNumber(number);
        expect(vo, `${number} must resolve`).not.toBeNull();
        const practice = vo!.practiceId ? await ordering.practice(vo!.practiceId) : null;
        console.log(
          `[#3302] RESET ${number.padEnd(8)} followupStatus=${vo!.followupStatus ?? '(cleared)'} ` +
            `ordering=${vo!.orderingStatus} practice ${vo!.practiceId} now ` +
            `${practice?.leadTimeDays}d/${practice?.leadTimeSource}`,
        );
        if (vo!.followupStatus === ORDER_STATUS) stillFlagged.push(number);
      }

      // The field is omitted from the payload once cleared, so "reset" reads as absent.
      expect(stillFlagged, 'every RESET VO must have been returned to its prior state').toEqual([]);
    },
  );

  test(
    'AC2 — VOs the team had acted on, and the ones that still qualify, were left alone',
    { tag: ['@SuperAdmin', '@OrderFlagReset', '@LeadTime'] },
    async () => {
      test.setTimeout(240_000);

      const disturbed: string[] = [];

      for (const number of KEPT) {
        const vo = await ordering.voByNumber(number);
        expect(vo, `${number} must resolve`).not.toBeNull();
        console.log(`[#3302] KEPT       ${number.padEnd(8)} followupStatus=${vo!.followupStatus} ordering=${vo!.orderingStatus}`);
        if (vo!.followupStatus !== ORDER_STATUS) disturbed.push(`${number} (kept, but no longer in Bestellen)`);
      }

      for (const number of TEAM_ACTED) {
        const vo = await ordering.voByNumber(number);
        expect(vo, `${number} must resolve`).not.toBeNull();
        console.log(`[#3302] TEAM-ACTED ${number.padEnd(8)} followupStatus=${vo!.followupStatus} ordering=${vo!.orderingStatus}`);
        if (vo!.followupStatus !== ORDER_STATUS) disturbed.push(`${number} (team had acted, must be untouched)`);
        // "By Admin" is the marker that the team moved it on after the automatic transition — the
        // exact condition AC2 says must protect a VO from the reset.
        expect(vo!.orderingStatus, `${number} was moved on by the team`).toBe('By Admin');
      }

      for (const number of SKIPPED_BLANKO) {
        const vo = await ordering.voByNumber(number);
        expect(vo, `${number} must resolve`).not.toBeNull();
        console.log(`[#3302] BLANKO     ${number.padEnd(8)} followupStatus=${vo!.followupStatus} blanko=${vo!.blankoVO}`);
        expect(vo!.blankoVO, `${number} is the Blanko skip category`).toBe(true);
        if (vo!.followupStatus !== ORDER_STATUS) disturbed.push(`${number} (Blanko, excluded from re-evaluation)`);
      }

      expect(disturbed, 'the reset must not have touched any VO outside its RESET group').toEqual([]);
    },
  );

  test(
    '#3298 — every practice exposes a lead time inside the documented range',
    { tag: ['@SuperAdmin', '@OrderFlagReset', '@LeadTime'] },
    async () => {
      test.setTimeout(300_000);

      const practices = await ordering.allPracticeLeadTimes();
      const bySource: Record<string, number> = {};
      const byDays: Record<string, number> = {};
      const outOfRange: string[] = [];
      const badStandard: string[] = [];

      for (const practice of practices) {
        bySource[String(practice.leadTimeSource)] = (bySource[String(practice.leadTimeSource)] ?? 0) + 1;
        byDays[String(practice.leadTimeDays)] = (byDays[String(practice.leadTimeDays)] ?? 0) + 1;
        const days = practice.leadTimeDays;
        if (days === null || days < LEAD_TIME_MIN || days > LEAD_TIME_MAX) {
          outOfRange.push(`${practice.id} ${practice.name}: ${days}`);
        }
        if (practice.leadTimeSource === 'standard' && days !== STANDARD_LEAD_TIME) {
          badStandard.push(`${practice.id}: standard but ${days}d`);
        }
      }

      const individual = bySource['individual'] ?? 0;
      console.log(
        `[#3302] ${practices.length} practices — source ${JSON.stringify(bySource)}, days ${JSON.stringify(byDays)}\n` +
          `        ${individual} carry an Individual lead time today (the PM's 2026-08-12 run resolved 848)`,
      );

      expect(practices.length, 'the practice population must load').toBeGreaterThan(1000);
      expect(outOfRange, `every lead time must sit inside #3298's ${LEAD_TIME_MIN}–${LEAD_TIME_MAX} day clamp`).toEqual([]);
      expect(badStandard, `a Standard practice must read exactly ${STANDARD_LEAD_TIME} days`).toEqual([]);
    },
  );

  /**
   * **Deploy-day prerequisite, currently unmet on staging.**
   *
   * #3302's own go-live note makes the order mandatory: `app:practice:recalculate-ordering-metrics`
   * must run and populate Individual lead times *before* the reset command, because "running the
   * reset before the recalculation would evaluate everything against the 21-day standard, making the
   * run a no-op for lead-time purposes".
   *
   * Staging is in exactly that state right now — **0 of 1,459 practices** hold an Individual lead
   * time, against the 848 the PM's 2026-08-12 run resolved. That is consistent with #3298 working as
   * designed (the rolling 4-week window needs ≥3 completed order cycles and staging ordering
   * activity has stopped), and it is not separable from "the daily recalculation is no longer
   * running" using read-only data alone — both produce 21/Standard everywhere.
   *
   * Either way the production run must not be sequenced off a stale assumption: check that the
   * recalculation has populated Individual values immediately before the reset's preview.
   */
  test.fixme(
    'prerequisite — Individual lead times are populated before the reset is evaluated',
    { tag: ['@SuperAdmin', '@OrderFlagReset', '@LeadTime'] },
    async () => {
      // 0 of 1,459 staging practices carry an Individual lead time today; needs the recalculation
      // command to have run, which is not reachable from a browser.
    },
  );

  /**
   * AC3 (preview mode is the default and writes nothing), AC4 (the apply run produces a per-VO CSV)
   * and AC5 (the day-one volume is accepted) are all properties of the console command and its
   * report. The PM's evidence is the 2026-08-10 preview CSV (1,792 candidates) and the 2026-08-12
   * apply CSV (1,847 rows: 1,269 RESET / 270 KEPT / 214 SKIPPED_BLANKO / 94 SKIPPED_LATER_CHANGE).
   * The outcome those rows describe is asserted per VO above.
   */
  test.fixme(
    'AC3/AC4/AC5 — preview writes nothing, apply reports every changed VO, volume accepted',
    { tag: ['@SuperAdmin', '@OrderFlagReset', '@LeadTime'] },
    async () => {
      // Console-only: mode flag and CSV artefact, no HTTP surface.
    },
  );
});
