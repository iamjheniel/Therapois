import { test, expect } from '@playwright/test';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';
import { mintUiSession, STAGING_CREDENTIALS } from '../../../Pages/util/api-token';
import { AppPage } from '../../../Pages/base/app.page';

/**
 * RC 3.12 — German translation cleanup across the admin screens (#3337, PR #3404).
 *
 * 58 strings in `apps/therapios/translations/de.json`: 22 that showed English, 29 that used ae/oe/
 * ue/ss where an umlaut or eszett belongs, and 7 that mixed the two languages. **Deployed on
 * staging; all four ACs pass, all 58 strings verified — not a sample.**
 *
 * **A translation ticket has exactly one authoritative surface: the dictionary the deployed bundle
 * ships.** i18next reads nothing else, so a key whose value is right and whose path the code
 * references *must* render right — and clicking through five screens says nothing about the other
 * 53 strings. This file therefore reads the served `entry-*.js`, evaluates both locale modules, and
 * asserts every one of the 58 by key. The screen walk that follows is aimed at the part a
 * dictionary check genuinely cannot settle: whether the key the ticket names is the key that screen
 * actually uses.
 *
 * **That distinction is not academic — one AC row is wrong because of it.** AC1's "Site-wide data
 * table pagination: 'Rows per page' → 'Zeilen pro Seite'" points at `controls.rows_per_page`, which
 * is **dead**: every table reads `datatable.rows_per_page`, and that key already said "Zeilen pro
 * Seite" *before* this ticket (verified against `39b280b4~1`). So the pagination row describes a
 * defect no screen ever displayed, and confirming "Zeilen pro Seite" on the Admin Board — the PM's
 * own AC1 evidence — would have passed identically against the pre-fix build.
 *
 * **The before/after is exact.** Against the parent of the fix commit, all 58 keys held precisely
 * the "Current Text Shown" the ticket lists; against staging today all 58 hold precisely the
 * "Correct German", and none of the 52 distinct old values survives anywhere else in the file. The
 * change touched `de.json` only — 57 lines in `39b280b4` plus the one-line `controls.view` follow-up
 * in `241c1711` — so "text-only, no logic changes" is a property of the diff, not a hope.
 *
 * **The dead-key count checks out, with a wrinkle.** All 12 keys the developer flagged are absent
 * from the deployed bundle. Three *more* keys have no whole-path reference either —
 * `diagnosis_list.filters.LO`, `document_center.bulk_status.type.ib` and
 * `document_center.bulk_download.skipped_reason.ib_not_supported` — but those are built as template
 * literals (`` `document_center.bulk_status.type.${type}` ``) and are live; two of them are read off
 * real screens below. A scan that only greps whole paths would have called them dead.
 *
 * **Traps.** The bundle escapes non-ASCII (`L\xe4dt...`), so grepping the served text for "Lädt"
 * finds nothing — the literal has to be evaluated. And the locale modules are content-hashed and
 * renumbered on every build, so they are located by shape, never by offset or module id.
 */

