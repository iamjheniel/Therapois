import { test, expect } from '@playwright/test';
import { OpticaExportPage, ExportAttempt, VoBsnr } from '../../../Pages/admin/admin.optica-export.page';

/**
 * RC 3.11 — Optica billing file uses the VO's stamped BSNR (#3288).
 *
 * The §302 Sammelrechnung wants the BSNR *from the prescription* (Anlage 1 TP5 V21), because the
 * insurer holds the stamped paper next to the electronic record. The export used to read the doctor's
 * practice's current main BSNR; it must now read the VO's own recorded number, falling back to the
 * practice's main BSNR only when the VO has none. The billing-readiness check must use the same
 * source, so the two can never disagree.
 *
 * **What staging can and cannot show.** The exported file itself is out of reach here: of 50 billing
 * batches, 5 are `pending` (422 "not ready for export") and 45 are blocked by the readiness check
 * (1,931 MISSING_INSURER_IK, 1,930 MISSING_VERSICHERTENSTATUS, 1,274 MISSING_POSITION_NUMBER, 8
 * MISSING_LANR, 2 MISSING_BSNR), so no batch produces a file at all — and no batched VO carries its
 * own BSNR anyway (all of them predate #3286/#3287), so even a successful export would only exercise
 * AC2's fallback. AC1 and AC3 are therefore asserted as far as the data allows: the VO's own number is
 * recorded and does differ from its practice's main number, which is the precondition those ACs are
 * about, with the file comparison left `fixme`'d and explained.
 *
 * What *is* directly observable is AC4, the readiness check — it reports per-VO error codes, so
 * whether it accepts a VO's own BSNR can be read straight off the response.
 *
 * Read-only: exports are fetched, never sent, and no batch or VO is modified.
 */

/** Batch pages to sweep (20 per page covers all 50 staging batches). */
const BATCH_PAGES = 3;

function describeVo(vo: VoBsnr): string {
  return (
    `VO ${vo.number} (id ${vo.id}): ownBsnr=${vo.ownBsnr ?? 'none'}, practice=` +
    `${vo.practiceName ?? 'none'} (main ${vo.practiceMainBsnr ?? 'none'}), doctor=${vo.hasDoctor}`
  );
}

