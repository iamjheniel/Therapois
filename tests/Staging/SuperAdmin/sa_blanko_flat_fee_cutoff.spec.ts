import { test, expect } from '@playwright/test';
import {
  BlankoFlatFeeCutoffPage,
  CUTOFF_DATE,
  VBP_CODES,
} from '../../../Pages/superadmin/sa.blanko-flat-fee-cutoff.page';

/**
 * RC 3.14 #3712 — a Blanko VO issued on or after 30.07.2026 no longer gets the VBP-BV flat fee.
 *
 * READ-ONLY: every request is a GET. Nothing documents a treatment, which is the only action that
 * could attach the fee.
 */

const S = BlankoFlatFeeCutoffPage;

/** The three post-cutoff Blanko VOs with documented sessions — the live positive control. */
const POST_CUTOFF_BLANKO_WITH_SESSIONS = [
  { id: 34216, vo: '965111-1', fee: 'AB-P-BV' },
  { id: 34218, vo: '965112-1', fee: 'AB-E-BV' },
  { id: 34254, vo: '965506-1', fee: 'AB-P-BV' },
];

test.describe('#3712 the Blanko VBP-BV flat-fee cutoff', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: BlankoFlatFeeCutoffPage;

  test.beforeEach(({ request }) => {
    api = new BlankoFlatFeeCutoffPage(request);
  });

  test(
    'the gated code list is complete — exactly two VBP flat fees exist, one per therapy area',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      // The Developer Reference left this open: "Verify in the Heilmittel/Treatment catalog
      // whether area-specific variants exist (e.g. for Ergo or Logo Blanko) and apply the same
      // cutoff to all of them." It names only VBP-BV-P; the shipped CODES names both.
      const catalogue = await api.catalogue();
      const fees = await api.oneTimeFees();
      const vbp = await api.vbpTreatments();

      console.log(`#3712 catalogue: ${catalogue.length} treatments, ${fees.length} of kind one_time_fee`);
      for (const f of fees) {
        console.log(
          `#3712   id=${String(f.id).padStart(3)} ${f.code.padEnd(10)} area=${String(f.area).padEnd(5)} bv=${String(f.bv).padEnd(5)} gkv=${f.tariffGkv}`,
        );
      }

      // Exactly the two the constant names, and nothing VBP-shaped outside it — a Logo/SSSST
      // variant would have to be gated too and there is none.
      expect(vbp.map((t) => t.code).sort()).toEqual([...VBP_CODES].sort());
      const vbpShaped = catalogue.filter((t) => /VBP/i.test(t.code));
      expect(vbpShaped.map((t) => t.code).sort(), 'a VBP variant exists outside the gated list').toEqual(
        [...VBP_CODES].sort(),
      );
      expect(vbp.map((t) => t.area).sort()).toEqual(['ERGO', 'PT']);

      // The class docblock's own claim: "Both are kind = one_time_fee with bv = 1, so both only
      // ever appear on a Blanko VO."
      for (const t of vbp) {
        expect(t.kind, `${t.code} kind`).toBe('one_time_fee');
        expect(t.bv, `${t.code} is not flagged bv`).toBe(true);
      }

      // And the gate is narrow: the other one-time fees are NOT in the list, including the three
      // that are themselves Blanko codes — so "every other one-time fee is untouched" has real
      // content rather than being about non-Blanko fees only.
      const otherBlankoFees = fees.filter((f) => f.bv && !(VBP_CODES as readonly string[]).includes(f.code));
      console.log(`#3712 other Blanko one-time fees, deliberately NOT gated: ${otherBlankoFees.map((f) => f.code).join(', ')}`);
      expect(otherBlankoFees.length).toBeGreaterThan(0);
    },
  );

  test(
    'AC1/AC2/AC3 the cutoff boundary, ported — 29.07 keeps the fee, 30.07 and later do not',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      const fees = await api.oneTimeFees();
      const otherFee = fees.find((f) => !(VBP_CODES as readonly string[]).includes(f.code))!;

      const cases: { date: string | null; ac: string; suppressed: boolean }[] = [
        { date: '2026-07-29', ac: 'AC1', suppressed: false },
        { date: CUTOFF_DATE, ac: 'AC2', suppressed: true },
        { date: '2026-09-15', ac: 'AC3', suppressed: true },
        { date: '2025-01-01', ac: 'well before', suppressed: false },
        { date: '2030-01-01', ac: 'well after', suppressed: true },
      ];

      for (const code of VBP_CODES) {
        for (const c of cases) {
          const got = S.suppresses(code, c.date);
          console.log(`#3712 ${c.ac}: ${code} issued ${c.date} → ${got ? 'NO fee' : 'fee attached'}`);
          expect(got, `${code} @ ${c.date}`).toBe(c.suppressed);
        }
        // Absent data must not silently remove a fee.
        expect(S.suppresses(code, null), `${code} with no issue date`).toBe(false);
      }

      // The gate is code-scoped as well as date-scoped: every other one-time fee survives every
      // date, which is what keeps AB-P/AB-E/AB-L/L-ED and the other Blanko fees billing.
      for (const c of cases) {
        expect(S.suppresses(otherFee.code, c.date), `${otherFee.code} @ ${c.date} must never be gated`).toBe(false);
      }
      expect(S.suppresses(null, '2030-01-01')).toBe(false);
    },
  );

  test(
    'the filters these counts rest on actually partition',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      const f = await api.filtersPartition();
      console.log(
        `#3712 /prescriptions: all=${f.all}, date[before]=${f.beforeInclusive}, date[strictly_before]=${f.strictlyBefore}, ` +
          `date[after]=${f.afterInclusive}, unknown-filter=${f.bogus}`,
      );

      // An unregistered filter is accepted and IGNORED here, so a zero from a date query is only
      // meaningful once the date filter is shown to split the book.
      expect(f.bogus, 'an unknown filter is silently ignored — which is why this test exists').toBe(f.all);
      expect(f.strictlyBefore + f.afterInclusive, 'strictly_before + after must tile the whole book').toBe(f.all);
      // `after` is inclusive, which happens to be exactly the cutoff's own `>=` semantics.
      expect(f.beforeInclusive).toBeGreaterThan(f.strictlyBefore);

      // `/activity_treatments` registers no ordering at all — asc and desc return the same page.
      console.log(`#3712 /activity_treatments order[id] ignored: ${f.atOrderIgnored}`);
      expect(f.atOrderIgnored, 'order[id] now works — a page ordered by it may be trusted').toBe(true);
    },
  );

  test(
    'AC2/AC3/AC4 at full scale — not one VBP fee is attached to a VO issued on or after the cutoff',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly', '@Slow'] },
    async () => {
      // The whole attachment population, enumerable because `?treatment=` is a registered filter.
      const attachments = await api.vbpAttachments();
      const rows = [...attachments.values()].reduce((n, l) => n + l.length, 0);
      const postCutoff = await api.postCutoffVos();
      const postIds = new Set(postCutoff.map((v) => v.id));
      const offenders = [...attachments.keys()].filter((id) => postIds.has(id));

      console.log(
        `#3712 ${rows} VBP attachments across ${attachments.size} VOs; ${postCutoff.length} VOs issued on/after ${CUTOFF_DATE}; ` +
          `intersection = ${offenders.length}`,
      );
      // AC2/AC3 in their negative form, over the entire book rather than one example VO.
      expect(offenders, 'a VO issued on/after the cutoff carries a VBP flat fee').toEqual([]);

      // AC4 measured rather than assumed: the ticket's 7 pre-existing cases are PRODUCTION rows.
      // Staging has none, so there is nothing here for a retroactive correction to have removed —
      // stated so a future reader does not read this zero as the fix deleting them.
      console.log(
        `#3712 AC4: staging holds 0 post-cutoff VOs carrying the fee, so the ticket's "7 already ` +
          `carry it incorrectly" (15 Sep production snapshot) has no counterpart here — nothing to preserve, ` +
          `and nothing whose survival could be checked.`,
      );

      // A one-time fee attached more than once is a data anomaly worth naming rather than hiding.
      const multi = [...attachments.entries()].filter(([, l]) => l.length > 1);
      for (const [voId, list] of multi) {
        console.log(`#3712 NOTE: VO ${voId} carries ${list.length} VBP rows (${list.map((a) => a.atId).join(', ')}) for a once-per-VO fee`);
      }
      expect(rows).toBeGreaterThan(0);
    },
  );

  test(
    'AC1 the pre-cutoff population is whole — every VO prescribing a VBP fee was issued before the cutoff',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      const vbp = await api.vbpTreatments();
      let prescribing = 0;
      for (const t of vbp) {
        const [all, pre, post] = [
          await api.prescribingCount(t.id),
          await api.prescribingCount(t.id, 'pre'),
          await api.prescribingCount(t.id, 'post'),
        ];
        prescribing += all;
        const newest = (await api.prescribingVos(t.id, 1))[0];
        console.log(
          `#3712 ${t.code}: ${all} VOs prescribe it — ${pre} pre-cutoff, ${post} post-cutoff; newest issued ${newest?.issueDate}`,
        );
        expect(pre + post, `${t.code} counts must tile`).toBe(all);
        // AC1's population is the whole of it on staging, so the gate currently suppresses nothing.
        expect(post, `${t.code} has a post-cutoff VO — AC2/AC3 finally have a fixture, re-read this file`).toBe(0);
        expect(newest.issueDate < CUTOFF_DATE, `${t.code}'s newest VO is not pre-cutoff`).toBe(true);
      }
      console.log(`#3712 ${prescribing} VOs prescribe a VBP flat fee, all of them issued before ${CUTOFF_DATE}`);
      expect(prescribing).toBeGreaterThan(0);
    },
  );

  test(
    'the gate did not over-reach — a post-cutoff Blanko VO still gets its other one-time fee, once',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      // The live positive control. Without it, "no VBP fee on post-cutoff VOs" is equally
      // consistent with one-time-fee attachment being broken altogether.
      for (const f of POST_CUTOFF_BLANKO_WITH_SESSIONS) {
        const codes = await api.attachedCodes(f.id);
        console.log(`#3712 ${f.vo} (post-cutoff Blanko, id ${f.id}) attached: ${JSON.stringify(codes)}`);
        expect(codes[f.fee], `${f.vo} lost its ${f.fee} one-time fee`).toBe(1);
        for (const code of VBP_CODES) {
          expect(codes[code], `${f.vo} carries a VBP fee`).toBeUndefined();
        }
      }
    },
  );

  test(
    'FINDING — the ticket\'s PM/QA step cannot fail, because a hand-made Blanko VO never carries the fee',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly'] },
    async () => {
      const blankoCodes = await api.blankoCodes();
      const postCutoff = await api.postCutoffVos();
      const blanko = postCutoff.filter((v) => v.codes.some((c) => blankoCodes.has(c)));
      const withVbp = blanko.filter((v) => v.codes.some((c) => (VBP_CODES as readonly string[]).includes(c)));

      console.log(`#3712 post-cutoff VOs: ${postCutoff.length}, of which Blanko: ${blanko.length}, prescribing a VBP fee: ${withVbp.length}`);
      for (const v of blanko.sort((a, b) => a.issueDate.localeCompare(b.issueDate))) {
        console.log(`#3712   ${v.issueDate} ${v.prescriptionId.padEnd(10)} ${String(v.treatmentStatus).padEnd(12)} acts=${v.activityCount} ${JSON.stringify(v.codes)}`);
      }

      // The Testing Guidance reads: "create a test Blanko VO with an issue date of 30 Jul 2026 or
      // later, document its first treatment, and confirm the Heilmittel breakdown does not include
      // VBP-BV." On staging that step passes on ANY build, fixed or not, because the fee is never
      // prescribed on a hand-created Blanko VO in the first place — and the gate is only reached
      // through Prescription::getOneTimeFees(), i.e. through the prescribed list.
      expect(blanko.length, 'no post-cutoff Blanko VO exists at all — re-check the Blanko code set').toBeGreaterThan(0);
      expect(withVbp.length).toBe(0);
      console.log(
        `#3712 FINDING: all ${blanko.length} post-cutoff Blanko VOs on staging lack a VBP fee in their PRESCRIBED ` +
          `treatments, so the gate is never reached. Following the ticket's PM/QA step therefore confirms nothing: ` +
          `an unfixed build shows the same empty breakdown.`,
      );

      // And the ticket's premise is not true on staging either, which is the reason above: it says
      // "Every Blanko VO automatically carries the VBP-BV one-time flat fee". Blanko VOs issued
      // well BEFORE the cutoff already lack it, so carrying the fee is a property of what was
      // prescribed (the TheOrg import), not of being Blanko.
      const ptBlanko = await api.prescribingVos(
        (await api.catalogue()).find((t) => t.code === 'KG-BV')!.id,
        100,
      );
      const lacking = ptBlanko.filter((v) => !v.codes.includes('VBP-BV-P'));
      const lackingPreCutoff = lacking.filter((v) => v.issueDate < CUTOFF_DATE);
      console.log(
        `#3712 FINDING: of ${ptBlanko.length} PT-Blanko VOs (KG-BV), ${lacking.length} do not prescribe VBP-BV-P — ` +
          `${lackingPreCutoff.length} of them issued BEFORE the cutoff (oldest ${lackingPreCutoff.map((v) => v.issueDate).sort()[0]}), ` +
          `so the ticket's "every Blanko VO automatically carries the fee" does not hold on staging.`,
      );
      expect(lackingPreCutoff.length, 'the premise holds after all — this finding can be withdrawn').toBeGreaterThan(0);
    },
  );

  test(
    'evidence — the populations either side of the cutoff',
    { tag: ['@SuperAdmin', '@BlankoFlatFee', '@ReadOnly', '@Slow'] },
    async () => {
      const fees = await api.oneTimeFees();
      console.log('#3712 one-time fees, VOs prescribing them and their post-cutoff exposure:');
      for (const f of fees) {
        const [all, post] = [await api.prescribingCount(f.id), await api.prescribingCount(f.id, 'post')];
        const gated = (VBP_CODES as readonly string[]).includes(f.code);
        console.log(
          `#3712   ${f.code.padEnd(10)} bv=${String(f.bv).padEnd(5)} gated=${String(gated).padEnd(5)} VOs=${String(all).padEnd(6)} postCutoff=${post}`,
        );
      }

      // The population the commit says an ungated row check would have unbilled: VOs that
      // prescribe the fee but carry no ActivityTreatment row for it. On the dev data set that was
      // 1,311 pairs worth ~EUR 25k; this is the staging equivalent, and it is exactly the set the
      // date scoping protects.
      const attachments = await api.vbpAttachments();
      let prescribing = 0;
      for (const t of await api.vbpTreatments()) prescribing += await api.prescribingCount(t.id);
      console.log(
        `#3712 ${prescribing} (VO, VBP fee) pairs prescribed, ${attachments.size} VOs carry a row → ` +
          `~${prescribing - attachments.size} pairs bill the fee with NO row, all pre-cutoff and all still billing ` +
          `because the row check only applies past the cutoff.`,
      );
      expect(prescribing).toBeGreaterThanOrEqual(attachments.size);

      const odd = (await api.postCutoffVos()).filter((v) => v.issueDate > '2030-01-01');
      for (const v of odd) {
        console.log(
          `#3712 NOTE: VO ${v.prescriptionId} carries a mistyped issue date ${v.issueDate} (${v.treatmentStatus}) — ` +
            `the rule is a plain date comparison, so a typo like this is "post-cutoff" for good.`,
        );
      }
    },
  );
});
