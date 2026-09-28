import { test, expect } from '@playwright/test';
import { InvoiceRetentionPage, RETENTION_REFUSAL } from '../../../Pages/superadmin/sa.invoice-retention.page';

/**
 * RC 3.12 (#3492) — a finalized invoice can never be deleted.
 *
 * **Deployed (`bd91fa410`, 2026-08-26, `release/3.12.0`). AC2 and AC3 are verified live; AC1 is
 * console-only and AC4 is a document.**
 *
 * **The implementation is wider than the ticket asked for, and wider than the PM note records.**
 * The ticket named one command; the commit found and guarded **three** — `app:invoice:delete-all`,
 * `app:cleanup:billing-data` and `app:cleanup:gkv-billing-data`, the last two describing themselves
 * as one-time production cleanups. And the guard is an **allow-list** (`dev`/`test`/`staging`) read
 * from **`app.environment`**, so an unset or unknown environment fails closed.
 *
 * That matters because the PM note records AC-1 as "an env guard (`APP_ENV !== 'prod'`)". The
 * ticket's own Developer Reference warns against exactly that: `APP_ENV` is `prod` on staging AND
 * production, so it cannot tell them apart — a deny-list on it would have blocked the command on
 * staging (where it is meant to work) while a typo in the variable would have left production open.
 * The code does the opposite of what the note describes, and does it correctly.
 *
 * **AC2's protection is a stated rule, not the FK.** `InvoiceRetentionListener` sits on
 * `Prescription::preRemove` — the single choke point covering the `Patient -> Prescription` cascade,
 * console commands and future cleanup code — and `PatientDeleteProcessor` turns it into a readable
 * 422. Verified live on patient 8430: `DELETE /patients/8430` answers **422 "…6 invoice(s) on their
 * prescriptions are financial records subject to statutory retention…"**, the count matches an
 * independent count of that patient's invoices, and the patient is still there afterwards.
 *
 * **AC4's document exists — it is just not attached where the AC asks.** The PM note says the
 * compliance document is "currently missing" and waives the AC; in fact the commit ships
 * `api/docs/invoice-retention-compliance.md` (211 lines) covering all five required points in
 * sections 1–5, with a section 6 listing what it deliberately does NOT assert (RDS snapshot
 * retention, S3 versioning/object lock, dump retention, restoration rehearsal, and the § 14b UStG
 * basis pending the tax advisor's sign-off). What is missing is the attachment to the GitHub issue.
 *
 * **Traps**
 * - **A missing operation answers 405; an existing one with a missing id answers 404.** Probing a
 *   single route cannot tell "no delete exists" from "that id is gone", so the AC3 test probes a
 *   nonexistent id on both a protected resource and a control resource that DOES expose Delete
 *   (`/activity_treatments/{id}` → 404).
 * - **The AC2 test issues a real DELETE.** Its passing outcome is the refusal, so it must run
 *   against a patient that HAS invoices — a patient without them would be deleted, irreversibly.
 *   Each case re-derives the invoice count first and re-reads the patient afterwards.
 * - There is no client-reachable *positive* control (a patient with no invoices being deleted
 *   successfully); proving the processor lets a legitimate delete through would destroy a patient,
 *   so it is deliberately not attempted here.
 */

/**
 * Patients carrying invoices. The counts are re-derived at run time — they are listed only so a
 * fixture that stops carrying invoices is obvious in the diff.
 */
const PROTECTED_PATIENTS = [
  { id: 8430, name: 'Offline Testpatient S3', invoices: 6 },
  { id: 877, name: 'Anneliese Hasert', invoices: 4 },
  { id: 4425, name: 'Karl Schäfer', invoices: 3 },
];

/** Resources that must expose no Delete operation at all. */
const NO_DELETE_ROUTES = [
  { path: '/invoices/999999999', what: 'an invoice' },
  { path: '/invoice_logs/999999999', what: 'an invoice log' },
  { path: '/prescriptions/999999999', what: 'a prescription' },
  { path: '/billing_batches/999999999', what: 'a billing batch' },
];

/** A resource that DOES expose Delete — the control that makes 405 mean "no such operation". */
const DELETE_CONTROL = { path: '/activity_treatments/999999999', what: 'an activity treatment' };