test.describe('Optica export — BSNR comes from the VO', () => {
  test(
    'AC1/AC3 — VOs record their own BSNR, and it can differ from the practice’s current main number',
    { tag: ['@Admin', '@OpticaExport', '@BsnrPerVo'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const optica = new OpticaExportPage(page);
      await optica.open();

      // Newest VOs first: `bsnr` only exists on VOs created or edited since #3286/#3287, and the
      // collection is ordered oldest-first.
      const { total, lastPage } = await optica.prescriptionPages(50);
      const newest = await optica.vosOnPage(lastPage, 50);
      const withOwn = newest.filter((vo) => vo.ownBsnr);
      console.log(`prescriptions: ${total}; newest page ${lastPage}: ${withOwn.length}/${newest.length} carry their own BSNR`);
      expect(
        withOwn.length,
        'VOs must be recording their own BSNR at all — without that, #3288 has nothing to submit',
      ).toBeGreaterThan(0);

      // AC3's precondition: own number ≠ the practice's current main number. This is the case the
      // ticket calls intended behaviour rather than a data error, so it must exist to be testable.
      const differing = withOwn.filter((vo) => vo.practiceMainBsnr && vo.ownBsnr !== vo.practiceMainBsnr);
      console.log(`own BSNR differs from the practice main BSNR on ${differing.length} of ${withOwn.length}`);
      for (const vo of differing.slice(0, 5)) console.log(`  ${describeVo(vo)}`);
      expect(
        differing.length,
        'staging must hold at least one VO whose own BSNR differs from its practice’s main number — ' +
          'that is the AC3 fixture the export has to honour',
      ).toBeGreaterThan(0);

      // And the number a VO kept should be one its practice actually holds (#3285's list). Logged
      // rather than asserted for every row: which numbers a practice may hold is #3285/#3286's rule,
      // not this ticket's.
      const sample = differing[0];
      const list = await optica.practiceBsnrs(sample.practiceId!);
      console.log(`practice ${sample.practiceName} BSNRs: ${JSON.stringify(list)}`);
      const main = list.find((entry) => entry.isMain)?.number ?? null;
      expect(main, 'a practice with a BSNR list must have a main number').toBeTruthy();
      expect(
        sample.ownBsnr,
        `VO ${sample.number} must have kept a number other than the practice’s main ${main}`,
      ).not.toBe(main);
    },
  );

  test(
    'AC4 — the readiness check reads the BSNR from the VO, not the practice',
    { tag: ['@Admin', '@OpticaExport', '@BsnrPerVo'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const optica = new OpticaExportPage(page);
      await optica.open();

      const batches = await optica.batches(BATCH_PAGES);
      console.log(`batches: ${batches.length} (${JSON.stringify(batches.reduce((acc: Record<string, number>, b) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }), {}))})`);
      expect(batches.length, 'staging must have billing batches to attempt').toBeGreaterThan(0);

      const attempts: ExportAttempt[] = [];
      for (const batch of batches) attempts.push(await optica.attemptExport(batch));

      const codes: Record<string, number> = {};
      const bsnrFlagged: { vo: string; id: number; hint: string }[] = [];
      for (const attempt of attempts) {
        for (const error of attempt.errors) {
          codes[error.code] = (codes[error.code] ?? 0) + 1;
          if (error.code === 'MISSING_BSNR') bsnrFlagged.push({ vo: error.vo, id: error.prescriptionId, hint: error.hint });
        }
      }
      console.log(`export outcomes: ${JSON.stringify(attempts.reduce((acc: Record<string, number>, a) => ({ ...acc, [a.outcome]: (acc[a.outcome] ?? 0) + 1 }), {}))}`);
      console.log(`readiness error codes: ${JSON.stringify(codes)}`);
      console.log(`MISSING_BSNR on: ${JSON.stringify(bsnrFlagged)}`);

      // The check must be reachable at all, otherwise this test proves nothing.
      expect(
        attempts.some((a) => a.outcome === 'validation'),
        'at least one batch must reach the billing-readiness check',
      ).toBe(true);

      // AC4: a VO that has its own BSNR must never be flagged as missing one.
      for (const flagged of bsnrFlagged) {
        const vo = await optica.voBsnr(flagged.id);
        console.log(`  flagged: ${describeVo(vo)}`);
        expect(
          vo.ownBsnr,
          `VO ${vo.number} is flagged MISSING_BSNR although it records its own BSNR ${vo.ownBsnr} — the ` +
            `readiness check is not reading the VO's number`,
        ).toBeNull();
      }
    },
  );

  test(
    'AC2 — a VO with no BSNR of its own falls back to its practice’s main number',
    { tag: ['@Admin', '@OpticaExport', '@BsnrPerVo'] },
    async ({ page }) => {
      test.fixme(
        true,
        'FINDING (staging, 2026-08-18): the fallback does not use the VO\'s linked practice. Both VOs ' +
          'flagged MISSING_BSNR by the readiness check — 8986-1 (id 29953, batch 54) and 3447-27 ' +
          '(id 30930, batch 26) — have no own BSNR **and** a linked practice that does hold a main ' +
          'BSNR: "Johanniter-Klinik Godeshöhe" 752703700 and "Vivantes Klinikum Neukölln - Kinder und ' +
          'Jugendmedizin" 729654700, both present as isMain in practiceBsnrs. What they lack is a ' +
          'DOCTOR: `prescription.doctor` is absent on both, and the resolver is called with the ' +
          'doctor\'s practice (`$doctor->getPractice()`, per the PM notes) rather than the ' +
          'prescription\'s own practice — which the ticket\'s developer reference explicitly asks for ' +
          '("fallback to the prescription\'s practice\'s main BSNR"). So a doctorless hospital VO is ' +
          'blocked from billing even though a BSNR is on file for its practice. Not a regression — the ' +
          'pre-change code read the doctor\'s practice too — but AC2/AC4\'s fallback is unfulfilled for ' +
          'this shape. Un-fixme once the fallback reads the prescription\'s practice; the assertion ' +
          'below then guards it.',
      );
      test.setTimeout(900_000);
      const optica = new OpticaExportPage(page);
      await optica.open();

      const batches = await optica.batches(BATCH_PAGES);
      for (const batch of batches) {
        const attempt = await optica.attemptExport(batch);
        for (const error of attempt.errors.filter((e) => e.code === 'MISSING_BSNR')) {
          const vo = await optica.voBsnr(error.prescriptionId);
          console.log(describeVo(vo));
          expect(
            vo.practiceMainBsnr,
            `VO ${vo.number} has no BSNR of its own, so the check must fall back to its practice's main ` +
              `number — it is flagged MISSING_BSNR while practice "${vo.practiceName}" holds ` +
              `${vo.practiceMainBsnr}`,
          ).toBeNull();
        }
      }
    },
  );

  test('AC1/AC2/AC3 — the BSNR field inside a generated Optica file', { tag: ['@Admin', '@OpticaExport'] }, async () => {
    test.fixme(
      true,
      'No Optica file can be generated on staging, so the exported field cannot be read. All 50 billing ' +
        'batches were attempted (2026-08-18): 5 are `pending` and answer 422 "not ready for export", ' +
        'and the other 45 are rejected by the readiness check — 1,931 MISSING_INSURER_IK, 1,930 ' +
        'MISSING_VERSICHERTENSTATUS, 1,274 MISSING_POSITION_NUMBER, 8 MISSING_LANR, 2 MISSING_BSNR. ' +
        'Independently, no batched VO carries its own BSNR (batch 54: 0 of 15 sampled), because every ' +
        'batch predates #3286/#3287 — so a successful export would exercise AC2\'s fallback only, never ' +
        'AC1 or AC3. Making this testable needs a fresh GKV batch built from VOs with their own BSNR, ' +
        'which is a real billing action (it marks VOs as billed) and out of scope for a read-only suite. ' +
        'The PM pass reached the same wall and verified AC1–AC3 by code reading; Stefan\'s first real ' +
        'submission remains the ground truth.',
    );
  });
});
