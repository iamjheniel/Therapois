import { test, expect } from '@playwright/test';
import { DischargeExpiryPage, type ExpiryLog, type Vo } from '../../../Pages/superadmin/sa.discharge-expiry.page';

/**
 * RC 3.14 — #3800: Discharge VOs (Entlassmanagement) expire when treatment starts after
 * day 7, or once the 12-day window is over.
 *
 * Shipped as `c79958e3b` (PR #3813): `ExpirePrescriptionCommand` +14/-2, two new
 * `ExpiryReasonTypeEnum` cases, `PrescriptionExpirationTrait` +82.
 *
 * THE JOB IS CONSOLE-ONLY, so this file never runs it. It reads what two real nightly runs
 * left behind — which is better evidence than a manufactured one, because the second run
 * caught exactly the two VOs whose windows closed ON the first run day.
 *
 * Read-only: every request is a GET.
 */

const P = DischargeExpiryPage;

/** Today, resolved once — comparing served dates against two different "now"s makes
 *  a VO one day either side of its boundary agree with both verdicts (#3471). */
const TODAY = new Date().toISOString().slice(0, 10);

/** The fixtures, by VO number. Each is re-read and re-classified before use, so a fixture
 *  that has drifted fails loudly instead of quietly proving nothing. */
const F = {
  /** No treatment; day 7 fell ON the first run day — survived it, expired on the next. */
  boundaryStart: '99664-1',
  /** Treated inside day 7; the 12-day window ended ON the first run day — same. */
  boundaryWindow: '99665-1',
  /** The only fixture with a treatment that came LATE (09-24 against a 09-23 deadline). */
  lateStart: '99667-1',
  /** Privat Basis — AC4's second applying type. */
  privatBasis: '99669-1',
  /** PKV — excluded from expiry entirely, so it carries no deadlines at all. */
  pkv: '99670-1',
  /** Accident/BG — keeps the OLD 14-day rule and no validity date. */
  accident: '99671-1',
  /** No insurance type — keeps the OLD 28-day rule. */
  noType: '99672-1',
  /** Fertig Behandelt, the same shape as two VOs that DID expire. AC5/AC6's control. */
  terminal: '99675-1',
  /** Not a discharge VO: 28-day start deadline, validity from the first treatment. */
  control: '99680-1',
} as const;

/** The 5 real (non-fixture) discharge VOs the fix cleared on its first run. */
const REAL = ['9988999-5', '9489-1', '9594-1', '9612-1', '9612-2'];

