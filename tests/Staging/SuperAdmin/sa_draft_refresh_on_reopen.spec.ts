import { test, expect } from '@playwright/test';
import { DraftRefreshPage } from '../../../Pages/superadmin/sa.draft-refresh.page';

/**
 * RC 3.12 (#3589) — a still-unsent draft invoice must refresh when a session delete reopens its VO.
 *
 * **Deployed (`1e8e84361`, merged into `release/3.12.0` on 2026-09-03) and verified live.** The old
 * refresh path only ran while the VO's treatment status was in the regeneration allowlist
 * (`COMPLETED, CANCELLED, INVOICED, ARCHIVED`). A session delete flips a Fertig-behandelt VO back to
 * **Aktiv**, which is not on that list, so `applyDraftRefresh()` threw, the caller swallowed the
 * exception, and the draft kept a stale amount silently. The fix splits the predicate — first-time
 * generation is unchanged, only the refresh arm widens to accept a reopened Aktiv VO.
 *
 * **This is verified WITHOUT deleting a session, and that is a deliberate choice.** The listener
 * fires on a `treatmentStatus` *or* a `validationStatus` changeset, so toggling validation on an
 * already-Aktiv VO carrying a draft exercises the widened predicate directly — and the outcome is
 * visible even when the amount is already right, because a refresh restamps the draft's
 * **issueDate** and writes an `invoice_logs` note. Deleting a documented session is not reversible
 * here: `Activity` exposes `Delete` but no plain `Post`, only `/activities/bulk`, so a deleted
 * session cannot be put back as it was.
 *
 * **The probe is two-step, and each step predicts a different outcome under the same build** —
 * which is what makes it evidence rather than a coincidence:
 *
 * ```
 * validated → for_fixing  on Aktiv   no refresh   (not Validiert — unchanged behaviour)
 * for_fixing → validated  on Aktiv   REFRESH      (pre-fix this was silently rejected)
 * ```
 *
 * Measured on VO 8437-2 / draft R226-66: the first step moved nothing (issueDate unchanged, no new
 * log), the second restamped `2026-09-04T03:51:26Z → 04:01:46Z` and added a log entry.
 *
 * **Corroboration from the wild, before this file touched anything:** that same draft was created
 * `2026-08-27` and carries a "draft replaced in place" note dated `2026-09-04T03:51:26Z` — a refresh
 * on an Aktiv VO hours after the fix shipped, which the old allowlist could not have produced.
 *
 * **Traps**
 * - **Never toggle validation on an Aktiv VO with NO invoice.** The same listener path can CREATE
 *   one for an eligible VO (#3426's exclusion fixture is exactly this hazard), and that is
 *   irreversible. Every fixture here must already carry a draft.
 * - A refresh is not visible in the AMOUNT when the amount is already correct — read the issueDate
 *   and the log count, or a working refresh looks like nothing happened.
 * - Draft tier means `not_sent` **AND** `datevSyncedAt` null (#3495); a synced `not_sent` invoice is
 *   issued tier and must never be touched.
 */

/** The only Aktiv VO on staging carrying a draft-tier invoice — the shape this ticket is about. */
const REOPENED = { prescriptionId: 31476, vo: '8437-2', invoiceId: 622, invoice: 'R226-66' };

/** `not_sent` but already pushed to DATEV — issued tier, and the reason status alone is not enough. */
const ISSUED_TIER = { prescriptionId: 28942, vo: '3899-13', invoiceId: 493, invoice: 'R126-86' };

