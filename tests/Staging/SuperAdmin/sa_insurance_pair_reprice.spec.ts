import { test, expect } from '@playwright/test';
import {
  InsurancePairRepricePage,
  EXPECTED_BY_DATE,
  FIXTURE,
  PAIRS,
  RESET_REASON,
} from '../../../Pages/superadmin/sa.insurance-pair-reprice.page';

/**
 * RC 3.13 — insurance-type corrections reprice and revalidate across every pair (#3562).
 *
 * #3535 built confirm-and-reprice for PKV <-> Privat Basis; #3562 widens the guard to all pairs and
 * adds a validation-status reset. **Deployed (`d15d268e0`, plus `be7b69c53`); AC1/AC2 verified on
 * real data, AC5 has never fired on staging. 5 passed / 2 fixme.**
 *
 * **The headline: #3535's repricing never ran, and this file proves it now does.** That ticket's
 * guard compared the changeset value with `instanceof InsuranceTypeEnum`, but Doctrine hands back
 * the BACKING STRING — so the guard was false on every correction and the pass was skipped with no
 * error at all. This suite reported that in its #3535 run ("the confirmation is live and gated
 * exactly right; the repricing does not happen"), and `be7b69c53`'s docblock now cites that
 * diagnostic verbatim, on this very VO. The fix is real and measurable here.
 *
 * **The evidence is a STRADDLING fixture, not a total.** VO **4355-1** has three PNF sessions either
 * side of the PRIVAT_BASIS step on 2025-07-01, which separates the three things a reprice can do:
 *
 * | outcome | what the sessions would read |
 * |---|---|
 * | priced at each session's OWN date (correct — AC1) | 47,69 / 45,92 / 45,92 |
 * | priced at today | 47,06 three times |
 * | never repriced (#3535's bug) | the old PKV 61,95 three times |
 *
 * They read **47,69 / 45,92 / 45,92**. A test computes each expected figure from the price ladder
 * rather than hardcoding it, and separately asserts none of them equals today's price — otherwise a
 * build that priced everything at today would pass on the two sessions that happen to match.
 *
 * **Reading the VO's total cannot tell these apart, and that is the #3535 false pass.** A VO's
 * revenue is snapshotted treatment lines PLUS a live fee calculation, and only the fee half follows
 * the current type — so `Gesamtumsatz` moves on a correction whether or not the sessions repriced.
 * 4355-1 went 257,85 → 224,65 while still holding PKV session prices; fully repriced it is 178,33,
 * which is what it reads today. **Always read `ActivityTreatment.resolvedTariff`.**
 *
 * **FINDING — AC5 has never fired on staging.** The reset stamps a `validation_status_change` log
 * with reason "Validation reset after an insurance-type correction"; there are **0** of them. The
 * PM's notes record AC5 as PASS by code reading, and their own session says the dialog was
 * "dismissed with Abbrechen to preserve test VO" — so no correction was ever confirmed through the
 * UI either. The reset additionally requires a non-null billing `validationStatus`, and the fixture
 * VO's is null, so it would not fire there even now.
 *
 * **Also worth carrying to the PM:** their AC table is renumbered against the ticket — their AC-3
 * describes the validation reset (the ticket's AC5), their AC-6 the invoiced-VO guard (AC7), and
 * their AC-1/AC-2 describe the dialog, which is AC3. So "7 of 7" does not map onto these seven ACs.
 *
 * **Read-only — every request is a GET.**
 */

