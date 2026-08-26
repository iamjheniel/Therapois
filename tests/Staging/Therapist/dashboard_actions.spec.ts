import { test, expect } from '@playwright/test';
import { TherapistBoardV2Page } from '../../../Pages/therapist/therapist.board-v2.page';

/**
 * Two Therapist dashboard controls, both re-homed by the board redesign:
 *
 *   - **The review reminders.** These used to be yellow "Überprüfen" banners above the patient list.
 *     That surface is gone; the same three reminders ("N Patienten seit 14+ Tagen nicht behandelt",
 *     "N VOs laufen in 14 Tagen aus", "N Therapieberichte fällig") are now sections of the
 *     **"Hinweise"** panel, each listing its worst three entries over a "Diese anzeigen" control that
 *     takes the therapist to the affected rows.
 *
 *   - **"Bestellt von"** (Ordered by), which records who ordered the follow-up VO. It moved onto the
 *     bulk action bar that appears once a row is ticked ("N ausgewählt · Auswahl aufheben ·
 *     Doku erfassen (N) · Bestellt von · VO abbrechen · Patient transferieren · Patient teilen"), and
 *     it is **no longer a Therapeut/Admin dropdown** — it sets the status straight to
 *     "Vom Therapeuten" behind a confirmation that spells out what it will change.
 *
 * Read-only. The "Bestellt von" test opens the dropdown and verifies its options but never picks
 * one — selecting an option is a backend mutation. Both tests stay data-gated and skip cleanly when
 * the environment has nothing due / no rows.
 *
 * The Production mirror still drives the older banner surface via
 * `Pages/therapist/therapist.dashboard.page.ts`; mirror this file when Production takes the redesign.
 */

test.describe('Therapist Hinweise reminders', () => {
  test(
    'The Hinweise panel lists the review reminders with their counts',
    { tag: ['@Therapist', '@reviewbanner'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1920, 1080);

      const badge = await board.hinweiseCount();
      console.log(`Hinweise badge: ${badge}`);
      test.skip(!badge, 'No review reminders due in this environment');

      await board.openHinweise();
      const headlines = await board.hinweiseHeadlines();
      console.log(`reminders: ${JSON.stringify(headlines)}`);
      expect(headlines.length, 'a badged Hinweise button must list at least one reminder').toBeGreaterThan(0);

      // Every reminder is actionable — that is what replaced the banners' "Überprüfen" link.
      await expect(
        board.hinweiseShowAll(0),
        'each reminder must offer a "Diese anzeigen" control',
      ).toBeVisible();
    },
  );

  test(
    'The 14-day reminder lists the patients behind it',
    { tag: ['@Therapist', '@reviewbanner'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1920, 1080);
      test.skip(!(await board.hinweiseCount()), 'No review reminders due in this environment');

      await board.openHinweise();
      const headlines = await board.hinweiseHeadlines();
      const gap = headlines.find((h) => /seit 14\+ Tagen nicht behandelt/.test(h));
      test.skip(!gap, 'No "seit 14+ Tagen nicht behandelt" reminder due in this environment');

      // The headline counts the affected patients; the section names the worst few of them.
      const total = parseInt(gap!.match(/^(\d+)/)![1], 10);
      const entries = await board.hinweiseEntries();
      console.log(`"${gap}" → ${entries.length} entries listed: ${JSON.stringify(entries.slice(0, 5))}`);
      expect(entries.length, 'the reminder must name the patients behind its count').toBeGreaterThan(0);
      expect(
        entries.length,
        'and it lists a preview, never more entries than the count it reports',
      ).toBeLessThanOrEqual(total);
    },
  );
});

test.describe('Therapist Bestellt von', () => {
  test(
    'Bestellt von confirms what it will change before writing',
    { tag: ['@Therapist', '@bestelltvon'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new TherapistBoardV2Page(page);
      await board.open(1920, 1080);

      test.skip((await board.rowCount()) === 0, 'No patient row available in this environment');

      // "Bestellt von" only exists once a row is ticked — it acts on the selection.
      await board.selectRow(0);
      expect(await board.selectedCount(), 'ticking one row selects exactly one').toBe(1);

      const actions = await board.selectionActions();
      console.log(`selection bar: ${JSON.stringify(actions)}`);
      for (const action of ['Auswahl aufheben', 'Bestellt von', 'VO abbrechen', 'Patient transferieren']) {
        expect(actions, `the selection bar must offer "${action}"`).toContain(action);
      }

      const confirmation = await board.openBestelltVon();
      console.log(`Bestellt von confirmation: ${JSON.stringify(confirmation)}`);
      const text = confirmation.join(' | ');

      // It must say what it is about to do before it does it: the scope, the resulting status, and
      // the affected VO with its current → new value.
      expect(text, 'the confirmation must name the target status').toContain('Therapeut Bestellt');
      expect(text, 'and how much it will change').toMatch(/\d+ Patienten, \d+ VO\/s werden aktualisiert\./);
      expect(text, 'and which order status it sets').toContain('Vom Therapeuten');
      for (const column of ['Patient', 'VO Nr.', 'Bestellt von']) {
        expect(confirmation, `the confirmation table must list "${column}"`).toContain(column);
      }
      expect(confirmation, 'and it must be dismissable as well as confirmable').toContain('Abbrechen');
      expect(confirmation).toContain('Bestätigen');

      // Deliberately cancelling — confirming would write the order status for the selected VOs.
      await board.cancelBestelltVon();
      await board.clearSelection();
      expect(await board.selectedCount(), '"Auswahl aufheben" drops the selection').toBeNull();
    },
  );
});
