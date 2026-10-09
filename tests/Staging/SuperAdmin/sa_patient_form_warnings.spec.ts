import { test, expect } from '../../fixtures/session';
import {
  PatientFormWarningsPage,
  NUMBERS,
  DUPLICATE_ROWS,
  NORMALISATION_ROWS,
  BIRTH_DATE,
} from '../../../Pages/superadmin/sa.patient-form-warnings.page';

/**
 * RC 3.15 **#3806** (a warning when a GKV insurance number looks wrong, PR #3833) and
 * **#3807** (the duplicate warning also matches on last name + birth date, PR #3831).
 *
 * Tested in one file because they share `PatientForm.tsx`, surface in the same three
 * places, and #3810's own notes point out that all three messages can appear together
 * on that form.
 *
 * **Both deployed; every AC verified that can be, 9 passed, 0 `fixme`. READ-ONLY — no
 * patient is created.**
 *
 * **WHY TWO TICKETS ABOUT CREATING PATIENTS NEED NO PATIENT:** both checks are READS the
 * form issues while someone types, so each AC table is driven directly against the
 * endpoint the screen itself calls (#3576's technique) —
 * `GET /patients/insurance-number-check` and `GET /patients/duplicate-check`.
 *
 * **AND #3806's CLIENT HALF IS PORTED FROM THE DEPLOYED BUNDLE, not from the AC.** The
 * rule survives minification verbatim, so the truth table runs against the shipped
 * source rather than against my reading of the ticket — including the precedence clause
 * `null !== serverMatch ? serverMatch`, which IS "the BSNR or LANR warning replaces the
 * format warning".
 *
 * What is NOT covered here, and why, is in
 * `docs/manual-test-3806-3807-patient-form-warnings.md`: #3806 AC4 and #3807 AC5 both
 * require actually saving a patient.
 */

