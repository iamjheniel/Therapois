import { test, expect } from '@playwright/test';
import { Facility, MondayFacilitySyncPage, ReportRow, SyncReport } from '../../../Pages/superadmin/sa.monday-facility-sync.page';
import { API_BASE, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.14 #3783 — each facility follows its OWN Monday row in the nightly sync (commit `b97630f8d`,
 * no PR). This is the follow-up to #3344, and it closes that ticket's standing finding.
 *
 * `SyncMondayFacilitiesCommand` paired Flow facilities to Monday rows by the Einrichtungs-ID, so
 * when a Monday row's ID changed, whichever facility happened to hold that ID took the row's
 * address, and an empty twin was created for the row's real occupant (the ticket names Hamburg
 * 20 Sep and Hannover 17 Sep). Pairing is now on `mondayItemId`; the ID is a fallback only when the
 * kept row is gone from Monday or the facility has none, and never takes a row another active
 * facility keeps.
 *
 * ## Deployment IS client-decidable — through the run's own REPORT
 *
 * An earlier version of this file asserted the opposite, having probed `/elderly_care_home_logs`,
 * `/facility_logs` and `/monday_sync_logs` (all 404) and concluded the command was unobservable.
 * That was wrong: the surface is a *report*, not a log. **`GET /sync_facility_reports`** serves one
 * row per run with `matchedCount`/`createdCount`/`gapCount`, and **`/{id}/signed-url`** serves the
 * CSV with AC6's seven columns. The probe is the CATEGORY VOCABULARY: `conflict` is a category this
 * ticket introduced, so a report containing conflict rows was written by the fixed code. Measured —
 * reports 145/147/148 carry `matched`/`name_update_skipped`/`gap` and NO conflict; 149 onward carry
 * `conflict: 5`. `GET /status` still cannot answer (release, not commit — #3704); the report can.
 *
 * ## So what this file actually tests
 *
 * Two things, and they are different in kind:
 *
 *  1. **The rules have live input.** Both conflict shapes the fix introduces exist on staging right
 *     now — two pairs of active facilities keeping one Monday row, and one Einrichtungs-ID held by
 *     two active facilities. A fix for a case that never occurs proves nothing, so this is asserted
 *     before anything else.
 *  2. **Nothing the rules freeze may move.** A conflict means "neither facility was changed", so
 *     every facility in one is pinned field for field. That is a real regression guard from the very
 *     next nightly run: under the fix these fingerprints are stable for good, and under a regression
 *     one of them drifts by morning.
 *
 * ## The pre-fix damage is still in the data, and the ticket plans for that
 *
 * Facility 222 ("Tagesstätte Falkenbek", 11 VOs) carries facility 221's address and the real
 * Falkenbek is an empty twin, facility 239. The ticket's Out of Scope covers this explicitly —
 * "Existing wrong facility data on production. The operations team corrects it by hand before
 * go-live" — so it is recorded rather than reported as a defect. It is worth recording because the
 * staging state IS the ticket's own rule-9 example ("PFLEGEN & WOHNEN FINKENAU" and "Tagesstätte
 * Falkenbek" both keep row 1848742792 today) and its rule-10 example (two facilities with ID E23,
 * one without a row number), so a QA verifying either rule meets exactly these rows.
 */

const FACILITIES = 'https://api.staging.therapios.de/elderly_care_homes';

/**
 * The two rule-9 conflicts as they stand, pinned so a change is a failure rather than a surprise.
 *
 * Pinned rather than re-derived on purpose: re-deriving "whatever is in a conflict today" and then
 * asserting it equals itself is vacuous. The point is that THESE facilities, in THIS state, must not
 * move.
 */
