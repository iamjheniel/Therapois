import { test, expect } from '@playwright/test';
import {
  DatevOldFormatPage,
  DEBT_COLLECTION_FIXTURE,
  DEBT_COLLECTION_STATUSES,
  EXPECTED,
  OLD_FORMAT_PKV_NUMBERS,
  PREVIEW_2026_08_24,
  OUTSTANDING_STATUSES,
  isInScope,
  isOldFormat,
  isStorno,
  isSynced,
} from '../../../Pages/superadmin/sa.datev-old-format.page';

/**
 * One-Time DATEV Push for Old-Format PKV Invoices — RC 3.11.1 #3440.
 *
 * PKV invoices predating the current numbering format carry a bare number (`426-14`) instead of the
 * current `R426-64`. The nightly DATEV sync selects on the `R` prefix, so they are permanently
 * excluded: they never reach DATEV, and the payment-status pull that follows a delivery never runs
 * for them, so Flow shows them as outstanding forever. #3440 ships a one-time command that delivers
 * them **under their existing number** and puts them on the ongoing payment-status path.
 *
 * **The command — `app:datev:push-legacy-pkv-invoices` — is console-only, and it can only ever be
 * previewed here.** `DATEV_SYNC_ENABLED` is `false` on staging, so `--force` aborts at the guard;
 * and the parameter also gates the three DATEV EventBridge rules, so enabling it would start the
 * nightly push, payment pull and debtor creation against staging data against a Riecken gateway
 * whose URL and credentials are byte-identical to production. Staging is preview-only by decision;
 * the real delivery happens on production. So this spec does what is decidable from a browser:
 *
 *  - it derives the affected population from the ticket's own rule and checks it still reproduces
 *    the reference figure of 44 — independently of the command, and **set-identical to the command's
 *    2026-08-24 preview output**, which is AC1's comparison from both directions;
 *  - it pins the two boundary cases a naive implementation of that rule gets wrong;
 *  - it proves the defect is live — not one old-format invoice has ever reached DATEV, while
 *    current-format ones have (the AC5 baseline);
 *  - it records the pre-run payment statuses AC3/AC4 are judged against;
 *  - and it carries the post-run assertions for AC2/AC4/AC6 as **data-gated tests that skip with
 *    evidence** until a push exists to read, rather than passing vacuously. They are written to run
 *    unchanged against production, which is where the delivery will happen.
 *
 * **Every request is a GET.** The UI half only opens a tab and a dropdown.
 */
