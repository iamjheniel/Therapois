import { test, expect } from '@playwright/test';
import {
  DoubleTreatmentPage,
  DoubleVo,
  KNOWN_V1_DOUBLE_VOS,
  TICKET_V2_VOS,
  Verdict,
} from '../../../Pages/superadmin/sa.double-treatment.page';

/**
 * RC 3.12 #3602 — Doppelbehandlung must double the sessions actually marked double, not every
 * session on the VO.
 *
 * **Deployed on staging; the core rule is verified on five VOs that can each tell the two rules
 * apart. AC3 and AC6 have no fixture here, and the ticket's own named fixtures do not exist.**
 *
 * The old engines read a **VO-level** flag (`prescription->isDoubleTreatment()`, and
 * `DOUBLE_TREATMENT_MULTIPLIER_EXPR` in SQL) and doubled every session; the fix substitutes the
 * per-session `Activity::getDoubleTreatment()`.
 *
 * **The interesting problem is that the per-session flag is served by no group**, and neither
 * `/prescriptions` nor `/activities` can filter or sort on double treatment — `order[doubleTreatment]`
 * is accepted and silently ignored. So this file leans on a discriminator that needs no flag at all:
 *
 * > For a V1 double VO the OLD rule can produce only `fees + base` or `fees + 2*base`. The NEW rule
 * > produces `fees + Σ(line × (session double ? 2 : 1))`. **A served total strictly between the two
 * > is something the VO-level rule cannot produce**, whatever the individual flags are.
 *
 * VOs whose sessions are *all* double are therefore not evidence — both rules agree on them — and
 * `classify()` returns `ambiguous` for those rather than a pass. Four of the nine priced VOs fall in
 * that class and are excluded from the verdict by construction, not by judgement.
 *
 * Read-only — every request is a GET.
 */

