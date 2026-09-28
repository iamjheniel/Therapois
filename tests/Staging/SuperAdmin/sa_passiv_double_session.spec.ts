import { test, expect } from '@playwright/test';
import {
  BLANKO_SESSIONS,
  BLANKO_TOTALS,
  FIXTURES,
  PassivDoubleSessionPage,
  Session,
} from '../../../Pages/superadmin/sa.passiv-double-session.page';

/**
 * RC 3.12 #3647 — a passive Heilmittel on a double session must be billed ONCE.
 *
 * **Deployed on staging between 2026-09-05 and 09-07, and this file has the before/after on both
 * halves** — which is unusual, and only possible because this suite measured the same VO two days
 * earlier while testing #3603.
 *
 * | half | 2026-09-05 | 2026-09-07 |
 * |---|---|---|
 * | API — VO 7080-2 `totalRevenue` | **2.888,80** (AEB-BV counted twice) | **2.839,15** (once) |
 * | Client — `expandDoubleTreatmentRows` exclusion list | `['one_time_fee','per_treatment_fee']` | `['one_time_fee','per_treatment_fee','passiv']` |
 *
 * The delta is exactly **49,65**, the AEB-BV price. That single number is the whole ticket.
 *
 * **The export file is the primary oracle, not a revenue model.** VO 7080-2 is a Blanko VO, whose
 * treatment lines price by DURATION on a separate calculator branch — modelling it to predict a
 * total would mean porting that branch. The `.rz` Optica export states quantities outright, so AC3
 * is read directly off the file, and because one calculator feeds every surface it corroborates the
 * rest. `solveTreatmentPrice()` covers the validation total without pricing anything: the two rules
 * differ by a constant, so solving the VO's own total for the per-session treatment price under each
 * rule says which one the API is running.
 *
 * **A correction this ticket forced, which matters beyond it:** every other spec in this suite
 * records `optica-export` as unreachable (422 on all batches). That was measured on **pending**
 * batches, where #3288's readiness check legitimately blocks it. A **`complete_and_sent`** batch
 * returns **200** and a real file. AC3 is testable because of that.
 *
 * Read-only — every request is a GET.
 */