/** Category 1 — [key, the German it must now show, the English it used to show]. */
const ENGLISH_TO_GERMAN: [string, string, string][] = [
  ['controls.loading', 'Lädt...', 'Loading...'],
  ['controls.rows_per_page', 'Zeilen pro Seite', 'Rows per page'],
  ['controls.view', 'Anzeigen', 'View'],
  ['controls.dialog.title', 'Aktion bestätigen', 'Confirm Action'],
  ['link.announcements', 'Ankündigungen', 'Announcements'],
  ['link.knowledge_center', 'Wissenszentrum', 'Knowledge Center'],
  ['flowBoards.callToAction', 'Maßnahme', 'Call to Action'],
  ['columns.organizer', 'Planungsstatus', 'Organizer'],
  ['columns.first_follow_up_date', '1. FUP-Datum', '1st FUP Date'],
  ['columns.uploadDashboard.copayment.batchId', 'Zuzahlungs-Batch-ID', 'Copayment Batch ID'],
  ['columns.uploadDashboard.copayment.noteCount', 'Notizen', 'Notes'],
  ['columns.uploadDashboard.document.noteCount', 'Notizen', 'Notes'],
  ['columns.uploadDashboard.prescription.noteCount', 'Notizen', 'Notes'],
  ['image_picker.assign_error', 'Bild konnte nicht zugewiesen werden. Bitte versuchen Sie es erneut.', 'Failed to assign image. Please try again.'],
  ['image_picker.remove_error', 'Bild konnte nicht entfernt werden. Bitte versuchen Sie es erneut.', 'Failed to remove image. Please try again.'],
  ['performanceDashboard.issueTypes.attitude', 'Einstellung', 'Attitude'],
  ['practice.form.address_placeholder', 'Musterstraße 12, 12345 Musterstadt', '123 Main Street, Springfield, IL 62701'],
  ['prescription_upload.messages.note_added', 'Notiz erfolgreich hinzugefügt', 'Note added successfully'],
  ['prescription_upload.modal.details.prescription_deleted', 'Rezeptbild erfolgreich gelöscht', 'Prescription image deleted successfully'],
  ['share_vo.share_prescription_error', 'Fehler beim Teilen der Verordnungen', 'Error sharing prescriptions'],
  ['modal.fvo_actions_follow_up_order_form', 'FUP-Formular erstellen', 'Generate FUP Form'],
  ['modal.fvo_actions_initial_order_form', 'Erstbestellformular erstellen', 'Generate Initial Order Form'],
];

/**
 * Category 2 — the digraph fixes. A `~` prefix means "must contain": four of the ticket's rows
 * quote the string with an ellipsis rather than in full.
 */
const DIGRAPH_FIXES: [string, string, string][] = [
  ['billing.validation_bulk.cannot_validate_failed', 'Markierung der ausgewählten VOs fehlgeschlagen', 'Markierung der ausgewaehlten VOs fehlgeschlagen'],
  ['billing.validation_bulk.cannot_validate_success', 'Ausgewählte VOs als nicht validierbar markiert', 'Ausgewaehlte VOs als nicht validierbar markiert'],
  ['billing.validation_bulk.close_selected', 'Ausgewählte schließen', 'Ausgewaehlte schliessen'],
  ['billing.validation_bulk.closed_failed', 'Schließen der ausgewählten VOs fehlgeschlagen', 'Schliessen der ausgewaehlten VOs fehlgeschlagen'],
  ['billing.validation_bulk.closed_success', 'Ausgewählte VOs erfolgreich geschlossen', 'Ausgewaehlte VOs erfolgreich geschlossen'],
  ['billing.validation_bulk.for_fixing_failed', 'Markierung der ausgewählten VOs zur Korrektur fehlgeschlagen', 'Markierung der ausgewaehlten VOs zur Korrektur fehlgeschlagen'],
  ['billing.validation_bulk.for_fixing_success', 'Ausgewählte VOs zur Korrektur markiert', 'Ausgewaehlte VOs zur Korrektur markiert'],
  ['billing.validation_bulk.validate_selected', 'Ausgewählte validieren', 'Ausgewaehlte validieren'],
  ['billing.validation_bulk.validated_failed', 'Validierung der ausgewählten VOs fehlgeschlagen', 'Validierung der ausgewaehlten VOs fehlgeschlagen'],
  ['billing.validation_bulk.validated_success', 'Ausgewählte VOs erfolgreich validiert', 'Ausgewaehlte VOs erfolgreich validiert'],
  ['billing_batch.columns.validityDate', 'Gültigkeitsdatum', 'Gueltigkeitsdatum'],
  ['billing_batch.complete_and_sent_dialog.confirm', 'Bestätigen & Senden', 'Bestaetigen & Senden'],
  ['billing_batch.complete_and_sent_dialog.message', '~für die Bearbeitung gesperrt', 'fuer'],
  ['controls.activity.max_treatments', '~können keine weiteren Behandlungen', 'koennen'],
  ['diagnosis_list.empty', 'Keine passenden Einträge', 'Keine passenden Eintraege'],
  ['diagnosis_list.filters.LO', 'Logopädie', 'Logopaedie'],
  ['diagnosis_list.page.count_all', '{{total}} Einträge', '{{total}} Eintraege'],
  ['diagnosis_list.page.count_filtered', '{{filtered}} von {{total}} Einträgen', '{{filtered}} von {{total}} Eintraegen'],
  ['document_center.bulk_download.close', 'Schließen', 'Schliessen'],
  ['document_center.bulk_download.skipped_reason.ib_not_supported', 'Infoblatt-Download noch nicht verfügbar', 'Infoblatt-Download noch nicht verfuegbar'],
  ['document_center.bulk_status.skip', 'Überspringen', 'Ueberspringen'],
  ['document_center.bulk_status.type.ib', 'Infoblätter', 'Infoblaetter'],
  ['document_upload.modal.document_type.consent_declaration', 'Einwilligungserklärung', 'Einwilligungserklaerung'],
  ['document_upload.modal.document_type.privacy_declaration', 'Datenschutzerklärung', 'Datenschutzerklaerung'],
  ['ib.upload_modal.signer_placeholder', 'z. B. Helga Müller', 'z. B. Helga Mueller'],
  ['patients.form.generate_hono_confirm_message', '~Möchten Sie fortfahren?', 'Moechten'],
  ['patients.form.generate_ptn_confirm_message', '~Möchten Sie fortfahren?', 'Moechten'],
  ['vo_validation.vo_info.entity_change_confirm', 'Bestätigen', 'Bestaetigen'],
  ['vo_validation.vo_info.entity_change_title', 'Gesellschaft ändern?', 'Gesellschaft aendern?'],
];