test.describe('#3440 One-time DATEV push for old-format PKV invoices', () => {
  test.describe.configure({ mode: 'serial' });

  let datev: DatevOldFormatPage;

  test.beforeEach(async ({ page }) => {
    datev = new DatevOldFormatPage(page);
    await datev.open();
  });

  // ───────────────────────────── AC1 — the selection rule ─────────────────────

  test(
    'AC1 the invoice-number rule selects exactly the 44 old-format PKV invoices',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const oldFormat = await datev.oldFormatInvoices();
      const pkv = oldFormat.filter(isInScope);
      const gkv = oldFormat.filter((i) => i.insuranceType === 'public');

      console.log(
        `old-format invoices: ${oldFormat.length} — ${pkv.length} PKV (in scope), ${gkv.length} GKV (out of scope)`,
      );
      for (const i of pkv) {
        console.log(
          `  ${i.number.padEnd(8)} ${i.status.padEnd(14)} ${i.amount.toFixed(2).padStart(9)} €  VO ${i.vo}  ${i.patient}`,
        );
      }

      // The rule reproduces the ticket's reference figure. The ticket is explicit that this may
      // drift, so the count is asserted with the rule's own output printed above it — a drift reads
      // as a diff against 44, not as a mystery.
      expect(pkv.length, 'old-format PKV invoices (the ticket\'s 44)').toBe(EXPECTED.pkv);

      // Cross-check against what the command itself reported in preview on the same date: same
      // count, same total value. Two independent derivations of the rule agreeing is stronger than
      // either alone — a rule that quietly widened would break the total, not just the count.
      const total = Number(pkv.reduce((sum, i) => sum + i.amount, 0).toFixed(2));
      console.log(
        `total value: ${total.toFixed(2)} € — the command's 2026-08-24 preview reported ` +
          `${PREVIEW_2026_08_24.wouldSend} invoices / ${PREVIEW_2026_08_24.totalValue.toFixed(2)} €, 0 skipped`,
      );
      expect(pkv.length, 'agrees with the preview run\'s count').toBe(PREVIEW_2026_08_24.wouldSend);
      expect(total, 'agrees with the preview run\'s total value').toBeCloseTo(PREVIEW_2026_08_24.totalValue, 2);

      // Nothing in scope carries a current-format number, and nothing current-format leaks in.
      expect(pkv.every((i) => !/^R/.test(i.number))).toBe(true);
      expect(pkv.every((i) => i.insuranceType === 'private')).toBe(true);

      // AC6's report fields are all readable per invoice — number, patient, amount.
      for (const i of pkv) {
        expect(i.number, 'every selected invoice has a number').toBeTruthy();
        expect(i.patient, `invoice ${i.number} must resolve a patient for the report`).toBeTruthy();
        expect(i.amount, `invoice ${i.number} must carry an amount`).toBeGreaterThan(0);
      }
    },
  );

  test(
    'AC1 the rule must not sweep in Storno documents, whose numbers also lack the R',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const all = await datev.allInvoices();
      const stornos = all.filter((i) => isStorno(i.number));

      console.log(`Storno documents: ${stornos.length} — ${stornos.map((s) => s.number).join(', ')}`);

      // A selection written as a bare "does not start with R" hits these too. The shipped command
      // excludes them explicitly (`invoiceNumber NOT LIKE 'S%'`, stornos having their own sync
      // path), and its preview returned none — this test is what keeps that clause honest.
      expect(stornos.length, 'Storno documents exist to be mis-selected').toBe(EXPECTED.storno);
      expect(stornos.every((s) => !/^R/.test(s.number)), 'every Storno number fails the R test').toBe(true);
      expect(stornos.every((s) => !isOldFormat(s.number)), 'but none is an old-format invoice').toBe(true);

      const oldFormatNumbers = new Set(all.filter((i) => isOldFormat(i.number)).map((i) => i.number));
      for (const s of stornos) {
        expect(oldFormatNumbers.has(s.number), `${s.number} must stay out of the selection`).toBe(false);
      }
    },
  );

  test(
    'AC1 out-of-scope GKV old-format invoices are excluded by the insurance filter, not by the number rule',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const oldFormat = await datev.oldFormatInvoices();
      const gkv = oldFormat.filter((i) => i.insuranceType === 'public');
      const byStatus: Record<string, number> = {};
      for (const i of gkv) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;

      console.log(`old-format GKV invoices: ${gkv.length} — ${JSON.stringify(byStatus)}`);
      console.log(
        'the ticket names ONE out-of-scope GKV invoice ("has not yet been sent"); staging holds ' +
          `${gkv.length}, ${byStatus['not_sent'] ?? 0} of them not_sent`,
      );

      // The number rule alone does not separate them — the insurance scope is load-bearing.
      expect(gkv.every((i) => isOldFormat(i.number)), 'they all satisfy the number rule').toBe(true);
      expect(gkv.every((i) => !isInScope(i)), 'and are excluded only by the PKV filter').toBe(true);
      expect(gkv.length, 'old-format GKV invoices out of scope').toBe(EXPECTED.gkv);

      // None has been delivered to DATEV, so a later run over the wrong population is detectable.
      expect(gkv.filter(isSynced).length, 'no GKV old-format invoice is in DATEV today').toBe(0);
    },
  );

  // ──────────────────── the defect, and the AC5 baseline ─────────────────────

  test(
    'AC2 pre-state: not one old-format invoice has ever reached DATEV',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const synced = await datev.syncedInvoices();
      const oldFormat = await datev.oldFormatInvoices();
      const pkv = oldFormat.filter(isInScope);
      const pushes = await datev.datevPushes();
      const pushedIds = new Set(pushes.map((p) => p.invoiceId));

      console.log(`invoices in DATEV: ${synced.length}; datev_push_success log rows: ${pushes.length}`);
      console.log(`of those, old-format: ${synced.filter((i) => isOldFormat(i.number)).length}`);

      // Every delivered invoice carries the current format — this is the excluded population.
      expect(synced.length, 'invoices reported synced').toBe(EXPECTED.synced);
      expect(
        synced.filter((i) => isOldFormat(i.number)).length,
        'no old-format invoice is in DATEV before the run',
      ).toBe(0);

      // And per invoice, from both surfaces: no sync state, no push log.
      for (const i of pkv) {
        expect(i.datevSyncStatus, `${i.number} must have no DATEV sync status yet`).toBeNull();
        expect(i.datevSyncedAt, `${i.number} must have no DATEV sync date yet`).toBeNull();
        expect(pushedIds.has(i.id), `${i.number} must have no datev_push_success log yet`).toBe(false);
      }

      // The failure counter is not a stand-in for "was this pushed": it is 0 everywhere, and there
      // are no failure log rows either, so the exclusion is silent — nothing ever tried.
      expect(pkv.every((i) => i.datevSyncAttempts === 0)).toBe(true);
      const failures = await datev.logCount('datev_push_failed');
      console.log(`datev_push_failed log rows: ${failures} — the exclusion leaves no failure trace`);
      expect(failures, 'the old-format invoices are skipped, not failing').toBe(0);
    },
  );

  test(
    'AC5 baseline: current-format invoices do reach DATEV, in batches, and must keep doing so',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      const synced = await datev.syncedInvoices();
      const pushes = await datev.datevPushes();

      const batches: Record<string, number> = {};
      for (const p of pushes) batches[p.batchId ?? 'no-batch'] = (batches[p.batchId ?? 'no-batch'] ?? 0) + 1;
      const days = [...new Set(synced.map((i) => String(i.datevSyncedAt ?? '').slice(0, 10)))].sort();

      console.log(`DATEV deliveries on ${days.join(', ')} across ${Object.keys(batches).length} batch ids`);
      console.log(`push types: ${JSON.stringify([...new Set(pushes.map((p) => p.type))])}`);

      expect(synced.every((i) => /^R/.test(i.number)), 'every delivered invoice is current-format').toBe(true);
      expect(synced.every((i) => i.datevSyncedAt), 'every delivered invoice carries a sync date').toBeTruthy();
      expect(pushes.length, 'each delivery left an audit log row').toBe(synced.length);
      expect(pushes.every((p) => p.batchId), 'each push carries a batch id').toBe(true);
      // One id per push, not per run — so a run is recovered from `createdAt`, not from the id.
      expect(Object.keys(batches).length, 'batch ids are unique per push').toBe(pushes.length);

      // The nightly is switched OFF on staging — `DATEV_SYNC_ENABLED=false` — which is why the
      // newest delivery predates invoices issued since. So AC5 is not observable here by running
      // anything; it holds structurally instead: #3440 leaves `findPendingDatevSync()` (the nightly
      // PUSH selection) unchanged and `R`-only, and widens only the payment-POLLING selection to
      // `LIKE 'R%' OR datevSyncStatus = SYNCED`. The batch trail below is the baseline a post-run
      // check on production compares against.
      const newest = days[days.length - 1];
      console.log(
        `newest DATEV delivery: ${newest}; nightly disabled on staging (DATEV_SYNC_ENABLED=false), ` +
          `so AC5 is structural, not observable (baseline: ${synced.length} delivered).`,
      );
    },
  );

  // ──────────────────── AC3 / AC4 — payment status baseline ──────────────────

  test(
    'AC3/AC4 baseline: 43 of the 44 are outstanding and exactly one is at the debt-collection step',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const pkv = (await datev.oldFormatInvoices()).filter(isInScope);
      const outstanding = pkv.filter((i) => OUTSTANDING_STATUSES.includes(i.status));
      const inkasso = pkv.filter((i) => DEBT_COLLECTION_STATUSES.includes(i.status));
      const paid = pkv.filter((i) => i.status === 'paid');

      console.log(
        `outstanding (Ausstehend): ${outstanding.length}; debt collection (Inkasso): ${inkasso.length}; paid: ${paid.length}`,
      );

      expect(outstanding.length, 'outstanding old-format PKV invoices').toBe(EXPECTED.pkvOutstanding);
      expect(inkasso.length, 'old-format PKV invoices at the debt-collection step').toBe(EXPECTED.pkvDebtCollection);
      expect(inkasso[0].number, 'the Inkasso invoice AC4 singles out').toBe(DEBT_COLLECTION_FIXTURE.number);
      expect(inkasso[0].vo).toBe(DEBT_COLLECTION_FIXTURE.vo);

      // AC3's boundary case — "already paid before this ticket runs" — has no fixture here. Reported
      // rather than skipped silently, because it is the case the developer guidance calls out.
      expect(paid.length, 'no old-format PKV invoice is paid today').toBe(0);
      console.log(
        'AC3 boundary case (an old-format invoice already paid when the run happens) has NO staging ' +
          'fixture: all 44 are unpaid. It can only be covered by marking one paid in DATEV first, ' +
          'or by a unit test.',
      );
    },
  );

  // ───────────────────────────── the UI surface ──────────────────────────────

  test(
    'the DATEV column reports the old-format PKV invoices as pending, and its filter cannot find them',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);

      // The API filter behind the dropdown: `synced` works, `pending` is empty in every combination
      // even though the column renders "Ausstehend" for every unsynced row.
      const counts = {
        default: await datev.pkvBillingCount(),
        archived: await datev.pkvBillingCount({ treatmentStatus: 'Archiviert' }),
        synced: await datev.pkvBillingCount({ allWithInvoice: 'true', datevStatus: 'synced' }),
        pending: await datev.pkvBillingCount({ allWithInvoice: 'true', datevStatus: 'pending' }),
        pendingArchived: await datev.pkvBillingCount({ treatmentStatus: 'Archiviert', datevStatus: 'pending' }),
        failed: await datev.pkvBillingCount({ allWithInvoice: 'true', datevStatus: 'failed' }),
      };
      console.log('PKV-Abrechnung counts', JSON.stringify(counts));

      const body = await datev.openPkvTab();
      expect(body, 'the list carries a DATEV column').toContain('DATEV');
      expect(body, 'delivered invoices read "Synchronisiert"').toContain('Synchronisiert');
      expect(body, 'undelivered invoices read "Ausstehend"').toContain('Ausstehend');

      const options = await datev.datevFilterOptions();
      console.log('DATEV filter options', JSON.stringify(options));
      expect(options).toEqual(expect.arrayContaining(['Ausstehend', 'Synchronisiert', 'Fehlgeschlagen']));

      // The archived filter is the only route to the 44 (#3277): they all sit on archived VOs.
      expect(counts.archived, 'archived PKV rows are reachable').toBeGreaterThan(EXPECTED.pkv);
      expect(counts.synced, 'the synced option finds the delivered invoices').toBeGreaterThan(0);

      // Pre-existing #2856 defect, recorded here because it blocks the ticket's QA route: the PM
      // cannot use DATEV = "Ausstehend" to list the affected invoices before or after the run.
      console.log(
        `FINDING (#2856, not #3440): DATEV filter "Ausstehend" returns ${counts.pending} rows in ` +
          `"Alle mit Rechnung" mode and ${counts.pendingArchived} on archived VOs, while the DATEV ` +
          'column renders "Ausstehend" for every unsynced invoice. `datevSyncStatus` is omitted ' +
          'from the payload until a push happens, so there is no stored value for pending to match.',
      );
      expect(counts.pending, 'the pending option is empty — the filter cannot find them').toBe(0);
    },
  );

  // ─────────────────── post-run: data-gated until the command runs ───────────

  test(
    'AC2/AC6 after the run: every old-format PKV invoice is in DATEV under its unchanged number',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const oldFormat = await datev.oldFormatInvoices();
      const pkv = oldFormat.filter(isInScope);
      const delivered = pkv.filter(isSynced);

      test.skip(
        delivered.length === 0,
        `no delivery to read — 0 of ${pkv.length} old-format PKV invoices carry a DATEV sync ` +
          'status. An execute run is blocked on staging by DATEV_SYNC_ENABLED=false (and enabling ' +
          'it would start the nightly jobs against a production-shared gateway), so this closes ' +
          'against PRODUCTION after the real delivery. The assertions below need no changes to run ' +
          'there.',
      );

      const pushes = await datev.datevPushes();
      const pushedIds = new Set(pushes.map((p) => p.invoiceId));

      // AC2 — all of them, not some of them.
      expect(delivered.length, 'every selected invoice reached DATEV').toBe(pkv.length);
      for (const i of pkv) {
        expect(i.datevSyncStatus, `${i.number} synced`).toBe('synced');
        expect(i.datevSyncedAt, `${i.number} carries a sync date`).toBeTruthy();
        expect(pushedIds.has(i.id), `${i.number} left a datev_push_success log`).toBe(true);
        // No renumbering, under any circumstances.
        expect(i.number, `${i.number} must keep its old-format number`).not.toMatch(/^R/);
      }

      // The numbers pinned before the run must all still be present, on the same invoices.
      const numbers = new Set(pkv.map((i) => i.number));
      for (const n of OLD_FORMAT_PKV_NUMBERS) {
        expect(numbers.has(n), `${n} must survive the run unchanged`).toBe(true);
      }

      // AC6 — the run is identifiable by when it happened, not by a shared batch id: `batchId` is
      // unique per push (84 pushes on staging hold 84 distinct ids). Group the deliveries by day so
      // the report can be reconciled against a single run.
      const byDay: Record<string, number> = {};
      for (const i of pkv) {
        const day = String(i.datevSyncedAt ?? '').slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
      }
      console.log(`old-format deliveries by day: ${JSON.stringify(byDay)}`);
      expect(Object.keys(byDay).length, 'the one-time run lands as one delivery day').toBe(1);
    },
  );

  test(
    'AC4 after the run: unpaid invoices stay outstanding and the Inkasso one stays at Inkasso',
    { tag: ['@SuperAdmin', '@DatevOldFormat', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);

      const pkv = (await datev.oldFormatInvoices()).filter(isInScope);
      const delivered = pkv.filter(isSynced);

      test.skip(
        delivered.length === 0,
        'no post-delivery state to judge AC4 against — the execute run is production-only (see the ' +
          'AC2/AC6 test). The pre-run baseline (43 outstanding + 1 Inkasso) is asserted above.',
      );

      const inkasso = pkv.filter((i) => i.number === DEBT_COLLECTION_FIXTURE.number);
      expect(inkasso.length, 'the Inkasso invoice is still in the population').toBe(1);
      expect(
        DEBT_COLLECTION_STATUSES,
        `${DEBT_COLLECTION_FIXTURE.number} must not be knocked back off the debt-collection step`,
      ).toContain(inkasso[0].status);

      // A delivery on its own must not mark anything paid — only a real payment does.
      for (const i of pkv.filter((i) => i.status === 'paid')) {
        const logs = await datev.invoiceLogs(i.id);
        const statusChanges = logs.filter((l) => l.type === 'status_change' && /paid/.test(l.value));
        console.log(`${i.number} reads paid — status_change trail: ${JSON.stringify(statusChanges.map((s) => s.createdAt))}`);
        expect(statusChanges.length, `${i.number} must have an auditable transition to paid`).toBeGreaterThan(0);
      }
    },
  );

  // ────────────────────────── console-only acceptance ────────────────────────

  test.fixme(
    'AC1/AC6 preview mode and the CSV report of invoices actually sent',
    { tag: ['@SuperAdmin', '@DatevOldFormat'] },
    async () => {
      // Both are properties of a console command with no HTTP surface, so they stay fixme'd here —
      // but both are VERIFIED out of band, and the AC1 test above cross-checks the result:
      //
      // Preview run 2026-08-24, `app:datev:push-legacy-pkv-invoices` with no --force, one-off
      // Fargate task on therapios-staging-console, image 86b17313 (= release/3.11.0 head), exit 0:
      //   44 old-format PKV invoices pending delivery / 44 would be sent as-is / 0 skipped
      //   43 overdue + 1 to_send_to_dc, EUR 32,968.57 — matching the 20 Aug reference exactly.
      // AC6's report is written by the command itself to
      //   s3://therapios-csv-files-staging/reports/DatevPushLegacyPkvInvoicesCommand/…csv
      // carrying invoice_id, invoice_number, entity, patient_id, patient_name, amount, status,
      // datev_sync_status, fiscal_year, outcome — so the report exists in preview mode too, which
      // is what makes the pre-run list signable off by billing.
    },
  );

  test.fixme(
    'AC3 an old-format invoice already paid in DATEV shows as paid in Flow after the run',
    { tag: ['@SuperAdmin', '@DatevOldFormat'] },
    async () => {
      // The mechanism is confirmed: `InvoiceRepository::findUnpaidForPaymentMatching()` widened from
      // `invoiceNumber LIKE 'R%'` to `LIKE 'R%' OR datevSyncStatus = SYNCED`. Nothing is marked
      // "already delivered", so an old-format invoice becomes pollable only after the one-time push
      // has actually set that status — which also means no *new* old-format invoice can enter the
      // polling path on its own.
      //
      // Unverifiable here for three separate reasons: all 44 are unpaid (no fixture), the pull job
      // is disabled on staging with the rest of the DATEV schedule, and confirming it would need
      // one of the 44 settled inside DATEV first. On production it is verified against the EXISTING
      // payment-status polling run — there is no new job to watch.
    },
  );

  test.fixme(
    'AC5 a newly issued current-format PKV invoice still reaches DATEV via the nightly process',
    { tag: ['@SuperAdmin', '@DatevOldFormat'] },
    async () => {
      // The nightly DATEV jobs are disabled on staging (DATEV_SYNC_ENABLED=false also sets the
      // EventBridge rules' State), so issuing a fresh invoice and waiting for the push cannot pass,
      // and asserting on it would report a deliberate config choice as a #3440 regression.
      //
      // AC5 is instead structural: `findPendingDatevSync()` — the nightly push selection — is
      // untouched and still `R`-only, so current-format invoices are unaffected by construction and
      // no old-format invoice can be picked up by the nightly at all.
      //
      // RUNBOOK consequence worth carrying into the production run: because the nightly still
      // excludes these invoices, anything the one-time command defers is NOT retried by the nightly.
      // Re-running the command is the only retry path, and it must be re-run until the deferred
      // count reaches 0. The command's last selection clause
      // (`datevSyncStatus IS NULL OR = FAILED`) is what makes that safe to repeat.
    },
  );
});
