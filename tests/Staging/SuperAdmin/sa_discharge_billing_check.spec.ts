import { test, expect } from '@playwright/test';
import {
  BILLING_CHECK,
  CREATION_CHECK,
  DischargeBillingCheckPage,
  addDays,
  checkApplies,
  de,
  expectedNote,
  expectedPassed,
  outsideWindow,
  type Session,
  type Validation,
  type Vo,
} from '../../../Pages/superadmin/sa.discharge-billing-check.page';

/**
 * RC 3.15 #3808 — "Entlassmanagement-Timing" on the billing validation page.
 *
 * Shipped as `a0b961b4cbb` (PR #3861). Mostly READ-ONLY: the registry, the fixtures, their
 * sessions and their stored verdicts all answer without a write, because the PM ran the checks on
 * 4 Oct and a stored verdict is the engine's own answer.
 *
 * ONE test writes, and only to drive AC5, which is about writes by definition. It is bounded and
 * SELF-RESTORING: the manual Pass is undone by the Re-check that AC5 asks for, and the marker is
 * put back with a second Re-check in a `finally`. Every VO it touches is a QA fixture (1000xx).
 */

const FIXTURES = {
  // AC3's six rows, all issued 01.09.2026 → day 7 = 08.09, day 12 = 13.09.
  ac3: [
    ['100017-1', 'sessions 2, 5, 8 Sep', true],
    ['100018-1', 'sessions 2, 13 Sep — 13 Sep IS day 12', true],
    ['100019-1', 'sessions 2, 14 Sep', false],
    ['100021-1', 'sessions 3, 15, 20 Sep', false],
    ['100022-1', 'sessions 8, 10 Sep — 8 Sep IS day 7', true],
    ['100023-1', 'sessions 9, 11 Sep — first session after day 7', false],
  ] as [string, string, boolean][],
  // AC2's session-counting rule.
  counting: [
    ['100024-1', 'a planned session on day 19 does not count', true],
    ['100025-1', 'a refusal WITHOUT signature on day 19 does not count', true],
    ['100026-1', 'a refusal WITH signature on day 19 DOES count', false],
    ['100027-1', 'only a planned session — no carried-out session at all', true],
  ] as [string, string, boolean][],
  // AC1's applicability table.
  applicability: [
    // AC1 row 2: GKV but NOT marked Entlassmanagement — the check runs and passes, because there
    // is nothing to check. That is why this one's marker is false while the other four are true.
    ['100028-1', 'public', false, true],
    ['100029-1', 'privat_basis', true, null],
    ['100030-1', 'private', true, null],
    ['100031-1', 'accident', true, null],
    ['100038-1', null, true, null],
  ] as [string, string | null, boolean, boolean | null][],
  withDischargeDate: '100037-1',
  outOfOrder: '100032-1',
  named: '9489-1',
  /** AC5 is driven here — it fails, so there is something to Pass. */
  acknowledge: '100019-1',
};

const ALL = [
  ...FIXTURES.ac3.map((f) => f[0]),
  ...FIXTURES.counting.map((f) => f[0]),
  ...FIXTURES.applicability.map((f) => f[0]),
  FIXTURES.withDischargeDate,
  FIXTURES.outOfOrder,
  FIXTURES.named,
];

