import { test, expect } from '../../fixtures/session';
import { CODE_SHAPE, RefusalReasonsPage } from '../../../Pages/superadmin/sa.refusal-reasons.page';

/**
 * RC 3.15 #3899 + #3908 — two defects from the 2026-10-01 Sentry triage, both "a refusal that
 * does not say why". Tested together because they share one shipped helper module
 * (`violationDigest` / `detailOf`) and one theme.
 *
 * #3899 shipped as `d2e9511456a` + `582f91a9b00`; #3908 as `0980fe59cbb`.
 *
 * READ-ONLY IN EFFECT. One test POSTs an activity, and it is aimed at a VO that has already used
 * every prescribed treatment — so the only correct outcome is a 422 and a passing run creates
 * nothing. That is the same reasoning #3549 and #3869 use: a write whose refusal IS the assertion.
 */

test.describe('#3899 + #3908 a refusal must name its reason', () => {
  test.describe.configure({ mode: 'serial' });

  let p: RefusalReasonsPage;

  test.beforeAll(async ({ playwright }) => {
    p = new RefusalReasonsPage(await playwright.request.newContext());
  });

  test('#3899 AC1 — a refused activity save carries a stable, identifier-shaped code', async () => {
    test.setTimeout(300_000);
    const vo = await p.voAtMaxTreatments();
    expect(vo, 'need a VO at its treatment maximum, whose save must be refused').toBeTruthy();
    console.log(`[#3899] using ${vo!.number} (id ${vo!.id}), therapist ${vo!.therapistId}`);

    const r = await p.attemptActivity(vo!.id, vo!.therapistId, new Date().toISOString().slice(0, 10));
    console.log(`[#3899] POST /activities/bulk -> ${r.status}`);
    console.log(`[#3899] violations: ${JSON.stringify(r.violations)}`);

    expect(r.status, 'the save must be refused — a 2xx would mean this test created an Activity').toBe(422);
    expect(r.violations.length).toBeGreaterThan(0);

    const v = r.violations[0];
    // The ambiguity the ticket is about: five rules all report on this one path …
    expect(v.propertyPath).toBe('prescription');
    // … so the code is what now tells them apart.
    expect(v.code, 'the violation must carry a code').toBeTruthy();
    expect(v.code!, `code ${v.code} must be identifier-shaped`).toMatch(CODE_SHAPE);
    expect(v.code).toBe('ACTIVITY_MAX_TREATMENTS_REACHED');
    // The code names the RULE, not the message — asserted apart, because a code equal to the
    // message would satisfy "carries a code" while solving nothing.
    expect(v.code).not.toBe(v.message);
    expect(v.message, 'the message is still there for the user').toBeTruthy();
  });

  test('#3899 AC2/AC3 — the Sentry digest sends codes, never messages or values', async () => {
    const digest = await p.context('e.violationDigest=function', 120, 520);
    expect(digest, 'violationDigest must be in the served bundle').toBeTruthy();
    console.log(`[#3899] violationDigest: ${digest}`);

    // AC2: the digest carries the codes …
    expect(digest!).toContain('violationCodes');
    expect(digest!).toContain('violationCount');
    expect(digest!).toContain('violationFields');
    // … and still only ever reads propertyPath and code off a violation.
    expect(digest!).toContain('propertyPath');
    expect(digest!).not.toContain('.message');
    expect(digest!).not.toContain('.value');

    // AC3: a code that is not identifier-shaped is dropped before it reaches Sentry. The filter
    // is the regex itself, which ships verbatim.
    expect(digest!).toMatch(/filter\(.*test\(/);
    expect(await p.occurrences('/^[A-Za-z0-9_-]{1,64}$/'), 'the shape filter must ship').toBeGreaterThan(0);
    // Driven over the cases it exists to separate.
    for (const ok of ['ACTIVITY_MAX_TREATMENTS_REACHED', 'vo_deleted', 'A', 'a-b_c']) {
      expect(CODE_SHAPE.test(ok), ok).toBe(true);
    }
    for (const bad of ['', 'has space', 'Patient Müller', 'x'.repeat(65), 'VO 1234-5 abgelaufen']) {
      expect(CODE_SHAPE.test(bad), JSON.stringify(bad)).toBe(false);
    }

    // And the key survives the scrubber: it is on the Sentry allowlist beside the two that were
    // already there, so the codes actually arrive rather than being redacted out.
    const allow = await p.context('ALLOWLIST_KEYS', 200, 900);
    expect(allow!).toContain('violationCodes');
    expect(allow!).toContain('violationFields');
    expect(allow!).toContain('violationCount');
  });

  test('#3908 AC1 — a Heilmittel already on the session is stopped before any request', async () => {
    const guard = await p.context("treatment_history.treatment_already_added", 300, 220);
    expect(guard, 'the guard must be in the served bundle').toBeTruthy();
    console.log(`[#3908] guard: ${guard}`);

    // The duplicate check runs BEFORE the POST — `some(...)` then the error toast, with the
    // request only in the `else` branch. That is AC1's "stopped before any request".
    expect(guard!).toMatch(/some\(/);
    expect(guard!).toContain('treatment?.id');
    expect(guard!).toMatch(/else/);

    // AC1 also asks for a translated message, DE and EN.
    const de = 'Dieses Heilmittel ist bereits in dieser Behandlung enthalten';
    const en = 'This Heilmittel is already on this treatment';
    console.log(`[#3908] DE x${await p.occurrences(de)} / EN x${await p.occurrences(en)}`);
    expect(await p.occurrences(de), 'the German string must ship').toBeGreaterThan(0);
    expect(await p.occurrences(en), 'the English string must ship').toBeGreaterThan(0);
    // It is a key, not a hardcoded literal — the #3611 failure mode.
    expect(await p.occurrences('treatment_already_added')).toBeGreaterThan(1);
  });

  test('#3908 AC2 — the bare "HTTP 422" toast is gone', async () => {
    // The string the ticket complains about does not occur anywhere in the served build.
    const bare = await p.occurrences('HTTP 422');
    console.log(`[#3908] "HTTP 422" occurrences in the bundle: ${bare}`);
    expect(bare).toBe(0);

    // The replacement path exists: `detailOf` reads the server's own reason off the body, and a
    // named failure string is there for when there is none.
    const detail = await p.context('e.detailOf=function', 60, 260);
    expect(detail, 'detailOf must ship').toBeTruthy();
    console.log(`[#3908] detailOf: ${detail}`);
    expect(detail!).toContain('detail');
    expect(detail!).toContain('hydra:description');
    for (const s of ['Heilmittel konnte nicht hinzugefügt werden', 'Heilmittel could not be added']) {
      expect(await p.occurrences(s), s).toBeGreaterThan(0);
    }

    // CONTROL: the escaping helper must be able to find a German string at all, or every count
    // above is zero for the wrong reason (#3337's trap, in the direction that fakes a pass).
    expect(await p.occurrences('Behandlung erfolgreich hinzugefügt')).toBeGreaterThan(0);
  });

  test('#3908 — what is NOT verifiable here: the DATEV payment-pull warning', async () => {
    // AC4 asks the nightly `app:datev:pull-payments` warning to carry the company id and both
    // counts. It is a CloudWatch/Sentry log line from a console command: no route, no serialized
    // field, nothing a client can read. AC5 is a repo-side unit test
    // (`LoggerContextKeyWhitelistTest`) and AC6 needs the first production run.
    //
    // Recorded rather than asserted, so the gap is visible in the run output.
    console.log(
      '[#3908] NOT COVERED: AC4 (the payment-pull warning\'s contents) is a console-command log ' +
        'line with no client surface; AC5 is a PHPUnit allowlist test; AC6 needs the first ' +
        'production nightly. See docs/manual-test-3899-3908-refusal-reasons.md.',
    );
    expect(true).toBe(true);
  });
});
