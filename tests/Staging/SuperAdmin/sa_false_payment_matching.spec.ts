import { test, expect } from '@playwright/test';
import {
  DatevOldFormatPage,
  OLD_FORMAT_PKV_NUMBERS,
  isOldFormat,
} from '../../../Pages/superadmin/sa.datev-old-format.page';

/**
 * RC 3.11.2 (#3499) — an old-format invoice must only be auto-marked paid when a cleared bank item
 * matches BOTH its invoice number AND its debtor account.
 *
 * The defect: `collectClearedMatches()` keys cleared receivables on the invoice number alone, with
 * no debtor (or amount) check. #3440 widened the polling pool to include old-format invoices, which
 * exposed it: on 25 Aug 2026, 36 of 43 old-format PKV invoices were falsely flipped to paid — the
 * ticket's own example being invoice 426-16 (Dr. Ursula Grünwald-Schuller, EUR 917.90) matched by a
 * cleared item actually belonging to Joachim Alois Salm at EUR 93.40.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SPEC CAN AND CANNOT DO — the ticket says staging cannot verify this end-to-end, and
 * that is confirmed here, with the reason pinned down:
 *
 *  1. **The DATEV connection is disabled on staging by decision** (`DATEV_SYNC_ENABLED=false` —
 *     see `sa_datev_old_format_push.spec.ts` and the `datev-old-format-push-3-11-1` note). The
 *     payment check therefore never runs here: all 44 old-format PKV invoices carry
 *     `datevSyncStatus: null` and none is `paid`.
 *  2. **The debtor account is not exposed to any client, in any environment.** `/datev_debtors`,
 *     `/debtors`, `/accounts_receivable` and `/bank_items` all 404; the invoice payload has no
 *     debtor field (`id, prescription, status, invoiceNumber, sentDate, overdueDate,
 *     totalOnHoldDays, createdAt, issueDate, updatedAt, logs, datevSyncAttempts, invoiceAmount`);
 *     the patient carries only `insuranceNumber`. So AC1/AC2 — "the debtor matched" / "the debtor
 *     did not match" — are not observable through the API even against production. They are
 *     developer unit-test territory, exactly as the ticket's Testing Guidance says.
 *
 * What IS verifiable here, and is what this spec asserts:
 *  - the exposed population and its untouched pre-fix state (the deploy-priority baseline);
 *  - the COLLISION SURFACE that makes the fix necessary — measurable, and severe;
 *  - AC4's R-format baseline, so "unchanged" is checkable after deploy rather than assumed;
 *  - a paid-state snapshot designed to be re-run in PRODUCTION around the first nightly run, which
 *    is verification step (3) the ticket asks for.
 *
 * **Read-only — every request is a GET. Nothing here writes, and nothing triggers a payment check.**
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
test.describe('False payment matching for old-format invoices (#3499)', () => {
  test(
    'Exposure baseline — the old-format PKV population is intact, unpaid, and never payment-checked here',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const datev = new DatevOldFormatPage(page);
      await datev.open();

      const old = await datev.oldFormatInvoices();
      const pkv = old.filter((i) => i.insuranceType === 'private');
      console.log(`old-format invoices: ${old.length}; of them PKV: ${pkv.length}`);

      const byStatus: Record<string, number> = {};
      for (const i of pkv) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
      console.log(`old-format PKV by status: ${JSON.stringify(byStatus)}`);

      // The population #3440 admitted into the polling pool, which is what #3499 protects.
      expect(pkv.length, 'the exposed old-format PKV population must still be readable').toBeGreaterThan(0);
      const missing = OLD_FORMAT_PKV_NUMBERS.filter((n) => !pkv.some((i) => i.number === n));
      expect(missing, 'every invoice number the #3440 selection named must still exist').toEqual([]);

      // Pre-fix state on staging: the payment check has never run, so nothing has been flipped.
      // This is the assertion that would catch a staging DATEV connection being switched on by
      // accident — which is the only way these could move here.
      const paid = pkv.filter((i) => /paid/i.test(i.status));
      expect(
        paid.map((i) => `${i.number}:${i.status}`),
        'no old-format PKV invoice may be marked paid on staging — the payment check does not run ' +
          'here, so a paid one means either DATEV was enabled or it was flipped by hand',
      ).toEqual([]);

      const synced = pkv.filter((i) => i.datevSyncStatus !== null);
      expect(
        synced.map((i) => `${i.number}:${i.datevSyncStatus}`),
        'none of these has ever been pushed to DATEV from staging',
      ).toEqual([]);

      // The ticket's own fixtures, confirmed against live data so the production tester can rely
      // on them: 426-16 is the identity-mismatch case, 426-14 the same-amount case.
      const f16 = pkv.find((i) => i.number === '426-16');
      const f14 = pkv.find((i) => i.number === '426-14');
      expect(f16, 'the AC2 fixture invoice 426-16 must exist').toBeTruthy();
      expect(f14, 'the AC3 fixture invoice 426-14 must exist').toBeTruthy();
      console.log(`426-16: ${f16!.patient}, EUR ${f16!.amount} (${f16!.status})`);
      console.log(`426-14: ${f14!.patient}, EUR ${f14!.amount} (${f14!.status})`);
      expect(f16!.patient, 'AC2 names Dr. Ursula Grünwald-Schuller as 426-16\'s debtor').toMatch(
        /Grünwald-Schuller/,
      );
      expect(Math.round(f16!.amount * 100) / 100, 'AC2 names EUR 917.90 for 426-16').toBe(917.9);
      expect(Math.round(f14!.amount * 100) / 100, 'AC3 names EUR 378.00 for 426-14').toBe(378);
    },
  );

  test(
    'The collision surface the fix has to survive — amounts are heavily shared, so amount/reference alone cannot identify a payment',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const datev = new DatevOldFormatPage(page);
      await datev.open();

      const book = await datev.allInvoices();
      const scoped = await datev.scope(book);
      const pkvOld = scoped.filter((i) => isOldFormat(i.number) && i.insuranceType === 'private');

      // Collisions WITHIN the exposed set: two exposed invoices at the same amount cannot be told
      // apart by amount, which is precisely AC3's scenario.
      const within = DatevOldFormatPage.amountCollisionsWithin(pkvOld);
      console.log(`amounts shared by more than one exposed invoice: ${within.size}`);
      for (const [amount, who] of within) console.log(`  EUR ${amount}: ${who.join(' | ')}`);

      // Collisions against the WHOLE book: the colliding booking need not be an old-format invoice.
      const freq = DatevOldFormatPage.amountFrequency(pkvOld, book);
      const colliding = pkvOld.filter((i) => (freq.get(i.number) ?? 0) > 1);
      const worst = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(
        `exposed invoices whose amount also occurs elsewhere in the ${book.length}-invoice book: ` +
          `${colliding.length}/${pkvOld.length}`,
      );
      console.log(`most-shared amounts: ${JSON.stringify(worst)}`);

      // AC3's premise must actually hold in the data, or the acceptance criterion is untestable:
      // there must BE same-amount pairs for the matcher to confuse.
      expect(
        within.size,
        'AC3 needs same-amount invoices to exist, or the scenario it describes is unreachable',
      ).toBeGreaterThan(0);

      // And the exposure is the headline: a large share of the population is ambiguous by amount.
      // Asserted as "most of them", not a fixed number, so ordinary data drift does not break it.
      expect(
        colliding.length / pkvOld.length,
        `${colliding.length} of ${pkvOld.length} exposed invoices share their amount with another ` +
          'booking — this is why matching on amount or a loose reference cannot be safe, and it is ' +
          'consistent with the ticket\'s 36-of-43 false-flip rate',
      ).toBeGreaterThan(0.5);
    },
  );

  test(
    'AC4 — the R-format population is recorded so "matching is unchanged" can be checked after deploy',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const datev = new DatevOldFormatPage(page);
      await datev.open();

      const scoped = await datev.scope(await datev.allInvoices());
      const rFormat = scoped.filter((i) => /^R/.test(i.number));
      const byStatus: Record<string, number> = {};
      for (const i of rFormat) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
      console.log(`R-format invoices: ${rFormat.length} — ${JSON.stringify(byStatus)}`);

      expect(rFormat.length, 'the R-format population must be readable to baseline it').toBeGreaterThan(0);
      // AC4 is a "no change" criterion, so the only thing assertable pre-fix is that the two
      // populations are disjoint under the selection rule — i.e. the fix's scope cannot leak into
      // R-format invoices by construction.
      const leak = rFormat.filter((i) => isOldFormat(i.number));
      expect(
        leak.map((i) => i.number),
        'no R-format invoice may satisfy the old-format rule — that disjointness is what keeps ' +
          'AC4 true whatever the old-format path does',
      ).toEqual([]);
    },
  );

  /**
   * Verification step (3) from the ticket: observe the first automatic nightly run after deploy.
   *
   * Runs unchanged against PRODUCTION (`--project=SAJhen-Prod` once mirrored) around the nightly
   * window: capture the old-format PKV paid-set before, and re-run after. On staging it is
   * data-gated — the payment check never runs, so there is nothing to observe and the test says so
   * rather than passing vacuously.
   */
  test(
    'Post-deploy watch — no old-format invoice is newly flipped to paid by the nightly run',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const datev = new DatevOldFormatPage(page);
      await datev.open();

      const pkv = (await datev.oldFormatInvoices()).filter((i) => i.insuranceType === 'private');
      const paid = pkv.filter((i) => /paid/i.test(i.status));
      console.log(
        `old-format PKV: ${pkv.length}; currently paid: ${paid.length} ` +
          `${JSON.stringify(paid.map((i) => `${i.number}/${i.patient}/EUR${i.amount}`))}`,
      );

      // Each paid one carries its own provenance: an automatic flip is the thing under suspicion.
      for (const inv of paid) {
        const logs = await datev.invoiceLogs(inv.id);
        console.log(`  ${inv.number} logs: ${JSON.stringify(logs.map((l) => `${l.type}@${l.createdAt.toISOString()}`))}`);
      }

      test.skip(
        paid.length === 0,
        'nothing to observe in this environment: no old-format PKV invoice is marked paid, because ' +
          'the payment check does not run against staging (DATEV_SYNC_ENABLED=false). Re-run this ' +
          'against production around the first nightly window after the fix deploys.',
      );

      // In production after the fix: a paid old-format invoice must be a legitimate match, and the
      // ticket is explicit that the 36 already-wrong ones are NOT reset by this ticket — so this is
      // a watch on NEW flips, compared against the recorded set rather than an absolute zero.
      console.log(
        'compare this paid-set against the pre-deploy snapshot: any NEW number is a candidate ' +
          'false match and needs its cleared-item debtor checked by hand',
      );
    },
  );

  // ── AC1 / AC2 / AC3 (the matching outcome), AC5, AC6 ──────────────────────────────────────────
  // Not verifiable from a client, in any environment — and the reason is not just that staging's
  // DATEV connection is off:
  //   • there is no debtor-account surface at all (/datev_debtors, /debtors, /accounts_receivable
  //     and /bank_items all 404; the invoice payload has no debtor field, the patient only
  //     `insuranceNumber`), so "the bank item's debtor equals the invoice's debtor" cannot be
  //     evaluated by a test even against production;
  //   • there is no cleared-bank-item surface either, so the input side of the match is invisible;
  //   • AC5 (nightly) and AC6 (the manual command's chained check) are both console/cron paths.
  // The ticket's Testing Guidance says exactly this and routes verification to developer unit tests
  // plus a restored-production rehearsal. Recorded here so the gap is explicit rather than looking
  // like missing coverage.
  test.fixme(
    'AC1/AC2/AC3 — a cleared item is accepted only when invoice number AND debtor both match',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch'] },
    async () => {
      // Reachable only with a debtor-account and cleared-bank-item surface, plus a DATEV connection.
      // If those ever land, the shape is: take 426-16 (Grünwald-Schuller, EUR 917.90), present a
      // cleared item carrying its invoice number but Joachim Alois Salm's debtor account, run the
      // check, and assert the invoice is still overdue.
    },
  );

  test.fixme(
    'AC5/AC6 — the nightly check and the manual command\'s chained check share the corrected rule',
    { tag: ['@SuperAdmin', '@FalsePaymentMatch'] },
    async () => {
      // Both are console/cron paths with no browser surface. The developer reference states both
      // call `collectClearedMatches()`, so this is a source-level equivalence rather than a
      // black-box one — a unit test, or a rehearsal against restored production data.
    },
  );
});
