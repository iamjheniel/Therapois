import { test, expect } from '@playwright/test';
import { PerTreatmentFeePage, KIND } from '../../../Pages/superadmin/sa.per-treatment-fee.page';

/**
 * RC 3.12 (#3484) — a per-treatment fee removed from a day's session must stop being billed.
 *
 * Both revenue engines billed every fee on the VO's prescribed list once per VO per day
 * unconditionally, so deleting the fee's `ActivityTreatment` row left the VO total, its invoice,
 * the KPI figures and the exports reporting a fee the session no longer showed — Stefan's
 * VO 6330-7, rows 363,30 EUR against a total of 387,30 EUR.
 *
 * **Deployed on staging (`838538240`, PR #3498, merged into `release/3.12.0` on 2026-08-26;
 * `GET /status` reports 3.12.0), and every AC that can be reached from a client is verified —
 * four of them by MAKING the change rather than by observing leftovers.**
 *
 * **The ticket's own VO no longer reproduces the bug, and that trap is the reason this file
 * mutates.** All seven of 6330-7's sessions carry HBH-PT again today; five are countable (two are
 * rejected without signature), so its total is 5 x (39,00 + 24,00) + 9,30 = **324,30** — neither
 * of the ticket's two numbers, and a figure the pre-fix and post-fix rules agree on. Anything
 * asserted by looking at 6330-7 as it stands would pass against the unfixed build. The PM's own
 * note records "6 of 6 ACs verified" with every row reasoned from code and a deploy signal of
 * "VO 6330-7 exists on staging"; its AC1 method (VO total = sum of the remaining session rows)
 * could not have been carried out there, because there is no removed fee left to see.
 *
 * So the fee is removed here, live, and put back: `DELETE /activity_treatments/{id}` is the only
 * way to reproduce the ticket (an Activity PATCH cannot — `ActivityTreatmentsProcessor` diffs
 * treatment-kind rows only, "exclude fees so they survive the diff"), and the restore is exact
 * because `ActivityTreatmentPriceListener::prePersist` re-resolves `resolvedTariff` from the
 * session's own date. Every mutating test below restores in a `finally`.
 *
 * **What the population says.** Scanning all 50,679 activities dated since 2026-05-01 finds
 * **179 removed-fee days across 38 VOs** — the commit's own staging estimate was ~134 sessions /
 * 40 VOs — worth **3.496,56 EUR** that the fix stops billing (2.048,61 on the 18 VOs this file's
 * oracle prices, 1.447,95 on the 20 Blanko ones it does not). Of the 18 comparable VOs, the
 * served `totalRevenue` equals the POST-fix oracle on **18** and the PRE-fix oracle on **0**.
 * All 38 are GKV, against the ticket's "11 of them PKV" — and none carries an invoice or sits in
 * a billing batch, so the retroactive reduction contradicts no issued document on staging.
 *
 * **Traps**
 * - An embedded `ActivityTreatment` carries `@id` but **no bare `id`** — a delete addressed by
 *   `at.id` sends `/activity_treatments/undefined` and 404s, which reads like a permissions
 *   problem. Take the id from the IRI (the page object does).
 * - **A regenerable draft is `not_sent` AND `datevSyncedAt` null.** R126-86 is `not_sent` but was
 *   pushed to DATEV, so regenerating it answers 400 "A cancellation reason is required to
 *   regenerate an issued invoice." Only two invoices on staging are regenerable drafts today.
 * - **`invoiceAmount` is frozen at issue time** (#3093): it does not follow the VO's revenue down
 *   until the draft is regenerated. Asserting AC2 without regenerating shows nothing.
 * - **KPI reads are cached ~5 minutes** (#3401), so AC3 is asserted as SQL-vs-PHP parity across
 *   the whole Abrechnungs-Stau population, not as a live delta.
 * - A day whose session carries **no** `ActivityTreatment` rows at all keeps the unconditional
 *   behaviour (the pre-AT legacy arm), so "no fee row" is not the same predicate as "fee removed".
 *   There are **0** such countable days since May 2026, so the arm is unexercised live.
 */

