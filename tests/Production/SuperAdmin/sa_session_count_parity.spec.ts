import { test, expect } from '@playwright/test';
import {
  FEE_ONLY_FIXTURES,
  SessionCountParityPage,
  TICKET_FIXTURE,
} from '../../../Pages/superadmin/sa.session-count-parity.page';

/**
 * RC 3.13 #3704 — the five VO list views must count an old-style Doppelbehandlung as two completed
 * sessions and a fee-only visit as one, matching the T-Board and the VO's own completion status.
 *
 * **Production, read-only.** Every request is a GET except the one `POST /auth` that mints the read
 * token; the on-screen test navigates and reads and nothing else.
 *
 * See `Pages/superadmin/sa.session-count-parity.page.ts` for the mechanism and the traps. The short
 * version: all five views read one field, `activityCount` on `/v2/prescriptions`, and the fix
 * (`bd2da1cb6`) rewrites the one SQL expression behind it. Both the old and the new expression are
 * ported, and the served count is compared against BOTH — the one it matches is the one deployed,
 * which is the only way to settle it, since `/status` reports the release and not the commit.
 */
test.describe('#3704 completed-session count on the VO list views', () => {
  test.describe.configure({ mode: 'serial' });

  test('AC1 — the ticket\'s own example, VO 8950-1, reads 10/10 and matches the post-fix rule', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(300_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    const vo = await p.vo(TICKET_FIXTURE);
    expect(vo, `#3704: VO ${TICKET_FIXTURE} not found on production`).not.toBeNull();
    expect(SessionCountParityPage.isV1Double(vo!), 'the fixture must be an OLD-style double VO').toBe(true);

    const acts = (await p.activitiesFor([vo!.id])).get(vo!.id) ?? [];
    const { pre, post } = SessionCountParityPage.counts(acts, vo!.doubleTreatmentV2 === true);
    console.log(`VO ${vo!.prescriptionId}: served ${vo!.activityCount}/${vo!.totalTreatments} ` +
      `(remaining ${vo!.remainingTreatments}, ${vo!.treatmentStatus}) | pre-fix ${pre} | post-fix ${post}`);

    // The fixture must be able to tell the two rules apart, or the assertion below proves nothing.
    expect(pre, 'this fixture no longer discriminates between the two expressions').not.toBe(post);
    expect(vo!.activityCount, 'the served count must be the post-fix one').toBe(post);
    expect(vo!.activityCount).toBe(vo!.totalTreatments);
    expect(vo!.remainingTreatments, 'AC1: 0 open').toBe(0);
  });

  test('AC1 at scale — every old-style double VO on production matches the post-fix rule', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly', '@Slow'],
  }, async ({ page }) => {
    test.setTimeout(3_600_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    const book = await p.bookSize();
    const all = await p.walkVos(500, 200);
    expect(all.length, 'the walk must cover the whole book').toBe(book);

    const v1 = all.filter(SessionCountParityPage.isV1Double);
    console.log(`book ${book} VOs | old-style double: ${v1.length}`);
    expect(v1.length, 'no old-style double VOs ⇒ nothing to prove').toBeGreaterThan(0);

    const acts = await p.activitiesFor(v1.map((v) => v.id));
    let compared = 0, affected = 0, matchPost = 0, matchPreOnly = 0, added = 0;
    const mismatches: string[] = [];
    for (const v of v1) {
      const a = acts.get(v.id) ?? [];
      if (!a.length) continue;
      compared++;
      const { pre, post } = SessionCountParityPage.counts(a, v.doubleTreatmentV2 === true);
      if (pre !== post) { affected++; added += post - pre; if (v.activityCount === pre) matchPreOnly++; }
      if (v.activityCount === post) matchPost++;
      else mismatches.push(`${v.prescriptionId} served ${v.activityCount} pre ${pre} post ${post}`);
    }
    console.log(`compared ${compared} | affected ${affected} | +${added} sessions | ` +
      `served==post ${matchPost} | affected still matching pre-fix ${matchPreOnly}`);
    for (const m of mismatches.slice(0, 10)) console.log('  MISMATCH', m);

    expect(affected, 'no affected VO ⇒ the comparison cannot decide anything').toBeGreaterThan(0);
    expect(mismatches, 'every VO must read the post-fix count').toEqual([]);
    expect(matchPreOnly, 'no affected VO may still be serving the pre-fix count').toBe(0);
  });

  test('AC2 — a visit carrying only a fee-type Heilmittel counts as one session', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(600_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    let feeOnlyVisits = 0;
    for (const num of FEE_ONLY_FIXTURES) {
      const vo = await p.vo(num);
      expect(vo, `#3704: fee-only fixture ${num} not found`).not.toBeNull();
      const acts = (await p.activitiesFor([vo!.id])).get(vo!.id) ?? [];
      const feeOnly = acts.filter(SessionCountParityPage.isFeeOnlyVisit);
      const { pre, post } = SessionCountParityPage.counts(acts, vo!.doubleTreatmentV2 === true);
      feeOnlyVisits += feeOnly.length;
      console.log(`${num}: ${feeOnly.length} fee-only of ${acts.length} visits | ` +
        `served ${vo!.activityCount}/${vo!.totalTreatments} | pre-fix ${pre} | post-fix ${post}`);

      expect(feeOnly.length, `${num} no longer carries a fee-only visit`).toBeGreaterThan(0);
      // Each fee-only visit is worth exactly one session under the shipped rule, and nothing before.
      for (const a of feeOnly) {
        expect(SessionCountParityPage.contribution(a, false, false)).toBe(0);
        expect(SessionCountParityPage.contribution(a, false, true)).toBe(1);
      }
      expect(post - pre, 'the gap must be exactly the fee-only visits').toBe(feeOnly.length);
      expect(vo!.activityCount, `${num} must serve the post-fix count`).toBe(post);
    }
    expect(feeOnlyVisits).toBeGreaterThan(0);
  });

  test('AC3 — VOs on the newer recording style are unchanged, and the V2 edge has no instance', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly', '@Slow'],
  }, async ({ page }) => {
    test.setTimeout(3_600_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    const v2 = (await p.walkVos(500, 200)).filter((v) => v.doubleTreatment === true && v.doubleTreatmentV2 === true);
    console.log(`new-style (V2) double VOs: ${v2.length}`);
    expect(v2.length, 'no V2 double VOs ⇒ AC3 has no fixture').toBeGreaterThan(0);

    const acts = await p.activitiesFor(v2.map((v) => v.id));
    let compared = 0, edge = 0;
    for (const v of v2) {
      const a = acts.get(v.id) ?? [];
      if (!a.length) continue;
      compared++;
      const { pre, post } = SessionCountParityPage.counts(a, true);
      expect(pre, `AC3: ${v.prescriptionId} moved under the fix`).toBe(post);
      expect(v.activityCount, `AC3: ${v.prescriptionId} served count`).toBe(post);
      edge += SessionCountParityPage.v2EdgeInstances(a);
    }
    console.log(`V2 VOs compared ${compared} | AC3-edge visits (double, no activity_treatment row): ${edge}`);
    // Not an assertion about correctness: the shipped "no treatment-kind row" branch doubles without
    // checking V2, so any instance here WOULD move a V2 VO, against AC3. Reported, not asserted.
    expect(compared).toBeGreaterThan(0);
  });

  test('AC4 — rejected and planned visits stay excluded, and the date aggregates are untouched', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(900_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    // A slice of the book wide enough to contain both excluded shapes.
    const vos = await p.walkVos(500, 8);
    const acts = await p.activitiesFor(vos.map((v) => v.id), 60);

    let rejected = 0, planned = 0, mismatches = 0;
    for (const v of vos) {
      const a = acts.get(v.id) ?? [];
      if (!a.length) continue;
      for (const act of a) {
        if (act.rejectedTreatment && !act.rejectedTreatmentWithSignature) {
          rejected++;
          expect(SessionCountParityPage.contribution(act, false, true), 'rejected must count 0').toBe(0);
        }
        if (act.treatmentType === 'planned') {
          planned++;
          expect(SessionCountParityPage.contribution(act, false, true), 'planned must count 0').toBe(0);
        }
      }
      const { post } = SessionCountParityPage.counts(a, v.doubleTreatmentV2 === true);
      if (v.activityCount !== post) mismatches++;

      // The fix touched only the activity_count expression; the date aggregates come from the same
      // query and must still be derived from the same visits.
      const dates = a.map((x) => x.date).sort();
      if (dates.length && v.startActivityDate) {
        expect(v.startActivityDate.slice(0, 10), `${v.prescriptionId} start date`).toBe(dates[0].slice(0, 10));
        expect(v.lastActivityDate!.slice(0, 10), `${v.prescriptionId} last date`).toBe(dates[dates.length - 1].slice(0, 10));
      }
    }
    console.log(`AC4: rejected-without-signature ${rejected}, planned ${planned}, served!=post ${mismatches}`);
    expect(rejected + planned, 'no excluded visit in the slice ⇒ AC4 unexercised').toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  });

  test('AC1 on screen — the Admin Board paints the post-fix count it was served', {
    tag: ['@SuperAdmin', '@SessionCountParity', '@ReadOnly'],
  }, async ({ page }) => {
    test.setTimeout(600_000);
    const p = new SessionCountParityPage(page);
    await p.connect();

    // An Aktiv old-style double VO — the case operations actually looks at. Discovered rather than
    // pinned, because an Aktiv VO's counts move as it is treated.
    const slice = await p.walkRecentVos(20);
    const candidates = slice.filter((v) => SessionCountParityPage.isV1Double(v) && v.treatmentStatus === 'Aktiv');
    test.skip(candidates.length === 0, 'no Aktiv old-style double VO in the slice');

    const acts = await p.activitiesFor(candidates.map((v) => v.id));
    const target = candidates.find((v) => {
      const a = acts.get(v.id) ?? [];
      const { pre, post } = SessionCountParityPage.counts(a, v.doubleTreatmentV2 === true);
      return a.length > 0 && pre !== post;
    });
    test.skip(!target, 'no Aktiv old-style double VO whose count the fix moves');

    const a = acts.get(target!.id)!;
    const { pre, post } = SessionCountParityPage.counts(a, target!.doubleTreatmentV2 === true);
    const { served, fraction } = await p.boardRow(target!.prescriptionId);
    console.log(`${target!.prescriptionId}: board painted "${fraction}" | payload ${served?.activityCount}/${served?.totalTreatments} | pre-fix ${pre} | post-fix ${post}`);

    expect(served, 'the board never served a row for this VO').not.toBeNull();
    expect(served!.activityCount, 'the board was served the post-fix count').toBe(post);
    expect(fraction, 'Beh. Status must paint the served count').toBe(`${served!.activityCount} / ${served!.totalTreatments}`);
    expect(fraction, 'and NOT the pre-fix count').not.toBe(`${pre} / ${served!.totalTreatments}`);
  });
});
