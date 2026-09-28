import { test, expect } from '@playwright/test';
import {
  COPAYMENT_SUBTABS_ENGLISH,
  DISTINCTIVE,
  GKV_ENGLISH,
  GKV_HEADERS,
  HardcodedGermanPage,
  KEY_LABELS,
  LEFTOVER_ENGLISH,
  PKV_SUBTABS_GERMAN,
} from '../../../Pages/admin/admin.hardcoded-german.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.13 #3611 — the German interface must not render English text that is written straight into a
 * screen. Nine items across the Document/VO Upload screen, the Notifications panel, the GKV/PKV/
 * copayment billing batch tables and the Performance Dashboard.
 *
 * Shipped in two passes: `55ad84cb1` (items 2–9) and `141fc1c92` (item 1, after the first FT failed
 * AC1 and AC7 — the first pass had translated the *native image-source picker* in
 * `UploadDashboard/utils.tsx`, while the AC meant the *modal* on the upload screen; both are dialogs
 * on the same screen and both carry a Cancel).
 *
 * **Read-only** — every test either reads a screen or the served bundle.
 *
 * See the page object for why the screen has to be the oracle for `View`, `Cancel` and `Actions`, and
 * for the two traps (tab labels carry counts; a column label may be a translation key).
 */
test.describe('#3611 hardcoded English strings on the admin screens', () => {
  let screens: HardcodedGermanPage;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(420_000);
    screens = new HardcodedGermanPage(page);
    await screens.signIn(STAGING_CREDENTIALS.superadmin);
  });

  // ─────────────────────────────── the billing batch tables ───────────────────────────────

  test(
    'AC2/AC4/AC5 the GKV batch table is German, and none of the English headers survive',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      await screens.goto('/billing');
      await screens.openBillingTab('GKV-Abrechnung');
      await screens.waitForText('Stapelstatus');

      const german = await screens.present(GKV_HEADERS);
      expect(german, 'every AC4/AC5 header must be German').toEqual([...GKV_HEADERS]);
      // AC2's row action.
      expect(await screens.present(['Ansehen']), 'AC2: the row action reads Ansehen').toEqual(['Ansehen']);

      // And the English predecessors are gone from this screen. `View` and `Actions` are checked
      // here rather than in the bundle because they collide with identifiers there.
      const english = await screens.present(GKV_ENGLISH);
      expect(english, 'no English header or action may remain on the GKV table').toEqual([]);

      // The fix went WIDER than the nine items: these three were flagged by the Developer Reference
      // as the same pattern but left off the list, and they were translated anyway.
      const extras = await screens.present(['Batch-ID', 'IK Nummer', 'Bilder']);
      console.log(`#3611 GKV: German headers ${german.join(', ')}; also translated beyond the list: ${extras.join(', ')}`);
      expect(await screens.present(['Batch ID', 'IK Number']), 'the collateral headers are German too').toEqual([]);
    },
  );

  test(
    'AC4 the PKV and copayment tables carry the one in-scope header in German',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // Only `Sent Date` from the nine items lives in these two column files (one line each), so
      // this is the whole of #3611's footprint on these tables.
      await screens.goto('/billing');
      for (const tab of ['PKV-Abrechnung', 'Zuzahlungsverwaltung'] as const) {
        await screens.openBillingTab(tab);
        await screens.waitForText('Invoice Nr');
        expect(await screens.present(['Gesendet am']), `${tab}: AC4's Sent Date is German`).toEqual(['Gesendet am']);
        expect(await screens.present(['Sent Date']), `${tab}: the English predecessor is gone`).toEqual([]);
      }
    },
  );

  test(
    'a column label that is a translation key resolves to German, it does not render raw',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // `pkvColumns.tsx` mixes `label: 'Patient'` with `label: 'columns.hono_doc'`. The table calls
      // translate() on the label, so a key resolves and plain text falls through unchanged (i18next
      // returns a missing key verbatim). Reading the column files alone therefore suggests a
      // raw-key bug; this test settles that it is not one.
      await screens.goto('/billing');
      await screens.openBillingTab('PKV-Abrechnung');
      await screens.waitForText('Invoice Nr');
      const text = await screens.screenText();
      for (const [key, german] of Object.entries(KEY_LABELS)) {
        if (!text.includes(german) && !text.includes(key)) continue; // that column is not on this tab
        expect(text.includes(key), `${key} must not render as a raw key`).toBe(false);
        expect(text.includes(german), `${key} must resolve to "${german}"`).toBe(true);
      }
      console.log(
        `#3611 key-labels on PKV: ${Object.values(KEY_LABELS).filter((g) => text.includes(g)).join(', ')} — all resolved`,
      );
    },
  );

  // ─────────────────────────────── the other three screens ───────────────────────────────

  test(
    'AC3 the notifications panel title ships in German and the English one is gone',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // Verified on the served bundle rather than the panel: the bell is an icon-only header control
      // with no testid and no accessible name, and it was not reliably locatable in this session.
      // The substance of AC3 is the string, and that IS decidable — `My Notifications` appears in the
      // bundle exactly once and only inside the shipped English dictionary (the AC7 test asserts the
      // 0-outside count), while the German ships alongside it.
      expect(await screens.escapedCount('Meine Benachrichtigungen'), 'the German title ships').toBeGreaterThan(0);
      const english = await screens.literalCounts('My Notifications');
      expect(english.outside, 'no screen writes the English title any more').toBe(0);

      // Opportunistic render check — reported, never asserted, because the control is not addressable.
      await screens.goto('/dashboard');
      await screens.waitForText('Admin Board');
      const bell = screens.bellControl();
      const opened = await bell
        .click({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (opened) {
        await screens.page.waitForTimeout(5_000);
        const text = await screens.screenText();
        console.log(
          `#3611 AC3 on screen: "Meine Benachrichtigungen"=${text.includes('Meine Benachrichtigungen')} ` +
            `"My Notifications"=${text.includes('My Notifications')}`,
        );
        if (text.includes('Benachrichtigung')) {
          expect(text, 'the opened panel is German').toContain('Meine Benachrichtigungen');
          expect(text).not.toContain('My Notifications');
        }
      } else {
        console.log('#3611 AC3: the notification control could not be opened — string verified on the bundle only');
      }
    },
  );

  test(
    'AC6 the button ships the column\'s own wording, and the old wording is gone entirely',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // AC6 is about agreement: the button must use the word the column header above it uses, which
      // #3601 set to "Maßnahme". Both strings are checked in the deployed bundle — in their ESCAPED
      // form, or the grep silently returns 0 (#3337).
      expect(await screens.escapedCount('Maßnahme hinzufügen...'), 'the button label ships').toBeGreaterThan(0);
      expect(await screens.escapedCount('Maßnahme'), 'and the column header wording it must match').toBeGreaterThan(0);
      // The strongest half: the superseded wording is not in the bundle at all, in either locale.
      expect(await screens.escapedCount('Handlungsaufforderung'), 'the old wording is gone from the whole bundle').toBe(0);
      console.log('#3611 AC6: "Maßnahme hinzufügen..." ships; "Handlungsaufforderung" has 0 occurrences anywhere');

      // The TO Verwaltung board did not paint within four minutes in this session, so the on-screen
      // half is attempted and reported rather than asserted.
      await screens.goto('/to-management');
      const painted = await screens.page
        .waitForFunction(() => ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes('Maßnahme'), null, { timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      console.log(`#3611 AC6 on screen: the board painted "Maßnahme" within 120 s: ${painted}`);
      if (painted) {
        const text = await screens.screenText();
        expect(text, 'the old wording must not be on screen either').not.toContain('Handlungsaufforderung');
      }
    },
  );

  test(
    'AC1 the upload dialog footer is German',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // The item the first pass got wrong: the AC means the modal on the upload screen, not the
      // native image-source picker. `141fc1c92` translated the whole footer block of each dialog
      // rather than Cancel alone — "a German Abbrechen beside an English Submit is the same defect
      // one control along".
      await screens.goto('/prescriptionUpload');
      await screens.waitForText('Rezept');
      const opener = screens.page.getByText(/Rezept hochladen/).first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click().catch(() => {});
        await screens.page.waitForTimeout(6_000);
      }
      const text = await screens.screenText();
      console.log(`#3611 AC1: dialog shows Abbrechen=${text.includes('Abbrechen')} Cancel=${/\bCancel\b/.test(text)}`);
      expect(text, 'AC1: the dialog offers Abbrechen').toContain('Abbrechen');
      expect(/\bCancel\b/.test(text), 'AC1: no English Cancel remains on this screen').toBe(false);
      expect(/\bSubmit\b/.test(text), 'and no English Submit beside it').toBe(false);
    },
  );

  // ─────────────────────────────── AC7, in the form a client can run ───────────────────────────────

  test(
    'AC7 the distinctive literals exist only as dictionary values, not as screen code',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // The scan AC7 asks to be re-run, in the only form available from outside the repo: a
      // hardcoded literal appears in the served bundle, and so does the en.json value of the same
      // phrase — so the two are separated by carving the locale modules out and subtracting. This
      // only works for phrases that cannot collide with identifiers; `View`, `Cancel` and `Actions`
      // are verified on screen instead (see the tests above).
      for (const phrase of DISTINCTIVE) {
        const counts = await screens.literalCounts(phrase);
        console.log(
          `#3611 AC7: "${phrase}" — ${counts.total} in the bundle, ${counts.inDictionaries} inside the ` +
            `dictionaries, ${counts.outside} outside`,
        );
        expect(counts.total, `"${phrase}" must still ship as an English dictionary value`).toBeGreaterThan(0);
        expect(counts.outside, `"${phrase}" must no longer be written into a screen`).toBe(0);
      }
    },
  );

  // ─────────────────────────────── findings ───────────────────────────────

  test(
    'FINDING — the PKV and copayment tables still show ~20 English headers each',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // The ACs list nine items and only one of them (`Sent Date`) touches these two tables, so they
      // all pass. The End Goal is wider: "admins ... no longer see English button labels, column
      // headers, or panel titles on ... the GKV/PKV/copayment billing batch tables." The commit is
      // candid about the gap — "The PKV and copayment tables still carry roughly twenty English
      // headers each ... deliberately left in place rather than silently widened into this change."
      // Measured here so the size of it is on the record rather than in a commit message.
      await screens.goto('/billing');
      const counts: Record<string, string[]> = {};
      for (const tab of ['PKV-Abrechnung', 'Zuzahlungsverwaltung'] as const) {
        await screens.openBillingTab(tab);
        await screens.waitForText('Invoice Nr');
        counts[tab] = await screens.present(LEFTOVER_ENGLISH);
        console.log(`#3611 FINDING — ${tab}: ${counts[tab].length} English strings still on screen`);
        console.log(`   ${counts[tab].join(', ')}`);
      }
      // Both tables carry the corrected item sitting in a row of English ones, which is the shape
      // worth showing a PM.
      for (const tab of Object.keys(counts)) {
        expect(counts[tab].length, `${tab} still renders English column headers`).toBeGreaterThan(15);
      }
      expect(await screens.present(['Gesendet am']), 'beside the one header this ticket fixed').toEqual(['Gesendet am']);
    },
  );

  test(
    'FINDING — the copayment tab\'s invoice-status sub-tabs are English where the PKV tab\'s are German',
    { tag: ['@Admin', '@HardcodedGerman', '@ReadOnly'] },
    async () => {
      // Not in #3611's scope either, and a different kind of gap: #2951 (RC 3.9) translated the PKV
      // invoice-status sub-tabs, and the copayment tab's equivalents were never done — so the same
      // screen offers "Nicht gesendet / Überfällig / Gemahnt" on one tab and "Not Sent / Overdue /
      // Reminded" on the next.
      await screens.goto('/billing');

      await screens.openBillingTab('PKV-Abrechnung');
      await screens.waitForText('Invoice Nr');
      const pkvGerman = await screens.present(PKV_SUBTABS_GERMAN);

      await screens.openBillingTab('Zuzahlungsverwaltung');
      await screens.waitForText('Invoice Nr');
      const copayEnglish = await screens.present(COPAYMENT_SUBTABS_ENGLISH);

      console.log(`#3611 FINDING — PKV sub-tabs in German: ${pkvGerman.length} (${pkvGerman.join(', ')})`);
      console.log(`#3611 FINDING — copayment sub-tabs in English: ${copayEnglish.length} (${copayEnglish.join(', ')})`);
      expect(pkvGerman.length, 'PKV was translated by #2951').toBeGreaterThan(5);
      expect(copayEnglish.length, 'the copayment equivalents were not').toBeGreaterThan(5);
    },
  );
});