/** The ticket's own VO — PKV, Aktiv, uninvoiced, KG-H + HBH-PT + a one-time AB-L. */
const TICKET_VO = { id: 23601, vo: '6330-7', fee: 'HBH-PT', oneTimeFee: 'AB-L', countableSessions: 5 };

/**
 * AC5's hard case: two countable sessions on 2026-05-26, BOTH carrying HBH-PT. Removing the fee
 * from the FIRST is what separates "mark the day processed" from "mark it only when billed".
 */
const SAME_DAY_VO = { id: 27608, vo: '8410-2', fee: 'HBH-PT', day: '2026-05-26' };

/** AC2: the only PKV VO whose draft is still regenerable (`not_sent`, never pushed to DATEV). */
const DRAFT_INVOICE_VO = { id: 27101, vo: '7205-2', invoiceId: 642, invoice: 'R526-73', fee: 'HBH-PT' };

/**
 * The finding fixture: a day holding a delivered session and a **planned** one, both carrying the
 * fee. Removing it from the delivered session drops the day's fee even though a session that day
 * still shows it — the case the commit leaves as a PM decision ("rejected is not removed").
 */
const PLANNED_CARRIER_VO = { id: 25720, vo: '2856-30', fee: 'HBH-PT', day: '2026-05-21' };

/**
 * The removed-fee population as measured on 2026-09-02, non-Blanko only (the oracle does not
 * price BV duration branches). `pre` is what the old rule billed, `post` what the VO reads today.
 */
const AFFECTED_VOS = [
  { id: 26691, vo: '8425-1', days: 10, post: 569.3, pre: 844.9 },
  { id: 26675, vo: '8427-1', days: 10, post: 569.3, pre: 844.9 },
  { id: 26653, vo: '8420-1', days: 10, post: 569.3, pre: 844.9 },
  { id: 27638, vo: '8650-1', days: 10, post: 570.5, pre: 750.2 },
  { id: 27848, vo: '7836-2', days: 10, post: 569.3, pre: 844.9 },
  { id: 28327, vo: '8735-1', days: 9, post: 855.21, pre: 1016.94 },
  { id: 27752, vo: '8652-1', days: 6, post: 642.38, pre: 750.2 },
  { id: 26811, vo: '3447-25', days: 5, post: 192.27, pre: 257.72 },
  { id: 27769, vo: '8647-1', days: 5, post: 585.45, pre: 675.3 },
  { id: 27605, vo: '8610-1', days: 4, post: 1057.92, pre: 1129.8 },
  { id: 26806, vo: '8487-1', days: 3, post: 177.78, pre: 217.05 },
  { id: 27675, vo: '8641-1', days: 3, post: 416.69, pre: 470.6 },
  { id: 27658, vo: '8646-1', days: 3, post: 171.99, pre: 225.9 },
  { id: 33372, vo: '9216-2', days: 3, post: 131.61, pre: 170.88 },
  { id: 28190, vo: '8487-2', days: 3, post: 177.78, pre: 217.05 },
  { id: 29752, vo: '404-71', days: 1, post: 636.01, pre: 649.1 },
  { id: 29701, vo: '8969-1', days: 1, post: 656.13, pre: 674.1 },
  { id: 31112, vo: '8663-2', days: 1, post: 115.07, pre: 128.16 },
];

/** Affected VOs that also appear in the Abrechnungs-Stau drill-down — AC3's direct evidence. */
const AFFECTED_IN_BACKLOG = [
  { id: 27752, vo: '8652-1', post: 642.38, pre: 750.2 },
  { id: 26806, vo: '8487-1', post: 177.78, pre: 217.05 },
  { id: 29752, vo: '404-71', post: 636.01, pre: 649.1 },
];

/** VOs with a per-treatment fee and no removed day — AC5's "unchanged behaviour" population. */
const UNAFFECTED_FEE_VOS = [34167, 27608, 21056, 29437, 23601];

const EUR = (n: number) => `${n.toFixed(2)} EUR`;

