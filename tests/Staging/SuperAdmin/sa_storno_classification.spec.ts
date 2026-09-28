import { test, expect } from '@playwright/test';
import { StornoClassificationPage, TYPE_RANK } from '../../../Pages/superadmin/sa.storno-classification.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — `isStorno()` reads the relation, not the invoice-number prefix (#3449, PR #3451).
 *
 * `Invoice::isStorno()` inferred Storno-ness from `str_starts_with($invoiceNumber, 'S')` while
 * `setOriginalInvoice()` carried the relational truth; ~20 readers depended on the convention and
 * four re-implemented it in DQL. The fix makes the relation authoritative and converts the readers.
 * **Deployed on staging; everything the change touches is consistent, and one reader was left behind.**
 *
 * **The honest difficulty with testing this ticket: a converged predicate is invisible on data where
 * the two mechanisms already agreed.** No before/after is observable, and manufacturing a drifted row
 * would mean writing an invoice with a mismatched number — irreversible, and precisely the state the
 * ticket exists to make impossible. So this file does the two things that ARE decidable from outside:
 * it checks the invariant that makes the change safe, in BOTH directions, and it cross-checks the
 * mechanisms that the ticket says could disagree.
 *
 * **The sharpest of those is the "Art" column.** `InvoiceOrderFilter::addTypeSort` ranks rows in SQL
 * with `CASE WHEN i.originalInvoice IS NOT NULL THEN 2 …` while `Invoice::getInvoiceType()` computes
 * the same ranking in PHP, and the code comment requires them to "stay in lockstep". Sorting the whole
 * book by Art and checking the serialized types come back monotonic compares the two directly, row by
 * row, over all 555 invoices — no drifted fixture needed. **0 disagreements in both directions.**
 *
 * **What the earlier round did not cover:** the dev checked "57 invoices with `original_invoice_id`
 * set and 0 violating the prefix". That is one direction. The other — an **S-numbered invoice with no
 * original**, which the old predicate called a Storno and the new one calls an ordinary invoice — was
 * never checked, and it is the direction in which the fix *removes* Storno-ness from a row. On staging
 * it is also empty (0 of 555), so the change really is behaviour-neutral here; but that is a measured
 * fact now rather than an assumption.
 *
 * **Finding** → `fixme`: `InvoiceRepository::findLegacyPkvPendingDatevSync()` still excludes Stornos
 * by `NOT LIKE 'S%'`. Latent, like the original ticket — but it is the one DATEV arm with no Storno
 * counterpart, so a drifted row there books an unreversed receivable.
 *
 * **Read-only — every request is a GET.**
 */

/**
 * The ticket's own failure table: a cancelled original, then a Storno at a LOWER id than the
 * replacement. `getActiveInvoice()` iterates the collection and returns the first invoice it does not
 * skip, so this ordering is what made the #3448 fixture return the Storno as the VO's live successor.
 * Three real VOs on staging have exactly this shape.
 */
const TICKET_SHAPE_MINIMUM = 1;

