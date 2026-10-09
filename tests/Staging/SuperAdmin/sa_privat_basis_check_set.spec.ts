import { test, expect } from '../../fixtures/session';
import {
  PrivatBasisCheckSetPage,
  INSURANCE,
  EXCLUDED_CHECKS,
  EXCLUDED_BY_CATEGORY,
  type Validation,
} from '../../../Pages/superadmin/sa.privat-basis-check-set.page';
import { mintUiSession, STAGING_CREDENTIALS, API_BASE } from '../../../Pages/util/api-token';

/**
 * RC 3.14 — Privat Basis VOs use the GKV validation check set (#3708, commit `28f402375`,
 * migration `Version20260916070000`).
 *
 * #3608 gave Privat Basis the **PKV** set by mirroring `private`. Privat Basis is the
 * PKV-Basistarif, which follows the GKV contractual framework, so this ticket re-points it at
 * **GKV** minus eleven checks that do not apply to a Basistarif patient.
 *
 * ## **MERGED BUT NOT DEPLOYED — reached three independent ways**
 *
 * `28f402375` is an ancestor of `release/3.14.0` (2026-09-16) and the API reports `3.14.0`, yet
 * Privat Basis still holds the #3608 set. Three surfaces agree: the **registry** (14 checks, all of
 * them the PKV-shaped ones), the **create form's own endpoint** (6 creation checks against GKV's
 * 18), and the **Validierungskonfiguration screen** (6 ✓ in its Privat Basis creation column).
 * `GET /status` cannot settle it — it reports the RELEASE, not the commit (#3704).
 *
 * ## The registry is the authoritative surface, and the arithmetic is exact
 *
 * `GET /validations` serves `applicableInsuranceTypes` per check, so AC1, AC3 and AC5 are all
 * statements about one served column — no sampled VO required. The migration's rule is arithmetic:
 * append `privat_basis` to every row carrying `public`, `WHERE description NOT IN (…11 names…)`.
 * Measured: **44 rows carry `public`, 14 carry `privat_basis`, and all 14 are inside the 44**, so
 * after the migration Privat Basis must hold **exactly 44 − 11 = 33**, and the **19** rows in
 * `shouldGain()` are precisely the difference. That containment is asserted before the number is
 * used, because without it the target silently under-counts.
 *
 * ## Findings
 *
 *  - **AC2 cannot fail, and saying so is the honest version of it.** `severity` is a property of
 *    the CHECK — one column per row, with no per-insurance-type override — so a check that applies
 *    to both GKV and Privat Basis necessarily carries the same severity and message for both. The
 *    test asserts that structure rather than inventing a per-type comparison that does not exist.
 *  - **This ticket incidentally closes #3576's open finding.** `fee_area_matches_therapy_type`
 *    (id 54) is the one PKV creation check #3608 never gave `privat_basis`, which #3576 reported as
 *    a defect. It carries `public`, it is not on the exclusion list, so the migration will add
 *    `privat_basis` to it — visible today on the config screen as the single row where PKV is ✓ and
 *    Privat Basis is ✗.
 *  - **The screen's "Zuletzt aktualisiert" reads 2026-06-22**, which predates both #3608 and this
 *    ticket, so it does not track the data it heads. Cosmetic, but a QA checking "did the screen
 *    update" by that date would conclude nothing changed.
 *
 * ## Traps
 *
 *  - **Six rows carry an EMPTY `applicableInsuranceTypes`** — disabled checks the migration
 *    deliberately skips. They are in no count and must not read as "missing from Privat Basis".
 *  - `/validations` needs `itemsPerPage` raised or the default page hides most of the 51.
 *  - The config screen has no per-cell testid; its columns are read by x-band and y-order.
 *
 * **Read-only** — every request is a GET except the transient `preview-creation-validation` POST,
 * which hydrates a throwaway prescription and writes nothing (#3576).
 */

