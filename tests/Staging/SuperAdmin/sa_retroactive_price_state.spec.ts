import { test, expect } from '@playwright/test';
import { TreatmentPricesPage } from '../../../Pages/superadmin/sa.treatment-prices.page';
import { waitForAuthState } from '../../../Pages/util/settle';

/**
 * RC 3.11 #3378 — "Retroactively Entered Prices Are Not Applied to Already-Documented Treatments",
 * verified **read-only**.
 *
 * A treatment's price is snapshotted onto its `ActivityTreatment` when it is documented, and used to
 * be written once and never revisited — so a price entered later with a *past* effective date left
 * every already-documented treatment on its old price. The fix recomputes those snapshots whenever a
 * price entry is created (single or bulk) or deleted.
 *
 * **This spec writes nothing.** It reads the standing state left by the retroactive price entry the
 * PM created on staging on 2026-08-15 — HBH-E GKV €20.00 effective **2026-08-10**, against a prior
 * GKV price of €17.97 — and checks that the recompute's outcome is visible in the data. The
 * companion spec `sa_retroactive_price_recompute.spec.ts` drives the same ticket through a
 * self-restoring POST/DELETE round trip and covers the ACs that need a write (AC3, AC5).
 *
 * **The step function is the evidence.** Every documented GKV HBH-E treatment dated before
 * 2026-08-10 sits at €17.97 and every one dated on or after it sits at €20.00 — including the ones
 * documented on 2026-08-11/12, i.e. *before the price entry itself was created on 2026-08-15*. Those
 * are exactly the rows the bug used to strand.
 *
 * **The trap:** a few HBH-E rows in the same window read €24.00. They are not un-repriced — they are
 * private-insurance VOs resolving the PRIVAT tariff, which a GKV-only entry must not touch. Every
 * assertion here is scoped by the VO's `insuranceType`.
 */

const CODE = 'HBH-E';
const TREATMENT_ID = 11;

/** The PM's retroactive entry (id 2698) and the GKV price it superseded. */
const EFFECTIVE_DATE = '2026-08-10';
const NEW_GKV_PRICE = 20;
const OLD_GKV_PRICE = 17.97;
/** HBH-E's PRIVAT tariff — untouched by a GKV-scoped entry. */
const PRIVAT_PRICE = 24;

/** The four treatments the PM's notes name, by `ActivityTreatment` id. */
const REPRICED = [860470, 860445, 860443];
const CONTROL_BEFORE_EFFECTIVE = 860309;

const WINDOW_FROM = '2026-07-20';
const WINDOW_TO = '2026-08-21';