test.describe('Storno classification reads the originalInvoice relation', () => {
  let auth: string;

  test.beforeAll(async ({ request }) => {
    const response = await request.post('https://api.staging.therapios.de/auth', {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    expect(response.status(), 'the suite needs a Super Admin token').toBe(200);
    auth = (await response.json()).token;
  });

  test(
    'The relation, the number prefix and the rendered type identify the same invoices — in both directions',
    { tag: ['@SuperAdmin', '@StornoClassification', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const invoices = new StornoClassificationPage(request, auth);
      const book = await invoices.allInvoices();
      const { relational, prefix, serialized } = await invoices.stornoSignals();
      console.log(
        `${book.length} invoices | relational Stornos ${relational.size} | S-prefixed ${prefix.size} | rendered as storno ${serialized.size}`,
      );

      const only = (a: Set<number>, b: Set<number>) => [...a].filter((id) => !b.has(id));
      const byId = new Map(book.map((row) => [row.id, row]));
      const describe = (ids: number[]) => ids.map((id) => `${id}:${byId.get(id)?.invoiceNumber}`).join(', ');

      // Direction 1 — the one the earlier round checked: a linked reversal that is not S-numbered.
      // Under the OLD predicate it read as an ordinary invoice everywhere, which is the #3448 red.
      expect(
        describe(only(relational, prefix)),
        'an invoice with an originalInvoice must also carry the S prefix',
      ).toBe('');

      // Direction 2 — unchecked until now, and the one where the fix REMOVES Storno-ness: an
      // S-numbered invoice with no original was a Storno before and is an ordinary invoice now.
      expect(
        describe(only(prefix, relational)),
        'an S-numbered invoice with no originalInvoice would change meaning under this fix',
      ).toBe('');

      // And the serialized type — what every screen renders — must follow the relation exactly.
      expect(describe(only(serialized, relational)), 'rendered storno but not relationally one').toBe('');
      expect(describe(only(relational, serialized)), 'relationally a storno but not rendered as one').toBe('');
    },
  );

  test(
    'No VO ever presents a Storno as its live invoice, including the shape that broke #3448',
    { tag: ['@SuperAdmin', '@StornoClassification', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const invoices = new StornoClassificationPage(request, auth);
      const book = await invoices.allInvoices();
      const stornoIds = new Set(book.filter((row) => row.originalInvoiceId !== null).map((row) => row.id));
      const prescriptions = await invoices.prescriptionsWithAStorno();
      expect(prescriptions.length, 'staging must carry VOs with a Storno for this to mean anything').toBeGreaterThan(0);

      let ticketShaped = 0;
      for (const id of prescriptions) {
        const vo = await invoices.voBilling(id);
        const mine = book.filter((row) => row.prescriptionIri?.endsWith(`/${id}`));
        const stornosHere = mine.filter((row) => stornoIds.has(row.id));

        console.log(
          `VO ${vo.number.padEnd(9)} | ${mine.map((r) => `${r.id}:${r.invoiceNumber}:${r.status}`).join(' ')} ` +
            `| active -> ${vo.activeInvoiceNumber ?? 'null'} | cancelled ${JSON.stringify(vo.cancelledInvoiceIds)}`,
        );

        expect(
          vo.activeInvoiceId === null || !stornoIds.has(vo.activeInvoiceId),
          `${vo.number}: getActiveInvoice() returned the Storno ${vo.activeInvoiceNumber}`,
        ).toBe(true);

        // #3656: nor may it return a CANCELLED original. Both halves together are what the
        // automatic draft cancellation's entity-restore exists to preserve — its own docblock warns
        // that a cancellation whose transaction fails leaves CANCELLED written on the object while
        // the database rolled back, and "getActiveInvoice() skips CANCELLED, so a serialized VO
        // loses its draft and grows a phantom row in getCancelledInvoices()". That phantom is
        // within-request and never persisted, so no stored-data check can catch it (the detector is
        // InvoiceRegenerationServiceTest); this pins the rule it would violate.
        expect(
          vo.activeInvoiceId === null || byStatus(book, vo.activeInvoiceId) !== 'cancelled',
          `${vo.number}: getActiveInvoice() returned the CANCELLED ${vo.activeInvoiceNumber}`,
        ).toBe(true);

        // getCancelledInvoices() is the other prefix reader on the VO root: it must list the cancelled
        // ORIGINALS and never the reversals.
        for (const cancelledId of vo.cancelledInvoiceIds) {
          expect(stornoIds.has(cancelledId), `${vo.number}: a Storno appeared in cancelledInvoices`).toBe(false);
          expect(byStatus(book, cancelledId), `${vo.number}: cancelledInvoices must hold cancelled rows`).toBe('cancelled');
        }

        // The ticket's table: a Storno sitting at a lower id than the live replacement. Iteration is
        // id order (now pinned by #[ORM\OrderBy]), so this is the arrangement that returned the
        // Storno when the predicate missed it.
        if (vo.activeInvoiceId !== null && stornosHere.some((row) => row.id < vo.activeInvoiceId!)) {
          ticketShaped++;
          console.log(`   ^ this is the #3448 shape: Storno at a lower id than the live invoice`);
        }
      }

      expect(
        ticketShaped,
        'at least one VO must reproduce the arrangement from the ticket, or this test proves little',
      ).toBeGreaterThanOrEqual(TICKET_SHAPE_MINIMUM);
      console.log(`${ticketShaped} of ${prescriptions.length} VOs reproduce the ticket's failing arrangement`);
    },
  );

  test(
    'The VO-rooted cancelled set and the invoice-rooted Storniert register agree exactly',
    { tag: ['@SuperAdmin', '@StornoClassification', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const invoices = new StornoClassificationPage(request, auth);

      // This is the ticket's "concrete stake": getCancelledInvoices() used the PREFIX while the
      // register's SQL uses the RELATION, so a drifted row would show two different cancelled sets on
      // two screens. Converged, they must be one set.
      const register = await invoices.cancelledRegister();
      expect(register.every((row) => row.originalInvoiceId === null), 'no Storno may appear in the register').toBe(true);
      expect(register.every((row) => row.status === 'cancelled'), 'the register holds cancelled originals').toBe(true);

      const voRooted = new Set<number>();
      for (const id of await invoices.prescriptionsWithAStorno()) {
        for (const cancelledId of (await invoices.voBilling(id)).cancelledInvoiceIds) voRooted.add(cancelledId);
      }
      const invoiceRooted = new Set(register.map((row) => row.id));
      console.log(`VO-rooted cancelled set ${voRooted.size} | invoice-rooted register ${invoiceRooted.size}`);

      expect([...voRooted].filter((id) => !invoiceRooted.has(id)), 'in the VO-rooted set only').toEqual([]);
      expect([...invoiceRooted].filter((id) => !voRooted.has(id)), 'in the register only').toEqual([]);
    },
  );

  test(
    'The "Art" column\'s DQL ranking agrees with the PHP it mirrors, on every invoice',
    { tag: ['@SuperAdmin', '@StornoClassification', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const invoices = new StornoClassificationPage(request, auth);

      for (const direction of ['asc', 'desc'] as const) {
        const rows = await invoices.orderedByType(direction);
        const violations = StornoClassificationPage.monotonicityViolations(rows, direction);
        const stornoPositions = rows.map((row, i) => (row.invoiceType === 'storno' ? i : -1)).filter((i) => i >= 0);
        console.log(
          `order[type]=${direction}: ${rows.length} rows, ${violations.length} disagreements, ` +
            `storno rows at ${stornoPositions[0]}..${stornoPositions[stornoPositions.length - 1]}`,
        );

        // A single row whose SQL rank and PHP type disagreed would break the ordering exactly here.
        expect(violations.slice(0, 5), `order[type]=${direction} must rank by the same rule getInvoiceType() uses`).toEqual([]);

        // And the ranking is the documented one: copayment 0, pkv 1, storno 2.
        const expectedEnd = direction === 'asc' ? rows.length - stornoPositions.length : 0;
        expect(stornoPositions[0], `stornos are rank ${TYPE_RANK.storno}, so they belong at the ${direction === 'asc' ? 'end' : 'start'}`).toBe(
          expectedEnd,
        );
      }
    },
  );

  test(
    'Every DATEV finder partitions Stornos by the relation, not the number',
    { tag: ['@SuperAdmin', '@StornoClassification', '@ReadOnly'] },
    async ({ request }) => {
      test.fixme(
        true,
        'One reader was left on the prefix. PR #3451 converted findPendingDatevSync() and ' +
          'findPendingStornoDatevSync() to `originalInvoice IS NULL / IS NOT NULL`, InvoiceOrderFilter::' +
          'addTypeSort to a relational CASE, and DatevPaymentSyncService off `str_starts_with($reference, ' +
          '"S")` — but `InvoiceRepository::findLegacyPkvPendingDatevSync()` (the #3440 old-format PKV arm) ' +
          'still excludes reversals with `andWhere(\'i.invoiceNumber NOT LIKE :sPrefix\')`, untouched by ' +
          'the PR. ' +
          '(The two remaining prefix uses in CorrectStornoInvoiceAmountsCommand are deliberate and ' +
          'correct: reportHalfMatches() compares BOTH predicates by design — it is the drift detector — ' +
          'and findStornoIds() requires both to agree before it writes.) ' +
          'Why this arm specifically matters: its own docblock says it "has no Storno arm ... a cancelled ' +
          'original delivered here would raise a receivable no reversal ever clears", which is exactly ' +
          'what a relationally-linked Storno with a non-S number would become. ' +
          'Exposure measured on staging: 84 invoices satisfy the finder\'s number rule (NOT R%, NOT S%) — ' +
          '44 PKV and 40 GKV — and 0 of them carry an originalInvoice, so nothing slips through today. ' +
          'Latent, exactly like the ticket\'s original framing, and cheap to close while the context is ' +
          'fresh.',
      );

      const invoices = new StornoClassificationPage(request, auth);
      const candidates = await invoices.legacyFinderCandidates();
      console.log(`invoices matching the legacy finder's number rule: ${candidates.length}`);
      expect(
        candidates.filter((row) => row.originalInvoiceId !== null),
        'the legacy PKV finder must exclude reversals by the relation, so no linked Storno can match its number rule',
      ).toEqual([]);
    },
  );
});

/** The status of one invoice in the snapshot, for the cancelledInvoices assertion. */
function byStatus(book: { id: number; status: string }[], id: number): string {
  return book.find((row) => row.id === id)?.status ?? 'missing';
}
