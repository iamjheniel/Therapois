import { test, expect } from '@playwright/test';
import {
  GAP_PERIOD,
  HoursRow,
  LEGEND,
  PersonioDayEfficiencyPage,
  TOOLTIP,
  WARN_EFFICIENCY,
  WARNING_STRADDLE_PERIOD,
} from '../../../Pages/superadmin/sa.personio-day-efficiency.page';

/**
 * RC 3.13 #3666 — Effizienz and €/Stunde must count only days where Personio has an entry, on both
 * the Management and the Therapeuten-Orga Arbeitszeiten tables. Shipped as `bc5da6887`.
 *
 * **Read-only — every request is a GET.**
 *
 * The whole file rests on one thing: the fix added the qualifying-day numerators to the payload, so
 * the old and new formulas are separable from a single read and "which rule is live" is a fact
 * rather than an inference. See the page object for the two formulas, the fixture period, and the
 * traps — above all that the "Personio fehlt" tag is *not* the set of affected rows and that the
 * time columns deliberately no longer divide into Effizienz.
 */
test.describe('#3666 Effizienz and €/Stunde over Personio days only', () => {
  let kpi: PersonioDayEfficiencyPage;
  let rows: HoursRow[];
  let discriminating: HoursRow[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    const page = await browser.newPage();
    kpi = new PersonioDayEfficiencyPage(page);
    await kpi.connect();
    rows = await kpi.hoursRows(GAP_PERIOD);
    discriminating = PersonioDayEfficiencyPage.discriminating(rows);
    console.log(
      `#3666 ${GAP_PERIOD.label}: ${rows.length} Arbeitszeiten rows, ` +
        `${discriminating.length} where the two formulas differ (the only ones that can tell the build apart)`,
    );
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    kpi = new PersonioDayEfficiencyPage(page);
    await kpi.connect();
  });

  test(
    'the fixture period actually contains gap days',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      // Without this the whole file passes vacuously: on a period where nobody has a day with
      // treated time and no Personio entry, the old and new formulas agree everywhere.
      expect(rows.length, 'the table must have rows').toBeGreaterThan(0);
      expect(discriminating.length, `${GAP_PERIOD.label} must contain therapists with a Personio gap`).toBeGreaterThan(0);

      // And the reason the period matters, on the record: the board's DEFAULT period is almost
      // entirely non-discriminating, so a verification run there cannot tell the two builds apart.
      const defaultRows = await kpi.defaultHoursRows();
      const defaultDiscriminating = PersonioDayEfficiencyPage.discriminating(defaultRows);
      console.log(
        `#3666 fixture choice: ${discriminating.length}/${rows.length} rows discriminate in ${GAP_PERIOD.label}, ` +
          `but only ${defaultDiscriminating.length}/${defaultRows.length} in the board's default period — ` +
          `a run there would pass on either build`,
      );
      expect(
        discriminating.length,
        'the chosen period must discriminate far better than the default one',
      ).toBeGreaterThan(defaultDiscriminating.length);

      const spread = discriminating
        .map((r) => ({
          name: r.therapistName,
          shipped: PersonioDayEfficiencyPage.qualifyingEfficiency(r)!,
          old: PersonioDayEfficiencyPage.wholePeriodEfficiency(r)!,
        }))
        .sort((a, b) => b.old - b.shipped - (a.old - a.shipped));
      console.log(`#3666 widest corrections:`);
      for (const s of spread.slice(0, 5)) {
        console.log(`   ${s.name.padEnd(26)} ${s.shipped.toFixed(2)}%  (the old rule gave ${s.old.toFixed(2)}%)`);
      }
      // The ticket's complaint is inflation, so the correction must always be downward.
      for (const s of spread) {
        expect(s.shipped, `${s.name}: the qualifying-day figure cannot exceed the whole-period one`).toBeLessThanOrEqual(s.old + 0.001);
      }
    },
  );

  test(
    'AC1 Effizienz is the qualifying-day ratio, and is not the whole-period one',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      let matchedNew = 0;
      let matchedOld = 0;
      const neither: string[] = [];
      for (const row of rows) {
        if (null === row.efficiency) continue;
        const shipped = PersonioDayEfficiencyPage.qualifyingEfficiency(row);
        const old = PersonioDayEfficiencyPage.wholePeriodEfficiency(row);
        // The served value is rounded to 2 dp, so compare with a tolerance that cannot swallow a
        // real formula difference (the smallest one in this period is ~0.3 points).
        if (null !== shipped && Math.abs(row.efficiency - shipped) < 0.06) matchedNew += 1;
        else if (null !== old && Math.abs(row.efficiency - old) < 0.06) matchedOld += 1;
        else neither.push(`${row.therapistName}: served ${row.efficiency}, qualifying ${shipped}, whole ${old}`);
      }
      console.log(`#3666 AC1: qualifying-day formula ${matchedNew} | whole-period ${matchedOld} | neither ${neither.length}`);
      for (const n of neither.slice(0, 6)) console.log(`   ${n}`);

      expect(neither, 'every published Effizienz must be one of the two formulas').toEqual([]);
      expect(matchedOld, 'no row may still use the whole-period rule').toBe(0);
      expect(matchedNew, 'every row uses the qualifying-day rule').toBeGreaterThan(0);
    },
  );

  test(
    'AC2 €/Stunde is the qualifying-day ratio too',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      let matchedNew = 0;
      let matchedOld = 0;
      const neither: string[] = [];
      for (const row of rows) {
        if (null === row.revenuePerHour) continue;
        const shipped = PersonioDayEfficiencyPage.qualifyingRevenuePerHour(row);
        const old = PersonioDayEfficiencyPage.wholePeriodRevenuePerHour(row);
        if (null !== shipped && Math.abs(row.revenuePerHour - shipped) < 0.02) matchedNew += 1;
        else if (null !== old && Math.abs(row.revenuePerHour - old) < 0.02) matchedOld += 1;
        else neither.push(`${row.therapistName}: served ${row.revenuePerHour}, qualifying ${shipped}, whole ${old}`);
      }
      console.log(`#3666 AC2: qualifying-day formula ${matchedNew} | whole-period ${matchedOld} | neither ${neither.length}`);
      expect(neither).toEqual([]);
      expect(matchedOld, 'no row may still use the whole-period rule for €/Stunde').toBe(0);
      expect(matchedNew).toBeGreaterThan(0);
    },
  );

  test(
    'a therapist with no qualifying day reads as unavailable, never as zero',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      // The Testing Guidance asks for this explicitly: no divide-by-zero, and no fabricated 0 —
      // which on a percentage column would read as a real, terrible efficiency.
      const noPersonio = rows.filter((r) => r.personioMinutes <= 0);
      expect(noPersonio.length, 'the period must contain such a therapist').toBeGreaterThan(0);
      for (const row of noPersonio) {
        expect(row.efficiency, `${row.therapistName}: Effizienz must be unavailable`).toBeNull();
        expect(row.revenuePerHour, `${row.therapistName}: €/Stunde must be unavailable`).toBeNull();
      }
      const withWork = noPersonio.filter((r) => r.treatmentMinutes > 0);
      console.log(
        `#3666: ${noPersonio.length} rows have no Personio minutes at all — all null, ` +
          `${withWork.length} of them while carrying treated time`,
      );
      expect(withWork.length, 'the sharp case: treated time but no Personio entry anywhere').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 a team row pools numerators and denominators — it never averages member percentages',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      const teams = await kpi.teamRows(GAP_PERIOD);
      const byTeam = new Map<string, HoursRow[]>();
      for (const row of rows) {
        if (null === row.teamName) continue;
        byTeam.set(row.teamName, [...(byTeam.get(row.teamName) ?? []), row]);
      }

      let checked = 0;
      for (const team of teams) {
        const members = null === team.teamName ? [] : byTeam.get(team.teamName) ?? [];
        if (!members.length || null === team.efficiency) continue;

        const pooled = PersonioDayEfficiencyPage.pooledEfficiency(members)!;
        const averaged = PersonioDayEfficiencyPage.averageOfMemberPercentages(members);
        console.log(
          `   ${String(team.teamName).padEnd(24)} served ${team.efficiency}  pooled ${pooled.toFixed(2)}  ` +
            `average-of-members ${averaged?.toFixed(2)}`,
        );

        expect(team.efficiency, `${team.teamName}: AC3's pooled ratio`).toBeCloseTo(pooled, 1);
        // The check only means something if the two candidate formulas actually differ for this team.
        if (null !== averaged && Math.abs(pooled - averaged) > 0.1) {
          expect(
            Math.abs(team.efficiency - averaged),
            `${team.teamName}: must NOT be the average of member percentages`,
          ).toBeGreaterThan(0.1);
          checked += 1;
        }
        expect(team.revenuePerHour, `${team.teamName}: €/Stunde pooled`).toBeCloseTo(
          PersonioDayEfficiencyPage.pooledRevenuePerHour(members)!,
          1,
        );
      }
      expect(checked, 'at least one team must separate the pooled ratio from the averaged one').toBeGreaterThan(0);
    },
  );

  test(
    'AC4 the time columns stay whole-period — so they no longer divide into Effizienz',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      // The consequence AC4 creates, asserted as the ticket intends it: for a therapist with a gap
      // day, Behandlungszeit ÷ Personio-Stunden is STRICTLY LARGER than the published Effizienz.
      // This is the invariant the PM's own arithmetic spot-check would appear to confirm — it only
      // "checks out" on rows that have no gap day, so it cannot evidence AC1.
      expect(discriminating.length).toBeGreaterThan(0);
      for (const row of discriminating) {
        const fromColumns = PersonioDayEfficiencyPage.wholePeriodEfficiency(row)!;
        expect(
          fromColumns,
          `${row.therapistName}: the time columns must still describe the whole period`,
        ).toBeGreaterThan(row.efficiency! + 0.001);
        // …and the whole-period numerator is the larger of the two, i.e. the columns kept the gap day.
        expect(row.treatmentMinutes).toBeGreaterThan(row.personioDayTreatmentMinutes);
      }
      console.log(
        `#3666 AC4: on all ${discriminating.length} gap rows, Behandlungszeit ÷ Personio-Stunden ` +
          `exceeds the published Effizienz — the documented, intended split`,
      );
    },
  );

  test(
    'AC5 the "Personio fehlt" tag is unchanged — and is NOT the set of corrected rows',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      const tagged = rows.filter((r) => r.missingPersonioDays > 0);
      expect(tagged.length, 'the tag must still be populated').toBeGreaterThan(0);

      // The trap worth pinning: the two populations are different. A row can be corrected while its
      // tag reads 0 T., because the tag counts EXPECTED working days with no entry while the
      // numerator drops ANY day carrying treatment without one.
      const correctedWithoutTag = discriminating.filter((r) => 0 === r.missingPersonioDays);
      console.log(
        `#3666 AC5: ${tagged.length} rows carry "Personio fehlt (N T.)"; ` +
          `${discriminating.length} rows were corrected; ${correctedWithoutTag.length} of the corrected read "(0 T.)"`,
      );
      for (const row of correctedWithoutTag.slice(0, 6)) {
        console.log(
          `   ${row.therapistName.padEnd(26)} Effizienz ${row.efficiency} (old ${PersonioDayEfficiencyPage.wholePeriodEfficiency(row)!.toFixed(2)}) — tag 0 T.`,
        );
      }
      expect(
        correctedWithoutTag.length,
        'the tag cannot be used to find the affected therapists — reported for the QA instructions',
      ).toBeGreaterThan(0);
    },
  );

  test(
    'AC6 the Zeiterfassung warning reads the corrected figure',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // The efficiency arm of the marker fires above 115%. The discriminating case is a therapist
      // whose corrected figure is below it while the old one is above: under the old rule they would
      // have been flagged, and they must not be now.
      const straddle = await kpi.hoursRows(WARNING_STRADDLE_PERIOD);
      const flipped = straddle.filter((r) => {
        const shipped = PersonioDayEfficiencyPage.qualifyingEfficiency(r);
        const old = PersonioDayEfficiencyPage.wholePeriodEfficiency(r);
        return null !== shipped && null !== old && shipped <= WARN_EFFICIENCY && old > WARN_EFFICIENCY;
      });
      console.log(`#3666 AC6: ${flipped.length} therapist(s) cross the ${WARN_EFFICIENCY}% threshold between the two formulas`);
      expect(flipped.length, 'the straddle period must contain such a therapist').toBeGreaterThan(0);

      for (const row of flipped) {
        const shipped = PersonioDayEfficiencyPage.qualifyingEfficiency(row)!;
        const old = PersonioDayEfficiencyPage.wholePeriodEfficiency(row)!;
        console.log(
          `   ${row.therapistName.padEnd(26)} corrected ${shipped.toFixed(2)}% (no warning) vs old ${old.toFixed(2)}% (would warn) — ` +
            `warning=${row.timeRecordingWarning}`,
        );
        // The marker has a second, whole-period arm (the Differenz gap), so a row can legitimately
        // still warn for that reason — the assertion is that it is not warning on EFFICIENCY.
        const gapArm = row.personioMinutes - (row.treatmentMinutes + row.otherMinutes) > 0.12 * row.personioMinutes;
        if (!gapArm) {
          expect(
            row.timeRecordingWarning,
            `${row.therapistName}: corrected to ${shipped.toFixed(2)}%, so the efficiency arm must not fire`,
          ).toBe(false);
        }
      }
    },
  );

  test(
    'AC8 both boards publish the same Effizienz and €/Stunde',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // The two tables are backed by DIFFERENT providers (`WorkingHoursRowProvider` and
      // `ManagementTherapistProvider`) that each compute the ratio, so agreement is a real
      // assertion rather than a tautology — and the whole point of the commit touching both.
      const management = new Map((await kpi.managementRows(GAP_PERIOD)).map((r) => [r.therapistId, r]));
      const shared = rows.filter((r) => management.has(r.therapistId));
      expect(shared.length, 'therapists present on both boards').toBeGreaterThan(0);

      const mismatches: string[] = [];
      for (const row of shared) {
        const other = management.get(row.therapistId)!;
        if ((null === row.efficiency) !== (null === other.efficiency)) {
          mismatches.push(`${row.therapistName}: ${row.efficiency} vs ${other.efficiency}`);
          continue;
        }
        if (null !== row.efficiency && Math.abs(row.efficiency - other.efficiency!) > 0.06) {
          mismatches.push(`${row.therapistName}: Effizienz ${row.efficiency} vs ${other.efficiency}`);
        }
        if (null !== row.revenuePerHour && null !== other.revenuePerHour && Math.abs(row.revenuePerHour - other.revenuePerHour) > 0.02) {
          mismatches.push(`${row.therapistName}: €/Stunde ${row.revenuePerHour} vs ${other.revenuePerHour}`);
        }
      }
      console.log(`#3666 AC8: ${shared.length} therapists on both boards, ${mismatches.length} disagreements`);
      for (const m of mismatches.slice(0, 6)) console.log(`   ${m}`);
      expect(mismatches, 'the two boards must agree').toEqual([]);

      // …and both must agree with the gap rows, or the comparison would be vacuous.
      const sharedGap = shared.filter((r) => discriminating.includes(r));
      expect(sharedGap.length, 'the agreement must cover corrected rows too').toBeGreaterThan(0);
    },
  );

  test(
    'the KPI cards above the table were corrected with it',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // Not in the ACs; the commit included `ManagementKpiProvider` because the cards sit directly
      // above the table and would otherwise have read ~182% over a corrected 76%.
      const card = await kpi.kpiCard(GAP_PERIOD);
      const pooled = PersonioDayEfficiencyPage.pooledEfficiency(rows)!;
      const pooledOld = (100 * rows.reduce((s, r) => s + r.treatmentMinutes, 0)) / rows.reduce((s, r) => s + r.personioMinutes, 0);
      console.log(
        `#3666 cards: Effizienz ${card.efficiency} | pooled qualifying ${pooled.toFixed(2)} | pooled whole-period ${pooledOld.toFixed(2)}`,
      );
      expect(card.efficiency, 'the card matches the table, not the old rule').toBeCloseTo(pooled, 1);
      expect(Math.abs(card.efficiency! - pooledOld), 'and the two rules differ here').toBeGreaterThan(0.1);
      expect(card.revenuePerHour).toBeCloseTo(PersonioDayEfficiencyPage.pooledRevenuePerHour(rows)!, 1);
    },
  );

  test(
    'the trend charts deliberately keep the old rule — measured, so nobody files it',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // Documented on the issue and in the commit: applying a per-day qualifying rule inside a
      // weekly/monthly bucket is a separate product decision. Pinned here with the actual numbers so
      // the disagreement is on the record — and so a silent change to the trend shows up.
      const bucket = await kpi.trendBucket('2026-04', GAP_PERIOD.to);
      expect(bucket, 'the April bucket must exist').toBeTruthy();
      const card = await kpi.kpiCard(GAP_PERIOD);
      const pooledOld = PersonioDayEfficiencyPage.pooledRevenuePerHour(rows);
      console.log(
        `#3666 trend split: trend €/Stunde ${bucket!.revenuePerHour} vs card ${card.revenuePerHour} ` +
          `(pooled qualifying ${pooledOld?.toFixed(2)}, pooled whole-period ` +
          `${(rows.reduce((s, r) => s + r.revenue, 0) / (rows.reduce((s, r) => s + r.personioMinutes, 0) / 60)).toFixed(2)})`,
      );
      // `gesamt` carries no `efficiency` key, so €/Stunde is the only comparable figure.
      expect(bucket!.efficiency, 'the trend bucket publishes no efficiency').toBeNull();
      expect(bucket!.revenuePerHour, 'the trend still answers').not.toBeNull();
      expect(
        Math.abs(bucket!.revenuePerHour! - card.revenuePerHour!),
        'the trend and the card disagree, by design',
      ).toBeGreaterThan(0.05);
    },
  );

  test(
    'AC7 the tooltip string is in the deployed bundle under the key that renders it',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      const bundle = await kpi.bundle();
      // The bundle escapes non-ASCII, so the German is matched on its longest ASCII run (#3337).
      expect(bundle, 'the AC7 copy must ship').toContain('Nur Tage mit Personio-Eintrag');
      // Under the key the components actually read — NOT the Developer Reference's suggestion.
      expect(bundle, `the key that carries it is ${TOOLTIP.key}`).toContain('effizienzPersonioTageTooltip');
      expect(bundle, 'the suggested key name was not the one used').not.toContain('effizienzPeriodRuleTooltip');
    },
  );

  test(
    'AC9 the Therapeuten-Orga legend now names the qualifying-day rule, in both locales',
    { tag: ['@SuperAdmin', '@PersonioDayEfficiency', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // Added 2026-09-14, when AC9 shipped. It was a FINDING first: `TherapeutenOrgaLegend.tsx`
      // rendered `flowBoards.toLegendEffizienz` = "Effizienz = Behandlungszeit ÷ Personio-Stunden",
      // which AC4 makes false — Behandlungszeit is whole-period, Effizienz is qualifying-days-only,
      // and on this period that division overstates the published figure on 27 of 116 rows (by up
      // to 34 points). The commit had been careful about exactly this invariant, rewriting the
      // `TherapeutenOrgaKpiCards` comment that asserted it ("This comment previously asserted the
      // opposite invariant") — but that is a code comment, and the user-facing legend on the same
      // board as the contradicting table was missed. AC9 was added to the ticket for it.
      //
      // **Matched in two halves, not as one sentence.** AC9's literal text proposed a `/` divider;
      // the shipped string keeps the existing **`÷`** and appends the qualifier, which is the right
      // call (the sibling `toLegendDifferenz` uses `÷`/`−` too). Asserting the exact AC sentence
      // would fail on a correct implementation.
      //
      // **And matched ESCAPED**: the bundle stores non-ASCII as `\xNN`, so a raw grep for the
      // German returns 0 and reads exactly like "never shipped" (#3611). A first check of this AC
      // searched for the `/` form and found 0 occurrences — a false negative that looked like a pass
      // for the removal of the old wording.
      const bundle = await kpi.bundle();
      expect(bundle, 'the legend key is still shipped').toContain(LEGEND.key.split('.').pop()!);

      const formula = kpi.escapedCount(bundle, LEGEND.de);
      const qualifier = kpi.escapedCount(bundle, LEGEND.qualifier);
      const english = kpi.escapedCount(bundle, LEGEND.en);
      const references = bundle.split('toLegendEffizienz').length - 1;
      console.log(
        `#3666 AC9: formula half ${formula}, qualifier "${LEGEND.qualifier}" ${qualifier}, ` +
          `English value ${english}, ${references} bundle references`,
      );

      expect(formula, 'the formula half still ships').toBeGreaterThan(0);
      expect(qualifier, 'and the qualifier AC9 requires now ships with it').toBeGreaterThan(0);
      // The English value was NOT covered by any AC — the ticket's Localization Reference is
      // German-only — and was flagged as a gap when AC9 was still open. It shipped anyway.
      expect(english, 'the English legend carries the qualifier too, though no AC required it').toBeGreaterThan(0);
      // Referenced, not merely present — a string nothing renders is not shipped behaviour (#3337).
      expect(references, 'the legend is read, not dead').toBeGreaterThan(1);

      // The regression this guards: the legend must never again state the bare formula with no
      // qualifier while the table computes over qualifying days only.
      const bare = kpi.escapedCount(bundle, `${LEGEND.de}"`);
      expect(bare, 'the unqualified formula must not be the whole value of any key').toBe(0);
      console.log(`   contradicted ${discriminating.length} of ${rows.length} rows before AC9 shipped; the legend now says so`);
    },
  );
});