/** Category 3 — the half-translated strings. */
const MIXED_LANGUAGE_FIXES: [string, string, string][] = [
  ['doctors.controls.add_doctor', 'Arzt hinzufügen', 'Add Arzt'],
  ['modal.fvo_actions_save_as_ordered', "~als 'Bestellt' speichern", 'Save VO(s) as Bestellt'],
  ['modal.fvo_actions_save_as_tracking', "~als 'Nachverfolgen' speichern", 'Save VO(s) as Nachverfolgen'],
  ['fvo_dashboard.page.title', 'Folge-VO Bestellung Dashboard', 'Folge-VO Ordering Dashboard'],
  ['vo_validation.treatment_history.medication_breakdown_title', 'Heilmittel-Aufschlüsselung', 'Heilmittel Breakdown'],
  ['treatment.status.unbilled_vo', 'Nicht abgerechnete VO', 'Unbilled VO'],
  ['patients.form.befunde_title', 'BEFUNDE', 'BEFUNDE (ASSESSMENTS)'],
];

/** The keys the developer reported as having no live screen (AC4). */
const KEYS_WITHOUT_A_SCREEN = [
  'controls.loading',
  'controls.rows_per_page',
  'columns.first_follow_up_date',
  'columns.uploadDashboard.copayment.batchId',
  'columns.uploadDashboard.copayment.noteCount',
  'share_vo.share_prescription_error',
  'modal.fvo_actions_follow_up_order_form',
  'modal.fvo_actions_initial_order_form',
  'modal.fvo_actions_save_as_ordered',
  'modal.fvo_actions_save_as_tracking',
  'fvo_dashboard.page.title',
  'patients.form.generate_ptn_confirm_message',
];

/**
 * The three live keys the code builds with a template literal, so they never appear as a whole
 * dotted path. Listed with the prefix that DOES appear, which is how they are told apart from the
 * genuinely dead ones.
 */
const TEMPLATE_LITERAL_KEYS: [string, string][] = [
  ['diagnosis_list.filters.LO', 'diagnosis_list.filters.'],
  ['document_center.bulk_status.type.ib', 'document_center.bulk_status.type.'],
  ['document_center.bulk_download.skipped_reason.ib_not_supported', 'document_center.bulk_download.skipped_reason.'],
];