const FROZEN: Record<number, Record<string, unknown>> = {
  221: {
    echId: 'HH38',
    name: 'PFLEGEN & WOHNEN FINKENAU',
    address: 'Finkenau 11, 22081 Hamburg, Hamburg-Nord, Germany',
    mondayItemId: '1848742792',
    status: true,
  },
  222: {
    echId: 'HH39',
    name: 'Tagesstätte Falkenbek',
    address: 'Finkenau 11, 22081 Hamburg, Hamburg-Nord, Germany',
    mondayItemId: '1848742792',
    status: true,
  },
  216: {
    echId: 'ST 5',
    name: 'Kursana Domizil Vaihingen - Haus St. Kilian',
    address: 'Stuttgarter Str. 90, 71665 Vaihingen an der Enz, Germany',
    mondayItemId: '2114947979',
    status: true,
  },
  218: {
    echId: 'ST5',
    name: 'Kursana Domizil Vaihingen - Haus St. Kilian',
    address: 'Stuttgarter Str. 90, 71665 Vaihingen an der Enz, Germany',
    mondayItemId: '2114947979',
    status: true,
  },
};

/** The Hamburg case the ticket names, and #3344's E23 case, as identified fixtures. */
const HAMBURG = { finkenau: 221, falkenbekCorrupted: 222, falkenbekEmptyTwin: 239 };
const E23 = { inUse: 12, holdsTheRow: 37 };