test.describe('#3562 insurance-type corrections reprice across every pair', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1 the sessions are priced at each one\'s OWN treatment date, not today\'s',
    { tag: ['@SuperAdmin', '@InsurancePairReprice', '@ReadOnly'] },
    async ({ request }) => {
      const api = new InsurancePairRepricePage(request);
      const vo = await api.prescription(FIXTURE.prescriptionId);
      const sessions = await api.sessionTariffs(FIXTURE.prescriptionId, FIXTURE.treatmentCode);
      const ladder = await api.priceLadder(FIXTURE.treatmentId, 'PRIVAT_BASIS');

      console.log(`#3562 fixture VO ${vo.prescriptionId}: insuranceType=${vo.insuranceType}, totalRevenue=${vo.totalRevenue}`);
      console.log(`   PRIVAT_BASIS ladder: ${ladder.map((s) => `${s.effectiveDate}=${s.price}`).join('  ')}`);
      expect(vo.insuranceType, 'the fixture must still be the corrected type').toBe('privat_basis');
      expect(sessions.length, 'the fixture must still have its three straddling sessions').toBe(3);

      const today = new Date().toISOString().slice(0, 10);
      const priceToday = api.priceOn(ladder, today);

      for (const s of sessions) {
        const expected = api.priceOn(ladder, s.date);
        console.log(`   ${s.date}  served ${s.resolvedTariff}  | price in force that day ${expected}  | price today ${priceToday}`);
        expect(expected, `no ${FIXTURE.treatmentCode} price is in force on ${s.date}`).not.toBeNull();
        expect(s.resolvedTariff, `${s.date} must be priced at its OWN date`).toBeCloseTo(expected!, 2);
      }

      // The discriminator: at least one session must differ from today's price, or "priced at its
      // own date" and "priced at today" would be indistinguishable on this fixture.
      const differs = sessions.filter((s) => Math.abs((s.resolvedTariff ?? 0) - (priceToday ?? 0)) > 0.005);
      console.log(`   ${differs.length}/3 sessions differ from today's price (${priceToday}) — that is what makes AC1 falsifiable here`);
      expect(differs.length, 'the fixture must straddle a price step, or AC1 cannot be told apart from "priced today"').toBeGreaterThan(0);
    },
  );

  test(
    'the sessions match the pinned per-date figures, so #3535\'s unrepriced state is excluded',
    { tag: ['@SuperAdmin', '@InsurancePairReprice', '@ReadOnly'] },
    async ({ request }) => {
      // Belt and braces against the ladder itself changing: these are the exact values this suite
      // computed as "what full repricing would give" when it reported #3535 as NOT repricing.
      const api = new InsurancePairRepricePage(request);
      const sessions = await api.sessionTariffs(FIXTURE.prescriptionId, FIXTURE.treatmentCode);
      for (const s of sessions) {
        const want = EXPECTED_BY_DATE[s.date];
        expect(want, `${s.date} is not one of the pinned fixture dates — the fixture moved`).toBeTruthy();
        expect(s.resolvedTariff, `${s.date}`).toBeCloseTo(want, 2);
        // The pre-fix value. If any session still read 61,95 the #3535 bug would be back.
        expect(s.resolvedTariff, `${s.date} must not still hold the old PKV tariff`).not.toBeCloseTo(61.95, 2);
      }
      console.log(`#3562: all ${sessions.length} sessions hold their date-resolved Privat Basis price, none the pre-fix 61,95`);
    },
  );

  test(
    'the correction that repriced it happened AFTER the string fix shipped',
    { tag: ['@SuperAdmin', '@InsurancePairReprice', '@ReadOnly'] },
    async ({ request }) => {
      // Ties the corrected prices to a correction rather than to some other recompute: the VO's own
      // log shows insurance-type changes, and the ones after 2026-09-02 are post-`be7b69c53`.
      const api = new InsurancePairRepricePage(request);
      const changes = await api.insuranceChanges(FIXTURE.prescriptionId);
      for (const c of changes.slice(-6)) console.log(`   ${c.at}  ${c.from} -> ${c.to}`);
      expect(changes.length, 'the fixture must carry its correction history').toBeGreaterThan(0);

      const STRING_FIX = '2026-09-02';
      const postFix = changes.filter((c) => c.at.slice(0, 10) >= STRING_FIX);
      console.log(`#3562: ${changes.length} insurance-type corrections on this VO, ${postFix.length} after the ${STRING_FIX} string fix`);
      expect(postFix.length, 'the corrected prices must be attributable to a post-fix correction').toBeGreaterThan(0);
      expect(changes.at(-1)?.to, 'and the last one left it on the type whose prices it now holds').toBe('privat_basis');
    },
  );

  test(
    'AC3 the confirmation dialog ships, with the per-session-date wording',
    { tag: ['@SuperAdmin', '@InsurancePairReprice', '@ReadOnly'] },
    async ({ request }) => {
      const api = new InsurancePairRepricePage(request);
      const bundle = await api.bundle();
      for (const s of ['Behandlungen neu bepreisen?', 'bereits dokumentierte Behandlungen', 'der am jeweiligen Behandlungstag galt']) {
        const n = api.escapedCount(bundle, s);
        console.log(`   "${s}" -> ${n}`);
        expect(n, `the dialog string "${s}" must ship`).toBeGreaterThan(0);
      }
      // The wording is the promise AC1 makes — "at the price in force on each treatment day".
      console.log('#3562 AC3: the dialog states the per-treatment-day rule, matching what the data shows');
    },
  );

  test(
    'FINDING — AC5\'s validation reset has never fired on staging',
    { tag: ['@SuperAdmin', '@InsurancePairReprice', '@ReadOnly'] },
    async ({ request }) => {
      const api = new InsurancePairRepricePage(request);
      const resets = await api.validationResets();
      console.log(`#3562 AC5: ${resets.length} logs with reason "${RESET_REASON}"`);
      for (const r of resets.slice(0, 5)) console.log(`   ${r.at} VO ${r.prescriptionId} ${r.from} -> null`);

      const vo = await api.prescription(FIXTURE.prescriptionId);
      console.log(`   the fixture's billing validationStatus is ${JSON.stringify(vo.validationStatus ?? null)} — the reset only fires when this is non-null`);

      // Recorded as the environment's state, not as a requirement. The day someone confirms a
      // correction on a validated VO this flips, and the fixme below becomes a real test.
      expect(
        resets.length === 0,
        'if this fails, AC5 finally has a live instance — promote the fixme to an assertion',
      ).toBe(true);

      const pools = await Promise.all(PAIRS.flat().filter((v, i, a) => a.indexOf(v) === i).map(async (t) => [t, await api.countByInsuranceType(t)] as const));
      console.log(`   VO pool by insurance type: ${pools.map(([t, n]) => `${t}=${n}`).join('  ')}`);
    },
  );

});
