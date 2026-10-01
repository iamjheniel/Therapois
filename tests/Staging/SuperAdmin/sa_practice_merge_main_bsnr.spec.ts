import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { PracticeBsnrMergePage as P, type PracticeFacts, type BsnrRow } from '../../../Pages/superadmin/sa.practice-bsnr-merge.page';
import { LetterGreetingPage as L } from '../../../Pages/admin/admin.letter-greeting.page';

/**
 * RC 3.15 — #3859 (PR #3876, merged into `release/3.15.0` 2026-09-29): `app:practice-doctor:
 * merge-duplicates` could leave the surviving practice with no MAIN `practice_bsnr` row, so the
 * practice form refused to save and #3285's `practice.practice_id` mirror stayed broken.
 *
 * **Read-only, and deliberately so.** The ticket and both Need Command comments say the command
 * must not be run before the fix is live, and `--force` merges practices irreversibly — so nothing
 * here runs it. The fix is a console service with no route and no serialized field, so deployment
 * is **not client-decidable** (`/status` gives the release, not the commit — #3704); it is
 * confirmed from the branch instead, and this file verifies what the ACs are stated in terms of.
 *
 * **AC5's check query IS client-reachable**, because `GET /practice_bsnrs` is a full collection
 * carrying `number` / `isMain` / `practice` — so the Need Command's SQL is re-expressed over it
 * exactly, and the command's own grouping and survivor rules are ported to predict the preview.
 */

let api: APIRequestContext;
let page: P;
let rows: BsnrRow[];
/** The duplicate groups the command derives, with each member's facts. */
let groups: { number: string; members: PracticeFacts[] }[] = [];

