import { test, expect } from '@playwright/test';
import {
  PrivatBasisExpiryPage,
  INSURANCE,
  SKIPPED_STATUSES,
  START_DEADLINE_DAYS,
  PHYSIO_TREATMENT_THRESHOLD,
  type Vo,
} from '../../../Pages/superadmin/sa.privat-basis-expiry.page';
import { API_BASE } from '../../../Pages/util/api-token';

/**
 * RC 3.14 — Privat Basis VOs expire automatically like GKV (#3709, commit `28f402375`).
 *
 * Privat Basis was carved out of the nightly expiry job when it became its own insurance type. The
 * fix removes it from two exclusion lists, leaving **only PKV** exempt.
 *
 * ## **MERGED BUT NOT DEPLOYED — re-derived from behaviour every run**
 *
 * `28f402375` is an ancestor of `release/3.14.0` (2026-09-16) and the API reports `3.14.0`, yet all
 * **10** Privat Basis VOs on staging still serve `treatmentStartDeadline: null` **and**
 * `validityDate: null`, while GKV VOs serve both. Those two fields are the job's own inputs and
 * both return null for an excluded insurance type before any rule runs, so their absence IS the
 * pre-fix build. `GET /status` cannot settle it — it reports the RELEASE, not the commit (#3704) —
 * which is why the probe is behavioural.
 *
 * **The GKV control is what makes the null mean something.** Both fields are legitimately null on
 * plenty of GKV VOs (no first treatment yet ⇒ no validity window), so "Privat Basis serves null"
 * proves nothing on its own.
 *
 * ## The rules are ported, and the port is validated before it is trusted
 *
 * The nightly command is console-only, so AC1–AC4 are verified as ARITHMETIC over the live
 * population: `oracleStartDeadline()` and `oracleValidityDate()` re-implement the shipped rules and
 * are first checked against the values the API serves for GKV — measured **160/160 on the start
 * deadline and 99 matches / 0 mismatches on the validity date**. Only then are they applied to
 * Privat Basis, where there is nothing served to compare against yet. The Ergo branch is
 * deliberately not ported and is reported as such rather than guessed.
 *
 * ## Scope warning: the commit carries a second ticket and a migration
 *
 * `28f402375` is "treat Privat Basis like GKV for validation **and** expiry". Alongside #3709 it
 * ships **#3708** — Privat Basis validated with the GKV check set — as migration
 * `Version20260916070000`, which appends `privat_basis` to every `validation` row carrying
 * `public`, minus 11 named checks. So deploying #3709 also changes which validation checks a Privat
 * Basis VO gets, and a QA signing this ticket off will see that change too. Measured here as an
 * independent second probe: Privat Basis is currently evaluated against **6** creation checks
 * against GKV's **18**.
 *
 * ## Findings
 *
 *  - **AC3's two conditions are not both reachable for a Privat Basis VO.** The rule is
 *    `isUrgentTreatmentNeed() || UV === insuranceType`, and `insuranceType` is ONE field — a VO is
 *    either `privat_basis` or `accident`, never both. Only the urgent arm can ever fire here, so
 *    the AC's "or covered by accident insurance" describes a case that cannot exist.
 *  - **AC7's count is a production figure and staging differs**: 2 Privat Basis VOs qualify by the
 *    start-deadline rule here (4946-8, 7551-9) against the ticket's 1. Not a contradiction — the
 *    ticket says so — but a QA comparing staging to "exactly 1" would file it.
 *
 * **Read-only** — every request is a GET, except the transient `preview-creation-validation` POST,
 * which hydrates a throwaway prescription and writes nothing (#3576).
 */

