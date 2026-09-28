import { test, expect } from '@playwright/test';
import {
  FlowBoardsPatientNamesPage,
  SURFACES,
  DRILLDOWN_BARS,
  FIELD,
} from '../../../Pages/superadmin/sa.flow-boards-patient-names.page';
import { ToRiskGroupingPage, TILES } from '../../../Pages/superadmin/sa.to-risk-grouping.page';

/**
 * RC 3.14 (#3724, PR #3779) — every Flow Boards table, drill-down modal and CSV export shows the
 * patient's FULL NAME instead of initials.
 *
 * **NOT DEPLOYED on staging, and the reason is release management rather than a defect. 6 passed,
 * 5 gated.** The ticket is milestoned **RC 3.14.0** — the PM moved it there on 22 Sep, "the
 * management team asked for full patient names on the boards as part of the RC 3.14 release" — but
 * the work merged to **`release/3.15.0`** (PR #3779, branch `task/3724-rc315`), and the 3.14 PR,
 * **#3778, was closed unmerged**. Structurally confirmed: `f40476707` is *diverged* from
 * `release/3.14.0`, and the new `api/src/Service/Kpi/PatientDisplayName.php` **404s on
 * `release/3.14.0`** while existing on 3.15. Staging serves 3.14.0.
 *
 * **So the AC tests are GATED, not `fixme`'d, and they flip with no edit the day it ships.** The
 * gate is behavioural — {@link FlowBoardsPatientNamesPage.isDeployed} asks whether any surface
 * serves a value that is not an abbreviation — so it needs no version string and survives the field
 * rename in either direction. Beside them, a green baseline test records exactly what staging shows
 * today, which is what a PM needs to see the ticket is genuinely outstanding.
 *
 * **THE MEASUREMENT IS THE VALUE'S SHAPE, NEVER THE FIELD NAME.** The Developer Reference tells the
 * implementer to rename `patientInitials` → `patientName` "rather than keeping the old field name
 * with new content" — which means a build *could* ship full names under the old name, and a
 * name-only probe would call that undeployed. Every classification here runs on the value:
 * `"M. B."` is an abbreviation, `"Ilona Stutzki"` is not.
 *
 * **DO NOT grep the bundle for `patientName`.** It occurs **174 times** in the served bundle and
 * always has — it is Flow's ordinary patient-name field, used across VO forms, patient management
 * and the boards' own unrelated code. Only **`patientInitials`** is diagnostic (4 occurrences, one
 * being the risk cell's literal `children:t.patientInitials`). This is #3611's rule — a common
 * token cannot decide a deployment — in the direction that fakes a PASS.
 *
 * **The #3774 interaction, which is the one surface ALREADY full-named.** #3774's own AC5 changed
 * its new export's patient column "from today's export, which showed initials only", so
 * `POST /kpis/orga/risks/export` writes full names on staging today, from
 * `BillingBacklogVoFacts::patientFullNames()` — independently of this ticket. **Half of #3724 AC5
 * is therefore already satisfied by a different ticket**, and it is asserted here so a later #3724
 * deploy cannot silently regress it.
 *
 * **Traps:**
 *  - `/kpis/management/revenue-drilldown` needs **`?bar=erarbeitet|nicht_validiert|validiert`**;
 *    without it the route answers **400 `Unknown bar ""`**, which reads like the endpoint being
 *    gone. Its rows nest `teams[] → therapists[] → prescriptions[]`, so the reader walks the whole
 *    document rather than assuming a flat row shape.
 *  - The revenue-drilldown CSV export answers **403** for the QA Super Admin — the #3181
 *    Kian/Dennis allowlist, proven by the known-allowlisted `/kpis/management/export` answering 403
 *    in the same breath — so AC5's first export is unreachable here, not broken.
 *  - **The banner's OLD export is still routed and still serves initials.** #3774 removed the
 *    banner from both boards but kept its files, so `POST /kpis/management/billing-backlog/export`
 *    still answers 200 with 1,170 rows of `"K. P."`. #3724's PR edits that controller too, which
 *    makes it a second, independent deployment probe.
 *
 * **Read-only** — every request is a GET except the two export POSTs, which write nothing.
 */

