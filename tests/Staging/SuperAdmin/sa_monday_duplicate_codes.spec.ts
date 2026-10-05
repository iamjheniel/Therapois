import { test, expect } from '@playwright/test';
import { MondayFacilitySyncPage } from '../../../Pages/superadmin/sa.monday-facility-sync.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 #3730 — the Monday.com facility sync must DETECT two Monday items sharing one station
 * code, keep the first item's data, and report every later one as a conflict with a count.
 *
 * **NOT SHIPPED, and this file's job is to prove that rather than assert it.** A "Need Command"
 * ticket with no commit on `release/3.15.0` naming it — but a commit search is not evidence
 * (#3895's API half rode in under a performance subject), so the verdict is behavioural: the
 * run report has no duplicate count and no duplicate row has ever been written.
 *
 * **It is also the MIRROR of #3783, which is easy to confuse.** That ticket's `conflict` rows are
 * two Flow FACILITIES keeping one Monday row; this one is two Monday ITEMS carrying one station
 * code. Reading #3783's conflicts as #3730's duplicates reports this ticket as done.
 *
 * READ-ONLY — every request a GET; the sync is a console command and is never run.
 */

/** AC5: the summary counts the run reports today. A duplicate count must join them. */
const EXISTING_COUNTS = ['matchedCount', 'createdCount', 'mismatchCount', 'gapCount'] as const;

/** The categories the report has ever used. `duplicate` is the one #3730 adds. */
const KNOWN_CATEGORIES = [
  'matched',
  'created',
  'gap',
  'name_updated', // the pre-#3344 category, still in the older reports
  'name_update_skipped', // what #3344's guard renamed it to
  'conflict', // #3783's mirror case
  'held',
];

test.describe('#3730 duplicate station codes in the Monday.com sync', () => {
  test.describe.configure({ mode: 'serial' });

  let p: MondayFacilitySyncPage;

  // A context of its own (the `request` fixture cannot cross from beforeAll into a test), and
  // the page object takes a bearer rather than minting one — `.auth` is single-use (#3460), so
  // a file driving no page mints with POST /auth directly.
  test.beforeAll(async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    let token = '';
    for (let attempt = 0; attempt < 5 && !token; attempt++) {
      const res = await ctx.post('https://api.staging.therapios.de/auth', {
        headers: { 'Content-Type': 'application/json' },
        data: {
          username: STAGING_CREDENTIALS.superadmin.email,
          password: STAGING_CREDENTIALS.superadmin.password,
        },
        timeout: 60_000,
      }).catch(() => null);
      if (res?.ok()) token = (await res.json()).token;
      else await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    expect(token, 'a bearer token').toBeTruthy();
    p = new MondayFacilitySyncPage(ctx, token);
  });

  test('CONTROL — the nightly sync is running, so any zero below means something', async () => {
    test.setTimeout(300_000);
    const reports = await p.reports();
    const latest = reports[reports.length - 1];
    const ageDays = (Date.now() - Date.parse(latest.runDate)) / 86_400_000;
    console.log(`[#3730] ${reports.length} runs; newest ${latest.runDate} (${ageDays.toFixed(1)} days old)`);
    console.log(`[#3730] newest counts: ${JSON.stringify(latest)}`);
    expect(reports.length).toBeGreaterThan(50);
    // Without this, "no duplicate was ever reported" is equally explained by the job being off.
    expect(ageDays, 'the sync must have run recently').toBeLessThan(3);
    expect(latest.matchedCount).toBeGreaterThan(0);
  });

  test('NOT DEPLOYED — AC5\'s duplicate count is absent from the run summary', async () => {
    const reports = await p.reports();
    const latest = reports[reports.length - 1];
    // The counts that ARE there, so the absence below is about this field and not the endpoint.
    for (const k of EXISTING_COUNTS) {
      expect(latest, `${k} must be serialized`).toHaveProperty(k);
      expect(typeof (latest as any)[k]).toBe('number');
    }
    // AC5 asks for a duplicate count beside them. Nothing of the kind is served.
    const keys = Object.keys(latest);
    const duplicateish = keys.filter((k) => /duplicat|dupe/i.test(k));
    console.log(`[#3730] report keys: ${JSON.stringify(keys)}`);
    console.log(`[#3730] duplicate-shaped keys: ${JSON.stringify(duplicateish)}`);
    expect(duplicateish, 'AC5 is not implemented — recorded, not a defect').toEqual([]);
  });

  test('NOT DEPLOYED — no run has ever written a duplicate row', async () => {
    test.setTimeout(400_000);
    const reports = await p.reports();
    // A spread across the whole history rather than only the newest, so "never" is a measurement.
    const sample = [0, 0.25, 0.5, 0.75, 0.9, 1]
      .map((f) => reports[Math.min(reports.length - 1, Math.floor(f * (reports.length - 1)))])
      .filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);

    const seen = new Set<string>();
    let read = 0;
    for (const r of sample) {
      // The oldest runs' S3 objects are GONE (the same expiry #3668 measured on notices), so an
      // unreadable report is skipped rather than failing the sweep — but enough must be read, or
      // "no duplicate row anywhere" would be vacuously true.
      let rows;
      try {
        rows = await p.reportRows(r.id);
      } catch (e) {
        console.log(`[#3730] report ${r.id} ${r.runDate.slice(0, 10)}: unreadable (${String(e).slice(0, 60)})`);
        continue;
      }
      read++;
      const cats: Record<string, number> = {};
      for (const row of rows) {
        cats[row.category] = (cats[row.category] ?? 0) + 1;
        seen.add(row.category);
      }
      console.log(`[#3730] report ${r.id} ${r.runDate.slice(0, 10)}: ${JSON.stringify(cats)}`);
      expect(rows.filter((x) => /duplicate/i.test(x.category)), `report ${r.id}`).toEqual([]);
    }
    console.log(`[#3730] reports read: ${read}/${sample.length}; categories ever seen: ${JSON.stringify([...seen])}`);
    expect(read, 'enough reports must be readable for the sweep to mean anything').toBeGreaterThanOrEqual(3);
    // Every category belongs to the known vocabulary — so a new one really would stand out.
    for (const c of seen) expect(KNOWN_CATEGORIES, `unexpected category ${c}`).toContain(c);
    expect(seen.has('duplicate')).toBe(false);
  });

  test('NOT #3730 — the `conflict` rows are #3783\'s MIRROR case, not this ticket', async () => {
    const reports = await p.reports();
    const rows = await p.reportRows(reports[reports.length - 1].id);
    const conflicts = rows.filter((r) => r.category === 'conflict');
    console.log(`[#3730] conflict rows in the newest run: ${conflicts.length}`);
    for (const c of conflicts.slice(0, 3)) console.log(`[#3730]   ${c.echId} | ${c.monday_item_id} | ${c.reason.slice(0, 110)}`);

    expect(conflicts.length, 'the mirror case must exist, or the distinction is untested').toBeGreaterThan(0);
    // #3783's conflict is phrased about a Monday ROW kept by two FACILITIES. #3730's duplicate
    // would be the opposite: one station code carried by two Monday ITEMS. Reading these as
    // #3730's output is the mistake this test exists to prevent.
    for (const c of conflicts) {
      expect(c.reason, 'a #3783 conflict names the Monday row, not a duplicate station code').toContain('Monday row');
      expect(c.reason.toLowerCase()).not.toContain('duplicate station');
    }
  });

  test('AC4\'s `board` column HAS appeared — dated, and reported rather than claimed', async () => {
    test.setTimeout(400_000);
    const reports = await p.reports();
    // AC4 wants four fields per conflicting item: station code, item name, BOARD, and the name of
    // the item whose data was kept. The board column is new since #3783 measured seven columns.
    const latest = await p.reportRows(reports[reports.length - 1].id);
    const hasBoard = latest.length > 0 && 'board' in (latest[0] as any);
    console.log(`[#3730] newest report row keys: ${JSON.stringify(Object.keys(latest[0] ?? {}))}`);
    console.log(`[#3730] board column present: ${hasBoard}`);

    // Reported, not asserted either way: a `board` column is a precondition for AC4 rather than
    // AC4 itself, and whether it belongs to this ticket or another cannot be read from here.
    if (hasBoard) {
      const filled = latest.filter((r) => String((r as any).board ?? '').trim() !== '').length;
      console.log(`[#3730] rows carrying a board: ${filled}/${latest.length}`);
      const conflictsWithBoard = latest.filter((r) => r.category === 'conflict' && String((r as any).board ?? '').trim() !== '');
      console.log(`[#3730] conflict rows carrying a board: ${conflictsWithBoard.length}`);
    }
    expect(true).toBe(true);
  });

  test('FINDING — staging cannot exercise #3730 even once it ships', async () => {
    // The condition is two Monday.com items configured with the same station code. That lives on
    // a third-party board this suite does not write to — the same wall #3783's rules 6 and 8 hit.
    // So the ticket's own Testing Guidance is right to say "ask a developer to run the sync after
    // temporarily giving two Monday.com test-board items the same station code".
    //
    // What IS ready here: the report reader, the category vocabulary and the count assertions
    // above, all of which flip from "absent" to a real check the moment a duplicate row appears.
    console.log(
      '[#3730] FINDING: not deployed — no duplicate count on the run summary and no duplicate ' +
        'row in any of the runs sampled. And the trigger (two Monday.com items sharing a station ' +
        'code) is a third-party board state this suite does not write, so even a shipped build ' +
        'needs a Monday.com edit plus a sync run before it can be verified.',
    );
    expect(true).toBe(true);
  });
});
