import { test, expect } from '@playwright/test';
import {
  ToOverviewOperativPage,
  OPERATIV_COLUMNS,
  DETAILS_COLUMNS,
  I18N,
} from '../../../Pages/superadmin/sa.to-overview-operativ.page';

/**
 * RC 3.14 (#3770, commit `73d5801cc` / PR #3781) — the Therapeuten-Orga board's working-hours table
 * opens on the 5-column **Operativ** view, "Standard" is relabelled **"Details"**, and the section
 * heading becomes **"Übersicht"**.
 *
 * **Deployed; all five ACs verified. 7 passed, 0 `fixme`.**
 *
 * **`GET /status` cannot answer for this ticket at all.** It reports the API release — `3.14.0` on
 * both sides of this change — while #3770 touches nothing but `WorkingHoursTable.tsx` and two
 * dictionary values. The frontend bundle deploys independently (#3705), so the two probes that CAN
 * decide it are the served dictionary and the columns the table paints, and both are asserted.
 *
 * **The i18n KEYS did not change, only their values** — `flowBoards.standard` now reads "Details"
 * and `flowBoards.arbeitszeiten` reads "Übersicht". A probe hunting for a `flowBoards.details` or
 * `flowBoards.uebersicht` key finds nothing and concludes the rename never shipped; the commit says
 * so outright ("the `standard` column-mode key stays as it is — only its label moved").
 *
 * **The rename is scoped, and that is asserted rather than assumed.** Two other keys still hold the
 * old words on purpose: `performanceDashboard.subTabs.workingHours` = "Arbeitszeiten" (the TO
 * Verwaltung sub-tab, a different screen) and `crm.lead_time.source_standard` = "Standard". They are
 * the control that this was a targeted re-value and not a blanket find-and-replace — which, on a
 * ticket whose whole diff is four dictionary lines, is the failure mode worth guarding.
 *
 * **THE TRAP, and it makes the AC's own wording unmatchable:** the headers are CSS-uppercased and
 * **German ß uppercases to SS**, so `innerText` yields `MASSNAHME` — matching neither `/Maßnahme/`
 * nor `/Maßnahme/i`, because simple case folding does not equate ß with SS (#3718 hit this first).
 * `textContent` keeps the shipped `Maßnahme`. The ticket's Localization Reference writes
 * "Massnahme" with ss, i.e. the PAINTED form, so an assertion written from the AC literal fails on a
 * correct implementation. Both readings are taken and logged side by side.
 *
 * **AC2's English half is settled by the dictionary, and it is a deliberate divergence:** the
 * English interface reads **"Operativ"**, not "Operational" — the commit records that as one of two
 * readings it had to resolve, against AC2 and the Localization Reference, which give the German word
 * for both languages. `en.json`'s old "Operational" is gone from the bundle entirely.
 *
 * **A consequence no AC mentions, and it broke a sibling spec the day this shipped:** Operativ's
 * five columns FIT, so the table has **no horizontal scroller at all** in the default view. #3718's
 * frozen-name-column geometry test measures a name holding its place while columns scroll past, and
 * it failed with "the table has a horizontal scroller / Received: null" — which reads like the
 * frozen column being gone rather than like the table having become narrow. `#3718`'s page object
 * now selects Details first. Reported as a finding: **#3718's shipped behaviour is invisible in the
 * view the board now opens on.**
 *
 * **Read-only** — the board is opened and read; the only interaction is the column toggle, which is
 * local state and is restored by a reload.
 */