test.describe('#3709 Privat Basis VOs expire automatically like GKV', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: the fix is merged into release/3.14.0 but Privat Basis still serves neither date',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      const status = await (await request.get(`${API_BASE}/status`)).json();
      const state = await api.deploymentState(token);
      console.log(`#3709 API /status: ${JSON.stringify(status)}`);
      console.log(`#3709 deployment probe: ${JSON.stringify(state)}`);

      // The control: the fields DO serialize, and GKV VOs really do carry them. Without this a null
      // on Privat Basis is indistinguishable from the fields not being exposed at all.
      expect(state.gkvWithStartDeadline, 'GKV control: the start deadline is served').toBeGreaterThan(0);
      expect(state.gkvWithValidity, 'GKV control: the validity date is served').toBeGreaterThan(0);
      expect(state.privatBasisTotal, 'there are Privat Basis VOs to look at').toBeGreaterThan(0);

      if (!state.deployed) {
        console.log(
          `#3709 NOT DEPLOYED: ${state.privatBasisTotal} Privat Basis VOs, ${state.privatBasisWithStartDeadline} with a ` +
            `start deadline and ${state.privatBasisWithValidity} with a validity date — against ` +
            `${state.gkvWithStartDeadline}/${state.gkvWithValidity} of ${state.gkvSampleSize} GKV VOs. Both getters ` +
            'return null for an excluded insurance type before any rule runs, so this is the pre-fix build. The ' +
            `commit is merged to release/3.14.0 and the API reports ${status.version}: /status gives the release, ` +
            'not the commit (#3704).',
        );
        expect(state.privatBasisWithValidity, 'and the validity date is absent for the same reason').toBe(0);
      } else {
        console.log('#3709 DEPLOYED: Privat Basis VOs now carry the same two dates GKV VOs do.');
      }
    },
  );

  test(
    'the ported rules agree with what the API serves for GKV — earning the right to apply them to Privat Basis',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      const sample = await api.gkvSample(token);
      const result = api.validateOracle(sample);
      console.log(`#3709 oracle vs API over ${sample.length} GKV VOs: ${JSON.stringify(result)}`);

      expect(sample.length, 'a real sample, spread across the id space').toBeGreaterThan(100);
      // The start deadline has no "not started yet" branch, so every VO must match exactly.
      expect(result.startDeadline['MISMATCH'] ?? 0, 'start-deadline port is faithful').toBe(0);
      expect(result.startDeadline['match'] ?? 0).toBe(sample.length);
      // The validity date legitimately comes back null before a first treatment, so `both-null` is
      // a pass; only a disagreement on a value is a failure.
      expect(result.validity['MISMATCH'] ?? 0, 'validity port is faithful where it is ported').toBe(0);
      expect(result.validity['divergent'] ?? 0, 'and never one-sided').toBe(0);
      expect(result.validity['match'] ?? 0, 'with real dates checked, not only nulls').toBeGreaterThan(20);
    },
  );

  test(
    'AC5 PKV stays excluded — neither date, and no automatic expiry since long before the job\'s last run',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(420_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      const pkv = await api.vosByInsuranceType(INSURANCE.pkv, token);
      const withSd = pkv.filter((v) => v.treatmentStartDeadline);
      const withVd = pkv.filter((v) => v.validityDate);
      console.log(
        `#3709 AC5: ${pkv.length} PKV VOs sampled — ${withSd.length} with a start deadline, ${withVd.length} with a validity date`,
      );

      expect(pkv.length).toBeGreaterThan(0);
      // The regression AC: this must stay true after the deploy, and it is the one assertion in
      // this file that a leaked exclusion-list edit would break.
      expect(withSd.length, 'AC5: PKV has no start deadline').toBe(0);
      expect(withVd.length, 'AC5: and no validity window').toBe(0);

      // The precondition for every negative below: "no PKV VO was auto-expired" means nothing
      // unless the job is demonstrably still running.
      const lastRun = await api.jobLastRanAt(token);
      console.log(`#3709 the nightly job last wrote an automatic expiry at ${lastRun}`);
      expect(lastRun, 'the job is running, so a negative is informative').toBeTruthy();
      const lastRunAge = (Date.now() - Date.parse(lastRun as string)) / 86_400_000;
      expect(lastRunAge, 'and it ran recently').toBeLessThan(14);

      // **THE TRAP this test was rewritten around.** Staging's history predates both exclusions, so
      // PKV VOs DO carry old automatic entries — VO 3188-1 has 192 of them. Counting any entry
      // reports a live AC5 violation that is really a 2025 artifact (the #3651 lesson: old rows are
      // never rewritten, so partition by date). And `meta.type` matters: a `manual` entry is an
      // admin expiring a VO by hand, which no insurance type is exempt from.
      const byType: Record<string, { newest: string | null; ageDays: number | null; vosWithAnyLog: number }> = {};
      for (const [label, type] of [
        ['GKV', INSURANCE.public],
        ['PKV', INSURANCE.pkv],
        ['PrivatBasis', INSURANCE.privatBasis],
      ] as const) {
        const r = await api.newestAutomaticExpiry(type, token);
        byType[label] = {
          newest: r.newest,
          ageDays: r.newest ? Math.round((Date.now() - Date.parse(r.newest)) / 86_400_000) : null,
          vosWithAnyLog: r.vosWithAnyLog,
        };
        console.log(`#3709 newest AUTOMATIC expiry — ${label}: ${JSON.stringify(byType[label])}`);
      }

      // GKV is the positive control: the job still acts on it, recently.
      expect(byType.GKV.newest, 'GKV control: the job does auto-expire GKV VOs').toBeTruthy();
      expect(byType.GKV.ageDays as number, 'and did so recently').toBeLessThan(60);
      // PKV's newest automatic entry must be far older than GKV's — the exclusion in effect.
      expect(
        (byType.PKV.ageDays ?? Infinity) > (byType.GKV.ageDays as number) + 60,
        `AC5: PKV's newest automatic expiry (${byType.PKV.newest}) must be far staler than GKV's (${byType.GKV.newest})`,
      ).toBe(true);

      // And the same measurement is the pre-fix evidence for this ticket: Privat Basis is stale in
      // exactly the same way, because it is excluded in exactly the same way — today.
      console.log(
        `#3709 pre-fix evidence: Privat Basis's newest automatic expiry is ${byType.PrivatBasis.newest} ` +
          `(${byType.PrivatBasis.ageDays} days ago) against GKV's ${byType.PrivatBasis.newest ? byType.GKV.ageDays : '—'} days. ` +
          'Once the fix deploys and the job runs, a fresh automatic entry on a Privat Basis VO is AC1\'s positive proof.',
      );
    },
  );

  test(
    'AC1/AC2/AC3 the deadline arithmetic, and the 28-day boundary',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async () => {
      const base = { insuranceType: INSURANCE.privatBasis, therapyType: 'physiotherapy', date: '2026-01-01T00:00:00+00:00' };
      const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

      // AC1 — 28 days, not urgent.
      expect(PrivatBasisExpiryPage.startDeadlineDays(base as Vo)).toBe(START_DEADLINE_DAYS.standard);
      expect(day(PrivatBasisExpiryPage.oracleStartDeadline(base as Vo))).toBe('2026-01-29');

      // AC3 — the urgent arm. `urgentTreatmentNeed` is OMITTED when false, so the rule tests
      // `=== true`; a missing field must not be read as urgent.
      expect(PrivatBasisExpiryPage.startDeadlineDays({ ...base, urgentTreatmentNeed: true } as Vo)).toBe(
        START_DEADLINE_DAYS.urgent,
      );
      expect(PrivatBasisExpiryPage.startDeadlineDays({ ...base, urgentTreatmentNeed: undefined } as Vo)).toBe(
        START_DEADLINE_DAYS.standard,
      );
      expect(day(PrivatBasisExpiryPage.oracleStartDeadline({ ...base, urgentTreatmentNeed: true } as Vo))).toBe(
        '2026-01-15',
      );

      // AC2 — the boundary. Issued 27 days ago is inside the window; 28+ is past it.
      const now = new Date('2026-06-01T12:00:00Z');
      const issuedDaysAgo = (n: number): Vo =>
        ({ ...base, activityCount: 0, treatmentStatus: 'Aktiv', date: new Date(now.getTime() - n * 86_400_000).toISOString() }) as Vo;
      expect(PrivatBasisExpiryPage.qualifiesByStartDeadline(issuedDaysAgo(27), now), 'AC2: 27 days — not yet').toBe(false);
      expect(PrivatBasisExpiryPage.qualifiesByStartDeadline(issuedDaysAgo(28), now), 'AC1: 28 days — the deadline is reached, not passed').toBe(false);
      expect(PrivatBasisExpiryPage.qualifiesByStartDeadline(issuedDaysAgo(29), now), 'AC1: past the deadline').toBe(true);

      // A documented treatment takes the VO out of the start-deadline rule entirely.
      expect(
        PrivatBasisExpiryPage.qualifiesByStartDeadline({ ...issuedDaysAgo(60), activityCount: 1 }, now),
        'AC1 is about VOs with 0 documented treatments',
      ).toBe(false);

      // PKV is exempt before any of this is reached (AC5).
      expect(PrivatBasisExpiryPage.oracleStartDeadline({ ...base, insuranceType: INSURANCE.pkv } as Vo)).toBeNull();
    },
  );

  test(
    'FINDING: AC3 names two conditions, but only one can ever apply to a Privat Basis VO',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      // `insuranceType` holds exactly one value, and the populations are disjoint by construction.
      const counts: Record<string, number> = {};
      for (const t of [INSURANCE.public, INSURANCE.pkv, INSURANCE.privatBasis, INSURANCE.accident]) {
        counts[t] = await api.countByInsuranceType(t, token);
      }
      const total = await api.countByInsuranceType('', token).catch(() => 0);
      console.log(`#3709 insuranceType populations: ${JSON.stringify(counts)} (book total ${total})`);

      // The rule: 14 days when urgent OR accident. For a Privat Basis VO the second arm is dead.
      const privatBasisAccident = {
        insuranceType: INSURANCE.privatBasis,
        date: '2026-01-01T00:00:00+00:00',
        urgentTreatmentNeed: undefined,
      } as Vo;
      expect(
        PrivatBasisExpiryPage.startDeadlineDays(privatBasisAccident),
        'a Privat Basis VO cannot also be accident insurance, so only the urgent arm can give it 14 days',
      ).toBe(START_DEADLINE_DAYS.standard);

      console.log(
        '#3709 FINDING (for the PM): AC3 reads "marked as urgent treatment need, or covered by accident insurance". ' +
          'The implementation is `isUrgentTreatmentNeed() || UV === insuranceType`, and insuranceType is a single ' +
          'field — a VO is either privat_basis or accident, never both. So for a Privat Basis VO the accident arm ' +
          'is unreachable and only `dringender Behandlungsbedarf` can produce the 14-day deadline. AC3 is still ' +
          'satisfiable, but half of it describes a state that cannot exist.',
      );

      // The urgent half does have a live instance, so the branch is not merely theoretical.
      const pb = await api.vosByInsuranceType(INSURANCE.privatBasis, token);
      const urgent = pb.filter((v) => v.urgentTreatmentNeed === true);
      console.log(
        `#3709 AC3 urgent Privat Basis VOs: ${urgent.length} — ${urgent.map((v) => `${v.prescriptionId} (${v.treatmentStatus})`).join(', ') || 'none'}`,
      );
    },
  );

  test(
    'AC7 the population the first run would touch, and what the two dates would be',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();
      const now = new Date();

      const pb = await api.vosByInsuranceType(INSURANCE.privatBasis, token);
      const rows = pb.map((v) => {
        const sd = PrivatBasisExpiryPage.oracleStartDeadline(v);
        const vd = PrivatBasisExpiryPage.oracleValidityDate(v);
        return {
          vo: v.prescriptionId,
          status: v.treatmentStatus,
          therapy: v.therapyType,
          blanko: v.blankoVO ?? false,
          acts: v.activityCount ?? 0,
          prescribed: v.totalTreatments ?? 0,
          candidate: PrivatBasisExpiryPage.isJobCandidate(v),
          oracleStartDeadline: sd?.toISOString().slice(0, 10) ?? null,
          oracleValidity: vd === 'ERGO' ? 'ergo-branch' : (vd?.toISOString().slice(0, 10) ?? null),
          qualifies: PrivatBasisExpiryPage.qualifiesByStartDeadline(v, now),
        };
      });
      for (const r of rows) console.log(`#3709 AC7 ${JSON.stringify(r)}`);

      const candidates = rows.filter((r) => r.candidate);
      const qualifiers = rows.filter((r) => r.qualifies);
      console.log(
        `#3709 AC7 on staging: ${pb.length} Privat Basis VOs, ${candidates.length} the job would look at, ` +
          `${qualifiers.length} qualifying by the start-deadline rule — ${qualifiers.map((r) => r.vo).join(', ') || 'none'}. ` +
          "The ticket's count of 1 is against a 15 Sep production snapshot, so a difference here is expected.",
      );

      // The status filter is load-bearing: without it most of the population looks like a qualifier.
      const ignoringStatus = rows.filter((r) => r.acts === 0 && r.oracleStartDeadline && new Date(r.oracleStartDeadline) < now);
      expect(
        candidates.length,
        `the job skips ${SKIPPED_STATUSES.join('/')}, so most of the population is out of scope`,
      ).toBeLessThan(pb.length);
      console.log(
        `#3709 AC7 note: ignoring the status filter would count ${ignoringStatus.length} instead of ${qualifiers.length}.`,
      );

      // **The assertion has to survive the job, which is why it is not "qualifiers > 0".** Before
      // the deploy the interesting number was how many were waiting; after the first run it is
      // legitimately zero, because the job cleared them — so a `> 0` check fails on a WORKING
      // build, which is exactly how this test failed the first time it ran post-deploy.
      //
      // The durable invariant is catch-up: a VO may only still be a qualifier if it became one
      // AFTER the last run. Anything older means the job saw it and left it alone.
      const lastRun = await api.jobLastRanAt(token);
      console.log(`#3709 AC7 job last ran ${lastRun}; ${qualifiers.length} qualifier(s) outstanding now`);
      for (const r of qualifiers) {
        const deadline = new Date(r.oracleStartDeadline as string);
        console.log(`#3709 AC7 outstanding ${r.vo}: deadline ${r.oracleStartDeadline}, last run ${lastRun}`);
        expect(
          deadline.getTime(),
          `AC7: ${r.vo} may only be outstanding because its deadline passed after the last run`,
        ).toBeGreaterThan(Date.parse(lastRun as string));
      }
    },
  );

  test(
    'AC4 the Physio validity window, and the fixture that will show it',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      // The rule, stated: first treatment + 3 months at or below the threshold, + 6 above it.
      const base = {
        insuranceType: INSURANCE.privatBasis,
        therapyType: 'physiotherapy',
        date: '2026-01-01T00:00:00+00:00',
        activityCount: 1,
        treatmentStartDate: '2026-01-15T00:00:00+00:00',
      };
      const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      expect(day(PrivatBasisExpiryPage.oracleValidityDate({ ...base, totalTreatments: PHYSIO_TREATMENT_THRESHOLD } as Vo))).toBe(
        '2026-04-15',
      );
      expect(day(PrivatBasisExpiryPage.oracleValidityDate({ ...base, totalTreatments: PHYSIO_TREATMENT_THRESHOLD + 1 } as Vo))).toBe(
        '2026-07-15',
      );
      // Before the first treatment the window has not begun — the start deadline covers that case.
      expect(
        PrivatBasisExpiryPage.oracleValidityDate({ ...base, treatmentStartDate: null, activityCount: 0, totalTreatments: 10 } as Vo),
        'AC4 anchors on the first treatment, so a 0-treatment VO has no validity date',
      ).toBeNull();

      // And the live fixture that will carry it once deployed.
      const pb = await api.vosByInsuranceType(INSURANCE.privatBasis, token);
      const physioStarted = pb.filter(
        (v) => v.therapyType === 'physiotherapy' && !v.blankoVO && (v.activityCount ?? 0) > 0 && v.treatmentStartDate,
      );
      let checked = 0;
      for (const v of physioStarted) {
        const vd = PrivatBasisExpiryPage.oracleValidityDate(v);
        const verdict = PrivatBasisExpiryPage.compare(v.validityDate, vd);
        console.log(
          `#3709 AC4 ${v.prescriptionId} (${v.treatmentStatus}): firstTreatment=${String(v.treatmentStartDate).slice(0, 10)} ` +
            `prescribed=${v.totalTreatments} → oracle ${vd instanceof Date ? vd.toISOString().slice(0, 10) : vd} | ` +
            `served ${String(v.validityDate).slice(0, 10)} → ${verdict}`,
        );
        // The served value is the shipped rule's own output, so this is AC4 measured on real Privat
        // Basis data rather than argued from the GKV side: first treatment + 3 months at or below
        // the threshold, + 6 above it, to the day.
        expect(verdict, `AC4: ${v.prescriptionId} validity window`).toBe('match');
        checked++;
      }
      expect(checked, 'AC4 is exercised on real Privat Basis VOs, not only on the rule in the abstract').toBeGreaterThan(
        0,
      );
      // And on both sides of the threshold, or the 3-vs-6-month branch is half-tested.
      const spans = new Set(physioStarted.map((v) => ((v.totalTreatments ?? 0) > PHYSIO_TREATMENT_THRESHOLD ? 6 : 3)));
      console.log(`#3709 AC4 month-spans exercised on live VOs: ${[...spans].sort().join(' and ')}`);
      expect(spans.size, 'both the 3-month and the 6-month branch have a live VO').toBeGreaterThan(1);
    },
  );

  test(
    'scope: the same commit also gives Privat Basis the GKV validation check set (#3708)',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      // A transient prescription — this endpoint writes nothing (#3576), so it is free to call.
      const gkv = await api.creationCheckIds(INSURANCE.public, token);
      const pkv = await api.creationCheckIds(INSURANCE.pkv, token);
      const pb = await api.creationCheckIds(INSURANCE.privatBasis, token);
      console.log(`#3709/#3708 creation checks — GKV ${gkv.length} ${JSON.stringify(gkv)}`);
      console.log(`#3709/#3708 creation checks — PKV ${pkv.length} ${JSON.stringify(pkv)}`);
      console.log(`#3709/#3708 creation checks — Privat Basis ${pb.length} ${JSON.stringify(pb)}`);
      console.log(`#3709/#3708 GKV checks Privat Basis does NOT get: ${JSON.stringify(gkv.filter((i) => !pb.includes(i)))}`);

      expect(gkv.length, 'GKV has the widest set').toBeGreaterThan(pkv.length);

      // A second, independent probe for the SAME commit: migration Version20260916070000 appends
      // `privat_basis` to every `validation` row carrying `public`, minus 11 named checks. Until it
      // runs, Privat Basis stays on the PKV-shaped set.
      const migrated = pb.length > pkv.length;
      console.log(
        migrated
          ? `#3708 migration HAS run: Privat Basis is on ${pb.length} checks, beyond PKV's ${pkv.length}.`
          : `#3708 migration has NOT run: Privat Basis is on ${pb.length} checks against GKV's ${gkv.length} — ` +
              'the same verdict the #3709 date probe reaches, from a completely different surface. ' +
              'Worth knowing before signing #3709 off: the two ship in one commit, so deploying the expiry ' +
              'change also changes which validation checks a Privat Basis VO gets.',
      );
    },
  );

  test(
    'AC1/AC3/AC6 the nightly run expired exactly the Privat Basis VOs the rule selects, with the German reason and the Bestellen flip',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(420_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();

      // The job's most recent run, taken from the trail rather than from a clock: staging's nightly
      // lands ~20:02 UTC, and pinning a date would rot.
      const lastRun = await api.jobLastRanAt(token);
      expect(lastRun, 'the job has run at all').toBeTruthy();
      const runPrefix = (lastRun as string).slice(0, 14); // yyyy-mm-ddThh
      const expired = await api.expiredInRun(runPrefix, token);
      const byType = expired.reduce<Record<string, number>>((acc, e) => {
        const k = e.insuranceType ?? '(none)';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`#3709 last run ${lastRun}: ${expired.length} VOs expired — ${JSON.stringify(byType)}`);

      const privatBasis = expired.filter((e) => e.insuranceType === INSURANCE.privatBasis);
      for (const e of privatBasis) console.log(`#3709 AC1 expired ${e.prescriptionId}: ${e.reason}`);

      // AC1 — the headline. Before this ticket the job could not touch a Privat Basis VO at all, so
      // a single one in a run is the whole change; the GKV rows alongside are the control that the
      // run was a normal one and not a Privat-Basis-only backfill.
      expect(privatBasis.length, 'AC1: the job now expires Privat Basis VOs').toBeGreaterThan(0);
      expect(byType[INSURANCE.public] ?? 0, 'and GKV is still being expired in the same run').toBeGreaterThan(0);
      // AC5 again, on the freshest possible evidence: this run, not a historical window.
      expect(byType[INSURANCE.pkv] ?? 0, 'AC5: PKV was not touched by this run').toBe(0);

      // AC3 — the reason states the deadline that fired and both dates, in German (#3651's format).
      for (const e of privatBasis) {
        expect(e.reason, `${e.prescriptionId} carries a reason`).toBeTruthy();
        const reason = e.reason as string;
        expect(reason, 'AC3: German, naming the deadline').toMatch(/innerhalb von (14|28) Tagen|Gültigkeitszeitraum/);
        const days = Number(reason.match(/innerhalb von (\d+) Tagen/)?.[1] ?? 0);
        if (days) {
          // The self-consistency invariant #3651 established: the announced day count must equal
          // Frist − Ausstellung, or the VO was expired under one rule and told about another.
          const frist = reason.match(/Frist:\s*(\d{2})\.(\d{2})\.(\d{4})/);
          const issue = reason.match(/Ausstellung:\s*(\d{2})\.(\d{2})\.(\d{4})/);
          expect(frist && issue, 'AC3: both dates are stated').toBeTruthy();
          const toDate = (m: RegExpMatchArray) => Date.UTC(+m[3], +m[2] - 1, +m[1]);
          const span = Math.round((toDate(frist as RegExpMatchArray) - toDate(issue as RegExpMatchArray)) / 86_400_000);
          console.log(`#3709 AC3 ${e.prescriptionId}: announced ${days} days, Frist − Ausstellung = ${span}`);
          expect(span, 'AC3: the announced deadline matches the dates it names').toBe(days);
          expect([14, 28], 'AC1/AC3: one of the two start deadlines').toContain(days);
        }
      }

      // AC6 — the downstream effects, read off the same run's log rows on one of the VOs.
      const sample = privatBasis[0];
      const logs = (await api.allLogsFor(sample.voId, token)).filter((l) => (l.createdAt ?? '').startsWith(runPrefix));
      console.log(`#3709 AC6 ${sample.prescriptionId} run rows: ${JSON.stringify(logs.map((l) => `${l.type}:${l.oldValue}->${l.newValue}`))}`);

      const statusRow = logs.find((l) => l.type === 'treatment_expired');
      expect(statusRow?.oldValue, 'AC6: it was live before the run').toBeTruthy();
      expect(statusRow?.newValue, 'AC6: status → Abgelaufen').toBe('Abgelaufen');
      expect(statusRow?.metaType, 'written by the job, not by an admin').toBe('automatic');
      // "follow-up status is set to Bestellen (Order) if it was blank" — the null → order row.
      const followup = logs.find((l) => l.type === 'field_change' && l.newValue === 'order');
      expect(followup, 'AC6: followupStatus set in the same run').toBeTruthy();
      // **"Blank" is the literal string `"null"`**, not a JS null — `PrescriptionLogTypeEnum::EMPTY`
      // is the four characters `null`, and the log column stores that sentinel. A `toBeFalsy()`
      // check reads it as "the field already had a value" and reports AC6 failing on a correct run.
      expect(
        [null, '', 'null'],
        'AC6: the follow-up status was blank before the run, so the job was allowed to set it',
      ).toContain(followup?.oldValue ?? null);

      const vo = (await api.vosByInsuranceType(INSURANCE.privatBasis, token)).find((v) => v.id === sample.voId);
      console.log(`#3709 AC6 ${sample.prescriptionId} now: status=${vo?.treatmentStatus} followupStatus=${vo?.followupStatus}`);
      expect(vo?.treatmentStatus, 'AC6: and it stuck').toBe('Abgelaufen');
      expect(vo?.followupStatus, 'AC6: Bestellen').toBe('order');
    },
  );

  test(
    'AC2 the same run left every Privat Basis VO still inside its deadline alone',
    { tag: ['@SuperAdmin', '@PrivatBasisExpiry', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(240_000);
      const api = new PrivatBasisExpiryPage(request);
      const token = await api.adminToken();
      const now = new Date();

      // AC2 is the negative half of AC1 and needs the same run to be the evidence: a VO the rule
      // does NOT select must still be live. Without this, "the job expires Privat Basis VOs" is
      // satisfied by a job that expires all of them.
      const pb = await api.vosByInsuranceType(INSURANCE.privatBasis, token);
      const inside = pb.filter(
        (v) => PrivatBasisExpiryPage.isJobCandidate(v) && !PrivatBasisExpiryPage.qualifiesByStartDeadline(v, now),
      );
      for (const v of inside) {
        const deadline = PrivatBasisExpiryPage.oracleStartDeadline(v);
        const daysLeft = deadline ? Math.round((deadline.getTime() - now.getTime()) / 86_400_000) : null;
        console.log(
          `#3709 AC2 ${v.prescriptionId}: status=${v.treatmentStatus} acts=${v.activityCount} ` +
            `deadline=${deadline?.toISOString().slice(0, 10)} (${daysLeft} days away) — must still be live`,
        );
        expect(v.treatmentStatus, `AC2: ${v.prescriptionId} is inside its window, so it is not expired`).not.toBe(
          'Abgelaufen',
        );
      }
      expect(inside.length, 'AC2 has at least one VO to be left alone').toBeGreaterThan(0);
    },
  );

});