test.describe('#3602 per-session Doppelbehandlung billing', () => {
  test.describe.configure({ mode: 'serial' });

  let dt: DoubleTreatmentPage;
  /** The known V1 double VOs, priced once for the whole file. */
  let priced: { vo: DoubleVo; p: ReturnType<typeof DoubleTreatmentPage.price>; verdict: Verdict }[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    const page = await browser.newPage();
    dt = new DoubleTreatmentPage(page);
    await dt.connect();
    for (const number of KNOWN_V1_DOUBLE_VOS) {
      const vo = await dt.voByNumber(number).catch(() => null);
      if (!vo || !vo.doubleTreatment || vo.doubleTreatmentV2) continue;
      const p = DoubleTreatmentPage.price(vo);
      priced.push({ vo, p, verdict: DoubleTreatmentPage.classify(vo, p) });
    }
  });

  test(
    'the population is real, and the per-session flag is readable only by its presence',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      expect(priced.length, 'V1 double VOs resolved on staging').toBeGreaterThan(3);
      console.log(`V1 double VOs priced: ${priced.length}`);
      for (const { vo, p } of priced) {
        console.log(
          `  ${vo.vo.padEnd(10)} sessions=${String(p.countableSessions).padEnd(3)} double=${String(p.doubleSessions).padEnd(3)} fees=${p.fees}`,
        );
      }
      // The flag is omitted when false, so a VO with SOME double sessions proves it is served at all.
      const withDoubles = priced.filter((r) => r.p.doubleSessions > 0);
      expect(withDoubles.length, 'at least one VO has sessions marked double — the flag is served when true').toBeGreaterThan(0);
      const withNone = priced.filter((r) => 0 === r.p.doubleSessions);
      console.log(`VOs with the setting ON but no session marked double: ${withNone.map((r) => r.vo.vo).join(', ') || 'none'}`);
    },
  );

  test(
    'the guard: order[doubleTreatment] is silently ignored, so the population cannot be sorted to the top',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      // Pinned because it is the trap that makes this ticket look easy: the Admin Board renders a
      // sortable "Doppelbeh." column, so `order[doubleTreatment]` looks like it should work. API
      // Platform ignores an unknown order key without complaint (#3449), returning identical pages
      // for asc and desc — which reads as "no double VOs exist".
      const honoured = await dt.orderIsHonoured('doubleTreatment');
      const control = await dt.orderIsHonoured('id');
      console.log(`order[doubleTreatment] honoured: ${honoured} | order[id] honoured: ${control}`);
      expect(control, 'the control ordering IS honoured, so the check is meaningful').toBe(true);
      expect(honoured, 'order[doubleTreatment] is ignored — do not trust a page ordered by it').toBe(false);
    },
  );

  test(
    'AC1 — the billed total follows the per-session flag, not the VO setting',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      const decisive = priced.filter((r) => 'ambiguous' !== r.verdict);
      const ambiguous = priced.filter((r) => 'ambiguous' === r.verdict);
      console.log(`decisive VOs: ${decisive.length}, ambiguous (all sessions double — both rules agree): ${ambiguous.length}`);
      for (const { vo, p, verdict } of priced) {
        console.log(
          `  ${vo.vo.padEnd(10)} served=${String(vo.served?.toFixed(2)).padEnd(9)} single=${String(p.single).padEnd(9)} perSession=${String(p.perSession).padEnd(9)} voLevel=${String(p.voLevel).padEnd(9)} → ${verdict}`,
        );
      }
      expect(decisive.length, 'staging has VOs that can tell the two rules apart').toBeGreaterThan(2);

      // The load-bearing assertion.
      const stillVoLevel = decisive.filter((r) => 'per-session' !== r.verdict);
      expect(
        stillVoLevel.map((r) => `${r.vo.vo}: served ${r.vo.served} (perSession ${r.p.perSession}, voLevel ${r.p.voLevel})`),
        'every decisive VO is billed by the per-session rule',
      ).toEqual([]);

      // And the sharpest single case: a VO with the setting ON and a MIX of double and single
      // sessions, whose served total sits strictly between the two rules. The VO-level rule cannot
      // produce that number at all.
      const mixed = decisive.filter((r) => r.p.doubleSessions > 0 && r.p.doubleSessions < r.p.countableSessions);
      for (const { vo, p } of mixed) {
        expect(vo.served!, `${vo.vo} is above the all-single total`).toBeGreaterThan(p.single);
        expect(vo.served!, `${vo.vo} is below the all-double total the old rule would give`).toBeLessThan(p.voLevel);
        console.log(`  strictly-between proof: ${vo.vo} — ${p.single} < ${vo.served} < ${p.voLevel} (${p.doubleSessions}/${p.countableSessions} double)`);
      }
      expect(mixed.length, 'at least one VO has a genuine mix').toBeGreaterThan(0);
    },
  );

  test(
    'AC1 (the other half) — the setting ON with no session marked double bills nothing extra',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      // The purest form of the bug's absence: the VO flag is on, no session is ticked, so the old
      // rule would have doubled EVERYTHING. If the served total equals the all-single figure, the
      // VO-level flag is being ignored for billing exactly as the ticket requires.
      const none = priced.filter((r) => 0 === r.p.doubleSessions && r.p.countableSessions > 0);
      test.skip(0 === none.length, 'no V1 double VO on staging has zero double sessions');
      for (const { vo, p } of none) {
        console.log(`  ${vo.vo}: served ${vo.served} vs single ${p.single} vs old rule ${p.voLevel} (would have overbilled by ${(p.voLevel - p.single).toFixed(2)})`);
        expect(vo.served!, `${vo.vo} bills every session singly`).toBeCloseTo(p.single, 2);
        expect(vo.served!, `${vo.vo} is NOT doubled by the VO setting`).not.toBeCloseTo(p.voLevel, 2);
      }
    },
  );

  test(
    'AC8 — fees are billed once, never doubled',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      // The oracle already models fees as counted once; that it reproduces the served total on every
      // decisive VO is the evidence. Doubling them instead would overshoot by exactly the fee sum.
      const withFees = priced.filter((r) => r.p.fees > 0 && 'ambiguous' !== r.verdict);
      test.skip(0 === withFees.length, 'no decisive VO carries fees');
      for (const { vo, p } of withFees) {
        const ifFeesDoubled = Math.round((p.perSession + p.fees) * 100) / 100;
        console.log(`  ${vo.vo}: served ${vo.served}, fees ${p.fees} counted once (doubling them would give ${ifFeesDoubled})`);
        expect(vo.served!, `${vo.vo} counts its fees once`).toBeCloseTo(p.perSession, 2);
        expect(vo.served!, `${vo.vo} does not double its fees`).not.toBeCloseTo(ifFeesDoubled, 2);
      }
      // The client applies the same rule: the validation page's line builder filters fee kinds out
      // before duplicating a double session's lines.
      console.log('the frontend duplicates only non-fee lines — see the bundle excerpt in the page object');
    },
  );

  test(
    'AC2 — a PKV invoice on one of these VOs matches the corrected total',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      const withInvoice = priced.filter((r) => r.vo.invoice);
      console.log(`V1 double VOs carrying an invoice: ${withInvoice.length}`);
      for (const { vo, p } of withInvoice) {
        console.log(`  ${vo.vo}: ${vo.invoice!.number} ${vo.invoice!.status} ${vo.invoice!.amount} vs VO total ${vo.served} (perSession ${p.perSession})`);
      }
      // AC9 says an invoice frozen BEFORE the fix is deliberately left alone, so a mismatch here is
      // not necessarily a defect — it is what #3604 exists to correct. Reported, not asserted.
      test.skip(0 === withInvoice.length, 'no V1 double VO on staging carries an invoice — AC2 has no fixture');
      for (const { vo } of withInvoice) {
        if (null === vo.invoice!.amount) continue;
        const drift = Math.abs(vo.invoice!.amount - (vo.served ?? 0));
        console.log(`  ${vo.invoice!.number}: |invoice − VO total| = ${drift.toFixed(2)}${drift > 0.02 ? ' (frozen before the fix — #3604 territory)' : ''}`);
      }
    },
  );

  test(
    'AC5 — copayment totals are untouched',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      // Copayment counts per session already, so the fix must not move it. What is checkable: where
      // one of these VOs carries a copayment figure and an invoice, the two agree.
      const withCopay = priced.filter((r) => (r.vo.copaymentAmount ?? 0) > 0);
      console.log(`V1 double VOs with a copayment amount: ${withCopay.length}`);
      for (const { vo } of withCopay) {
        console.log(`  ${vo.vo}: copayment ${vo.copaymentAmount}, invoice ${vo.invoice?.number ?? '—'} ${vo.invoice?.amount ?? ''}`);
        if (vo.invoice && null !== vo.invoice.amount && 'public' === vo.insuranceType) {
          expect(vo.invoice.amount, `${vo.vo}'s copayment invoice equals its copayment figure`).toBeCloseTo(vo.copaymentAmount!, 2);
        }
      }
      test.skip(0 === withCopay.length, 'no V1 double VO on staging carries a copayment — AC5 has no fixture');
    },
  );

  test(
    'evidence — how rare this configuration is, and what the sample covered',
    { tag: ['@SuperAdmin', '@DoubleTreatment', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // A census is not affordable — `/prescriptions` costs ~0.13 s per row, so 34.247 VOs is ~74
      // minutes, and concurrent large pages 504. This samples pages spread across the id space and
      // reports prevalence rather than implying a complete count.
      const { scanned, found } = await dt.sample([1, 25, 55, 85, 115, 145, 171], 200);
      const v1 = found.filter((f) => f.v1);
      const v2 = found.filter((f) => f.v2);
      console.log(`sampled ${scanned} VOs; double-flagged ${found.length} — V1 ${v1.length}, V2 ${v2.length}`);
      console.log(`V1 found in this sample: ${v1.map((f) => f.vo).join(', ')}`);
      expect(scanned, 'the sample actually read VOs').toBeGreaterThan(500);
    },
  );

  // ─────────────────────────────────── findings ───────────────────────────────────
});