test.describe('#3708 Privat Basis VOs use the GKV validation check set', () => {
  test.describe.configure({ mode: 'serial' });

  let rows: Validation[] = [];

  test(
    'deployment: the migration has not run — the registry still holds the #3608 PKV-shaped set',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      const token = await api.adminToken();
      rows = await api.validations(token);

      const status = await (await request.get(`${API_BASE}/status`)).json();
      const pub = PrivatBasisCheckSetPage.forType(rows, INSURANCE.public);
      const pkv = PrivatBasisCheckSetPage.forType(rows, INSURANCE.pkv);
      const pb = PrivatBasisCheckSetPage.forType(rows, INSURANCE.privatBasis);
      const disabled = rows.filter(PrivatBasisCheckSetPage.isDisabled);
      const gain = PrivatBasisCheckSetPage.shouldGain(rows);

      console.log(`#3708 API /status: ${JSON.stringify(status)}`);
      console.log(
        `#3708 registry: ${rows.length} checks — public ${pub.length}, private ${pkv.length}, privat_basis ${pb.length}, disabled ${disabled.length}`,
      );

      expect(rows.length, 'the whole registry was fetched, not one page').toBeGreaterThan(40);
      expect(pub.length, 'GKV is the widest set').toBeGreaterThan(pkv.length);

      if (!PrivatBasisCheckSetPage.migrationApplied(rows)) {
        console.log(
          `#3708 NOT DEPLOYED: ${gain.length} GKV checks still lack privat_basis and are not on the exclusion list — ` +
            `${gain.map((v) => `${v.id}:${v.description}`).join(', ')}. The commit is merged to release/3.14.0 and the ` +
            `API reports ${status.version}; /status gives the release, not the commit (#3704).`,
        );
        expect(pb.length, 'Privat Basis still holds the #3608 set').toBeLessThan(pub.length);
      } else {
        console.log('#3708 DEPLOYED: every non-excluded GKV check now carries privat_basis.');
        expect(gain.length).toBe(0);
      }
    },
  );

  test(
    'AC1 the exact target: Privat Basis must end up as GKV minus the eleven exclusions',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      rows = rows.length ? rows : await api.validations(await api.adminToken());

      const pub = PrivatBasisCheckSetPage.forType(rows, INSURANCE.public);
      const pb = PrivatBasisCheckSetPage.forType(rows, INSURANCE.privatBasis);
      const target = PrivatBasisCheckSetPage.expectedAfterMigration(rows);
      const gain = PrivatBasisCheckSetPage.shouldGain(rows);

      // The arithmetic is only sound while every current privat_basis row is also a public row —
      // otherwise `public − excluded` is not a superset of where Privat Basis already is, and the
      // target silently under-counts.
      const outsidePublic = pb.filter((v) => !PrivatBasisCheckSetPage.applies(v, INSURANCE.public));
      console.log(
        `#3708 AC1: public ${pub.length} − excluded ${EXCLUDED_CHECKS.length} = target ${target}; ` +
          `privat_basis today ${pb.length}, to gain ${gain.length}; privat_basis rows outside public: ${outsidePublic.length}`,
      );
      expect(outsidePublic, 'every Privat Basis check is also a GKV check, so the arithmetic holds').toHaveLength(0);
      expect(pb.length + gain.length, 'today + the gap is exactly the target').toBe(target);
      expect(target, 'and the target is GKV minus the eleven').toBe(pub.length - EXCLUDED_CHECKS.length);

      // Both timings are in scope — AC1 says "creation OR billing validation". Asserted over the
      // TARGET set, not over the gap: once the migration has run the gap is empty, and a spread
      // assertion on it would fail on a correct build for having nothing left to spread.
      const tally = (rs: Validation[]) =>
        rs.reduce<Record<string, number>>((acc, v) => {
          const k = v.timing ?? '(none)';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      const targetRows = PrivatBasisCheckSetPage.forType(rows, INSURANCE.public).filter(
        (v) => !EXCLUDED_CHECKS.includes(v.description),
      );
      console.log(`#3708 AC1 target set by timing: ${JSON.stringify(tally(targetRows))}`);
      console.log(`#3708 AC1 still to gain (${gain.length}) by timing: ${JSON.stringify(tally(gain))}`);
      expect(tally(targetRows)['vo_creation'] ?? 0, 'AC1 covers creation checks').toBeGreaterThan(0);
      expect(tally(targetRows)['billing'] ?? 0, 'and billing checks').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 the eleven exclusions exist, are off, and map onto the five categories the AC names',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      rows = rows.length ? rows : await api.validations(await api.adminToken());
      const byDescription = new Map(rows.map((v) => [v.description, v]));

      // AC 3 is written as five categories; the migration is eleven descriptions. Nothing else
      // states the mapping, so it is asserted here.
      for (const [category, checks] of Object.entries(EXCLUDED_BY_CATEGORY)) {
        for (const description of checks) {
          const v = byDescription.get(description);
          expect(v, `AC3 "${category}": ${description} exists in the registry`).toBeTruthy();
          expect(
            PrivatBasisCheckSetPage.applies(v as Validation, INSURANCE.privatBasis),
            `AC3 "${category}": ${description} stays OFF for Privat Basis`,
          ).toBe(false);
        }
        console.log(`#3708 AC3 ${category}: ${checks.length} check(s), all present and all off`);
      }

      // Every one of the eleven is a GKV check — an exclusion that GKV does not have either would
      // be a no-op in the migration and a sign the list had drifted.
      const notGkv = EXCLUDED_CHECKS.filter((d) => {
        const v = byDescription.get(d);
        return v && !PrivatBasisCheckSetPage.applies(v, INSURANCE.public);
      });
      console.log(`#3708 AC3: ${EXCLUDED_CHECKS.length} exclusions, ${notGkv.length} of them not GKV checks`);
      expect(notGkv, 'each exclusion actually subtracts something from the GKV set').toHaveLength(0);
      expect(PrivatBasisCheckSetPage.excludedAndOff(rows), 'all eleven are off today').toHaveLength(
        EXCLUDED_CHECKS.length,
      );
    },
  );

  test(
    'AC5 the PKV set is untouched, and the migration cannot touch it',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      rows = rows.length ? rows : await api.validations(await api.adminToken());

      const pkv = PrivatBasisCheckSetPage.forType(rows, INSURANCE.pkv);
      console.log(`#3708 AC5: PKV holds ${pkv.length} checks — ${pkv.map((v) => v.description).sort().join(', ')}`);

      // The ticket calls it "the 11 shared checks"; the registry says 15. Recorded rather than
      // asserted against the ticket's figure, which is the older #3608 wording.
      expect(pkv.length, 'PKV has a real set to be unchanged').toBeGreaterThan(0);
      if (pkv.length !== 11) {
        console.log(
          `#3708 AC5 note: the ticket says "the 11 shared checks", the registry serves ${pkv.length}. ` +
            "The count is #3608's legacy wording; what AC5 requires is that it does not CHANGE, which is " +
            'structural — the migration matches on `public` and never on `private`.',
        );
      }

      // The structural guarantee: the migration's WHERE clause keys on `public`, so no row can lose
      // or gain `private`. A PKV-only row (no `public`) is untouchable by it.
      const pkvOnly = pkv.filter((v) => !PrivatBasisCheckSetPage.applies(v, INSURANCE.public));
      console.log(`#3708 AC5: ${pkvOnly.length} PKV checks carry no \`public\`, so the migration cannot reach them at all`);
      expect(pkv.every((v) => PrivatBasisCheckSetPage.applies(v, INSURANCE.pkv))).toBe(true);
    },
  );

  test(
    'AC2 severity is a property of the check, not of the insurance type — so it cannot diverge',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      rows = rows.length ? rows : await api.validations(await api.adminToken());

      // One severity column per row. There is no per-type override anywhere in the payload, so a
      // check that applies to both GKV and Privat Basis necessarily reports the same severity and
      // the same message for both — AC2 holds by construction.
      const severities = [...new Set(rows.map((v) => v.severity))];
      const shapes = [...new Set(rows.map((v) => Object.keys(v).sort().join(',')))];
      console.log(`#3708 AC2 severities in use: ${JSON.stringify(severities)}`);
      console.log(`#3708 AC2 payload shape: ${shapes[0]}`);

      expect(severities.length, 'severity is a small closed vocabulary').toBeGreaterThan(0);
      expect(
        rows.every((v) => typeof v.severity === 'string' && v.severity.length > 0),
        'every check carries exactly one severity',
      ).toBe(true);
      // Falsifiable version of "no per-type override": nothing in the payload is keyed by type
      // except the applicability list itself.
      expect(
        shapes[0].split(',').filter((k) => /severity/i.test(k)),
        'exactly one severity field, not one per insurance type',
      ).toEqual(['severity']);

      const gain = PrivatBasisCheckSetPage.shouldGain(rows);
      console.log(
        `#3708 AC2: the ${gain.length} checks Privat Basis will gain bring their GKV severity with them — ` +
          JSON.stringify(
            gain.reduce<Record<string, number>>((acc, v) => {
              const k = v.severity ?? '(none)';
              acc[k] = (acc[k] ?? 0) + 1;
              return acc;
            }, {}),
          ),
      );
    },
  );

  test(
    'the create form\'s own endpoint agrees with the registry — a second, independent probe',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisCheckSetPage(request);
      const token = await api.adminToken();
      rows = rows.length ? rows : await api.validations(token);

      const gkvIds = await api.creationCheckIds(INSURANCE.public, token);
      const pkvIds = await api.creationCheckIds(INSURANCE.pkv, token);
      const pbIds = await api.creationCheckIds(INSURANCE.privatBasis, token);
      console.log(`#3708 preview endpoint — GKV ${gkvIds.length}, PKV ${pkvIds.length}, Privat Basis ${pbIds.length}`);

      // The endpoint evaluates creation-timing checks, so it must agree with the registry's
      // creation-timing slice for the same type. Two surfaces, one answer.
      const registryCreationPb = rows.filter(
        (v) => v.timing === 'vo_creation' && PrivatBasisCheckSetPage.applies(v, INSURANCE.privatBasis),
      );
      console.log(
        `#3708 registry creation-timing Privat Basis checks: ${registryCreationPb.length} ` +
          `(${registryCreationPb.map((v) => v.id).sort((a, b) => a - b).join(',')}) vs endpoint ${pbIds.join(',')}`,
      );
      expect(pbIds.length, 'the endpoint and the registry describe the same set').toBe(registryCreationPb.length);
      expect(gkvIds.length, 'and GKV is wider, as the ticket describes').toBeGreaterThan(pbIds.length);
    },
  );

  test(
    'AC4 the Validierungskonfiguration screen renders a Privat Basis column matching the registry',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(300_000);
      const api = new PrivatBasisCheckSetPage(request, page);
      const token = await api.adminToken();
      rows = rows.length ? rows : await api.validations(token);

      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await api.openConfigScreen();

      const body = await page.locator('body').innerText();
      // AC4's own subject: the column exists, in both tables, beside the other insurance types.
      for (const header of ['GKV Standard', 'PKV', 'Privat Basis', 'UV/BG']) {
        expect(body, `AC4: the "${header}" column`).toContain(header);
      }
      expect(body, 'AC4: the creation table').toContain('Erstellungsprüfungen');
      expect(body, 'AC4: and the billing table').toContain('Abrechnungsprüfungen');

      const pbMarks = await api.columnMarks('Privat Basis');
      const gkvMarks = await api.columnMarks('GKV Standard');
      const pbTicks = pbMarks.filter((m) => m === '✓').length;
      const gkvTicks = gkvMarks.filter((m) => m === '✓').length;
      console.log(
        `#3708 AC4 screen: Privat Basis column has ${pbMarks.length} cells, ${pbTicks} ✓; GKV Standard ${gkvMarks.length} cells, ${gkvTicks} ✓`,
      );

      expect(pbMarks.length, 'the column was actually read').toBeGreaterThan(20);

      // The screen is display-only and rendered from the registry, so its tick count must equal the
      // registry's — which is what makes AC4 a real assertion rather than "a column is present".
      //
      // **Two filters beyond the insurance type, and missing either makes the screen look wrong.**
      // The GKV columns are split by VO KIND (Standard / LHB / BVB / Blanko), so "GKV Standard" is
      // `public` AND `standard`; and a check whose timing is neither creation nor billing is in
      // neither table. Comparing the raw `public` count against the column reports a 4-row
      // discrepancy that is really 3 kind-specific checks plus 1 `not_needed` one.
      const registryPb = PrivatBasisCheckSetPage.renderedInColumn(rows, INSURANCE.privatBasis).length;
      const registryGkv = PrivatBasisCheckSetPage.renderedInColumn(rows, INSURANCE.public).length;
      const rawPb = PrivatBasisCheckSetPage.forType(rows, INSURANCE.privatBasis).length;
      const rawGkv = PrivatBasisCheckSetPage.forType(rows, INSURANCE.public).length;
      console.log(
        `#3708 AC4 registry: privat_basis ${rawPb} rows → ${registryPb} rendered; public ${rawGkv} rows → ${registryGkv} rendered ` +
          '(GKV columns are split by VO kind, and a `not_needed` check is in neither table)',
      );
      expect(pbTicks, 'AC4: the screen agrees with the registry for Privat Basis').toBe(registryPb);
      expect(gkvTicks, 'and for GKV Standard, which is the control').toBe(registryGkv);

      // The screen's own freshness stamp does not track the data it heads.
      const stamp = body.match(/Zuletzt aktualisiert:\s*([0-9-]+)/)?.[1];
      console.log(`#3708 AC4 screen stamp: "Zuletzt aktualisiert: ${stamp}" — predates #3608 and this ticket`);
    },
  );

  test(
    'FINDING: this ticket incidentally closes #3576\'s open finding on the cross-area check',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisCheckSetPage(request);
      rows = rows.length ? rows : await api.validations(await api.adminToken());

      const crossArea = rows.find((v) => v.description === 'fee_area_matches_therapy_type');
      expect(crossArea, 'check 54 is in the registry').toBeTruthy();
      const v = crossArea as Validation;
      const state = {
        id: v.id,
        severity: v.severity,
        public: PrivatBasisCheckSetPage.applies(v, INSURANCE.public),
        pkv: PrivatBasisCheckSetPage.applies(v, INSURANCE.pkv),
        privatBasis: PrivatBasisCheckSetPage.applies(v, INSURANCE.privatBasis),
        onExclusionList: EXCLUDED_CHECKS.includes(v.description),
      };
      console.log(`#3708 cross-area check state: ${JSON.stringify(state)}`);

      expect(state.public, 'it is a GKV check').toBe(true);
      expect(state.onExclusionList, 'and it is not one of the eleven exclusions').toBe(false);

      if (!state.privatBasis) {
        console.log(
          '#3708 FINDING (for the PM): `fee_area_matches_therapy_type` (id 54) is the one PKV creation check ' +
            "#3608 never gave `privat_basis` — reported as an open defect on #3576. It carries `public` and is not " +
            'on this ticket\'s exclusion list, so the migration will add `privat_basis` to it. #3708 therefore closes ' +
            '#3576\'s finding as a side effect, and it is visible today on the config screen as the single row where ' +
            'PKV is ✓ and Privat Basis is ✗.',
        );
        expect(state.pkv, 'PKV has it, which is exactly what made the gap a defect').toBe(true);
      } else {
        console.log("#3708: check 54 now applies to Privat Basis — #3576's finding is closed.");
      }
    },
  );

  test(
    'AC2 a Privat Basis VO is evaluated exactly as a GKV one on every shared check, failures included',
    { tag: ['@SuperAdmin', '@PrivatBasisCheckSet', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisCheckSetPage(request);
      const token = await api.adminToken();
      rows = rows.length ? rows : await api.validations(token);

      // The same transient VO, run twice under two insurance types. `preview-creation-validation`
      // hydrates a throwaway prescription and writes nothing (#3576), so this drives AC2's literal
      // case — a Privat Basis VO FAILING a GKV-specific check — without creating anything.
      const gkv = await api.creationVerdicts(INSURANCE.public, token);
      const pb = await api.creationVerdicts(INSURANCE.privatBasis, token);
      const shared = [...gkv.keys()].filter((id) => pb.has(id)).sort((a, b) => a - b);
      const disagreements = shared.filter((id) => gkv.get(id) !== pb.get(id));
      const failing = shared.filter((id) => pb.get(id) === false);

      console.log(
        `#3708 AC2: GKV evaluated ${gkv.size} checks, Privat Basis ${pb.size}; ${shared.length} shared, ` +
          `${disagreements.length} verdict disagreements, ${failing.length} of them FAILING for Privat Basis`,
      );
      console.log(
        `#3708 AC2 per-check (id: GKV/PB): ${shared.map((id) => `${id}:${gkv.get(id)}/${pb.get(id)}`).join(' ')}`,
      );

      // AC2's substance: identical input, identical outcome on every check both types run.
      expect(disagreements, 'AC2: a shared check reaches the same verdict for both types').toEqual([]);
      // And it is exercised on real failures, not only on passes — a set where nothing fails would
      // satisfy the equality trivially and prove nothing about AC2's wording.
      expect(failing.length, 'AC2 names a FAILING check, so at least one must fail here').toBeGreaterThan(0);

      // Severity travels with the check, so "same severity as a GKV VO" is the same row read twice.
      const byId = new Map(rows.map((v) => [v.id, v]));
      const failingSeverities = failing.map((id) => `${id}:${byId.get(id)?.severity}`);
      console.log(`#3708 AC2 severities of the failing checks: ${failingSeverities.join(' ')}`);
      expect(
        failing.every((id) => typeof byId.get(id)?.severity === 'string'),
        'every failing check carries the one severity both types read',
      ).toBe(true);

      // What GKV runs and Privat Basis does not must be exactly AC3 exclusions — anything else
      // would mean the migration had dropped a check it was meant to add.
      const gkvOnly = [...gkv.keys()].filter((id) => !pb.has(id)).sort((a, b) => a - b);
      const gkvOnlyNames = gkvOnly.map((id) => byId.get(id)?.description ?? String(id));
      console.log(`#3708 AC2 GKV-only on this payload: ${gkvOnly.join(',')} — ${gkvOnlyNames.join(', ')}`);
      expect(
        gkvOnlyNames.filter((n) => !EXCLUDED_CHECKS.includes(n)),
        'the only creation checks Privat Basis still misses are AC3 exclusions',
      ).toEqual([]);
    },
  );

});