test.describe('Draft invoice refresh on a reopened VO (#3589)', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  let auth: string;
  let drafts: DraftRefreshPage;

  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${DraftRefreshPage.API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
      timeout: 120_000,
    });
    expect(response.status(), 'POST /auth').toBe(200);
    auth = (await response.json()).token;
  });

  test.beforeEach(async ({ request }) => {
    drafts = new DraftRefreshPage(request, auth);
  });

  test(
    'AC1 a validated, reopened (Aktiv) VO refreshes its unsent draft — and a non-validated one does not',
    { tag: ['@SuperAdmin', '@DraftRefresh', '@Mutating'] },
    async () => {
      const before = await drafts.state(REOPENED.prescriptionId, REOPENED.invoiceId);
      console.log(`  ${REOPENED.vo} / ${REOPENED.invoice}: ${JSON.stringify(before)}`);

      // The fixture has to be the reopened shape, or neither step means anything.
      expect(before.treatmentStatus, `${REOPENED.vo} must be Aktiv — the status the old allowlist rejected`).toBe(
        'Aktiv',
      );
      expect(
        DraftRefreshPage.LEGACY_ALLOWLIST,
        'and Aktiv must genuinely be outside the pre-fix allowlist',
      ).not.toContain(before.treatmentStatus);
      expect(before.validationStatus, 'and validated to start from').toBe('validated');
      expect(before.datevSyncedAt, 'and the invoice must be draft tier — never synced to DATEV').toBeNull();

      try {
        // Step 1 — NOT validated: the refresh must not be attempted. This is the control; without
        // it, a refresh in step 2 could be anything that happens to touch the invoice.
        expect(await drafts.setValidationStatus(REOPENED.prescriptionId, 'for_fixing')).toBeLessThan(300);
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        const unvalidated = await drafts.state(REOPENED.prescriptionId, REOPENED.invoiceId);
        console.log(`  after → for_fixing: issueDate ${unvalidated.issueDate}, logs ${unvalidated.logCount}`);
        expect(unvalidated.issueDate, 'a non-validated VO must not refresh its draft').toBe(before.issueDate);
        expect(unvalidated.logCount, 'and must write no log').toBe(before.logCount);

        // Step 2 — validated again on an Aktiv VO: this is the case #3589 fixes.
        expect(await drafts.setValidationStatus(REOPENED.prescriptionId, 'validated')).toBeLessThan(300);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const refreshed = await drafts.state(REOPENED.prescriptionId, REOPENED.invoiceId);
        console.log(`  after → validated : issueDate ${refreshed.issueDate}, logs ${refreshed.logCount}`);

        // The amount is already correct on this fixture, so the refresh shows in the restamp and
        // the log — reading the amount alone would report a working fix as a no-op.
        expect(refreshed.issueDate, 'a validated Aktiv VO must refresh its draft in place').not.toBe(
          unvalidated.issueDate,
        );
        expect(refreshed.logCount, 'and record it').toBeGreaterThan(unvalidated.logCount);
        // Whatever else changed, the draft must still agree with the VO.
        expect(refreshed.invoiceAmount, 'and the refreshed amount matches the VO').toBeCloseTo(
          refreshed.copaymentAmount!,
          2,
        );
        expect(refreshed.datevSyncedAt, 'and it is still an unsent draft').toBeNull();
      } finally {
        expect(
          await drafts.setValidationStatus(REOPENED.prescriptionId, before.validationStatus),
          'the VO must go back to its original validation status',
        ).toBeLessThan(300);
        const after = await drafts.state(REOPENED.prescriptionId, REOPENED.invoiceId);
        expect(after.validationStatus).toBe(before.validationStatus);
        expect(after.invoiceAmount, 'and the draft still carries the same amount').toBeCloseTo(
          before.invoiceAmount!,
          2,
        );
      }
    },
  );

  test(
    'AC2 issued invoices are out of reach — the draft-tier guard is what protects them',
    { tag: ['@SuperAdmin', '@DraftRefresh', '@ReadOnly'] },
    async () => {
      const invoices = await drafts.draftTierInvoices();
      expect(invoices.length, 'staging must carry unsent invoices').toBeGreaterThan(50);

      // `not_sent` is NOT the same as draft tier: an invoice already pushed to DATEV keeps that
      // status but is ISSUED, and regenerating one answers 400 "A cancellation reason is required"
      // (#3495). The refresh path sits behind the same `isDraftTier()` guard, which is why AC2
      // holds by construction — so the thing worth asserting is that the two tiers really are
      // distinct on this data, not a count over an arbitrary slice.
      const syncedDraft = await drafts.state(ISSUED_TIER.prescriptionId, ISSUED_TIER.invoiceId);
      console.log(
        `  ${ISSUED_TIER.invoice}: status not_sent, datevSyncedAt ${syncedDraft.datevSyncedAt} — issued tier`,
      );
      expect(
        syncedDraft.datevSyncedAt,
        `${ISSUED_TIER.invoice} is not_sent yet DATEV-synced, so "not_sent" alone cannot mean draft tier`,
      ).not.toBeNull();

      // And the fixture this file refreshes is on the other side of that line.
      const draft = await drafts.state(REOPENED.prescriptionId, REOPENED.invoiceId);
      expect(draft.datevSyncedAt, `${REOPENED.invoice} is genuinely draft tier`).toBeNull();
    },
  );

});
