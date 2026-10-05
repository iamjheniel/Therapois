import { test, expect } from '@playwright/test';
import {
  CLOSED_STATUSES,
  ExpiryHintPage,
  NOT_SHOWN_STATUSES,
  berlinToday,
  countsTowardExpiryHint,
  daysUntilExpiry,
  isStillRunning,
  type BoardRow,
} from '../../../Pages/therapist/therapist.expiry-hint.page';
import { UntreatedDaysPage } from '../../../Pages/therapist/therapist.untreated-days.page';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 #3849 — the T Board's 14-day expiry hint counts only running, non-follow-up VOs.
 *
 * Shipped as `76f76ff451d` (PR #3864). READ-ONLY: every API request is a GET, and the screen is
 * navigated and read — the one control operated is the hint's own "Diese anzeigen", which sets a
 * client-side filter chip and writes nothing.
 *
 * The PM left a purpose-built fixture block on Sara Fischer's board (100160-1 … 100175-1, all
 * validity 12.10.2026), one VO per status plus five follow-up pairs. Each is re-read before use,
 * because two of them have already moved since the PM's run of 4 Oct.
 */

const SARA = 24;
const TODAY = berlinToday();

/** The PM's fixtures, by the AC row each one stands for. */
const FIXTURES = {
  aktiv: '100160-1',
  closed: {
    Abgerechnet: '100161-1',
    'Fertig Behandelt': '100162-1',
    Abgebrochen: '100163-1',
    Abgelaufen: '100164-1',
    Archiviert: '100165-1',
  } as Record<string, string>,
  notShown: {
    Bereit: '100166-1',
    'For Review': '100167-1',
    Pending: '100173-1',
    'Sent Back to Therapist': '100174-1',
  } as Record<string, string>,
  followUps: ['100168-2', '100169-2', '100170-2', '100171-2', '100172-2'],
};

