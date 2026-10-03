import { test, expect } from '@playwright/test';
import {
  SubmissionCorrectionPage,
  PART2,
  HISTORY,
} from '../../../Pages/superadmin/sa.submission-correction.page';

/**
 * RC 3.15 #3821 — "One-Off Correction: VO 9334-2 Into Hamburg's Sent Submission,
 * Stuck Stuttgart Speech-Therapy VOs Into an Open Submission".
 *
 * A **Need Command** ticket: one console command, `app:billing-batch:correct-3821`,
 * preview by default and `--execute` to apply, in two INDEPENDENT parts.
 *
 * AC8 settles what a spec can even claim here: "The ticket is done only after the
 * production run of both parts... A staging run does not complete it." So this file
 * does not close the ticket and does not pretend to. It answers the question the
 * ticket leaves open for QA — what does staging actually show today — and leaves a
 * regression guard behind.
 *
 * VERDICT ON STAGING (2026-10-03, API 3.15.0):
 *   Part 2  RAN, 2026-09-30 03:28:58 UTC. Every client-reachable AC verified.
 *   Part 1  has NEVER run. Nothing on staging has ever been added to a sent
 *           submission, which is the one thing no other code path in Flow can do.
 *
 * READ-ONLY. Every request is a GET. The command itself is console-only and is not
 * run here; nor are its two manual preparation steps, which detach a confirmed back
 * side from a real VO and reset a real VO's billing validation. Part 1 additionally
 * CREATES A COPAYMENT INVOICE, so it is left for a human who has first confirmed the
 * staging safety controls the Testing Guidance names (DATEV transfer off, every
 * Gesellschaft on test Mandant 9999, the email redirect active).
 *
 * WHY THE DEPLOYMENT PROBE IS THE RUN ITSELF: a console command has no route, no
 * serialized field and no bundle trace, and `GET /status` gives the release and not
 * the commit (#3704) — so on a release already deployed it cannot separate "shipped"
 * from "not yet" (#3773, #3719). What settles it here is better than a probe: the
 * command demonstrably ran, and it left a footprint only it can leave.
 */

