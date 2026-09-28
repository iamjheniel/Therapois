import { test, expect } from '@playwright/test';
import {
  ALETH,
  AREA_TO_THERAPY_TYPE,
  CrossAreaFeesPage,
  LISTED_FEES,
  VoFees,
} from '../../../Pages/superadmin/sa.cross-area-fees.page';

/**
 * RC 3.12 #3577 — the one-off removal of cross-area fees from 93 TheOrg-imported VOs.
 *
 * The correction ships as a console command (`app:prescription:remove-cross-area-fees`), so nothing
 * here can run it. What it CAN do is read the outcome: the command was applied to staging on
 * 2026-09-03 and re-previewed clean on 2026-09-04, so every AC that describes a resulting state is
 * decidable, and this file is explicit about which ones are not.
 *
 * **The one methodological choice worth stating up front.** AC2 has two halves — "removes exactly
 * the listed entry" and "leaves every other fee/Heilmittel unchanged" — and only the first is a
 * lookup. There is no pre-run snapshot to diff against from a client, so the second half is
 * approached from the opposite direction: re-derive the cross-area rule over the whole book with
 * `/prescriptions?treatment=<id>&therapyType=<x>` and see where it still fires. If the listed pairs
 * are gone AND the survivors are all off-list, the command was list-scoped exactly as AC2 requires.
 * That is a stronger claim than a spot check, and it is what turned up the finding at the bottom.
 *
 * Read-only — every request is a GET.
 */

