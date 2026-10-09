import { test, expect, request as pwRequest, type APIRequestContext } from '../../fixtures/session';
import { BlankoBillingValidationPage as B, type Treatment } from '../../../Pages/superadmin/sa.blanko-billing-validation.page';

/**
 * RC 3.15 — #3841 and #3842, the two billing checks that fail on Blanko VOs for the same reason:
 * on a Blanko VO the therapist decides the Heilmittel and the units, so the VO's prescribed list is
 * not a specification. Both shipped in commit `646440999` (`Ref #3841 #3842`), **no PR**.
 *
 *  - **#3841**, check **17** `billed_units_not_exceed_prescribed`: an early `return true` for a
 *    Blanko VO, whose prescribed quantity is 0 when created in Flow and an arbitrary TheOrg number
 *    when imported.
 *  - **#3842**, check **30** `service_maps_to_remedy`: an unlisted billed position passes when it
 *    is a Blanko position of the VO's OWN Fachbereich; other-area and non-Blanko still fail.
 *
 * **Mostly read-only; the one write is the evaluation itself.** There is no preview route — the
 * only thing that makes either check speak is `POST /prescriptions/{id}/check-billing-validation`,
 * which is exactly what the validation page fires on load and what both tickets' QA steps ask for.
 * It is measured here as writing verdict rows ONLY: `validationStatus`, `creationValidationStatus`
 * and `treatmentStatus` are read either side of every call and must not move. The population tests
 * additionally stay off VOs that already carry a validation status; the AC2 test deliberately does
 * NOT, because a VO holding a stale pre-fix verdict is precisely the case #3841 AC2 and #3842 AC2
 * describe, and some of them are validated.
 *
 * **The before/after needs no write at all, which is the method worth keeping.** A stored
 * `PrescriptionValidation` row is the judgement made when the VO was last validated, so on a VO
 * nobody has re-opened since the deploy it is literally the PRE-FIX answer — and comparing it to
 * what today's rule says about the same unchanged data is the whole ticket, read-only.
 *
 * **VO 6314-2 is in that stale pool and is READ ONLY here by name.** It is #3426's TheOrg-Blanko
 * exclusion fixture and must never be invoiced; `DO_NOT_WRITE` keeps the evaluation off it.
 */

const UNITS = B.CHECK_UNITS;      // 17
const MAPPING = B.CHECK_MAPPING;  // 30
/** The tickets' own named staging fixtures, resolved by VO NUMBER at run time. */
const TICKET_FIXTURES = ['8978-1', '7106-3', '9435-1', '2648-10'] as const;
/** How many Blanko VOs the population tests evaluate. Each is one bounded write. */
const SAMPLE = 8;
/** How many Blanko VOs the beforeAll classifies to build the pools. Reads only. */
const SCAN = 60;

type Classified = {
  id: number; number: string; therapyType: string | null; insuranceType: string | null;
  over: { code: string; billed: number; prescribed: number }[];
  unlisted: { code: string; bucket: string }[];
};

let api: APIRequestContext;
let page: B;
let TR = new Map<number, Treatment>();
let blankoIds: number[] = [];
/** Blanko VOs the PRE-fix check 17 would have failed — #3841's own case. */
let unitsCases: Classified[] = [];
/** Blanko VOs billing a position that is not on their list — #3842's own case. */
let mappingCases: Classified[] = [];
/** Blanko VOs that trip neither, kept so a pass is not read as the check never running. */
let quietCases: Classified[] = [];

