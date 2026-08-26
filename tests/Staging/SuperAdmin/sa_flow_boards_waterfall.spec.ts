import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Revenue Waterfall, left half (#3177, epic #3172).
 *
 * The whole point of this ticket is arithmetic consistency with the cards above it, so the tests are
 * built around three exact identities rather than around the rendered strings:
 *   Erarbeitet      == the "Umsatz (behandelt)" card   (AC1)
 *   Validiert       == the "Umsatz validiert" card     (AC1, #3175)
 *   − n. validiert  == Erarbeitet − Validiert          (AC2)
 *
 * AC5 is the interesting one: the Privatanteil badge (revenue ÷ revenue) and the Privatpatient:innen
 * card (patient count ÷ patient count) are two different formulas that are both correct and both on
 * screen at once. The test asserts both exist and are computed independently — it must NOT assert
 * they agree.
 */
test.describe('Flow Boards — Revenue waterfall (Umsatz-Realisierung)', () => {
  test(
    'AC1/AC2 — Erarbeitet → − n. validiert → Validiert reconcile exactly with the KPI cards',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsWaterfall'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      await expect(
        page.getByText('Umsatz-Realisierung · erarbeitet → realisiert', { exact: true }),
      ).toBeVisible({ timeout: 20_000 });

      // AC1: the three live steps, left to right
      for (const step of FlowBoardsPage.WATERFALL_LIVE) {
        await expect(page.getByText(step, { exact: true }).first(), `step "${step}"`).toBeVisible();
      }

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      const treatedCard = FlowBoardsPage.parseNumber(await board.valueUnder('Umsatz (behandelt)'));
      const validatedCard = FlowBoardsPage.parseNumber(await board.valueUnder('Umsatz validiert'));
      const erarbeitet = FlowBoardsPage.parseNumber(await board.waterfallStepValue('Erarbeitet'));
      const validiert = FlowBoardsPage.parseNumber(await board.waterfallStepValue('Validiert'));
      const notValidated = FlowBoardsPage.parseNumber(
        await board.waterfallStepValue('− n. validiert'),
      );

      // AC1: the outer steps must match their cards exactly, not approximately
      expect(
        erarbeitet,
        `the "Erarbeitet" step (${erarbeitet}) must equal the Umsatz (behandelt) card (${treatedCard})`,
      ).toBe(treatedCard);
      expect(
        validiert,
        `the "Validiert" step (${validiert}) must equal the Umsatz validiert card (${validatedCard})`,
      ).toBe(validatedCard);

      // AC2: the middle step is derived, never computed independently.
      //
      // Compared to within 1, not exactly: all three figures are euro amounts the board rounds for
      // DISPLAY, so the derived step is round(a − b) while this computes round(a) − round(b). Those
      // differ by 1 whenever the two fractional parts straddle a boundary (seen live: 625 against
      // 667 − 43 = 624). A tolerance of 1 still catches a step computed from a different population,
      // which is what AC2 is actually guarding.
      expect(notValidated, '"− n. validiert" step').not.toBeNull();
      expect(
        Math.abs(Math.abs(notValidated!) - (erarbeitet! - validiert!)),
        `"− n. validiert" (${notValidated}) must be Erarbeitet (${erarbeitet}) − Validiert (${validiert}), ` +
          'within the 1-euro rounding of the displayed figures',
      ).toBeLessThanOrEqual(1);
    },
  );

  test(
    'AC3 — the 5 steps beyond Validiert are "In Vorbereitung" placeholders with no values',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsWaterfall'] },
    async ({ page }) => {
      const board = new FlowBoardsPage(page);
      await board.open();
      await board.waitForBoardLoaded();

      for (const step of FlowBoardsPage.WATERFALL_COMING_SOON) {
        await expect(page.getByText(step, { exact: true }).first(), `step "${step}"`).toBeVisible({
          timeout: 20_000,
        });
        expect(
          await board.waterfallStepValue(step),
          `"${step}" must show a placeholder, not a value`,
        ).toBe('In Vorbereitung');
      }
    },
  );

  test(
    'AC4/AC5 — Privatanteil is live and revenue-based, while Realisierungsquote and Absetzungsquote are placeholders',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsWaterfall'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      // AC4: 3 header badges — one live, two not
      const badge = await board.privatanteilBadge();
      expect(badge, 'the Privatanteil badge must show a live percentage').toMatch(/\d+,\d+\s*%/);

      const flat = await board.boardText();
      const badgeRegion = flat.slice(
        flat.indexOf('Umsatz-Realisierung'),
        flat.indexOf('Privatanteil:'),
      );
      for (const b of ['Realisierungsquote', 'Absetzungsquote']) {
        expect(badgeRegion, `badge "${b}" must be present in the waterfall header`).toContain(b);
      }
      expect(
        badgeRegion.match(/\d+,\d+\s*%/g),
        `neither coming-soon badge may show a value, got ${JSON.stringify(badgeRegion)}`,
      ).toBeNull();

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // AC5: two different, independently correct formulas coexist. Assert both are present and
      // each is bounded by its own definition — deliberately NOT that they agree.
      const cardShare = FlowBoardsPage.parseNumber(await board.valueUnder('Privatpatient:innen'));
      const badgeShare = FlowBoardsPage.parseNumber(badge);
      expect(cardShare, 'the patient-count-based Privatpatient:innen card').not.toBeNull();
      expect(badgeShare, 'the revenue-based Privatanteil badge').not.toBeNull();
      expect(cardShare!, 'Privatpatient:innen is a share, so 0–100 %').toBeGreaterThanOrEqual(0);
      expect(cardShare!).toBeLessThanOrEqual(100);
      expect(badgeShare!, 'Privatanteil is a share, so 0–100 %').toBeGreaterThanOrEqual(0);
      expect(badgeShare!).toBeLessThanOrEqual(100);

      // AC6: validated private VOs sit inside the Validiert step itself — there is no separate
      // deduction step for them, so no extra live step may appear between the three live ones.
      const waterfallRegion = flat.slice(
        flat.indexOf('Privatanteil:'),
        flat.indexOf('Verlauf nach Gruppe'),
      );
      expect(
        waterfallRegion,
        'the left half must not contain a private-VO deduction/re-addition step',
      ).not.toMatch(/−\s*Privat|Privat abziehen/);
    },
  );

  test(
    'AC1 — the waterfall follows the filter bar in lockstep with the cards',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsWaterfall'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      for (const type of ['GKV', 'PKV'] as const) {
        await board.setPatientType(type);
        const card = FlowBoardsPage.parseNumber(await board.valueUnder('Umsatz (behandelt)'));
        const step = FlowBoardsPage.parseNumber(await board.waterfallStepValue('Erarbeitet'));
        expect(
          step,
          `under the ${type} filter the Erarbeitet step (${step}) must still equal the ` +
            `Umsatz (behandelt) card (${card})`,
        ).toBe(card);

        const vCard = FlowBoardsPage.parseNumber(await board.valueUnder('Umsatz validiert'));
        const vStep = FlowBoardsPage.parseNumber(await board.waterfallStepValue('Validiert'));
        expect(
          vStep,
          `under the ${type} filter the Validiert step (${vStep}) must still equal the ` +
            `Umsatz validiert card (${vCard})`,
        ).toBe(vCard);
      }
    },
  );
});
