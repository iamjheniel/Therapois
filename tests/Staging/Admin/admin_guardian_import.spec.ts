import { test, expect } from '@playwright/test';
import { PatientAddressesPage } from '../../../Pages/admin/admin.patient-addresses.page';

/**
 * RC 3.10 — One-Time Guardian Address Import from TheOrg CSV (#3189, epic #3187).
 *
 * The import itself is a console command (`--apply` gated), so there is no UI to drive it from and
 * nothing here runs it. What these tests do is verify the *state the import is required to leave
 * behind*, against whatever it actually wrote on staging — which is the half a UI/API suite can hold
 * accountable, and the half that matters for the rollout gate.
 *
 * Confirmed live: the apply-mode run HAS happened on staging — a scan of 1,000 patients found 89
 * guardian-type addresses, each in the documented "New" shape (pre-existing Care Home address kept
 * and switched to non-billing, new guardian address created as billing). If a future environment has
 * not had the import run, every test here skips with that reason rather than failing.
 *
 * Read-only: nothing in this file writes to any patient.
 */
const GUARDIAN_TYPES = ['legal_guardian', 'relative', 'other'] as const;

/** Scan budget: 1,000 patients out of ~8,350. The import covers 548, so hits are dense enough. */
const SCAN_PAGES = 10;
const SCAN_PER_PAGE = 100;

