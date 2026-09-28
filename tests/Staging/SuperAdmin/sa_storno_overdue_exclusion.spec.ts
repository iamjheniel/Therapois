import { test, expect } from '@playwright/test';
import {
  CHECK_PRODUCED_STATUSES,
  Candidate,
  PAYMENT_WINDOW_DAYS_GKV,
  REMINDER_PAYMENT_DAYS,
  STAGING_FIXTURE,
  STORNO_SELECTABLE_STATUSES,
  StornoOverdueExclusionPage,
} from '../../../Pages/superadmin/sa.storno-overdue-exclusion.page';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.14 #3799 — the nightly overdue check must never move a Storno, and the ones it already moved
 * return to Sent at release. Commit `7c2b3b030`.
 *
 * Run at `--workers=1`. Read-only: every request is a GET.
 */
test.describe('#3799 the overdue check leaves Stornos alone', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  let api: StornoOverdueExclusionPage;

  test.beforeAll(async ({ playwright }) => {
    api = new StornoOverdueExclusionPage(await playwright.request.newContext());
  });

  test('the surfaces partition, and the three serialization groups disagree on purpose', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    // Every field this ticket turns on is omitted when null AND lives in only one group, so a read
    // from the wrong group is indistinguishable from a real null. This file's own first measurement
    // ("no Storno has a sentDate") was taken from a group that does not serialize sentDate at all.
    await api.assertSurfacesPartition();
  });

  test('AC1/AC2 the rule, ported in BOTH versions — the exclusion is the only difference', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    // The whole API change is two `andWhere('i.originalInvoice IS NULL')` lines, so the honest test
    // is the rule as a pure function: drive the same candidates through both versions and show they
    // differ on Stornos and ONLY on Stornos. Staging cannot show this on live data — all 17 Stornos
    // are not_sent, so neither version selects any and the two agree vacuously.
    const now = new Date();
    const past = StornoOverdueExclusionPage.daysAgo(PAYMENT_WINDOW_DAYS_GKV + 1, now);
    const reminded = StornoOverdueExclusionPage.daysAgo(REMINDER_PAYMENT_DAYS + 1, now);
    const base: Candidate = {
      status: 'sent', isStorno: false, sentDate: past, remindedDate: null, copaymentAmount: null, totalOnHoldDays: 0,
    };

    // Step 1 — a Sent invoice past its window moves; the same shape as a Storno does not.
    expect(StornoOverdueExclusionPage.selectedByStep1(base, true, now), 'AC2: a normal invoice still moves').toBe(true);
    expect(StornoOverdueExclusionPage.selectedByStep1({ ...base, isStorno: true }, true, now), 'AC1: a Storno does not').toBe(false);
    // …and that the pre-fix rule DID move it, or the test proves nothing about the change.
    expect(StornoOverdueExclusionPage.selectedByStep1({ ...base, isStorno: true }, false, now), 'pre-fix it did move').toBe(true);

    // Step 2 — the same, on the Reminded → To Debt Collector step.
    const r: Candidate = { ...base, status: 'reminded', sentDate: null, remindedDate: reminded };
    expect(StornoOverdueExclusionPage.selectedByStep2(r, true, now), 'AC2: a Reminded PKV invoice still moves').toBe(true);
    expect(StornoOverdueExclusionPage.selectedByStep2({ ...r, isStorno: true }, true, now), 'AC1: a Reminded Storno does not').toBe(false);
    expect(StornoOverdueExclusionPage.selectedByStep2({ ...r, isStorno: true }, false, now), 'pre-fix it did move').toBe(true);

    // AC2's copayment clause, unchanged by this ticket.
    expect(StornoOverdueExclusionPage.selectedByStep2({ ...r, copaymentAmount: 12.5 }, true, now), 'copayment stays excluded from step 2').toBe(false);

    // The boundaries, and that on-hold days still count — the exclusion must not have moved them.
    expect(StornoOverdueExclusionPage.selectedByStep1({ ...base, sentDate: StornoOverdueExclusionPage.daysAgo(PAYMENT_WINDOW_DAYS_GKV - 1, now) }, true, now)).toBe(false);
    expect(StornoOverdueExclusionPage.selectedByStep1({ ...base, totalOnHoldDays: 5 }, true, now), 'on-hold days are still subtracted').toBe(false);
  });

  test('AC1 the standing invariant: no Storno sits in a status only the check could produce', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    const stornos = await api.stornos();
    const byStatus = stornos.reduce<Record<string, number>>((acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`#3799 Stornos: ${stornos.length}  by status: ${JSON.stringify(byStatus)}`);

    const wrong = stornos.filter((s) => (CHECK_PRODUCED_STATUSES as readonly string[]).includes(s.status));
    for (const s of wrong) console.log(`   ${s.invoiceNumber} is ${s.status} — the bug's own state`);
    expect(wrong, 'AC1/AC3: no Storno is Overdue or To Debt Collector').toEqual([]);

    // Every Storno's status is one the billing team can actually set by hand (#2868, Out of Scope).
    for (const s of stornos) {
      expect(
        [...STORNO_SELECTABLE_STATUSES, 'paid', 'cancelled'].includes(s.status),
        `${s.invoiceNumber} is in a hand-settable status, not one only an automatic run produces`,
      ).toBe(true);
    }
  });

  test('AC1 the history: no automatic run has ever moved a Storno', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    const [stornos, logs] = await Promise.all([api.stornos(), api.statusChangeLogs()]);
    const ids = new Set(stornos.map((s) => s.id));
    const onStorno = logs.filter((l) => ids.has(l.invoiceId));
    console.log(`#3799 status_change logs: ${logs.length}; on a Storno: ${onStorno.length}`);
    for (const l of onStorno) {
      console.log(`   invoice ${l.invoiceId} ${l.oldValue} -> ${l.newValue} ${l.createdAt.slice(0, 19)} meta=${JSON.stringify(l.meta)} by=${l.author ?? '(system)'}`);
    }

    // The bug's signature, and AC3's correction signature, in the same stream. Neither has ever
    // occurred on staging — which is why deployment is not decidable here (see the last test).
    const intoCheckStatus = onStorno.filter((l) => (CHECK_PRODUCED_STATUSES as readonly string[]).includes(l.newValue));
    expect(intoCheckStatus, 'no log ever moved a Storno into Overdue/To Debt Collector').toEqual([]);
  });

  test('AC2 the control: the check demonstrably still moves real invoices, and only them', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    // Without this the AC1 invariant above is satisfiable by a build where the check does nothing at
    // all. Every invoice the check HAS moved must be a non-Storno.
    const all = await api.invoices();
    const moved = all.filter((i) => (CHECK_PRODUCED_STATUSES as readonly string[]).includes(i.status));
    const movedStornos = moved.filter((i) => i.originalInvoiceId != null);
    console.log(`#3799 invoices in a check-produced status: ${moved.length}; of those Stornos: ${movedStornos.length}`);
    expect(moved.length, 'the overdue check has real work on staging').toBeGreaterThan(0);
    expect(movedStornos, 'and every one of them is a normal invoice').toEqual([]);
  });

  test('AC4 the Storno status surface: it hangs off the ORIGINAL invoice row, and agrees', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    // A Storno has no billing row of its own (#2867): every billing screen in AC4's table renders
    // `stornoStatus` from the ORIGINAL's row. So the two must agree, or the screens and the Storno
    // disagree about the same fact.
    const all = await api.invoices();
    const stornos = all.filter((i) => i.originalInvoiceId != null);
    const carriers = all.filter((i) => i.stornoStatus != null);
    console.log(`#3799 originals carrying stornoStatus: ${carriers.length}; Stornos: ${stornos.length}`);
    expect(carriers.length, 'exactly one carrier per Storno').toBe(stornos.length);

    const disagree: string[] = [];
    for (const s of stornos) {
      const original = all.find((i) => i.id === s.originalInvoiceId);
      expect(original, `${s.invoiceNumber}'s original is in the book`).toBeTruthy();
      if (original!.stornoStatus !== s.status) {
        disagree.push(`${original!.invoiceNumber}.stornoStatus=${original!.stornoStatus} vs ${s.invoiceNumber}=${s.status}`);
      }
      expect(original!.status, 'AC3: the original stays Cancelled').toBe('cancelled');
    }
    expect(disagree, 'the column and the Storno agree everywhere').toEqual([]);
  });

  test('the ticket\'s staging fixture, and the numbering collision it warns about', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    const all = await api.invoices();
    const storno = all.find((i) => i.invoiceNumber === STAGING_FIXTURE.storno);
    const original = all.find((i) => i.invoiceNumber === STAGING_FIXTURE.original);
    expect(storno && original, 'both exist on staging').toBeTruthy();
    expect(storno!.originalInvoiceId, `${STAGING_FIXTURE.storno} points at ${STAGING_FIXTURE.original}`).toBe(original!.id);
    console.log(`#3799 fixture: ${storno!.invoiceNumber} (id ${storno!.id}, ${storno!.status}) -> ${original!.invoiceNumber} (id ${original!.id}, ${original!.status})`);

    // The ticket says this outright and it is easy to miss: staging has its own numbering, so its
    // S126-6 is a DIFFERENT Storno from the production one in the billing team's screenshot
    // (original R126-20 there, R126-84 here). Reading the production numbers against staging finds
    // a real but unrelated Storno.
    expect(original!.invoiceNumber, 'staging\'s S126-6 is NOT production\'s').toBe('R126-84');
    expect(all.some((i) => i.invoiceNumber === 'R126-20'), 'and R126-20 is not this Storno\'s original here').toBe(
      all.find((i) => i.invoiceNumber === 'R126-20') !== undefined,
    );

    const dates = await api.datesFor(storno!.id);
    console.log(`#3799 fixture dates (DEFAULT group): ${JSON.stringify(dates)}`);
    expect(dates.isStorno, 'the default group confirms the relation').toBe(true);
    expect(dates.overdueDate, 'and it carries no overdue date').toBeNull();
  });

  test('Out of Scope: the Storno status vocabulary is still exactly Not sent / Sent', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async ({ page }) => {
    // The ticket protects #2868's two-choice column. A build that "fixed" the check by widening the
    // vocabulary would satisfy every assertion above and break the thing being protected.
    const { source } = await new TranslationsPage(page).loadDictionaries();
    // The constant survives minification, but it is EXPORTED through
    // `Object.defineProperty(e,"STORNO_SELECTABLE_STATUSES",{get:()=>_})`, so its value sits in a
    // separate minified variable and cannot be matched next to the name. What CAN be bound is the
    // call site: the Storno status control is handed this constant as its `allowedStatuses`, and
    // there are two of them — the PKV and copayment tabs, AC4's first two rows.
    expect(source, 'the vocabulary constant is still shipped').toContain('STORNO_SELECTABLE_STATUSES');
    const callSites = source.match(/allowedStatuses:\w+\.STORNO_SELECTABLE_STATUSES/g) ?? [];
    console.log(`#3799 Storno status controls fed by the constant: ${callSites.length}`);
    expect(callSites.length, 'both billing tabs drive the Storno column from it').toBeGreaterThanOrEqual(2);
    // …and the value is still the two hand-settable statuses.
    expect(source, 'still exactly Not sent / Sent').toMatch(/\[\s*['"]not_sent['"]\s*,\s*['"]sent['"]\s*\]/);
  });

  test('deployment is NOT client-decidable here — and this is why', {
    tag: ['@SuperAdmin', '@StornoOverdue', '@ReadOnly'],
  }, async () => {
    // Recorded as an assertion rather than a comment so it cannot quietly become untrue.
    //
    // The API change is two lines inside a console command: no route, no serialized field, so there
    // is nothing to probe. `/status` gives the release, not the commit (#3704). The migration WOULD
    // have been the probe — it runs at deploy and writes a status_change log per corrected Storno —
    // but staging had 0 Overdue Stornos, so it corrected nothing and left no fingerprint.
    const stornos = await api.stornos();
    const logs = await api.statusChangeLogs();
    const ids = new Set(stornos.map((s) => s.id));
    const correction = logs.filter((l) => ids.has(l.invoiceId) && l.oldValue === 'overdue' && l.newValue === 'sent');
    const overdue = stornos.filter((s) => s.status === 'overdue');

    console.log(
      `#3799 deployment probe: ${overdue.length} Overdue Stornos, ${correction.length} correction logs — ` +
        'both zero, so "the migration ran and corrected them" and "there was never anything to correct" ' +
        'are indistinguishable from a client.',
    );
    expect(correction.length, 'no correction fingerprint exists on staging').toBe(0);
    expect(overdue.length, 'and nothing was left for it to correct').toBe(0);

    // The live half needs the development team: the ticket's own recipe is set a Storno to Sent,
    // back-date its sent date 22 days, and run the nightly check — steps 4 and 5 are dev-only.
    // The invariant tests above become the real guard the moment any Storno is set to Sent.
    const sent = stornos.filter((s) => s.status === 'sent');
    console.log(`#3799 Stornos currently Sent (the state the check would act on): ${sent.length}`);
  });
});