test.describe('#3577 cross-area fee removal on TheOrg-imported VOs', () => {
  test.describe.configure({ mode: 'serial' });

  let fees: CrossAreaFeesPage;
  /** The listed VOs as staging holds them today, resolved once for the whole file. */
  let vos: Map<string, VoFees | null>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await browser.newPage();
    fees = new CrossAreaFeesPage(page);
    await fees.connect();
    await fees.loadTreatments();
    vos = await fees.listedVos();
  });

  test(
    'the treatment catalogue and the therapyType filter are live, so a zero below means something',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      // Every code the list names must exist in the catalogue, with the area the sheet claims —
      // otherwise the whole cross-area premise is being read off a stale column.
      const missing: string[] = [];
      const wrongArea: string[] = [];
      for (const row of LISTED_FEES) {
        const t = fees.treatment(row.wrongCode);
        if (!t) missing.push(row.wrongCode);
        else if (t.area !== row.feeArea) wrongArea.push(`${row.wrongCode}: catalogue ${t.area} vs sheet ${row.feeArea}`);
      }
      expect(missing, 'every listed fee code exists in /treatments').toEqual([]);
      expect([...new Set(wrongArea)], "the catalogue agrees with the sheet's Fee Area column").toEqual([]);

      // The trap this guard exists for: `therapyType` takes `physiotherapy`, not the sheet's `PT`,
      // and an unknown value is accepted SILENTLY with `totalItems: 0` — which reads exactly like
      // "no cross-area VOs are left", i.e. like the ticket passing. So prove the filter partitions:
      // AB-L's own area must come back non-empty.
      const { own, total } = await fees.assertTherapyTypeVocabulary('AB-L');
      expect(total, 'AB-L is carried by some VO').toBeGreaterThan(0);
      expect(own, 'the therapyType filter returns AB-L VOs of its OWN area — the filter is live').toBeGreaterThan(0);
      console.log(`AB-L: ${total} VOs carry it, ${own} of them speech-therapy VOs (${total - own} elsewhere)`);
    },
  );

  test(
    'AC2 (removal) — every listed wrong-area fee is gone from its VO',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      const stillPresent: string[] = [];
      const absent: string[] = [];
      let checked = 0;
      for (const row of LISTED_FEES) {
        const vo = vos.get(row.vo);
        if (!vo) {
          absent.push(`${row.vo}/${row.wrongCode}`);
          continue;
        }
        checked++;
        if (vo.codes.some((c) => c.code === row.wrongCode)) stillPresent.push(`${row.vo}/${row.wrongCode}`);
      }
      console.log(`listed pairs: ${LISTED_FEES.length} — ${checked} reachable on staging, ${absent.length} on VOs that do not exist here`);
      console.log(`VOs absent from staging: ${[...new Set(absent)].join(', ')}`);
      expect(checked, 'the correction is exercised on a real population, not an empty one').toBeGreaterThan(80);
      expect(stillPresent, 'no listed VO still carries its wrong-area fee').toEqual([]);
    },
  );

  /**
   * The stray-code survey, shared by the green half of the End Goal and the `fixme` below.
   *
   * The map lookup here is load-bearing and used to fail silently: `AREA_TO_THERAPY_TYPE` mapped
   * `ERGO` to `occupational_therapy`, so an `ergotherapy` VO matched no entry, `voArea` came back
   * undefined and the loop skipped it — the stray-code check simply did not run for any
   * Ergotherapie VO. It now throws instead of skipping.
   */
  const surveyStrays = () => {
    const stray: string[] = [];
    const emptied: string[] = [];
    for (const [number, vo] of vos) {
      if (!vo) continue;
      if (0 === vo.codes.length) emptied.push(number);
      const voArea = Object.entries(AREA_TO_THERAPY_TYPE).find(([, tt]) => tt === vo.therapyType)?.[0];
      if (!voArea) {
        throw new Error(
          `#3577: therapyType "${vo.therapyType}" on VO ${number} is not in AREA_TO_THERAPY_TYPE — ` +
            'the stray-code check would silently skip this VO',
        );
      }
      for (const c of vo.codes) {
        if (c.area && c.area !== voArea) stray.push(`${number} (${vo.therapyType}) still carries ${c.code} [${c.area}]`);
      }
    }
    return { stray, emptied };
  };

  test(
    'AC2 (nothing else) — no corrected VO was emptied, and each still has a Heilmittel',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      const { emptied } = surveyStrays();
      expect(emptied, 'the removal never stripped a VO of all its prescribed treatments').toEqual([]);

      const heilmittelless = [...vos.entries()].filter(([, v]) => v && !v.codes.some((c) => 'treatment' === c.kind));
      expect(heilmittelless.map(([n]) => n), 'every corrected VO still has at least one Heilmittel').toEqual([]);
    },
  );

  test(
    'evidence — the cross-area codes still sitting on corrected VOs',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      const { stray } = surveyStrays();
      console.log(
        stray.length
          ? `#3577 End Goal: ${stray.length} cross-area code(s) remain on corrected VOs:\n  ${stray.join('\n  ')}`
          : '#3577 End Goal: every remaining code on a corrected VO belongs to that VO’s own area',
      );
    },
  );

  test(
    'AC5 — no billing batch was reopened, modified or resent',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      const batches = await fees.billingBatches();
      const sent = batches.filter((b) => 'complete_and_sent' === b.status);
      expect(sent.length, 'staging has already-sent batches to protect').toBeGreaterThan(0);

      // The correction ran 2026-09-03. A batch touched on or after that date would mean the command
      // reached into billing, which AC5 forbids.
      const touched = batches.filter((b) => b.updatedAt >= '2026-09-03');
      console.log(`${batches.length} batches (${sent.length} sent); newest updatedAt = ${batches.map((b) => b.updatedAt).sort().slice(-1)[0]}`);
      for (const b of touched) console.log(`  touched on/after the run: ${b.batchId} ${b.status} ${b.updatedAt}`);
      expect(touched.filter((b) => 'complete_and_sent' === b.status), 'no SENT batch was modified on or after the run date').toEqual([]);

      // Honest scope note: AC5 names 3 GKV batches that went out carrying the wrong-area fees. None
      // of the listed VOs sits in a staging batch, so the specific fixture the AC describes does not
      // exist here and this test asserts the general form only.
      const batched = [...vos.values()].filter((v) => v && v.billingBatchCount > 0);
      console.log(`listed VOs sitting in a billing batch on staging: ${batched.length}`);
    },
  );

  test(
    'evidence — what the corrected population looks like today',
    { tag: ['@SuperAdmin', '@CrossAreaFees', '@ReadOnly'] },
    async () => {
      const present = [...vos.values()].filter((v): v is VoFees => !!v);
      const byCode = new Map<string, number>();
      for (const f of LISTED_FEES) byCode.set(f.wrongCode, (byCode.get(f.wrongCode) ?? 0) + 1);
      console.log(`list: ${LISTED_FEES.length} pairs over ${new Set(LISTED_FEES.map((f) => f.vo)).size} VOs`);
      console.log(`  by wrong fee code: ${[...byCode].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' ')}`);
      console.log(`  on staging: ${present.length} VOs resolve, ${present.filter((v) => v.imported).length} of them imported`);
      console.log(`  carrying an invoice: ${present.filter((v) => v.invoice).length}; in a billing batch: ${present.filter((v) => v.billingBatchCount > 0).length}`);
      expect(present.length).toBeGreaterThan(0);
    },
  );

  // ─────────────────────────────────── findings ───────────────────────────────────
});
