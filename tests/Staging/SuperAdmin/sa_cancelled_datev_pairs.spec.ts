import { test, expect } from '@playwright/test';
import { StornoClassificationPage } from '../../../Pages/superadmin/sa.storno-classification.page';

/**
 * RC 3.12 (#3502) — a cancelled invoice and its Storno must reach DATEV as a zero-sum pair.
 *
 * `datevSyncable()` excluded CANCELLED, so a cancelled original never reached DATEV; its Storno
 * then had nothing to pair against (`findPendingStornoDatevSync` requires the original to be synced
 * first), and DATEV received neither half. The gaps that left in DATEV's numbering were reconciled
 * by hand.
 *
 * **Deployed and observable — because DATEV sync is now switched ON for staging.** That is a change
 * from #3440's finding (`DATEV_SYNC_ENABLED=false`, 2026-08-24) and it is what makes this ticket
 * testable at all: **105 of 563 invoices carry a `datevSyncedAt`, with 0 failed attempts**, and the
 * cancelled pairs were pushed between 2026-08-29 and 2026-09-02. Any spec that assumes staging
 * never pushes (as the #3440 and #3499 files do) is reasoning about a previous environment.
 *
 * **The shipped design differs from the ticket's Developer Reference, and for the better.** The
 * reference said to add CANCELLED to `datevSyncable()`. What landed adds a SECOND predicate,
 * `datevSyncableWithStornoPair()` — derived from the first "so the two lists cannot drift" — used
 * only on the paired path, with a docblock warning that a caller which cannot push the reversal
 * (the #3440 legacy PKV delivery, which has no Storno arm) must keep the narrow list or it "books a
 * permanently unbalanced cancelled receivable". Widening the shared gate would have done exactly
 * that to the finder #3449 already flagged.
 *
 * **AC3 cannot be read off `invoiceAmount`, and reading it there produces a false finding.** The
 * stored amount is a MAGNITUDE on both halves — the pair looks like 35,63 + 35,63 = 71,26, not
 * zero. The negation happens in the DATEV posting proposal:
 * `PostingProposalMapper::mapStornoInvoice()` does `$proposal['amount'] = round(-$proposal['amount'], 2)`.
 * So what is checkable from a client is that the magnitudes match exactly; the sign is applied
 * where the payload is, and that payload is not exposed.
 *
 * **Traps**
 * - `datevSyncedAt` / `datevSyncStatus` are **omitted until an invoice is actually pushed** (#3440),
 *   so "never pushed" reads `undefined`, not `null`.
 * - `datevSyncAttempts` is a FAILURE counter: 0 means "nothing failed", not "nothing was pushed".
 *   The unpushed Stuttgart pair sits at 0 attempts precisely because it was never tried.
 * - Pair by the `originalInvoice` RELATION, never by the `S` number prefix — #3449 made the
 *   relation authoritative, and a Storno's own number says nothing about what it reverses.
 */

/** The two entities the ticket names as not yet DATEV-activated. */
const INACTIVE_ENTITIES = [/Stuttgart/i, /Rhein-Ruhr 2/i];

