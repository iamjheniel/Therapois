import { test, expect } from '@playwright/test';
import { Facility, FacilityAttachments, MondayFacilitySyncPage } from '../../../Pages/superadmin/sa.monday-facility-sync.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — the nightly Monday.com facility sync must not rename a facility that is in use (#3344).
 *
 * `SyncMondayFacilitiesCommand` matches Flow facilities to Monday rows on the Einrichtungs-ID and
 * renames in place when the names differ; the guard added here skips the rename when the facility
 * has at least one patient or VO, and reports the mismatch instead. **The guard is deployed** —
 * commit `03a93bfc` on `release/3.12.0`, not the `6cc3f431` the ticket says is still waiting to be
 * cherry-picked.
 *
 * **The sync is a console command, so this file tests its inputs and outcomes, not the run.** What
 * is observable: which facility each Einrichtungs-ID resolves to, how much is attached to it, and
 * whether `mondayItemId` was written — the command sets that on **every** match, so its presence is
 * a footprint of a facility the sync actually reached.
 *
 * **Finding** → `fixme`: the ID→facility match is not one-to-one. `$echMap[$ech->getEchId()] = $ech`
 * over `findAll()` lets a second facility overwrite the first, and the gap report is computed over
 * deduplicated IDs (`array_diff(array_keys($echMap), $seenEchIds)`), so the dropped row appears in
 * no output path at all. On staging that hides a facility holding **243 VOs across 37 patients** while
 * the guard evaluates 0/0 on its twin and would rename freely.
 *
 * **Measurement trap.** `countAttachedRecords()` counts patients AND prescriptions, but `/patients`
 * registers **no** facility filter and API Platform ignores an unknown query parameter silently — a
 * "filtered" total that equals the unfiltered 8,364 is being ignored, not answered. Only the VO half
 * is reachable, so `vos > 0` proves the guard applies while `vos === 0` does not prove it does not.
 * A 2026-09-01 staging dump was used once to close that gap and confirmed the VO proxy was exact
 * there — **0 facilities have patients but no VOs** — but the proxy is not exact by construction and
 * the assertions below are written to stay honest without the dump.
 *
 * **Read-only — every request is a GET.**
 */

/** AC1's fixture: the facility from the ticket's own screenshots, renamed because it was unused. */
const RENAMED = { echId: 'RR51', id: 235, name: 'Rosenhof Seniorenwohnanlage Hochdahl' };
/** AC2's fixtures: in use, so the guard must leave their names alone. */
const IN_USE = [
  { echId: 'ST1', id: 208, vos: 29 },
  { echId: 'HH38', id: 222, vos: 11 },
];

