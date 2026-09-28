import { test, expect } from '@playwright/test';
import {
  EtiPerGesellschaftPage,
  ENTITY_COUNT,
  NO_ACCOUNT_ERROR,
} from '../../../Pages/superadmin/sa.eti-per-gesellschaft.page';

/**
 * RC 3.13 — every ETI claim submits under its own Gesellschaft's account and key (#3473).
 *
 * Flow submitted every PKV invoice to ETI Experts under ONE shared account. ETI requires one
 * account per Gesellschaft: each has its own bank account and their bookkeeping must stay strictly
 * separate (ETI confirmed in writing, 13 Aug 2026). `EtiClient` now holds a Gesellschaft-id → key
 * map and `EtiSubmissionController` resolves the key per invoice inside the batch loop.
 * **Deployed as `1fb526b8b` (2026-08-27); AC1, AC2 and AC3's independence row verified from the
 * submission record. 5 passed / 2 fixme.**
 *
 * **This file never submits, by policy.** `POST /invoices/eti/submit` files a claim with a real
 * debt-collection partner; even flagged `test: true` that is an outward-facing action against a
 * third party and it cannot be undone from here. It does not need to: the outcome is durable —
 * `etiTransactionId` is serialized on the invoice and every status move is in `invoice_logs` — so
 * this reads the record that the PM's 13 Sep session and the `ETITEST-R*` series left behind.
 *
 * **AC1 is covered for all 7 Gesellschaften, which is better than the ticket's own notes say.** The
 * PM recorded 5 entities and "Entity 6 (Hannover) has no To-DC invoices on staging and was not
 * tested". There is a purpose-built `ETITEST-R1-043901 … ETITEST-R7-043901` series, one invoice per
 * Gesellschaft, and **all seven reached Sent to DC with a distinct transaction id** — entity 6's is
 * `26225ca0`. That also settles, empirically, the Go-Live Prerequisite asking whether entities 6 and
 * 7 map to the Rhein-Ruhr2 / Stuttgart1 accounts: both submitted successfully under their own key.
 *
 * **What this evidence cannot establish, stated plainly:** a distinct transaction id proves each
 * submission was accepted and separately tracked; it does **not** prove the claim landed in the
 * right ETI account. Only ETI's portal shows that. The tests assert what is decidable from here and
 * do not dress it up as more.
 *
 * **FINDING — two of the PM's five AC-1 data points no longer show what they are cited for.**
 * Invoices 505 (R426-70, entity 4, `6b211c6e`) and 480 (R526-56, entity 5, `2d689b33`) are quoted as
 * "prior successful submissions". Both DID transition to Sent to DC when submitted — and both were
 * moved back to `to_send_to_dc` by an **automatic** status change at the identical second,
 * **2026-09-02T05:42:25**, keeping their transaction ids. So today they contradict AC1's "transitions
 * to Sent to DC with its own transaction ID tracked". Entities 4 and 5 are still covered, by their
 * `ETITEST` rows — but whatever reverted two submitted invoices is worth a look, and it is outside
 * this ticket's ACs.
 *
 * **The mirror case, which is innocuous and worth knowing before anyone reports it:** invoice 479
 * (R126-84) is at Sent to DC with **no** transaction id — its log shows a single manual
 * `not_sent → sent_to_dc` move on 2026-07-24. It was never submitted. So neither status alone proves
 * a submission happened, nor its absence proves one did not.
 *
 * **The shipped design deliberately diverges from the ticket's Developer Reference.** That reference
 * says to keep `isTestMode()`'s `sk_test_` prefix check working per resolved key. The code rejects
 * that: the ETI portal issues one key per Gesellschaft with no test/live distinction, so whether a
 * claim opens a real case is decided by the request's own `test` flag — environment config, never
 * inferred from the key — and `$testMode` defaults to **true** so an unconfigured environment cannot
 * open real cases against patients. That is the safer design and the PM's 4 Sep note about
 * `sk_test_*` keys describes something the code no longer keys off.
 *
 * **Read-only — every request is a GET.**
 */