test.describe('#3783 — each facility follows its own Monday row', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  let sync: MondayFacilitySyncPage;
  let facilities: Facility[];
  let bearer: string;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    // Minted directly: `apiBearerToken()` reads a browser's localStorage first and this file drives
    // no page at all. A refresh token is single-use (#3460), so `.auth` is not an option either.
    const auth = await request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    expect(auth.status(), 'POST /auth').toBe(200);
    bearer = (await auth.json()).token as string;
    sync = new MondayFacilitySyncPage(request, bearer);
    facilities = await sync.facilities();
    console.log(`  ${facilities.length} facilities; ${facilities.filter((f) => f.mondayItemId).length} keep a Monday row`);
  });

  test('deployment — the run REPORT is the probe, and it shows a clean cutover', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    // `conflict` is a category THIS ticket introduced (the dev's own comment: "New report entries:
    // held, conflict"), so a report carrying conflict rows was written by the fixed code. That makes
    // the vocabulary a genuine deployment probe where /status cannot be one.
    const reports = await sync.reports();
    const latest = reports[reports.length - 1];
    console.log(`  ${reports.length} sync reports; latest id=${latest.id} ${latest.runDate}`);

    const seen: { id: number; runDate: string; categories: Record<string, number> }[] = [];
    for (const r of reports.slice(-7)) {
      const rows = await sync.reportRows(r.id);
      seen.push({ id: r.id, runDate: r.runDate, categories: MondayFacilitySyncPage.countByCategory(rows) });
    }
    for (const x of seen) console.log(`    report ${x.id} ${x.runDate.slice(0, 19)} ${JSON.stringify(x.categories)}`);

    const withConflict = seen.filter((x) => (x.categories.conflict ?? 0) > 0);
    const withoutConflict = seen.filter((x) => (x.categories.conflict ?? 0) === 0);
    expect(withConflict.length, 'the fixed code has produced at least one report').toBeGreaterThan(0);
    // The cutover is monotonic: once conflicts appear they never disappear again.
    if (withoutConflict.length) {
      const lastOld = Math.max(...withoutConflict.map((x) => x.id));
      const firstNew = Math.min(...withConflict.map((x) => x.id));
      console.log(`  cutover: last report without conflicts = ${lastOld}, first with = ${firstNew}`);
      expect(firstNew, 'conflicts start after the last pre-fix report and never lapse').toBeGreaterThan(lastOld);
    }

    // And the NIGHTLY is running the fixed code — not just the developer's manual apply. The
    // EventBridge schedule is 19:30 UTC daily, so a report stamped ~19:3x is the scheduled run.
    const latestRows = await sync.reportRows(latest.id);
    const latestCats = MondayFacilitySyncPage.countByCategory(latestRows);
    console.log(`  latest run ${latest.runDate} categories: ${JSON.stringify(latestCats)}`);
    expect(latestCats.conflict ?? 0, 'the most recent run was written by the fixed code').toBeGreaterThan(0);

    // The facilities themselves still carry no timestamp, which is why the STATE tests below pin
    // fingerprints rather than reading a "last changed" field.
    const item = await sync.facilityRaw(HAMBURG.falkenbekCorrupted);
    for (const stamp of ['updatedAt', 'createdAt', 'syncedAt', 'lastSyncedAt']) {
      expect(item[stamp], `no ${stamp} on a facility`).toBeUndefined();
    }
  });

  test('AC6 the report entries — categories, the seven columns, and each conflict naming the other', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    const latest = await sync.latestReport();
    const rows = await sync.reportRows(latest.id);
    const cats = MondayFacilitySyncPage.countByCategory(rows);
    console.log(`  report ${latest.id} (${latest.runDate.slice(0, 19)}): ${JSON.stringify(cats)}`);

    // AC6: "Each entry shows the facility ID(s), the Flow name, the Monday name and the Monday row
    // number involved" plus a reason.
    for (const col of ['category', 'echId', 'flow_name', 'monday_name', 'address', 'monday_item_id', 'reason']) {
      expect(Object.keys(rows[0]), `the CSV carries the ${col} column`).toContain(col);
    }

    const conflicts = rows.filter((r: ReportRow) => r.category === 'conflict');
    expect(conflicts.length, 'the run reports conflicts').toBeGreaterThan(0);
    for (const c of conflicts) {
      console.log(`    conflict ${c.echId} row=${c.monday_item_id}: ${c.reason}`);
      expect(c.echId, 'a conflict names the facility ID').not.toBe('');
      expect(c.flow_name, 'and the Flow name').not.toBe('');
      expect(c.reason, 'and says why, naming the OTHER facility').toMatch(/neither (was|facility was) changed/);
      expect(c.reason, 'identifying it by ID and row').toMatch(/ID [^,]+, Monday row \d+/);
    }

    // The counts on the collection row must agree with the file it points at — two surfaces, one run.
    expect(cats.matched ?? 0, 'matchedCount agrees with the file').toBe(latest.matchedCount);
    expect(cats.created ?? 0, 'createdCount agrees with the file').toBe(latest.createdCount);
    expect(cats.gap ?? 0, 'gapCount agrees with the file').toBe(latest.gapCount);
  });

  test('the new rules have live input — both conflict shapes exist on staging', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    // Rule 9: two active facilities keeping one Monday row.
    const sharedRows = MondayFacilitySyncPage.duplicateMondayRows(facilities);
    console.log(`  active facilities sharing a Monday row: ${sharedRows.size} group(s)`);
    for (const [row, group] of sharedRows) {
      console.log(`    row ${row}: ${group.map((f) => `${f.id} ${f.echId} ${f.name}`).join('  |  ')}`);
    }
    expect(sharedRows.size, 'rule 9 (shared Monday row) has a live instance').toBeGreaterThan(0);

    // Rule 10: one Einrichtungs-ID held by two active facilities.
    const sharedIds = MondayFacilitySyncPage.duplicateEchIds(facilities.filter((f) => f.status));
    console.log(`  active facilities sharing an Einrichtungs-ID: ${sharedIds.size} group(s)`);
    for (const [id, group] of sharedIds) {
      console.log(`    ${id}: ${group.map((f) => `${f.id} row=${f.mondayItemId} ${f.name}`).join('  |  ')}`);
    }
    expect(sharedIds.size, 'rule 10 (shared Einrichtungs-ID) has a live instance').toBeGreaterThan(0);

    // Rule 2's fallback population: the ID is only consulted for a facility keeping no row.
    const fallback = MondayFacilitySyncPage.idFallbackOnly(facilities);
    console.log(`  active facilities that can only pair by ID (no Monday row): ${fallback.length}`);
    expect(fallback.length, 'rule 2 has a live population too').toBeGreaterThan(0);
  });

  test('AC — a facility in a conflict is not changed (pinned field for field)', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    // "neither was changed" is the whole of rules 9 and 10. Every nightly run from here on either
    // leaves these alone or fails this test the following morning.
    for (const [id, expected] of Object.entries(FROZEN)) {
      const live = facilities.find((f) => f.id === Number(id));
      expect(live, `facility ${id} still exists`).toBeTruthy();
      const actual = {
        echId: live!.echId,
        name: live!.name,
        address: live!.address,
        mondayItemId: live!.mondayItemId,
        status: live!.status,
      };
      console.log(`  ${id}: ${MondayFacilitySyncPage.fingerprint(live!)}`);
      expect(actual, `facility ${id} is in a conflict and must not have been changed`).toEqual(expected);
    }

    // And the conflict itself must still be a conflict — if one side silently lost its row number,
    // the pair would quietly start syncing again and the pins above would stop meaning anything.
    const rows = MondayFacilitySyncPage.duplicateMondayRows(facilities);
    for (const row of ['1848742792', '2114947979']) {
      expect(rows.get(row)?.map((f) => f.id).sort((a, b) => a - b), `row ${row} is still kept by both`).toBeTruthy();
    }
  });

  test('AC — a practice keeps its ID, name and address (rule 4)', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    const practices = facilities.filter((f) => f.type === 'practice');
    console.log(`  practices: ${practices.length}`);
    expect(practices.length, 'there are practices to protect').toBeGreaterThan(0);

    // The strongest client-side statement of rule 4: not one practice keeps a Monday row, so none can
    // be paired by row at all, and the ID fallback then hands it to the branch that rewrites nothing.
    const withRow = practices.filter((f) => f.mondayItemId !== null);
    for (const p of practices) console.log(`    ${p.id} ${p.echId.padEnd(10)} row=${p.mondayItemId} ${p.name}`);
    expect(withRow, 'no practice is paired to a Monday row').toEqual([]);
  });

  test('#3344 closed — the in-use facility behind a duplicate ID is no longer invisible', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    // This suite's #3344 finding: `$echMap[$echId] = $ech` over `findAll()` let one row overwrite the
    // other, and the gap report was built from the DEDUPLICATED keys — so the dropped facility was
    // not matched, not renamed, not skipped AND not gap-reported. It appeared nowhere in the run.
    //
    // #3783 rebuilds the gap loop over `$facilities` (every row), skipping only those a plan involves,
    // so an unpaired facility is now reported. The report is console-only; what is checkable here is
    // that its input still exists and has exactly the shape that used to vanish.
    const inUse = facilities.find((f) => f.id === E23.inUse);
    const holder = facilities.find((f) => f.id === E23.holdsTheRow);
    expect(inUse && holder, 'the E23 pair still exists').toBeTruthy();
    expect(inUse!.echId, 'both hold the same Einrichtungs-ID').toBe(holder!.echId);
    expect(inUse!.status && holder!.status, 'both are active').toBe(true);

    // The one that is actually used holds no Monday row, so it can only ever pair by ID — and the ID
    // is taken by the other one, which keeps a row. That is precisely the "appears nowhere" case.
    expect(inUse!.mondayItemId, 'the in-use facility keeps no Monday row').toBeNull();
    expect(holder!.mondayItemId, 'its twin keeps the row').toBeTruthy();

    const control = await sync.patientsTotal();
    const vos = await sync.voCount(E23.inUse);
    const twinVos = await sync.voCount(E23.holdsTheRow);
    expect(vos, 'the VO filter is not being ignored').not.toBe(control);
    console.log(`  ${E23.inUse} (${inUse!.name}): ${vos} VOs, no Monday row`);
    console.log(`  ${E23.holdsTheRow} (${holder!.name}): ${twinVos} VOs, row ${holder!.mondayItemId}`);
    expect(vos, 'the invisible one is the one carrying the caseload').toBeGreaterThan(0);

    // PROVEN, not inferred: the run's own report now lists E23 TWICE — the twin that keeps the row
    // as `matched`, and the in-use facility as a `gap`. Under #3344 the gap report was built from
    // the DEDUPLICATED ID map, so this facility appeared nowhere in the run at all.
    const latest = await sync.latestReport();
    const rows = await sync.reportRows(latest.id);
    const e23 = rows.filter((r: ReportRow) => r.echId === inUse!.echId);
    for (const r of e23) console.log(`    report: ${r.category.padEnd(10)} ${r.flow_name} row=${r.monday_item_id || '(none)'}`);
    expect(e23.length, 'E23 appears twice in the run — once per facility').toBe(2);
    expect(
      e23.some((r) => r.category === 'gap' && r.flow_name === inUse!.name),
      '#3344 CLOSED: the in-use facility is gap-reported instead of vanishing',
    ).toBe(true);
    expect(
      e23.some((r) => r.category === 'matched' && r.flow_name === holder!.name),
      'and its twin is the one that matched',
    ).toBe(true);
  });

  test('the pre-fix damage is still on staging, and rule 9 now freezes it', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    const finkenau = facilities.find((f) => f.id === HAMBURG.finkenau)!;
    const corrupted = facilities.find((f) => f.id === HAMBURG.falkenbekCorrupted)!;
    const twin = facilities.find((f) => f.id === HAMBURG.falkenbekEmptyTwin)!;

    const corruptedVos = await sync.voCount(corrupted.id);
    const twinVos = await sync.voCount(twin.id);

    console.log(`  ${finkenau.id} ${finkenau.echId} ${finkenau.name}`);
    console.log(`     address ${finkenau.address}  row ${finkenau.mondayItemId}`);
    console.log(`  ${corrupted.id} ${corrupted.echId} ${corrupted.name} — ${corruptedVos} VOs`);
    console.log(`     address ${corrupted.address}  row ${corrupted.mondayItemId}`);
    console.log(`  ${twin.id} ${twin.echId} ${twin.name} — ${twinVos} VOs`);
    console.log(`     address ${twin.address}  row ${twin.mondayItemId}`);

    // The bug's two halves, both still present:
    //  (a) the facility that held the ID took the row's address …
    expect(corrupted.address, 'facility 222 still carries 221\'s address').toBe(finkenau.address);
    expect(corrupted.name, 'under its own, different name').not.toBe(finkenau.name);
    //  (b) … and an empty twin was created for the row's real occupant.
    expect(twin.name, 'facility 239 is the same facility by name').toBe(corrupted.name);
    expect(twin.address, 'but carries the real address').not.toBe(corrupted.address);
    expect(twinVos, 'and holds no VOs — it is the empty twin').toBe(0);
    expect(corruptedVos, 'while the corrupted row carries the caseload').toBeGreaterThan(0);

    console.log(
      `\n  NOT A FINDING — the ticket's Out of Scope says so outright: "Existing wrong facility data ` +
        `on production. The operations team corrects it by hand before go-live." Recorded because it ` +
        `is the state a QA meets on staging, and because it is the concrete consequence of rule 9: ` +
        `${finkenau.id} and ${corrupted.id} keep one Monday row, so they are now a PERMANENT conflict ` +
        `— the sync will never change either again — while ${corrupted.id} goes on serving ` +
        `${corruptedVos} VOs under ${finkenau.id}'s address. The hand-repair is NOT under way — the run's own ` +
        `report says so. Facility ${twin.id} keeps the ID "${twin.echId}" because its Monday row ` +
        `${twin.mondayItemId} proposes HH39 and ${corrupted.id} still holds it: a rule-8 conflict ` +
        `("New facility ID HH39 is held by …"), a THIRD conflict shape beside the two rule-9 pairs. ` +
        `An earlier version of this file read "${twin.echId}" as a human placeholder; the report ` +
        `shows it is the sync declining to rename. Clearing ${corrupted.id} is what lets rule 1 ` +
        `give ${twin.id} its real ID. Same shape for 216/218.`,
    );
  });

  test('no NEW twin facility has appeared', {
    tag: ['@SuperAdmin', '@MondayRowPairing', '@ReadOnly'],
  }, async () => {
    // "A new facility is not created when its ID would collide" and "never takes a row another active
    // facility keeps" together mean the twin set must stop growing. Pinned, so a new one fails here.
    const twins = MondayFacilitySyncPage.twinGroups(facilities);
    const names = [...twins.values()].map((g) => g[0].name).sort();
    for (const [, group] of twins) {
      console.log(`  ${group[0].name}: ${group.map((f) => `${f.id}/${f.echId}/row=${f.mondayItemId}`).join('  ')}`);
    }
    expect(names, 'the twin set is unchanged since 2026-09-24').toEqual(
      [
        'Haus Deckstein',
        'Johanneshaus Wohnen und Pflege - Ernst Zimmer Haus',
        'Kursana Domizil Vaihingen - Haus St. Kilian',
        'Tagesstätte Falkenbek',
      ].sort(),
    );
  });

  // ────────────────────────────── not reachable ─────────────────────────────

});