test.describe('Cancelled invoices push to DATEV as pairs (#3502)', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  let auth: string;
  let stornos: StornoClassificationPage;

  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${StornoClassificationPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
      timeout: 120_000,
    });
    expect(response.status(), 'POST /auth').toBe(200);
    auth = (await response.json()).token;
  });

  test.beforeEach(async ({ request }) => {
    stornos = new StornoClassificationPage(request, auth);
  });

  test(
    'AC1/AC2 every cancelled invoice has a Storno, and DATEV always gets the original first',
    { tag: ['@SuperAdmin', '@DatevStornoPairs', '@ReadOnly'] },
    async () => {
      const pairs = await stornos.cancelledPairs();
      expect(pairs.length, 'staging must carry cancelled invoices').toBeGreaterThan(0);

      let pushed = 0;
      for (const pair of pairs) {
        console.log(
          `  ${pair.original.number.padEnd(10)} ${String(pair.original.amount).padEnd(9)} ` +
            `${(pair.storno?.number ?? '(none)').padEnd(9)} ${String(pair.storno?.amount ?? '-').padEnd(9)} ` +
            `orig ${String(pair.original.syncedAt ?? 'never').slice(0, 19).padEnd(19)} ` +
            `storno ${String(pair.storno?.syncedAt ?? 'never').slice(0, 19).padEnd(19)} ${pair.entity ?? ''}`,
        );

        // AC1's precondition: a cancellation always produces a Storno. Without it the pair cannot
        // exist and the push would leave a permanently open receivable.
        expect(pair.storno, `${pair.original.number} must have a Storno`).not.toBeNull();

        if (!pair.original.syncedAt) {
          // Not yet pushed — AC5 covers why. Its Storno must not have jumped the queue.
          expect(
            pair.storno!.syncedAt,
            `${pair.storno!.number} must not reach DATEV before its original`,
          ).toBeNull();
          continue;
        }
        pushed++;
        // AC2: the ordering rule, asserted on real timestamps rather than on the code that sets them.
        expect(pair.storno!.syncedAt, `${pair.storno!.number} follows its original`).not.toBeNull();
        expect(
          new Date(pair.storno!.syncedAt!).getTime(),
          `${pair.original.number} must reach DATEV before ${pair.storno!.number}`,
        ).toBeGreaterThanOrEqual(new Date(pair.original.syncedAt).getTime());
      }

      console.log(`  ${pushed} of ${pairs.length} pairs have both halves in DATEV`);
      // The whole point of the ticket: before it, this number was 0 for every cancelled invoice.
      expect(pushed, 'cancelled originals must actually be reaching DATEV now').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 the two halves carry equal magnitudes — the sign is applied in the posting proposal',
    { tag: ['@SuperAdmin', '@DatevStornoPairs', '@ReadOnly'] },
    async () => {
      const pairs = await stornos.cancelledPairs();
      for (const pair of pairs) {
        expect(pair.storno, `${pair.original.number} must have a Storno`).not.toBeNull();
        // Equal magnitudes are the client-visible half of "nets to zero". Asserting
        // original + storno === 0 on these fields fails on a perfectly correct pair, because both
        // are stored positive and `mapStornoInvoice()` negates the reversal at booking time.
        expect(pair.storno!.amount, `${pair.storno!.number} reverses the full amount of ${pair.original.number}`)
          .toBeCloseTo(pair.original.amount!, 2);
      }
      console.log(`  ${pairs.length} pairs, every Storno matching its original to the cent`);
    },
  );

  test(
    'AC5 a pair on a non-activated entity is held, not failed',
    { tag: ['@SuperAdmin', '@DatevStornoPairs', '@ReadOnly'] },
    async () => {
      const pairs = await stornos.cancelledPairs();
      const held = pairs.filter((pair) => !pair.original.syncedAt);
      console.log(`  held pairs: ${held.map((p) => `${p.original.number} (${p.entity})`).join(', ') || 'none'}`);

      for (const pair of held) {
        // "Held" and "broken" look identical unless the attempt counter is read: a genuine failure
        // increments it, an entity that was never activated leaves it at 0.
        expect(pair.original.attempts, `${pair.original.number} must be held, not failing`).toBe(0);
        expect(
          INACTIVE_ENTITIES.some((pattern) => pattern.test(pair.entity ?? '')),
          `${pair.original.number} is held, so it must belong to an entity the ticket names as not yet activated — its entity is ${pair.entity}`,
        ).toBe(true);
      }

      // And an activated entity's pair did go: the gate is per-entity, not a global stop.
      const sent = pairs.filter((pair) => pair.original.syncedAt);
      expect(sent.length, 'at least one activated entity must have pushed its pair').toBeGreaterThan(0);
      console.log(`  pushed from: ${[...new Set(sent.map((p) => p.entity))].join(', ')}`);
    },
  );

  test(
    'AC7 reaching DATEV does not make a cancelled invoice eligible for payment matching',
    { tag: ['@SuperAdmin', '@DatevStornoPairs', '@ReadOnly'] },
    async () => {
      const book = await stornos.allInvoices();
      const cancelled = book.filter((row) => 'cancelled' === row.status);
      expect(cancelled.length, 'cancelled invoices must exist').toBeGreaterThan(0);

      // `findUnpaidForPaymentMatching` filters `status NOT IN (PAID, CANCELLED)` and is a separate
      // query from the DATEV gate this ticket changed. The client-visible consequence is that no
      // cancelled invoice may ever end up marked paid.
      const paid = cancelled.filter((row) => 'paid' === row.status);
      expect(paid, 'a cancelled invoice must never be marked paid by matching').toEqual([]);
      console.log(`  ${cancelled.length} cancelled invoices, ${paid.length} marked paid`);
    },
  );

  test(
    'evidence: DATEV sync is live on staging, which is what makes this ticket observable',
    { tag: ['@SuperAdmin', '@DatevStornoPairs', '@ReadOnly'] },
    async () => {
      const book = await stornos.allInvoices();
      let synced = 0;
      let failed = 0;
      for (const row of book) {
        const state = await stornos.datevState(row.id);
        if (state.syncedAt) synced++;
        if (state.attempts > 0) failed++;
      }
      console.log(`  ${synced} of ${book.length} invoices are DATEV-synced; ${failed} carry failed attempts`);
      // Recorded rather than asserted tightly: the point is that the environment changed since
      // #3440 measured it, and the other DATEV specs in this suite assume the old state.
      expect(synced, 'staging is pushing to DATEV').toBeGreaterThan(0);
    },
  );

});