test.describe('#3473 ETI submissions use each Gesellschaft\'s own account and API key', () => {
  test.describe.configure({ mode: 'serial' });

  let auth: string;
  let rows: Awaited<ReturnType<EtiPerGesellschaftPage['dcInvoices']>>;
  let entities: { id: number; name: string }[];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    const page = new EtiPerGesellschaftPage(request);
    entities = await page.entities();
    rows = await page.dcInvoices();
    auth = '';
    expect(entities.length, 'the seven Gesellschaften must exist').toBe(ENTITY_COUNT);
    expect(rows.length, 'staging must carry invoices at an ETI stage').toBeGreaterThan(0);
  });

  test(
    'AC1 every Gesellschaft has an accepted submission with its own distinct transaction id',
    { tag: ['@SuperAdmin', '@EtiPerGesellschaft', '@ReadOnly'] },
    async ({ request }) => {
      const page = new EtiPerGesellschaftPage(request, auth);
      const byEntity = page.submissionsByEntity(rows);

      for (const e of entities) {
        const mine = byEntity.get(e.id) ?? [];
        console.log(
          `   entity ${e.id} ${e.name.padEnd(34)} ${mine.length} tracked submission(s): ` +
            mine.map((m) => `${m.invoiceNumber}=${m.etiTransactionId!.slice(0, 8)}`).join(', '),
        );
        expect(mine.length, `Gesellschaft ${e.id} (${e.name}) must have submitted under its own account`).toBeGreaterThan(0);
      }

      // A shared or mis-routed account would show up as a reused id. Distinctness across the whole
      // book is the strongest routing evidence available from outside ETI.
      const ids = rows.map((r) => r.etiTransactionId).filter((v): v is string => Boolean(v));
      expect(new Set(ids).size, 'every submission must be tracked under its own transaction id').toBe(ids.length);
      console.log(`#3473 AC1: ${ids.length} tracked submissions across ${byEntity.size}/${ENTITY_COUNT} Gesellschaften, all ids distinct`);
    },
  );

  test(
    'AC1 the transition is real: a tracked submission reached Sent to DC in its own log',
    { tag: ['@SuperAdmin', '@EtiPerGesellschaft', '@ReadOnly'] },
    async ({ request }) => {
      // The id alone does not prove the status moved; the log does. Checked on one submission per
      // Gesellschaft so all seven routing paths are covered, not just the ones the PM sampled.
      const page = new EtiPerGesellschaftPage(request, auth);
      const byEntity = page.submissionsByEntity(rows);

      for (const [entityId, mine] of [...byEntity.entries()].sort((a, b) => a[0] - b[0])) {
        const sample = mine.find((m) => m.status === 'sent_to_dc') ?? mine[0];
        const trail = await page.statusTrail(sample.id);
        const reached = trail.filter((t) => t.newValue === 'sent_to_dc');
        console.log(
          `   entity ${entityId}: ${sample.invoiceNumber} — ${trail.length} status moves, ` +
            `reached sent_to_dc ${reached.length}x (last ${reached.at(-1)?.createdAt.slice(0, 19) ?? 'never'})`,
        );
        expect(reached.length, `${sample.invoiceNumber}: a tracked submission must have reached Sent to DC`).toBeGreaterThan(0);
      }
    },
  );

  test(
    'AC2/AC3 a mixed-Gesellschaft batch is processed per invoice — one failure blocks nothing',
    { tag: ['@SuperAdmin', '@EtiPerGesellschaft', '@ReadOnly'] },
    async () => {
      // The PM's 13 Sep batch was invoiceIds [615, 655, 637, 667] spanning entities 1, 2, 3 and 7.
      // Three succeeded; 637 (entity 3) failed the address pre-check. The outcome is still readable,
      // and it is exactly AC2 plus AC3's third row.
      const batch = [615, 655, 637, 667];
      const seen = rows.filter((r) => batch.includes(r.id));
      expect(seen.length, 'the PM\'s batch invoices must still be present').toBe(batch.length);

      const succeeded = seen.filter((r) => r.etiTransactionId !== null);
      const blocked = seen.filter((r) => r.etiTransactionId === null);
      for (const r of seen) {
        console.log(
          `   invoice ${r.id} ${r.invoiceNumber.padEnd(18)} entity ${r.entityId} | ${r.status.padEnd(14)} | ` +
            `${r.etiTransactionId ? r.etiTransactionId.slice(0, 8) : 'no transaction'}`,
        );
      }

      expect(succeeded.length, 'three of the four succeeded, each under its own Gesellschaft').toBe(3);
      expect(new Set(succeeded.map((r) => r.entityId)).size, 'and they span three different Gesellschaften').toBe(3);
      expect(blocked.length, 'one failed on data quality, not on a key').toBe(1);
      expect(blocked[0].status, 'the blocked invoice stays at To Debt Collector').toBe('to_send_to_dc');
    },
  );

  test(
    'FINDING — two submitted invoices were reverted to To Debt Collector, keeping their transaction id',
    { tag: ['@SuperAdmin', '@EtiPerGesellschaft', '@ReadOnly'] },
    async ({ request }) => {
      const page = new EtiPerGesellschaftPage(request, auth);
      const reverted = page.revertedAfterSubmission(rows);
      console.log(`#3473 FINDING: ${reverted.length} invoices hold a transaction id while sitting at to_send_to_dc`);

      for (const r of reverted) {
        const trail = await page.statusTrail(r.id);
        const back = trail.filter((t) => t.oldValue === 'sent_to_dc' && t.newValue === 'to_send_to_dc');
        console.log(
          `   ${r.invoiceNumber} (entity ${r.entityId}, id ${r.etiTransactionId!.slice(0, 8)}): ` +
            back.map((b) => `${b.createdAt.slice(0, 19)} ${b.meta.includes('"automatic"') ? 'automatic' : 'manual'}`).join(', '),
        );
        // The point of the test: each of these DID transition on submission and was moved back
        // afterwards, so a reader of AC1 must not take today's status as the submission's outcome.
        expect(
          trail.some((t) => t.newValue === 'sent_to_dc'),
          `${r.invoiceNumber} must have reached Sent to DC before being reverted`,
        ).toBe(true);
        expect(back.length, `${r.invoiceNumber} must show the revert that explains its status`).toBeGreaterThan(0);
      }

      expect(reverted.length, 'this finding stands while those invoices remain reverted').toBeGreaterThan(0);
    },
  );

  test(
    'status alone proves nothing in either direction',
    { tag: ['@SuperAdmin', '@EtiPerGesellschaft', '@ReadOnly'] },
    async ({ request }) => {
      // The mirror of the finding above: an invoice can sit at Sent to DC having never been
      // submitted. Pinned so neither shape is mistaken for an ETI routing defect.
      const page = new EtiPerGesellschaftPage(request, auth);
      const marked = page.markedWithoutSubmission(rows);
      console.log(`#3473: ${marked.length} invoices are at sent_to_dc with NO transaction id`);
      for (const r of marked) {
        const trail = await page.statusTrail(r.id);
        const manual = trail.filter((t) => t.newValue === 'sent_to_dc' && t.meta.includes('"manual"'));
        console.log(
          `   ${r.invoiceNumber} (entity ${r.entityId}): ${trail.length} moves, ` +
            `${manual.length} manual move(s) into sent_to_dc — never submitted to ETI`,
        );
        expect(manual.length, `${r.invoiceNumber}: reached Sent to DC by hand, not via ETI`).toBeGreaterThan(0);
      }
    },
  );
});
