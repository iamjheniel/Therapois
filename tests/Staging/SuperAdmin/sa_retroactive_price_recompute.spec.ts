import { test, expect } from '@playwright/test';
import { TreatmentPricesPage, DocumentedTreatment } from '../../../Pages/superadmin/sa.treatment-prices.page';

/**
 * RC 3.11 — Retroactively Entered Prices Are Not Applied to Already-Documented Treatments (#3378).
 *
 * A treatment's price is snapshotted when it is documented. Before this fix that snapshot was written
 * once and never revisited, so entering a corrected price with an effective date in the past left
 * every treatment already documented in that window billing at the old price (4,767 treatments /
 * €7,378.26 in production, from the 1–23 Jul 2026 Ergotherapie correction). The fix recomputes those
 * snapshots on every write path and reports how many rows it touched.
 *
 * **These tests write, and restore what they write.** There is no read-only way to observe a
 * recompute — it only happens when a price entry is saved. So the round trip is: snapshot the
 * affected rows, create a retroactive entry, assert the repricing, then DELETE the entry, which
 * re-resolves the same rows back to the price that applied before (AC3's own behaviour, used here as
 * the undo). Every test that creates an entry removes it again, and `afterAll` sweeps anything a
 * failure left behind. Nothing is billed, sent, or validated.
 *
 * Fixture: HBH-E (Ergotherapie home visit) — one of the 18 codes in the production incident, and the
 * type the PM already used on staging. The window is chosen to sit entirely BEFORE the existing
 * 2026-08-10 staging entry so the two never interact.
 */

const CODE = 'HBH-E';
const TARIFF = 'GKV';

/** The fixture window. `EFFECTIVE` splits it: rows on/after it must reprice, rows before must not. */
const WINDOW = { from: '2026-07-20', to: '2026-08-09' };
const EFFECTIVE = '2026-07-28';
/** A price no staging entry uses, so a repriced row is unambiguous. */
const TEST_PRICE = 19.11;

/**
 * AC4 needs treatments whose VO is already in a billing batch, and those sit further back than the
 * window above. The effective date is deliberately at the very end of the window: the recompute
 * necessarily covers everything from that date onward, so a late date keeps the set it touches (and
 * the set the delete has to put back) as small as the assertion allows.
 */
const BILLED_WINDOW = { from: '2026-06-01', to: '2026-06-30' };
const BILLED_EFFECTIVE = '2026-06-29';

const onOrAfter = (row: DocumentedTreatment) => row.date.slice(0, 10) >= EFFECTIVE;