test.describe('#3841 + #3842 the two billing checks on Blanko VOs', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    api = await pwRequest.newContext();
    page = new B(api);
    await page.init();
    TR = await page.treatments();
    // Blanko VOs are enumerated through the BV catalogue, because `blankoVO` is SILENTLY IGNORED
    // as a filter (#3773) while `treatment=` is registered (#3577): a VO prescribing any `bv`
    // position IS a Blanko VO, which is `isBlankoVO()`'s own definition.
    const bvIds = [...TR.values()].filter((t) => t.bv).map((t) => t.id);
    const seen = new Map<number, any>();
    for (const id of bvIds) {
      const b = await page.get<any>(
        `/prescriptions?itemsPerPage=120&treatment=${id}&treatmentStatus=Fertig+Behandelt`);
      for (const vo of b.member ?? []) seen.set(vo.id, vo);
    }
    // Only VOs with no validation status yet — nothing already judged is re-judged.
    blankoIds = [...seen.values()].filter((v) => !v.validationStatus).map((v) => v.id).sort((a, b) => a - b);
    console.log(`  catalogue: ${TR.size} treatments, ${bvIds.length} Blanko positions` +
      ` (${[...new Set([...TR.values()].filter((t) => t.bv).map((t) => t.area))].join('/')})`);
    console.log(`  Blanko VOs, Fertig Behandelt: ${seen.size}; unvalidated: ${blankoIds.length}`);

    // **The two tickets need DIFFERENT fixtures, and each ticket's own are non-discriminating for
    // the other** — which is why the pools are classified rather than sliced off the front.
    //   #3841's shape: a prescribed TREATMENT-kind remedy is ALSO billed, over its quantity
    //                  (8978-1 prescribes KG-BV 0 and bills KG-BV 11).
    //   #3842's shape: a TREATMENT-kind position is billed that is NOT prescribed
    //                  (9435-1 prescribes PFB-BV and bills the archived PFB-H-BV).
    // On #3842's fixtures no prescribed remedy is billed at all, so check 17 cannot fail there;
    // on #3841's the billed position is listed, so check 30 cannot. Taking the first N VOs found
    // neither case, which is what the anti-vacuity guards below exist to catch.
    const named: number[] = [];
    for (const num of TICKET_FIXTURES) {
      const f = await page.prescriptionByNumber(num);
      if (f) named.push(f.id);
    }
    const toScan = [...new Set([...named, ...blankoIds])].slice(0, SCAN);
    for (const id of toScan) {
      const vo = await page.prescription(id);
      if (vo.validationStatus) continue;
      const pres = B.prescribedMap(vo);
      const billed = await page.deliveredCounts(id);
      const row: Classified = {
        id, number: String(vo.prescriptionId), therapyType: vo.therapyType ?? null,
        insuranceType: vo.insuranceType ?? null,
        over: B.unitsOverPreFix(pres, billed, TR),
        unlisted: B.unlistedPositions(pres, billed, TR, vo.therapyType),
      };
      if (row.over.length) unitsCases.push(row);
      if (row.unlisted.length) mappingCases.push(row);
      if (!row.over.length && !row.unlisted.length) quietCases.push(row);
    }
    console.log(`  classified ${toScan.length}: ${unitsCases.length} would fail check ${UNITS} pre-fix,` +
      ` ${mappingCases.length} bill an unlisted position, ${quietCases.length} neither`);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: the fix is in the EVALUATOR — the scope config is deliberately unchanged',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@ReadOnly'] },
    async () => {
      // The Developer Reference offered two routes: an early return, or dropping "blanko" from the
      // checks' `applicable_vo_kinds`. The second was NOT taken — so a probe that reads the config
      // concludes nothing changed, and only evaluating a VO can tell.
      const b = await page.get<any>('/validations?itemsPerPage=80');
      const rows = (b.member ?? []).filter((v: any) => [UNITS, MAPPING].includes(v.id));
      expect(rows, 'both checks are registered').toHaveLength(2);
      for (const v of rows) {
        console.log(`  validation ${v.id} ${v.description}: kinds=${JSON.stringify(v.applicableVoKinds)}` +
          ` types=${JSON.stringify(v.applicableInsuranceTypes)} severity=${v.severity}`);
        expect(v.applicableVoKinds, `check ${v.id} still lists blanko`).toContain('blanko');
        expect(v.timing, `check ${v.id} is a billing check`).toBe('billing');
      }
      expect(rows.find((v: any) => v.id === UNITS).description).toBe('billed_units_not_exceed_prescribed');
      expect(rows.find((v: any) => v.id === MAPPING).description).toBe('service_maps_to_remedy');

      // ...and the reason the early return had to be the route: the VO-kind list is only applied
      // for GKV and Privat Basis, so dropping "blanko" would have left PKV and BG Blanko VOs
      // failing — which AC1 of #3841 covers explicitly.
      for (const v of rows) {
        expect(v.applicableInsuranceTypes, `check ${v.id} covers all four insurance types`)
          .toEqual(expect.arrayContaining(['public', 'private', 'accident', 'privat_basis']));
      }
    },
  );

  test(
    'the evaluation writes verdict rows ONLY — it never moves a VO on the billing queue',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      // Established before anything else runs it, because every test below depends on this being a
      // bounded write. (It is also #3841 AC2 / #3842 AC2's mechanism: opening the page re-checks.)
      const id = blankoIds[0];
      const before = await page.queueState(id);
      const beforeRows = await page.storedVerdicts(id);
      const results = await page.runBillingChecks(id);
      const after = await page.queueState(id);
      const afterRows = await page.storedVerdicts(id);
      console.log(`  VO ${id}: queue state ${JSON.stringify(before)}`);
      console.log(`  verdict rows ${beforeRows.size} -> ${afterRows.size}; the POST returned ${results.size}`);
      expect(after, 'validationStatus / creationValidationStatus / treatmentStatus are untouched').toEqual(before);
      expect(results.size, 'the response carries the verdicts inline').toBeGreaterThan(0);
      expect(afterRows.size, 'and they are stored').toBeGreaterThanOrEqual(results.size);
    },
  );

  test(
    "#3841: check 17 passes on every Blanko VO, including ones the old rule would have failed",
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      // The rescued VOs first — a sample that contains none of them passes on the OLD build too.
      const pool = [...unitsCases.slice(0, SAMPLE), ...quietCases.slice(0, 4)];
      expect(unitsCases.length, 'the classified pool contains VOs the change actually rescues')
        .toBeGreaterThan(0);
      const insurance = new Set<string>();
      for (const row of pool) {
        const verdicts = await page.runBillingChecks(row.id);
        const v = verdicts.get(UNITS);
        insurance.add(String(row.insuranceType));
        console.log(`  ${row.number.padEnd(9)} ${String(row.insuranceType).padEnd(10)}` +
          (row.over.length
            ? ` pre-fix would FAIL ${JSON.stringify(row.over.slice(0, 2))}`
            : ' (no pre-fix failure — a control)') + ` -> passed=${v?.passed}`);
        expect(v, `VO ${row.number}: check ${UNITS} was evaluated`).toBeTruthy();
        expect(v!.passed, `VO ${row.number}: check ${UNITS} passes on a Blanko VO`).toBe(true);
      }
      console.log(`  ${pool.length} Blanko VOs evaluated (${unitsCases.slice(0, SAMPLE).length} rescued,` +
        ` ${quietCases.slice(0, 4).length} controls); insurance types ${JSON.stringify([...insurance])}`);
    },
  );

  test(
    "#3841 AC3 + #3842 AC1: the tickets' own named fixtures",
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      for (const num of TICKET_FIXTURES) {
        const found = await page.prescriptionByNumber(num);
        expect(found, `${num} exists on staging`).toBeTruthy();
        const vo = await page.prescription(found.id);
        expect(vo.blankoVO, `${num} is a Blanko VO`).toBe(true);
        expect(vo.validationStatus ?? null, `${num} is not already validated`).toBeNull();

        const pres = B.prescribedMap(vo);
        const billed = await page.deliveredCounts(vo.id);
        const over = B.unitsOverPreFix(pres, billed, TR);
        const unlisted = B.unlistedPositions(pres, billed, TR, vo.therapyType);
        const verdicts = await page.runBillingChecks(vo.id);
        console.log(`  ${num} (${vo.therapyType}, ${vo.insuranceType}):`);
        console.log(`     units  pre-fix offenders ${JSON.stringify(over)} -> check ${UNITS} passed=${verdicts.get(UNITS)?.passed}`);
        console.log(`     unlisted billed positions ${JSON.stringify(unlisted)} -> check ${MAPPING} passed=${verdicts.get(MAPPING)?.passed}`);
        expect(verdicts.get(UNITS)?.passed, `${num}: check 17`).toBe(true);
        expect(verdicts.get(MAPPING)?.passed, `${num}: check 30`).toBe(true);

        // #3841 AC2 / #3842 AC2: with these two out of the way, nothing else holds the VO back —
        // which is what enables "Validierung bestanden".
        const failing = [...verdicts.entries()].filter(([, v]) => !v.passed).map(([k]) => k);
        console.log(`     remaining failing checks: ${JSON.stringify(failing)}`);
      }
    },
  );

  test(
    '#3842: unlisted own-area Blanko positions pass, and that population is large',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      expect(mappingCases.length, 'the classified pool exercises the mapping rule')
        .toBeGreaterThan(0);
      const buckets: Record<string, number> = { 'own-area-bv': 0, 'other-area-bv': 0, 'not-bv': 0 };
      let mismatches = 0;
      const pool = mappingCases.slice(0, SAMPLE + 4);
      for (const row of pool) {
        for (const u of row.unlisted) buckets[u.bucket] = (buckets[u.bucket] ?? 0) + 1;
        // The oracle, not a constant: an own-area-only VO must pass, anything else must fail.
        const expected = row.unlisted.every((u) => u.bucket === 'own-area-bv');
        const served = (await page.runBillingChecks(row.id)).get(MAPPING)?.passed;
        console.log(`  ${row.number.padEnd(9)} ${String(row.therapyType).padEnd(14)}` +
          ` unlisted ${JSON.stringify(row.unlisted.map((u) => `${u.code}:${u.bucket}`))}` +
          ` -> oracle ${expected}, served ${served}`);
        if (served !== expected) mismatches++;
        expect(served, `VO ${row.number}: check ${MAPPING}`).toBe(expected);
      }
      console.log(`  ${pool.length} VOs bill an unlisted position; buckets ${JSON.stringify(buckets)}`);
      expect(buckets['own-area-bv'], "#3842's own case occurs").toBeGreaterThan(0);
      expect(mismatches, 'the served verdict matches the ported rule everywhere').toBe(0);
      if (!buckets['other-area-bv'] && !buckets['not-bv']) {
        console.log('  → AC1\'s two FAILING rows (other-area Blanko, non-Blanko) have no fixture in');
        console.log('    this pool — the production copy has 7 and 3 VOs; staging, none scanned.');
      }
    },
  );

  // --------------------------------------------------------------------------------------
  // The before/after. A stored verdict is the judgement made when the VO was last validated,
  // so on a VO nobody has re-opened since the deploy it is literally the PRE-FIX answer — and
  // comparing it to today's rule is the whole ticket, read-only, on real data.
  // --------------------------------------------------------------------------------------

  // Blanko VOs that carried a stored `passed: false` for check 30 on 2026-10-02. 24166 is
  // 6314-2, #3426's exclusion fixture — it is READ ONLY here and must never be posted to.
  // 25439 (8220-1) is the one whose correction was demonstrated live, below.
  const STALE_MAPPING_VERDICTS = [
    7218, 16395, 17584, 20295, 20833, 21012, 22638, 22740, 23241, 24166, 24614, 24876, 25439,
  ];
  const DO_NOT_WRITE = new Set([24166]);

  test(
    '#3842 AC2: the stored PRE-FIX verdicts, and today\'s rule disagreeing with every one',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@ReadOnly'] },
    async () => {
      let stale = 0; let justified = 0; let corrected = 0;
      for (const id of STALE_MAPPING_VERDICTS) {
        const vo = await page.prescription(id);
        expect(vo.blankoVO, `${vo.prescriptionId} is a Blanko VO`).toBe(true);
        const stored = (await page.storedVerdicts(id)).get(MAPPING);
        const pres = B.prescribedMap(vo);
        const billed = await page.deliveredCounts(id);
        const unlisted = B.unlistedPositions(pres, billed, TR, vo.therapyType);
        const oracle = B.mappingPasses(pres, billed, TR, vo.therapyType, true);
        const codes = unlisted.map((u) => `${u.code}:${u.bucket}`);
        if (stored === false) {
          stale += 1;
          console.log(`  ${vo.prescriptionId} stored=FAILED  ${JSON.stringify(codes)} -> today ${oracle ? 'PASSES' : 'still fails'}`);
          // The durable invariant: a stored failure must not be one today's rule would repeat.
          if (!oracle) justified += 1;
        } else {
          corrected += 1;
          console.log(`  ${vo.prescriptionId} stored=${stored}  ${JSON.stringify(codes)} (re-evaluated since)`);
        }
      }
      console.log(`  ${stale} still carrying the pre-fix verdict, ${corrected} re-evaluated since`);
      expect(justified, 'no stored check-30 failure on a Blanko VO survives today\'s rule').toBe(0);
      expect(stale + corrected, 'the pinned population is still readable').toBe(STALE_MAPPING_VERDICTS.length);
    },
  );

  test(
    '#3842 AC2: re-evaluating REPLACES the stored failure in place, without moving the VO',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      // Pick a VO still holding the pre-fix verdict; if the pool is exhausted, fall back to
      // 8220-1, where the flip was demonstrated on 2026-10-02 and must have persisted.
      let target: number | null = null;
      for (const id of STALE_MAPPING_VERDICTS) {
        if (DO_NOT_WRITE.has(id)) continue;
        if ((await page.storedVerdicts(id)).get(MAPPING) === false) { target = id; break; }
      }

      if (target === null) {
        const vo = await page.prescription(25439);
        const rows = await page.storedVerdictRows(25439);
        const row = rows.find((r) => r.validation === MAPPING);
        console.log(`  pool exhausted — ${vo.prescriptionId} verdict row ${row?.id} reads passed=${row?.passed}`);
        expect(row?.passed, 'the correction demonstrated on 2026-10-02 persisted').toBe(true);
        expect(row?.id, 'and it was an update in place, not a new row').toBe(496897);
        return;
      }

      const vo = await page.prescription(target);
      const before = await page.storedVerdictRows(target);
      const beforeRow = before.find((r) => r.validation === MAPPING);
      const beforeQueue = await page.queueState(target);
      console.log(`  ${vo.prescriptionId}: verdict row ${beforeRow?.id} reads passed=${beforeRow?.passed}`);

      await page.runBillingChecks(target);

      const after = await page.storedVerdictRows(target);
      const afterRow = after.find((r) => r.validation === MAPPING);
      const afterQueue = await page.queueState(target);
      console.log(`  after re-evaluation: row ${afterRow?.id} reads passed=${afterRow?.passed}`);
      console.log(`  queue ${JSON.stringify(beforeQueue)} -> ${JSON.stringify(afterQueue)}`);

      expect(afterRow?.passed, 'the stored failure is replaced by a pass').toBe(true);
      expect(afterRow?.id, 'updated in place — the same verdict row, not a second one').toBe(beforeRow?.id);
      expect(afterQueue, 'the VO itself is not moved by the re-evaluation').toEqual(beforeQueue);

      // A re-evaluation writes a verdict for every CURRENTLY applicable check, so on a VO last
      // validated before a new check was registered the row count grows by that catch-up — on
      // 4876-1 it was validation 55 (billing_discharge_management_timing, #3830's). That is an
      // addition, never a replacement: nothing may be removed, and a second run must add
      // nothing, which is what separates a catch-up from the rows multiplying on every open.
      const beforeIds = new Set(before.map((r) => r.id));
      const afterIds = new Set(after.map((r) => r.id));
      const removed = before.filter((r) => !afterIds.has(r.id));
      const added = after.filter((r) => !beforeIds.has(r.id));
      console.log(`  verdict rows ${before.length} -> ${after.length}; added ${JSON.stringify(added.map((r) => r.validation))}, removed ${JSON.stringify(removed.map((r) => r.validation))}`);
      expect(removed, 'no verdict row is ever removed by a re-evaluation').toEqual([]);
      const beforeChecks = new Set(before.map((r) => r.validation));
      for (const r of added) {
        expect(beforeChecks.has(r.validation), `added row is a catch-up for check ${r.validation}, not a duplicate`).toBe(false);
      }

      await page.runBillingChecks(target);
      const twice = await page.storedVerdictRows(target);
      console.log(`  a second run leaves ${twice.length} rows`);
      expect(twice.length, 'the write is idempotent — a second run adds nothing').toBe(after.length);
    },
  );

  test(
    '#3841 AC4 + #3842 AC3: a NON-Blanko VO keeps both checks exactly as before',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@Mutating'] },
    async () => {
      // The half that shows the change is SCOPED, so it needs standard VOs — a Blanko VO
      // cannot stand in for either check. These were found by walking the id space; each is
      // re-derived from its own data below, so a fixture that drifts out of its state fails
      // loudly instead of passing for the wrong reason.
      //
      // STANDARD_UNLISTED is the sharpest control in the file. 6975-5 prescribes KG and bills
      // KG-BV — an own-area BV position, EXACTLY the shape #3842 now accepts on a Blanko VO.
      // It must still fail here, which is what shows the new branch is gated on `blankoVO`
      // rather than on the position being BV. 1280-28 covers the plain non-BV case beside it.
      const STANDARD_AT_BUDGET = [21991, 22205, 22699];  // 6381-4, 7725-1, 6109-3
      const STANDARD_UNLISTED = [31034, 29384];          // 6975-5 (KG-BV), 1280-28 (KG)

      const load = async (id: number) => {
        const vo = await page.prescription(id);
        const pres = B.prescribedMap(vo);
        const delivered = await page.deliveredCounts(id);
        return {
          vo, pres, delivered,
          over: B.unitsOverPreFix(pres, delivered, TR),
          unlisted: B.unlistedPositions(pres, delivered, TR, vo.therapyType),
        };
      };

      // ── #3841 AC4, second line: "the same VO with 10 sessions billed passes" ──
      let atBudget: Awaited<ReturnType<typeof load>> | null = null;
      for (const id of STANDARD_AT_BUDGET) {
        const row = await load(id);
        if (row.vo.blankoVO) continue;                 // a Blanko VO would prove nothing here
        if (row.over.length) continue;                 // must be AT or under budget
        const prescribedUnits = [...row.pres.values()].filter((n) => n > 0);
        if (!prescribedUnits.length) continue;         // and must actually prescribe units
        atBudget = row;
        break;
      }
      expect(atBudget, 'a standard VO sitting at its prescribed budget').toBeTruthy();
      const units = (await page.runBillingChecks(atBudget!.vo.id)).get(UNITS);
      const budget = [...atBudget!.pres.entries()]
        .filter(([, n]) => n > 0)
        .map(([id, n]) => `${TR.get(id)?.code ?? id} ${atBudget!.delivered.get(id) ?? 0}/${n}`);
      console.log(`  AC4 at budget : ${atBudget!.vo.prescriptionId} ${JSON.stringify(budget)} -> passed=${units?.passed}`);
      expect(units?.passed, 'a standard VO within its prescribed units passes check 17').toBe(true);
      // The point of this VO: unlike a Blanko one it prescribes a real number, so the check is
      // asking a question the VO can answer — and the answer is still being computed.
      expect([...atBudget!.pres.values()].some((n) => n > 0),
        'and it prescribes a real quantity, unlike a Blanko VO').toBe(true);

      // ── #3842 AC3: an unlisted position on a standard VO still fails ──
      let unlistedVo: Awaited<ReturnType<typeof load>> | null = null;
      let bvShaped = false;
      for (const id of STANDARD_UNLISTED) {
        const row = await load(id);
        if (row.vo.blankoVO || !row.unlisted.length) continue;
        unlistedVo = row;
        bvShaped = row.unlisted.some((u) => u.bucket === 'own-area-bv');
        if (bvShaped) break;                           // prefer the BV-shaped control
      }
      expect(unlistedVo, 'a standard VO billing a position it does not prescribe').toBeTruthy();
      const mapping = (await page.runBillingChecks(unlistedVo!.vo.id)).get(MAPPING);
      const kinds = unlistedVo!.unlisted.map((u) => `${u.code}:${u.bucket}`);
      console.log(`  AC3 unlisted  : ${unlistedVo!.vo.prescriptionId} ${JSON.stringify(kinds)} -> passed=${mapping?.passed}`);
      console.log(`     note: ${JSON.stringify(mapping?.autoNote)}`);
      expect(mapping?.passed, 'a standard VO billing an unlisted position still FAILS check 30').toBe(false);
      expect(mapping?.autoNote ?? '', 'with the existing German note').toMatch(/nicht auf der VO verordnet/);
      expect(bvShaped,
        'and the control is the BV-shaped one, so it discriminates the new Blanko-only branch').toBe(true);
    },
  );

  test(
    '#3841 AC3: both halves of the ticket\'s own table, and why AC4\'s failing row has no fixture',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@ReadOnly'] },
    async () => {
      // AC3's table says a Blanko VO must pass "whatever number of prescribed units its
      // Heilmittel has in Flow", and names three shapes: created in Flow (0 prescribed, 12
      // billed), imported from TheOrg (2 prescribed, 6 billed) and imported (10 prescribed, 4
      // billed). Those are two genuinely different states — a VO built here carries no unit
      // number at all, while TheOrg brings one with it — and the pre-fix rule misfired on both
      // for the same reason, so both have to be on the record.
      //
      // AC4's FAILING row ("a standard GKV VO with 10 units prescribed and 11 sessions billed")
      // has no staging fixture: a walk of 460 standard Fertig Behandelt VOs on 2026-10-02 found
      // none delivering past its budget, because the Doku flow will not document beyond it. The
      // over-budget cases that DO exist on staging are all Blanko — which is the scope
      // statement AC4 is really making, reached from the data rather than from the code.
      // The three shapes a Blanko VO's prescribed list actually takes. The third is the one
      // the ticket does not mention and which a sample makes look like an empty result: most
      // Blanko VOs prescribe NO treatment-kind position at all — their list is fees (VBP-BV is
      // a one-time fee, #3712; AEB-BV is passiv) — so a filter on treatment-kind rows returns
      // nothing for them, which reads exactly like the VO having no prescribed units.
      const sample = blankoIds.slice(0, 30);
      let noTreatmentRow = 0; let zeroPrescribed = 0; let numbered = 0;
      const numberedExamples: string[] = [];
      for (const id of sample) {
        const vo = await page.prescription(id);
        const treatments = [...B.prescribedMap(vo).entries()]
          .filter(([t]) => TR.get(t)?.kind === 'treatment');
        if (!treatments.length) { noTreatmentRow += 1; continue; }
        if (treatments.every(([, n]) => n === 0)) {
          zeroPrescribed += 1;
        } else {
          numbered += 1;
          if (numberedExamples.length < 4) {
            numberedExamples.push(`${vo.prescriptionId} ${JSON.stringify(
              treatments.map(([t, n]) => `${TR.get(t)?.code}:${n}`))}`);
          }
        }
      }
      console.log(`  of ${sample.length} sampled Blanko VOs: ${noTreatmentRow} prescribe only fees,`
        + ` ${zeroPrescribed} prescribe a treatment at 0 units, ${numbered} carry a unit number`);
      for (const e of numberedExamples) console.log(`     ${e}`);

      // AC3's two rows, pinned on the ticket's own VOs rather than on whatever a slice holds.
      // 8978-1 is the ticket's staging repro (created in Flow, KG-BV at 0 units); 8603-2 is a
      // TheOrg import that brought its own number, which is AC3's second row.
      const AC3_ZERO = '8978-1';
      const AC3_IMPORTED = '8603-2';
      for (const [label, num] of [['created in Flow', AC3_ZERO], ['TheOrg import', AC3_IMPORTED]] as const) {
        const vo = await page.prescriptionByNumber(num);
        expect(vo, `${num} is still on staging`).toBeTruthy();
        const full = await page.prescription(vo!.id);
        expect(full.blankoVO, `${num} is a Blanko VO`).toBe(true);
        const pres = B.prescribedMap(full);
        const delivered = await page.deliveredCounts(full.id);
        const treatments = [...pres.entries()].filter(([t]) => TR.get(t)?.kind === 'treatment');
        const shown = treatments.map(([t, n]) => `${TR.get(t)?.code} ${delivered.get(t) ?? 0}/${n}`);
        const over = B.unitsOverPreFix(pres, delivered, TR);
        const verdict = (await page.runBillingChecks(full.id)).get(UNITS);
        console.log(`  AC3 ${label.padEnd(15)} ${num} ${JSON.stringify(shown)}`
          + ` pre-fix would fail on ${JSON.stringify(over.map((o) => o.code))} -> passed=${verdict?.passed}`);
        expect(over.length, `${num} is over its prescribed units, so it discriminates`).toBeGreaterThan(0);
        expect(verdict?.passed, `${num} passes check 17 anyway`).toBe(true);
      }

      // The standard side, for contrast: a real budget the check can meaningfully compare to.
      const b = await page.get<any>(
        '/prescriptions?itemsPerPage=40&treatmentStatus=Fertig+Behandelt&order%5Bid%5D=desc');
      let standard = 0; let standardZero = 0;
      for (const v of b.member ?? []) {
        if (v.blankoVO) continue;
        const treatments = [...B.prescribedMap(v).entries()]
          .filter(([t]) => TR.get(t)?.kind === 'treatment');
        if (!treatments.length) continue;
        standard += 1;
        if (treatments.every(([, n]) => n === 0)) standardZero += 1;
      }
      console.log(`  standard VOs prescribing zero units: ${standardZero} of ${standard} sampled`);
      expect(standard, 'the standard comparison is not vacuous').toBeGreaterThan(5);
      expect(standardZero, 'a standard VO always carries a real budget').toBe(0);

      // Every over-budget case on staging is a Blanko one — AC4's scope, measured.
      const overNumbers = unitsCases.map((c) => c.number);
      console.log(`  VOs over their prescribed units in the scanned pool: ${JSON.stringify(overNumbers)}`);
      for (const c of unitsCases) {
        const vo = await page.prescription(c.id);
        expect(vo.blankoVO, `${c.number} is over its budget, and is a Blanko VO`).toBe(true);
      }
    },
  );

  test(
    'coverage: which insurance types and which failing rows staging can exercise',
    { tag: ['@SuperAdmin', '@BlankoBillingValidation', '@ReadOnly'] },
    async () => {
      // #3841 AC1 names four insurance types; #3842 AC1 names two failing rows. Measured rather
      // than assumed, so the gaps are on the record instead of being silently untested.
      const byType: Record<string, number> = {};
      const bvIds = [...TR.values()].filter((t) => t.bv).map((t) => t.id);
      const seen = new Map<number, any>();
      for (const id of bvIds.slice(0, 12)) {
        const b = await page.get<any>(`/prescriptions?itemsPerPage=120&treatment=${id}`);
        for (const vo of b.member ?? []) seen.set(vo.id, vo);
      }
      for (const vo of seen.values()) {
        const k = String(vo.insuranceType ?? 'none');
        byType[k] = (byType[k] ?? 0) + 1;
      }
      console.log(`  Blanko VOs by insurance type (any status): ${JSON.stringify(byType)}`);
      const missing = ['public', 'private', 'accident', 'privat_basis'].filter((t) => !byType[t]);
      if (missing.length) {
        console.log(`  → #3841 AC1 names four types; staging has no Blanko VO for: ${JSON.stringify(missing)}`);
        console.log('    The fix is an early return before any type is consulted, so it cannot');
        console.log('    differ by type — but those rows are unexercised here.');
      }
      const areas = [...new Set([...TR.values()].filter((t) => t.bv).map((t) => t.area))];
      console.log(`  Blanko positions exist for areas ${JSON.stringify(areas)} — none for SSSST,`);
      console.log('    which is why #3842 AC1 says Logopädie has no Blanko positions.');
      expect(areas.sort(), 'PT and ERGO only').toEqual(['ERGO', 'PT']);
      expect(Object.keys(byType).length, 'Blanko VOs exist').toBeGreaterThan(0);
    },
  );
});
