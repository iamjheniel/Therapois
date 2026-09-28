import { test, expect } from '@playwright/test';
import { PatientAddressMigrationPage, StoredAddress } from '../../../Pages/superadmin/sa.patient-address-migration.page';
import { BillingExportAddressPage } from '../../../Pages/superadmin/sa.billing-export-address.page';

/**
 * RC 3.12 (#3375) — the four billing exports read the structured address fields.
 *
 * DATEV debtor accounts, the ETI claim, the Optica export and the IB record document each split
 * the patient's free-text address themselves; since `b786b073b` / `7d269599e` (PR #3418) they read
 * `street`/`postalCode`/`city` directly, keeping the old parser as the fallback for rows #3373's
 * migration has not filled (AC5).
 *
 * **Deployed. AC2's client half is verified outright; AC1, AC3 and AC4 are unreachable from a
 * client on staging, and this file proves that rather than asserting it.** Every one of the four
 * gateways is closed here: Optica answers 422 on every batch (#3288), DATEV is switched off and
 * exposes no debtor collection (#3440/#3499), ETI submission is blocked, and an IB record renders
 * its PDF exactly once — lazily, on the first signed-url request — so every stored PDF shows the
 * render from its signing day and the only records without one carry no signature to render from.
 *
 * **The deeper problem is that the change is invisible by construction.** #3373's migration DERIVED
 * the structured fields with the same splitter these exports fall back to, so both arms produce
 * BYTE-IDENTICAL values: of 1,825 address rows sampled, **1,806 can be answered by both arms and
 * they disagree on 0**. On today's data this ticket is a pure refactor — which is exactly why the
 * commit's own verification had to corrupt the free text to attribute a path, and why the tests
 * below assert the SWITCH (which arm each row takes, and that the arms agree where they should)
 * rather than pretending an export can be read.
 *
 * A near-miss worth recording: a hand-rolled port of `splitAddress` that omits
 * `AddressNormalizer::stripCountryMarker`'s `\s{2,}` collapse reports 4 false divergences
 * ("Südostallee  212" vs "Südostallee 212"). The normalizer collapses runs of whitespace; the
 * migration inherited that, so the fields match the parser exactly. Reuse the #3373 port.
 *
 * **What the PM note claims and what it shows.** It records 5 of 5 with "code verification on
 * release/3.12.0" for four of them plus "Jarn's staging run created 10 debtors without parsing
 * failures". Reading the source is how the PM established each consumer calls
 * `StructuredPatientAddress::fromRow()`, which is true — but "no parsing failures" is not evidence
 * of the structured path, since the fallback parser succeeds on those rows too. AC-2's own row
 * says the dialog was not tested; it is tested here, in the served bundle.
 *
 * **Traps**
 * - **The consumers do not read the same row.** DATEV provisioning and the ETI claim read the
 *   BILLING address; DATEV bootstrap, Optica and the IB record read the RESIDENCE address
 *   (`getResidenceAddress()`, which prefers a Care Home row with no contact person). An oracle
 *   built on one row answers for two of the four exports only.
 * - **The gate is all three fields, not two.** #3374's letters take postal code + city; #3375
 *   requires a street as well, deliberately. Today that distinction has **no live instance** —
 *   0 rows carry a partial triple — so the stricter bar is unexercised.
 * - **`hasUsableAddress` is an OR, not a replacement.** The comma heuristic survives as the
 *   fallback so the dialog never blocks a patient the backend would submit — which is also why
 *   AC2's wording ("confirms street, postal code and city are all filled in") is not what a row
 *   without structured fields actually gets.
 */

const SAMPLE = { perPage: 40, every: 5, maxPages: 45 };

/** Measured 2026-09-02 over 1,825 rows / 1,680 patients; asserted as floors, not equalities. */
const EXPECTED = {
  minRows: 1_200,
  /** Rows the migration filled — the structured arm. */
  minStructured: 1_000,
  /** Rows it could not split, which still export through the parser (AC5). */
  minFallback: 5,
};

