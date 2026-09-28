import { test, expect } from '@playwright/test';
import {
  DraftAutoCancelPage,
  AC5_TYPES,
  AUTO_CANCEL_NOTE,
  CLOSED_STATUSES,
  SYNCED_NON_DRAFT,
} from '../../../Pages/superadmin/sa.draft-auto-cancel.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.13 — a draft invoice with no billable sessions left is cancelled automatically (#3649).
 *
 * A draft (Not Sent, never DATEV-synced) used to sit at a stale amount once its VO ran out of
 * billable sessions; VO expiry did not even trigger a refresh. The fix cancels such a draft with
 * `SERVICE_NOT_RENDERED`, writes "cancelled automatically: no billable sessions left." to the
 * invoice log, creates **no** Storno and sends nothing to DATEV.
 *
 * **The state AC1 describes does not exist on staging, and that is this file's first result rather
 * than an excuse.** Re-deriving the shipped rule over every draft-tier invoice — 404 of them —
 * gives **zero** with no billable sessions left. So AC1's positive case cannot be observed here by
 * anyone without first destroying a session, and the PM's notes say exactly that ("destructive, not
 * performed"). What that leaves is not nothing: AC2, AC3, AC4 and AC5 are all decidable read-only
 * and at full scale, because each one is a statement about drafts that must **survive** — and 404
 * surviving drafts is a large sample of precisely that.
 *
 * **Every AC row in the PM's notes reads Surface: Code.** They are careful and honest about it, and
 * their reasoning is sound; the gap this file closes is that a code-only pass cannot distinguish
 * "the rule is right" from "the rule never runs here", and on this ticket the second is also true.
 *
 * **THE TRAP that makes the rule easy to re-derive wrongly.** "Delivered" is
 * `isDeliveredSession()`: NOT (rejected && !rejectedWithSignature) AND `treatmentType !== PLANNED`.
 * The second test is NEGATIVE, so a session whose `treatmentType` is **omitted from the payload
 * counts as delivered**. The PM's AC6 row states the rule as "activities with status done", and an
 * oracle written that way disagrees with the shipped rule on **28 of 404** VOs, in both directions:
 * it over-counts wherever a rejected-without-signature session carries `done` (harmless — it spares
 * a draft), and it UNDER-counts wherever `treatmentType` is omitted. Staging serves `done` 3,177
 * times, `planned` 10 times and **omits the field twice** — both omissions on VO 9634-5, which the
 * naive rule scores at **zero** delivered while the shipped rule scores 2, so its draft R126-118
 * presents as a stranded zero-session draft. It is not one, and that false positive is exactly what
 * the first pass of this work reported before the predicate was read from the source.
 *
 * **A gate in the code that appears in no AC:** cancellation also requires
 * `validationStatus === VALIDATED`. #3204 deliberately KEEPS a Not Sent draft when an admin resets
 * or sends back a VO's billing validation, so the reserved invoice number survives; cancelling in
 * that window would burn the number through a different door. One live draft sits in that state.
 *
 * **Read-only — every request is a GET.** Nothing here documents, deletes or cancels anything;
 * provoking AC1 would mean removing a real session's billability, and #3655 exists precisely
 * because an auto-cancelled draft cannot be re-invoiced by any supported route today.
 */