test.describe('Guardian Contacts — TheOrg import results', () => {
  test(
    'AC3 — the existing care-home address is preserved on file rather than deleted',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124); // any patient form — just to establish an authenticated page

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(
        hits.length === 0,
        `No guardian-type address found in the first ${SCAN_PAGES * SCAN_PER_PAGE} patients, so the ` +
          `import has not been run in apply mode on this environment (preview mode writes nothing). ` +
          `Note the rollout gate: apply mode may only run after #3190 and #3191 are deployed.`,
      );
      console.log(`guardian-type addresses found on ${hits.length} patients`);

      // "please import the addresses as an additional contact without overwriting the current
      // address" — so a New-branch patient must still have their Care Home address on file, and it
      // must have kept its own address text.
      const newBranch = hits.filter((p) => p.addresses.some((a) => a.type === 'care_home'));
      expect(
        newBranch.length,
        `most imported patients are New-branch and must retain a Care Home address ` +
          `(${newBranch.length} of ${hits.length})`,
      ).toBeGreaterThan(0);

      for (const p of newBranch) {
        for (const ch of p.addresses.filter((a) => a.type === 'care_home')) {
          expect(
            ch.address,
            `patient ${p.patientId}: the preserved Care Home address must keep its address text`,
          ).toBeTruthy();
        }
      }

      // Convert-branch patients legitimately have no separate Care Home row — the guardian address IS
      // their pre-existing address, updated in place, so no duplicate was created for them.
      const convertBranch = hits.filter((p) => !p.addresses.some((a) => a.type === 'care_home'));
      console.log(
        `New branch (Care Home kept): ${newBranch.length}; Convert branch (updated in place): ` +
          `${convertBranch.length}`,
      );
      for (const p of convertBranch) {
        expect(
          p.addresses.filter((a) => GUARDIAN_TYPES.includes(a.type)).length,
          `patient ${p.patientId}: a converted-in-place address must not have been duplicated`,
        ).toBe(1);
      }
    },
  );

  test(
    'AC3 — the imported guardian address is the billing address',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.fixme(
        true,
        'PRODUCT DEFECT found by this test against the real staging import: 1 of the 89 imported ' +
          'patients in the scanned range has its guardian address left NON-billing, with a Care Home ' +
          'address still flagged as billing — so invoices and correspondence for that patient still ' +
          'go to the care home instead of the guardian, which is the exact outcome this epic exists ' +
          'to fix. Affected: Pat-Nr 2752 (patient id 459), guardian address 11296 "Katrin Harz" ' +
          '(relative, Frau) isBilling=false, while care_home 440 isBilling=true. The address carries ' +
          'the import fingerprint (contactPerson === personName, type from the CSV mapping), so it ' +
          'was created by the import rather than added by an admin — #3188 AC4 would make a manual ' +
          'add legitimately non-billing. Likely cause: this patient has TWO duplicate Care Home ' +
          'addresses (ids 440 and 459, identical text "Lanzendorfer Weg 30, 14089 Berlin, D"), and ' +
          'the billing-flip appears not to handle a duplicate. Note #3189 AC9\'s self-check does NOT ' +
          'catch this: the patient does have exactly one billing address, just the wrong one. ' +
          'Un-fixme this test once the import is corrected/re-run for the affected patient.',
      );

      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);
      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(hits.length === 0, 'Import has not been run in apply mode on this environment.');

      const notBilling = hits.filter(
        (p) => !p.addresses.some((a) => GUARDIAN_TYPES.includes(a.type) && a.isBilling),
      );
      expect(
        notBilling.map((p) => ({
          patientId: p.patientId,
          addresses: p.addresses.map((a) => ({ id: a.id, type: a.type, isBilling: a.isBilling })),
        })),
        'every imported guardian address must be its patient\'s billing address',
      ).toEqual([]);
    },
  );

  test(
    'AC9 — every patient touched by the import has exactly one billing address',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(hits.length === 0, 'Import has not been run in apply mode on this environment.');

      // This is the invariant the command has to guarantee itself: it is a bulk write path that
      // bypasses the form's onToggleBilling safeguard, and there is no database constraint behind it.
      const broken = hits
        .map((p) => ({ patientId: p.patientId, billing: p.addresses.filter((a) => a.isBilling).length }))
        .filter((p) => p.billing !== 1);

      expect(
        broken,
        `every imported patient must end with exactly one billing address; these do not: ` +
          `${JSON.stringify(broken)}`,
      ).toEqual([]);
    },
  );

  test(
    'AC3 — imported guardian addresses carry the type, salutation and name from the CSV',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(hits.length === 0, 'Import has not been run in apply mode on this environment.');

      const guardians = hits.flatMap((p) =>
        p.addresses.filter((a) => GUARDIAN_TYPES.includes(a.type)).map((a) => ({ patientId: p.patientId, a })),
      );

      const noName = guardians.filter(({ a }) => !a.personName && !a.contactPerson);
      // PID 5281 is a known blank-name row in the source CSV; the command is required to route it to
      // the review report rather than import a nameless address, so nothing here should be nameless.
      expect(
        noName.map((x) => x.patientId),
        `every imported guardian address must record a name (the one known blank-name CSV row, ` +
          `PID 5281, belongs in the review report, not in the data)`,
      ).toEqual([]);

      const noStructuredSalutation = guardians.filter(({ a }) => !a.salutation);
      // 8 of the 548 rows are organisational guardians (care offices) with a deliberately blank
      // Frau/Herr salutation — expected, not a data gap. So this is reported, not asserted to zero.
      console.log(
        `guardian addresses: ${guardians.length}; without a Frau/Herr salutation: ` +
          `${noStructuredSalutation.length} (organisational guardians are expected here)`,
      );
      for (const { patientId, a } of guardians) {
        if (a.salutation) {
          expect(
            ['Frau', 'Herr'],
            `patient ${patientId}: salutation must be a structured Frau/Herr value, got ` +
              `${JSON.stringify(a.salutation)}`,
          ).toContain(a.salutation);
        }
        expect(
          PatientAddressesPage.API_TYPES,
          `patient ${patientId}: imported type must be one of the mapped relationship types`,
        ).toContain(a.type);
      }

      // The CSV maps 48 raw relationship variants down to these three; a type outside them would mean
      // the mapping column was not used as instructed.
      const types = [...new Set(guardians.map(({ a }) => a.type))];
      console.log('imported relationship types present:', JSON.stringify(types));
      expect(
        types.every((t) => (GUARDIAN_TYPES as readonly string[]).includes(t)),
        `imported types must come from the CSV's pre-mapped relationship_type column, got ${JSON.stringify(types)}`,
      ).toBe(true);
    },
  );

  test(
    'AC8 — guardians of deceased patients are imported too',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(hits.length === 0, 'Import has not been run in apply mode on this environment.');

      const deceased = hits.filter((p) => p.isDeceased);
      console.log(
        `imported patients scanned: ${hits.length}; deceased among them: ${deceased.length} ` +
          `(28 of the 548 CSV rows are deceased patients)`,
      );
      test.skip(
        deceased.length === 0,
        `No deceased patient with an imported guardian address fell inside the scanned ` +
          `${SCAN_PAGES * SCAN_PER_PAGE} patients. Only 28 of the 548 imported patients are deceased, ` +
          `so this is a sampling gap rather than a failure — widen SCAN_PAGES to cover more.`,
      );

      // A deceased patient's guardian must be treated exactly like any other: billing, single-billing.
      for (const p of deceased) {
        expect(
          p.addresses.filter((a) => GUARDIAN_TYPES.includes(a.type) && a.isBilling).length,
          `deceased patient ${p.patientId}: the guardian address must still be the billing address ` +
            `so remaining invoices reach the right person`,
        ).toBe(1);
      }
    },
  );

  test(
    'AC4 — a guardian address identical to the patient address is still imported as its own address',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, SCAN_PAGES, SCAN_PER_PAGE);
      test.skip(hits.length === 0, 'Import has not been run in apply mode on this environment.');

      const norm = (s: string) => (s || '').replace(/[\s,]+/g, '').replace(/,?D$/i, '').toLowerCase();
      const identical = hits.filter((p) => {
        const g = p.addresses.filter((a) => GUARDIAN_TYPES.includes(a.type));
        const c = p.addresses.filter((a) => a.type === 'care_home');
        return g.some((gg) => c.some((cc) => norm(gg.address) === norm(cc.address)));
      });

      test.skip(
        identical.length === 0,
        `No patient in the scanned range has a guardian address matching their Care Home address ` +
          `text, so AC4's edge case is not present in this sample to verify against.`,
      );

      // The point of AC4: matching street text must NOT have caused the row to be skipped or merged —
      // the guardian still gets its own typed, salutation-bearing address.
      for (const p of identical) {
        const guardian = p.addresses.find((a) => GUARDIAN_TYPES.includes(a.type));
        expect(
          guardian.isBilling,
          `patient ${p.patientId}: an identical-address guardian must still be imported as its own ` +
            `billing address (the salutation differs, which is the point)`,
        ).toBe(true);
        expect(
          p.addresses.filter((a) => a.type === 'care_home').length,
          `patient ${p.patientId}: the Care Home address must still be on file alongside it`,
        ).toBeGreaterThan(0);
      }
    },
  );

  test(
    'AC1/AC2/AC6/AC7 — preview mode, apply mode and the change report are console-command behaviour',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianImport'] },
    async () => {
      test.fixme(
        true,
        'AC1 (preview mode makes no changes and prints per-branch counts), AC2 (apply mode plus a ' +
          'downloadable change report), AC6 (conflict rows land in a "needs admin review" section) ' +
          'and AC7 (unknown patient IDs are skipped and listed) are all behaviours of the ' +
          '`--apply`-gated console command. There is no UI or API surface that runs the import, ' +
          'prints its preview, or serves its change report, so a browser suite cannot exercise them ' +
          '— the ticket assigns them to developer unit tests per branch plus a PM/QA console run. ' +
          'What the import must LEAVE BEHIND is covered by the tests above, against the real ' +
          'staging import output.',
      );
    },
  );
});