test.describe('Removed per-treatment fee is not billed (#3484)', () => {
  test.describe.configure({ mode: 'serial' });

  let fees: PerTreatmentFeePage;

  test.beforeEach(async ({ page }) => {
    fees = new PerTreatmentFeePage(page);
    await fees.connect();
    await fees.loadPriceCatalogue();
  });

  // ─────────────────────────────── AC1 ────────────────────────────────

  test(
    'AC1 the removed-fee population reads at the corrected total, never the old one',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const rows: string[] = [];
      let matchedPost = 0;
      let matchedPre = 0;

      for (const fixture of AFFECTED_VOS) {
        const vo = await fees.voSnapshot(fixture.id);
        const removed = fees.removedFeeDays(vo);
        const post = fees.expectedRevenue(vo, 'post');
        const pre = fees.expectedRevenue(vo, 'pre');

        // The shape is what makes this VO evidence at all: a prescribed fee with no carrier on a
        // countable day. If a therapist re-attaches it the VO stops discriminating (that is
        // exactly what happened to the ticket's own 6330-7), so it is asserted, not assumed.
        expect(removed.length, `${fixture.vo} must still hold a removed-fee day`).toBeGreaterThan(0);
        expect(vo.totalRevenue, `${fixture.vo} must serve a total`).not.toBeNull();

        if (Math.abs((vo.totalRevenue ?? 0) - post.total) < 0.005) matchedPost++;
        if (Math.abs((vo.totalRevenue ?? 0) - pre.total) < 0.005) matchedPre++;
        rows.push(
          `  ${fixture.vo.padEnd(10)} ${removed.length} day(s)  served ${String(vo.totalRevenue).padEnd(9)}` +
            ` post-fix ${String(post.total).padEnd(9)} pre-fix ${String(pre.total).padEnd(9)}` +
            ` delta ${(pre.total - post.total).toFixed(2)}`,
        );

        // Each individual VO decides the same question, so a single re-attached fixture cannot
        // quietly turn the whole file green.
        expect(post.total, `${fixture.vo}: the post-fix rule must differ from the pre-fix one`).not.toBeCloseTo(
          pre.total,
          2,
        );
        expect(vo.totalRevenue, `${fixture.vo}: served total must be the AT-gated figure`).toBeCloseTo(post.total, 2);
      }

      console.log(`#3484 removed-fee population (${AFFECTED_VOS.length} non-Blanko VOs):\n${rows.join('\n')}`);
      console.log(`served == post-fix oracle: ${matchedPost}/${AFFECTED_VOS.length}`);
      console.log(`served == pre-fix oracle : ${matchedPre}/${AFFECTED_VOS.length}`);

      expect(matchedPost, 'every affected VO must price under the #3484 rule').toBe(AFFECTED_VOS.length);
      expect(matchedPre, 'no affected VO may still price under the old rule').toBe(0);
    },
  );

  test(
    'AC1/AC6 removing the fee from one session drops exactly that day (and only that fee)',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@Mutating'] },
    async () => {
      test.setTimeout(180_000);

      const before = await fees.voSnapshot(TICKET_VO.id);
      expect(before.vo, 'the ticket fixture').toBe(TICKET_VO.vo);
      expect(before.activeInvoice, `${TICKET_VO.vo} must carry no invoice`).toBeNull();
      expect(before.billingBatchCount, `${TICKET_VO.vo} must sit in no billing batch`).toBe(0);
      expect(
        before.sessions.filter((s) => s.countable).length,
        'countable sessions — the two rejected-without-signature ones do not price',
      ).toBe(TICKET_VO.countableSessions);
      expect(fees.removedFeeDays(before), `${TICKET_VO.vo} starts with every day carrying its fee`).toEqual([]);

      const carrier = fees.feeCarrier(before, TICKET_VO.fee);
      expect(carrier, `${TICKET_VO.vo} must carry ${TICKET_VO.fee} on a countable session`).not.toBeNull();
      const { session, row } = carrier!;
      const feeAmount = fees.priceAt(TICKET_VO.fee, before.insuranceType, session.date);
      const oneTimeBefore = fees
        .expectedRevenue(before, 'post')
        .lines.filter((l) => KIND.ONE_TIME_FEE === l.kind)
        .reduce((sum, l) => sum + l.amount, 0);

      console.log(
        `${TICKET_VO.vo}: removing ${TICKET_VO.fee} (${EUR(feeAmount)}) from session ${session.id} on ${session.date};` +
          ` total before ${EUR(before.totalRevenue ?? 0)}`,
      );

      try {
        expect(await fees.removeFee(row.id), 'DELETE /activity_treatments/{id}').toBe(204);

        const during = await fees.voSnapshot(TICKET_VO.id);
        const removed = fees.removedFeeDays(during);
        expect(removed.map((d) => d.date), 'exactly the edited day loses its fee').toEqual([session.date]);

        // AC1: the day's amount for the removed fee is gone from the total, and nothing else is.
        expect(during.totalRevenue!, 'the total drops by exactly the fee').toBeCloseTo(
          before.totalRevenue! - feeAmount,
          2,
        );
        expect(during.totalRevenue!, 'and matches the oracle under the #3484 rule').toBeCloseTo(
          fees.expectedRevenue(during, 'post').total,
          2,
        );
        // The pre-fix rule would have kept the fee — this is the assertion that fails on an
        // unfixed build, and the only one in the file that can.
        expect(fees.expectedRevenue(during, 'pre').total, 'the old rule would have billed it anyway').toBeCloseTo(
          before.totalRevenue!,
          2,
        );

        // AC6: the one-time fee is untouched by a per-treatment fee's removal.
        const oneTimeDuring = fees
          .expectedRevenue(during, 'post')
          .lines.filter((l) => KIND.ONE_TIME_FEE === l.kind)
          .reduce((sum, l) => sum + l.amount, 0);
        expect(oneTimeDuring, `the one-time ${TICKET_VO.oneTimeFee} still bills once`).toBeCloseTo(oneTimeBefore, 2);
        expect(oneTimeBefore, 'and it is a real amount, not an absent line').toBeGreaterThan(0);

        console.log(`  after removal: ${EUR(during.totalRevenue!)} (one-time fee still ${EUR(oneTimeDuring)})`);
      } finally {
        const restored = await fees.restoreFee({
          treatmentId: row.treatmentId,
          activityId: session.id,
          prescriptionId: TICKET_VO.id,
        });
        console.log(`  restored as AT ${restored.id} (resolvedTariff ${restored.resolvedTariff})`);
        expect(restored.status, 'the fee row must go back').toBe(201);
        // prePersist re-resolves the price from the session's own date, so the restore is exact.
        expect(restored.resolvedTariff, 'and come back at the same price').toBeCloseTo(feeAmount, 2);
        const after = await fees.voSnapshot(TICKET_VO.id);
        expect(after.totalRevenue!, 'the VO must end where it started').toBeCloseTo(before.totalRevenue!, 2);
      }
    },
  );

  // ─────────────────────────────── AC5 ────────────────────────────────

  test(
    'AC5 a fee that was not removed still bills once per day',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@ReadOnly'] },
    async () => {
      test.setTimeout(180_000);

      for (const id of UNAFFECTED_FEE_VOS) {
        const vo = await fees.voSnapshot(id);
        expect(fees.perTreatmentFees(vo).length, `${vo.vo} must prescribe a per-treatment fee`).toBeGreaterThan(0);
        expect(fees.removedFeeDays(vo), `${vo.vo} must have no removed-fee day`).toEqual([]);

        const post = fees.expectedRevenue(vo, 'post');
        const pre = fees.expectedRevenue(vo, 'pre');
        expect(vo.totalRevenue!, `${vo.vo} prices as the engine does`).toBeCloseTo(post.total, 2);
        // The point of AC5: for a fee nobody removed, #3484 changes nothing at all.
        expect(pre.total, `${vo.vo}: the fix must not move an untouched VO`).toBeCloseTo(post.total, 2);

        const feeLines = post.lines.filter((l) => KIND.PER_TREATMENT_FEE === l.kind);
        const days = new Set(feeLines.map((l) => `${l.date}:${l.code}`));
        expect(days.size, `${vo.vo}: one fee line per day per fee`).toBe(feeLines.length);
        console.log(`  ${vo.vo}: ${EUR(vo.totalRevenue!)}, ${feeLines.length} fee line(s) over ${days.size} day(s)`);
      }
    },
  );

  test(
    'AC5 a fee removed from the FIRST of two same-day sessions still bills once',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@Mutating'] },
    async () => {
      test.setTimeout(180_000);

      const before = await fees.voSnapshot(SAME_DAY_VO.id);
      expect(before.vo).toBe(SAME_DAY_VO.vo);
      const sameDay = fees.sameDayGroups(before).get(SAME_DAY_VO.day);
      expect(sameDay?.length, `${SAME_DAY_VO.vo} must hold two countable sessions on ${SAME_DAY_VO.day}`).toBe(2);

      const ordered = [...sameDay!].sort((a, b) => a.id - b.id);
      const carriers = ordered.filter((s) => s.treatments.some((t) => t.code === SAME_DAY_VO.fee));
      expect(carriers.length, 'both sessions must carry the fee before the edit').toBe(2);

      const first = ordered[0];
      const row = first.treatments.find((t) => t.code === SAME_DAY_VO.fee)!;

      // Live data cannot produce this shape: all 7 same-day days where the fee sits on only one
      // session have the CARRIER first, so the ordering-sensitive branch of the dedup key is
      // never exercised by staging as it stands. It is manufactured here and put back.
      console.log(
        `${SAME_DAY_VO.vo} ${SAME_DAY_VO.day}: removing ${SAME_DAY_VO.fee} from the first session ${first.id};` +
          ` it survives on ${ordered[1].id}`,
      );

      try {
        expect(await fees.removeFee(row.id)).toBe(204);

        const during = await fees.voSnapshot(SAME_DAY_VO.id);
        expect(fees.removedFeeDays(during), 'the day still has a carrier, so nothing is dropped').toEqual([]);
        expect(during.totalRevenue!, 'the total is unchanged — the fee bills on the surviving session').toBeCloseTo(
          before.totalRevenue!,
          2,
        );

        const feeLines = fees
          .expectedRevenue(during, 'post')
          .lines.filter((l) => KIND.PER_TREATMENT_FEE === l.kind && l.date === SAME_DAY_VO.day);
        expect(feeLines.length, 'and it bills exactly once that day').toBe(1);
        expect(feeLines[0].activityId, 'on the session that still carries it').toBe(ordered[1].id);
      } finally {
        const restored = await fees.restoreFee({
          treatmentId: row.treatmentId,
          activityId: first.id,
          prescriptionId: SAME_DAY_VO.id,
        });
        expect(restored.status).toBe(201);
        const after = await fees.voSnapshot(SAME_DAY_VO.id);
        expect(after.totalRevenue!).toBeCloseTo(before.totalRevenue!, 2);
      }
    },
  );

  // ─────────────────────────────── AC2 ────────────────────────────────

  test(
    'AC2 a regenerated invoice excludes the removed fee',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@Mutating'] },
    async () => {
      test.setTimeout(240_000);

      const before = await fees.voSnapshot(DRAFT_INVOICE_VO.id);
      expect(before.vo).toBe(DRAFT_INVOICE_VO.vo);
      expect(before.activeInvoice?.number, 'the draft this test regenerates').toBe(DRAFT_INVOICE_VO.invoice);
      expect(before.activeInvoice?.status, 'and it must still be a draft').toBe('not_sent');
      expect(before.activeInvoice?.amount, 'whose amount starts at the VO total').toBeCloseTo(before.totalRevenue!, 2);

      const carrier = fees.feeCarrier(before, DRAFT_INVOICE_VO.fee)!;
      const feeAmount = fees.priceAt(DRAFT_INVOICE_VO.fee, before.insuranceType, carrier.session.date);

      try {
        expect(await fees.removeFee(carrier.row.id)).toBe(204);

        const removed = await fees.voSnapshot(DRAFT_INVOICE_VO.id);
        expect(removed.totalRevenue!, 'the VO total drops immediately').toBeCloseTo(before.totalRevenue! - feeAmount, 2);
        // #3093: the amount is an issue-time snapshot, so it does NOT follow the VO on its own.
        // Skipping the regeneration is how AC2 gets mistakenly reported as failing.
        expect(removed.activeInvoice!.amount!, 'while the issued amount stays frozen').toBeCloseTo(
          before.activeInvoice!.amount!,
          2,
        );

        expect(await fees.regenerateInvoice(DRAFT_INVOICE_VO.id), 'the draft is replaced in place').toBe(200);

        const regenerated = await fees.voSnapshot(DRAFT_INVOICE_VO.id);
        expect(regenerated.activeInvoice!.number, 'the invoice number is kept').toBe(DRAFT_INVOICE_VO.invoice);
        expect(regenerated.activeInvoice!.amount!, 'and the invoiced total now excludes the fee').toBeCloseTo(
          before.activeInvoice!.amount! - feeAmount,
          2,
        );
        console.log(
          `${DRAFT_INVOICE_VO.invoice}: ${EUR(before.activeInvoice!.amount!)} -> ${EUR(regenerated.activeInvoice!.amount!)}` +
            ` after removing ${DRAFT_INVOICE_VO.fee} (${EUR(feeAmount)})`,
        );
      } finally {
        const restored = await fees.restoreFee({
          treatmentId: carrier.row.treatmentId,
          activityId: carrier.session.id,
          prescriptionId: DRAFT_INVOICE_VO.id,
        });
        expect(restored.status).toBe(201);
        expect(await fees.regenerateInvoice(DRAFT_INVOICE_VO.id)).toBe(200);
        const after = await fees.voSnapshot(DRAFT_INVOICE_VO.id);
        expect(after.totalRevenue!).toBeCloseTo(before.totalRevenue!, 2);
        expect(after.activeInvoice!.amount!).toBeCloseTo(before.activeInvoice!.amount!, 2);
      }
    },
  );

  // ─────────────────────────────── AC3 ────────────────────────────────

  test(
    'AC3 the SQL KPI engine reports the same corrected figure as the VO',
    { tag: ['@SuperAdmin', '@PerTreatmentFee', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      // `/kpis/management/billing-backlog` is the one client-reachable surface that publishes a
      // per-VO revenue from RawKpiCalculator — the SQL engine the commit had to change in
      // lockstep with the PHP one.
      const backlog = await fees.backlogRevenueByPrescription();
      expect(backlog.size, 'the Abrechnungs-Stau must list VOs').toBeGreaterThan(100);

      const inBacklog = AFFECTED_IN_BACKLOG.filter((f) => backlog.has(f.id));
      expect(inBacklog.length, 'affected VOs must still be reachable through the KPI').toBeGreaterThan(0);

      for (const fixture of inBacklog) {
        const vo = await fees.voSnapshot(fixture.id);
        expect(fees.removedFeeDays(vo).length, `${fixture.vo} still holds its removed-fee day`).toBeGreaterThan(0);
        const sql = backlog.get(fixture.id)!;
        expect(sql, `${fixture.vo}: the KPI figure is the corrected one`).toBeCloseTo(fixture.post, 2);
        expect(Math.abs(sql - fixture.pre), `${fixture.vo}: and not the pre-fix one`).toBeGreaterThan(0.005);
        expect(sql, `${fixture.vo}: SQL and PHP engines agree`).toBeCloseTo(vo.totalRevenue!, 2);
        console.log(`  ${fixture.vo}: KPI(SQL) ${EUR(sql)} == totalRevenue(PHP) ${EUR(vo.totalRevenue!)}`);
      }

      // A wider parity sweep, because "both engines were changed together" is the property that
      // decides AC3 for every VO rather than for three of them.
      const sample = [...backlog.keys()].filter((_, i) => 0 === i % 7);
      let mismatches = 0;
      for (const id of sample) {
        const vo = await fees.voSnapshot(id);
        if (Math.abs(backlog.get(id)! - (vo.totalRevenue ?? 0)) > 0.005) mismatches++;
      }
      console.log(`SQL-vs-PHP parity over ${sample.length} backlog VOs: ${mismatches} mismatches`);
      expect(mismatches, 'the two revenue engines must stay in lockstep').toBe(0);
    },
  );

  // ───────────────────────── AC4 / findings ───────────────────────────
});
