import { test, expect } from '@playwright/test';
import {
  AC3_VO,
  CUTOVER,
  ExpiryLog,
  ExpiryReasonPage,
  PM_VO,
  QUALIFIERS,
  REASON_SHAPES,
} from '../../../Pages/superadmin/sa.expiry-reason.page';

/**
 * RC 3.13 #3651 — an expired VO must state the deadline that actually fired (14 or 28 Tage), why it
 * applied, and the dates, in German. Shipped as `2eb764c8d` (PR #3654), live on staging since the
 * first `release/3.13.0` deploy at 2026-09-09 02:38 UTC.
 *
 * **Read-only.** The stored `PrescriptionLog.meta.reason` is the authoritative surface: the
 * Änderungsprotokoll and the in-app notification both interpolate that same string verbatim, so
 * checking it checks both (the commit made no frontend change for exactly this reason).
 *
 * See the page object for the cutover rule — the ticket does not rewrite old entries, so the
 * population must be partitioned by date before anything is asserted — and for the self-consistency
 * invariant that detects the bug without knowing a VO's urgency.
 */
test.describe('#3651 expired VOs state the deadline that fired, in German', () => {
  let expiry: ExpiryReasonPage;
  let logs: ExpiryLog[];
  let post: ExpiryLog[];
  let pre: ExpiryLog[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(1_200_000);
    const page = await browser.newPage();
    expiry = new ExpiryReasonPage(page);
    await expiry.connect();
    logs = await expiry.expiryLogs();
    post = logs.filter((l) => ExpiryReasonPage.isPostCutover(l));
    pre = logs.filter((l) => !ExpiryReasonPage.isPostCutover(l));
    console.log(
      `#3651: ${logs.length} expiry logs scanned (${logs[logs.length - 1]?.createdAt.slice(0, 10)} … ` +
        `${logs[0]?.createdAt.slice(0, 10)}) — ${post.length} after the ${CUTOVER} cutover, ${pre.length} before`,
    );
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    expiry = new ExpiryReasonPage(page);
    await expiry.connect();
  });

  test(
    'the cutover is where the ticket says it is: German after, English before',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      expect(post.length, 'there must be post-fix expirations to check').toBeGreaterThan(0);
      expect(pre.length, 'and historical ones to leave alone').toBeGreaterThan(0);

      // Every post-fix reason is one of the four German shapes…
      const notGerman = post.filter((l) => !ExpiryReasonPage.isGerman(l.reason) && 'Manual expiration' !== l.reason);
      for (const l of notGerman.slice(0, 6)) console.log(`   still not German: ${l.createdAt} ${l.reason}`);
      expect(notGerman, 'every expiry after the fix must read German').toEqual([]);

      // …and the historical ones are untouched, which is the ticket's explicit non-change. Asserting
      // this stops a future "translate everything" change from silently rewriting audit history.
      const rewritten = pre.filter((l) => ExpiryReasonPage.isGerman(l.reason));
      expect(rewritten, 'historical entries must NOT have been rewritten retroactively').toEqual([]);
      console.log(
        `#3651 cutover: ${post.length}/${post.length} post-fix entries German, ` +
          `0/${pre.length} historical entries rewritten`,
      );
    },
  );

  test(
    'AC1 every post-fix reason carries its deadline, its reason and its dates',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      const byShape = new Map<string, number>();
      for (const entry of post) {
        byShape.set(ExpiryReasonPage.shapeOf(entry.reason), (byShape.get(ExpiryReasonPage.shapeOf(entry.reason)) ?? 0) + 1);

        if (REASON_SHAPES.START_DEADLINE.test(entry.reason)) {
          // AC1's start-deadline row: the count, the Frist, the Ausstellung and today.
          expect(entry.reason, `${entry.voNumber}: Frist`).toMatch(/Frist: \d{2}\.\d{2}\.\d{4}/);
          expect(entry.reason, `${entry.voNumber}: Ausstellung`).toMatch(/Ausstellung: \d{2}\.\d{2}\.\d{4}/);
          expect(entry.reason, `${entry.voNumber}: heute`).toMatch(/heute: \d{2}\.\d{2}\.\d{4}/);
          expect(entry.reason, `${entry.voNumber}: a day count`).toMatch(/von (14|28) Tagen/);
        } else if (REASON_SHAPES.VALIDITY_PERIOD.test(entry.reason)) {
          // AC1's validity row: the period length that applied, its start and its expiry.
          expect(entry.reason, `${entry.voNumber}: the period length`).toMatch(/\d+ (Tage|Monate) ab (Ausstellung|erster Behandlung)/);
          expect(entry.reason, `${entry.voNumber}: Beginn`).toMatch(/Beginn: \d{2}\.\d{2}\.\d{4}/);
          expect(entry.reason, `${entry.voNumber}: Ablauf`).toMatch(/Ablauf: \d{2}\.\d{2}\.\d{4}/);
        }
      }
      console.log('#3651 AC1 — post-fix reason shapes:');
      for (const [shape, count] of [...byShape].sort((a, b) => b[1] - a[1])) console.log(`   x${count}  ${shape}`);
    },
  );

  test(
    'AC2 the stated deadline never contradicts its own dates',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      // The invariant that detects the bug without knowing anything about the VO: the text carries
      // both the day count and the two dates, so `Frist − Ausstellung` must equal the count. This is
      // exactly what the old Ergo prose violated — "28 days" over a 14-day span.
      const started = post.filter((l) => REASON_SHAPES.START_DEADLINE.test(l.reason));
      expect(started.length, 'there must be post-fix start-deadline entries').toBeGreaterThan(0);

      for (const entry of started) {
        const parsed = ExpiryReasonPage.parseStartDeadline(entry.reason)!;
        expect(parsed, `${entry.voNumber}: the reason must be parseable`).toBeTruthy();
        const span = ExpiryReasonPage.daysBetween(parsed.issued, parsed.deadline);
        expect(
          span,
          `VO ${entry.voNumber}: states ${parsed.days} Tagen but Frist − Ausstellung is ${span} days`,
        ).toBe(parsed.days);
      }
      console.log(`#3651 AC2: all ${started.length} post-fix start-deadline entries are self-consistent`);
    },
  );

  test(
    'AC2 the stated deadline is the one the VO\'s own urgency and insurance imply',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // Self-consistency is necessary but not sufficient — the text could be consistently wrong. So
      // the count is also checked against `getStartDeadlineDays()`'s rule read off the VO itself.
      const started = post.filter((l) => REASON_SHAPES.START_DEADLINE.test(l.reason));
      for (const entry of started) {
        const vo = await expiry.vo(entry.prescriptionId);
        const parsed = ExpiryReasonPage.parseStartDeadline(entry.reason)!;
        const expected = ExpiryReasonPage.expectedDeadlineDays(vo);
        console.log(
          `   VO ${entry.voNumber}: states ${parsed.days} Tagen | urgent=${vo.urgentTreatmentNeed} ` +
            `insurance=${vo.insuranceType} → rule says ${expected}`,
        );
        expect(parsed.days, `VO ${entry.voNumber}: the stated deadline must be the rule's`).toBe(expected);

        // And the qualifier must be present exactly when a 14-day deadline fired.
        if (14 === expected) {
          const qualifier = vo.urgentTreatmentNeed ? QUALIFIERS.urgent : QUALIFIERS.accident;
          expect(entry.reason, `VO ${entry.voNumber}: the 14-day qualifier`).toContain(qualifier.trim().replace(/^– /, ''));
        } else {
          expect(entry.reason, `VO ${entry.voNumber}: a 28-day case carries no qualifier`).not.toContain('dringender Behandlungsbedarf');
          expect(entry.reason).not.toContain('Berufsgenossenschaft');
        }
      }
    },
  );

  test(
    'the PM\'s screenshotted case reads as the localization table specifies',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      const vo = await expiry.voByNumber(PM_VO.number);
      expect(vo, `VO ${PM_VO.number} must exist`).toBeTruthy();
      const entries = (await expiry.expiryLogsFor(vo!.id)).filter((l) => ExpiryReasonPage.isPostCutover(l));
      expect(entries.length, `VO ${PM_VO.number} must have a post-fix expiry entry`).toBeGreaterThan(0);

      const reason = entries[0].reason;
      console.log(`#3651 VO ${PM_VO.number}: ${reason}`);
      // The standard row of AC1's table, matched against the ticket's own proposed wording.
      expect(reason).toMatch(
        /^Behandlungsbeginn nicht innerhalb von 28 Tagen nach Ausstellung \(Frist: \d{2}\.\d{2}\.\d{4}, Ausstellung: \d{2}\.\d{2}\.\d{4}, heute: \d{2}\.\d{2}\.\d{4}\)$/,
      );
      expect(vo!.urgentTreatmentNeed, 'it is a standard case, so 28 is right').toBe(false);
      expect(vo!.insuranceType).not.toBe('accident');
    },
  );

  test(
    'FINDING — the bug is present in history, on both the urgent and the accident branch',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);
      // The same self-consistency invariant, run over the historical population. Every hit is an
      // entry that announces a deadline its own dates contradict — the defect #3651 was raised for,
      // now quantified rather than described.
      const contradictions: Array<{ vo: string | null; stated: number; actual: number; createdAt: string }> = [];
      for (const entry of pre) {
        const parsed = ExpiryReasonPage.parseStartDeadline(entry.reason);
        if (!parsed) continue;
        const span = ExpiryReasonPage.daysBetween(parsed.issued, parsed.deadline);
        if (span !== parsed.days) {
          contradictions.push({ vo: entry.voNumber, stated: parsed.days, actual: span, createdAt: entry.createdAt });
        }
      }
      const parseable = pre.filter((l) => null !== ExpiryReasonPage.parseStartDeadline(l.reason)).length;
      console.log(
        `#3651 FINDING: of ${parseable} historical start-deadline entries carrying their own dates, ` +
          `${contradictions.length} state a deadline their dates contradict:`,
      );
      for (const c of contradictions) {
        console.log(`   VO ${c.vo} (${c.createdAt.slice(0, 10)}): says ${c.stated} days, its dates are ${c.actual} apart`);
      }
      // The bug is real and reproducible from the data — and these strings are permanent, because
      // the ticket does not rewrite history.
      expect(contradictions.length, 'the defect must be visible in the historical population').toBeGreaterThan(0);
      for (const c of contradictions) {
        expect(c.stated, 'every contradiction is the hardcoded 28').toBe(28);
        expect(c.actual, 'over a deadline that was really 14 days').toBe(14);
      }
    },
  );

  test(
    'FINDING — AC3 cannot be satisfied: VO 5691-6 expired before the fix and keeps the old English text',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // AC3 asks for VO 5691-6's change log to show "14 Tagen" and "(dringender Behandlungsbedarf)".
      // Its expiry was logged 2026-08-07 — a month before the fix reached staging — and the ticket
      // itself says existing entries are never rewritten. So the AC contradicts the ticket's own
      // scope, and the screenshot in its Visual Reference will look the same for good.
      const vo = await expiry.voByNumber(AC3_VO.number);
      expect(vo, `VO ${AC3_VO.number} must exist on staging`).toBeTruthy();
      expect(vo!.urgentTreatmentNeed, 'it is the urgent case AC3 describes').toBe(true);
      expect(vo!.therapyType).toBe(AC3_VO.area);

      const entries = await expiry.expiryLogsFor(vo!.id);
      expect(entries.length, 'it has an expiry entry').toBeGreaterThan(0);
      const entry = entries[0];
      console.log(`#3651 AC3: VO ${AC3_VO.number} logged ${entry.createdAt} — "${entry.reason}"`);

      // It predates the cutover…
      expect(ExpiryReasonPage.isPostCutover(entry), 'the entry predates the fix').toBe(false);
      // …so it is still English, still says 28, and still contradicts its own dates by 14.
      expect(entry.reason, 'AC3 asks for German here, and it is English').not.toMatch(REASON_SHAPES.START_DEADLINE);
      expect(entry.reason).toContain('28 days passed');
      expect(entry.reason).not.toContain('14 Tagen');
      expect(entry.reason).not.toContain('dringender Behandlungsbedarf');
      const parsed = ExpiryReasonPage.parseStartDeadline(entry.reason)!;
      expect(parsed.days, 'it announces 28').toBe(28);
      expect(
        ExpiryReasonPage.daysBetween(parsed.issued, parsed.deadline),
        'over a 14-day deadline — the exact defect, still on screen',
      ).toBe(14);
    },
  );

  test(
    'evidence — which of the six reason types have a post-fix instance at all',
    { tag: ['@SuperAdmin', '@ExpiryReason', '@ReadOnly'] },
    async () => {
      const seen = {
        startDeadline28: post.some((l) => /von 28 Tagen/.test(l.reason)),
        startDeadline14: post.some((l) => /von 14 Tagen/.test(l.reason)),
        urgentQualifier: post.some((l) => l.reason.includes('dringender Behandlungsbedarf')),
        accidentQualifier: post.some((l) => l.reason.includes('Berufsgenossenschaft')),
        validityPeriod: post.some((l) => REASON_SHAPES.VALIDITY_PERIOD.test(l.reason)),
        sixteenWeek: post.some((l) => REASON_SHAPES.SIXTEEN_WEEK.test(l.reason)),
        breakAccumulation: post.some((l) => REASON_SHAPES.BREAK_ACCUMULATION.test(l.reason)),
      };
      console.log(`#3651 post-fix coverage: ${JSON.stringify(seen, null, 0)}`);
      // Two of the six are observable on staging today; the rest simply have not fired since the
      // deploy. Recorded here so the gap is a measured fact rather than a silent skip.
      expect(seen.validityPeriod, 'the validity-period reason has fired').toBe(true);
      expect(seen.startDeadline28, 'the standard 28-day reason has fired').toBe(true);
    },
  );
});