test.describe('#3821 one-off billing-submission correction', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let sc: SubmissionCorrectionPage;

  test.beforeEach(async ({ page }) => {
    sc = new SubmissionCorrectionPage(page);
    await sc.open();
  });

  // ────────────────────────────────────────────────────────────────────────
  // The traps. Pinned first, because every count below depends on them.
  // ────────────────────────────────────────────────────────────────────────

  test(
    'the per-VO filter key is OPPOSITE on the two collections, and the wrong one returns everything',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const links = await sc.totalItems('/prescription_billing_batches');
      const invoices = await sc.totalItems('/invoices');

      // An unregistered key is accepted and IGNORED on both, so "it answered 200"
      // proves nothing — the control is that the whole collection comes back.
      expect(
        await sc.totalItems('/prescription_billing_batches?zzzNotAFilter=1'),
        'a bogus key must be ignored, which is what makes the comparison below mean something',
      ).toBe(links);

      const linkByDotId = await sc.totalItems(
        `/prescription_billing_batches?prescription.id=${PART2.prescriptionId}`,
      );
      const linkByBare = await sc.totalItems(
        `/prescription_billing_batches?prescription=${PART2.prescriptionId}`,
      );
      expect(linkByDotId, 'prescription.id= narrows the link collection').toBeLessThan(links);
      expect(linkByBare, 'bare prescription= is IGNORED on the link collection').toBe(links);

      const invByBare = await sc.totalItems(`/invoices?prescription=${PART2.prescriptionId}`);
      const invByDotId = await sc.totalItems(`/invoices?prescription.id=${PART2.prescriptionId}`);
      expect(invByBare, 'bare prescription= narrows /invoices').toBeLessThan(invoices);
      expect(invByDotId, 'prescription.id= is IGNORED on /invoices').toBe(invoices);

      console.log(
        `[#3821] /prescription_billing_batches: prescription.id=${linkByDotId}, prescription=${linkByBare} of ${links}\n` +
          `[#3821] /invoices:                     prescription=${invByBare}, prescription.id=${invByDotId} of ${invoices}\n` +
          `[#3821] the two conventions are exact opposites — neither predicts the other (#3550)`,
      );
    },
  );

  test(
    'page size is capped PER COLLECTION below itemsPerPage, so a short page is not the last page',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const caps: Record<string, { returned: number; total: number }> = {};
      for (const path of [
        '/prescription_back_images',
        '/billing_batches',
        '/prescription_billing_batches',
        '/billing_batch_logs',
      ]) {
        const r = await sc.get(`${path}?itemsPerPage=100&page=1`);
        caps[path] = {
          returned: SubmissionCorrectionPage.members(r.body).length,
          total: r.body?.totalItems,
        };
      }
      console.log('[#3821] page caps at itemsPerPage=100:', JSON.stringify(caps, null, 1));

      // The dangerous one: 30 of 3,301. A walk that breaks on a short page reads
      // under 1% of this table and reports its answer with total confidence.
      expect(caps['/prescription_back_images'].returned).toBeLessThan(100);
      expect(caps['/prescription_back_images'].total).toBeGreaterThan(1_000);
      expect(caps['/billing_batches'].returned).toBeLessThan(100);

      // And the walker must refuse a truncated read rather than return it.
      const all = await sc.walk('/billing_batches');
      expect(all.length).toBe(caps['/billing_batches'].total);
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Part 2 — ran on staging. Criteria 1, 2, 5 and 6.
  // ────────────────────────────────────────────────────────────────────────

  test(
    'Part 2 HAS run on staging, and its footprint is the only proof a console command can leave',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const vo = await sc.vo(PART2.vo);
      expect(vo, `the ticket's staging fixture ${PART2.vo} must exist`).toBeTruthy();
      expect(vo.id).toBe(PART2.prescriptionId);

      const links = await sc.linksForVo(PART2.prescriptionId);
      expect(links.length, `${PART2.vo} is in exactly one submission`).toBe(1);

      const batchId = SubmissionCorrectionPage.batchIdFromIri(links[0].billingBatch)!;
      const batch = await sc.batch(batchId);
      const history = await sc.batchHistory(batchId);

      const created = history.filter((h) => h.type === HISTORY.batchCreated);
      const added = history.filter((h) => h.type === HISTORY.voAdded);

      // AC5: a "submission created" entry when the correction created it, and a
      // "VO added" entry per VO. Same second = one operation did both.
      expect(created.length, 'exactly one "Batch erstellt" entry').toBe(1);
      expect(added.map((h) => h.meta?.prescriptionId)).toContain(PART2.vo);
      expect(created[0].createdAt).toBe(batch.createdAt);
      expect(added.find((h) => h.meta?.prescriptionId === PART2.vo)!.createdAt).toBe(
        links[0].createdAt,
      );

      console.log(
        `[#3821] Part 2 ran: ${batch.batchId} created ${batch.createdAt}, ` +
          `${PART2.vo} added ${links[0].createdAt}, history = ${history.map((h) => h.type).join(' + ')}`,
      );
    },
  );

  test(
    'AC5 — the submission belongs to the right Gesellschaft and is numbered from its own IK',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const links = await sc.linksForVo(PART2.prescriptionId);
      const batch = await sc.batch(SubmissionCorrectionPage.batchIdFromIri(links[0].billingBatch)!);

      expect(batch.entity?.id, 'the submission belongs to the VO\'s own Gesellschaft').toBe(
        PART2.entityId,
      );
      expect(batch.therapyType).toBe(PART2.therapyType);
      expect(batch.status, 'AC5: a WAITING submission, never a sent one').toBe('pending');

      // The number is `S-<year>-<last three digits of that Gesellschaft's IK>-NNN`,
      // which is exactly why criterion 1 has to look for a collision first.
      const entity = (await sc.entities()).find((e) => e.id === PART2.entityId);
      const prefix = SubmissionCorrectionPage.ikPrefix(entity?.ikSpeechtherapy);
      expect(batch.batchId).toMatch(new RegExp(`^S-\\d{4}-${prefix}-\\d{3}$`));
      expect(batch.ikNumber).toBe(entity?.ikSpeechtherapy);

      // AC5: the totals include the added VO.
      const inside = SubmissionCorrectionPage.members(
        (await sc.get(`/prescription_billing_batches?billingBatch.id=${batch.id}&itemsPerPage=100`))
          .body,
      );
      expect(batch.totalPrescriptions).toBe(inside.length);
      const revenue = inside.reduce((sum, r) => sum + (r.prescription?.totalRevenue ?? 0), 0);
      expect(batch.totalRevenue).toBeCloseTo(revenue, 2);

      console.log(
        `[#3821] ${batch.batchId}: entity ${batch.entity?.id}, IK ${batch.ikNumber} -> prefix ${prefix}, ` +
          `${batch.totalPrescriptions} VO(s), revenue ${batch.totalRevenue}, copayment ${batch.copaymentTotal}`,
      );
    },
  );

  test(
    'AC6 — the VO\'s status, validation and invoices were NOT touched (the no-reset signature)',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const vo = await sc.vo(PART2.vo);
      const log = await sc.voLog(PART2.prescriptionId);

      const validations = log.filter((l) => l.meta?.field === 'validationStatus');
      const batchAdds = log.filter((l) => l.meta?.field === 'billingBatch');

      // THIS is what separates the command from a manual reset-and-revalidate, and
      // it is the whole reason the run is attributable at all: the correction calls
      // addPrescriptionToBillingBatch() directly and never touches validationStatus.
      // A reset would have written `validated -> null` and then a second validation.
      expect(validations.length, 'validation was set exactly once, and never reset').toBe(1);
      expect(validations[0].newValue).toBe('validated');
      expect(batchAdds.length, 'added to a submission exactly once').toBe(1);
      expect(batchAdds[0].createdAt > validations[0].createdAt).toBe(true);

      // The add is system-written; the validation was a person. `meta.type` and the
      // absence of an author are both part of that contract.
      expect(batchAdds[0].meta?.type).toBe('automatic');
      expect(batchAdds[0].createdBy, 'a command writes with no author').toBeFalsy();
      expect(validations[0].meta?.type).toBe('manual');
      expect(validations[0].createdBy?.fullName).toBeTruthy();

      // AC6: status unchanged, and no invoice created for it.
      expect(vo.validationStatus).toBe('validated');
      expect(vo.treatmentStatus).toBe('Fertig Behandelt');
      const invoices = await sc.invoicesForVo(PART2.prescriptionId);
      expect(invoices.length, 'AC6: Part 2 creates no copayment invoice').toBe(0);

      console.log(
        `[#3821] ${PART2.vo}: validated ${validations[0].createdAt} by ${validations[0].createdBy?.fullName}; ` +
          `batched ${batchAdds[0].createdAt} by the system; status ${vo.treatmentStatus}; invoices ${invoices.length}`,
      );
    },
  );

  test(
    'AC2 row 3 — the fixture is now in a submission, so a re-run must skip it',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      // The Testing Guidance's last step is "Run it again: the VO is skipped as
      // already in a submission". The STATE that produces that skip is checkable
      // without running anything, which is the only way to check it read-only:
      // the suggested approach detects it as "a PrescriptionBillingBatch row exists".
      const links = await sc.linksForVo(PART2.prescriptionId);
      expect(links.length).toBe(1);

      const vo = await sc.vo(PART2.vo);
      expect(vo.validationStatus, 'still validated, so it is not skipped for that reason').toBe(
        'validated',
      );
      expect(['public', 'accident']).toContain(vo.insuranceType);

      console.log(
        `[#3821] a re-run would skip ${PART2.vo}: "Already in submission ` +
          `${(await sc.batch(SubmissionCorrectionPage.batchIdFromIri(links[0].billingBatch)!)).batchId}"`,
      );
    },
  );

  test(
    'criterion 1 (Part 2) — the Gesellschaft has its IK, and no two share a submission prefix',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const entities = await sc.entities();
      const entity = entities.find((e) => e.id === PART2.entityId);
      expect(entity?.name).toBe(PART2.entityName);
      expect(entity?.ikSpeechtherapy, 'criterion 1: the Logopädie IK must be saved').toBeTruthy();

      // The second check: a submission number uses the last three digits of the IK,
      // and another Gesellschaft's IK can share them — in which case
      // findMostRecentAndPending() (which filters on the prefix only, not on the
      // entity) would put these VOs into somebody else's submission.
      const prefixes = new Map<string, string[]>();
      for (const e of entities) {
        for (const [key, value] of Object.entries(e)) {
          if (!/^ik/i.test(key) || !value) continue;
          const k = `${key}:${SubmissionCorrectionPage.ikPrefix(value)}`;
          prefixes.set(k, [...(prefixes.get(k) ?? []), `${e.id} ${e.name}`]);
        }
      }
      const collisions = [...prefixes].filter(([, owners]) => owners.length > 1);
      expect(prefixes.size, 'the check is not vacuous — IKs do exist to collide').toBeGreaterThan(5);
      expect(collisions, `prefix collisions: ${JSON.stringify(collisions)}`).toEqual([]);

      console.log(
        `[#3821] ${prefixes.size} (IK type, last 3) pairs across ${entities.length} Gesellschaften, 0 collisions`,
      );
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Part 1 — never run on staging.
  // ────────────────────────────────────────────────────────────────────────

  test(
    'Part 1 has NEVER run on staging: nothing has been added to a sent submission',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      const batches = await sc.batches();
      const byId = new Map(batches.map((b) => [b.id, b]));
      const logs = await sc.walk('/billing_batch_logs');

      const sent = batches.filter((b) => b.status === 'complete_and_sent');
      expect(sent.length, 'there are sent submissions to add to, so the check can fail').toBeGreaterThan(0);

      // Adding a VO to an ALREADY-SENT submission is the one thing no other path in
      // Flow can do — the API Post is denied for a batch that is not VO-editable, and
      // only PENDING is VO-editable. So this is Part 1's unmistakable signature.
      const intoSent = logs.filter((l) => {
        if (l.type !== HISTORY.voAdded) return false;
        const b = byId.get(SubmissionCorrectionPage.batchIdFromIri(l.billingBatch)!);
        return b?.status === 'complete_and_sent' && b.sentDate && l.createdAt > b.sentDate;
      });

      expect(
        intoSent,
        `Part 1 would show here: ${JSON.stringify(intoSent.map((l) => l.meta))}`,
      ).toEqual([]);

      console.log(
        `[#3821] ${logs.length} submission-history entries across ${batches.length} submissions ` +
          `(${sent.length} sent); 0 VOs ever added to a sent one. Part 1 has not run on staging.`,
      );
    },
  );

  test(
    "Part 1's production fixtures do not exist on staging, so its run is production-only",
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      // The ticket's Part 1 names production records throughout. None is here, which
      // is why the Testing Guidance tells QA to pick a comparable pair instead of
      // following the production numbers.
      for (const number of ['9334-2', '7610-10']) {
        expect(await sc.vo(number), `${number} is a production VO`).toBeFalsy();
      }
      const batches = await sc.batches();
      for (const id of ['P-2026-862-013', 'P-2026-112-013', 'P-2026-862-014']) {
        expect(batches.find((b) => b.batchId === id), `${id} is a production submission`).toBeFalsy();
      }
      const backImages = SubmissionCorrectionPage.members(
        (await sc.get('/prescription_back_images?imageId=565-008&itemsPerPage=30')).body,
      );
      expect(backImages.find((i) => i.imageId === '565-008')).toBeFalsy();

      console.log('[#3821] none of Part 1\'s named records (9334-2, 7610-10, P-2026-862-013/112-013/862-014, 565-008) exists on staging');
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Findings, reported as green tests rather than fixmes: each is a fact about
  // the environment or the ticket's own instructions, not an AC failing.
  // ────────────────────────────────────────────────────────────────────────

  test(
    "FINDING — the Testing Guidance's Part 2 rehearsal can no longer be performed on staging",
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly'] },
    async () => {
      // The Testing Guidance says: "Run the preview with the IK still missing:
      // Part 2 stops and names the missing IK. Save the IK, run the preview and the
      // confirmed run... Run it again: the VO is skipped as already in a submission."
      //
      // Both of that rehearsal's preconditions are gone. The Developer Reference
      // (written against a 25 Sep snapshot) still records the fixture as "in no
      // batch, a ready fixture for Part 2".
      const entity = (await sc.entities()).find((e) => e.id === PART2.entityId);
      const links = await sc.linksForVo(PART2.prescriptionId);

      expect(entity?.ikSpeechtherapy, 'the IK is saved, so step 1 cannot be rehearsed').toBeTruthy();
      expect(links.length, 'the VO is batched, so steps 2 and 3 cannot be rehearsed').toBe(1);

      console.log(
        `[#3821] FINDING: the staging Part 2 fixture is CONSUMED.\n` +
          `  ${PART2.vo} is already in a submission (${links[0].createdAt}) and entity ` +
          `${PART2.entityId} already holds its Logopädie IK (${entity?.ikSpeechtherapy}).\n` +
          `  Only the LAST step of the rehearsal ("run it again -> skipped") is still reachable.\n` +
          `  A fresh fixture would need a validated GKV VO whose Gesellschaft has no IK for its\n` +
          `  therapy type, and #3822 now refuses to create one — see the next test for the one\n` +
          `  such VO that already exists on staging.`,
      );
    },
  );

  test(
    'FINDING — a SECOND stuck cause exists on staging: validated GKV VOs in no submission despite having an IK',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly', '@Slow'] },
    async () => {
      test.setTimeout(600_000);

      const entities = Object.fromEntries((await sc.entities()).map((e) => [e.id, e]));
      const ikField: Record<string, string> = {
        physiotherapy: 'ikPhysiotherapy',
        ergotherapy: 'ikErgotherapy',
        speech_therapy: 'ikSpeechtherapy',
      };

      const links = await sc.links();
      const batched = new Set(links.map((l) => l.prescription?.id));

      let validated: any[] = [];
      for (const insurance of ['public', 'accident']) {
        validated = validated.concat(
          await sc.walk(`/prescriptions?validationStatus=validated&insuranceType=${insurance}`, {
            cap: 4_000,
          }),
        );
      }
      const stuck = validated.filter((v) => !batched.has(v.id));

      // Split the stuck population by WHY, because the ticket attributes all of its
      // five to one cause and staging shows two.
      const withIk = stuck.filter((v) => {
        const dept = v.therapist?.therapyDepartment ?? v.therapyType;
        return Boolean(entities[v.entity?.id]?.[ikField[dept]]);
      });
      const withoutIk = stuck.filter((v) => !withIk.includes(v));

      // None of them was simply removed from a submission by hand — that is the
      // innocent explanation, and it is ruled out rather than assumed.
      const removed = new Set(
        (await sc.walk('/billing_batch_logs'))
          .filter((l) => l.type === HISTORY.voRemoved)
          .map((l) => l.meta?.prescriptionId),
      );
      const unexplained = withIk.filter((v) => !removed.has(v.prescriptionId));

      console.log(
        `[#3821] stuck population on staging: ${stuck.length} validated GKV/BG VOs in no submission\n` +
          `  stuck for THIS ticket's reason (no IK for the therapy type): ${withoutIk.length} — ` +
          `${withoutIk.map((v) => `${v.prescriptionId} (entity ${v.entity?.id}, ${v.therapyType})`).join(', ') || 'none'}\n` +
          `  stuck DESPITE having an IK: ${withIk.length} — ${withIk.map((v) => v.prescriptionId).join(', ')}\n` +
          `  ...of which never removed from a submission by hand: ${unexplained.length}`,
      );

      // The ticket's Background says of its five: "These five are the only validated
      // GKV or BG VOs on production that are in no submission", and attributes all of
      // them to the missing IK. On staging that second group exists and is larger than
      // the first. Reported, not asserted as a defect: it is outside #3821's five named
      // VOs and outside #3822's prevention, and whether production has the same shape
      // cannot be read from here.
      // The finding itself is REPORTED, not asserted — but the measurement behind it
      // must still be able to fail, or this test passes on an empty read and the
      // numbers above are worthless. These three are the anti-vacuity guards.
      expect(validated.length, 'the validated population must be non-empty').toBeGreaterThan(100);
      expect(links.length, 'the link walk must have collected the whole collection').toBeGreaterThan(100);
      expect(
        stuck.length,
        'every stuck VO must be accounted for by exactly one cause',
      ).toBe(withIk.length + withoutIk.length);

      if (unexplained.length) {
        console.log(
          `[#3821] FINDING: ${unexplained.length} VOs are validated, GKV, in no submission, hold the\n` +
            `  right IK and were never removed from one — so neither #3821's cause nor a manual\n` +
            `  removal explains them. Worth a look before the production run, because #3822\n` +
            `  prevents only the missing-IK cause.`,
        );
      }
    },
  );

  test(
    'evidence — the Part 1 comparable pair the Testing Guidance asks QA to pick',
    { tag: ['@SuperAdmin', '@SubmissionCorrection', '@ReadOnly', '@Slow'] },
    async () => {
      test.setTimeout(600_000);

      // "Pick a comparable pair: a GKV VO in Fertig Behandelt that is not validated,
      // and a sent submission of the same therapy type from another Gesellschaft whose
      // confirmed back side can be moved." Nobody has picked one, so this names them.
      const batches = await sc.batches();
      const byId = new Map(batches.map((b) => [b.id, b]));
      const links = await sc.links();
      const batched = new Set(links.map((l) => l.prescription?.id));

      const sentOf = (entityId: number, therapyType: string) =>
        batches.filter(
          (b) => b.status === 'complete_and_sent' && b.entity?.id === entityId && b.therapyType === therapyType,
        );

      // (a) the 9334-2 analogue — and it must carry a NON-ZERO copayment, or AC4's
      //     "a copayment invoice is created" row is never exercised.
      const candidates = (
        await sc.walk(
          '/prescriptions?insuranceType=public&treatmentStatus=Fertig%20Behandelt' +
            '&exists%5BvalidationStatus%5D=false&therapyType=physiotherapy',
          { cap: 1_300 },
        )
      ).filter(
        (v) =>
          !batched.has(v.id) &&
          (v.copaymentAmount ?? 0) > 0 &&
          v.entity?.id &&
          sentOf(v.entity.id, 'physiotherapy').length > 0,
      );
      expect(candidates.length, 'at least one usable Part 1 VO must exist').toBeGreaterThan(0);

      // (b) the source side — a confirmed back side on a VO inside a SENT submission
      //     of a DIFFERENT Gesellschaft, so it can be detached and re-attached.
      const target = candidates[0];
      const sources = links.filter((l) => {
        const b = byId.get(SubmissionCorrectionPage.batchIdFromIri(l.billingBatch)!);
        return (
          b?.status === 'complete_and_sent' &&
          b.entity?.id !== target.entity?.id &&
          (l.prescription?.prescriptionBackImages ?? []).length > 0
        );
      });
      expect(sources.length, 'at least one movable back side must exist').toBeGreaterThan(0);

      const source = sources[0];
      const sourceBatch = byId.get(SubmissionCorrectionPage.batchIdFromIri(source.billingBatch)!)!;
      const targetBatch = sentOf(target.entity.id, 'physiotherapy')[0];
      const image = source.prescription.prescriptionBackImages[0];

      console.log(
        `[#3821] A Part 1 pair for QA on staging (${candidates.length} VO candidates, ${sources.length} movable back sides):\n` +
          `  --vo=${target.prescriptionId}            ${target.entity?.name}, GKV, Fertig Behandelt, unvalidated,\n` +
          `                              revenue ${target.totalRevenue}, copayment ${target.copaymentAmount} (non-zero, so AC4's invoice row is exercised)\n` +
          `  --target-batch=${targetBatch.batchId}   sent ${targetBatch.sentDate}, same Gesellschaft and therapy type\n` +
          `  --source-batch=${sourceBatch.batchId}   sent ${sourceBatch.sentDate}, ${sourceBatch.entity?.name}\n` +
          `  --detached-vo=${source.prescription.prescriptionId}        the VO the back side is detached from\n` +
          `  --back-image=${image.imageId ?? '(see /prescription_back_images)'}\n` +
          `  Prep first (ticket + Need Command): detach the back side, reset that VO's billing\n` +
          `  validation, and tick every open billing check on ${target.prescriptionId} WITHOUT validating it.`,
      );
    },
  );

});
