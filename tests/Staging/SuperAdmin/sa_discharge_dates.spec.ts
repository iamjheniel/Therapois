import { test, expect } from '../../fixtures/session';
import { DischargeDatesPage, type Vo } from '../../../Pages/superadmin/sa.discharge-dates.page';

/**
 * RC 3.14 — #3830: a discharge VO (Entlassmanagement) SHOWS day 7 as its start deadline and day 12
 * as its valid-until date, on every screen, and the existing expiring warnings follow those dates.
 *
 * The display counterpart to #3800, which made the nightly check close the same VOs on the same two
 * days. Shipped as `4b1722ce7` (api, adding the shared `DischargeWindow`) + `a394b0af8` (app).
 *
 * Read-only: every request is a GET except the transient creation-validation preview, which
 * hydrates a throwaway Prescription and writes nothing (#3576).
 */

const P = DischargeDatesPage;

test.describe('#3830 discharge VO start deadline and validity', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);

  let sa: DischargeDatesPage;

  test.beforeAll(async () => {
    sa = new DischargeDatesPage();
    await sa.connect();
    // ONE round trip for every fixture the API tests read: 33 VOs by `prescriptionId[]=` plus all
    // their activities by `prescription[]=`, ~7 s together against ~100 s fetched one at a time.
    const t0 = Date.now();
    const vos = await sa.prefetch();
    console.log(`  prefetched ${vos.length} VOs + their sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    'DEPLOYED on both halves, decided behaviourally — /status answers for neither',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async ({ page }) => {
      // The API half: the two serialized fields ARE the feature, so they are the probe. The
      // non-discharge control is mandatory — both fields are legitimately null on many VOs, so
      // "a discharge VO serves +7/+12" only means something beside a VO that serves +28.
      const d = await sa.voByNumber(P.AC8.gkvNoSession.vo);
      expect(d, `fixture ${P.AC8.gkvNoSession.vo}`).not.toBeNull();
      expect(d!.isDischargeManagement).toBe(true);
      expect(P.daysBetween(d!.date, d!.treatmentStartDeadline!), 'discharge start deadline').toBe(7);
      expect(P.daysBetween(d!.date, d!.validityDate!), 'discharge validity').toBe(12);

      const c = await sa.voByNumber(P.NON_DISCHARGE_CONTROL);
      expect(c, `control ${P.NON_DISCHARGE_CONTROL}`).not.toBeNull();
      expect(c!.isDischargeManagement ?? false, 'the control is not a discharge VO').toBeFalsy();
      expect(P.daysBetween(c!.date, c!.treatmentStartDeadline!), 'ordinary start deadline').toBe(28);
      console.log(`  api: ${d!.prescriptionId} +7/+12 vs control ${c!.prescriptionId} +28`);

      // The app half. The commit adds `isDischargeManagement` to the start-deadline check's
      // dependency list, and that array survives minification verbatim as string keys — so the
      // THIRD entry is the probe. Before the fix it was ['issueDate','insuranceType'], which is
      // why the marker did not re-run the check (AC6's second paragraph).
      const dd = new DischargeDatesPage(page);
      const bundle = await dd.entryBundle();
      const deps = bundle.match(/start_deadline_warning:\[[^\]]*\]/);
      console.log(`  bundle dependency array: ${deps?.[0]}`);
      expect(deps, 'the check declares a dependency list').not.toBeNull();
      expect(deps![0], 'AC6: ticking the marker re-runs the check').toContain('isDischargeManagement');
      expect(deps![0]).toContain('issueDate');
      expect(deps![0]).toContain('insuranceType');

      // ...and the banner's timezone fix, which is in the same commit and in no AC.
      expect(P.occurrences(bundle, 'daysUntilExpiry'), 'the banner counts in days').toBeGreaterThan(0);

      // Neither `DischargeWindow` nor `getOrdinaryTreatmentStartDeadline` may appear: both are
      // API-only, so finding them would mean the probe is reading the wrong artifact.
      expect(P.occurrences(bundle, 'DischargeWindow'), 'API-only symbol absent from the bundle').toBe(0);
    },
  );

  test(
    "AC8: the ticket's own four fixtures match its own 'After this ticket' column exactly",
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async () => {
      // AC8 states both the before and the after for four named VOs, which makes it the one AC that
      // can be checked against the ticket's own arithmetic rather than against a re-derivation.
      const a = await sa.voByNumber(P.AC8.gkvNoSession.vo);
      expect(P.iso(a!.date)).toBe(P.AC8.gkvNoSession.issue);
      expect(P.iso(a!.treatmentStartDeadline), 'Startfrist').toBe(P.AC8.gkvNoSession.startDeadline);
      expect(P.iso(a!.validityDate), 'Gültig bis').toBe(P.AC8.gkvNoSession.validity);

      const b = await sa.voByNumber(P.AC8.gkvStarted.vo);
      expect(P.iso(b!.date)).toBe(P.AC8.gkvStarted.issue);
      expect(P.iso(b!.treatmentStartDeadline), 'Behandlungsstartfrist').toBe(P.AC8.gkvStarted.startDeadline);
      expect(P.iso(b!.validityDate), 'Gültigkeitsdatum').toBe(P.AC8.gkvStarted.validity);
      console.log(`  ${a!.prescriptionId}: ${P.de(a!.treatmentStartDeadline!)} / ${P.de(a!.validityDate!)}`);
      console.log(`  ${b!.prescriptionId}: ${P.de(b!.treatmentStartDeadline!)} / ${P.de(b!.validityDate!)}`);

      // 99700-1 is the sharper of the two: its validity was 22.12.2026 under the ordinary Physio
      // rule (three months from its first session), so the new date is ~81 days EARLIER — the
      // discharge branch overrides a rule that was producing a perfectly plausible value.
      const firstBeh = await sa.firstTreatmentDate(b!.id);
      expect(firstBeh, '99700-1 has a session').not.toBeNull();
      console.log(`  ${b!.prescriptionId} first session ${firstBeh} — ordinary Physio validity would be ~3 months out`);
      expect(P.daysBetween(b!.date, b!.validityDate!), 'validity is measured from ISSUE, not the session').toBe(12);

      // The two unchanged rows. Both are discharge VOs, so they also show that the marker alone is
      // not what moves the dates — the insurance type decides (AC3).
      for (const [fx, days] of [
        [P.AC8.bg, P.AC8.bg.startDays],
        [P.AC8.noType, P.AC8.noType.startDays],
      ] as const) {
        const vo = await sa.voByNumber(fx.vo);
        expect(vo, fx.vo).not.toBeNull();
        expect(vo!.isDischargeManagement, `${fx.vo} is marked Entlassmanagement`).toBe(true);
        expect(P.daysBetween(vo!.date, vo!.treatmentStartDeadline!), `${fx.vo} keeps today's deadline`).toBe(days);
        expect(vo!.validityDate ?? null, `${fx.vo} gets no discharge validity`).toBeNull();
        console.log(`  ${fx.vo} (${vo!.insuranceType ?? 'unset'}): +${days}, no validity — unchanged`);
      }
    },
  );

  test(
    "AC1/AC2: both dates are issue+7 and issue+12, and they never move whatever happens to the VO",
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async () => {
      // AC2 is a four-row table of SITUATIONS, and all four have live fixtures — so rather than
      // constructing them, the population is classified and every row required to occur. A test
      // that only checked "no session" would be satisfied by a build that recomputed from the
      // first session, which is exactly the pre-fix behaviour for the validity date.
      const fixtures = [
        P.AC8.gkvNoSession.vo,
        P.AC8.gkvStarted.vo,
        P.STARTED_ON_DAY_7,
        P.STARTED_ON_DAY_8,
        P.BLANKO_DISCHARGE,
        '99663-1', '99664-1', '99666-1', '99668-1', '99674-1', '99675-1', '99677-1', '99678-1', '99679-1',
      ];

      const bySession: Record<string, string[]> = {};
      const closed: string[] = [];
      const wrong: string[] = [];

      for (const number of fixtures) {
        const vo = await sa.voByNumber(number);
        if (!vo) continue;
        if (!P.inScope(vo)) {
          wrong.push(`${number}: not in scope (${vo.insuranceType}, discharge=${vo.isDischargeManagement})`);
          continue;
        }
        const firstBeh = await sa.firstTreatmentDate(vo.id);
        (bySession[P.sessionState(vo, firstBeh)] ??= []).push(number);
        if (P.isClosed(vo)) closed.push(`${number} (${vo.treatmentStatus})`);

        if (P.iso(vo.treatmentStartDeadline) !== P.expectedStartDeadline(vo)) {
          wrong.push(`${number}: start ${P.iso(vo.treatmentStartDeadline)} != issue+7 ${P.expectedStartDeadline(vo)}`);
        }
        if (P.iso(vo.validityDate) !== P.expectedValidity(vo)) {
          wrong.push(`${number}: validity ${P.iso(vo.validityDate)} != issue+12 ${P.expectedValidity(vo)}`);
        }
      }

      for (const [k, v] of Object.entries(bySession)) console.log(`  ${k}: ${v.join(', ')}`);
      console.log(`  closed: ${closed.join(', ')}`);
      for (const w of wrong) console.log(`    ${w}`);
      expect(wrong, 'every in-scope discharge VO shows issue+7 / issue+12').toHaveLength(0);

      // All four of AC2's rows must actually occur, or the invariant is satisfied vacuously. The
      // session axis and the closed axis are asked SEPARATELY, because the rows overlap: most of
      // these fixtures are both closed and carry a session history.
      expect(bySession['no-session'] ?? [], 'AC2 row 1 — no session yet').not.toHaveLength(0);
      expect(bySession['started-in-time'] ?? [], 'AC2 row 2 — first session by day 7').not.toHaveLength(0);
      expect(bySession['started-late'] ?? [], 'AC2 row 3 — first session after day 7').not.toHaveLength(0);
      expect(closed, 'AC2 row 4 — closed VO').not.toHaveLength(0);

      // AC2's closed row names five statuses; require more than one to occur so the row is not
      // carried by a single status.
      const closedStatuses = new Set(closed.map((c) => c.replace(/^.*\(|\)$/g, '')));
      console.log(`  closed statuses covered: ${[...closedStatuses].join(', ')}`);
      expect(closedStatuses.size, 'more than one closed status is exercised').toBeGreaterThan(1);

      // The BOUNDARY, which is what separates "shows the window" from "shows something plausible":
      // one VO's first session is ON day 7 and another's on day 8, and both show the same dates.
      const on7 = await sa.voByNumber(P.STARTED_ON_DAY_7);
      const on8 = await sa.voByNumber(P.STARTED_ON_DAY_8);
      const beh7 = await sa.firstTreatmentDate(on7!.id);
      const beh8 = await sa.firstTreatmentDate(on8!.id);
      expect(P.daysBetween(on7!.date, beh7!), `${P.STARTED_ON_DAY_7} starts on day 7`).toBe(7);
      expect(P.daysBetween(on8!.date, beh8!), `${P.STARTED_ON_DAY_8} starts on day 8`).toBe(8);
      console.log(`  boundary: ${P.STARTED_ON_DAY_7} day 7 and ${P.STARTED_ON_DAY_8} day 8 both show +7/+12`);

      // AC1's own note, as a CONTRAST rather than an assertion about one VO: a discharge VO with no
      // session shows day 12, where a non-discharge VO with no session shows nothing at all,
      // because the ordinary Physio validity only starts at the first treatment.
      const none = await sa.voByNumber(P.NON_DISCHARGE_NO_SESSION);
      expect(none, P.NON_DISCHARGE_NO_SESSION).not.toBeNull();
      expect(await sa.firstTreatmentDate(none!.id), 'the control has no session').toBeNull();
      expect(none!.validityDate ?? null, 'a non-discharge VO with no session has no validity').toBeNull();
      expect(P.iso(on7!.validityDate), 'a discharge VO shows day 12 regardless').not.toBeNull();
      console.log(`  contrast: ${none!.prescriptionId} (no session, not discharge) validity = none`);
    },
  );

  test(
    'AC3: the new dates apply to GKV and Privat Basis only, and the marker alone does not move them',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async () => {
      const rows: string[] = [];

      for (const number of [P.AC8.gkvNoSession.vo, P.PRIVAT_BASIS_DISCHARGE]) {
        const vo = await sa.voByNumber(number);
        expect(vo, number).not.toBeNull();
        expect(vo!.isDischargeManagement).toBe(true);
        expect(P.DISCHARGE_TYPES).toContain(vo!.insuranceType);
        expect(P.daysBetween(vo!.date, vo!.treatmentStartDeadline!)).toBe(7);
        expect(P.daysBetween(vo!.date, vo!.validityDate!)).toBe(12);
        rows.push(`${number} ${vo!.insuranceType}: +7 / +12  NEW DATES`);
      }

      // PKV is excluded from expiry entirely (#3709), so a PKV discharge VO carries neither date.
      // Pre-existing, but it is exactly what AC3's PKV row observes.
      const pkv = await sa.voByNumber(P.PKV_DISCHARGE);
      expect(pkv, P.PKV_DISCHARGE).not.toBeNull();
      expect(pkv!.insuranceType).toBe('private');
      expect(pkv!.isDischargeManagement).toBe(true);
      expect(pkv!.treatmentStartDeadline ?? null, 'PKV: no start deadline').toBeNull();
      expect(pkv!.validityDate ?? null, 'PKV: no validity').toBeNull();
      rows.push(`${P.PKV_DISCHARGE} private: none / none  TODAY'S DATES`);

      for (const fx of [P.AC8.bg, P.AC8.noType] as const) {
        const vo = await sa.voByNumber(fx.vo);
        expect(P.daysBetween(vo!.date, vo!.treatmentStartDeadline!)).toBe(fx.startDays);
        rows.push(`${fx.vo} ${vo!.insuranceType ?? 'unset'}: +${fx.startDays} / none  TODAY'S DATES`);
      }

      // "A VO that is not marked Entlassmanagement keeps today's dates" — the other half of the
      // rule, and the one a blanket change to the presenter would break.
      const plain = await sa.voByNumber(P.NON_DISCHARGE_CONTROL);
      expect(plain!.isDischargeManagement ?? false).toBeFalsy();
      expect(P.daysBetween(plain!.date, plain!.treatmentStartDeadline!)).toBe(28);
      expect(P.daysBetween(plain!.date, plain!.validityDate!), 'and its validity is not issue+12').not.toBe(12);
      rows.push(`${P.NON_DISCHARGE_CONTROL} not marked: +28 / +${P.daysBetween(plain!.date, plain!.validityDate!)}  TODAY'S DATES`);

      for (const r of rows) console.log(`  ${r}`);
    },
  );

  test(
    'AC4: every therapy type, a Blanko discharge VO, and day 7 beating the 14-day urgent deadline',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly', '@Slow'] },
    async () => {
      // AC4's urgent clause is the one most likely to be got wrong, because the ordinary rule has
      // its OWN 14-day branch for an urgent VO — so "day 7 and day 12 win" means the discharge
      // branch must be reached BEFORE it. That has live fixtures rather than needing a construction.
      // The population is PINNED, not walked: `?isDischargeManagement=` is silently ignored and a
      // re-derivation costs ~10 minutes (one 100-row page measures ~26 s and `itemsPerPage=1000`
      // 504s). These are the VOs that walk returned, and they span both therapy types present,
      // urgent and non-urgent, Blanko, five statuses and all five insurance types. Sound to pin
      // because the window comes from ONE shared `DischargeWindow`, so a regression hits all of
      // them; the re-derivation recipe is on `DISCHARGE_POPULATION`.
      const inScope = sa.dischargePopulation();
      const urgent = inScope.filter((v) => v.urgentTreatmentNeed === true);
      const byTherapy = inScope.reduce<Record<string, number>>((a, v) => {
        const k = v.therapyType ?? 'none';
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  pinned discharge population: ${inScope.length} in scope`);
      console.log(`  by therapy type: ${JSON.stringify(byTherapy)}`);
      console.log(`  urgentTreatmentNeed true: ${urgent.length} (${urgent.map((v) => v.prescriptionId).join(', ')})`);

      const wrong = inScope.filter(
        (v) =>
          P.iso(v.treatmentStartDeadline) !== P.expectedStartDeadline(v) ||
          P.iso(v.validityDate) !== P.expectedValidity(v),
      );
      for (const v of wrong) {
        console.log(`    ${v.prescriptionId}: ${P.iso(v.treatmentStartDeadline)} / ${P.iso(v.validityDate)}`);
      }
      expect(wrong, 'every in-scope discharge VO in the window shows +7/+12').toHaveLength(0);
      expect(inScope.length, 'the window holds a real population').toBeGreaterThan(0);

      // The urgent clause, asserted rather than merely counted: an urgent discharge VO must read 7,
      // NOT the 14 its urgency would otherwise earn it.
      expect(urgent.length, 'AC4: urgent discharge VOs exist to test against').toBeGreaterThan(0);
      for (const v of urgent) {
        expect(P.daysBetween(v.date, v.treatmentStartDeadline!), `${v.prescriptionId} urgent -> day 7 wins over 14`).toBe(7);
      }

      // More than one therapy type must occur, or "applies to every therapy type" is vacuous.
      expect(Object.keys(byTherapy).length, 'AC4: more than one therapy type in the population').toBeGreaterThan(1);

      // AC4's Blanko clause. A Blanko VO takes its own validity branch in the ordinary rules
      // (#3709), so it is a genuinely separate path the discharge branch has to win.
      const blanko = await sa.voByNumber(P.BLANKO_DISCHARGE);
      expect(blanko, P.BLANKO_DISCHARGE).not.toBeNull();
      expect(blanko!.blankoVO, `${P.BLANKO_DISCHARGE} is Blanko`).toBe(true);
      expect(blanko!.isDischargeManagement).toBe(true);
      expect(P.daysBetween(blanko!.date, blanko!.treatmentStartDeadline!), 'Blanko start').toBe(7);
      expect(P.daysBetween(blanko!.date, blanko!.validityDate!), 'Blanko validity').toBe(12);
      console.log(`  Blanko discharge VO ${P.BLANKO_DISCHARGE}: +7 / +12`);
    },
  );

  test(
    "AC6: the VO form's 'Startfrist überschritten' check follows day 7, and only for a discharge VO",
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async () => {
      // Driven through the CREATE FORM'S OWN endpoint, which writes nothing (#3576) — so the
      // boundary is exercised exactly, on both sides, without creating a VO.
      //
      // The registry is keyed by `description`; there is NO `code` field on this resource, and a
      // lookup by `code` silently finds nothing, which makes every verdict read `undefined` and the
      // whole table print as inapplicable (that is how this test first failed).
      const V = await sa.validations();
      const check = V[P.START_DEADLINE_WARNING];
      expect(check, `/validations carries ${P.START_DEADLINE_WARNING}`).toBeTruthy();
      expect(check.timing, 'it is a VO-creation check').toBe('vo_creation');
      console.log(`  check ${check['@id']} timing=${check.timing} types=${JSON.stringify(check.applicableInsuranceTypes)}`);

      const iri = await sa.physioTreatmentIri();
      const today = new Date().toISOString().slice(0, 10);
      const back = (n: number) => P.addDays(today, -n);

      const verdict = async (daysBack: number, discharge: boolean, insuranceType = 'public') => {
        const b = await sa.previewCreationChecks({
          issueDate: back(daysBack),
          discharge,
          insuranceType,
          treatmentIri: iri,
        });
        const row = b.results.find((r) => r.validation === check['@id']);
        return { passed: row?.passed ?? null, note: row?.autoNote ?? null, checked: b.checked };
      };

      // The preview is transient and writes nothing, so the whole table can go out at once —
      // ~1.3 s each sequentially, ~2 s for all nine in parallel.
      const [at7, at8, plainAt8, ord28, ord29, pb7, pb8, pkv8, bg13, bg15] = await Promise.all([
        verdict(7, true),
        verdict(8, true),
        verdict(8, false),
        verdict(28, false),
        verdict(29, false),
        verdict(7, true, 'privat_basis'),
        verdict(8, true, 'privat_basis'),
        verdict(8, true, 'private'),
        verdict(13, true, 'accident'),
        verdict(15, true, 'accident'),
      ]);

      // AC6's own two cases, in its own words: 7 days back passes, 8 days back fails with the note.
      console.log(`  discharge, issued ${back(7)} (7 days back): passed=${at7.passed}`);
      console.log(`  discharge, issued ${back(8)} (8 days back): passed=${at8.passed} note=${(at8.note ?? '').slice(0, 60)}`);
      expect(at7.passed, 'AC6: 7 days back passes').toBe(true);
      expect(at8.passed, 'AC6: 8 days back fails').toBe(false);
      expect(at8.note, 'AC6: with the start-deadline note').toBe(P.START_DEADLINE_NOTE);

      // THE DISCRIMINATOR, and the reason this test can fail on a build without the fix: on the
      // SAME day, with the same insurance type, the marker alone flips the verdict.
      console.log(`  NOT discharge, issued ${back(8)}: passed=${plainAt8.passed}`);
      expect(plainAt8.passed, 'a non-discharge VO at 8 days back still passes').toBe(true);

      // ...and the ordinary 28-day rule is untouched, which is what makes the above a narrowing
      // rather than a wholesale change.
      expect(ord28.passed, 'ordinary: 28 days back passes').toBe(true);
      expect(ord29.passed, 'ordinary: 29 days back fails').toBe(false);
      console.log(`  ordinary boundary intact: 28 passes, 29 fails`);

      // AC3 on the check as well as on the dates.
      expect(pb7.passed, 'Privat Basis: 7 passes').toBe(true);
      expect(pb8.passed, 'Privat Basis: 8 fails').toBe(false);
      // PKV is not in the check's own insurance list, so it is not evaluated at all — null, not false.
      expect(pkv8.passed, 'PKV: the check does not apply').toBeNull();
      // BG keeps its 14 days even when marked Entlassmanagement, per AC3.
      expect(bg13.passed, 'BG: 13 days back passes').toBe(true);
      expect(bg15.passed, 'BG: 15 days back fails').toBe(false);
      console.log(`  privat_basis follows day 7; PKV not evaluated; BG keeps 14`);
    },
  );

  test(
    'AC7: the Therapeuten-Orga "VO läuft ab ≤ 7 T" tile follows the new valid-until date',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly', '@Slow'] },
    async () => {
      // The warnings were deliberately NOT changed — they read `validityDate`, so they follow the
      // new date for free. That makes the tile a real end-to-end check of the API change, and it is
      // falsifiable: one fixture is inside the 7-day window and the other is not.
      const near = await sa.voByNumber(P.AC8.gkvStarted.vo); // valid issue+12
      const far = await sa.voByNumber(P.AC8.gkvNoSession.vo);
      const today = new Date().toISOString().slice(0, 10);
      const dNear = P.daysBetween(today, P.iso(near!.validityDate)!);
      const dFar = P.daysBetween(today, P.iso(far!.validityDate)!);
      console.log(`  today ${today}: ${near!.prescriptionId} valid in ${dNear} d, ${far!.prescriptionId} valid in ${dFar} d`);

      const { tile, voNumbers } = await sa.laeuftAb();
      console.log(`  laeuftAb tile ${tile}, rows ${voNumbers.size}`);
      expect(tile, 'the tile count equals its row count').toBe(voNumbers.size);

      // Only assert the side of the window each fixture is actually on — the fixtures age, so
      // hard-coding "near is on the tile" would fail once its window closes.
      if (dNear >= 0 && dNear <= 7) {
        expect(voNumbers.has(near!.prescriptionId), `${near!.prescriptionId} is within 7 days and must be listed`).toBe(true);
        console.log(`  ${near!.prescriptionId} IS on the tile — and under the ordinary Physio rule its`);
        console.log(`  validity was ~3 months out, so it could not have appeared before this ticket`);
      } else {
        console.log(`  ${near!.prescriptionId} is outside the window today (${dNear} d) — not asserted`);
      }
      if (dFar > 7) {
        expect(voNumbers.has(far!.prescriptionId), `${far!.prescriptionId} is beyond 7 days and must NOT be listed`).toBe(false);
        console.log(`  ${far!.prescriptionId} is NOT on the tile, correctly — the window is still 7 days`);
      }

      // At least one of the two must have been decidable, or the test proved nothing.
      expect((dNear >= 0 && dNear <= 7) || dFar > 7, 'at least one fixture sits decidably inside or outside').toBe(true);
    },
  );

  test(
    'AC5: the VO form side panel shows the new dates',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async ({ page }) => {
      // The ticket's own second screenshot: "Wichtige Termine" on the VO form of 99700-1, which it
      // predicts will read 27.09.2026 and 02.10.2026.
      const dd = new DischargeDatesPage(page);
      await dd.signIn();

      const vo = await sa.voByNumber(P.AC8.gkvStarted.vo);
      expect(vo, P.AC8.gkvStarted.vo).not.toBeNull();
      await dd.openVoForm(vo!.id);

      const start = await dd.panelDate(P.GERMAN.startDeadline);
      const validity = await dd.panelDate(P.GERMAN.validityDate);
      console.log(`  ${vo!.prescriptionId}: ${P.GERMAN.startDeadline} = ${start}, ${P.GERMAN.validityDate} = ${validity}`);

      expect(start, 'the panel paints a start deadline').toBeTruthy();
      expect(start, `${P.GERMAN.startDeadline} shows day 7`).toContain(P.de(vo!.treatmentStartDeadline!));
      expect(validity, `${P.GERMAN.validityDate} shows day 12`).toContain(P.de(vo!.validityDate!));

      // ...and they are the ticket's own predicted strings, not merely self-consistent.
      expect(start).toContain(P.de(P.AC8.gkvStarted.startDeadline));
      expect(validity).toContain(P.de(P.AC8.gkvStarted.validity));
    },
  );

  test(
    'AC5: the Therapist Board deadlines column shows the new dates',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async ({ page }) => {
      // The ticket's FIRST screenshot. `deadlines` is a default column, so nothing is enabled; the
      // cell is read with textContent because its sub-labels are CSS-uppercased (#3718).
      const dd = new DischargeDatesPage(page);
      await dd.signIn();
      await dd.openTherapistBoard(P.BOARD_THERAPIST);

      const noSession = await sa.voByNumber(P.AC8.gkvNoSession.vo);
      const started = await sa.voByNumber(P.AC8.gkvStarted.vo);

      const cellA = await dd.boardDeadlines(P.AC8.gkvNoSession.vo);
      const cellB = await dd.boardDeadlines(P.AC8.gkvStarted.vo);
      console.log(`  ${P.AC8.gkvNoSession.vo} deadlines cell: ${JSON.stringify(cellA)}`);
      console.log(`  ${P.AC8.gkvStarted.vo} deadlines cell: ${JSON.stringify(cellB)}`);

      test.skip(cellA === null && cellB === null, 'neither AC8 fixture is painted on this board page');

      if (cellA) {
        // No session yet, so the cell carries BOTH new dates — and these are the ticket's own
        // predicted strings, not merely dates consistent with the payload.
        expect(cellA, 'Startfrist shows day 7').toContain(P.de(noSession!.treatmentStartDeadline!));
        expect(cellA, 'Gültig bis shows day 12').toContain(P.de(noSession!.validityDate!));
        expect(cellA).toContain(P.de(P.AC8.gkvNoSession.startDeadline));
        expect(cellA).toContain(P.de(P.AC8.gkvNoSession.validity));
        // It must NOT still show the ordinary 28-day deadline, which is what the ticket screenshots.
        expect(cellA, 'the pre-fix 25.10.2026 is gone').not.toContain('25.10.2026');
      }
      if (cellB) {
        // AC2's closing note: a screen that shows "Begonnen" in place of the start deadline once a
        // session is carried out keeps doing so. Asserted, because it is the one place the new
        // start deadline is deliberately NOT painted — and its validity is still day 12.
        expect(cellB, 'AC2: a started VO still shows Begonnen').toContain(P.GERMAN.started);
        expect(cellB, 'Gültig bis shows day 12').toContain(P.de(started!.validityDate!));
        expect(cellB).toContain(P.de(P.AC8.gkvStarted.validity));
        // The pre-fix value was three months out under the ordinary Physio rule.
        expect(cellB, 'the pre-fix 22.12.2026 is gone').not.toContain('22.12.2026');
      }
    },
  );

  test(
    'AC9 — FINDING: the billing check cannot be attributed read-only, and why',
    { tag: ['@SuperAdmin', '@DischargeDates', '@ReadOnly'] },
    async () => {
      // AC9 is a "what stays as it is": the BILLING check `treatment_start_deadline`
      // ("Behandlungsbeginnfrist") must keep the ordinary 28/14-day deadline until #3808, and the
      // commit does that by keeping `Prescription::getOrdinaryTreatmentStartDeadline()` reachable
      // on its own — a method that is deliberately NOT serialized, so no field exposes it.
      const V = await sa.validations();
      const billing = V[P.BILLING_START_DEADLINE];
      expect(billing, `/validations carries ${P.BILLING_START_DEADLINE}`).toBeTruthy();
      expect(billing.timing, 'it is a BILLING check, so no creation preview reaches it').toBe('billing');
      console.log(`  check ${billing['@id']} timing=${billing.timing}`);

      // The only read-only surface is a STORED verdict, and a verdict is written only when a VO is
      // saved or re-checked (#3576). So the question is whether any discriminating VO has one: a
      // discharge VO whose first session falls between day 8 and its ordinary limit is LATE under
      // the discharge rule and fine under the ordinary one, so its verdict separates the two.
      const candidates = [P.STARTED_ON_DAY_8, '9489-1'];
      const report: string[] = [];
      let decidable = 0;

      for (const number of candidates) {
        const vo = await sa.voByNumber(number);
        if (!vo) continue;
        const firstBeh = await sa.firstTreatmentDate(vo.id);
        if (!firstBeh) continue;
        const gap = P.daysBetween(vo.date, firstBeh);
        const limit = vo.urgentTreatmentNeed === true ? 14 : 28;
        const lateUnderDischarge = gap > P.START_DAYS;
        const fineUnderOrdinary = gap <= limit;
        const verdicts = await sa.storedVerdicts(vo.id, billing.id);
        if (lateUnderDischarge && fineUnderOrdinary && verdicts.length > 0) decidable++;
        report.push(
          `${number}: gap ${gap} d, late-under-discharge=${lateUnderDischarge}, fine-under-ordinary=${fineUnderOrdinary}, stored verdicts=${verdicts.length}`,
        );
      }
      for (const r of report) console.log(`  ${r}`);

      // The finding: discriminating VOs exist, and none of them carries a verdict — so AC9 is
      // structurally unreachable read-only. Producing one means POSTing
      // /prescriptions/{id}/check-billing-validation, which RE-CREATES the VO's billing verdict
      // rows (measured: the returned ids are new), i.e. a write to live billing-validation state
      // that can move a VO on or off the billing Validierung queue. Not done here.
      console.log('  => AC9 needs ONE call a PM can make: POST /prescriptions/<id>/check-billing-validation');
      console.log(`     on ${P.STARTED_ON_DAY_8} (first session day 8) and reading check ${billing['@id']};`);
      console.log('     it must PASS, because billing keeps the ordinary 28-day deadline until #3808.');
      expect(decidable, 'no discriminating VO carries a stored billing verdict').toBe(0);
    },
  );
});