test.describe('#3647 passive Heilmittel billed once on a double session', () => {
  let pd: PassivDoubleSessionPage;
  let blankoSessions: Session[];
  let blankoVo: Awaited<ReturnType<PassivDoubleSessionPage['voTotal']>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await browser.newPage();
    pd = new PassivDoubleSessionPage(page);
    await pd.connect();
    blankoVo = await pd.voTotal(FIXTURES.blanko.prescriptionId);
    blankoSessions = await pd.sessions(FIXTURES.blanko.prescriptionId);
  });

  test(
    'deployment — the client stopped cloning passive rows onto a double session’s second row',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);
      // `expandDoubleTreatmentRows` builds the second row of a double session by cloning the first
      // and dropping some kinds. The fix adds `passiv` to that list; before, an assessment was cloned
      // and the validation page showed it twice — the ticket's repro step 4.
      const bundle = await pd.entryBundle();
      expect(bundle, 'the double-session row expander is in the bundle').toContain('_isDoubleTreatmentSecondRow');
      expect(bundle, 'passive rows are excluded from the cloned second row').toContain(
        "['one_time_fee','per_treatment_fee','passiv']",
      );
      console.log('client exclusion list now includes `passiv` (2026-09-05 bundle had only the two fee kinds)');
    },
  );

  test(
    'AC1 — the passive line is counted once in the VO total, not twice',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      const served = blankoVo.totalRevenue!;
      const passivOnDouble = PassivDoubleSessionPage.passivOnDoubleSessions(blankoSessions);
      console.log(`VO ${blankoVo.vo} (Blanko=${blankoVo.blankoVO}) served=${served} | passive on doubled sessions=${passivOnDouble}`);
      expect(passivOnDouble, 'the fixture still has a passive line on a doubled session').toBeCloseTo(BLANKO_TOTALS.aebBv, 2);

      // Solve the per-session treatment price under each rule. The rules differ by a constant, so a
      // clean, self-consistent price under one of them identifies which is running — no Blanko
      // duration pricing has to be modelled.
      const tOnce = PassivDoubleSessionPage.solveTreatmentPrice(blankoSessions, served, { passivDoubled: false });
      const tDoubled = PassivDoubleSessionPage.solveTreatmentPrice(blankoSessions, served, { passivDoubled: true });
      console.log(`per-session treatment price solved: passive-once → ${tOnce.toFixed(2)}, passive-doubled → ${tDoubled.toFixed(2)}`);

      // Under the correct rule the price is the VO's flat 60-minute Blanko rate, identical on every
      // session; under the wrong one it comes out short by the passive line spread over the sessions.
      const single = blankoSessions.find((s) => FIXTURES.blanko.singleDate === s.date)!;
      const expectedSingleTotal = tOnce + single.feeLines;
      console.log(`  ${single.date} (not double): ${tOnce.toFixed(2)} treatment + ${single.feeLines.toFixed(2)} fees = ${expectedSingleTotal.toFixed(2)}`);
      expect(expectedSingleTotal, 'AC2: the non-double session is 112,87').toBeCloseTo(BLANKO_SESSIONS.single, 2);

      const dbl = blankoSessions.find((s) => FIXTURES.blanko.doubleDate === s.date)!;
      expect(dbl.double, 'the 17 Jul session is marked double').toBe(true);
      const dblTotal = 2 * tOnce + dbl.feeLines + dbl.passivLines;
      const dblIfBuggy = dblTotal + dbl.passivLines;
      console.log(`  ${dbl.date} (double): 2 x ${tOnce.toFixed(2)} + ${dbl.feeLines.toFixed(2)} fees + ${dbl.passivLines.toFixed(2)} passive once = ${dblTotal.toFixed(2)} (pre-fix would be ${dblIfBuggy.toFixed(2)})`);
      expect(dblTotal, 'AC1: the double session is 257,42').toBeCloseTo(BLANKO_SESSIONS.double, 2);
      expect(dblIfBuggy, 'and the pre-fix figure the ticket quotes is 307,07').toBeCloseTo(BLANKO_SESSIONS.doublePreFix, 2);

      // The VO total itself, against both recorded values.
      expect(served, 'the served total counts the passive line once').toBeCloseTo(BLANKO_TOTALS.passivOnce, 2);
      expect(served + passivOnDouble, 'and is exactly one AEB-BV below what it served on 2026-09-05').toBeCloseTo(
        BLANKO_TOTALS.passivDoubled,
        2,
      );
    },
  );

  test(
    'AC2 + regression — the treatment still doubles and the fees still bill once',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      const served = blankoVo.totalRevenue!;
      const t = PassivDoubleSessionPage.solveTreatmentPrice(blankoSessions, served, { passivDoubled: false });
      const countable = blankoSessions.filter((s) => s.countable);
      const dbl = countable.filter((s) => s.double);
      expect(dbl.length, 'the fixture has a doubled session').toBeGreaterThan(0);

      // Rebuild the whole VO from the solved price and check it reproduces the served total. That is
      // only possible if the treatment doubles, the fees do not, and the passive line is counted once.
      const rebuilt = countable.reduce((n, s) => n + t * (s.double ? 2 : 1) + s.feeLines + s.passivLines, 0);
      console.log(`rebuilt VO total ${rebuilt.toFixed(2)} vs served ${served.toFixed(2)} over ${countable.length} countable sessions`);
      expect(rebuilt, 'the whole VO reconstructs under treatment-doubles / fees-once / passive-once').toBeCloseTo(served, 1);

      // Fees on the doubled session specifically: billed once, per the ticket's "unchanged" column.
      for (const s of dbl) {
        console.log(`  ${s.date}: fees ${s.feeLines.toFixed(2)} counted once; doubling them would add ${s.feeLines.toFixed(2)}`);
        expect(s.feeLines, 'the doubled session carries a fee to check').toBeGreaterThan(0);
      }
      const feesDoubled = countable.reduce((n, s) => n + t * (s.double ? 2 : 1) + s.feeLines * (s.double ? 2 : 1) + s.passivLines, 0);
      expect(feesDoubled, 'doubling the fees would NOT reproduce the served total').not.toBeCloseTo(served, 1);
    },
  );

  test(
    'AC3 — the Optica export carries quantity 1 for the passive position and 2 for the treatment',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      test.setTimeout(300_000);
      const batch = await pd.batchByBatchId(FIXTURES.batch.batchId);
      expect(batch, `batch ${FIXTURES.batch.batchId} exists`).toBeTruthy();
      console.log(`batch ${FIXTURES.batch.batchId} → id ${batch!.id}, status ${batch!.status}`);

      const exp = await pd.opticaExport(batch!.id);
      // A pending batch answers 422 from #3288's readiness check; a sent one exports.
      expect(exp.status, 'a complete_and_sent batch exports — pending ones 422, which is what other specs measured').toBe(200);
      console.log(exp.raw);

      const passiv = exp.positions.find((p) => '54003' === p.positionNumber);
      expect(passiv, 'position 54003 (Analyse ergoth. Bedarf (BV)) is in the export').toBeTruthy();
      console.log(`  position ${passiv!.positionNumber}: quantity ${passiv!.quantity} x ${passiv!.unitPrice} = ${passiv!.total} — "${passiv!.description}"`);
      expect(passiv!.quantity, 'AC3: quantity 1,00, not 2,00').toBeCloseTo(1, 2);
      expect(passiv!.total, 'so the line totals 49,65, not 99,30').toBeCloseTo(passiv!.unitPrice, 2);

      // The treatment's own daily line for the doubled date must still be 2,00 — the fix must not
      // have flattened the doubling itself.
      const onDoubleDate = exp.daily.filter((l) => '01.07.2026' === l.date);
      console.log(`  daily lines on the doubled date: ${onDoubleDate.map((l) => `pos#${l.index}=${l.quantity}`).join(', ')}`);
      const passivDaily = onDoubleDate.find((l) => l.index === passiv!.index);
      expect(passivDaily, 'the passive position has a daily line on the doubled date').toBeTruthy();
      expect(passivDaily!.quantity, 'the passive daily line is 1,00').toBeCloseTo(1, 2);
      expect(
        onDoubleDate.some((l) => l.index !== passiv!.index && l.quantity >= 2),
        'a treatment position on the same date still carries the doubled quantity',
      ).toBe(true);

      // And the file's own trailer must agree with the positions, so the quantities are not merely
      // cosmetic.
      const sum = exp.positions.reduce((n, p) => n + p.total, 0);
      console.log(`  positions sum ${sum.toFixed(2)} vs trailer total ${exp.total}`);
      expect(exp.total, 'the export total is the sum of its positions').toBeCloseTo(sum, 2);
    },
  );

  test(
    'AC6 — an invoice locked before the fix is not recalculated',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      // AC6 needs an invoice whose amount INCLUDED a doubled passive line, so the fix would move it
      // if it recalculated. No such invoice exists on staging: the only two sessions with a passive
      // line on a doubled session are on VOs 7080-2 and 7048-4, neither of which carries an invoice,
      // and all four invoiced passive rows sit on NON-doubled sessions. So the boundary is asserted
      // where it can be — a data gate with the evidence — rather than on an unrelated VO.
      //
      // The first version of this test did exactly that and was wrong: it used VO 1762-28's draft
      // R326-89, which read 1.118,51 against a live total of 1.160,31 that morning and had been
      // re-snapshotted to 1.160,31 by the afternoon. A draft is precisely the thing that DOES get
      // refreshed (#3604 step 3, #3589), so it can never evidence "not recalculated".
      const all = await pd.passivOnDoubleSessions();
      const invoiced = all.filter((a) => a.double && a.vo);
      console.log(`passive-on-double rows: ${all.filter((a) => a.double).length}; of those on a VO carrying an invoice: 0 (checked below)`);
      for (const f of [FIXTURES.blanko, FIXTURES.exported]) {
        const vo = await pd.voTotal(f.prescriptionId);
        console.log(`  ${vo.vo}: invoice ${vo.invoice?.number ?? '—'} — total ${vo.totalRevenue}`);
        expect(vo.invoice, `${vo.vo} carries no invoice, so the fix could not have moved one`).toBeNull();
      }
      test.skip(true, 'AC6 has no fixture: no invoice on staging ever included a doubled passive line');
      expect(invoiced.length).toBeGreaterThan(0);
    },
  );

  test(
    'evidence — the population this ticket can actually affect',
    { tag: ['@SuperAdmin', '@PassivDouble', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      const all = await pd.passivOnDoubleSessions();
      const linked = all.filter((a) => a.vo);
      const orphans = all.filter((a) => !a.vo);
      const onDouble = linked.filter((a) => a.double);
      console.log(`passive attachments: ${all.length} — ${linked.length} with a prescription link, ${orphans.length} without`);
      console.log(`on a DOUBLE session (reachable by this join): ${onDouble.map((a) => `${a.code}@${a.vo}/${a.date}`).join(', ') || 'none'}`);
      console.log(`orphans (at ids): ${orphans.map((a) => a.at).join(', ')}`);

      // The join used above goes activity_treatment → prescription, and that link is null on several
      // rows — including VO 7048-4's AEB-BV, the AC3 fixture. So this enumeration UNDERCOUNTS: the
      // reliable route is to walk a candidate VO's activities, which is how both fixtures were found.
      for (const f of [FIXTURES.blanko, FIXTURES.exported]) {
        const sessions = await pd.sessions(f.prescriptionId);
        const hit = sessions.find((s) => f.doubleDate === s.date);
        console.log(`  ${f.vo} ${f.doubleDate}: double=${hit?.double} passive=${hit?.passivLines} fees=${hit?.feeLines}`);
        expect(hit?.double, `${f.vo}'s ${f.doubleDate} session is double`).toBe(true);
        expect(hit?.passivLines, `${f.vo}'s ${f.doubleDate} session carries a passive line`).toBeGreaterThan(0);
      }
    },
  );

  // ─────────────────────────────────── findings ───────────────────────────────────
});
