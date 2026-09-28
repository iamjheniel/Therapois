import { test, expect } from '@playwright/test';
import {
  PatientAddressMigrationPage,
  StoredAddress,
  carriesCountryMarker,
  split,
} from '../../../Pages/superadmin/sa.patient-address-migration.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — the one-time split of patient addresses into structured fields (#3373).
 *
 * Free-text `address` → `street` / `postalCode` / `city`, the #3370 country marker stripped on the
 * way, the original text kept as a fallback, and a new billing check
 * (`billing_address_complete`, id 53) that blocks a billing document when the postal code and city
 * are empty. **Run on staging 2026-08-29; all seven ACs verified here, with one gap in the review
 * list.**
 *
 * **A migration is verified by re-deriving it, not by sampling it.** The split rule is deterministic,
 * so the page object carries a faithful port of `PatientAddressSplitter::split()` +
 * `AddressNormalizer::stripCountryMarker()` and uses it as an INDEPENDENT ORACLE: for every stored
 * row, compute what the fields should hold and compare. **2,345 addresses re-derived, 0 mismatches**
 * — which settles AC2, AC3, AC4 and AC5 together rather than one patient at a time.
 *
 * **Two things that would have produced false findings:**
 * - A loose "leftover marker" check (`\bD\b`) flags `Hönower Str. 53 d` and `An de Geest 22`. Both
 *   are correct: the normalizer's lookbehinds are `^`, `,` and `,\s`, deliberately not a bare space,
 *   so a house-number suffix and a Low German street name survive. The detector here mirrors those
 *   anchors.
 * - Four sampled rows carry NO free text at all. That is not the migration destroying the fallback —
 *   its query is `WHERE address IS NOT NULL AND TRIM(address) <> ''`, so those rows were never read.
 *   Three are guardian contact rows (#3187) that `getResidenceAddress()` correctly steps over. The
 *   fourth is the finding below.
 *
 * **Finding** → `fixme`: a text-less address is invisible to the migration and therefore absent from
 * the review list, yet the new check still blocks on it.
 *
 * **Read-only — every request is a GET.** `/patients` is the expensive part: ~14 KB per patient, no
 * `/patient_addresses` collection, no `properties[]` filter, and a straight walk 504s — so the
 * sample is taken from pages spread across the id space.
 */

/** AC4 + AC7 + AC3 in one row: no house number, split anyway, marker stripped, not blocked. */
const NO_HOUSE_NUMBER = { vo: '3745-6', patientNumber: 3745, raw: 'An der Dahmebrücke, 15754 Heidesee, D' };
/** AC5 + AC6: unsplittable, fields left empty, raw preserved, billing blocked. */
const UNSPLITTABLE = { vo: '964201-4', patientNumber: 964201, raw: '123 Test, Berlin' };
/** Enough of the population for the oracle comparison to mean something. */
const MINIMUM_SAMPLE = 1_500;

test.describe('Patient addresses split into structured fields', () => {
  let auth: string;
  let sample: StoredAddress[];

  test.beforeAll(async ({ request }) => {
    const response = await request.post('https://api.staging.therapios.de/auth', {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    expect(response.status()).toBe(200);
    auth = (await response.json()).token;
  });

  test(
    'AC2/AC3/AC4/AC5 — every stored row matches an independent re-derivation of the split',
    { tag: ['@SuperAdmin', '@PatientAddressMigration', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const addresses = new PatientAddressMigrationPage(request, auth);
      sample = await addresses.sampleAddresses();
      expect(sample.length, 'the sample must be large enough to be worth the name').toBeGreaterThanOrEqual(MINIMUM_SAMPLE);

      const withText = sample.filter((row) => row.raw !== '');
      const outcomes = { clean: 0, no_house_number: 0, unsplittable: 0 };
      const mismatches: string[] = [];

      for (const row of withText) {
        const expected = split(row.raw);
        outcomes[expected.outcome]++;
        // AC5: an unsplittable row keeps its fields EMPTY — the migration writes nothing at all.
        const want =
          expected.outcome === 'unsplittable'
            ? { street: '', postalCode: '', city: '' }
            : { street: expected.street, postalCode: expected.postalCode, city: expected.city };
        if (row.street !== want.street || row.postalCode !== want.postalCode || row.city !== want.city) {
          mismatches.push(
            `addr ${row.id} raw ${JSON.stringify(row.raw)} — expected ${JSON.stringify(want)}, stored ` +
              `${JSON.stringify({ street: row.street, postalCode: row.postalCode, city: row.city })}`,
          );
        }
      }

      console.log(`${withText.length} addresses re-derived | outcomes ${JSON.stringify(outcomes)}`);
      console.log(`mismatches: ${mismatches.length}`);
      for (const line of mismatches.slice(0, 10)) console.log(`   ${line}`);
      expect(mismatches.slice(0, 10), 'every stored split must equal the independent re-derivation').toEqual([]);

      // AC4 must actually be exercised by the sample, or the no-house-number branch is untested.
      expect(outcomes.no_house_number, 'the sample must contain flagged-but-usable rows').toBeGreaterThan(0);
      expect(outcomes.unsplittable, 'and rows the splitter refuses').toBeGreaterThan(0);

      // AC3, judged with the normalizer's own anchors — see the page object on why a loose check lies.
      const leftovers = sample.filter((row) => carriesCountryMarker(row.street) || carriesCountryMarker(row.city));
      console.log(`structured fields still carrying a country marker: ${leftovers.length}`);
      expect(leftovers.map((row) => `${row.id}:${row.street}|${row.city}`), 'no marker may survive into a structured field').toEqual([]);

      // #3372 puts Assert\Regex(/^\d{5}$/) on the column; the migration must not write past it.
      const badPostalCodes = sample.filter((row) => row.postalCode !== '' && !/^\d{5}$/.test(row.postalCode));
      expect(badPostalCodes.map((row) => `${row.id}:${row.postalCode}`), 'every written postal code is 5 digits').toEqual([]);
    },
  );

  test(
    'AC4 + AC7 — a street with no house number is split, marker-cleaned, and still billable',
    { tag: ['@SuperAdmin', '@PatientAddressMigration', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const addresses = new PatientAddressMigrationPage(request, auth);
      const vo = await addresses.prescription(NO_HOUSE_NUMBER.vo);
      expect(vo, `${NO_HOUSE_NUMBER.vo} must exist`).not.toBeNull();

      const rows = await addresses.addressesOfPatient(vo!.patientId);
      const residence = PatientAddressMigrationPage.residenceAddress(rows)!;
      console.log(`patient ${NO_HOUSE_NUMBER.patientNumber}: raw ${JSON.stringify(residence.raw)} -> ` +
        `${JSON.stringify([residence.street, residence.postalCode, residence.city])}`);

      expect(residence.raw, 'AC2: the original text is kept untouched, marker and all').toBe(NO_HOUSE_NUMBER.raw);
      expect(split(residence.raw).outcome, 'this fixture is the no-house-number class').toBe('no_house_number');
      expect(residence.street, 'AC4: split anyway, not skipped').not.toBe('');
      expect(residence.postalCode).toBe('15754');
      expect(residence.city).toBe('Heidesee');
      // AC3 on the same row: the ", D" in the raw text never reaches the structured fields.
      expect(carriesCountryMarker(residence.street) || carriesCountryMarker(residence.city)).toBe(false);

      // AC7: usable, so the new check must not block it — asserted on the stored verdict.
      expect(
        await addresses.verdicts(vo!.id, PatientAddressMigrationPage.CHECK.id),
        'AC7: a missing house number must not block billing',
      ).toEqual([true]);
      expect(PatientAddressMigrationPage.billingAddressComplete(rows), 'and the rule agrees').toBe(true);
    },
  );

  test(
    'AC5 + AC6 — an unsplittable address leaves the fields empty and blocks billing',
    { tag: ['@SuperAdmin', '@PatientAddressMigration', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const addresses = new PatientAddressMigrationPage(request, auth);
      const vo = await addresses.prescription(UNSPLITTABLE.vo);
      expect(vo, `${UNSPLITTABLE.vo} must exist`).not.toBeNull();

      const rows = await addresses.addressesOfPatient(vo!.patientId);
      const residence = PatientAddressMigrationPage.residenceAddress(rows)!;
      console.log(`patient ${UNSPLITTABLE.patientNumber}: raw ${JSON.stringify(residence.raw)} -> ` +
        `${JSON.stringify([residence.street, residence.postalCode, residence.city])}`);

      expect(residence.raw, 'AC5: the original text survives for manual correction').toBe(UNSPLITTABLE.raw);
      expect(split(residence.raw).outcome, 'no 5-digit postal code, so nothing to anchor on').toBe('unsplittable');
      expect([residence.street, residence.postalCode, residence.city], 'AC5: nothing is guessed').toEqual(['', '', '']);

      expect(
        await addresses.verdicts(vo!.id, PatientAddressMigrationPage.CHECK.id),
        'AC6: an address with no postal code and city blocks the billing document',
      ).toEqual([false]);
      expect(PatientAddressMigrationPage.billingAddressComplete(rows), 'and the rule agrees').toBe(false);
    },
  );

  test(
    'AC6 — the new check is registered as a billing validation',
    { tag: ['@SuperAdmin', '@PatientAddressMigration', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const addresses = new PatientAddressMigrationPage(request, auth);
      const catalogue = await addresses.validationCatalogue();
      const check = catalogue.find((row) => row.description === PatientAddressMigrationPage.CHECK.description);
      console.log(`catalogue: ${catalogue.length} checks | billing timing: ${catalogue.filter((r) => r.timing === 'billing').length}`);
      console.log(`billing_address_complete: ${JSON.stringify(check)}`);

      expect(check, 'the check must exist in the shared catalogue, not as a special case').toBeTruthy();
      expect(check!.id).toBe(PatientAddressMigrationPage.CHECK.id);
      expect(check!.timing, 'it runs with the billing checks, not at VO creation').toBe('billing');
    },
  );

  test(
    'The review list covers every address the new check can block',
    { tag: ['@SuperAdmin', '@PatientAddressMigration', '@ReadOnly'] },
    async ({ request }) => {
      test.fixme(
        true,
        'A text-less address is invisible to the migration but not to the check. The migration reads ' +
          '`WHERE address IS NOT NULL AND TRIM(address) <> \'\'`, so a patient_address row with no free ' +
          'text is never counted, never split, and — the part that matters — never appears on the review ' +
          'list AC1/AC5 promise for everything that could not be split. `checkBillingAddressComplete()` ' +
          'has no such exclusion: it reads whatever `getResidenceAddress()` returns and fails when its ' +
          'postal code and city are empty. ' +
          'Measured on a 2,349-address sample: 4 rows carry no free text. Three are guardian contact rows ' +
          '(#3187) sitting beside a real Care Home address, and `getResidenceAddress()` correctly steps ' +
          'over them — it prefers a Care Home row with NO contact person — so those patients still pass. ' +
          'The fourth is a genuine orphan: patient 875499, address 9727, its ONLY address, ' +
          'type care_home, isBilling true, no contact person, no free text, no structured fields. For ' +
          'that patient the check fails and the admin gets a blocked billing document with nothing on ' +
          'any review list saying which address to fix. ' +
          'Roughly 1 in 2,349 sampled, so a handful across the population — cheap to close by widening ' +
          'the review query to report text-less rows as their own class rather than skipping them. ' +
          'Worth deciding before the production run, since that run produces the list the PM signs off.',
      );

      const addresses = new PatientAddressMigrationPage(request, auth);
      const rows = sample ?? (await addresses.sampleAddresses());
      const textless = rows.filter((row) => row.raw === '');
      console.log(`addresses with no free text at all: ${textless.length}`);

      const blocked: string[] = [];
      for (const row of textless) {
        const all = await addresses.addressesOfPatient(row.patientId);
        if (!PatientAddressMigrationPage.billingAddressComplete(all)) {
          blocked.push(`patient ${row.patientNumber} via address ${row.id} (${row.type}, label ${JSON.stringify(row.label)})`);
        }
      }
      console.log(`of those, patients the billing check would block: ${blocked.length}`);
      for (const line of blocked) console.log(`   ${line}`);
      expect(blocked, 'nothing may block billing without appearing on the migration review list').toEqual([]);
    },
  );
});