test.describe('Monday facility sync — rename guard', () => {
  let auth: string;
  let inventory: FacilityAttachments[];

  test.beforeAll(async ({ request }) => {
    const response = await request.post('https://api.staging.therapios.de/auth', {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    expect(response.status()).toBe(200);
    auth = (await response.json()).token;
  });

  test(
    'AC1 — the facility the sync renamed was genuinely unused',
    { tag: ['@SuperAdmin', '@MondayFacilitySync', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const sync = new MondayFacilitySyncPage(request, auth);
      const facility = (await sync.facilities()).find((row) => row.id === RENAMED.id);
      expect(facility, `facility ${RENAMED.id} must exist`).toBeTruthy();

      // The rename happened: Flow now carries Monday's name for RR51.
      expect(facility!.echId).toBe(RENAMED.echId);
      expect(facility!.name, 'AC1: an unused facility is renamed automatically, as before').toBe(RENAMED.name);
      // And it was allowed because nothing is attached — the guard's condition, from the visible half.
      const vos = await sync.voCount(RENAMED.id);
      console.log(`${RENAMED.echId} (id ${RENAMED.id}) "${facility!.name}" — ${vos} VOs`);
      expect(vos, 'the guard may only allow a rename on a facility with nothing attached').toBe(0);
    },
  );

  for (const fixture of IN_USE) {
    test(
      `AC2 — ${fixture.echId} is in use, so the guard's condition holds`,
      { tag: ['@SuperAdmin', '@MondayFacilitySync', '@ReadOnly'] },
      async ({ request }) => {
        test.setTimeout(300_000);
        const sync = new MondayFacilitySyncPage(request, auth);
        const facility = (await sync.facilities()).find((row) => row.id === fixture.id);
        expect(facility, `facility ${fixture.id} must exist`).toBeTruthy();

        const vos = await sync.voCount(fixture.id);
        console.log(`${fixture.echId} (id ${fixture.id}) "${facility!.name}" — ${vos} VOs`);
        // Whether Monday proposed a different name for it is console-only; what a client can settle
        // is that the guard's predicate is true here, which is what makes "skipped" the right outcome.
        expect(vos, 'the facility must be in use for the skip branch to be the one under test').toBeGreaterThan(0);
        // The sync has reached this row, so it is the one an Einrichtungs-ID match resolves to.
        expect(facility!.mondayItemId, 'a matched facility carries the Monday item id the sync writes').toBeTruthy();
      },
    );
  }

  test(
    'The guard covers the facilities that are actually in use',
    { tag: ['@SuperAdmin', '@MondayFacilitySync', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const sync = new MondayFacilitySyncPage(request, auth);
      inventory = await sync.facilitiesWithAttachments();
      const protectedFacilities = inventory.filter((row) => row.vos > 0);
      const renameable = inventory.filter((row) => row.vos === 0);
      console.log(`facilities ${inventory.length} | in use, guard applies ${protectedFacilities.length} | unused, rename stays automatic ${renameable.length}`);

      expect(inventory.length, 'staging must still hold its facility list').toBeGreaterThan(200);
      // The point of the change: the automatic rename is now the exception, not the rule.
      expect(protectedFacilities.length, 'most facilities are in use, so most are protected').toBeGreaterThan(renameable.length);

      // The silent-filter trap, pinned so nobody "fixes" the VO proxy by reaching for /patients.
      const unfiltered = await sync.patientsTotal();
      const pretendFiltered = await sync.patientsTotal('&elderlyCareHome=1');
      console.log(`/patients total ${unfiltered} | with a facility filter ${pretendFiltered}`);
      expect(
        pretendFiltered,
        '/patients registers no facility filter — an equal total proves the parameter is ignored, not answered',
      ).toBe(unfiltered);
    },
  );

  test(
    'Every Einrichtungs-ID resolves to exactly one facility',
    { tag: ['@SuperAdmin', '@MondayFacilitySync', '@ReadOnly'] },
    async ({ request }) => {
      test.fixme(
        true,
        'Two Einrichtungs-IDs are held by two facilities each, and the sync can only ever see one of ' +
          'them. `$echMap[$ech->getEchId()] = $ech` over findAll() means the later row overwrites the ' +
          'earlier, and the gap report is built from the deduplicated keys — ' +
          '`$gaps = array_diff(array_keys($echMap), $seenEchIds)` — so the dropped facility is not ' +
          'matched, not renamed, not skipped AND not gap-reported. It appears nowhere in the run. ' +
          '(A gap row would also print $echMap[$echId]->getName(), i.e. the survivor\'s name.) ' +
          'Re-measured live on 2026-09-02, after the PM\'s 2026-09-01 verification and Jarn\'s 29 Aug ' +
          'run: E23 is held by facility 12 (**243 VOs across 37 patients, and NO mondayItemId**) and by ' +
          'facility 37 (**0 VOs, 0 patients**, mondayItemId 1707662413). The sync keeps 37, the guard ' +
          'evaluates 0/0 and would rename automatically — while the row carrying 243 VOs is never ' +
          'examined. **HH38 has changed shape since the first pass and is now the more revealing case:** ' +
          'BOTH its rows carry a mondayItemId today (221 "PFLEGEN & WOHNEN FINKENAU", 17 VOs / 15 ' +
          'patients, monday 1848742792; 222 "Tagesstätte Falkenbek", 11 VOs / 10 patients, monday ' +
          '2830700749), so on that ID the collision has not hidden either row — which is precisely the ' +
          'point: WHICH twin the map keeps is not stable, so a run that is harmless today can hide the ' +
          'used row tomorrow. It also explains the PM\'s AC-2 note, which records HH38 as "Falkenbek, ' +
          '10 patients / 11 VOs" — the 17-VO row under the same Einrichtungs-ID was never in view. ' +
          'The mondayItemId column corroborates which row a run reached rather than assuming findAll() ' +
          'order: the command writes it on every match, and E23\'s facility 12 has none. ' +
          'Not a defect in the guard — it does exactly what AC1/AC2 specify for the row it is handed — ' +
          'but a hole in the guarantee the ticket states. Cheapest fix: report a duplicated ' +
          'Einrichtungs-ID as its own category instead of silently dropping a row; better: iterate ' +
          'matches per ID so every facility is visited. 2 of 243 IDs collide; 1 of them (E23) is ' +
          'currently hiding a used facility.',
      );

      const sync = new MondayFacilitySyncPage(request, auth);
      const facilities: Facility[] = await sync.facilities();
      const duplicates = MondayFacilitySyncPage.duplicateEchIds(facilities);
      for (const [echId, rows] of duplicates) {
        console.log(`Einrichtungs-ID ${echId}: ${rows.map((r) => `id ${r.id} "${r.name}" (monday ${r.mondayItemId ?? 'none'})`).join('  ||  ')}`);
      }
      expect([...duplicates.keys()], 'an Einrichtungs-ID must identify one facility, or the sync cannot see the other').toEqual([]);
    },
  );

  test(
    'AC3/AC4 — the gap report and the skip report',
    { tag: ['@SuperAdmin', '@MondayFacilitySync', '@ReadOnly'] },
    async () => {
      test.fixme(
        true,
        'Console-only, on both counts. The sync writes its categories (matched / created / ' +
          'name_updated / name_update_skipped / gap) to stdout and a CSV; none of it is exposed over ' +
          'the API, and the command is not client-runnable. ' +
          'AC4 is satisfied structurally: the skip row carries flow_name, monday_name, monday_item_id ' +
          'and the reason "Rename skipped: facility has %d patient(s) and %d VO(s) attached — review ' +
          'manually", which is every field the AC asks for. AC3 is a no-change regression whose ' +
          'evidence is the absence of writes, and a client cannot distinguish "not renamed because ' +
          'Monday marked it inactive" from "not renamed because the names already agree". ' +
          'Both are covered by SyncMondayFacilitiesCommandTest.php; re-verify from the run output ' +
          'after the next nightly.',
      );
    },
  );
});