test.describe('#3849 the 14-day expiry hint counts only running, non-follow-up VOs', () => {
  test.describe.configure({ mode: 'serial' });

  let api: ExpiryHintPage;
  let rows: BoardRow[];

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(300_000);
    api = new ExpiryHintPage(await playwright.request.newContext());
    rows = await api.boardRows(SARA);
    console.log(`[#3849] Berlin today ${TODAY}; Sara Fischer's board payload: ${rows.length} rows`);
  });

  test('DEPLOYED — the payload carries followUpParentStatus, on follow-up rows and nowhere else', async () => {
    const cover = ExpiryHintPage.parentStatusCoverage(rows);
    console.log('[#3849] parent-status coverage:', JSON.stringify(cover));

    // The field is new in this fix, so its presence IS the API half's deployment probe.
    expect(cover.followUps, 'the board must carry follow-up VOs at all').toBeGreaterThan(0);
    expect(cover.withParent, 'every follow-up row must carry its parent status').toBe(cover.followUps);
    // "null when it follows none" — a non-follow-up row must never carry one.
    expect(cover.nonFollowUpsWithParent).toBe(0);

    // And the parent is usually NOT on the board, which is why a server-side field was needed
    // rather than inferring the parent's status from the other rows on screen.
    const ids = new Set(rows.map((r) => r.number));
    const parentsOffBoard = rows.filter((r) => r.isFollowUp).filter((r) => {
      const stem = r.number.replace(/-(\d+)$/, '');
      const n = Number(r.number.match(/-(\d+)$/)?.[1] ?? 0);
      return n > 1 && !ids.has(`${stem}-${n - 1}`);
    }).length;
    console.log(`[#3849] follow-up rows whose immediate predecessor number is not on the board: ${parentsOffBoard}`);
  });

  test('the hint pool is the board\'s OWN rows — completed included, four statuses never listed', async () => {
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.treatmentStatus] = (byStatus[r.treatmentStatus] ?? 0) + 1;
    console.log('[#3849] statuses in the payload:', JSON.stringify(byStatus));

    // The closed VOs arrive in each group's `completed` array, not `prescriptions`. Reading only
    // the latter makes the fix look like it drops nothing.
    const completed = rows.filter((r) => r.kind === 'completed');
    expect(completed.length, 'the payload must carry the inactive pool').toBeGreaterThan(0);
    expect(completed.every((r) => !isStillRunning(r.treatmentStatus) || NOT_SHOWN_STATUSES.includes(r.treatmentStatus as any))).toBe(true);

    // The four statuses the board never lists are in the payload and must be dropped before the
    // predicate runs — AC1's wording was corrected on 5 Oct to say exactly this.
    const shown = ExpiryHintPage.shown(rows);
    const notShown = rows.length - shown.length;
    console.log(`[#3849] payload ${rows.length} -> board shows ${shown.length} (${notShown} in never-listed statuses)`);
    expect(notShown).toBeGreaterThan(0);
  });

  test('AC1 — the five closed statuses leave the hint; Aktiv stays', async () => {
    const shown = ExpiryHintPage.shown(rows);
    const before = ExpiryHintPage.inWindow(shown, TODAY);
    const after = ExpiryHintPage.expected(rows, TODAY);
    const dropped = before.filter((r) => !after.includes(r));
    console.log(`[#3849] in the 14-day window: ${before.length} (the OLD hint) -> ${after.length} (the NEW hint); dropped ${dropped.length}`);
    for (const r of dropped) {
      console.log(`[#3849]   - ${r.number.padEnd(11)} d=${daysUntilExpiry(r.validityDate, TODAY)} ${r.treatmentStatus}`);
    }

    // The fix must actually remove something, or the comparison is vacuous.
    expect(dropped.length, 'the fix must drop closed VOs from this board').toBeGreaterThan(0);
    for (const r of dropped) expect(isStillRunning(r.treatmentStatus), `${r.number}`).toBe(false);
    for (const r of after) expect(isStillRunning(r.treatmentStatus), `${r.number}`).toBe(true);

    // Each of the PM's five closed fixtures, re-read rather than assumed.
    for (const [status, number] of Object.entries(FIXTURES.closed)) {
      const vo = await api.voByNumber(number);
      expect(vo, `${number} must exist`).toBeTruthy();
      expect(vo.treatmentStatus, `${number} must still be ${status}`).toBe(status);
      const d = daysUntilExpiry(String(vo.validityDate ?? '').slice(0, 10), TODAY);
      console.log(`[#3849]   fixture ${number} ${status} validity=${String(vo.validityDate).slice(0, 10)} d=${d}`);
      expect(d, `${number} must sit in the window, or it proves nothing`).toBeGreaterThanOrEqual(0);
      expect(d!).toBeLessThanOrEqual(14);
      expect(after.some((r) => r.number === number), `${number} must NOT be counted`).toBe(false);
    }

    // AC1 row 2: Aktiv is counted.
    const aktiv = await api.voByNumber(FIXTURES.aktiv);
    expect(aktiv.treatmentStatus).toBe('Aktiv');
    expect(after.some((r) => r.number === FIXTURES.aktiv), `${FIXTURES.aktiv} must be counted`).toBe(true);
  });

  test('AC1 as corrected 5 Oct — the board never lists Bereit / For Review / Pending / Sent Back', async () => {
    const after = ExpiryHintPage.expected(rows, TODAY);
    for (const [status, number] of Object.entries(FIXTURES.notShown)) {
      const vo = await api.voByNumber(number);
      expect(vo?.treatmentStatus, `${number}`).toBe(status);
      const d = daysUntilExpiry(String(vo.validityDate ?? '').slice(0, 10), TODAY);
      // In the window AND still running — so only "the board does not list it" keeps it out.
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d!).toBeLessThanOrEqual(14);
      expect(isStillRunning(status), `${status} is not one of the five closed`).toBe(true);
      expect(after.some((r) => r.number === number), `${number} must not be counted`).toBe(false);
      console.log(`[#3849]   ${number} ${status} d=${d} — in window, running, still not counted`);
    }
  });

  test('AC2 — a follow-up VO whose predecessor has CLOSED counts like any running VO', async () => {
    const after = ExpiryHintPage.expected(rows, TODAY);
    for (const number of FIXTURES.followUps) {
      const row = rows.find((r) => r.number === number);
      expect(row, `${number} must be on the board`).toBeTruthy();
      expect(row!.isFollowUp, `${number} must be a follow-up VO`).toBe(true);
      expect(row!.followUpParentStatus, `${number} must carry a parent status`).toBeTruthy();
      expect(isStillRunning(row!.followUpParentStatus), `${number}'s parent must be closed today`).toBe(false);
      expect(after.some((r) => r.number === number), `${number} must be counted`).toBe(true);
      console.log(`[#3849]   ${number} parent=${row!.followUpParentStatus} -> counted`);
    }
  });

  test('AC2\'s exclusion half has no live fixture — measured, not assumed', async () => {
    test.setTimeout(400_000);
    // Boards deliberately spread across the therapists this suite already knows.
    const boards = [24, 12, 6, 31, 198, 236];
    let inWindow = 0;
    const held: string[] = [];
    let runningParentRows = 0;
    for (const id of boards) {
      const r = id === SARA ? rows : await api.boardRows(id);
      const shown = ExpiryHintPage.shown(r);
      runningParentRows += shown.filter((x) => x.isFollowUp && x.followUpParentStatus && isStillRunning(x.followUpParentStatus)).length;
      for (const x of ExpiryHintPage.inWindow(shown, TODAY)) {
        inWindow++;
        if (isStillRunning(x.treatmentStatus) && x.isFollowUp && x.followUpParentStatus && isStillRunning(x.followUpParentStatus)) {
          held.push(`${id}:${x.number}<-${x.followUpParentStatus}`);
        }
      }
    }
    console.log(`[#3849] across ${boards.length} boards: ${inWindow} rows in the window, ${runningParentRows} follow-ups with a RUNNING parent, ${held.length} of them in the window`);
    console.log('[#3849] held by AC2:', JSON.stringify(held));

    // Follow-ups with a running parent DO exist — so the rule has something to act on …
    expect(runningParentRows, 'the population AC2 governs must exist').toBeGreaterThan(0);
    // … but none is near its validity date, so the exclusion is unexercised on live data today.
    if (held.length === 0) {
      console.log(
        '[#3849] COVERAGE GAP: no follow-up VO with a still-running predecessor currently has a ' +
          'validity date inside 14 days, so AC2\'s exclusion is not demonstrated on live data. ' +
          'The PM\'s own fixture for it (100169-1 as Bereit) now reads Fertig Behandelt; setting ' +
          'it back to Bereit restores the case, since 100169-2 is Aktiv and 7 days out.',
      );
    }
  });

  test('the predicate itself, driven at every case including the fail-open', async () => {
    // AC1's table.
    for (const s of CLOSED_STATUSES) {
      expect(countsTowardExpiryHint({ treatmentStatus: s }), s).toBe(false);
    }
    for (const s of ['Aktiv', ...NOT_SHOWN_STATUSES]) {
      expect(countsTowardExpiryHint({ treatmentStatus: s }), s).toBe(true);
    }
    // AC2's table.
    expect(countsTowardExpiryHint({ treatmentStatus: 'Aktiv', isFollowUp: true, followUpParentStatus: 'Aktiv' })).toBe(false);
    for (const s of CLOSED_STATUSES) {
      expect(
        countsTowardExpiryHint({ treatmentStatus: 'Aktiv', isFollowUp: true, followUpParentStatus: s }),
        `follow-up after ${s}`,
      ).toBe(true);
    }
    expect(countsTowardExpiryHint({ treatmentStatus: 'Aktiv', isFollowUp: false, followUpParentStatus: null })).toBe(true);

    // THE FAIL-OPEN, which the comment calls out deliberately: an UNKNOWN parent status counts
    // the VO rather than hiding it, because an over-count is a row the therapist can dismiss and
    // an under-count is work that never reaches them. A port that read "unknown" as "running"
    // would under-count and read as the fix being too aggressive.
    expect(countsTowardExpiryHint({ treatmentStatus: 'Aktiv', isFollowUp: true, followUpParentStatus: null })).toBe(true);
    expect(countsTowardExpiryHint({ treatmentStatus: 'Aktiv', isFollowUp: true, followUpParentStatus: '' })).toBe(true);
    // The same reasoning upward: an unreadable status counts as running.
    expect(countsTowardExpiryHint({ treatmentStatus: 'Etwas Neues' })).toBe(true);

    // The window's own bounds are inclusive at both ends, and a past validity is out.
    expect(daysUntilExpiry('2026-10-05', '2026-10-05')).toBe(0);
    expect(daysUntilExpiry('2026-10-19', '2026-10-05')).toBe(14);
    expect(daysUntilExpiry('2026-10-20', '2026-10-05')).toBe(15);
    expect(daysUntilExpiry('2026-10-04', '2026-10-05')).toBe(-1);
    expect(daysUntilExpiry(null, '2026-10-05')).toBeNull();
  });

  test('AC3 on screen — the hint number, the listed rows and the payload all agree', async ({ page }) => {
    test.setTimeout(500_000);
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
    const ud = new UntreatedDaysPage(page);
    const board = new TherapistBoardV2Page(page);
    await ud.open({ therapist: 'Sara Fischer' });
    await page.waitForTimeout(6000);

    const { headline, count, listed } = await ExpiryHintPage.readHint(page, board as any);
    const expected = ExpiryHintPage.expected(rows, TODAY);
    console.log(`[#3849] painted: ${JSON.stringify(headline)}; listed ${listed.length}; computed ${expected.length}`);

    // AC3: one predicate drives both, so the number and the rows must agree …
    expect(count, 'the hint number must equal the rows it lists').toBe(listed.length);
    // … and both must equal what the payload says, set for set, in both directions.
    const mine = [...expected.map((r) => r.number)].sort();
    const theirs = [...listed].sort();
    const onlyComputed = mine.filter((n) => !theirs.includes(n));
    const onlyPainted = theirs.filter((n) => !mine.includes(n));
    console.log('[#3849] only computed:', JSON.stringify(onlyComputed), '| only painted:', JSON.stringify(onlyPainted));
    expect(onlyComputed).toEqual([]);
    expect(onlyPainted).toEqual([]);
    expect(count).toBe(expected.length);

    // And the number genuinely moved: the pre-fix rule would have counted the closed ones too.
    const oldRule = ExpiryHintPage.inWindow(ExpiryHintPage.shown(rows), TODAY).length;
    console.log(`[#3849] the pre-fix rule would have shown ${oldRule} here, the board shows ${count}`);
    expect(oldRule).toBeGreaterThan(count);

    // Not one listed row is in a status AC1 excludes — the ticket's own reproduction, inverted.
    for (const n of listed) {
      const row = rows.find((r) => r.number === n);
      if (row) expect(isStillRunning(row.treatmentStatus), `${n} is listed`).toBe(true);
    }
  });
});