test.describe('Retroactive price changes reprice already-documented treatments', () => {
  test.describe.configure({ mode: 'serial' });

  /** Entries created by this file, so a failed test never leaves a price change behind. */
  const created: number[] = [];

  test.afterAll(async ({ browser }) => {
    if (!created.length) return;
    const page = await browser.newPage({ storageState: '.auth/SuperAdmin.json' });
    const prices = new TreatmentPricesPage(page);
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    for (const id of [...created]) {
      const res = await prices.deletePrice(id);
      console.log(`cleanup: DELETE /treatment_price_histories/${id} → ${res.status}`);
    }
    await page.close();
  });

  test(
    'AC1/AC4/AC5 — a past effective date reprices every already-documented treatment it covers',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const prices = new TreatmentPricesPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const treatment = await prices.treatmentByCode(CODE);
      const rows = await prices.documentedTreatments(CODE, WINDOW.from, WINDOW.to, 15);
      console.log(`fixture rows: ${JSON.stringify(rows.map((r) => ({ id: r.activityTreatmentId, d: r.date.slice(0, 10), p: r.resolvedTariff })))}`);

      const after = rows.filter(onOrAfter);
      const before = rows.filter((r) => !onOrAfter(r));
      test.skip(
        after.length === 0,
        `No ${CODE} treatment is documented between ${EFFECTIVE} and ${WINDOW.to} on this ` +
          `environment, so a retroactive entry effective ${EFFECTIVE} would have nothing to reprice. ` +
          `Document one (Doku erfassen) or move the window.`,
      );
      // The control group is what proves the recompute is scoped by date rather than repricing
      // everything of that type — without it, AC6 is the only thing standing between the two.
      console.log(`${after.length} rows on/after ${EFFECTIVE}, ${before.length} before it`);

      const baseline = Object.fromEntries(rows.map((r) => [r.activityTreatmentId, r.resolvedTariff]));

      const posted = await prices.addPrice({
        treatmentId: treatment.id,
        tariffType: TARIFF,
        effectiveDate: EFFECTIVE,
        price: TEST_PRICE,
      });
      expect(posted.status, `POST a ${TARIFF} price for ${CODE} effective ${EFFECTIVE}`).toBe(201);
      created.push(posted.entry.id);
      console.log(`created entry ${posted.entry.id}: ${JSON.stringify(posted.entry)}`);

      // AC5 — the count the admin is shown, carried on the response the frontend renders its toast
      // from ("… bereits dokumentierte Behandlungen wurden neu bepreist").
      expect(
        posted.entry.retroactiveTreatmentsUpdated,
        'the save response must report how many already-documented treatments were updated',
      ).toEqual(expect.any(Number));
      expect(
        posted.entry.retroactiveTreatmentsUpdated,
        `a retroactive entry covering ${after.length} known documented treatments must report a ` +
          `non-zero count`,
      ).toBeGreaterThan(0);
      console.log(`retroactiveTreatmentsUpdated = ${posted.entry.retroactiveTreatmentsUpdated}`);

      await page.waitForTimeout(5000);
      const now = await prices.resolvedTariffs(rows);

      // AC1 — every covered row moved to the new price.
      const stale = after.filter((r) => now[r.activityTreatmentId] !== TEST_PRICE);
      expect(
        stale.map((r) => ({ id: r.activityTreatmentId, date: r.date.slice(0, 10), was: baseline[r.activityTreatmentId], now: now[r.activityTreatmentId] })),
        `every ${CODE} treatment documented on or after ${EFFECTIVE} must be repriced to ` +
          `${TEST_PRICE}; these were not`,
      ).toEqual([]);

      // …and rows documented before the effective date are untouched.
      const wronglyTouched = before.filter((r) => now[r.activityTreatmentId] !== baseline[r.activityTreatmentId]);
      expect(
        wronglyTouched.map((r) => ({ id: r.activityTreatmentId, date: r.date.slice(0, 10), was: baseline[r.activityTreatmentId], now: now[r.activityTreatmentId] })),
        `a treatment documented BEFORE ${EFFECTIVE} must keep its price — the recompute is scoped to ` +
          `the effective date`,
      ).toEqual([]);

      // Billing state of the repriced VOs, for the record — AC4 gets its own test below, on a window
      // chosen so the fixture rows are already billed.
      const batches = await prices.billingBatchCounts([...new Set(after.map((r) => r.prescriptionId))]);
      console.log(`billing-batch counts of repriced VOs: ${JSON.stringify(batches)}`);
    },
  );

  test(
    'AC3 — deleting the entry recomputes the same treatments back to the price that applies next',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const prices = new TreatmentPricesPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const entryId = created[0];
      test.skip(!entryId, 'The previous test did not create a price entry, so there is none to delete.');

      const rows = await prices.documentedTreatments(CODE, WINDOW.from, WINDOW.to, 15);
      const affected = rows.filter(onOrAfter);
      expect(
        affected.every((r) => r.resolvedTariff === TEST_PRICE),
        `the rows repriced by the previous test must still be at ${TEST_PRICE} before the delete, ` +
          `got ${JSON.stringify(affected.map((r) => r.resolvedTariff))}`,
      ).toBe(true);

      const del = await prices.deletePrice(entryId);
      expect(del.status, `DELETE /treatment_price_histories/${entryId}`).toBe(200);
      created.splice(created.indexOf(entryId), 1);
      console.log(`delete recomputed ${del.recomputed} treatments`);
      expect(
        del.recomputed,
        'deleting a retroactive entry must report the treatments it recomputed',
      ).toEqual(expect.any(Number));

      await page.waitForTimeout(5000);
      const now = await prices.resolvedTariffs(rows);

      // AC3: the next applicable price takes over. Here that is the standing GKV entry the fixture
      // rows carried before this file touched anything — which is also what makes the round trip a
      // clean restore rather than a lasting change.
      const stillTestPrice = affected.filter((r) => now[r.activityTreatmentId] === TEST_PRICE);
      expect(
        stillTestPrice.map((r) => r.activityTreatmentId),
        'no treatment may still carry the price of a deleted entry',
      ).toEqual([]);

      const restored = affected.every((r) => now[r.activityTreatmentId] > 0);
      expect(restored, 'every affected treatment must resolve to some applicable price after the delete').toBe(true);
      console.log(
        `after delete: ${JSON.stringify(affected.map((r) => ({ id: r.activityTreatmentId, p: now[r.activityTreatmentId] })))}`,
      );
    },
  );

  test(
    'AC4 — treatments already included in a billing batch are corrected too',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const prices = new TreatmentPricesPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      // The whole point of AC4 is that the recompute carries no billing-status filter, so the fixture
      // has to be a treatment whose VO is ALREADY in a batch. Those sit further back than the window
      // used above, hence a separate window and effective date here.
      const treatment = await prices.treatmentByCode(CODE);
      const rows = await prices.documentedTreatments(CODE, BILLED_WINDOW.from, BILLED_WINDOW.to, 25);
      const counts = await prices.billingBatchCounts([...new Set(rows.map((r) => r.prescriptionId))]);
      const billed = rows.filter(
        (r) => r.date.slice(0, 10) >= BILLED_EFFECTIVE && (counts[r.prescriptionId] ?? 0) > 0,
      );
      console.log(
        `billed fixture rows: ${JSON.stringify(billed.map((r) => ({ id: r.activityTreatmentId, d: r.date.slice(0, 10), vo: r.prescriptionId, batches: counts[r.prescriptionId], p: r.resolvedTariff })))}`,
      );
      test.skip(
        billed.length === 0,
        `No ${CODE} treatment documented on or after ${BILLED_EFFECTIVE} belongs to a VO that is ` +
          `already in a billing batch, so AC4's "already billed" case has no fixture in this window.`,
      );

      const baseline = Object.fromEntries(rows.map((r) => [r.activityTreatmentId, r.resolvedTariff]));
      const posted = await prices.addPrice({
        treatmentId: treatment.id,
        tariffType: TARIFF,
        effectiveDate: BILLED_EFFECTIVE,
        price: TEST_PRICE,
      });
      expect(posted.status, `POST a ${TARIFF} price for ${CODE} effective ${BILLED_EFFECTIVE}`).toBe(201);
      created.push(posted.entry.id);
      console.log(`entry ${posted.entry.id}: retroactiveTreatmentsUpdated = ${posted.entry.retroactiveTreatmentsUpdated}`);

      await page.waitForTimeout(6000);
      const now = await prices.resolvedTariffs(rows);
      const missed = billed.filter((r) => now[r.activityTreatmentId] !== TEST_PRICE);
      expect(
        missed.map((r) => ({ id: r.activityTreatmentId, vo: r.prescriptionId, was: baseline[r.activityTreatmentId], now: now[r.activityTreatmentId] })),
        `a treatment on a VO that is already in a billing batch must be repriced like any other — ` +
          `these were skipped`,
      ).toEqual([]);

      const del = await prices.deletePrice(posted.entry.id);
      expect(del.status, 'removing the AC4 entry again').toBe(200);
      created.splice(created.indexOf(posted.entry.id), 1);
      await page.waitForTimeout(5000);

      const restored = await prices.resolvedTariffs(rows);
      const notRestored = rows.filter((r) => restored[r.activityTreatmentId] !== baseline[r.activityTreatmentId]);
      expect(
        notRestored.map((r) => ({ id: r.activityTreatmentId, was: baseline[r.activityTreatmentId], now: restored[r.activityTreatmentId] })),
        'the delete must put every row back on the price it had before this test',
      ).toEqual([]);
    },
  );

  test(
    'AC6 — an entry effective today does not reprice anything already documented',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const prices = new TreatmentPricesPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const treatment = await prices.treatmentByCode(CODE);
      const rows = await prices.documentedTreatments(CODE, WINDOW.from, WINDOW.to, 15);
      const baseline = Object.fromEntries(rows.map((r) => [r.activityTreatmentId, r.resolvedTariff]));

      // "Today or later" is the case that was already correct before this ticket and must stay that
      // way: the new price only applies to treatments documented from that date onward.
      const today = new Date().toISOString().slice(0, 10);
      const posted = await prices.addPrice({
        treatmentId: treatment.id,
        tariffType: TARIFF,
        effectiveDate: today,
        price: TEST_PRICE,
      });
      expect(posted.status, `POST a ${TARIFF} price for ${CODE} effective today (${today})`).toBe(201);
      created.push(posted.entry.id);
      console.log(`entry ${posted.entry.id} effective ${today}: retroactiveTreatmentsUpdated = ${posted.entry.retroactiveTreatmentsUpdated}`);

      expect(
        posted.entry.retroactiveTreatmentsUpdated,
        `an entry effective today must not recompute treatments documented before today, but it ` +
          `reported ${posted.entry.retroactiveTreatmentsUpdated}`,
      ).toBe(0);

      await page.waitForTimeout(4000);
      const now = await prices.resolvedTariffs(rows);
      const changed = rows.filter((r) => now[r.activityTreatmentId] !== baseline[r.activityTreatmentId]);
      expect(
        changed.map((r) => ({ id: r.activityTreatmentId, was: baseline[r.activityTreatmentId], now: now[r.activityTreatmentId] })),
        'no already-documented treatment may change when the entry is effective today',
      ).toEqual([]);

      const del = await prices.deletePrice(posted.entry.id);
      expect(del.status, 'removing the same-day entry again').toBe(200);
      created.splice(created.indexOf(posted.entry.id), 1);
    },
  );

  test(
    'AC5 — the price editor offers the effective date a retroactive entry needs',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const prices = new TreatmentPricesPage(page);
      await prices.openHeilmittelverwaltung();

      // The recompute is only reachable from the UI if the admin can date an entry into the past, so
      // the editor's date column is the entry point for AC1/AC5 as a whole. Read-only: edit mode is
      // opened and nothing is saved.
      const beforeEdit = (await page.locator('#root').innerText()) || '';
      expect(beforeEdit, 'the price table lists the tariff columns a price entry changes').toContain('GKV');

      await prices.enterEditMode();
      const inEdit = (await page.locator('#root').innerText()) || '';
      expect(
        inEdit,
        'the price editor must expose a per-row effective date — without it no entry can be dated ' +
          'into the past and the recompute can never be triggered from the UI',
      ).toContain('Effective Date');
      expect(inEdit, 'the editor must offer a save action for the entered prices').toContain('Save All Changes');

      await page.getByText('Discard', { exact: true }).first().click();
      await page.waitForTimeout(2000);
    },
  );

  test(
    'AC2 — a bulk price upload triggers the same recompute',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.fixme(
        true,
        'The bulk path is the CSV import ("CSV importieren", template columns Kurzzeichen, GKV, ' +
          'Beihilfe, Privat, Privat Basis, BG, Price Effective From). Exercising it means uploading a ' +
          'file that rewrites ALL FIVE tariffs of a treatment type at once and creates one price ' +
          'entry per tariff, with no per-entry id in the import response to delete afterwards — so ' +
          'unlike the single-entry path above it cannot be undone by this suite, and a failed run ' +
          'would leave four extra tariff changes on staging. `BulkUpdateTreatmentsController` calls ' +
          'the same shared recompute service asserted in the AC1 test (it bypasses the API Platform ' +
          'processor, which is exactly why the ticket calls out the explicit call). Re-enable when ' +
          'the import response identifies the rows it created.',
      );
    },
  );

  test(
    'AC7/AC8 — the one-time correction of the July 2026 batch',
    { tag: ['@SuperAdmin', '@TreatmentPrices', '@RetroactivePrice'] },
    async () => {
      test.fixme(
        true,
        'AC7 and AC8 are a console command run against production — ' +
          '`app:backfill-incorrect-price-snapshots --all --dry-run` for the preview report, then ' +
          '`--all` live after PM/Stefan/Dennis sign-off (deploy-checklist item #6). Neither the ' +
          'command nor its CSV report has a UI or API surface, so there is nothing a browser suite ' +
          'can drive or read. The prevention half of the ticket — which is what the fix changes in ' +
          'the product — is covered by the tests above.',
      );
    },
  );
});
