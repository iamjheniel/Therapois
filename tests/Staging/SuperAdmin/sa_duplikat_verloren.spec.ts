import { test, expect } from '@playwright/test';
import {
  AUTOMATIC_ONLY_STATUSES,
  DUPLIKAT,
  DUPLIKAT_TILES,
  DuplikatProcessPage,
  OPEN_STATUSES,
  SELECTABLE_STATUSES,
} from '../../../Pages/superadmin/sa.duplikat-process.page';

/**
 * RC 3.15 #3722 — a VO whose billing deadline passes while still in Anfordern, Erhalten or
 * Versendet moves automatically to the new terminal status **Verloren**, and gets its own tile on
 * the Therapeuten-Orga board.
 *
 * **NO COMMIT ON `release/3.15.0` MENTIONS 3722**, so a commit search reads as "not started" — the
 * fix is decided behaviourally instead, by the tile and the status existing at all.
 *
 * READ-ONLY in effect. Two tests POST a status, and both are deliberately aimed at a VO that is
 * ALREADY in the status being posted, so acceptance would be a no-op (`apply()` returns early on
 * an unchanged status, #3501) and refusal — the expected outcome — writes nothing either way.
 */

/** The nightly sweep, from #3795's Need Command comment. */
const SWEEP_UTC_HOUR = '23';