test.describe('#3806 + #3807 patient-form warnings', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: PatientFormWarningsPage;

  test.beforeEach(async ({ request }) => {
    api = new PatientFormWarningsPage(request);
    await api.authenticate();
  });

  test(
    'both are deployed: the two endpoints answer, and the bundle carries every new string',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // The API half: a brand-new route answering at all, against a 404 control — which
      // is what separates "deployed" from "the path happens to 200 for another reason".
      expect((await api.get(`/patients/insurance-number-check?number=${NUMBERS.mainBsnr}`)).status).toBe(200);
      expect((await api.get('/patients/duplicate-check?firstName=Anna&lastName=Testmüller&lenient=1')).status).toBe(200);
      expect((await api.get('/patients/zzz-not-a-route?number=1')).status, 'the 404 control').toBe(404);

      // The frontend half, which `/status` cannot answer for at all (#3705). Counted in
      // BOTH escape forms, because the bundle stores non-ASCII as \xNN / \uXXXX and a
      // plain search for a German string returns 0, reading like "never shipped" (#3873).
      const strings: Record<string, number> = {};
      for (const literal of [
        'GKV-Versichertennummern bestehen aus einem Buchstaben und 9 Ziffern',
        'Diese Nummer ist die BSNR einer Praxis',
        'Diese Nummer ist die LANR eines Arztes',
        'insurance-number-check',
        'match_type_last_name_dob',
        'Nachname + Geburtsdatum',
      ]) {
        strings[literal.slice(0, 40)] = await api.occurrences(literal);
        expect(strings[literal.slice(0, 40)], `the bundle ships "${literal.slice(0, 40)}"`).toBeGreaterThan(0);
      }

      // A control that makes those counts mean something: the PRE-existing match type is
      // still there, so the new one was added rather than renamed over it.
      expect(await api.occurrences('match_type_name_dob'), 'the existing match type survives').toBeGreaterThan(0);

      console.log(`[#3806/#3807] bundle strings: ${JSON.stringify(strings)}`);
    },
  );

  test(
    '#3806 AC1 + AC2 — the whole truth table, run against the rule as the bundle ships it',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      const rule = await api.warningRule();

      // AC1's table. The third column is what the server lookup answered, which for these
      // inputs is `null` — only the BSNR/LANR rows reach it, and those are the next test.
      const table: [string, string, 'format' | null][] = [
        ['A123456789', 'one letter then 9 digits', null],
        ['a123456789', 'lower-case letter', null],
        ['1234567890', '10 digits, no letter', 'format'],
        ['A12345678', 'one letter then 8 digits', 'format'],
        ['A 123456789', 'a space inside', 'format'],
        ['', 'empty', null],
        ['  A123456789  ', 'spaces around a valid number are ignored', null],
        ['   ', 'only spaces is empty', null],
      ];
      for (const [value, label, expected] of table) {
        expect(rule.warn(value, 'public', null), `GKV ${JSON.stringify(value)} (${label})`).toBe(expected);
      }

      // AC2 — every other insurance type, and the empty type, warn for nothing at all.
      for (const insuranceType of ['private', 'privat_basis', 'accident', '', 'public']) {
        const warned = rule.warn('1234567890', insuranceType, null);
        if (insuranceType === 'public') expect(warned, 'the GKV control still warns').toBe('format');
        else expect(warned, `${insuranceType || '(empty)'} never warns`).toBeNull();
      }
      // ...not even for a BSNR or a LANR, which is the half a type gate could miss.
      for (const insuranceType of ['private', 'privat_basis', 'accident', '']) {
        expect(rule.warn(NUMBERS.mainBsnr, insuranceType, 'bsnr'), `${insuranceType || '(empty)'} + BSNR`).toBeNull();
        expect(rule.warn(NUMBERS.lanr, insuranceType, 'lanr'), `${insuranceType || '(empty)'} + LANR`).toBeNull();
      }

      // AC1's "one warning at a time": the server answer REPLACES the format warning.
      // 723253500 is nine digits, so it fails the format test AND is a BSNR — exactly the
      // collision the precedence rule exists for.
      expect(rule.warn(NUMBERS.mainBsnr, 'public', null), 'without the lookup it is a format failure').toBe('format');
      expect(rule.warn(NUMBERS.mainBsnr, 'public', 'bsnr'), 'with it, BSNR replaces format').toBe('bsnr');
      expect(rule.warn(NUMBERS.lanr, 'public', 'lanr'), 'and LANR likewise').toBe('lanr');

      // The lookup is only ever asked for exactly nine digits, which is why a correct
      // number costs no request at all.
      expect(rule.looksUp('A123456789', 'public'), 'a valid number is never looked up').toBe(false);
      expect(rule.looksUp('1234567890', 'public'), 'ten digits are not looked up either').toBe(false);
      expect(rule.looksUp(NUMBERS.mainBsnr, 'public'), 'nine digits are').toBe(true);
      expect(rule.looksUp(`  ${NUMBERS.mainBsnr}  `, 'public'), 'after trimming').toBe(true);
      expect(rule.looksUp(NUMBERS.mainBsnr, 'private'), 'and never for a non-GKV patient').toBe(false);

      console.log(`[#3806] shipped rule: ${rule.source.replace(/\s+/g, ' ').slice(0, 190)}`);
    },
  );

  test(
    '#3806 AC1 — the BSNR and LANR rows, live, with the fixtures proven unambiguous',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // The filters that would confirm these fixtures are IGNORED, so they are walked —
      // which also settles something a filter could not: that each number is a BSNR or a
      // LANR but never both. A number matching both would leave the expected warning
      // undefined by the AC.
      const bsnrRows = await api.walk('/practice_bsnrs');
      const doctors = await api.walk('/doctors');
      expect(bsnrRows.length, 'the BSNR table was walked').toBeGreaterThan(1_000);

      const bsnrFor = (n: string) => bsnrRows.filter((b) => String(b.number ?? '').trim() === n);
      const lanrFor = (n: string) => doctors.filter((d) => String(d.doctorId ?? '').trim() === n);

      expect(bsnrFor(NUMBERS.mainBsnr).some((b) => b.isMain === true), 'a MAIN BSNR').toBe(true);
      expect(bsnrFor(NUMBERS.additionalBsnr).some((b) => b.isMain === false), 'an ADDITIONAL BSNR (AC1 says both count)').toBe(true);
      expect(bsnrFor(NUMBERS.ticketBsnr).length, "the ticket's own example is a BSNR").toBeGreaterThan(0);
      expect(lanrFor(NUMBERS.lanr).length, 'the LANR belongs to a doctor').toBe(1);

      expect(lanrFor(NUMBERS.mainBsnr).length, 'the BSNR fixture is not also a LANR').toBe(0);
      expect(bsnrFor(NUMBERS.lanr).length, 'the LANR fixture is not also a BSNR').toBe(0);

      // Now the endpoint itself, including AC1's "spaces are ignored".
      expect(await api.insuranceNumberCheck(NUMBERS.mainBsnr)).toBe('bsnr');
      expect(await api.insuranceNumberCheck(NUMBERS.additionalBsnr)).toBe('bsnr');
      expect(await api.insuranceNumberCheck(NUMBERS.ticketBsnr)).toBe('bsnr');
      expect(await api.insuranceNumberCheck(NUMBERS.lanr)).toBe('lanr');
      expect(await api.insuranceNumberCheck(`  ${NUMBERS.lanr}  `), 'trimmed before the lookup').toBe('lanr');
      expect(await api.insuranceNumberCheck('A123456789'), 'a well-formed number matches nothing').toBeNull();
      expect(await api.insuranceNumberCheck(''), 'empty matches nothing').toBeNull();

      console.log(
        `[#3806] ${bsnrRows.length} BSNR rows, ${doctors.length} doctors. ` +
          `${NUMBERS.mainBsnr}=main, ${NUMBERS.additionalBsnr}=additional, ${NUMBERS.lanr}=LANR, each unambiguous`,
      );
    },
  );

  test(
    '#3806 — the two filters that would confirm a fixture are silently ignored',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // Worth its own test: both answer 200 with the whole collection, exactly like a
      // bogus key, so "I filtered and found it" is not evidence that the row exists.
      for (const [path, filter] of [
        ['/practice_bsnrs', `number=${NUMBERS.mainBsnr}`],
        ['/doctors', `doctorId=${NUMBERS.lanr}`],
      ] as const) {
        const all = (await api.get(`${path}?itemsPerPage=1`)).body.totalItems;
        const filtered = (await api.get(`${path}?${filter}&itemsPerPage=1`)).body.totalItems;
        const bogus = (await api.get(`${path}?zzzNotAFilter=1&itemsPerPage=1`)).body.totalItems;
        expect(filtered, `${path}?${filter} is IGNORED`).toBe(all);
        expect(bogus, 'and a bogus key behaves identically, which is the control').toBe(all);
      }
      console.log('[#3806] /practice_bsnrs?number= and /doctors?doctorId= are both ignored — walk instead');
    },
  );

  test(
    "#3807 AC3 — the ticket's own eight rows, driven through the form's own check",
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      const report: string[] = [];
      for (const row of DUPLICATE_ROWS) {
        const matches = await api.duplicateCheck(row.first, row.last);
        const found = matches.find((m) => m.patientId === row.patient);

        if (row.expect === null) {
          // Row 8: same name, a different birth date -> no warning at all.
          expect(matches, `row ${row.row} (${row.label}) must match nothing`).toEqual([]);
        } else {
          expect(found, `row ${row.row} (${row.label}): patient ${row.patient} is listed`).toBeTruthy();
          expect(found!.matchType, `row ${row.row} (${row.label}) Match column`).toBe(row.expect);
        }
        report.push(`${row.row}:${row.label}=${found?.matchType ?? 'none'}`);
      }

      // Both Match values must occur, or the table is satisfied by one of them and AC1's
      // two-row mapping is never exercised.
      const seen = new Set(report.map((r) => r.split('=').pop()));
      expect(seen.has('name_dob'), 'the existing match type still occurs').toBe(true);
      expect(seen.has('last_name_dob'), 'and the NEW one occurs').toBe(true);

      console.log(`[#3807] AC3: ${report.join(' | ')}`);
    },
  );

  test(
    '#3807 AC2 — every normalisation rule, each against the patient it must find',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      for (const row of NORMALISATION_ROWS) {
        const matches = await api.duplicateCheck(row.first, row.last);
        const found = matches.find((m) => m.patientId === row.patient);
        expect(found, `${row.rule}: ${row.first} ${row.last} finds ${row.patient}`).toBeTruthy();
        // Normalisation equality means the FIRST names fold together too, so these are
        // full-name matches rather than last-name-only ones.
        expect(found!.matchType, `${row.rule} is a full-name match`).toBe('name_dob');
      }
      console.log(`[#3807] AC2: ${NORMALISATION_ROWS.length} normalisation rules, all matched as name_dob`);
    },
  );

  test(
    '#3807 AC1 — a group lists both match types at once, keyed to the first name',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // The PM's G pair is one existing patient with the same first name and one with a
      // different one, so a single check must label them differently — which is AC1's
      // table in one reading.
      const matches = await api.duplicateCheck('Anna', 'Testmüller FT3807 G');
      expect(matches.length, 'both patients are listed').toBeGreaterThanOrEqual(2);

      const sameFirstName = matches.filter((m) => m.firstName.trim().toLowerCase() === 'anna');
      const otherFirstName = matches.filter((m) => m.firstName.trim().toLowerCase() !== 'anna');
      expect(sameFirstName.length, 'one shares the first name').toBeGreaterThan(0);
      expect(otherFirstName.length, 'one does not').toBeGreaterThan(0);

      for (const m of sameFirstName) expect(m.matchType, `${m.patientId} same first name`).toBe('name_dob');
      for (const m of otherFirstName) expect(m.matchType, `${m.patientId} different first name`).toBe('last_name_dob');

      console.log(`[#3807] AC1: ${matches.map((m) => `${m.patientId} ${m.firstName}=${m.matchType}`).join(', ')}`);
    },
  );

  test(
    '#3807 — the regression direction: every pair the old rule found is still found',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // The Testing Guidance's own worry, and the real risk of a widened rule: the fold
      // was added AFTER today's mapping, so Müller/Mueller must still match as a full
      // name rather than being demoted to a last-name match.
      for (const [label, first, last, patient] of [
        ['Müller vs Mueller', 'Anna', 'Testmueller FT3807 R1', 99849],
        ['swapped first/last', 'Anna', 'Testmüller FT3807 R6', 99854],
        ['hyphen vs none', 'Anna', 'Schmidt-Müller FT3807 R7', 99855],
      ] as const) {
        const matches = await api.duplicateCheck(first, last);
        const found = matches.find((m) => m.patientId === patient);
        expect(found, `${label} is still found`).toBeTruthy();
        expect(found!.matchType, `${label} is still a FULL-name match, not demoted`).toBe('name_dob');
      }

      // And the rule did not become indiscriminate: a different birth date still matches
      // nothing, which is what stops "every pair is found" being true by accident.
      expect(
        await api.duplicateCheck('Anna', 'Testmüller FT3807 R5', '1960-07-07T11:00:00.000Z'),
        'an unrelated birth date matches nothing',
      ).toEqual([]);

      console.log('[#3807] the three pairs the old rule found are still name_dob; an unrelated birth date still matches nothing');
    },
  );

  test(
    '#3807 — the check is a READ, and the two-character guard moved to the last name only',
    { tag: ['@SuperAdmin', '@PatientFormWarnings', '@ReadOnly'] },
    async () => {
      // The pre-#3807 provider returned nothing while EITHER name was under two
      // characters, which kept the form from querying on the first keystroke. #3807 has
      // to relax half of that, because its whole point is matching regardless of the
      // first name — and it relaxed exactly that half:
      //
      //   last name under 2 characters  -> nothing, as before
      //   first name short or empty     -> the last-name matches still come back,
      //                                    and no full-name match, which is correct
      //
      // Worth pinning in both directions: keeping the old guard on the first name would
      // have silently disabled the new rule for anyone typing the last name first.
      const shortLast = await api.duplicateCheck('Anna', 'T');
      expect(shortLast, 'a one-character last name still returns nothing').toEqual([]);

      for (const [label, firstName] of [['one character', 'A'], ['empty', '']] as const) {
        const matches = await api.duplicateCheck(firstName, 'Testmüller FT3807 R5');
        expect(matches.length, `a ${label} first name still finds the last-name matches`).toBeGreaterThan(0);
        expect(
          [...new Set(matches.map((m) => m.matchType))],
          `a ${label} first name yields ONLY last-name matches`,
        ).toEqual(['last_name_dob']);
      }

      // ...and it is still a search, not a dump: an unknown last name matches nothing
      // even with a one-character first name.
      expect(await api.duplicateCheck('A', 'Zzzznosuchname'), 'an unknown last name').toEqual([]);

      // ...and asking twice changes nothing, because it is a read.
      const once = await api.duplicateCheck('Anna', 'Testmüller FT3807 R5');
      const twice = await api.duplicateCheck('Anna', 'Testmüller FT3807 R5');
      expect(twice.map((m) => m.patientId).sort(), 'the check is idempotent').toEqual(
        once.map((m) => m.patientId).sort(),
      );

      console.log(`[#3807] short-name guard holds; the check is a read (${once.length} matches, stable)`);
    },
  );
});
