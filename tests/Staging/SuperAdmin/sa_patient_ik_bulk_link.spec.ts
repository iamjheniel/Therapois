import { test, expect } from '@playwright/test';
import {
  FIXTURES,
  MAPPING_FILE,
  MappingRow,
  PatientIkLinkPage,
  PatientState,
  ProviderRow,
  RUN,
  RunLog,
} from '../../../Pages/superadmin/sa.patient-ik-link.page';

/**
 * RC 3.13 #3560 — the one-time bulk link of unlinked patients to their InsuranceProvider by IK
 * (`app:link-patients-by-ik`, PR #3586). **Applied on staging 2026-09-10 00:34 UTC**, so this file
 * verifies the outcome rather than the console.
 *
 * **Read-only — every request is a GET.** The command itself is console-only; what it left behind is
 * fully readable, so the approach is to **re-derive its decisions** from the three inputs it used
 * (the PM's mapping file, the #2969 provider catalog, and each patient's state) and compare against
 * what the run's own `PatientLog` trail says it did. That settles AC2–AC6 over the whole 6,295-row
 * population instead of on a spot-check.
 *
 * See the page object for the decision order (already-linked is checked BEFORE the IK lookup), the
 * traps, and why the counts here differ by one from the PM's recorded 379/40.
 */
