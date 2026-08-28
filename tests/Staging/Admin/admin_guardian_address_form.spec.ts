import { test, expect } from '@playwright/test';
import { PatientAddressesPage } from '../../../Pages/admin/admin.patient-addresses.page';
import { waitForAuthState } from '../../../Pages/util/settle';

/**
 * RC 3.10 — Guardian Addresses on the Patient Form (#3188, epic #3187).
 *
 * Adds an Adresstyp selector to every patient address card and, for the three person types, an
 * Anrede dropdown plus a "Name der Person" field.
 *
 * Mutation policy: only the AC4 test saves the form, and it deletes the address it created before
 * finishing. Every other test asserts in-form state and navigates away without saving, so the
 * patient record is left exactly as found. The billing-exclusivity rule (AC5) is frontend-only, so
 * it is fully observable without saving at all.
 */
const QA_PATIENT_ID = 8124; // NikkiQA DingdingTest — the QA patient already used by the deceased specs

test.describe('Guardian Contacts — patient address form', () => {
  test.describe.configure({ mode: 'serial' }); // one shared patient record

  test(
    'AC1 — every address card offers an Adresstyp with the 4 options, and existing addresses are Pflegeheim',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianAddressForm'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(QA_PATIENT_ID);

      const section = await form.sectionText();
      expect(section, 'the address card must show an Adresstyp field').toContain('Adresstyp');

      // AC1: exactly the 4 documented options, in the localised German wording
      const options = await form.openTypeDropdown(0);
      for (const label of Object.values(PatientAddressesPage.TYPES)) {
        expect(options, `Adresstyp option "${label}"`).toContain(label);
      }
      expect(
        options.filter((o) => (Object.values(PatientAddressesPage.TYPES) as string[]).includes(o)).length,
        `expected exactly 4 Adresstyp options, got ${JSON.stringify(options)}`,
      ).toBe(4);
      await page.keyboard.press('Escape');

      // AC1: existing addresses default to Care Home — asserted in the form and at the data layer,
      // since the default is a migration on 8,555 existing rows, not a UI default.
      expect(await form.selectedType(0), 'existing address Adresstyp').toBe(
        PatientAddressesPage.TYPES.careHome,
      );
      const addresses = await form.apiAddresses(QA_PATIENT_ID);
      expect(addresses.length, 'patient addresses from the API').toBeGreaterThan(0);
      for (const a of addresses) {
        expect(
          PatientAddressesPage.API_TYPES,
          `address ${a.id} must carry a known type, got ${JSON.stringify(a.type)}`,
        ).toContain(a.type);
      }
      expect(
        addresses[0].type,
        'a pre-existing address must have been migrated to care_home',
      ).toBe('care_home');
    },
  );

  test(
    'AC2 — a Pflegeheim address shows the existing fields and no Anrede / Name der Person',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianAddressForm'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(QA_PATIENT_ID);

      expect(await form.selectedType(0)).toBe(PatientAddressesPage.TYPES.careHome);
      const card = await form.cardText(0);

      // the pre-existing fields are all still there, unchanged
      for (const field of PatientAddressesPage.ALWAYS_FIELDS) {
        expect(card, `Pflegeheim card must still show "${field}"`).toContain(field);
      }
      // and no person fields are shown
      for (const field of PatientAddressesPage.PERSON_FIELDS) {
        expect(card, `Pflegeheim card must NOT show "${field}"`).not.toContain(field);
      }
    },
  );

  test(
    'AC3 — each person type reveals Anrede (Herr/Frau) and Name der Person, and switching back hides them',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianAddressForm'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(QA_PATIENT_ID);

      for (const personType of PatientAddressesPage.PERSON_TYPES) {
        await form.setType(personType, 0);
        expect(await form.selectedType(0), `Adresstyp after selecting "${personType}"`).toBe(personType);

        const card = await form.cardText(0);
        for (const field of PatientAddressesPage.PERSON_FIELDS) {
          expect(card, `"${personType}" must reveal "${field}"`).toContain(field);
        }
        // AC3 is explicit that the existing fields stay visible and unchanged
        for (const field of PatientAddressesPage.ALWAYS_FIELDS) {
          expect(card, `"${personType}" must keep "${field}" visible`).toContain(field);
        }

        // the Anrede dropdown offers exactly Frau and Herr
        const anrede = await form.openAnredeDropdown();
        expect(anrede, 'Anrede must offer "Frau"').toContain('Frau');
        expect(anrede, 'Anrede must offer "Herr"').toContain('Herr');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);

        // AC3's note: the type is not a one-time choice — switching back must hide the fields again
        await form.setType(PatientAddressesPage.TYPES.careHome, 0);
        const backToCareHome = await form.cardText(0);
        for (const field of PatientAddressesPage.PERSON_FIELDS) {
          expect(
            backToCareHome,
            `switching "${personType}" back to Pflegeheim must hide "${field}" again`,
          ).not.toContain(field);
        }
      }

      // nothing is saved — leave the patient exactly as found
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    },
  );

  test(
    'AC4 — a new person-type address saves its type, salutation and name, and stays non-billing',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianAddressForm'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(QA_PATIENT_ID);

      const before = await form.apiAddresses(QA_PATIENT_ID);
      const billingBefore = before.find((a) => a.isBilling);
      expect(billingBefore, 'the patient must start with a billing address').toBeTruthy();

      const personName = `QA Betreuer ${Date.now()}`;
      await form.addAddress();
      const cardIndex = (await form.cardCount()) - 1;
      expect(cardIndex, 'the new card index').toBeGreaterThan(0);

      await form.setType(PatientAddressesPage.TYPES.relative, cardIndex);
      await form.setAnrede('Frau');
      // occurrence 0: the new card is the only person-type card, so it owns the only such label
      await form.fillPersonName(personName, 0);
      await form.fillByPlaceholder('Straße, Stadt, PLZ', 'Jahnstr. 27, 15366 Neuenhagen', cardIndex);

      // AC4: adding a person-type address must never grab the billing flag on its own
      const statesBeforeSave = await form.billingStates();
      expect(
        statesBeforeSave[cardIndex].checked,
        'a newly added person-type address must have Rechnung OFF by default',
      ).toBe(false);
      expect(
        statesBeforeSave.filter((s) => s.checked).length,
        'exactly one address may be billing before saving',
      ).toBe(1);

      await form.save();

      // AC4: type, salutation and person name all persisted, and the address is not billing
      const after = await form.apiAddresses(QA_PATIENT_ID);
      expect(after.length, `a new address must have been saved (${before.length} → ${after.length})`).toBe(
        before.length + 1,
      );

      // Identified by its person name, NOT by diffing ids: saving the form replaces the whole
      // address collection, so every row comes back with a fresh id and an id-diff would report the
      // untouched Care Home address as "the new one".
      const created = after.find((a) => a.personName === personName);
      expect(
        created,
        `the saved address must be findable by its person name; got ${JSON.stringify(after)}`,
      ).toBeTruthy();
      expect(created.type, 'saved Adresstyp').toBe('relative');
      expect(created.salutation, 'saved Anrede').toBe('Frau');
      expect(created.personName, 'saved "Name der Person"').toBe(personName);
      expect(created.isBilling, 'a new person-type address must not become billing on its own').toBe(false);

      // and the billing flag has not moved — the Care Home address is still the billing one
      const billingAfter = after.filter((a) => a.isBilling);
      expect(billingAfter.length, 'exactly one billing address after saving').toBe(1);
      expect(
        billingAfter[0].type,
        `adding a person-type address must not move the billing flag off the Care Home address ` +
          `(it was "${billingBefore.label ?? billingBefore.id}")`,
      ).toBe(billingBefore.type);

      // ---- cleanup: remove the address this test created (it is non-billing, so deletable)
      await form.openPatientForm(QA_PATIENT_ID);
      const deleted = await form.deleteAddress((await form.cardCount()) - 1);
      if (deleted) {
        await form.save();
        const cleaned = await form.apiAddresses(QA_PATIENT_ID);
        expect(
          cleaned.length,
          'cleanup: the QA address must be removed so the patient is left as found',
        ).toBe(before.length);
      } else {
        // Never leave silently: an un-cleaned QA address would confuse the next run and any human
        // looking at this patient.
        console.warn(
          `CLEANUP FAILED: could not delete the QA address "${personName}" on patient ${QA_PATIENT_ID}. ` +
            `Remove it manually via the patient form.`,
        );
        expect(deleted, `cleanup: the QA address "${personName}" must be deletable`).toBe(true);
      }
    },
  );

  test(
    'AC5 — turning on Rechnung for another address turns the previous one off, keeping exactly one billing',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianAddressForm'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(QA_PATIENT_ID);

      // A second address is needed to have anything to switch to. It is never saved.
      await form.addAddress();
      await form.setType(PatientAddressesPage.TYPES.legalGuardian, (await form.cardCount()) - 1);

      const before = await form.billingStates();
      expect(before.length, 'two address cards').toBeGreaterThanOrEqual(2);
      expect(
        before.filter((s) => s.checked).length,
        `exactly one address starts as billing, got ${JSON.stringify(before)}`,
      ).toBe(1);
      const previousBillingIndex = before.findIndex((s) => s.checked);
      const target = before.findIndex((s, i) => !s.checked && i !== previousBillingIndex);
      expect(target, 'a non-billing address to switch to').toBeGreaterThanOrEqual(0);

      // the billing address's own switch is disabled — it can only be displaced by another address
      expect(
        before[previousBillingIndex].disabled,
        'the current billing address switch is disabled so it cannot be turned off directly',
      ).toBe(true);

      await form.enableBilling(target);

      const after = await form.billingStates();
      expect(
        after[target].checked,
        `Rechnung must be ON for the address that was just switched on (${JSON.stringify(after)})`,
      ).toBe(true);
      expect(
        after[previousBillingIndex].checked,
        `the previous billing address must have turned itself OFF (${JSON.stringify(after)})`,
      ).toBe(false);
      expect(
        after.filter((s) => s.checked).length,
        `exactly one address may be billing at a time, got ${JSON.stringify(after)}`,
      ).toBe(1);
      expect(
        after[target].disabled,
        'the new billing address switch becomes the disabled one',
      ).toBe(true);

      // discard: navigate away without saving so the patient keeps its original billing address
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await waitForAuthState(page);
      const persisted = await form.apiAddresses(QA_PATIENT_ID);
      expect(
        persisted.filter((a) => a.isBilling).length,
        'the unsaved billing switch must not have persisted',
      ).toBe(1);
    },
  );
});