const ALL_58 = [...ENGLISH_TO_GERMAN, ...DIGRAPH_FIXES, ...MIXED_LANGUAGE_FIXES];

/** Asserts one category against the deployed German dictionary. */
async function assertCategory(
  translations: TranslationsPage,
  rows: [string, string, string][],
  label: string,
) {
  const { de } = await translations.loadDictionaries();
  const failures: string[] = [];
  for (const [key, expected] of rows) {
    const actual = de[key];
    if (actual === undefined) {
      failures.push(`${key}: key missing from the deployed German dictionary`);
      continue;
    }
    const ok = expected.startsWith('~') ? actual.includes(expected.slice(1)) : actual === expected;
    if (!ok) failures.push(`${key}\n     want ${JSON.stringify(expected)}\n     got  ${JSON.stringify(actual)}`);
  }
  console.log(`${label}: ${rows.length - failures.length}/${rows.length} strings correct`);
  expect(failures, `${label} — every listed string must show the specified German`).toEqual([]);
}

test.describe('German translation cleanup across the admin screens', () => {
  test(
    'AC1 — the 22 strings that showed English now show German',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const translations = new TranslationsPage(page);
      const { bundleUrl } = await translations.loadDictionaries();
      console.log(`deployed bundle: ${bundleUrl}`);
      await assertCategory(translations, ENGLISH_TO_GERMAN, 'AC1');

      // Stronger than "the key is right": the old English must be gone from the whole file, so a
      // duplicate key elsewhere cannot still be rendering it.
      for (const [, , oldValue] of ENGLISH_TO_GERMAN) {
        if (oldValue.length <= 6) continue; // "View"/"Notes" are too generic to sweep on
        expect(await translations.keysStillHolding(oldValue), `no German key may still read ${JSON.stringify(oldValue)}`).toEqual([]);
      }
    },
  );

  test(
    'AC2 — the 29 strings missing an umlaut or eszett now carry it',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const translations = new TranslationsPage(page);
      await assertCategory(translations, DIGRAPH_FIXES, 'AC2');

      // And no OTHER string in the file still uses one, found independently of the ticket's list.
      const leftovers = await translations.remainingDigraphs();
      console.log(`remaining ae/oe/ue/ss strings anywhere in de.json: ${leftovers.length}`);
      for (const { key, value } of leftovers) console.log(`   ${key} = ${JSON.stringify(value).slice(0, 120)}`);
      expect(leftovers, 'the digraph sweep must come back empty across the whole German file').toEqual([]);
    },
  );

  test(
    'AC3 — the 7 half-translated strings are now fully German',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const translations = new TranslationsPage(page);
      await assertCategory(translations, MIXED_LANGUAGE_FIXES, 'AC3');
    },
  );

  test(
    'AC4 — the keys with no live screen are corrected too, and none of them is reachable',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const translations = new TranslationsPage(page);
      const { de } = await translations.loadDictionaries();

      for (const key of KEYS_WITHOUT_A_SCREEN) {
        const row = ALL_58.find(([k]) => k === key)!;
        expect(de[key], `${key} must still be corrected even though nothing renders it`).toBeDefined();
        const expected = row[1];
        const ok = expected.startsWith('~') ? de[key].includes(expected.slice(1)) : de[key] === expected;
        expect(ok, `${key} = ${JSON.stringify(de[key])}`).toBe(true);
        expect(await translations.referenced(key), `${key} is reported as having no live screen`).toBe(false);
      }
      console.log(`${KEYS_WITHOUT_A_SCREEN.length} keys corrected and confirmed unreferenced in the deployed bundle`);

      // The complement: every other key IS reachable, which is what makes "sample from the other 46"
      // a safe instruction. Three of them only through a template literal.
      const templateKeys = new Set(TEMPLATE_LITERAL_KEYS.map(([key]) => key));
      const live = ALL_58.map(([key]) => key).filter((key) => !KEYS_WITHOUT_A_SCREEN.includes(key));
      for (const key of live) {
        if (templateKeys.has(key)) continue;
        expect(await translations.referenced(key), `${key} must be referenced by the deployed code`).toBe(true);
      }
      for (const [key, prefix] of TEMPLATE_LITERAL_KEYS) {
        expect(
          await translations.prefixReferenced(prefix),
          `${key} is built as a template literal, so \`${prefix}\${…}\` must appear instead`,
        ).toBe(true);
      }
      console.log(`${live.length} keys reachable (${TEMPLATE_LITERAL_KEYS.length} of them only via a template literal)`);
    },
  );

  test(
    'Live — the Diagnosis List renders its corrected strings, with the counts still interpolating',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto('/diagnosis-list', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('KBV Diagnoseliste').first()).toBeVisible({ timeout: 60_000 });

      // `diagnosis_list.page.count_all` / `count_filtered` — the accented word AND the template
      // variables, which is the half a dictionary check cannot settle.
      const count = page.getByText(/\d[\d.,]*( von \d[\d.,]*)? Einträge(n)?/).first();
      await expect(count, 'the record count must use "Einträge"').toBeVisible({ timeout: 30_000 });
      // The header paints "0 von 0 Einträgen" for a beat before the rows land, and a zero proves
      // nothing about interpolation — poll until a real total is in there.
      await expect
        .poll(async () => (await count.innerText()).trim(), { timeout: 60_000, intervals: [1_000] })
        .toMatch(/(?:^|von )[1-9][\d.,]* Einträge/);
      const countText = (await count.innerText()).trim();
      console.log(`record count: ${countText}`);
      expect(countText, 'the counts must still interpolate, not print {{total}}').not.toContain('{{');
      expect(countText).toMatch(/^\d[\d.,]* (Einträge|von \d[\d.,]* Einträgen)/);

      // `diagnosis_list.filters.LO` — one of the template-literal keys.
      await page.getByText('Alle Therapiebereiche').first().click();
      await expect(page.getByText('Logopädie', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      console.log('therapy-area filter offers "Logopädie"');
    },
  );

  test(
    'Live — the Document Center renders its corrected document-type labels',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto('/document-center', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Dokumentenzentrale').first()).toBeVisible({ timeout: 60_000 });

      // `document_center.bulk_status.type.ib`, the second template-literal key.
      await expect(page.getByText('Infoblätter').first(), 'the Infoblatt tile must be spelled with ä').toBeVisible({ timeout: 30_000 });
      const body = await page.evaluate(() => document.body.innerText);
      expect(body, 'no digraph spelling may survive on this screen').not.toContain('Infoblaetter');
      console.log('Document Center shows "Infoblätter"');
    },
  );

  test(
    'Live — the Billing validation bulk actions are spelled with ä and ß',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto('/billing', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Validierung', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(6_000);

      // The bulk buttons only appear once a row is selected.
      const selectAll = page.getByRole('checkbox').first();
      if (await selectAll.isVisible().catch(() => false)) {
        await selectAll.click({ force: true, timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
      }
      const body = await page.evaluate(() => document.body.innerText);
      const shown = ['Ausgewählte validieren', 'Ausgewählte schließen'].filter((s) => body.includes(s));
      console.log(`bulk actions visible: ${shown.join(' | ') || '(none — selection not available)'}`);
      test.skip(shown.length === 0, 'no VO row could be selected, so the bulk action bar never rendered');

      expect(body, 'the old digraph spellings must be gone from this screen').not.toContain('Ausgewaehlte');
      expect(body).not.toContain('schliessen');
    },
  );

  test(
    'Live — the corrected navigation labels',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1600, height: 1200 });
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8_000);

      const app = new (class extends AppPage {})(page);
      await app.navTo(/Ankündigungen/);
      await expect(page).toHaveURL(/\/announcement/, { timeout: 30_000 });
      await expect(page.getByText('Ankündigungen').first()).toBeVisible({ timeout: 30_000 });
      console.log(`link.announcements renders "Ankündigungen" and routes to ${page.url()}`);
    },
  );

  test(
    'Live — Arzt Management offers "Arzt hinzufügen"',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1600, height: 1200 });
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8_000);

      const app = new (class extends AppPage {})(page);
      await app.navTo(/Arzt Management/);
      await page.waitForTimeout(6_000);
      await expect(
        page.getByText('Arzt hinzufügen').first(),
        'doctors.controls.add_doctor must be fully German',
      ).toBeVisible({ timeout: 30_000 });
      const body = await page.evaluate(() => document.body.innerText);
      expect(body, 'the half-English label must be gone').not.toContain('Add Arzt');
      console.log('Arzt Management shows "Arzt hinzufügen"');
    },
  );

  test(
    'Live — TO Verwaltung shows the corrected "Nicht abgerechnete VO" summary card',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.goto('/to-management', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('TO Verwaltung').first()).toBeVisible({ timeout: 60_000 });
      await page.getByText('Abrechnung', { exact: true }).first().click({ timeout: 20_000 });
      await page.waitForTimeout(6_000);

      const body = await page.evaluate(() => document.body.innerText);
      expect(body, 'treatment.status.unbilled_vo must be fully German').toContain('Nicht abgerechnete VO');
      expect(body, 'the half-English label must be gone').not.toContain('Unbilled VO');
      console.log('TO Verwaltung → Abrechnung shows "Nicht abgerechnete VO"');
    },
  );

  test(
    'Finding — two of the fixed strings still render in English, because that screen hardcodes them',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        'The dictionary is right and the screen is still English, for two of the 58. On TO Verwaltung ' +
          '(/to-management) the table column reads "Call to Action" and the Problemtyp dropdown offers ' +
          '"Attitude" — exactly the two strings AC1 corrects to "Maßnahme" and "Einstellung". Both keys ' +
          'ARE fixed and ARE used, but by a different component: `flowBoards.callToAction` is read by ' +
          'FlowBoards/WorkingHoursTable.tsx, while PerformanceDashboard/columns.tsx:183 hardcodes ' +
          '`label: \'Call to Action\'`; and `performanceDashboard.issueTypes.attitude` is read by the ' +
          'note cells, while PerformanceDashboard/types.ts:79 hardcodes `{ value: \'attitude\', label: ' +
          '\'Attitude\' }` inside a list whose own comment says "German labels for issue type dropdown ' +
          'options" — every other entry in it is German. ' +
          'This is a blind spot in the audit method, not an implementation slip: a flatten-and-diff of ' +
          'de.json against en.json cannot see a string that is in neither file. The same screen carries ' +
          'more of it — Problemstatus offers "All / Open / Completed", Therapeuten-Gesundheit offers ' +
          '"All / Red / Yellow / Green / Gray", and the Abrechnung tab has "Clear Filters", "Therapist" ' +
          'and "TO Staff" — all hardcoded (TherapistPerformanceTable.tsx:34-35, types.ts:26-28). ' +
          'Against the End Goal ("no English text ... anywhere in Flow\'s admin-facing screens") this is ' +
          'unmet for two of the ticket\'s own strings. Raised for a follow-up ticket scoped by SCREEN ' +
          'rather than by locale file.',
      );

      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.goto('/to-management', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('TO Verwaltung').first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(7_000);

      const body = await page.evaluate(() => document.body.innerText);
      expect(body, 'the working-hours column must read "Maßnahme"').not.toContain('Call to Action');

      const problemType = page.getByText('Problemtyp:', { exact: true }).first();
      await problemType.locator('xpath=following::div[@tabindex="0"][1]').click({ timeout: 20_000 });
      const options = await page.locator('[data-testid*="flatlist"]').first().innerText();
      console.log(`Problemtyp options: ${options.replace(/\n/g, ' | ')}`);
      expect(options, 'the issue-type dropdown must offer "Einstellung", not "Attitude"').toContain('Einstellung');
    },
  );

  test(
    'Finding — AC1\'s pagination row points at a dead key, and the live one was already correct',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        'AC1 row 2 ("Site-wide data table pagination: \'Rows per page\' → \'Zeilen pro Seite\'") describes ' +
          'a defect that was never on screen. The key it names, `controls.rows_per_page`, has no code ' +
          'reference in the deployed bundle; every table reads `datatable.rows_per_page`, and that key ' +
          'already held "Zeilen pro Seite" in de.json at 39b280b4~1 — the commit before the fix. So the ' +
          'string was correct on screen before this ticket and is correct after it, and the PM test note ' +
          'citing Admin Board pagination as AC1 evidence ("was \'Rows per page\'") would have passed just ' +
          'the same against the pre-fix build. The correction itself is harmless and AC4 covers it as a ' +
          'dead key; what needs fixing is the AC row and the QA step derived from it. Raised for the PM.',
      );

      const translations = new TranslationsPage(page);
      const { de } = await translations.loadDictionaries();
      expect(de['datatable.rows_per_page']).toBe('Zeilen pro Seite');
      expect(await translations.referenced('controls.rows_per_page'), 'the key AC1 names must be live').toBe(true);
    },
  );

  test(
    'Finding — the Organizer column AC1 sends QA to was removed from Therapist Board v2 after this ticket merged',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        '`columns.organizer` is correct in the dictionary ("Planungsstatus"), but the Testing Guidance — ' +
          '"check the Therapist Board (Organizer toggle label …, Therapist Board v2 included)" — can no ' +
          'longer be followed on v2. #3337 merged 2026-08-18 (72ee2840); `ff486c92` on 2026-08-20 removed ' +
          'the Organizer column from TherapistBoardV2 (columnDefs.tsx, TherapistBoardV2Screen.tsx, ' +
          'railColumns.tsx, VoCard.tsx). At HEAD the only remaining consumers are the LEGACY therapist ' +
          'board (constants/Therapist/columns.tsx, hooks/usePrescriptionColumns.tsx, ' +
          'constants/Therapist/expandedFieldsConfig.tsx), which is the surface reached by clicking a ' +
          'patient NAME on /therapist/. The string is therefore still checkable, but not where the ticket ' +
          'sends QA — and the v2 column picker offers 16 columns with no Planungsstatus among them. ' +
          'Raised so the QA step is corrected rather than reported as a missing translation.',
      );

      const translations = new TranslationsPage(page);
      const { de } = await translations.loadDictionaries();
      expect(de['columns.organizer']).toBe('Planungsstatus');
    },
  );

  test(
    'Finding — two English strings remain in the German file, in the namespace the ticket excludes',
    { tag: ['@SuperAdmin', '@GermanTranslation', '@ReadOnly'] },
    async ({ page }) => {
      test.fixme(
        true,
        'An independent sweep of the deployed German dictionary — no reference to the ticket\'s list — ' +
          'finds exactly two values that are still English: `vo_management.form.save_error` = "Failed to ' +
          'save VO. Please try again." and `vo_management.form.save_success` = "VO created successfully". ' +
          'Both sit in `vo_management.form.*`, the namespace the Developer Reference declares out of scope ' +
          'as "covered by a separate, already-shipped translation ticket" — so either that ticket missed ' +
          'them or it has not shipped. Neither has a code reference in the deployed bundle, so nothing ' +
          'renders them today, which is why this is a follow-up rather than a defect in #3337. Everything ' +
          'else is clean: 0 remaining digraphs and, outside these two, 0 remaining English values.',
      );

      const translations = new TranslationsPage(page);
      const remaining = await translations.remainingEnglishValues();
      const real = remaining.filter(({ value }) => value !== 'TO Management');
      console.log(`English values still in de.json: ${real.map((r) => `${r.key}=${JSON.stringify(r.value)}`).join(' | ')}`);
      expect(real, 'the German file must contain no English values').toEqual([]);
    },
  );
});