test.describe('#3808 Entlassmanagement-Timing on the billing validation', () => {
  test.describe.configure({ mode: 'serial' });

  let api: DischargeBillingCheckPage;
  let checks: Validation[];
  let vos: Map<string, Vo>;
  let sessions: Map<number, Session[]>;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(400_000);
    api = new DischargeBillingCheckPage(await playwright.request.newContext());
    checks = await api.validations();
    const list = await api.vosByNumber(ALL);
    vos = new Map(list.map((v) => [v.number, v]));
    sessions = await api.sessionsByVo(list.map((v) => v.id));
    console.log(`[#3808] ${checks.length} registered checks; ${vos.size}/${ALL.length} fixtures resolved`);
  });

  test('DEPLOYED — a new billing-timing row, separate from the creation one', async () => {
    const billing = checks.find((c) => c.description === BILLING_CHECK);
    const creation = checks.find((c) => c.description === CREATION_CHECK);
    console.log('[#3808] billing row :', JSON.stringify(billing));
    console.log('[#3808] creation row:', JSON.stringify(creation));

    // A `timing: billing` discharge row could not exist before this ticket.
    expect(billing, `${BILLING_CHECK} must be registered`).toBeTruthy();
    expect(billing!.timing).toBe('billing');
    // AC1: like "Unterbrechung maximal 14 Tage" — severity error, group Zeit.
    expect(billing!.severity).toBe('error');
    expect(billing!.category).toBe('time');
    // GKV only — Privat Basis stays off per #3708 AC3.
    expect(billing!.insuranceTypes).toEqual(['public']);

    // The creation check is explicitly left alone (Out of Scope).
    expect(creation, 'the creation row must survive').toBeTruthy();
    expect(creation!.timing).toBe('vo_creation');

    // A SEPARATE description shipped rather than a second row under the creation key. The
    // Developer Reference warned that older migrations update by description alone, so two rows
    // sharing one would both be hit; this is the safer choice and worth pinning.
    expect(billing!.description).not.toBe(creation!.description);
    expect(checks.filter((c) => c.description === BILLING_CHECK)).toHaveLength(1);

    // And the billing row covers Blanko where the creation row does not — the rule applies to
    // every VO kind marked Entlassmanagement, as the RC 3.14 expiry rule does.
    console.log(`[#3808] VO kinds — billing ${JSON.stringify(billing!.voKinds)} vs creation ${JSON.stringify(creation!.voKinds)}`);
    expect(billing!.voKinds).toContain('blanko');
    expect(creation!.voKinds).not.toContain('blanko');

    // It sits in the Zeit group beside the check AC1 says it behaves like.
    const zeit = checks.filter((c) => c.timing === 'billing' && c.category === 'time').map((c) => c.description);
    expect(zeit).toContain('interruption_max_14_days');
    expect(zeit).toContain(BILLING_CHECK);
  });

  test('the verdict filter — `prescription=` narrows, `prescription.id=` is silently ignored', async () => {
    const vo = vos.get(FIXTURES.ac3[2][0])!;
    const t = await api.verdictFilterTotals(vo.id);
    console.log(`[#3808] verdicts for ${vo.number}: prescription= -> ${t.scoped}, prescription.id= -> ${t.ignored}`);
    expect(t.scoped).toBeGreaterThan(0);
    // The ignored form returns an unfiltered page, so every VO looks like it carries a hundred
    // verdicts belonging to other VOs.
    expect(t.ignored).toBeGreaterThan(t.scoped);
  });

  test('AC3 — the truth table, each row against the stored verdict', async () => {
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    for (const [number, label, shouldPass] of FIXTURES.ac3) {
      const vo = vos.get(number);
      expect(vo, `${number} must exist`).toBeTruthy();
      const s = sessions.get(vo!.id) ?? [];
      // The fixture is re-derived before use, so one that has drifted fails loudly.
      expect(vo!.insuranceType, `${number} must be GKV`).toBe('public');
      expect(vo!.isDischargeManagement, `${number} must be marked`).toBe(true);

      const want = expectedPassed(vo!, s);
      const verdict = (await api.verdicts(vo!.id)).find((v) => v.validationId === billingId);
      expect(verdict, `${number} must carry a stored verdict — run the billing validation first`).toBeTruthy();
      console.log(
        `[#3808] ${number.padEnd(10)} ${label.padEnd(42)} stored=${verdict!.passed} expected=${want}`,
      );
      expect(want, `${number}: the ported rule must agree with the AC`).toBe(shouldPass);
      expect(verdict!.passed, `${number}: ${label}`).toBe(shouldPass);
    }
  });

  test('AC4 — the note names the issue date, day 7, day 12 and every out-of-window session', async () => {
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    let failing = 0;
    for (const number of [...FIXTURES.ac3.map((f) => f[0]), FIXTURES.outOfOrder, FIXTURES.withDischargeDate, FIXTURES.named]) {
      const vo = vos.get(number);
      if (!vo) continue;
      const s = sessions.get(vo.id) ?? [];
      const verdict = (await api.verdicts(vo.id)).find((v) => v.validationId === billingId);
      if (!verdict) continue;
      const want = expectedNote(vo.issueDate, s);
      if (want) failing++;
      console.log(`[#3808] ${number.padEnd(10)} note: ${verdict.autoNote ?? '(none)'}`);
      // Rebuilt independently, so a check that flags the right VOs but names the wrong dates
      // still fails.
      expect(verdict.autoNote ?? null, `${number}`).toBe(want);
      // A passing check carries no note at all — the field is omitted, not empty.
      if (!want) expect(verdict.autoNote).toBeNull();
    }
    expect(failing, 'at least one failing note must be compared').toBeGreaterThan(0);

    // The order the sessions were entered must not leak into the note (100032-1 was entered
    // 20, 02, 14 Sep).
    const oo = vos.get(FIXTURES.outOfOrder)!;
    const note = (await api.verdicts(oo.id)).find((v) => v.validationId === billingId)!.autoNote!;
    expect(note).toContain(`${de('2026-09-14')}, ${de('2026-09-20')}`);

    // AC1: a discharge date changes nothing — 100037-1 is 100019-1 plus one.
    const withDate = vos.get(FIXTURES.withDischargeDate)!;
    expect(withDate.dischargeDate, 'the fixture must actually carry a discharge date').toBeTruthy();
    const a = (await api.verdicts(withDate.id)).find((v) => v.validationId === billingId)!;
    const b = (await api.verdicts(vos.get('100019-1')!.id)).find((v) => v.validationId === billingId)!;
    expect(a.passed).toBe(b.passed);
    expect(a.autoNote).toBe(b.autoNote);
  });

  test('AC2 — how a session counts: planned, refused with and without a signature', async () => {
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    for (const [number, label, shouldPass] of FIXTURES.counting) {
      const vo = vos.get(number)!;
      const s = sessions.get(vo.id) ?? [];
      const verdict = (await api.verdicts(vo.id)).find((v) => v.validationId === billingId);
      console.log(
        `[#3808] ${number.padEnd(10)} ${label.padEnd(50)} sessions=${JSON.stringify(s.map((x) => `${x.date}${x.planned ? '[P]' : ''}${x.rejected ? (x.signed ? '[R+]' : '[R-]') : ''}${x.counts ? '' : '(x)'}`))} -> ${verdict?.passed}`,
      );
      expect(verdict?.passed, `${number}: ${label}`).toBe(shouldPass);
      expect(expectedPassed(vo, s)).toBe(shouldPass);
    }

    // The three edge fixtures must genuinely differ, or the rule is untested: the SAME extra
    // session date (20 Sep, outside the window) passes when planned or refused-unsigned and
    // fails when refused-signed.
    const dates = FIXTURES.counting.slice(0, 3).map((f) => sessions.get(vos.get(f[0])!.id)!.at(-1)!.date);
    expect(new Set(dates).size, 'the three edge fixtures must share the out-of-window date').toBe(1);
  });

  test('AC1 — the check runs for GKV only', async () => {
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    for (const [number, ins, marked, want] of FIXTURES.applicability) {
      const vo = vos.get(number)!;
      expect(vo.insuranceType, `${number}`).toBe(ins);
      expect(vo.isDischargeManagement, `${number} marker`).toBe(marked);
      const verdict = (await api.verdicts(vo.id)).find((v) => v.validationId === billingId);
      const got = verdict ? verdict.passed : null;
      console.log(`[#3808] ${number.padEnd(10)} ins=${String(ins)} marked=${marked} -> ${got === null ? 'no verdict (check does not run)' : got}`);
      expect(checkApplies(vo), `${number} applicability`).toBe(ins === 'public');
      expect(got, `${number}`).toBe(want);
    }
  });

  test('the rule as a pure function, at both boundaries', async () => {
    const issue = '2026-09-01';
    const S = (dates: string[]): Session[] =>
      dates.map((d) => ({ date: d, counts: true, planned: false, rejected: false, signed: false }));
    expect(addDays(issue, 7)).toBe('2026-09-08');
    expect(addDays(issue, 12)).toBe('2026-09-13');

    // Day 7 and day 12 are both INCLUSIVE.
    expect(outsideWindow(issue, S(['2026-09-08', '2026-09-10']))).toEqual([]);
    expect(outsideWindow(issue, S(['2026-09-09']))).toEqual(['2026-09-09']);
    expect(outsideWindow(issue, S(['2026-09-02', '2026-09-13']))).toEqual([]);
    expect(outsideWindow(issue, S(['2026-09-02', '2026-09-14']))).toEqual(['2026-09-14']);

    // A late start invalidates the VO, so EVERY session is outside — including ones inside the
    // 12-day period, which is the half a naive "after day 12" rule gets wrong.
    expect(outsideWindow(issue, S(['2026-09-09', '2026-09-11']))).toEqual(['2026-09-09', '2026-09-11']);

    // No counting session at all -> the check passes.
    expect(outsideWindow(issue, [])).toEqual([]);
    expect(outsideWindow(issue, [{ date: '2026-09-20', counts: false, planned: true, rejected: false, signed: false }])).toEqual([]);

    // The note's shape, including the trailing full stop.
    expect(expectedNote(issue, S(['2026-09-02', '2026-09-14']))).toBe(
      'Entlassmanagement: Behandlungen außerhalb des Zeitraums ' +
        '(Ausstellung: 01.09.2026, Beginn bis: 08.09.2026, Ende: 13.09.2026): 14.09.2026.',
    );
    expect(expectedNote(issue, S(['2026-09-02']))).toBeNull();
  });

  test('AC5 — manual Pass, then Re-check replaces it, then the marker removal (self-restoring)', async () => {
    test.setTimeout(400_000);
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    const vo = vos.get(FIXTURES.acknowledge)!;
    const read = async () => (await api.verdicts(vo.id)).find((v) => v.validationId === billingId)!;

    const before = await read();
    console.log(`[#3808] start: passed=${before.passed} note=${before.autoNote ? 'yes' : 'no'}`);
    expect(before.passed, 'AC5 needs a FAILING check to acknowledge').toBe(false);
    expect(before.autoNote).toBeTruthy();

    try {
      // Row 1: the manual Pass counts as passed.
      expect(await api.setPassed(before.id, true)).toBe(200);
      const passed = await read();
      console.log(`[#3808] after Pass: passed=${passed.passed}`);
      expect(passed.passed).toBe(true);
      // The row is updated in place rather than replaced, so the note survives the Pass.
      expect(passed.id).toBe(before.id);

      // Row 2: Re-check replaces the manual Pass with the automatic result.
      const re = await api.recheck(vo.id);
      console.log(`[#3808] re-check: status=${re.status} checked=${re.checked}`);
      expect(re.status).toBe(200);
      expect(re.checked).toBeGreaterThan(0);
      const back = await read();
      console.log(`[#3808] after re-check: passed=${back.passed} note=${back.autoNote ? 'yes' : 'no'}`);
      expect(back.passed, 'the automatic result must replace the manual Pass').toBe(false);
      expect(back.autoNote).toBe(before.autoNote);

      // Row 3: removing the Entlassmanagement marker makes the check pass.
      expect(await api.setDischargeMarker(vo.id, false)).toBe(200);
      expect(await api.marker(vo.id)).toBe(false);
      expect((await api.recheck(vo.id)).status).toBe(200);
      const unmarked = await read();
      console.log(`[#3808] marker removed -> passed=${unmarked.passed} note=${unmarked.autoNote ?? '(none)'}`);
      expect(unmarked.passed).toBe(true);
      expect(unmarked.autoNote).toBeNull();
    } finally {
      // Put the VO back exactly as found. The re-check is what restores the verdict, so the
      // whole sequence is self-undoing by construction.
      await api.setDischargeMarker(vo.id, true);
      await api.recheck(vo.id);
      const end = await read();
      console.log(`[#3808] restored: marker=${await api.marker(vo.id)} passed=${end.passed} note=${end.autoNote ? 'yes' : 'no'}`);
      expect(end.passed).toBe(before.passed);
      expect(end.autoNote).toBe(before.autoNote);
    }
  });

  test('FINDING — the ticket\'s own example note for VO 9489-1 is stale', async () => {
    const billingId = checks.find((c) => c.description === BILLING_CHECK)!.id;
    const vo = vos.get(FIXTURES.named)!;
    const s = sessions.get(vo.id) ?? [];
    const verdict = (await api.verdicts(vo.id)).find((v) => v.validationId === billingId)!;
    const counting = s.filter((x) => x.counts).map((x) => x.date);
    console.log(`[#3808] 9489-1 issued ${vo.issueDate}, counting sessions: ${JSON.stringify(counting)}`);
    console.log(`[#3808] note: ${verdict.autoNote}`);

    // The note is correct for the data that is there …
    expect(verdict.autoNote).toBe(expectedNote(vo.issueDate, s));
    expect(verdict.passed).toBe(false);

    // … but the Localization Reference's worked example lists SIX dates (17.07, 20.07, 24.07,
    // 27.07, 31.07, 03.08) and staging now holds fewer, so a QA comparing the note against the
    // ticket literally sees a mismatch that is not one. The example describes a 23 Sep snapshot.
    const ticketDates = ['17.07.2026', '20.07.2026', '24.07.2026', '27.07.2026', '31.07.2026', '03.08.2026'];
    const present = ticketDates.filter((d) => verdict.autoNote!.includes(d));
    console.log(`[#3808] of the ticket's ${ticketDates.length} example dates, ${present.length} are still on the VO: ${JSON.stringify(present)}`);
    if (present.length < ticketDates.length) {
      console.log(
        `[#3808] FINDING: the Localization Reference's example for 9489-1 is stale — it lists ` +
          `${ticketDates.length} session dates and the VO now has ${counting.length}. The note ` +
          `follows the data correctly; the example does not.`,
      );
    }
  });
});
