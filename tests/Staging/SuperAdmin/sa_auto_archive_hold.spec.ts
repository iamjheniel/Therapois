import { test, expect } from '@playwright/test';
import {
  ARCHIVE_REASON,
  AutoArchiveHoldPage,
  lastBillableDay,
  legacyDuplikatDeadline,
  shouldHold,
  type ArchiveLog,
  type Vo,
} from '../../../Pages/superadmin/sa.auto-archive-hold.page';

/**
 * RC 3.15 #3795 — automatic archiving keeps unbilled expired VOs until their billing deadline.
 *
 * Shipped as monorepo `a516e8abd5b` + `588e633f071` + `0c2d525118b` on `release/3.15.0`.
 *
 * READ-ONLY. Every request is a GET. The nightly job is never run by hand — it is console-only
 * and `app:prescription:auto-archive` without `--dry-run` writes real statuses, so this file
 * reads what the scheduled runs left behind instead.
 */

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

/** The archiver's own schedule, from the log: 20:46 UTC nightly. */
const SINCE = '2026-09-30';

test.describe('#3795 the auto-archive holds unbilled expired VOs', () => {
  test.describe.configure({ mode: 'serial' });

  let p: AutoArchiveHoldPage;
  let expired: Vo[];
  let tail: ArchiveLog[];

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(600_000);
    const request = await playwright.request.newContext();
    p = new AutoArchiveHoldPage(request);
    // One walk, shared: ~2,000 rows at 300/page is the whole file's cost.
    expired = await p.walkByStatus('Abgelaufen');
    tail = await p.statusChangeTail();
    console.log(`[#3795] walked ${expired.length} Abgelaufen VOs; ${tail.length} status-change rows in the tail`);
  });

  test('the 90-day population must be WALKED — expiredAt is silently ignored as a filter', async () => {
    const totals = await p.expiredAtFilterTotals();
    for (const [k, v] of Object.entries(totals)) console.log(`[#3795] ${String(v).padStart(6)}  ${k}`);

    const unfiltered = totals.unfiltered;
    expect(unfiltered).toBeGreaterThan(0);
    // Every expiredAt form answers the unfiltered total, exactly like a bogus key …
    for (const k of ['expiredAt[before]', 'expiredAt[after]', 'expiredAt[strictly_before]', 'exists[expiredAt]']) {
      expect(totals[k], `${k} must be silently ignored`).toBe(unfiltered);
    }
    expect(totals.bogusControl).toBe(unfiltered);
    // … while a REAL filter narrows, which is what stops this being "the collection ignores everything".
    expect(totals['insuranceType (a REAL filter)']).toBeLessThan(unfiltered);
  });

  test('CONTROL — the nightly archiver is awake, and AC2\'s log entry is unchanged', async () => {
    const archived = tail.filter((r) => r.to === 'Archiviert');
    const fromExpired = archived.filter((r) => r.from === 'Abgelaufen');
    expect(archived.length, 'the tail must contain archiving at all').toBeGreaterThan(0);

    const byDay: Record<string, number> = {};
    for (const a of archived) byDay[a.at.slice(0, 10)] = (byDay[a.at.slice(0, 10)] ?? 0) + 1;
    console.log('[#3795] Archiviert by day:', JSON.stringify(byDay));

    // It ran recently — otherwise "nothing was archived" would explain any hold below.
    const newest = archived[archived.length - 1].at;
    const ageDays = AutoArchiveHoldPage.daysAgo(newest, NOW);
    console.log(`[#3795] newest archive ${newest} (${ageDays.toFixed(1)} days old)`);
    expect(ageDays, 'the archiver must have run in the last few days').toBeLessThan(5);

    // It runs unattended: system-written, no author.
    const authored = fromExpired.filter((r) => r.author).length;
    console.log(`[#3795] ${fromExpired.length} Abgelaufen->Archiviert, ${authored} with an author`);
    expect(authored).toBe(0);

    // AC2: "with the same log entry as today".
    const reasons = [...new Set(fromExpired.map((r) => r.reason))];
    console.log('[#3795] reasons:', JSON.stringify(reasons));
    expect(reasons).toContain(ARCHIVE_REASON);

    // The run time is the schedule the Need Command names (20:45 UTC).
    const hours = [...new Set(fromExpired.map((r) => r.at.slice(11, 13)))];
    console.log('[#3795] archive run hours (UTC):', JSON.stringify(hours));
    expect(hours).toContain('20');
  });

  test('AC1 — a VO past 90 days with a signed session is HELD, which the old rule could not do', async () => {
    const past90 = expired.filter((v) => v.expiredAt && AutoArchiveHoldPage.daysAgo(v.expiredAt, NOW) >= 90);
    const held = past90.filter((v) => v.activityCount > 0);
    console.log(`[#3795] Abgelaufen past 90 days: ${past90.length}; of those with a signed session: ${held.length}`);
    for (const v of past90) {
      console.log(
        `[#3795]   ${v.number} expired=${v.expiredAt?.slice(0, 10)} ` +
          `(${AutoArchiveHoldPage.daysAgo(v.expiredAt!, NOW).toFixed(1)}d) ins=${v.insuranceType} ` +
          `signedSessions=${v.activityCount} batches=${v.billingBatchCount} invoice=${v.hasInvoice}`,
      );
    }

    // THE WHOLE POINT: under the pre-fix rule no VO could be here at all — every Abgelaufen VO was
    // archived on the first nightly after it passed 90 days, so this population was always empty.
    expect(held.length, 'at least one held VO is what shows the new rule is running').toBeGreaterThan(0);

    // Each held VO must genuinely satisfy AC1, re-derived rather than assumed.
    const sessions = await p.lastSessions(held.map((v) => v.id));
    for (const v of held) {
      const ls = sessions.get(v.id)!.signed;
      expect(ls, `${v.number} must have a signed session date`).toBeTruthy();
      const hold = shouldHold({
        expiredDaysAgo: AutoArchiveHoldPage.daysAgo(v.expiredAt!, NOW),
        hasSignedSession: true,
        lastSigned: ls,
        insuranceType: v.insuranceType,
        today: TODAY,
      });
      console.log(`[#3795]   ${v.number} lastSigned=${ls} deadline=${lastBillableDay(ls!)} -> hold=${hold}`);
      expect(hold, `${v.number} must satisfy AC1's keep rule`).toBe(true);
      // AC1's "still Abgelaufen" clause: billing is what moves a VO out, so a held VO is unbilled.
      expect(v.treatmentStatus).toBe('Abgelaufen');
      expect(v.billingBatchCount, `${v.number} must be in no billing submission`).toBe(0);
    }

    // And the archiver was awake while it was eligible — so this is a decision, not a missed run.
    const oldest = held.reduce((a, b) => (a.expiredAt! < b.expiredAt! ? a : b));
    const eligibleFrom = new Date(new Date(oldest.expiredAt!).getTime() + 90 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const runsSince = [
      ...new Set(
        tail
          .filter((r) => r.to === 'Archiviert' && r.at.slice(0, 10) >= eligibleFrom)
          .map((r) => r.at.slice(0, 10)),
      ),
    ];
    console.log(`[#3795] ${oldest.number} became eligible ${eligibleFrom}; archiver ran on ${JSON.stringify(runsSince)}`);
    expect(runsSince.length, 'the archiver must have run since the held VO became eligible').toBeGreaterThan(0);
  });

  test('AC1 converse — every VO the recent runs DID archive fails the keep rule', async () => {
    test.setTimeout(400_000);
    const ids = [
      ...new Set(
        tail
          .filter((r) => r.to === 'Archiviert' && r.from === 'Abgelaufen' && r.at.slice(0, 10) >= SINCE)
          .map((r) => r.prescriptionId)
          .filter((n): n is number => n !== null),
      ),
    ];
    console.log(`[#3795] VOs archived from Abgelaufen since ${SINCE}: ${ids.length}`);
    expect(ids.length, 'the comparison needs a non-empty archived set').toBeGreaterThan(0);

    const vos = await p.byIds(ids);
    expect(vos.length).toBe(ids.length);
    const withSigned = vos.filter((v) => v.activityCount > 0);
    console.log(`[#3795]   of those, with a signed session: ${withSigned.length}`);

    // A VO with a signed session may only have been archived if its GKV deadline had passed.
    const sessions = withSigned.length ? await p.lastSessions(withSigned.map((v) => v.id)) : new Map();
    const wronglyArchived: string[] = [];
    for (const v of withSigned) {
      const ls = sessions.get(v.id)?.signed ?? null;
      const hold = shouldHold({
        expiredDaysAgo: 999,
        hasSignedSession: true,
        lastSigned: ls,
        insuranceType: v.insuranceType,
        today: TODAY,
      });
      console.log(`[#3795]   ${v.number} ins=${v.insuranceType} lastSigned=${ls} -> ${hold ? 'SHOULD HAVE BEEN HELD' : 'archive correct'}`);
      if (hold) wronglyArchived.push(v.number);
    }
    expect(wronglyArchived, 'no VO satisfying AC1 may have been archived').toEqual([]);

    // Taken with the test above, the same runs partitioned the population exactly: they took the
    // VOs the rule does not protect and left the one it does.
    console.log(`[#3795] partition: ${ids.length} archived (none holdable) vs the held VO(s) above`);
  });

  test('AC3 — the truth table, driven against the ported rule', async () => {
    // The ticket's own table: run date 1 Oct 2026, VOs expired 22 Jun 2026 unless stated.
    const T = '2026-10-01';
    const expiredDays = (iso: string) => (new Date(T).getTime() - new Date(iso).getTime()) / 86_400_000;
    const base = expiredDays('2026-06-22'); // 101 days

    const rows: [string, boolean, ReturnType<typeof shouldHold>][] = [
      ['1  GKV, last signed 10 Jun 2026, unbilled', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2026-06-10', insuranceType: 'public', today: T })],
      ['2  same, in a submission not yet sent (still Abgelaufen)', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2026-06-10', insuranceType: 'public', today: T })],
      ['4  no signed session', false,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: false, lastSigned: null, insuranceType: 'public', today: T })],
      ['5  GKV, last signed 10 Nov 2025, deadline 31 Aug 2026 (passed)', false,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-11-10', insuranceType: 'public', today: T })],
      ['6  GKV, last signed 15 Dec 2025, deadline 30 Sep 2026 (passed on 1 Oct)', false,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-12-15', insuranceType: 'public', today: T })],
      ['7  PKV, invoice Nicht gesendet', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2026-06-10', insuranceType: 'private', today: T })],
      ['8  PKV, only a cancelled invoice', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2026-06-10', insuranceType: 'private', today: T })],
      ['9  PKV, last signed 10 Nov 2025 (no deadline for PKV)', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-11-10', insuranceType: 'private', today: T })],
      ['10 BG, last signed 10 Nov 2025 (no deadline for BG)', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-11-10', insuranceType: 'accident', today: T })],
      ['11 expired 10 Aug 2026, only 52 days ago', true,
        shouldHold({ expiredDaysAgo: expiredDays('2026-08-10'), hasSignedSession: true, lastSigned: '2026-06-10', insuranceType: 'public', today: T })],
      ['-- no insurance type, last signed 10 Nov 2025 (no deadline)', true,
        shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-11-10', insuranceType: null, today: T })],
    ];
    for (const [label, want, got] of rows) {
      console.log(`[#3795] ${got === want ? 'ok  ' : 'FAIL'} ${label} -> ${got ? 'stays Abgelaufen' : 'archived'}`);
      expect(got, label).toBe(want);
    }

    // ROW 3 IS DELIBERATELY ABSENT, and it is not a gap: it describes a VO whose submission was
    // set to "Vollständig und Gesendet", so the VO has left Abgelaufen and become Abgerechnet.
    // The hold predicate never sees it — criterion 4's 30-day branch does, which the AC4 test
    // covers. AC1 says this outright ("Billing is what moves a VO out of Abgelaufen … No separate
    // check of billing submissions or invoices is needed"), so modelling a `billed` flag here
    // would be re-implementing a condition the shipped rule deliberately does not have.
    expect(rows.length, 'ten of AC3\'s eleven rows are hold decisions').toBe(11);

    // Row 6 is the boundary and is what makes the table discriminating: 30 Sep 2026 is the last
    // billable day, so the VO is held THAT day and archived the next.
    expect(lastBillableDay('2025-12-15')).toBe('2026-09-30');
    expect(shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-12-15', insuranceType: 'public', today: '2026-09-30' })).toBe(true);
    expect(shouldHold({ expiredDaysAgo: base, hasSignedSession: true, lastSigned: '2025-12-15', insuranceType: 'public', today: '2026-10-01' })).toBe(false);
  });

  test('the month-overflow the shared helper exists to fix', async () => {
    // The ticket's own example, and the reason a naive "+9 months" is wrong: PHP turns 31 May
    // into 31 Feb -> 3 Mar, and "last day of this month" then lands a month late.
    expect(lastBillableDay('2026-05-31')).toBe('2027-02-28');
    expect(lastBillableDay('2025-12-31')).toBe('2026-09-30'); // the Developer Reference's trap
    // Every day of a month shares one deadline, which is what "last day of the month" means.
    for (const d of ['2026-05-01', '2026-05-15', '2026-05-29', '2026-05-30', '2026-05-31']) {
      expect(lastBillableDay(d), d).toBe('2027-02-28');
    }
    // A leap year is reached correctly.
    expect(lastBillableDay('2027-05-10')).toBe('2028-02-29');
  });

  test('AC4 — Abgerechnet VOs are still archived, unchanged', async () => {
    const archived = tail.filter((r) => r.to === 'Archiviert');
    const fromBilled = archived.filter((r) => r.from === 'Abgerechnet');
    const fromExpired = archived.filter((r) => r.from === 'Abgelaufen');
    console.log(`[#3795] in the tail: ${fromBilled.length} Abgerechnet->Archiviert, ${fromExpired.length} Abgelaufen->Archiviert`);

    // The 30-day branch is untouched by this ticket, so it must still be firing.
    expect(fromBilled.length, 'the Abgerechnet branch must still run').toBeGreaterThan(0);
    expect(fromBilled.every((r) => !r.author), 'and unattended').toBe(true);
    // Both branches belong to the same job, so they share its run hour.
    const hours = [...new Set(fromBilled.map((r) => r.at.slice(11, 13)))];
    console.log('[#3795] Abgerechnet archive hours (UTC):', JSON.stringify(hours));
    expect(hours).toContain('20');
  });

  test('AC5 — the Duplikat board uses the same last billable day, inclusive', async () => {
    const rows = await p.duplikatWorklist();
    console.log(`[#3795] Duplikat worklist rows: ${rows.length}`);
    expect(rows.length, 'AC5 needs at least one VO in the process').toBeGreaterThan(0);

    const sessions = await p.lastSessions(rows.map((r) => r.prescriptionId));
    let matchesNew = 0;
    let matchesOld = 0;
    let anchorDiscriminating = 0;

    for (const r of rows) {
      const s = sessions.get(r.prescriptionId)!;
      expect(s.signed, `${r.voNumber} must have a signed session`).toBeTruthy();
      const wantNew = lastBillableDay(s.signed!);
      const wantOld = legacyDuplikatDeadline(s.signed!);
      if (r.billingDeadline === wantNew) matchesNew++;
      if (r.billingDeadline === wantOld) matchesOld++;
      if (s.any && s.signed && s.any.slice(0, 7) !== s.signed.slice(0, 7)) anchorDiscriminating++;
      console.log(
        `[#3795]   ${r.voNumber.padEnd(10)} lastSigned=${s.signed} lastAny=${s.any} ` +
          `served=${r.billingDeadline} new=${wantNew} old=${wantOld} days=${r.daysToDeadline}`,
      );

      // "0 Tage" on the LAST billable day: the countdown is deadline - today, inclusive.
      if (r.billingDeadline && r.daysToDeadline !== null) {
        const calc = Math.round((new Date(r.billingDeadline).getTime() - new Date(TODAY).getTime()) / 86_400_000);
        expect(r.daysToDeadline, `${r.voNumber} countdown`).toBe(calc);
      }
    }

    // The two rules land on DIFFERENT DAYS, so this is a real discrimination and not a tautology.
    console.log(`[#3795] matches NEW (inclusive month-end): ${matchesNew}/${rows.length}; OLD (first of next month): ${matchesOld}/${rows.length}`);
    expect(matchesNew).toBe(rows.length);
    expect(matchesOld).toBe(0);

    // Every served deadline is a month END — the single clearest signature of the change.
    for (const r of rows) {
      const d = new Date(r.billingDeadline!);
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      expect(
        new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10),
        `${r.voNumber} deadline must be the last day of its month`,
      ).toBe(next.toISOString().slice(0, 10));
    }

    // The anchor change needs a VO whose last activity is LATER than its last signed session,
    // in another month — otherwise both anchors agree and the comparison proves nothing.
    console.log(`[#3795] rows where lastAny is in a later month than lastSigned: ${anchorDiscriminating}`);
    if (anchorDiscriminating === 0) {
      console.log('[#3795] NOTE: no row separates the anchor change today — the month-end half is still decided above.');
    }
  });
});