test.describe('#3859 a merged practice keeps a main BSNR row', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    api = await pwRequest.newContext();
    page = new P(api);
    await page.init();
    rows = await page.bsnrRows();
    const dup = P.duplicateNumbers(rows);
    for (const [number, ids] of dup) {
      const members: PracticeFacts[] = [];
      for (const id of ids) members.push(await page.practice(id, rows));
      groups.push({ number, members });
    }
    console.log(`  ${rows.length} practice_bsnr rows over ${P.byPractice(rows).size} practices;` +
      ` ${groups.length} BSNR numbers held by more than one practice`);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: inferred from a SIBLING ticket, since a console fix has no probe of its own',
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      // `ensureMainBsnrRow()` lives in a console service: no route, no serialized field, and
      // `/status` gives the release not the commit (#3704). So it has no probe — but the deploy
      // DATE can be bounded from another ticket that merged alongside it:
      //
      //   #3848 (PR #3866) merged 2026-09-29T23:45:17Z   ← this file's sibling, letter greetings
      //   #3859 (PR #3876) merged 2026-09-29T23:45:40Z   ← the fix under test
      //
      // and #3848's own archive scan dated the staging deploy to AFTER 2026-09-30T01:58 (the last
      // letter rendered with the pre-fix greeting). Any image cut after that carries both merges.
      // The live half of that is cheap and is re-derived here, because a recorded date goes stale:
      // a Zahlungserinnerung renders on demand and writes nothing (#3559).
      const letters = new L(api);
      const token = await letters.adminToken();
      const invoices = await letters.overduePkvInvoices(token);
      const patients = await letters.patientsById([...new Set(invoices.map((i) => i.patientId))], token);
      const noSal = invoices.find((i) => {
        const pt = patients.get(i.patientId);
        return pt && !pt.salutation && !L.billingPerson(pt);
      });
      test.skip(!noSal, 'no overdue PKV invoice has a patient without an Anrede to date the deploy');
      const pt = patients.get(noSal!.patientId)!;
      const { text } = await letters.reminderLetter(noSal!.id, token);
      const greeting = L.greetingIn(text);
      console.log(`  #3848 probe: invoice ${noSal!.number}, patient ${pt.id} (no Anrede)` +
        ` -> ${JSON.stringify(greeting)}`);
      expect(greeting, "#3848's fix is live, so the image postdates 2026-09-29T23:45:17Z")
        .toBe(L.expectedGreeting(pt.salutation, pt.firstName, pt.lastName));
      expect(text, 'and it is not the pre-fix greeting')
        .not.toContain(L.legacyGreeting(pt.salutation, pt.lastName));
      console.log('  → the deployed image was built after both merges, so #3876 is in it.');
      console.log('    (A 23-second window separates the two merges, so this is an inference');
      console.log('     about the BUILD, not a direct observation of #3876 — which has none.)');
    },
  );

  test(
    "AC5's check query, run from the API — the state BEFORE the Need Command",
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      const without = P.practicesWithoutAMainRow(rows);
      const several = P.practicesWithSeveralMainRows(rows);
      console.log(`  practices holding BSNR rows but none marked main: ${without.length}`);
      console.log(`  practices with MORE than one main row:            ${several.length}`);
      if (without.length) console.log(`    ${JSON.stringify(without.slice(0, 10))}`);
      expect(without, "AC5's query returns 0").toHaveLength(0);
      // Not an AC, but the same column read the other way — two mains would break #3285's mirror
      // just as surely as none.
      expect(several, 'and no practice claims two main rows').toHaveLength(0);

      // The reading is only worth anything if the walk was complete; `bsnrRows()` throws on a
      // short read, and this records the size it was taken over.
      expect(rows.length, 'the whole BSNR book was read').toBeGreaterThan(1_000);
      console.log('  NOTE: this is the state BEFORE any run — the command has not been run on');
      console.log('        staging, so a 0 here is a precondition, not evidence of the fix.');
    },
  );

  test(
    "#3285's mirror holds for every practice in a duplicate group",
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      // The rule the bug broke: `practice.practice_id` equals the main row's number. `practiceId`
      // is on the ITEM read only — absent from the collection and from the list/billing groups —
      // so this is checked on the practices that matter rather than book-wide.
      let checked = 0;
      for (const g of groups) {
        for (const m of g.members) {
          const main = m.rows.find((r) => r.isMain);
          console.log(`  practice ${String(m.id).padEnd(5)} practiceId=${m.practiceNumber}` +
            ` main=${main ? main.number : 'NONE'} rows=${m.rows.length}`);
          expect(main, `practice ${m.id} has a main row`).toBeTruthy();
          expect(m.practiceNumber, `practice ${m.id} mirrors its main row (#3285)`).toBe(main!.number);
          checked++;
        }
      }
      expect(checked, 'the duplicate groups were actually walked').toBeGreaterThan(5);
    },
  );

  test(
    'the groups the command will act on, with its own decision rule ported',
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      // So the preview's group list can be read against something, rather than being the first
      // time anyone sees it.
      let merges = 0; let skips = 0;
      for (const g of groups) {
        const d = P.decide(g.members, g.number);
        const who = g.members.map((m) => `${m.id}:${JSON.stringify(m.name.slice(0, 34))}` +
          `(vos ${m.totalVos}, docs ${m.doctorsCount})`).join('  ');
        console.log(`  BSNR ${g.number}: ${d.action === 'merge' ? `MERGE [${d.basis}] survivor ${d.survivor.id}` : `SKIP (${d.reason})`}`);
        console.log(`     ${who}`);
        if (d.action === 'merge') merges++; else skips++;
      }
      console.log(`  predicted: ${merges} merged, ${skips} skipped (of ${groups.length})`);
      // `hasData` is a LOWER bound from the API — the command also counts CRM activities and
      // prescription images, which no endpoint exposes — so a predicted merge can turn into a
      // skip. The prediction is reported; nothing below depends on it.
      expect(groups.length, 'staging has duplicate BSNRs for the command to consider').toBeGreaterThan(0);
    },
  );

  test(
    'FINDING: staging cannot exercise AC1 — no group has the shape the bug needs',
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      // #3859 needs a survivor that owns NO main row of its own once `moveBsnrRows()` has brought
      // the others in as secondaries. `ensureMainBsnrRow()` returns early when a main row exists,
      // so a group whose every member already has one can never reach the new code.
      const exercisable = groups.filter((g) => P.couldExerciseTheBug(g.members));
      for (const g of groups) {
        const shape = g.members.map((m) =>
          `${m.id}[${m.rows.map((r) => `${r.number}${r.isMain ? '*' : ''}`).join(',') || 'NO ROWS'}]`).join(' + ');
        console.log(`  BSNR ${g.number}: ${shape}`);
      }
      console.log(`  groups that could exercise #3859: ${exercisable.length} of ${groups.length}`);
      expect(exercisable, 'every member of every group already holds its own main row').toHaveLength(0);

      console.log('  → The ticket\'s QA note says "QA verifies it on staging data with the preview');
      console.log('    and apply run". On this data that cannot work: the fixed branch is never');
      console.log('    reached, so AC5 returning 0 after the staging run is the same 0 it returns');
      console.log('    now. The reported fixture (production practices 1763/1764/1765, three');
      console.log('    same-named practices of which only a merged-away one holds the BSNR row)');
      console.log('    has no staging counterpart — AC1 is verifiable on production only.');
    },
  );

  test(
    "AC2's gate exists, and today's data satisfies it",
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async ({ page: browserPage }) => {
      // AC2 is "the kept practice saves in the practice form without anyone marking a BSNR as
      // main". The form's refusal is the observable half of that, and it ships in the bundle.
      const occ = await P.bundleOccurrences(browserPage, [
        P.MAIN_ROW_GATE, 'Haupt-BSNR', 'practiceBsnrs', 'isMain',
      ]);
      console.log(`  bundle: ${JSON.stringify(occ)}`);
      expect(occ[P.MAIN_ROW_GATE], 'the practice form still carries the main-row refusal')
        .toBeGreaterThan(0);
      // ...and no practice currently trips it, which is AC2's precondition for every group the
      // command will keep.
      expect(P.practicesWithoutAMainRow(rows), 'no practice would be refused today').toHaveLength(0);
    },
  );

  test(
    'ARMED: once the command has run, every surviving practice still holds exactly one main row',
    { tag: ['@SuperAdmin', '@PracticeBsnrMerge', '@ReadOnly'] },
    async () => {
      // The durable form of AC1/AC3/AC5. It holds now and must hold after the run; the group count
      // falling is how this file will notice the run happened.
      const byPractice = P.byPractice(rows);
      const bad = [...byPractice.entries()].filter(([, v]) => v.filter((r) => r.isMain).length !== 1);
      console.log(`  ${byPractice.size} practices hold BSNR rows; ${bad.length} do not hold exactly one main`);
      expect(bad, 'exactly one main row per practice that has any').toHaveLength(0);

      // Each practice's main row number is unique to it — the state `EnforceBsnrUniquenessCommand`
      // is waiting for, and what the merges exist to produce.
      const mains = rows.filter((r) => r.isMain);
      const dupMains = [...new Map<string, number[]>(
        mains.reduce((m: Map<string, number[]>, r) => m.set(r.number, [...(m.get(r.number) ?? []), r.practiceId]), new Map()),
      ).entries()].filter(([, v]) => v.length > 1);
      console.log(`  main-row numbers still held by two practices: ${dupMains.length}` +
        ` ${JSON.stringify(dupMains.map(([n, v]) => `${n}:${v.join('/')}`))}`);
      console.log(`  (these are exactly the ${groups.length} groups above — the merges are what clears them,`);
      console.log('   and until then UNIQ_practice_bsnr_number stays deferred.)');
      expect(dupMains.length, 'the duplicate groups are the ones listed above').toBe(groups.length);
    },
  );
});