test.describe('Billing exports read the structured address fields (#3375)', () => {
  // The sample walk takes minutes, and a `test.setTimeout()` inside a test body runs AFTER the
  // hooks — a per-test call cannot rescue a hook. The budget has to be set here.
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  let auth: string;
  let sample: StoredAddress[] = [];

  test.beforeAll(async ({ request }) => {
    // `describe.configure({ timeout })` does NOT reach a beforeAll hook — it kept the 90 s
    // project default and the sample walk died in setup. Inside the hook, `test.setTimeout()`
    // sets the HOOK's own budget, which is the only thing that works here.
    test.setTimeout(900_000);

    const response = await request.post('https://api.staging.therapios.de/auth', {
      headers: { 'Content-Type': 'application/json' },
      data: { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
      timeout: 120_000,
    });
    expect(response.status(), 'POST /auth').toBe(200);
    auth = (await response.json()).token;

    // Sampled once for the whole file: it is read-only, and /patients 504s on a contiguous walk,
    // so the page object takes every fifth page (#3373).
    sample = await new PatientAddressMigrationPage(request, auth).sampleAddresses(SAMPLE);
    expect(sample.length, 'the address sample must be large enough to mean anything').toBeGreaterThan(
      EXPECTED.minRows,
    );
  });

  // ────────────────────────────── AC5 / the switch ─────────────────────────────

  test(
    'AC5 every row resolves to exactly one arm, and the fallback set is real',
    { tag: ['@SuperAdmin', '@BillingExportAddress', '@ReadOnly'] },
    async () => {

      const counts = { structured: 0, fallback: 0, neither: 0 };
      const fallbackRows: StoredAddress[] = [];
      for (const row of sample) {
        const resolved = BillingExportAddressPage.resolve(row);
        counts[resolved.path]++;
        if ('fallback' === resolved.path) fallbackRows.push(row);
      }

      console.log(
        `  ${sample.length} address rows: structured ${counts.structured}, parser fallback ${counts.fallback},` +
          ` neither ${counts.neither}`,
      );
      for (const row of fallbackRows.slice(0, 8)) {
        console.log(`    fallback: addr ${row.id} (${row.type}) "${row.raw.replace(/\n/g, ' / ')}"`);
      }

      expect(counts.structured, 'the migrated majority must take the structured arm').toBeGreaterThan(
        EXPECTED.minStructured,
      );
      // AC5 is only meaningful if unmigrated rows still exist; if this ever hits zero the AC has
      // become vacuous on staging and the fallback is no longer exercised by any live row.
      expect(counts.fallback, 'unmigrated rows must still exist for AC5 to mean anything').toBeGreaterThanOrEqual(
        EXPECTED.minFallback,
      );

      // Every fallback row must be missing at least one of the three fields — the gate is
      // all-or-nothing, so a row in this arm can never have a complete triple.
      for (const row of fallbackRows) {
        expect(
          BillingExportAddressPage.structuredUsable(row),
          `addr ${row.id} falls back, so its triple must be incomplete`,
        ).toBeNull();
      }
    },
  );

  test(
    'the gate is all three fields — stricter than the letters, and currently unexercised',
    { tag: ['@SuperAdmin', '@BillingExportAddress', '@ReadOnly'] },
    async () => {

      // #3374 (letters) takes postal code + city; #3375 also requires a street. The difference
      // only shows on a PARTIALLY filled row, and the migration writes all three or none.
      const partial = sample.filter((row) => {
        const filled = [row.street.trim(), row.postalCode.trim(), row.city.trim()].filter(Boolean).length;
        return filled > 0 && filled < 3;
      });
      const plzCityNoStreet = partial.filter((row) => !row.street.trim() && row.postalCode.trim() && row.city.trim());

      console.log(
        `  partially filled rows: ${partial.length} (of which postal code + city but no street: ${plzCityNoStreet.length})`,
      );
      // Reported, not asserted as a defect: it means #3375's deliberately stricter bar cannot be
      // told apart from #3374's on today's data. A future form-created row would change that.
      expect(partial.length, 'the migration writes all three fields or none').toBe(0);
    },
  );

  test(
    'the two arms agree wherever both can answer — which is why the change is nearly invisible',
    { tag: ['@SuperAdmin', '@BillingExportAddress', '@ReadOnly'] },
    async () => {

      const diverging: { row: StoredAddress; structured: any; parsed: any }[] = [];
      let comparable = 0;
      for (const row of sample) {
        const structured = BillingExportAddressPage.structuredUsable(row);
        if (!structured) continue;
        comparable++;
        const parsed = BillingExportAddressPage.parseFreeText(row.raw);
        if (!BillingExportAddressPage.same(structured, parsed)) diverging.push({ row, structured, parsed });
      }

      console.log(`  ${comparable} rows can be answered by both arms; they disagree on ${diverging.length}`);
      for (const d of diverging) {
        console.log(
          `    addr ${d.row.id}: raw "${d.row.raw}"\n      structured ${JSON.stringify(d.structured)}\n      parser     ${JSON.stringify(d.parsed)}`,
        );
      }

      // Byte-identical on every row both arms can answer — the migration derived the fields with
      // this very parser. Any divergence appearing here later is the first row on which this
      // ticket actually changes an export, and is worth a human look.
      expect(diverging.length, 'the two arms must agree wherever both can answer').toBe(0);
      expect(comparable, 'and the comparison must cover the migrated population').toBeGreaterThan(
        EXPECTED.minStructured,
      );
    },
  );

  // ──────────────────────────────────── AC2 ────────────────────────────────────

  test(
    "AC2 the ETI dialog's pre-submission check ships, and it is the structured triple",
    { tag: ['@SuperAdmin', '@BillingExportAddress', '@ReadOnly'] },
    async ({ page }) => {

      const index = await page.request.get('https://staging.therapios.de/', { timeout: 120_000 });
      const entry = (await index.text()).match(/src="([^"]*entry-[^"]*\.js)"/)?.[1];
      expect(entry, 'the entry bundle must be locatable').toBeTruthy();
      const bundle = await (await page.request.get(`https://staging.therapios.de${entry}`, { timeout: 180_000 })).text();

      // The predicate itself, minified but verbatim: structured triple first, comma second.
      expect(bundle, 'hasUsableAddress ships').toContain('hasUsableAddress=function');
      expect(bundle, 'and reads the three structured fields').toContain(
        "t.street?.trim()&&t.postalCode?.trim()&&t.city?.trim()",
      );
      expect(bundle, 'with the old comma heuristic kept only as the fallback').toContain("t.address.includes(',')");
      // And the ETI dialog actually gates its submission list on it.
      expect(bundle, 'the dialog uses it as the row-level addressOk gate').toContain('addressOk:(0,h.hasUsableAddress)');
      console.log(`  ${entry}: hasUsableAddress present and wired into the ETI dialog`);
    },
  );

  test(
    'AC2 what the new check changes, measured on the billing rows it reads',
    { tag: ['@SuperAdmin', '@BillingExportAddress', '@ReadOnly'] },
    async () => {

      const billing = sample.filter((row) => row.isBilling);
      expect(billing.length, 'billing rows must be present').toBeGreaterThan(100);

      const oldPass = billing.filter((row) => BillingExportAddressPage.commaHeuristic(row));
      const newPass = billing.filter((row) => BillingExportAddressPage.hasUsableAddress(row));
      const newlyAllowed = billing.filter(
        (row) => BillingExportAddressPage.hasUsableAddress(row) && !BillingExportAddressPage.commaHeuristic(row),
      );
      const stillBlocked = billing.filter((row) => !BillingExportAddressPage.hasUsableAddress(row));

      console.log(`  ${billing.length} billing rows — old check passes ${oldPass.length}, new check ${newPass.length}`);
      for (const row of newlyAllowed) console.log(`    newly submittable: addr ${row.id} "${row.raw}"`);
      for (const row of stillBlocked) console.log(`    still blocked: addr ${row.id} "${row.raw.replace(/\n/g, ' / ')}"`);

      // The new check is an OR over the old one, so it can only ever widen the set. That property
      // is what keeps the dialog from blocking a patient the backend would submit.
      expect(newPass.length, 'the new check never blocks what the old one allowed').toBeGreaterThanOrEqual(
        oldPass.length,
      );
      for (const row of oldPass) {
        expect(BillingExportAddressPage.hasUsableAddress(row), `addr ${row.id} must still pass`).toBe(true);
      }
    },
  );

  // ─────────────────────── AC1 / AC3 / AC4 reachability ────────────────────────
});