test.describe('Invoices are never deleted (#3492)', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  let auth: string;
  let retention: InvoiceRetentionPage;

  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${InvoiceRetentionPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
      timeout: 120_000,
    });
    expect(response.status(), 'POST /auth').toBe(200);
    auth = (await response.json()).token;
  });

  test.beforeEach(async ({ request }) => {
    retention = new InvoiceRetentionPage(request, auth);
  });

  // ─────────────────────────────────── AC3 ────────────────────────────────────

  test(
    'AC3 no delete operation exists for an invoice, its log, a VO or a billing batch',
    { tag: ['@SuperAdmin', '@InvoiceRetention', '@ReadOnly'] },
    async () => {
      // The control first: this route DOES have a Delete, so a nonexistent id answers 404. Without
      // it, a 405 below could equally mean "that id is gone" — the two are indistinguishable from
      // one probe, and reading 405 as proof would be an assumption rather than a measurement.
      const control = await retention.deleteProbe(DELETE_CONTROL.path);
      console.log(`  control — DELETE ${control.path} -> ${control.status} (${DELETE_CONTROL.what})`);
      expect(control.status, 'the control route must exist and answer 404 for a missing id').toBe(404);

      for (const route of NO_DELETE_ROUTES) {
        const probe = await retention.deleteProbe(route.path);
        console.log(`  DELETE ${route.path} -> ${probe.status} (${route.what})`);
        expect(probe.status, `${route.what} must expose no Delete operation`).toBe(405);
      }
    },
  );

  test(
    'AC3 the same holds for ids that really exist',
    { tag: ['@SuperAdmin', '@InvoiceRetention', '@Mutating'] },
    async () => {
      // Tagged @Mutating deliberately: these DELETEs name live rows. They must all be refused at
      // the routing layer — nothing reaches a processor, so nothing can be written.
      const byPatient = await retention.invoicesByPatient();
      const anyInvoice = [...byPatient.values()][0];
      expect(anyInvoice, 'the environment must carry invoices').toBeTruthy();

      const live = [
        { path: '/invoices/471', what: 'an overdue copayment invoice' },
        { path: '/invoice_logs/35', what: 'a status-change log entry' },
        { path: '/prescriptions/28311', what: 'a VO carrying an invoice' },
      ];
      for (const route of live) {
        const probe = await retention.deleteProbe(route.path);
        console.log(`  DELETE ${route.path} -> ${probe.status} (${route.what})`);
        expect(probe.status, `${route.what} must not be deletable`).toBe(405);
      }

      // And the rows are all still there.
      expect(await retention.exists('/invoices/471'), 'the invoice survives').toBe(true);
      expect(await retention.exists('/prescriptions/28311'), 'so does the VO').toBe(true);
    },
  );

  // ─────────────────────────────────── AC2 ────────────────────────────────────

  test(
    'AC2 deleting a patient who has invoices is refused, with the count, and changes nothing',
    { tag: ['@SuperAdmin', '@InvoiceRetention', '@Mutating'] },
    async () => {
      const byPatient = await retention.invoicesByPatient();

      for (const fixture of PROTECTED_PATIENTS) {
        const held = byPatient.get(fixture.id);
        expect(held, `${fixture.name} must still carry invoices for this case to mean anything`).toBeTruthy();
        expect(held!.count, `${fixture.name}'s invoice count`).toBeGreaterThan(0);

        expect(await retention.exists(`/patients/${fixture.id}`), 'the patient exists before the probe').toBe(true);

        const probe = await retention.deleteProbe(`/patients/${fixture.id}`);
        console.log(
          `  DELETE /patients/${fixture.id} (${fixture.name}, ${held!.count} invoice(s):` +
            ` ${held!.numbers.join(', ')}) -> ${probe.status}`,
        );
        console.log(`    ${probe.detail}`);

        expect(probe.status, `${fixture.name}: the delete must be refused`).toBe(422);
        const match = probe.detail.match(RETENTION_REFUSAL);
        expect(match, `${fixture.name}: the refusal must name the invoice count`).toBeTruthy();
        // The count in the message is compared against a count derived from a different endpoint —
        // a hardcoded number would pass against a refusal that counted nothing.
        expect(Number(match![1]), `${fixture.name}: and it must be the real count`).toBe(held!.count);
        expect(probe.detail, 'the refusal points at the only legitimate correction').toContain('Storno');
        // GDPR: the message carries entity ids, never the patient's name.
        expect(probe.detail, 'and never names the patient').not.toContain(fixture.name);

        // The point of the whole ticket: the request changed nothing.
        expect(await retention.exists(`/patients/${fixture.id}`), 'the patient is still there').toBe(true);
        const after = await retention.invoicesByPatient();
        expect(after.get(fixture.id)?.count, 'and every invoice is still on them').toBe(held!.count);
      }
    },
  );

  // ─────────────────────────── AC1 / AC4 — out of reach ────────────────────────
});