test.describe('#3800 Entlassmanagement VO expiry', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let sa: DischargeExpiryPage;
  let tail: ExpiryLog[] = [];
  let discharge: ExpiryLog[] = [];

  test.beforeAll(async () => {
    sa = new DischargeExpiryPage();
    await sa.connect();
    tail = await sa.expiryLogTail(4);
    discharge = tail.filter((l) => P.isDischargeReason(l.reason));
  });

  test.afterAll(async () => {
    await sa?.dispose();
  });

  test(
    'the two silent-ignore traps, pinned before any zero from either is believed',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // (a) `isDischargeManagement` is SERIALIZED on the VO but is not a registered filter.
      // Accepted and ignored: every value returns the unfiltered book. So the population
      // cannot be selected server-side and has to be derived from the window itself.
      const all = await sa.voCount();
      const yes = await sa.voCount('isDischargeManagement=true');
      const no = await sa.voCount('isDischargeManagement=false');
      const bogus = await sa.voCount('zzzNotAFilter=1');
      console.log(`  /prescriptions total ${all}; ?isDischargeManagement=true ${yes}, =false ${no}, bogus ${bogus}`);
      expect(yes, 'isDischargeManagement is silently ignored').toBe(all);
      expect(no).toBe(all);
      expect(bogus).toBe(all);

      // The control that makes those equalities mean "ignored" and not "everything matches":
      // a filter that IS registered narrows the same collection.
      expect(await sa.filterIsHonoured('date%5Bafter%5D', '2026-09-01'), 'date[after] IS honoured').toBe(true);

      // (b) `order[id]` is ignored on /prescription_logs — asc and desc are byte-identical,
      // and the collection is id-ascending. A "newest N" scan therefore returns the OLDEST
      // N: 3,600 rows of 2025 history carrying ZERO discharge reasons, which reads exactly
      // like the job never having run. This is why the tail is read by page number.
      const ordered = await sa.orderIsHonoured('/prescription_logs?type=treatment_expired', 'id');
      console.log(`  /prescription_logs order[id] honoured: ${ordered}`);
      expect(ordered, 'order[id] is silently ignored on /prescription_logs').toBe(false);
    },
  );

  test(
    'DEPLOYED: the discharge expiry reason exists, and only from the first run onwards',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // /status reports 3.14.0 either side of this commit — the release, not the commit
      // (#3704) — so deployment is decided from behaviour. The `Entlassmanagement:` reason
      // is written by nothing but this ticket's two new enum cases.
      console.log(`  treatment_expired tail: ${tail.length} rows, ${tail[0]?.createdAt.slice(0, 10)} .. ${tail.at(-1)?.createdAt.slice(0, 10)}`);
      expect(discharge.length, 'discharge expiries in the log tail').toBeGreaterThan(0);

      const days = [...new Set(discharge.map((l) => l.createdAt.slice(0, 10)))].sort();
      const kinds = discharge.reduce<Record<string, number>>((a, l) => {
        const k = P.kindOf(l.reason);
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  ${discharge.length} discharge expiries on ${JSON.stringify(days)}, kinds ${JSON.stringify(kinds)}`);

      // Both new reason types actually occur — a build that shipped one of them would
      // otherwise pass on the other's instances alone.
      expect(kinds.start7, 'day-7 expiries').toBeGreaterThan(0);
      expect(kinds.window12, '12-day-window expiries').toBeGreaterThan(0);
      expect(kinds.other ?? 0, 'no unrecognised discharge reason').toBe(0);

      // Historical entries are never rewritten (#3651), so the evidence is a PARTITION:
      // nothing before the first run carries the new wording, and the tail holds plenty of
      // older non-discharge entries to make that a real statement rather than an empty set.
      expect(days[0], 'earliest discharge expiry is the fix\'s first run').toBe(P.FIRST_RUN);
      const older = tail.filter((l) => l.createdAt.slice(0, 10) < P.FIRST_RUN);
      console.log(`  older (pre-first-run) entries in the same tail: ${older.length}, none carrying the new wording`);
      expect(older.length, 'the tail spans pre-fix history too').toBeGreaterThan(50);
      expect(older.filter((l) => P.isDischargeReason(l.reason)), 'no pre-fix entry was rewritten').toHaveLength(0);

      // Every one is the nightly job, not a hand edit: `automatic`, with no author.
      expect(discharge.every((l) => l.type === 'automatic'), 'all automatic').toBe(true);
      expect(discharge.every((l) => l.author === null), 'all system-written').toBe(true);
    },
  );

  test(
    'the served 7/12 window, against a non-discharge control (#3830 ships the display)',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // #3800's Out of Scope explicitly excluded changing Startfrist / Gültig bis. The
      // served fields DO read 7/12 today — delivered by `4b1722ce7`/`a394b0af8`, both
      // `Ref #3830`, which moved the presenter onto the shared `DischargeWindow`. Recorded
      // here so the two tickets are not confused: this probes the window DEFINITION, while
      // the test above probes the EXPIRY.
      const d = await sa.voByNumber(F.boundaryWindow);
      expect(d, `fixture ${F.boundaryWindow}`).not.toBeNull();
      expect(d!.isDischargeManagement).toBe(true);
      expect(P.daysBetween(d!.date, d!.treatmentStartDeadline!), 'discharge start deadline').toBe(7);
      expect(P.daysBetween(d!.date, d!.validityDate!), 'discharge validity').toBe(12);

      const c = await sa.voByNumber(F.control);
      expect(c, `control ${F.control}`).not.toBeNull();
      expect(c!.isDischargeManagement ?? false, 'control is not a discharge VO').toBeFalsy();
      expect(P.daysBetween(c!.date, c!.treatmentStartDeadline!), 'standard start deadline').toBe(28);

      // The control's validity is measured from its FIRST TREATMENT, not from issue — which
      // is the other half of what makes the discharge window distinctive, and the reason the
      // 12 days are stated "nach Ausstellung" in the reason text.
      const firstBeh = await sa.firstTreatmentDate(c!.id);
      console.log(`  discharge ${d!.prescriptionId}: ${d!.date.slice(0, 10)} → +7 ${d!.treatmentStartDeadline!.slice(0, 10)} / +12 ${d!.validityDate!.slice(0, 10)}`);
      console.log(`  control   ${c!.prescriptionId}: ${c!.date.slice(0, 10)} → +28 ${c!.treatmentStartDeadline!.slice(0, 10)} / valid ${c!.validityDate?.slice(0, 10)} (1st Beh ${firstBeh})`);
      expect(P.daysBetween(c!.date, c!.validityDate!), 'control validity is NOT issue+12').not.toBe(12);
    },
  );

  test(
    'AC1/AC3: both reasons are printed as specified, with self-consistent dates',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // The AC quotes prose; the shipped string is matched on its PARTS, in order, so a
      // correct implementation cannot fail on punctuation (#3666/#3668).
      const mismatches: string[] = [];
      let start = 0;
      let window = 0;

      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        const kind = P.kindOf(l.reason);
        const parts = kind === 'start7' ? P.REASON_START : P.REASON_WINDOW;
        if (!P.containsInOrder(l.reason, parts)) {
          mismatches.push(`${vo.prescriptionId}: wording — ${l.reason}`);
          continue;
        }

        // The invariant that catches "28 days over a 14-day deadline" without knowing the
        // rule (#3651): the reason states a day count AND both dates, so they must agree —
        // and the first date must be the VO's own issue date.
        const dates = P.datesInReason(l.reason);
        if (dates.length < 2) {
          mismatches.push(`${vo.prescriptionId}: ${dates.length} dates in reason`);
          continue;
        }
        const want = kind === 'start7' ? P.START_DAYS : P.WINDOW_DAYS;
        const gap = P.daysBetween(dates[0], dates[1]);
        if (gap !== want) mismatches.push(`${vo.prescriptionId}: announces ${want} over a ${gap}-day span`);
        if (dates[0] !== vo.date.slice(0, 10)) {
          mismatches.push(`${vo.prescriptionId}: reason Ausstellung ${dates[0]} != VO date ${vo.date.slice(0, 10)}`);
        }
        // And the boundary the reason prints must be the one the rule computes.
        const expected = P.addDays(vo.date, want);
        if (dates[1] !== expected) {
          mismatches.push(`${vo.prescriptionId}: reason boundary ${dates[1]} != issue+${want} ${expected}`);
        }
        kind === 'start7' ? start++ : window++;
      }

      console.log(`  ${start} day-7 reasons + ${window} window reasons checked, ${mismatches.length} mismatches`);
      for (const m of mismatches) console.log(`    ${m}`);
      expect(mismatches, 'every discharge reason is well-formed and self-consistent').toHaveLength(0);
      expect(start, 'AC1 instances').toBeGreaterThan(0);
      expect(window, 'AC3 instances').toBeGreaterThan(0);
    },
  );

  test(
    'AC1: a treatment that starts AFTER day 7 expires the VO',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // The discriminating case for AC1's literal wording. Every other day-7 expiry here has
      // no treatment at all, where "did not start in time" and "was never started" look the
      // same; this one WAS treated, one day late, and still expired.
      const vo = await sa.voByNumber(F.lateStart);
      expect(vo, `fixture ${F.lateStart}`).not.toBeNull();

      const deadline = P.addDays(vo!.date, P.START_DAYS);
      const firstBeh = await sa.firstTreatmentDate(vo!.id);
      console.log(`  ${vo!.prescriptionId}: issued ${vo!.date.slice(0, 10)}, day-7 deadline ${deadline}, first treatment ${firstBeh}`);

      expect(firstBeh, 'the fixture has a treatment').not.toBeNull();
      expect(firstBeh! > deadline, 'and it came after the deadline').toBe(true);
      expect(vo!.treatmentStatus).toBe('Abgelaufen');

      const logs = (await sa.expiryLogsFor(vo!.id)).filter((l) => P.isDischargeReason(l.reason));
      expect(logs.length, 'expired under the discharge rule').toBeGreaterThan(0);
      expect(P.kindOf(logs.at(-1)!.reason), 'as a day-7 expiry, not a window one').toBe('start7');
    },
  );

  test(
    'AC2: the boundary is strictly AFTER the closing day — shown across two nightly runs',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // The strongest evidence on this ticket, and it is not manufactured: two VOs whose
      // windows closed exactly ON the first run day were NOT expired by that run, and were
      // expired by the next one. That separates `> boundary` from `>= boundary`, which no
      // single run can do. (It also means the PM's AC-2 note — recording 99664-1 as still
      // Aktiv on 25 Sep — is correct for that day and stale today.)
      for (const [number, days] of [
        [F.boundaryStart, P.START_DAYS],
        [F.boundaryWindow, P.WINDOW_DAYS],
      ] as const) {
        const vo = await sa.voByNumber(number);
        expect(vo, `fixture ${number}`).not.toBeNull();

        const boundary = P.addDays(vo!.date, days);
        const logs = (await sa.expiryLogsFor(vo!.id)).filter((l) => P.isDischargeReason(l.reason));
        expect(logs.length, `${number} expired under the discharge rule`).toBeGreaterThan(0);
        const when = logs.at(-1)!.createdAt.slice(0, 10);

        console.log(`  ${number}: issued ${vo!.date.slice(0, 10)}, window closed ${boundary}, expired ${when}`);
        expect(boundary, `${number}'s window closed on the first run day`).toBe(P.FIRST_RUN);
        expect(when, `${number} survived that run and expired on the next`).toBe(P.SECOND_RUN);
      }

      // And the run that skipped them did expire other VOs the same night, so the two were
      // skipped by the rule rather than by the job not running.
      const onFirst = discharge.filter((l) => l.createdAt.slice(0, 10) === P.FIRST_RUN);
      console.log(`  the first run expired ${onFirst.length} other discharge VOs that night`);
      expect(onFirst.length, 'the first run was not a no-op').toBeGreaterThan(0);
    },
  );

  test(
    'AC4: the window applies to GKV and Privat Basis, and to nothing else',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // Read as a truth table off the served deadlines, which is exact — and the excluded
      // rows are the point: a change that leaked past `privat_basis` would move them.
      const rows: string[] = [];

      for (const [number, type] of [
        [F.boundaryWindow, 'public'],
        [F.privatBasis, 'privat_basis'],
      ] as const) {
        const vo = await sa.voByNumber(number);
        expect(vo, number).not.toBeNull();
        expect(vo!.insuranceType, `${number} is ${type}`).toBe(type);
        expect(vo!.isDischargeManagement).toBe(true);
        expect(P.daysBetween(vo!.date, vo!.treatmentStartDeadline!), `${number} start`).toBe(7);
        expect(P.daysBetween(vo!.date, vo!.validityDate!), `${number} window`).toBe(12);
        rows.push(`${number} ${type}: +7 / +12  APPLIES`);
      }

      // PKV is excluded from expiry altogether (#3709), so a PKV discharge VO carries
      // neither deadline. Worth pinning because the exclusion is pre-existing, not this
      // ticket's — but it is what AC4's PKV row observes.
      const pkv = await sa.voByNumber(F.pkv);
      expect(pkv, F.pkv).not.toBeNull();
      expect(pkv!.insuranceType).toBe('private');
      expect(pkv!.isDischargeManagement).toBe(true);
      expect(pkv!.treatmentStartDeadline ?? null, 'PKV gets no start deadline').toBeNull();
      expect(pkv!.validityDate ?? null, 'PKV gets no validity date').toBeNull();
      rows.push(`${F.pkv} private: none / none  EXCLUDED`);

      // BG and an unset type keep the OLD rules — 14 and 28 days, and no validity window.
      for (const [number, startDays, type] of [
        [F.accident, 14, 'accident'],
        [F.noType, 28, null],
      ] as const) {
        const vo = await sa.voByNumber(number);
        expect(vo, number).not.toBeNull();
        expect(vo!.insuranceType ?? null, `${number} type`).toBe(type);
        expect(vo!.isDischargeManagement).toBe(true);
        expect(P.daysBetween(vo!.date, vo!.treatmentStartDeadline!), `${number} keeps the old start rule`).toBe(startDays);
        expect(vo!.validityDate ?? null, `${number} gets no discharge window`).toBeNull();
        rows.push(`${number} ${type ?? 'unset'}: +${startDays} / none  OLD RULES`);
      }

      for (const r of rows) console.log(`  ${r}`);

      // Every VO the job actually expired under this rule is one of the two applying types.
      const offenders: string[] = [];
      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        if (!P.DISCHARGE_TYPES.includes(vo.insuranceType ?? '')) {
          offenders.push(`${vo.prescriptionId} (${vo.insuranceType})`);
        }
      }
      console.log(`  ${discharge.length} discharge expiries, ${offenders.length} on a non-applying type`);
      expect(offenders, 'no excluded insurance type was expired by this rule').toHaveLength(0);
      // ...and Privat Basis is genuinely exercised, not merely permitted.
      const basis: string[] = [];
      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        if (vo.insuranceType === 'privat_basis') basis.push(vo.prescriptionId);
      }
      expect(basis.length, 'Privat Basis discharge expiries actually occur').toBeGreaterThan(0);
      console.log(`  Privat Basis instances: ${basis.join(', ')}`);
    },
  );

  test(
    'AC5/AC6: it always writes Abgelaufen, and never touches a closed VO',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // AC6: the outcome is Abgelaufen, never Fertig Behandelt — the distinction the ticket
      // draws, since a discharge VO that ran out of time has not finished treatment.
      const wrong: string[] = [];
      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        if (vo.treatmentStatus !== 'Abgelaufen') wrong.push(`${vo.prescriptionId} → ${vo.treatmentStatus}`);
      }
      console.log(`  ${discharge.length} expired VOs, ${wrong.length} not Abgelaufen`);
      for (const w of wrong) console.log(`    ${w}`);
      expect(wrong, 'every discharge expiry landed on Abgelaufen').toHaveLength(0);

      // AC5, and this control is unusually clean: the fixture has the SAME issue date and
      // window as two VOs the same run expired, and differs only by already being closed.
      const closed = await sa.voByNumber(F.terminal);
      expect(closed, F.terminal).not.toBeNull();
      expect(closed!.isDischargeManagement).toBe(true);
      expect(closed!.treatmentStatus, 'the control is closed').toBe('Fertig Behandelt');
      expect(P.daysBetween(closed!.date, closed!.validityDate!), 'its window is a discharge one').toBe(12);
      expect(closed!.validityDate!.slice(0, 10) < TODAY, 'and it has long since closed').toBe(true);

      const twins: string[] = [];
      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        if (vo.date.slice(0, 10) === closed!.date.slice(0, 10)) twins.push(vo.prescriptionId);
      }
      console.log(`  ${F.terminal} (Fertig Behandelt, issued ${closed!.date.slice(0, 10)}, window to ${closed!.validityDate!.slice(0, 10)}) untouched`);
      console.log(`  same-issue-date VOs the job DID expire: ${twins.join(', ') || 'none'}`);
      expect(twins.length, 'the control has expired twins, so being skipped is the rule at work').toBeGreaterThan(0);
      expect(
        (await sa.expiryLogsFor(closed!.id)).filter((l) => P.isDischargeReason(l.reason)),
        'the closed VO was never expired by this rule',
      ).toHaveLength(0);
    },
  );

  test(
    'the fix cleared a real backlog on its first run, and re-derives correctly today',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly'] },
    async () => {
      // The purpose-built fixtures show the rule; these show it mattered. Five real VOs had
      // been sitting open since April–July, months past their 12-day windows, and the
      // fix's first run took all five.
      const seen: Vo[] = [];
      for (const number of REAL) {
        const vo = await sa.voByNumber(number);
        if (!vo) {
          console.log(`  ${number}: absent from staging today`);
          continue;
        }
        seen.push(vo);
        const logs = (await sa.expiryLogsFor(vo.id)).filter((l) => P.isDischargeReason(l.reason));
        const overdueBy = P.daysBetween(vo.validityDate ?? vo.date, P.FIRST_RUN);
        console.log(`  ${number}: issued ${vo.date.slice(0, 10)}, window to ${vo.validityDate?.slice(0, 10)} (${overdueBy} days overdue at the first run) → ${vo.treatmentStatus}, ${logs.length} discharge log(s)`);
        expect(vo.isDischargeManagement, `${number} is a discharge VO`).toBe(true);
        expect(vo.treatmentStatus, `${number} expired`).toBe('Abgelaufen');
        expect(logs.length, `${number} expired under THIS rule`).toBeGreaterThan(0);
        expect(logs[0].createdAt.slice(0, 10), `${number} was taken by the first run`).toBe(P.FIRST_RUN);
        expect(overdueBy, `${number} was genuinely overdue, not a same-week case`).toBeGreaterThan(30);
      }
      expect(seen.length, 'real discharge VOs found').toBeGreaterThan(0);

      // Now re-derive the rule over every VO the job expired and require it to agree. This
      // is the part that would catch a rule that expires the right VOs for the wrong reason.
      const wrong: string[] = [];
      for (const l of discharge) {
        const vo = await sa.voById(P.idFromIri(l.prescriptionIri));
        const firstBeh = await sa.firstTreatmentDate(vo.id);
        // The VO is closed now, so the oracle is asked what it would have decided while the
        // VO was still open.
        const open = { ...vo, treatmentStatus: 'Aktiv' };
        const verdict = P.expectedExpiry(open, firstBeh, TODAY);
        const actual = P.kindOf(l.reason);
        if (!verdict) wrong.push(`${vo.prescriptionId}: rule says stays open, job expired it (${actual})`);
        else if (verdict.kind !== actual) wrong.push(`${vo.prescriptionId}: rule says ${verdict.kind}, job wrote ${actual}`);
      }
      console.log(`  ${discharge.length} expiries re-derived, ${wrong.length} disagreements`);
      for (const w of wrong) console.log(`    ${w}`);
      expect(wrong, 'the ported rule agrees with every expiry the job made').toHaveLength(0);
    },
  );
  test(
    'the derived population is exact, and no discharge VO is left open past its window',
    { tag: ['@SuperAdmin', '@DischargeExpiry', '@ReadOnly', '@Slow'] },
    async () => {
      // `isDischargeManagement` cannot be filtered on (test 1), so the population is derived
      // from the window: only the discharge rule puts the start deadline exactly 7 days after
      // issue. That detector is VALIDATED here rather than assumed — every VO it selects must
      // actually carry the flag, or the walks built on it are selecting the wrong rows.
      // The walk is CAPPED, so this is a bounded sample of the window and not a census —
      // which is enough for both claims here (the detector's precision, and no overdue
      // survivor among the rows seen), but the cap is printed so nobody reads it as one.
      const total = await sa.voCount('date%5Bafter%5D=2026-06-01&date%5Bbefore%5D=2026-09-15');
      const all = await sa.voWalk('2026-06-01', '2026-09-15');
      const derived = all.filter((v) => P.looksLikeDischargeWindow(v));
      const flagged = derived.filter((v) => v.isDischargeManagement === true);
      console.log(`  walked ${all.length} of ${total} VOs issued 2026-06-01..09-15 (page-capped); startDl == issue+7: ${derived.length}`);
      console.log(`  of those, isDischargeManagement true: ${flagged.length}`);
      expect(derived.length, 'the detector finds some').toBeGreaterThan(0);
      expect(flagged.length, 'and every one it finds really is a discharge VO').toBe(derived.length);

      // The catch-up invariant, in the durable form (#3709): a flat "nothing is overdue" is
      // the right assertion only because the job has already run twice since the fix, and
      // every VO in this window closed its 12 days well before the first run.
      const OPEN = ['Aktiv', 'Pending', 'Bereit', 'For Review', 'Sent Back to Therapist'];
      const overdue = derived.filter(
        (v) => OPEN.includes(v.treatmentStatus ?? '') && v.validityDate && v.validityDate.slice(0, 10) < TODAY,
      );
      const byStatus = derived.reduce<Record<string, number>>((a, v) => {
        const k = v.treatmentStatus ?? 'none';
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  statuses: ${JSON.stringify(byStatus)}`);
      console.log(`  still OPEN past their 12-day window: ${overdue.length}`);
      for (const v of overdue) {
        console.log(`    ${v.prescriptionId} ${v.treatmentStatus} issued ${v.date.slice(0, 10)} window to ${v.validityDate?.slice(0, 10)}`);
      }
      expect(overdue, 'the discharge backlog is clear').toHaveLength(0);
    },
  );
});