test.describe('#3560 bulk-link patients to insurance providers by IK', () => {
  let link: PatientIkLinkPage;

  let mapping: Map<number, string> | null = null;
  let mappingRows: MappingRow[] = [];
  let mappingSha: string | null = null;
  let providers: Map<string, ProviderRow>;
  let patients: Map<number, PatientState>;
  let logs: RunLog[];
  let changedByRun: Set<number>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(1_800_000);
    const page = await browser.newPage();
    link = new PatientIkLinkPage(page);
    await link.connect();

    const file = await link.mappingRows();
    if (file) {
      mapping = file.mapping;
      mappingRows = file.rows;
      mappingSha = file.sha256;
    }

    providers = await link.providersByIk();
    logs = await link.insuranceProviderLogs();
    changedByRun = new Set(logs.map((l) => l.patientId));
    patients = await link.patientStates(mapping ? [...mapping.keys()] : [...changedByRun]);

    console.log(
      `#3560: mapping ${mapping ? `${mapping.size} rows` : 'UNAVAILABLE (no GitHub credential)'}; ` +
        `catalog ${providers.size} providers; ` +
        `${logs.length} insuranceProvider field_change logs over ${changedByRun.size} patients; ` +
        `${patients.size} patients resolved`,
    );
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    link = new PatientIkLinkPage(page);
    await link.connect();
  });

  /** The file-dependent tests gate rather than fail when no GitHub credential is present. */
  const requireMapping = () => {
    test.skip(null === mapping, '#3560: the mapping file needs GITHUB_TOKEN or a `gh` login');
    return mapping!;
  };

  // ─────────────────────────────── the command's input ───────────────────────────────

  test(
    'the mapping file is the one the ticket attached, and it is the shape the command reads',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      // Pinned by content: the attachment could be replaced on the issue, and every expectation
      // below is derived from it, so a silent swap must fail loudly rather than move the goalposts.
      expect(mappingSha, 'the attachment must be the file these expectations were built from').toBe(MAPPING_FILE.sha256);
      expect(mappingRows.length, 'usable rows').toBe(MAPPING_FILE.rows);
      expect(map.size, 'one row per patient — no duplicate patient ids to resolve').toBe(MAPPING_FILE.rows);

      const iks = new Set(map.values());
      expect(iks.size, 'distinct IKs').toBe(MAPPING_FILE.distinctIks);
      for (const ik of iks) expect(ik, `IK ${ik} must be 9 digits`).toMatch(/^\d{9}$/);
      // AC4 by construction: the file only carries the patients an IK could be found for, so the
      // no-IK population is out of scope because it is absent, not because it is filtered.
      expect(mappingRows.filter((r) => '' === r.ik), 'no blank IKs').toHaveLength(0);

      const sources = new Set(mappingRows.map((r) => r.source));
      console.log(
        `#3560 mapping: ${mappingRows.length} rows, ${iks.size} IKs, sources ${[...sources].join('/')} ` +
          `(${mappingRows.filter((r) => 'rezepte' === r.source).length} rezepte / ` +
          `${mappingRows.filter((r) => 'patienten' === r.source).length} patienten)`,
      );
      // The ticket's own description of the file: the fresher rezepte export as primary, the June
      // Patienten export as fallback.
      expect(sources, 'the two source exports the ticket names').toEqual(new Set(['rezepte', 'patienten']));
    },
  );

  test(
    'AC5 every IK in the file resolves against Flow\'s own catalog, and the names agree',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      expect(providers.size, 'the #2969 catalog').toBeGreaterThan(1_000);
      // The catalog's IK column is unique, which is what lets the command match without ambiguity.
      expect(new Set([...providers.values()].map((p) => p.ik)).size).toBe(providers.size);

      const iks = [...new Set(map.values())];
      const missing = iks.filter((ik) => !providers.has(ik));
      console.log(`#3560 AC5: ${iks.length - missing.length}/${iks.length} file IKs found in the catalog`);
      // The ticket projects 7 patients whose IK is not in the catalog. That is a PRODUCTION figure:
      // staging's catalog covers every IK in the file, which is why the run's unmatched report holds
      // only "patient id not found" rows. Reported rather than asserted as 7.
      expect(missing, 'unmatched IKs on staging').toEqual([]);

      // An independent check on the PM's file: its informational `insurer_name` must describe the
      // same insurer the IK points at. The command ignores that column, so a disagreement here
      // would mean the file itself pairs a name with the wrong IK — invisible to the command.
      const disagreements: string[] = [];
      for (const row of mappingRows) {
        const provider = providers.get(row.ik);
        if (!provider) continue;
        const a = row.insurerName.toLowerCase().replace(/[^a-zäöüß]/g, '');
        const b = provider.name.toLowerCase().replace(/[^a-zäöüß]/g, '');
        if (!a.startsWith(b.slice(0, 10)) && !b.startsWith(a.slice(0, 10))) {
          disagreements.push(`${row.ik}: file "${row.insurerName}" vs catalog "${provider.name}"`);
        }
      }
      console.log(`#3560 AC5: file-name vs catalog-name disagreements: ${disagreements.length}`);
      for (const d of disagreements.slice(0, 10)) console.log(`   ${d}`);
      expect(disagreements, 'the file pairs every IK with the insurer that IK actually is').toEqual([]);
    },
  );

  // ─────────────────────────────── what the run did ───────────────────────────────

  test(
    'AC2 every patient the run linked carries exactly the provider its mapped IK names, once',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      expect(logs.length, 'the run wrote a log per linked patient').toBeGreaterThan(0);
      // "exactly once per patient" — one entry each, no double-linking.
      expect(changedByRun.size, 'one entry per patient, no duplicates').toBe(logs.length);

      const mismatches: string[] = [];
      for (const patientId of changedByRun) {
        const ik = map.get(patientId);
        if (!ik) {
          mismatches.push(`patient ${patientId} was linked but is not in the mapping file`);
          continue;
        }
        const want = providers.get(ik);
        const have = patients.get(patientId);
        if (!want) {
          mismatches.push(`patient ${patientId}: mapped IK ${ik} is not in the catalog`);
        } else if (!have) {
          mismatches.push(`patient ${patientId}: linked by the run but not readable now`);
        } else if (have.providerId !== want.id) {
          mismatches.push(`patient ${patientId}: has ${have.providerId}/${have.providerIk}, file says ${want.id}/${ik}`);
        }
      }
      console.log(`#3560 AC2: ${changedByRun.size - mismatches.length}/${changedByRun.size} linked patients match the file`);
      for (const m of mismatches.slice(0, 10)) console.log(`   ${m}`);
      expect(mismatches, 'every linked patient holds the provider the file specifies').toEqual([]);

      // The PM's own fixture, pinned by value.
      const fixture = patients.get(FIXTURES.linked.patientId)!;
      expect(fixture.providerId).toBe(FIXTURES.linked.providerId);
      expect(fixture.providerIk).toBe(FIXTURES.linked.ik);
      expect(fixture.providerName).toBe(FIXTURES.linked.providerName);
      expect(changedByRun.has(FIXTURES.linked.patientId), 'and it was this run that linked them').toBe(true);
    },
  );

  test(
    'AC3 each link is recorded as one automatic field_change, the way other automated patient updates are',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      // The bulk UPDATE does not pass through the ORM listener, so the command writes the entry
      // itself — which is exactly why the SHAPE is worth asserting rather than assuming.
      const batchIds = new Set(logs.map((l) => l.batchId));
      expect(batchIds.size, 'one run-wide batch id ties the whole run together').toBe(1);
      expect([...batchIds][0]).toBe(RUN.batchId);

      for (const entry of logs) {
        expect(entry.metaType, `patient ${entry.patientId}: meta.type`).toBe('automatic');
        expect(entry.oldValue, `patient ${entry.patientId}: the field was empty before`).toBe('null');
        expect(entry.createdBy, `patient ${entry.patientId}: written by the system, not a user`).toBeNull();
        expect(entry.createdAt.slice(0, 16), `patient ${entry.patientId}: stamped in the run window`).toBe(RUN.at);
        // The recorded new value must be the provider's name, not an id — which is what makes the
        // entry readable in the patient's history.
        const ik = map.get(entry.patientId);
        expect(entry.newValue, `patient ${entry.patientId}: newValue names the provider`).toBe(providers.get(ik!)?.name);
      }
      console.log(`#3560 AC3: ${logs.length} entries, batch ${RUN.batchId}, all automatic with no author`);

      // And on the PM's fixture, through the per-patient log the profile itself shows.
      const own = await link.logsFor(FIXTURES.linked.patientId);
      const fieldChanges = own.filter((l) => 'field_change' === l.type && 'insuranceProvider' === l.meta.field);
      expect(fieldChanges, 'exactly one insuranceProvider entry on the fixture patient').toHaveLength(1);
      expect(fieldChanges[0].meta.type).toBe('automatic');
    },
  );

  test(
    'AC6 the patients that already had a provider kept it — the file did not overwrite them',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      const outcome = PatientIkLinkPage.decide(map, patients, providers, changedByRun);

      console.log(
        `#3560 outcome re-derived: link ${outcome.toLink.size} | not-found ${outcome.notFound.length} | ` +
          `already-linked ${outcome.alreadyLinked.length} | IK-not-in-catalog ${outcome.unmatchedIk.length} ` +
          `(sum ${outcome.toLink.size + outcome.notFound.length + outcome.alreadyLinked.length + outcome.unmatchedIk.length} of ${map.size})`,
      );
      expect(
        outcome.toLink.size + outcome.notFound.length + outcome.alreadyLinked.length + outcome.unmatchedIk.length,
        'the four buckets account for every mapping row',
      ).toBe(map.size);
      expect(outcome.alreadyLinked.length, 'there must be already-linked patients for this to mean anything').toBeGreaterThan(0);

      // Every one still holds a provider…
      for (const patientId of outcome.alreadyLinked) {
        expect(patients.get(patientId)!.providerId, `patient ${patientId} still linked`).not.toBeNull();
        expect(changedByRun.has(patientId), `patient ${patientId} must not appear in the run's log`).toBe(false);
      }

      // …and the sharp half: where their existing provider DIFFERS from what the file specifies, the
      // existing one survived. If AC6 were broken these rows would now read the file's provider.
      const differing = outcome.alreadyLinked.filter((p) => patients.get(p)!.providerIk !== map.get(p));
      console.log(
        `#3560 AC6: ${differing.length}/${outcome.alreadyLinked.length} already-linked patients hold a provider ` +
          `DIFFERENT from the file's — each one is a row the command declined to overwrite`,
      );
      for (const p of differing.slice(0, 6)) {
        const have = patients.get(p)!;
        console.log(`   patient ${p} keeps ${have.providerIk} ${have.providerName} — file says ${map.get(p)}`);
      }
      expect(differing.length, 'at least one already-linked patient disagrees with the file').toBeGreaterThan(0);
      for (const p of differing) {
        expect(patients.get(p)!.providerIk, `patient ${p} must keep its own provider`).not.toBe(map.get(p));
      }
    },
  );

  test(
    'AC2/AC6 a second run would change nobody — the command is idempotent',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      // The command's UPDATE re-checks `insurance_provider_id IS NULL`, so re-deriving its decision
      // against TODAY's state — where the 5,876 are linked — must produce nothing left to link.
      // This is the client-side equivalent of the PM's "re-run showed 0 would link".
      const outcome = PatientIkLinkPage.decide(map, patients, providers, new Set());
      console.log(
        `#3560 idempotency: a re-run today would link ${outcome.toLink.size}, ` +
          `skip ${outcome.alreadyLinked.length} as already linked, report ${outcome.notFound.length} not found`,
      );
      expect(outcome.toLink.size, 'nothing left to link').toBe(0);
      expect(outcome.alreadyLinked.length, 'every present mapping patient is now linked').toBe(patients.size);
    },
  );

  test(
    'AC4/AC5 the run touched nobody outside the file, and the ids it could not find really do not exist',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      // AC4: the log set is a subset of the file's patients — no patient outside the mapping was
      // written by this run.
      const strays = [...changedByRun].filter((p) => !map.has(p));
      expect(strays, 'the run changed only patients named in the file').toEqual([]);

      // The PM's untouched fixture: not in the file, still unlinked.
      expect(map.has(FIXTURES.untouched.patientId), 'the control is not in the mapping file').toBe(false);
      const control = await link.patientStates([FIXTURES.untouched.patientId]);
      expect(control.get(FIXTURES.untouched.patientId)!.providerId, `patient ${FIXTURES.untouched.patientId} untouched`).toBeNull();

      // AC5: the "patient id not found" rows are genuinely absent, not merely unreadable — a
      // sample is probed directly because a missing id simply does not come back from `?id[]=`.
      const notFound = [...map.keys()].filter((p) => !patients.has(p));
      expect(notFound.length, 'staging is a snapshot, so some mapped patients are absent').toBeGreaterThan(0);
      for (const patientId of notFound.slice(0, 6)) {
        expect(await link.status(`/patients/${patientId}`), `patient ${patientId} must be absent`).toBe(404);
        expect(changedByRun.has(patientId), `patient ${patientId} cannot have been linked`).toBe(false);
      }
      console.log(`#3560 AC5: ${notFound.length} mapped patient ids do not exist on staging (all reported "patient id not found")`);
    },
  );

  test(
    'the End Goal — no patient in the file is left unlinked',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      const present = [...map.keys()].filter((p) => patients.has(p));
      const stillUnlinked = present.filter((p) => null === patients.get(p)!.providerId);
      console.log(`#3560 End Goal: ${present.length - stillUnlinked.length}/${present.length} mapped patients present on staging are linked`);
      expect(stillUnlinked, 'every mapped patient that exists here now has a provider').toEqual([]);
    },
  );

  test(
    'evidence — the off-by-one against the PM\'s recorded 379/40',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly'] },
    async () => {
      const map = requireMapping();
      const notFound = [...map.keys()].filter((p) => !patients.has(p));
      const alreadyLinked = [...map.keys()].filter((p) => patients.has(p) && !changedByRun.has(p));
      console.log(
        `#3560 counts now: linked ${changedByRun.size} | not-found ${notFound.length} | already-linked ${alreadyLinked.length}; ` +
          `PM recorded 5,876 | 379 | 40 at run time`,
      );
      // The difference is one patient CREATED after the run: it was legitimately "not found" then
      // and exists now. Asserted so a future drift of two or more is not silently absorbed.
      expect(changedByRun.size + notFound.length + alreadyLinked.length, 'the buckets still cover the file').toBe(map.size);
      expect(Math.abs(notFound.length - 379), 'not-found has drifted by at most the patients created since').toBeLessThanOrEqual(2);

      const late = FIXTURES.createdAfterTheRun.patientId;
      if (map.has(late) && patients.has(late)) {
        const own = await link.logsFor(late);
        const created = own.find((l) => 'patient_created' === l.type);
        console.log(`   patient ${late} was created ${created?.createdAt} — after the run at ${RUN.at}`);
        expect(created?.createdAt ?? '', 'the drift is explained by a patient created after the run').toBeTruthy();
        expect(created!.createdAt > `${RUN.at}:00+00:00`, 'created after the run').toBe(true);
        expect(changedByRun.has(late), 'so the run cannot have linked it').toBe(false);
      }
    },
  );

  test(
    'evidence — the whole patient table, linked vs unlinked (slow)',
    { tag: ['@SuperAdmin', '@PatientIkLink', '@ReadOnly', '@Slow'] },
    async () => {
      test.setTimeout(1_800_000);
      const map = requireMapping();
      // `exists[insuranceProvider]` is accepted and silently IGNORED — both `true` and `false`
      // return every patient — so the only way to count the unlinked population is to walk the
      // collection. Worth the ~170 requests once: it is the ticket's headline figure, and it shows
      // the AC4 population (patients with no IK on file) still unlinked and untouched.
      const states = await link.walkAllPatients();
      const linked = [...states.values()].filter((ik) => null !== ik).length;
      const unlinked = states.size - linked;
      const unlinkedInFile = [...states.entries()].filter(([id, ik]) => null === ik && map.has(id)).map(([id]) => id);

      console.log(
        `#3560 whole table: ${states.size} patients — ${linked} linked, ${unlinked} unlinked; ` +
          `of the unlinked, ${unlinkedInFile.length} are in the mapping file ` +
          `(the ticket's 8,315-unlinked and 2,013-no-IK figures are production populations)`,
      );
      expect(states.size, 'the walk must cover the collection').toBeGreaterThan(8_000);
      expect(unlinkedInFile, 'no mapped patient is left unlinked anywhere in the table').toEqual([]);
      expect(unlinked, 'the AC4 population — patients with no IK on file — is still unlinked').toBeGreaterThan(0);
    },
  );

  // ─────────────────────────────── not client-reachable ───────────────────────────────

});
