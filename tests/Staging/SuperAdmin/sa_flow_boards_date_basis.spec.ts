import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';
import { STAGING_CREDENTIALS, mintUiSession } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — "by treatment date" note on the Management board revenue charts (#3400).
 *
 * Both revenue charts bucket by the date the treatment happened, not by billing or validation date,
 * so a month still being treated legitimately shows a low validated share. An admin read that as a
 * bug (WhatsApp, 12 Aug 2026). The fix is a persistent subtitle **"nach Behandlungsdatum"** under
 * each chart title plus a click-to-open explanation.
 *
 * **Deployed on staging** (verified 2026-08-31, app v3.12.0). It shipped inside commit `e87c91bad`
 * as `ChartDateBasisNote`, not through PR #3455 — that PR's diff had already collapsed to a lint
 * fix by the time it merged, so looking for the change under its own PR finds nothing.
 *
 * **What makes these assertions worth making.** Three of the four ACs are about *how* the
 * information is reachable, not that it exists, so each is tested against the failure it forbids:
 *  - AC1/AC4 — the subtitle must be visible with no interaction and sit **directly under the
 *    title**, which is measured (title bottom → subtitle top, and the left edges), not inferred
 *    from DOM order.
 *  - AC2/AC3 — a hover-only tooltip is the thing being ruled out, so hovering is asserted to do
 *    **nothing** at both desktop and tablet width, while click, Enter and Space all open it.
 *  - AC2 — all three dismissal routes (Escape, the close control, clicking away) are exercised
 *    separately; one working route would otherwise hide two broken ones.
 *
 * **Read-only** — the board is only viewed; nothing here writes.
 *
 * The component renders inside the chart header even when the board's aggregations fail (defect
 * #3233), so unlike the other Flow Boards specs this file needs no data gate.
 */

const NOTE = FlowBoardsPage.DATE_BASIS;

/** Tablet width from AC3; the PM verified at exactly this size. */
const TABLET = { width: 1024, height: 768 };

/**
 * The narrowest width the shipped component claims to handle. The PR records that Paper's
 * right-aligned branch let the popover run to x = -70 here before the anchor was moved onto the
 * whole row, so this is a regression guard with a known failure mode.
 */
const NARROW = { width: 500, height: 900 };

async function openBoard(page: import('@playwright/test').Page): Promise<FlowBoardsPage> {
  // A saved storageState no longer boots logged in on this build (the v3.12 auth migration), so the
  // session is minted before the first navigation.
  await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
  const board = new FlowBoardsPage(page);
  await board.open();
  await expect(page.getByText(NOTE.subtitle, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  // The note renders before the data does, but the board repaints as its five aggregations land and
  // a click that arrives mid-repaint is swallowed. Waiting for the KPI cards to settle first is what
  // separates "the ⓘ does nothing" from "the click was lost". A false return is defect #3233 (the
  // board silently settling on the empty state), which does not affect the chart headers.
  const loaded = await board.waitForBoardLoaded(45_000);
  if (!loaded) console.log('board settled on the empty state (#3233) — the chart headers still render');
  return board;
}

test.describe('Flow Boards — revenue charts note their treatment-date basis', () => {
  test(
    'AC1/AC4 — both charts show the subtitle at all times, directly under their titles',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);

      // AC4: before any interaction at all — the subtitle is not hiding inside the popover.
      expect(await board.dateBasisSubtitleCount(), 'both charts must carry the subtitle').toBe(2);
      expect(await board.dateBasisTriggerCount(), 'each subtitle must have its own ⓘ trigger').toBe(2);
      expect(
        await board.dateBasisExplanationCount(),
        'the long explanation must NOT be on screen until it is asked for — the subtitle is what is persistent',
      ).toBe(0);

      // AC1: "directly under their titles" is geometric, so it is measured.
      const placements = await board.dateBasisPlacement();
      for (const placement of placements) {
        console.log(
          `"${placement.title}" -> subtitle at y=${placement.y}, gap ${placement.gap}px, left offset ${placement.leftDelta}px`,
        );
      }
      expect(placements.map((p) => p.owner).sort(), 'one note per revenue chart, and only those two').toEqual(
        [...NOTE.charts].sort(),
      );
      for (const placement of placements) {
        expect(placement.title, `the note in the ${placement.owner} card must sit under a title`).toBeTruthy();
        expect(
          placement.gap!,
          `the ${placement.owner} subtitle is ${placement.gap}px below its title — "directly under" means adjacent, not elsewhere in the card`,
        ).toBeLessThanOrEqual(12);
        expect(placement.gap!, 'and below it, not overlapping it').toBeGreaterThanOrEqual(0);
        expect(
          Math.abs(placement.leftDelta!),
          `the ${placement.owner} subtitle must line up with its title's left edge`,
        ).toBeLessThanOrEqual(4);
      }
    },
  );

  test(
    'AC2 — the ⓘ opens the explanation on click, and hover alone does nothing',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);

      // The ticket's design note is explicit that this must not be a hover tooltip. Hovering is
      // therefore asserted to do nothing — on a hover-only implementation this is what would pass
      // silently while touch and keyboard users saw nothing.
      await board.dateBasisTrigger(0).hover({ force: true, timeout: 30_000 });
      await page.waitForTimeout(2000);
      expect(await board.dateBasisExplanationCount(), 'hovering must not open the explanation').toBe(0);

      expect(await board.openDateBasis(0), 'clicking the ⓘ must open the explanation').toBe(true);

      // The copy itself, not just "something opened": it has to say what the date basis is.
      const popover = page.getByText(NOTE.explanation.slice(0, 60), { exact: false }).first();
      const text = (await popover.innerText()).replace(/\s+/g, ' ').trim();
      console.log(`popover: ${text}`);
      expect(text, 'the explanation must be the ticket\'s copy').toContain(
        'Der Umsatz wird dem Behandlungsdatum zugeordnet, nicht dem Abrechnungs- oder Validierungsdatum',
      );
      expect(text, 'including why a recent month looks low').toContain('niedrigen validierten Anteil');
      expect(text, 'and that it resolves later').toContain('Realisierte Beträge folgen später');

      const attributes = await board.dateBasisTriggerAttributes(0);
      console.log(`trigger attributes: ${JSON.stringify(attributes)}`);
      expect(attributes.role, 'the ⓘ must be a real button, not decorative text').toBe('button');
      expect(attributes['aria-label'], 'and carry an accessible name').toBe(NOTE.subtitle);
    },
  );

  test(
    'AC2 — the popover can be dismissed by Escape, by its close control, and by clicking away',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);

      // All three routes, each from a fresh open: a spec that checks only one can pass while the
      // other two strand the popover on screen.
      expect(await board.openDateBasis(0), 'opened for the Escape case').toBe(true);
      expect(await board.dismissDateBasisWithEscape(), 'Escape must dismiss the popover').toBe(true);

      expect(await board.openDateBasis(0), 'opened for the close-control case').toBe(true);
      expect(await board.closeDateBasisWithControl(), 'the close control must dismiss it').toBe(true);

      expect(await board.openDateBasis(0), 'opened for the click-away case').toBe(true);
      expect(await board.clickAwayFromDateBasis(), 'clicking elsewhere must dismiss it').toBe(true);
    },
  );

  test(
    'AC2 — the ⓘ is reachable and operable from the keyboard',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);

      const attributes = await board.dateBasisTriggerAttributes(0);
      expect(attributes.tabindex, 'the trigger must be in the tab order').toBe('0');

      // The PM left this one open ("the focus path may require multiple Tab presses"), so it is
      // answered with a number rather than an opinion.
      const presses = await board.tabPressesToReachDateBasis();
      console.log(`Tab presses from the top of the board to the first ⓘ: ${presses}`);
      expect(presses, 'the ⓘ must be reachable by tabbing, not focusable only programmatically').toBeGreaterThan(0);

      await board.dateBasisTrigger(0).focus();
      expect(
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid')),
        'the trigger must be able to hold focus',
      ).toBe('date-basis-info');

      await page.keyboard.press('Enter');
      expect(await board.waitForDateBasisState(true), 'Enter on the focused ⓘ must open it').toBe(true);
      expect(await board.dismissDateBasisWithEscape(), 'and Escape must close it again').toBe(true);

      await board.dateBasisTrigger(0).focus();
      await page.keyboard.press('Space');
      expect(await board.waitForDateBasisState(true), 'Space must open it too — it is a button').toBe(true);
      await board.dismissDateBasisWithEscape();
    },
  );

  test(
    'AC3 — at tablet width the note behaves the same: tap to open, never hover',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);
      await page.setViewportSize(TABLET);
      await page.waitForTimeout(3000);

      expect(await board.dateBasisSubtitleCount(), 'both subtitles must survive the narrower layout').toBe(2);
      await board.dateBasisTrigger(0).hover({ force: true, timeout: 30_000 });
      await page.waitForTimeout(2000);
      expect(
        await board.dateBasisExplanationCount(),
        'hover must not open it at tablet width either — that is the interaction AC3 rules out',
      ).toBe(0);

      expect(await board.openDateBasis(0), 'a tap must open it').toBe(true);
      const box = await board.dateBasisPopoverBox();
      console.log(`tablet popover: x=${box?.x} → ${box?.right} in a ${box?.viewport}px viewport`);
      expect(box, 'the popover must be measurable').toBeTruthy();
      expect(box!.width, 'and must actually be painted, not collapsed to a sliver').toBeGreaterThan(100);
      expect(box!.x, 'it must not run off the left edge').toBeGreaterThanOrEqual(0);
      expect(box!.right, 'or the right').toBeLessThanOrEqual(box!.viewport);
      await board.dismissDateBasisWithEscape();
    },
  );

  test(
    'AC3 — the popover stays on screen at a phone-narrow width too',
    { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = await openBoard(page);
      await page.setViewportSize(NARROW);
      await page.waitForTimeout(3000);

      // A specific regression: anchored on the 14px icon, Paper's right-aligned branch clamped only
      // the right edge and the popover started at x = -70 here, cutting off every line. Anchoring on
      // the whole subtitle row is what fixed it.
      expect(await board.dateBasisSubtitleCount(), 'the subtitle must still render').toBe(2);
      expect(await board.openDateBasis(0), 'and still open').toBe(true);
      const box = await board.dateBasisPopoverBox();
      console.log(`narrow popover: x=${box?.x} → ${box?.right} (width ${box?.width}) in ${box?.viewport}px`);
      expect(box!.width, 'the popover must be painted at its full width').toBeGreaterThan(100);
      expect(box!.x, 'and must not start off screen — the pre-fix bug put it at x = -70 here').toBeGreaterThanOrEqual(0);
      expect(box!.right, 'nor end past the right edge').toBeLessThanOrEqual(box!.viewport);
      await board.dismissDateBasisWithEscape();
    },
  );

  test('AC2 — the ⓘ announces its expanded state to assistive technology', { tag: ['@SuperAdmin', '@FlowBoards', '@DateBasisNote'] }, async () => {
    test.fixme(
      true,
      'Small a11y gap, outside the ACs but contrary to the component\'s own intent. ' +
        'ChartDateBasisNote sets accessibilityState={{ expanded: open }} on the trigger with the ' +
        'comment "A disclosure, so assistive tech should announce its state" — but no aria-expanded ' +
        'reaches the DOM on this build, open or closed: the trigger\'s attributes are byte-identical ' +
        'before and after opening (aria-label, role, tabindex, class, data-testid, type, style). A ' +
        'screen-reader user hears "nach Behandlungsdatum, button" and is not told the popover opened. ' +
        'Everything AC2 does require — click, Enter, Space, Escape, close control, click-away — is ' +
        'verified above.',
    );
  });
});