test.describe('Retroactive price recompute — standing state (#3378, read-only)', () => {
  let prices: TreatmentPricesPage;

  test.beforeEach(async ({ page }) => {
    prices = new TreatmentPricesPage(page);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForAuthState(page);
  });

  test(
    'the retroactive price entry is still in place, over an older GKV price',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.setTimeout(180_000);

      const treatment = await prices.treatmentByCode(CODE);
      expect(treatment.id, `${CODE} is treatment ${TREATMENT_ID}`).toBe(TREATMENT_ID);

      const history = await prices.priceHistory(treatment.id);
      const gkv = history
        .filter((entry) => entry.tariffType === 'GKV')
        .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

      console.log(
        `[#3378] ${CODE} GKV history: ` +
          gkv.slice(0, 5).map((e) => `${e.effectiveDate.slice(0, 10)}=${e.price}`).join(' | '),
      );

      const retroactive = gkv[0];
      expect(retroactive.effectiveDate.slice(0, 10), 'the retroactive entry sits on top of the GKV history').toBe(
        EFFECTIVE_DATE,
      );
      expect(Number(retroactive.price), 'its price').toBe(NEW_GKV_PRICE);
      expect(Number(gkv[1].price), 'the GKV price it superseded').toBe(OLD_GKV_PRICE);

      // Without this fixture in place nothing below would mean anything, so it is asserted first.
      expect(new Date(retroactive.effectiveDate) < new Date(), 'the entry is retroactive, not future-dated').toBe(true);
    },
  );

  test(
    'AC1/AC6 — the treatments the ticket names sit either side of the effective date',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.setTimeout(180_000);

      const readings = await prices.resolvedTariffsById([...REPRICED, CONTROL_BEFORE_EFFECTIVE]);
      console.log(`[#3378] named fixtures: ${JSON.stringify(readings)}`);

      // AC1 — documented 11–12 Aug, i.e. after the effective date but BEFORE the entry was created
      // on 15 Aug. These are precisely the rows the bug used to leave behind.
      for (const id of REPRICED) {
        expect(readings[id], `treatment ${id} was repriced to the retroactive price`).toBe(NEW_GKV_PRICE);
      }

      // AC6 — documented 4 Aug, before the effective date: the entry must not reach back past it.
      expect(
        readings[CONTROL_BEFORE_EFFECTIVE],
        `control ${CONTROL_BEFORE_EFFECTIVE} predates the effective date and keeps the old price`,
      ).toBe(OLD_GKV_PRICE);
    },
  );

  test(
    'AC1/AC6 — every documented GKV treatment in the window steps exactly at the effective date',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.setTimeout(600_000);

      const rows = await prices.documentedTreatments(CODE, WINDOW_FROM, WINDOW_TO, 60, 12);
      expect(rows.length, 'the window must hold documented treatments to judge').toBeGreaterThan(10);

      const insurance = await prices.prescriptionInsurance([...new Set(rows.map((r) => r.prescriptionId))]);
      const gkvRows = rows.filter((r) => insurance[r.prescriptionId] === 'public');
      const privateRows = rows.filter((r) => insurance[r.prescriptionId] === 'private');

      const before = gkvRows.filter((r) => r.date.slice(0, 10) < EFFECTIVE_DATE);
      const onOrAfter = gkvRows.filter((r) => r.date.slice(0, 10) >= EFFECTIVE_DATE);

      const byDate: Record<string, number[]> = {};
      for (const row of gkvRows) (byDate[row.date.slice(0, 10)] ||= []).push(row.resolvedTariff);
      console.log(
        `[#3378] ${rows.length} ${CODE} treatments ${WINDOW_FROM}…${WINDOW_TO} — ` +
          `${gkvRows.length} GKV (${before.length} before / ${onOrAfter.length} on-or-after ${EFFECTIVE_DATE}), ` +
          `${privateRows.length} private`,
      );
      for (const date of Object.keys(byDate).sort()) console.log(`[#3378]   ${date}  ${JSON.stringify(byDate[date])}`);

      expect(before.length, 'the window must straddle the effective date').toBeGreaterThan(0);
      expect(onOrAfter.length, 'the window must straddle the effective date').toBeGreaterThan(0);

      const staleAfter = onOrAfter.filter((r) => r.resolvedTariff !== NEW_GKV_PRICE);
      const movedBefore = before.filter((r) => r.resolvedTariff !== OLD_GKV_PRICE);

      // The whole ticket in one assertion: nothing on or after the effective date may still hold the
      // old price, and nothing before it may have been dragged to the new one.
      expect(
        staleAfter.map((r) => `${r.activityTreatmentId}@${r.date.slice(0, 10)}=${r.resolvedTariff}`),
        `every GKV ${CODE} treatment on or after ${EFFECTIVE_DATE} must hold ${NEW_GKV_PRICE}`,
      ).toEqual([]);
      expect(
        movedBefore.map((r) => `${r.activityTreatmentId}@${r.date.slice(0, 10)}=${r.resolvedTariff}`),
        `every GKV ${CODE} treatment before ${EFFECTIVE_DATE} must still hold ${OLD_GKV_PRICE}`,
      ).toEqual([]);
    },
  );

  test(
    'the recompute stayed inside the entry\'s tariff type — private treatments were not touched',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.setTimeout(600_000);

      const rows = await prices.documentedTreatments(CODE, WINDOW_FROM, WINDOW_TO, 60, 12);
      const insurance = await prices.prescriptionInsurance([...new Set(rows.map((r) => r.prescriptionId))]);
      const privateRows = rows.filter((r) => insurance[r.prescriptionId] === 'private');

      test.skip(privateRows.length === 0, `no private-insurance ${CODE} treatment in ${WINDOW_FROM}…${WINDOW_TO}`);

      console.log(
        `[#3378] ${privateRows.length} private ${CODE} treatments: ` +
          privateRows.map((r) => `${r.date.slice(0, 10)}=${r.resolvedTariff}`).join(' '),
      );

      // The entry is GKV-scoped. A recompute that ignored tariff type would have pulled these to 20.
      const wrong = privateRows.filter((r) => r.resolvedTariff !== PRIVAT_PRICE);
      expect(
        wrong.map((r) => `${r.activityTreatmentId}@${r.date.slice(0, 10)}=${r.resolvedTariff}`),
        `private ${CODE} treatments must keep the PRIVAT tariff ${PRIVAT_PRICE}, untouched by a GKV entry`,
      ).toEqual([]);
    },
  );

  test(
    'AC4 — repriced treatments are corrected regardless of billing state',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.setTimeout(600_000);

      const rows = await prices.documentedTreatments(CODE, EFFECTIVE_DATE, WINDOW_TO, 40, 10);
      const prescriptionIds = [...new Set(rows.map((r) => r.prescriptionId))];
      const batches = await prices.billingBatchCounts(prescriptionIds);
      const batched = rows.filter((r) => (batches[r.prescriptionId] ?? 0) > 0);

      console.log(
        `[#3378] ${rows.length} repriced treatments across ${prescriptionIds.length} VOs — ` +
          `${batched.length} sit on a VO already in a billing batch`,
      );

      // Data-gated, and honestly so: nothing on staging pins a repriced HBH-E treatment to a billed
      // VO, so AC4's "in ALL billing states" cannot be demonstrated positively from read-only data.
      // The write-based companion spec reaches it through a VO that is already batched.
      test.skip(
        batched.length === 0,
        `no repriced ${CODE} treatment sits on a VO in a billing batch (all ${prescriptionIds.length} VOs have billingBatchCount 0)`,
      );

      const stale = batched.filter((r) => r.resolvedTariff !== NEW_GKV_PRICE);
      expect(
        stale.map((r) => `${r.activityTreatmentId} (VO ${r.prescriptionId}, ${batches[r.prescriptionId]} batches)`),
        'a treatment already in a billing batch must be repriced like any other',
      ).toEqual([]);
    },
  );

  /**
   * AC2 (bulk upload), AC3 (deleting an entry re-resolves to the next applicable price) and AC5 (the
   * admin sees how many treatments were updated) all require *saving* something, which this spec
   * deliberately does not do. They are covered by the companion
   * `sa_retroactive_price_recompute.spec.ts`, whose POST/DELETE round trip is self-restoring and
   * reads `retroactiveTreatmentsUpdated` off the response — except AC2, which has no HTTP surface
   * separate from the CSV upload form.
   *
   * AC7/AC8 are the one-time production correction, `app:backfill-incorrect-price-snapshots --all`
   * with a `--dry-run` preview — a console command against production data, with no browser surface
   * and no way to undo it.
   */
  test.fixme(
    'AC2/AC5 (need a write) and AC7/AC8 (console command against production)',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      // Read-only by request; the write paths live in sa_retroactive_price_recompute.spec.ts.
    },
  );
});