test.describe('#3724 full patient names on Flow Boards', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: no Flow Boards surface serves a full patient name — re-derived from the values, not a version',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request);
      const surfaces = await api.allSurfaces();

      for (const s of surfaces)
        console.log(
          `#3724 ${s.acs.padEnd(16)} ${s.label.padEnd(26)} HTTP ${s.status}  values=${String(s.values.length).padStart(5)}  ` +
            `initials=${String(s.initials).padStart(5)}  fullNames=${String(s.fullNames).padStart(4)}  e.g. ${JSON.stringify(s.values.slice(0, 3).map((v) => v.value))}`,
        );

      const total = surfaces.reduce((n, s) => n + s.values.length, 0);
      const named = surfaces.reduce((n, s) => n + s.fullNames, 0);
      console.log(`#3724 verdict: ${total} patient values across ${surfaces.length} surfaces, ${named} of them full names`);

      // Every surface must actually have answered, or "no full names" is vacuous.
      for (const s of surfaces) {
        expect(s.status, `${s.label} answered`).toBe(200);
        expect(s.values.length, `${s.label} carries patient values at all`).toBeGreaterThan(0);
      }
      // The verdict itself. Asserted as the CURRENT state so this test reports the ticket as
      // outstanding and fails loudly the day it ships — at which point every gated test below runs.
      expect(named, 'not deployed: every Flow Boards surface still abbreviates').toBe(0);
      expect(
        surfaces.every((s) => s.values.every((v) => v.field === FIELD.before)),
        `and the field is still "${FIELD.before}" everywhere`,
      ).toBe(true);
    },
  );

  test(
    'deployment: the served bundle still renders the initials field — and why the other field name proves nothing',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new FlowBoardsPatientNamesPage(request);
      const counts = await api.bundleFieldCounts();
      console.log(
        `#3724 bundle (${counts.url.split('/').pop()}): ${FIELD.before}=${counts.before} | ${FIELD.after}=${counts.after} ` +
          `| renders \`children:t.${FIELD.before}\` = ${counts.rendersInitials}`,
      );

      // The frontend half deploys independently of the API (#3705), so it gets its own probe.
      expect(counts.rendersInitials, 'the risk cell still renders the initials field verbatim').toBe(true);
      expect(counts.before, `${FIELD.before} is still referenced`).toBeGreaterThan(0);

      // Stated as an assertion so nobody later reads the big number as evidence of this ticket:
      // `patientName` is Flow-wide and would be large whether or not #3724 had shipped.
      expect(
        counts.after,
        `"${FIELD.after}" is Flow's ordinary patient field and is large regardless — NOT a #3724 signal`,
      ).toBeGreaterThan(50);
    },
  );

  test(
    'baseline: what each AC surface shows today, so the ticket has a before-state on record',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request);
      const surfaces = await api.allSurfaces();

      // The ticket's Context quotes 'e.g., "M. B."' as the thing to remove. It is literally there.
      const all = surfaces.flatMap((s) => s.values.map((v) => v.value));
      const sample = [...new Set(all)].slice(0, 12);
      console.log(`#3724 baseline: ${all.length} values, ${new Set(all).size} distinct — sample ${JSON.stringify(sample)}`);
      expect(all.length, 'a real population, not a handful').toBeGreaterThan(1_000);
      expect(
        all.every((v) => FlowBoardsPatientNamesPage.looksLikeInitials(v)),
        'every one is an abbreviation',
      ).toBe(true);

      // Per-AC, so a reader can see which of the Scope Summary rows are covered by an API surface.
      for (const s of surfaces)
        expect(s.initials, `${s.acs} — ${s.label} is entirely abbreviated`).toBe(s.values.length);
    },
  );

  test(
    'AC5 #3774\'s risk export ALREADY writes full names — a different ticket, and it must not regress',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request);
      const risks = new ToRiskGroupingPage(request);
      const { rows } = await risks.risks();
      const ids = ToRiskGroupingPage.exportIdsFor(rows, TILES.fertig.key).slice(0, 200);

      const csv = await api.riskExportCsv(ids);
      expect(csv.status, 'POST /kpis/orga/risks/export').toBe(200);
      const parsed = FlowBoardsPatientNamesPage.parseCsv(csv.text);
      const patient = FlowBoardsPatientNamesPage.patientColumn(parsed);
      const abbreviated = patient.values.filter((v) => FlowBoardsPatientNamesPage.looksLikeInitials(v));
      console.log(
        `#3724 AC5 (#3774's export): ${patient.values.length} rows, column ${patient.index} "Patient:in", ` +
          `${abbreviated.length} abbreviated — e.g. ${JSON.stringify(patient.values.slice(0, 3))}`,
      );

      // #3774 AC5 called this "the one column that changes from today's export, which showed
      // initials only", and it shipped on release/3.14.0. So this half of #3724 AC5 is satisfied
      // already, by a ticket that is deployed — which is exactly why it is worth pinning: a #3724
      // deploy re-touching these controllers must not take it back.
      expect(patient.index, 'the export has a Patient:in column').toBeGreaterThanOrEqual(0);
      expect(patient.values.length, 'and rows in it').toBeGreaterThan(0);
      expect(abbreviated.length, 'none of them abbreviated').toBe(0);
    },
  );

  test(
    'AC5 the revenue-drilldown export is unreachable for this role — the #3181 allowlist, not a defect',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new FlowBoardsPatientNamesPage(request);

      const drilldown = await api.status('/kpis/management/revenue-drilldown/export', 'POST', { bar: 'erarbeitet' });
      // The control is what makes the 403 mean "allowlist" rather than "broken": #3181 established
      // that the management CSV export is Kian/Dennis-only, and it answers the same.
      const known = await api.status('/kpis/management/export', 'POST');
      const getVerb = await api.status('/kpis/management/revenue-drilldown/export', 'GET');
      console.log(`#3724 AC5: revenue-drilldown/export POST=${drilldown} (control /kpis/management/export POST=${known}), GET=${getVerb}`);

      expect(drilldown, 'AC5 first export: 403 for the QA Super Admin').toBe(403);
      expect(known, 'the known-allowlisted export answers the same, so this is the gate and not a fault').toBe(403);
      // 405 not 404: the route EXISTS and simply does not take GET — worth pinning so a future 404
      // is read as the route disappearing rather than as the same old permission wall.
      expect(getVerb, 'and the route exists — 405, not 404').toBe(405);
    },
  );

  test(
    'the banner\'s old export is still routed and still abbreviates — a second, independent deployment probe',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request);

      const csv = await api.billingBacklogExportCsv();
      expect(csv.status, 'POST /kpis/management/billing-backlog/export').toBe(200);
      const parsed = FlowBoardsPatientNamesPage.parseCsv(csv.text);
      const patient = FlowBoardsPatientNamesPage.patientColumn(parsed);
      const abbreviated = patient.values.filter((v) => FlowBoardsPatientNamesPage.looksLikeInitials(v));
      console.log(
        `#3724: banner export still live — ${patient.values.length} rows, ${abbreviated.length} abbreviated, ` +
          `e.g. ${JSON.stringify(patient.values.slice(0, 3))}`,
      );

      // #3774 hid the banner but deliberately kept its files (its Out of Scope: "hidden, not
      // removed", pending #3775), so this CSV is still reachable by URL. #3724's PR modifies
      // `ManagementBillingBacklogExportController`, so this is a second probe on a different
      // controller from the five collections above — and it agrees with them.
      expect(patient.values.length, 'the route still serves rows').toBeGreaterThan(0);
      expect(abbreviated.length, 'all of them abbreviated, like everything else on 3.14').toBe(patient.values.length);
    },
  );

  // ─────────────────── the ACs themselves, gated on the deploy ───────────────────
  //
  // These are the tests that verify #3724. They are GATED rather than `fixme`'d, so the day the
  // code reaches staging they run and assert the fix with no edit to this file.

  for (const surface of SURFACES) {
    test(
      `${surface.acs} ${surface.label} shows full patient names`,
      { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
      async ({ request }) => {
        test.setTimeout(900_000);
        const api = new FlowBoardsPatientNamesPage(request);
        test.skip(
          !(await api.isDeployed()),
          '#3724 is not on staging: it merged to release/3.15.0 (PR #3779) while its milestone says ' +
            'RC 3.14.0 and the 3.14 PR #3778 was closed unmerged. PatientDisplayName.php 404s on release/3.14.0.',
        );

        const reading = await api.surface(surface.path);
        console.log(
          `#3724 ${surface.acs} ${surface.label}: ${reading.values.length} values, ` +
            `${reading.fullNames} full names, ${reading.initials} still abbreviated`,
        );
        expect(reading.values.length, 'the surface carries patient values').toBeGreaterThan(0);
        expect(reading.initials, `${surface.acs}: no value is still an abbreviation`).toBe(0);
        // AC6: the abbreviation is removed and nothing else — the field is renamed, so a build that
        // kept `patientInitials` while filling it with names is called out rather than accepted.
        expect(
          reading.values.every((v) => v.field === FIELD.after),
          `AC6: the field is "${FIELD.after}", not the old name carrying new content`,
        ).toBe(true);
      },
    );
  }

  test(
    'AC1 the revenue drilldown names patients in full on all three bars',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request);
      test.skip(!(await api.isDeployed()), '#3724 is not on staging — see the deployment test.');

      // One bar is the AC's own example; all three share the provider, and a per-bar check is what
      // catches a formatter applied on only one of the row-building paths.
      for (const bar of DRILLDOWN_BARS) {
        const reading = await api.surface(`/kpis/management/revenue-drilldown?bar=${bar}`);
        console.log(`#3724 AC1 bar=${bar}: ${reading.values.length} values, ${reading.initials} abbreviated`);
        if (reading.values.length === 0) continue;
        expect(reading.initials, `AC1: bar "${bar}" abbreviates nothing`).toBe(0);
      }
    },
  );

  test(
    'AC2/AC3 the risk table paints full names on screen, in the same column as before',
    { tag: ['@SuperAdmin', '@PatientNames', '@ReadOnly'] },
    async ({ request, page }) => {
      test.setTimeout(900_000);
      const api = new FlowBoardsPatientNamesPage(request, page);
      test.skip(!(await api.isDeployed()), '#3724 is not on staging — see the deployment test.');

      await api.openBoard('Therapeuten-Orga');
      await expect(page.getByText('Offene Risiken', { exact: true }).first()).toBeVisible({ timeout: 300_000 });
      const painted = await api.paintedPatientValues();
      console.log(`#3724 AC2/AC3 on screen: ${painted.initials.length} abbreviated cells still painted`);

      // AC6's "same column position" is already pinned by #3774's own spec, which asserts the risk
      // table's column order with `Patient:in` first; this only has to show the VALUES changed.
      expect(painted.initials.length, 'no abbreviated patient cell survives on the board').toBe(0);
    },
  );
});