test.describe('#3649 a draft with no billable sessions left is cancelled automatically', () => {
  test.describe.configure({ mode: 'serial' });

  let auth: string;
  let drafts: Awaited<ReturnType<DraftAutoCancelPage['scoreDraftTier']>>;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(600_000);
    const response = await request.post('https://api.staging.therapios.de/auth', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
    });
    expect(response.ok(), 'POST /auth must succeed').toBe(true);
    auth = (await response.json()).token;

    // One sweep for the whole file: ~14 activity batches + ~11 VO batches. Re-reading it per test
    // would triple the load on two collections that answer slowly under parallel suite load.
    drafts = await new DraftAutoCancelPage(request, auth).scoreDraftTier();
    expect(drafts.length, 'staging must carry draft-tier invoices for any of this to mean anything').toBeGreaterThan(0);
  });

  test(
    'AC2 every draft that still has a billable session is left alone — at full scale',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async () => {
      // The positive half of the boundary. Each of these drafts has been through at least one
      // trigger since the fix shipped (they are all on VOs that are closed or archived), and the
      // rule left every one of them at its amount rather than cancelling it.
      const withSessions = drafts.filter((d) => (d.billableSessions ?? 0) > 0);
      console.log(
        `#3649 AC2: ${withSessions.length} of ${drafts.length} draft-tier invoices have >=1 billable session`,
      );
      expect(withSessions.length, 'the surviving-draft population is the sample AC2 is about').toBeGreaterThan(300);

      for (const d of withSessions) {
        expect(d.status, `${d.invoiceNumber}: a draft with billable sessions must stay Not Sent`).toBe('not_sent');
      }
      const counts = withSessions.map((d) => d.billableSessions!);
      console.log(`   billable-session counts: min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
    },
  );

  test(
    'AC4 a closed VO never loses its draft on status alone',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async () => {
      // AC4 is the rule's most load-bearing negative: the decision is the session count, never the
      // VO's status. Staging makes this a strong test almost by accident — nearly every draft sits
      // on a CLOSED VO, so if status leaked into the condition the draft book would be empty.
      const closed = drafts.filter((d) => CLOSED_STATUSES.includes(d.vo?.treatmentStatus ?? ''));
      const byStatus = new Map<string, number>();
      for (const d of closed) {
        const k = d.vo!.treatmentStatus!;
        byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
      }
      console.log(`#3649 AC4: ${closed.length} drafts on a CLOSED VO, all still Not Sent — ${JSON.stringify(Object.fromEntries(byStatus))}`);
      expect(closed.length, 'AC4 needs closed VOs carrying drafts').toBeGreaterThan(100);

      for (const d of closed) {
        expect(d.delivered, `${d.invoiceNumber} (VO ${d.prescriptionNumber}): kept, so it must have delivered sessions`).toBeGreaterThan(0);
        expect(d.status, `${d.invoiceNumber}: VO status ${d.vo!.treatmentStatus} must not cancel a draft`).toBe('not_sent');
      }
    },
  );

  test(
    'AC3 the one Not Sent invoice that DID reach DATEV is outside the draft tier',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async ({ request }) => {
      // isDraftTier() is `status === NOT_SENT && datevSyncedAt === null`, so the interesting row is
      // one where the two halves disagree. Staging has exactly one, and without it AC3 could only
      // be argued from code: every other Not Sent invoice satisfies both halves, so a build that
      // checked only the status would pass.
      const page = new DraftAutoCancelPage(request, auth);
      const book = await page.allInvoices();
      const notSent = book.filter((i) => i.status === 'not_sent');
      const synced = notSent.filter((i) => i.datevSyncStatus);
      const nonStornoSynced = synced.filter((i) => !i.invoiceNumber.startsWith('S'));

      console.log(
        `#3649 AC3: ${notSent.length} Not Sent invoices — ${synced.length} DATEV-synced ` +
          `(${synced.length - nonStornoSynced.length} Storno documents + ${nonStornoSynced.length} ordinary)`,
      );

      expect(nonStornoSynced.length, 'AC3 needs at least one Not Sent + synced invoice to discriminate').toBeGreaterThan(0);
      const fixture = nonStornoSynced.find((i) => i.invoiceNumber === SYNCED_NON_DRAFT.invoiceNumber);
      expect(fixture, `${SYNCED_NON_DRAFT.invoiceNumber} is the documented fixture`).toBeTruthy();
      console.log(
        `   ${fixture!.invoiceNumber} (VO ${fixture!.prescriptionNumber}) is Not Sent AND datevSyncStatus=${fixture!.datevSyncStatus}` +
          ` -> NOT draft tier, so the automatic rule must never touch it`,
      );

      // It is outside the tier, so it must not have been cancelled — and it must not appear in the
      // set this file derives as governed by the rule.
      expect(fixture!.status, 'the synced invoice is untouched by the automatic rule').toBe('not_sent');
      expect(
        drafts.some((d) => d.invoiceNumber === fixture!.invoiceNumber),
        'a synced invoice must be excluded from the draft tier this ticket governs',
      ).toBe(false);
    },
  );

  test(
    'AC5 all three invoiced tariff types are present in the governed population',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async () => {
      // AC5 asks for identical treatment across copayment, PKV and Privat Basis. The claim is only
      // meaningful if all three actually carry drafts here, which is measured rather than assumed.
      const byType = new Map<string, number>();
      for (const d of drafts) {
        const k = d.vo?.insuranceType ?? 'unknown';
        byType.set(k, (byType.get(k) ?? 0) + 1);
      }
      console.log(`#3649 AC5: draft-tier population by insurance type — ${JSON.stringify(Object.fromEntries(byType))}`);

      for (const t of AC5_TYPES) {
        expect(byType.get(t) ?? 0, `AC5 requires ${t} drafts to exist for the rule to be exercised`).toBeGreaterThan(0);
      }

      // And the null branch: a type neither engine prices must answer null, never 0 — reading it as
      // zero would cancel every UV/BG draft on its next documentation change.
      const unpriced = drafts.filter((d) => d.billableSessions === null);
      console.log(`   drafts whose insurance type neither engine prices (countBillableSessions -> null): ${unpriced.length}`);
      for (const d of unpriced) {
        expect(d.wouldCancel, `${d.invoiceNumber}: a null session count must never decide a cancellation`).toBe(false);
      }
    },
  );

  test(
    'the delivered-session rule is a negative test against PLANNED, not an equality test on "done"',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async ({ request }) => {
      // This is the trap, pinned. `isDeliveredSession()` ends `PLANNED !== getTreatmentType()`, so an
      // omitted treatmentType counts as DELIVERED. An oracle written as `=== 'done'` disagrees, and
      // the disagreement is not hypothetical: it invents a zero-session draft on VO 9634-5.
      const page = new DraftAutoCancelPage(request, auth);
      const ids = [...new Set(drafts.map((d) => d.prescriptionId).filter((v): v is string => Boolean(v)))];
      const acts = await page.activitiesFor(ids);

      const seen = new Map<string, number>();
      for (const rows of acts.values()) {
        for (const a of rows) {
          const k = a.treatmentType ?? '<omitted>';
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
      console.log(`#3649 treatmentType distribution across the draft population: ${JSON.stringify(Object.fromEntries(seen))}`);

      const omitted = seen.get('<omitted>') ?? 0;
      expect(omitted, 'the omitted-treatmentType case must exist, or this trap is untested here').toBeGreaterThan(0);

      let disagreements = 0;
      for (const [pid, rows] of acts) {
        const real = page.deliveredSessions(rows);
        const naive = page.DELIVERED_BY_DONE_ONLY(rows);
        if (real !== naive) {
          disagreements++;
          const d = drafts.find((x) => x.prescriptionId === pid);
          // The two predicates disagree in BOTH directions, and only one of them is dangerous.
          // naive > real: a rejected-without-signature session carries treatmentType 'done', so the
          //   naive count is too HIGH — it would never wrongly cancel, only wrongly spare.
          // naive < real: an omitted treatmentType, which the shipped negative test counts as
          //   delivered — the naive count is too LOW, and at 0 it invents a cancellable draft.
          const direction = naive > real ? 'over-counts (spares a draft)' : 'UNDER-counts';
          const danger = naive === 0 && real > 0 ? ` -> would wrongly call ${d?.invoiceNumber} cancellable` : '';
          console.log(
            `   VO ${d?.prescriptionNumber ?? pid}: shipped ${real} delivered, "=== done" ${naive} — naive ${direction}${danger}`,
          );
        }
      }
      expect(disagreements, 'the two predicates must differ somewhere, or the warning is stale').toBeGreaterThan(0);

      // The dangerous direction specifically: a VO the naive oracle scores at zero while the shipped
      // rule scores above it. Exactly one exists (9634-5, via its two omitted treatmentTypes), and it
      // is the reason the first pass of this work reported a stranded draft that was not stranded.
      const falseZero = [...acts.entries()].filter(
        ([, rows]) => page.DELIVERED_BY_DONE_ONLY(rows) === 0 && page.deliveredSessions(rows) > 0,
      );
      console.log(`   VOs the naive oracle would wrongly score at zero: ${falseZero.length}`);
      expect(falseZero.length, 'this is the case that manufactures a false AC1 fixture').toBeGreaterThan(0);
    },
  );

  test(
    'evidence — AC1 has no fixture on staging, and the automatic cancellation has never run',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async ({ request }) => {
      // Both halves of "cannot be observed here": no draft is IN the state, and no draft has ever
      // BEEN through it. The second is the stronger statement, because it covers all of history.
      const zero = drafts.filter((d) => d.billableSessions === 0);
      console.log(`#3649 AC1: ${zero.length} of ${drafts.length} draft-tier invoices have zero billable sessions`);
      for (const d of zero) {
        console.log(
          `   ${d.invoiceNumber} (VO ${d.prescriptionNumber}, ${d.vo?.insuranceType}, ${d.vo?.treatmentStatus}) ` +
            `sessions ${d.sessions} delivered ${d.delivered} validated ${d.vo?.validationStatus} -> wouldCancel ${d.wouldCancel}`,
        );
      }

      const notes = await new DraftAutoCancelPage(request, auth).notes();
      const automatic = notes.filter((n) => n.value.includes(AUTO_CANCEL_NOTE));
      console.log(`#3649 AC1 footprint: ${automatic.length} "${AUTO_CANCEL_NOTE}" notes in all ${notes.length} invoice-log notes`);

      // Asserted as a RECORD of the environment, not as a requirement — the day a fixture appears
      // this flips, and the assertion below is what makes that visible rather than silent.
      expect(
        automatic.length === 0 && zero.length === 0,
        'if this fails, staging finally has an AC1 instance — turn the fixme below into a real test',
      ).toBe(true);

      // The manual cancellations that DO exist are all pre-fix and all minted a Storno, which is the
      // behaviour AC7 changes. Recorded so the contrast is on file when a draft cancellation happens.
      const cancels = notes.filter((n) => /cancelled\. Reason:/.test(n.value));
      const withStorno = cancels.filter((n) => /Stornorechnung/.test(n.value));
      console.log(
        `   manual cancellations on file: ${cancels.length}, of which ${withStorno.length} created a Stornorechnung` +
          ` (all predate the fix; AC7 says a draft cancellation creates none)`,
      );
    },
  );

  test(
    'FINDING — cancellation also requires VALIDATED, which no AC states',
    { tag: ['@SuperAdmin', '@DraftAutoCancel', '@ReadOnly'] },
    async () => {
      // `cancelDraftWithNoBillableSessions()` returns early unless the VO is VALIDATED. The reason is
      // good and documented in the code (#3204 keeps a Not Sent draft through a validation reset so
      // its reserved number is not burned) — but it is a real narrowing of AC1's "any of the
      // triggers", and a QA following the ACs literally would report a missing cancellation as a bug.
      const notValidated = drafts.filter((d) => d.vo?.validationStatus !== 'validated');
      console.log(`#3649 FINDING: ${notValidated.length} draft-tier invoices sit on a VO that is not VALIDATED`);
      for (const d of notValidated) {
        console.log(
          `   ${d.invoiceNumber} (VO ${d.prescriptionNumber}): validationStatus=${d.vo?.validationStatus ?? '<omitted>'}, ` +
            `delivered ${d.delivered} — exempt from the automatic rule whatever its session count`,
        );
      }
      expect(notValidated.length, 'the gate is only demonstrable while such a draft exists').toBeGreaterThan(0);
    },
  );
});