test.describe('#3722 past-deadline Duplikat VOs move to Verloren', () => {
  test.describe.configure({ mode: 'serial' });

  let p: DuplikatProcessPage;
  let tiles: Record<string, number>;
  let rows: Awaited<ReturnType<DuplikatProcessPage['orgaRisks']>>['rows'];

  // The page object mints through a browser page, so the suite's one-login-per-process cache
  // is shared and #3462's 5-per-minute /auth budget is not spent per test.
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext();
    p = new DuplikatProcessPage(await ctx.newPage());
    await p.connect();
    const risks = await p.orgaRisks();
    tiles = risks.tiles;
    rows = risks.rows;
    console.log('[#3722] tiles:', JSON.stringify(tiles));
  });

  test('DEPLOYED — the Verloren tile and status exist', async () => {
    // AC5: a tile of its own, beside the one it was split out of.
    expect(Object.keys(tiles)).toContain(DUPLIKAT_TILES.LOST);
    expect(Object.keys(tiles)).toContain(DUPLIKAT_TILES.OPEN);
    const lost = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.LOST);
    console.log(`[#3722] tile ${DUPLIKAT_TILES.LOST} = ${tiles[DUPLIKAT_TILES.LOST]}, rows = ${lost.length}`);
    expect(lost.length, 'the population must exist, or nothing below is exercised').toBeGreaterThan(0);
    // The count and its rows agree exactly — unlike duplikatOffen, whose tile deliberately omits
    // the Abgerechnet row it still lists (a pre-existing asymmetry, #3774).
    expect(tiles[DUPLIKAT_TILES.LOST]).toBe(lost.length);
    for (const r of lost) expect(r.duplikatStatus).toBe(DUPLIKAT.VERLOREN);
  });

  test('AC1 — every Verloren VO is past its last billable day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const lost = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.LOST);
    for (const r of lost) {
      const d = (r as any).billingDeadline as string | null;
      const days = (r as any).daysToDeadline as number | null;
      console.log(`[#3722]   ${String(r.voNumber).padEnd(11)} deadline=${d} days=${days}`);
      expect(d, `${r.voNumber} must carry a deadline`).toBeTruthy();
      // Strictly past: AC1 says the move happens the day AFTER the last billable day.
      expect(d! < today, `${r.voNumber} deadline ${d} must be before ${today}`).toBe(true);
      expect(days).toBeLessThan(0);
    }

    // And the converse keeps it honest: nothing still OPEN may be past its deadline, or the
    // sweep has simply not caught up — which would make the above true for the wrong reason.
    const open = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.OPEN);
    const stragglers = open.filter(
      (r) => OPEN_STATUSES.includes(r.duplikatStatus as any) && String((r as any).billingDeadline) < today,
    );
    console.log(`[#3722] open rows past their deadline (should be 0 after a sweep): ${stragglers.length}`);
    expect(stragglers.map((r) => r.voNumber)).toEqual([]);
  });

  test('AC2 — a Verloren VO leaves the open worklist and the Duplikat offen tile', async () => {
    const worklist = await p.worklist();
    const lost = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.LOST).map((r) => r.voNumber);
    console.log(`[#3722] worklist: ${worklist.length} rows — ${JSON.stringify(worklist.map((w) => `${w.voNumber}:${w.duplikatStatus}`))}`);

    expect(worklist.filter((w) => w.duplikatStatus === DUPLIKAT.VERLOREN)).toEqual([]);
    for (const vo of lost) expect(worklist.some((w) => w.voNumber === vo), `${vo} must be off the worklist`).toBe(false);

    // Nor may a Verloren VO count toward the open tile: every row under it is an open status
    // (or the Abgerechnet one the tile already excludes).
    const openRows = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.OPEN);
    expect(openRows.filter((r) => r.duplikatStatus === DUPLIKAT.VERLOREN)).toEqual([]);
    expect(tiles[DUPLIKAT_TILES.OPEN]).toBeLessThanOrEqual(openRows.length);
  });

  test('AC3 — Verloren cannot be set by hand, exactly as Abgerechnet cannot', async () => {
    // Both probes name a VO ALREADY in the status being posted, so an accepted write would be a
    // no-op; the refusal is the assertion and nothing can move either way.
    const lost = rows.find((r) => (r as any).tile === DUPLIKAT_TILES.LOST)!;
    const billed = rows.find((r) => r.duplikatStatus === DUPLIKAT.ABGERECHNET);

    const before = await p.duplikatStatusOf(lost.prescriptionId);
    const res = await p.setStatus(lost.prescriptionId, DUPLIKAT.VERLOREN);
    const detail = String(res.body?.detail ?? res.body?.description ?? '');
    console.log(`[#3722] POST Verloren -> ${res.status} ${detail.slice(0, 90)}`);
    expect(res.status).toBe(422);
    expect(detail).toContain('is set automatically');
    expect(detail).toContain(DUPLIKAT.VERLOREN);

    if (billed) {
      const b = await p.setStatus(billed.prescriptionId, DUPLIKAT.ABGERECHNET);
      const bd = String(b.body?.detail ?? b.body?.description ?? '');
      console.log(`[#3722] POST Abgerechnet -> ${b.status} ${bd.slice(0, 90)}`);
      // AC3's "the same restriction": the two refusals share their shape.
      expect(b.status).toBe(422);
      expect(bd).toContain('is set automatically');
    }

    // Verloren is also terminal: an open status cannot be set on a VO that has reached it.
    const back = await p.setStatus(lost.prescriptionId, DUPLIKAT.ANFORDERN);
    const bk = String(back.body?.detail ?? back.body?.description ?? '');
    console.log(`[#3722] POST Anfordern onto a Verloren VO -> ${back.status} ${bk.slice(0, 90)}`);
    expect(back.status).toBe(422);
    expect(bk).toContain('is final');

    // A nonsense value gets a DIFFERENT refusal, which is what makes the two above specific
    // rather than "this route refuses everything".
    const junk = await p.setStatus(lost.prescriptionId, 'NichtEinStatus');
    const jd = String(junk.body?.detail ?? junk.body?.description ?? '');
    console.log(`[#3722] POST nonsense -> ${junk.status} ${jd.slice(0, 90)}`);
    expect(jd).toContain('Unknown Duplikat status');

    // Nothing moved.
    expect(await p.duplikatStatusOf(lost.prescriptionId)).toBe(before);

    // And the shipped selectable list is unchanged apart from the new exclusion.
    expect(SELECTABLE_STATUSES).not.toContain(DUPLIKAT.VERLOREN);
    expect(AUTOMATIC_ONLY_STATUSES).toEqual([DUPLIKAT.ABGERECHNET, DUPLIKAT.VERLOREN]);
  });

  test('AC4 — the move is recorded as an automatic, system-attributed entry', async () => {
    const lost = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.LOST);
    let checked = 0;
    for (const r of lost) {
      const logs = await p.logs(r.prescriptionId);
      const move = logs.filter(
        (l) => l.type === 'duplikat_status_change' && String(l.value ?? '').includes(DUPLIKAT.VERLOREN),
      );
      if (move.length === 0) {
        console.log(`[#3722]   ${r.voNumber}: no status-change entry in the readable window`);
        continue;
      }
      const last = move[move.length - 1];
      console.log(
        `[#3722]   ${String(r.voNumber).padEnd(11)} ${String(last.createdAt).slice(0, 19)} ` +
          `${JSON.stringify(last.value)} author=${last.createdByName ?? '(system)'}`,
      );
      // AC4: recorded "the same way every other automatic Duplikat status change is" — which in
      // this log means no author at all.
      expect(last.createdByName, `${r.voNumber} must be system-attributed`).toBeFalsy();
      expect(String(last.value)).toMatch(/->\s*Verloren/);
      // It came FROM one of the three in-progress statuses, which is AC1's own precondition.
      const from = String(last.value).split('->')[0].trim();
      expect(OPEN_STATUSES as string[], `${r.voNumber} moved from ${from}`).toContain(from);
      // The nightly sweep runs at 23:15 UTC.
      expect(String(last.createdAt).slice(11, 13), `${r.voNumber} run hour`).toBe(SWEEP_UTC_HOUR);
      checked++;
    }
    console.log(`[#3722] automatic Verloren entries checked: ${checked}`);
    expect(checked, 'at least one move must be readable').toBeGreaterThan(0);
  });

  test('AC6 — the Verloren rows carry the same columns as the Duplikat list', async () => {
    const lost = rows.filter((r) => (r as any).tile === DUPLIKAT_TILES.LOST);
    for (const r of lost) {
      const row = r as any;
      // AC6's named columns, plus #3717's VO number on the shared drill-down table.
      for (const field of ['voNumber', 'patientName', 'therapistName', 'practiceName', 'region', 'duplikatStatus']) {
        expect(row[field], `${r.voNumber} must carry ${field}`).toBeTruthy();
      }
      expect(String(row.voNumber)).toMatch(/\d/);
    }
    console.log(`[#3722] ${lost.length} Verloren rows carry every AC6 column`);
  });
});