test.describe('#3770 Therepeuten-Orga Übersicht opens on Operativ', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: the dictionary carries all four re-valued strings, in both locales',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const to = new ToOverviewOperativPage(page);
      const { de, en, url } = await to.dictionaries();
      console.log(
        `#3770 dictionary (${url.split('/').pop()}): ` +
          `${I18N.heading}=de ${JSON.stringify(de[I18N.heading])}/en ${JSON.stringify(en[I18N.heading])} | ` +
          `${I18N.details}=de ${JSON.stringify(de[I18N.details])}/en ${JSON.stringify(en[I18N.details])} | ` +
          `${I18N.operativ}=de ${JSON.stringify(de[I18N.operativ])}/en ${JSON.stringify(en[I18N.operativ])}`,
      );

      // AC5, both interfaces.
      expect(de[I18N.heading], 'AC5: the German section heading').toBe('Übersicht');
      expect(en[I18N.heading], 'AC5: and the English one').toBe('Overview');
      // AC2, both interfaces — the key name is unchanged, which is the whole trap.
      expect(de[I18N.details], 'AC2: "Standard" is relabelled, under its old key').toBe('Details');
      expect(en[I18N.details], 'AC2: and in English too').toBe('Details');
      expect(de[I18N.operativ], 'AC2: the other option is unchanged').toBe('Operativ');
      // A deliberate divergence the commit documents: English reads the German word, per AC2 and
      // the Localization Reference. "Operational" is gone from the dictionary entirely.
      expect(en[I18N.operativ], 'AC2: the English interface reads "Operativ", not "Operational"').toBe('Operativ');
    },
  );

  test(
    'AC2/AC5 the rename is SCOPED — the two keys that legitimately still say "Arbeitszeiten" and "Standard" are untouched',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const to = new ToOverviewOperativPage(page);
      const { de } = await to.dictionaries();

      // On a ticket whose entire diff is four dictionary values, the realistic failure is a blanket
      // find-and-replace catching unrelated screens. These two are the control.
      const stillArbeitszeiten = await to.keysHolding('Arbeitszeiten');
      const stillStandard = await to.keysHolding('Standard');
      console.log(`#3770 scope: de keys still reading "Arbeitszeiten" = ${JSON.stringify(stillArbeitszeiten)}`);
      console.log(`#3770 scope: de keys still reading "Standard" = ${JSON.stringify(stillStandard)}`);

      expect(stillArbeitszeiten, 'the TO Verwaltung sub-tab keeps its own name').toEqual([I18N.untouchedHeading]);
      expect(stillStandard, 'and the CRM lead-time source keeps "Standard"').toEqual([I18N.untouchedStandard]);
      expect(de[I18N.untouchedHeading], 'a different screen, deliberately unchanged').toBe('Arbeitszeiten');
      expect(de[I18N.untouchedStandard], 'and so is this one').toBe('Standard');
    },
  );

  test(
    'AC1 the table opens on Operativ: exactly the five columns the AC names, and no others',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const to = new ToOverviewOperativPage(page);
      await to.open();

      const { authored, painted } = await to.columnHeaders();
      console.log(`#3770 AC1 default columns (textContent): ${JSON.stringify(authored)}`);
      console.log(`#3770 AC1 default columns (innerText, CSS-uppercased): ${JSON.stringify(painted)}`);

      // The name column ("Gruppe" or "Therapeut:in" depending on the view toggle) is always there
      // and is not one of AC1's five, so it is dropped before comparing.
      const data = authored.filter((h) => h !== 'Gruppe' && h !== 'Therapeut:in');
      expect(data, 'AC1: the Operativ five, in order, and nothing else').toEqual([...OPERATIV_COLUMNS]);

      // The AC's own spelling is the PAINTED one, and the two readings genuinely differ — pinned
      // here so the next person to write an assertion from the ticket text knows why it failed.
      expect(painted, 'innerText: the CSS-uppercased form, which is what the AC quotes').toContain('MASSNAHME');
      expect(authored, 'textContent: the shipped string, with the eszett').toContain('Maßnahme');
      expect(painted, 'and the shipped spelling is NOT what the screen shows').not.toContain('Maßnahme');
    },
  );

  test(
    'AC3 "Details" still shows all 15 columns, unchanged from the old "Standard" view',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const to = new ToOverviewOperativPage(page);
      await to.open();
      await to.setColumnMode('Details');

      const { authored } = await to.columnHeaders();
      const data = authored.filter((h) => h !== 'Gruppe' && h !== 'Therapeut:in');
      console.log(`#3770 AC3 Details columns (${data.length}): ${JSON.stringify(data)}`);

      expect(data.length, 'AC3: all 15').toBe(15);
      expect(data, 'AC3: in the order the old Standard view had them').toEqual([...DETAILS_COLUMNS]);
      // AC1's five are a strict subset — the ticket changes which view opens, never what is in one.
      for (const column of OPERATIV_COLUMNS)
        expect(data, `Operativ's "${column}" is one of the 15, not a separate column set`).toContain(column);
    },
  );

  test(
    'AC2 the toggle offers "Operativ" and "Details" — and "Standard" is gone from the control',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const to = new ToOverviewOperativPage(page);
      await to.open();

      const labels = await to.toggleLabels();
      console.log(`#3770 AC2 toggles, in painted order: ${JSON.stringify(labels)}`);

      expect(labels, 'AC2: the renamed option').toContain('Details');
      expect(labels, 'AC2: beside the unchanged one').toContain('Operativ');
      expect(labels, 'AC2: "Standard" no longer appears').not.toContain('Standard');
      // Out of Scope is explicit that the Gruppen / Therapeut:innen toggle does not move.
      expect(labels, 'the view toggle is untouched').toEqual(expect.arrayContaining(['Gruppen', 'Therapeut:innen']));
      // The commit resolved the toggle's ORDER as unchanged (Details then Operativ), reading Out of
      // Scope as covering only the rename and following the ticket's target screenshot.
      expect(labels.indexOf('Details'), 'Details still precedes Operativ').toBeLessThan(labels.indexOf('Operativ'));
    },
  );

  test(
    'AC4 a reload returns to Operativ — a Details selection does not survive it',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const to = new ToOverviewOperativPage(page);
      // Reload-safe session: mintUiSession's refresh token is single-use, so a plain reload logs
      // out and the empty table reads as AC4 passing for the wrong reason.
      await to.open({ reloadSafe: true });

      await to.setColumnMode('Details');
      const before = (await to.columnHeaders()).authored.filter((h) => h !== 'Gruppe' && h !== 'Therapeut:in');
      expect(before.length, 'Details is selected before the reload').toBe(15);

      // AC4 is a statement ABOUT #3761: that ticket persists the board, the Gesellschaft and the
      // per-board filter slices in sessionStorage, and this toggle is deliberately not among them.
      // So the reload has to be a real one, in the same tab, with #3761's state intact — otherwise
      // the test proves only that a fresh tab starts fresh, which no AC disputes.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
      await to.waitForTable();

      const after = (await to.columnHeaders()).authored.filter((h) => h !== 'Gruppe' && h !== 'Therapeut:in');
      console.log(`#3770 AC4: before reload ${before.length} columns, after reload ${after.length} — ${JSON.stringify(after)}`);
      expect(after, 'AC4: back to Operativ, not the Details view that was selected').toEqual([...OPERATIV_COLUMNS]);
    },
  );

  test(
    'FINDING: the Operativ default removes the table\'s horizontal scroll, so #3718\'s frozen column has nothing to do by default',
    { tag: ['@SuperAdmin', '@OperativDefault', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const to = new ToOverviewOperativPage(page);
      await to.open();

      const operativScroll = await to.maxScroll();
      await to.setColumnMode('Details');
      const detailsScroll = await to.maxScroll();
      console.log(`#3770 FINDING: max horizontal scroll — Operativ ${operativScroll}px, Details ${detailsScroll}px`);

      // Not a defect in #3770: the five columns fitting is the point of the ticket. But #3718
      // shipped a `position: sticky` name column three days earlier, and a sticky column is only
      // observable against columns that move — so the feature is now invisible in the view the
      // board opens on, and only applies once an admin switches to Details. #3718's own spec failed
      // the day this shipped ("the table has a horizontal scroller / Received: null"), which reads
      // like the frozen column being gone rather than like the table having become narrow; its page
      // object now selects Details first.
      expect(detailsScroll, 'Details overflows, so the frozen column still matters there').toBeGreaterThan(200);
      expect(
        operativScroll ?? 0,
        'while Operativ fits — reported for the PM, not asserted as a defect',
      ).toBeLessThan(detailsScroll as number);
    },
  );
});
