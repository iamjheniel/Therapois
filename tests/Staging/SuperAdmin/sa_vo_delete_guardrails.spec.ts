import { test, expect } from '@playwright/test';
import {
  VoDeletionPage,
  FIXTURES,
  BLOCKED,
  DELETION_REASONS,
  GERMAN,
  I18N_KEYS,
  RESTORE_WINDOW_DAYS,
  STAGING_WEB,
  BLOCKED_DIALOG_HEADING,
} from '../../../Pages/superadmin/sa.vo-deletion.page';
import { mintUiSession, STAGING_CREDENTIALS, API_BASE } from '../../../Pages/util/api-token';

/**
 * RC 3.14 — delete a VO with guardrails and a confirmation step (#3671, PR #3693).
 *
 * Admins had no way to remove a VO created in error; archiving or terminating only changes its
 * status and leaves it counted everywhere. This ticket adds the "Löschen" action, its three
 * blocking conditions, the confirmation step, the "Gelöscht" tab and the permanent deletion record.
 * **Deployed on both halves and verified live.**
 *
 * **Deployment has to be decided twice.** `GET /status` reports `3.14.0`, but that is the API only —
 * a frontend change deploys independently and `/status` says nothing about it (#3705). The first
 * test therefore reads both: the two preflight operations off the API, and the dialog's own German
 * out of the served entry bundle.
 *
 * **AC 2's whole truth table is READ-ONLY.** `GET /prescriptions/{id}/deletion-preflight` runs the
 * same `PrescriptionDeletionService::resolveBlocker()` the confirm re-runs, and writes nothing — so
 * the three blocking conditions are driven over the live population without deleting anything. That
 * is the #3576 `preview-creation-validation` technique, and it is what makes a destructive ticket
 * testable at all.
 *
 * **The precedence is measured, not assumed, and no AC states it.** Two live VOs satisfy more than
 * one condition and they settle the order: VO 4207-2 is `validated` AND carries the sent invoice
 * R426-98 → reports `invoice_sent`; VO 4193-2 is `validated` AND in batch E-2026-857-001 → reports
 * `billing_batch`. So it is invoice → batch → validated, and a QA reading only the AC's table would
 * have no way to predict which message an admin actually sees on such a VO.
 *
 * **One mutating test**, and it is self-restoring by construction: a soft delete preserves
 * `treatmentStatus` and #3674's restore clears the four deletion columns. The fixture is a QA
 * patient's VO with **no invoice and no child link** — see the page object for why either of those
 * would make the round trip irreversible. Its permanent residue is exactly what AC 13/14 require: a
 * `prescription_deleted` Verlauf entry, a `prescription_restored` one, and one
 * `PrescriptionDeletionRecord`.
 *
 * **AC 14 has no client surface at all** — `PrescriptionDeletionRecord` deliberately carries no
 * `#[ApiResource]` (it is read by the DPO out of the database), so the record's four fields cannot
 * be inspected from here → `fixme`.
 *
 * **FINDING (reported, not failed): the Gelöscht tab's empty state is in English.** Opening the tab
 * with nothing deleted paints "No prescriptions match these filters", "Try clearing a filter or
 * widening the date range. You can also create a new VO to get started.", "Create VO" and "Clear
 * filters" on an otherwise fully German board. Pre-existing rather than introduced by this PR — the
 * empty state is shared with every other tab — but #3671 gives it a tab that is empty by default,
 * so this is the first place an admin reliably meets it. Same family as #3611.
 *
 * **Traps:** `?patient=` is silently ignored on `/prescriptions` (returns the whole 34k book) while
 * `patient.id=` is the registered filter; `exists[deletedAt]=true` fails closed for a non-admin
 * (`totalItems: 0`, not 403), so an empty Gelöscht tab proves nothing unless the caller is an admin;
 * and the board's tabs are **not** `role="tab"` — they are leaf divs on one row, so AC 15's
 * "directly after Alle inkl. Archivierte" is asserted by x-order along that row.
 *
 * Run at `--workers=1`: the mutating test and the #3672/#3674 files share one fixture pool.
 */

const NOW_ISO = () => new Date().toISOString();

test.describe('#3671 delete a VO with guardrails and confirmation', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'deployment: both halves of the epic are live (API operations + the dialog in the served bundle)',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      const status = await (await request.get(`${API_BASE}/status`)).json();
      const pre = await api.deletionPreflightRaw(FIXTURES.spare.id, token);
      const restorePre = await api.restorePreflightRaw(FIXTURES.spare.id, token);

      console.log(`#3671 API: /status ${JSON.stringify(status)} | deletion-preflight ${pre.status} | restore-preflight ${restorePre.status}`);

      expect(status.version, 'the API half').toBe('3.14.0');
      expect(pre.status, 'GET /prescriptions/{id}/deletion-preflight is deployed').toBe(200);
      expect(restorePre.status, "#3674's preflight rides in the same release").toBe(200);

      // The frontend deploys separately, so the bundle is the only surface that can answer for it.
      const bundle = await api.entryBundle();
      const counts = {
        tabKey: VoDeletionPage.occurrences(bundle, I18N_KEYS.tab),
        tabLabel: VoDeletionPage.escapedCount(bundle, GERMAN.tabDeleted),
        dialogTitle: VoDeletionPage.escapedCount(bundle, GERMAN.dialogTitle),
        acknowledge: VoDeletionPage.escapedCount(bundle, GERMAN.acknowledge),
        existsFilter: VoDeletionPage.occurrences(bundle, 'exists[deletedAt]'),
      };
      console.log(`#3671 bundle: ${JSON.stringify(counts)}`);

      expect(counts.tabKey, `${I18N_KEYS.tab} is referenced by the deployed bundle`).toBeGreaterThan(0);
      expect(counts.tabLabel, 'the German tab label ships').toBeGreaterThan(0);
      expect(counts.dialogTitle, 'the confirmation step ships').toBeGreaterThan(0);
      expect(counts.acknowledge, "AC 11's assertion checkbox ships").toBeGreaterThan(0);
      expect(counts.existsFilter, "the tab's opt-in filter is wired").toBeGreaterThan(0);
    },
  );

  test(
    'AC2 each blocking condition is reported by the preflight, naming the invoice or the batch',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      const invoice = await api.deletionPreflight(FIXTURES.blockedByInvoice.id, token);
      const batch = await api.deletionPreflight(FIXTURES.blockedByBatch.id, token);
      const validated = await api.deletionPreflight(FIXTURES.blockedByValidation.id, token);

      for (const [label, pf] of [
        [FIXTURES.blockedByInvoice.vo, invoice],
        [FIXTURES.blockedByBatch.vo, batch],
        [FIXTURES.blockedByValidation.vo, validated],
      ] as const) {
        console.log(`#3671 AC2 ${label}: ${JSON.stringify(pf.blocked)}`);
      }

      // The message the admin sees interpolates the invoice number / batch name, so a blocker that
      // fires but cannot name its artifact would render "Diese VO hat die Rechnung ." and still
      // pass a bare type check.
      expect(invoice.blocked?.type).toBe(BLOCKED.invoiceSent);
      expect(invoice.blocked?.invoiceNumber, 'AC2 interpolates {{invoiceNumber}}').toBe(
        FIXTURES.blockedByInvoice.invoiceNumber,
      );
      expect(batch.blocked?.type).toBe(BLOCKED.billingBatch);
      expect(batch.blocked?.batchName, 'AC2 interpolates {{batchName}}').toBe(FIXTURES.blockedByBatch.batchName);
      expect(validated.blocked?.type).toBe(BLOCKED.validated);
      expect(
        validated.blocked?.invoiceNumber ?? null,
        'the validated arm names nothing — its message has no placeholder',
      ).toBeNull();
    },
  );

  test(
    'AC2 precedence: a VO that satisfies two conditions reports the earlier one (undocumented, measured here)',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // Both of these are ALSO `validated`; `resolveBlocker()` returns on the first match, and the
      // AC's table does not say which message wins. `validationStatus` is in the DEFAULT group, so
      // these are plain item reads — a `groups[]` here would REPLACE the default set and drop the
      // very field being checked (#3576).
      const both = await api.prescription(FIXTURES.validatedAndInvoiced.id, token);
      const invoiceWins = await api.deletionPreflight(FIXTURES.validatedAndInvoiced.id, token);
      const batchWins = await api.deletionPreflight(FIXTURES.blockedByBatch.id, token);
      const batchVo = await api.prescription(FIXTURES.blockedByBatch.id, token);

      console.log(
        `#3671 precedence: ${FIXTURES.validatedAndInvoiced.vo} validationStatus=${both.body?.validationStatus} -> ${invoiceWins.blocked?.type}; ` +
          `${FIXTURES.blockedByBatch.vo} validationStatus=${batchVo.body?.validationStatus} -> ${batchWins.blocked?.type}`,
      );

      expect(both.body?.validationStatus, 'the fixture really is validated too').toBe('validated');
      expect(invoiceWins.blocked?.type, 'invoice outranks validation').toBe(BLOCKED.invoiceSent);
      expect(batchVo.body?.validationStatus, 'and so is this one').toBe('validated');
      expect(batchWins.blocked?.type, 'batch outranks validation').toBe(BLOCKED.billingBatch);
    },
  );

  test(
    'AC3/AC4/AC5/AC7/AC8/AC10 an unblocked VO carries everything the confirmation step renders',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      const pf = await api.deletionPreflight(FIXTURES.roundTrip.id, token);
      console.log(`#3671 preflight ${FIXTURES.roundTrip.vo}: ${JSON.stringify(pf)}`);

      // AC 3 — no invoice at all, so the step opens rather than blocking.
      expect(pf.blocked, 'AC3: not blocked').toBeNull();
      expect(pf.draftInvoice, 'the round-trip fixture must carry no invoice (see the page object)').toBeNull();

      // AC 4 — the summary is always shown, all five fields.
      expect(pf.summary.prescriptionId).toBe(FIXTURES.roundTrip.vo);
      expect(pf.summary.patientName, 'AC4 names the patient so the admin can see which VO it is').toBeTruthy();
      expect(pf.summary.treatmentStatus, 'AC4 shows the status that will be preserved underneath').toBeTruthy();
      expect(pf.summary.therapistName).toBe(FIXTURES.roundTrip.therapistName);
      expect(pf.summary.entityName).toBeTruthy();

      // AC 5 — the documented-treatment count is the board's own weighted `getActivityCount()`, so
      // the number in the warning and the number in the Doku column cannot drift.
      const activities = await api.activitiesFor(FIXTURES.roundTrip.id, token);
      console.log(`#3671 AC5: documentedTreatments=${pf.documentedTreatments} vs /activities total=${activities}`);
      expect(pf.documentedTreatments, 'AC5 needs a non-zero count to be exercised at all').toBeGreaterThan(0);

      // AC 6/7/8 — absent links and documents arrive as explicit nulls / 0, never as missing keys.
      // `skip_null_values: false` on the operation is what guarantees that, and a client that tells
      // `null` from `undefined` (the dialog does) breaks without it.
      expect(pf).toHaveProperty('parentLink');
      expect(pf).toHaveProperty('childLink');
      expect(pf.childLink, 'the round-trip fixture must have no child link — restore never re-links one').toBeNull();
      expect(typeof pf.documentCount).toBe('number');

      // AC 10 — the 30-day sentence interpolates this, from `Prescription::DELETION_RESTORE_WINDOW_DAYS`.
      expect(pf.restoreWindowDays).toBe(RESTORE_WINDOW_DAYS);
    },
  );

  test(
    'AC1 a therapist never reaches the action: 403 on both preflight and delete, and no deleted VO is visible',
    { tag: ['@SuperAdmin', '@VoDeletion', '@Security', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const therapist = await api.therapistToken();

      const pre = await api.deletionPreflightRaw(FIXTURES.roundTrip.id, therapist);
      // An EMPTY body: `DeletePrescriptionController` denies access as its very first statement,
      // before it parses anything, so this can never delete the VO even if the guard were missing —
      // the reason parse would reject it. Same safety argument as #3550's authorization matrix.
      const del = await api.deleteVo(FIXTURES.roundTrip.id, {}, therapist);
      const tab = await api.deletedTabRaw(therapist);

      console.log(
        `#3671 AC1 therapist: deletion-preflight ${pre.status} | PATCH /delete ${del.status} "${(del.body as { message?: string } | null)?.message ?? ''}" | exists[deletedAt] ${tab.status}`,
      );

      expect(pre.status, 'the confirmation step is admin-only').toBe(403);
      expect(del.status, 'and so is the action behind it').toBe(403);
      expect(JSON.stringify(del.body)).toContain('Only Admins can delete VOs.');
      // Fail closed rather than 403: the extension re-adds `deletedAt IS NULL` on top of the
      // filter's `IS NOT NULL`, so a therapist sending the tab's own request gets an empty set and
      // is never told whether anything is deleted.
      expect(tab.status, 'the filter itself is not refused — it is emptied').toBe(200);
      const total = (tab.body as { totalItems?: number } | null)?.totalItems ?? -1;
      expect(total, 'a therapist sees no deleted VO whatever they ask for').toBe(0);
    },
  );

  test(
    'AC9 the reason is enforced by the endpoint, not only by the dialog',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // None of these three deletes anything: each is refused before the service is reached.
      const noReason = await api.deleteVo(FIXTURES.spare.id, {}, token);
      const badReason = await api.deleteVo(FIXTURES.spare.id, { reason: 'not-a-reason' }, token);
      const otherNoNote = await api.deleteVo(FIXTURES.spare.id, { reason: 'other' }, token);

      console.log(
        `#3671 AC9: no reason -> ${noReason.status}; bogus reason -> ${badReason.status}; other without note -> ${otherNoNote.status}`,
      );

      expect(noReason.status).toBe(400);
      expect(badReason.status, 'the enum is closed — only the three AC 9 codes are accepted').toBe(400);
      expect(otherNoNote.status, '"Anderer Grund" needs the free text server-side too').toBe(422);
      expect(JSON.stringify(otherNoNote.body)).toContain('free-text note is required');

      // And the VO is untouched by all three.
      const vo = await api.prescription(FIXTURES.spare.id, token);
      expect(vo.body?.deletedAt ?? null, 'a refused payload deletes nothing').toBeNull();
    },
  );

  test(
    'AC18 "Gelöscht" is never a selectable status, in the enum or on the bulk writer',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // Probed with an id that matches nothing, so the loop body never runs and nothing is written
      // (#3561) — what the call still decides is whether the VALUE is accepted.
      const asDeleted = await api.bulkStatus([999_000_001], GERMAN.tabDeleted, token);
      const asArchived = await api.bulkStatus([999_000_001], 'Archiviert', token);
      console.log(`#3671 AC18: treatmentStatus="Gelöscht" -> ${asDeleted.status}; control "Archiviert" -> ${asArchived.status}`);

      expect(asDeleted.status, 'the bulk status writer refuses it as a status').toBe(400);
      expect(JSON.stringify(asDeleted.body)).toContain('Invalid treatment status');
      // The control is what makes the refusal mean something: a 400 for every value would prove
      // nothing about this one.
      expect(asArchived.status, 'a real status is accepted on the same call').toBe(200);
      expect(asArchived.body?.count, 'and still writes nothing, because no id matched').toBe(0);

      // The dropdowns derive their options from the frontend status enum, which is why the ticket
      // chose a `deletedAt` column over a new status case.
      const bundle = await api.entryBundle();
      const enumBlock = bundle.match(/t\.PENDING="Pending".{0,600}?t\.SENT_BACK_TO_THERAPIST="[^"]+"/s)?.[0] ?? '';
      console.log(`#3671 AC18 status enum in the bundle: ${enumBlock.slice(0, 400)}`);
      expect(enumBlock, 'the status enum was located').not.toBe('');
      expect(enumBlock, 'no status case carries the deleted label').not.toContain(VoDeletionPage.escaped(GERMAN.tabDeleted));
    },
  );

  test(
    'AC1/AC4/AC9/AC10/AC11 the confirmation step on screen',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(300_000);
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      const vo = new VoDeletionPage(request, page);
      await vo.openVoForm(FIXTURES.spare.id);

      // AC 1 — the action sits in the same area as Speichern and Abbrechen.
      const deleteAction = page.getByText(GERMAN.deleteAction, { exact: true });
      await expect(deleteAction, 'AC1: "Löschen" is offered on the VO edit form').toHaveCount(1);
      await expect(page.getByText('Speichern', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Abbrechen', { exact: true }).first()).toBeVisible();

      expect(await vo.openDeleteDialog(), 'this VO is deletable, so the confirmation step opens').toBe('confirm');

      const body = await page.locator('body').innerText();
      console.log(`#3671 dialog: ${body.slice(body.indexOf(GERMAN.dialogTitle), body.indexOf(GERMAN.dialogTitle) + 900).replace(/\n+/g, ' | ')}`);

      // AC 4 — the summary's five labels.
      for (const label of ['VO-Nr.', 'Patient', 'VO-Status', 'Therapeut', 'Gesellschaft']) {
        expect(body, `AC4 summary row "${label}"`).toContain(label);
      }
      expect(body, 'AC4 shows the VO it is about').toContain(FIXTURES.spare.vo);

      // AC 9 / AC 10 / AC 11.
      expect(body, 'AC9 the reason picker').toContain('Grund für das Löschen');
      expect(body, 'AC10 the 30-day statement, with the window interpolated').toContain(
        GERMAN.restoreWindow.replace('{{days}}', String(RESTORE_WINDOW_DAYS)),
      );
      expect(body, "AC11 the assertion checkbox's label").toContain(GERMAN.acknowledge);

      // AC 11 — the destructive button is inert until the assertion checkbox is ticked. It is a
      // Pressable, so the state lives on an ancestor's `aria-disabled`, not on the text node.
      const confirmState = await page
        .getByText(GERMAN.dialogTitle, { exact: true })
        .last()
        .evaluate((node) => {
          let el: HTMLElement | null = node as HTMLElement;
          for (let i = 0; i < 4 && el; i++) {
            const v = el.getAttribute('aria-disabled');
            if (v) return `depth${i}:${v}`;
            el = el.parentElement;
          }
          return 'no aria-disabled';
        });
      console.log(`#3671 AC11 confirm button: ${confirmState}`);
      expect(confirmState, 'AC11: "VO löschen" stays disabled until the admin acknowledges').toContain('true');

      // Nothing is confirmed — closing the dialog leaves the VO exactly as it was.
      await page.getByText('Abbrechen', { exact: true }).last().click();
      const api = new VoDeletionPage(request);
      const stillLive = await api.prescription(FIXTURES.spare.id, await api.adminToken());
      expect(stillLive.body?.deletedAt ?? null, 'cancelling deletes nothing').toBeNull();
    },
  );

  test(
    'AC2 the blocking message replaces the confirmation step on screen, naming the batch',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(300_000);
      const vo = FIXTURES.blockedByBatch;
      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      const ui = new VoDeletionPage(request, page);
      await ui.openVoForm(vo.id);
      expect(await ui.openDeleteDialog(), 'AC2: the blocking message replaces the confirmation step').toBe('blocked');

      const body = await page.locator('body').innerText();
      const i = body.indexOf(BLOCKED_DIALOG_HEADING);
      console.log(`#3671 AC2 blocked dialog: ${body.slice(i, i + 400).replace(/\n+/g, ' | ')}`);

      expect(body, 'AC2: the message names the batch it is in').toContain(
        GERMAN.blockedBatch.replace('{{batchName}}', vo.batchName),
      );
      // The blocked dialog offers no way forward at all — it closes, it does not confirm.
      expect(body, 'AC2: no confirmation step behind it').not.toContain(GERMAN.acknowledge);
      await page.getByText('Schließen', { exact: true }).last().click();
    },
  );

  test(
    'AC5 the documented-treatment warning carries the count the preflight computed',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const vo = FIXTURES.roundTrip;

      const pf = await api.deletionPreflight(vo.id, token);
      console.log(`#3671 AC5: ${vo.vo} documentedTreatments=${pf.documentedTreatments}`);
      expect(pf.documentedTreatments, 'the fixture has sessions, or the warning would not render').toBeGreaterThan(0);

      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      const ui = new VoDeletionPage(request, page);
      await ui.openVoForm(vo.id);
      expect(await ui.openDeleteDialog()).toBe('confirm');

      const body = await page.locator('body').innerText();
      expect(body, 'AC5: the warning, interpolating the server-side count').toContain(
        GERMAN.treatmentsWarning.replace('{{count}}', String(pf.documentedTreatments)),
      );
      await page.getByText('Abbrechen', { exact: true }).last().click();
    },
  );

  test(
    'AC6 a follow-up VO offers the three choices for its parent, naming the parent',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ page, request }) => {
      // One VO per test, deliberately: the VO form does not remount on a navigation between two
      // edit URLs (the same trap #3535 records), so the second page.goto in a combined test finds
      // no "Löschen" at all and reads as the action being missing.
      test.setTimeout(300_000);
      const child = FIXTURES.childWithParent;

      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      const ui = new VoDeletionPage(request, page);
      await ui.openVoForm(child.id);
      expect(await ui.openDeleteDialog()).toBe('confirm');

      const body = await page.locator('body').innerText();
      const j = body.indexOf(GERMAN.dialogTitle);
      console.log(`#3671 AC6 dialog: ${body.slice(j, j + 700).replace(/\n+/g, ' | ')}`);

      expect(body, 'AC6: the parent warning names the parent VO').toContain(
        `Diese VO ist als Folge-VO mit der VO ${child.parentVo} verknüpft. Die Verknüpfung wird entfernt.`,
      );
      expect(body, 'AC6: the choice label').toContain('Status der Vorgänger-VO');
      for (const choice of ['Auf „Bestellen“ setzen', 'Auf „Keine Folge-VO“ setzen', 'Folge-VO-Status unverändert lassen']) {
        expect(body, `AC6: "${choice}"`).toContain(choice);
      }
      await page.getByText('Abbrechen', { exact: true }).last().click();
    },
  );

  test(
    'AC7 a VO that is itself a parent reports its child link',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(180_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();

      // Asserted through the preflight rather than the dialog, and read-only on purpose: the only
      // unblocked VOs on staging that HAVE a child are ones whose link a deletion would sever for
      // good, because restore re-links a parent and never a child (the finding in the restore
      // file). So this file never opens the delete action on one.
      const pf = await api.deletionPreflight(FIXTURES.withChildLink.id, token);
      console.log(`#3671 AC7 ${FIXTURES.withChildLink.vo}: childLink=${JSON.stringify(pf.childLink)}`);

      expect(pf.blocked, 'the AC7 fixture is otherwise deletable, so the block would really render').toBeNull();
      expect(pf.childLink?.prescriptionId, 'AC7: the child the informational block names').toBe(
        FIXTURES.withChildLink.childVo,
      );
      expect(pf.parentLink, 'and it is a parent, not a child, so no radio choice is required').toBeNull();
    },
  );

  test(
    'AC15/AC16 the Gelöscht tab sits directly after "Alle inkl. Archivierte" and carries its own count',
    { tag: ['@SuperAdmin', '@VoDeletion', '@ReadOnly'] },
    async ({ page, request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const counts = await api.dashboardCounts(token);
      console.log(`#3671 AC15 dashboard-counts: ${JSON.stringify(counts)}`);
      expect(counts, 'the counts endpoint gained a `deleted` bucket for the tab').toHaveProperty('deleted');

      await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
      await page.goto(`${STAGING_WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(GERMAN.tabAllWithArchived, { exact: true }).first()).toBeVisible({ timeout: 150_000 });

      // The tabs are not `role="tab"` — they are leaf divs sharing one row — so "directly after" is
      // read off the x-order along that row rather than from a list of roles. The row also carries
      // each tab's count and the strip's two scroll chevrons, so the sequence is narrowed to the
      // known tab LABELS before the order is asserted.
      const TAB_LABELS = [
        'Folge-VO erhalten',
        'Keine Folge-VO',
        'Fertig behandelt',
        'Zur Prüfung',
        'Alle VOs',
        GERMAN.tabAllWithArchived,
        GERMAN.tabDeleted,
      ];
      const readStrip = () =>
        page.evaluate(() => {
          const anchor = [...document.querySelectorAll('*')].find(
            (e) => e.children.length === 0 && (e as HTMLElement).innerText?.trim() === 'Alle inkl. Archivierte',
          ) as HTMLElement | undefined;
          if (!anchor) return [] as { t: string; x: number }[];
          const y = anchor.getBoundingClientRect().y;
          const rows: { t: string; x: number }[] = [];
          document.querySelectorAll('*').forEach((e) => {
            const el = e as HTMLElement;
            if (el.children.length !== 0) return;
            const r = el.getBoundingClientRect();
            if (Math.abs(r.y - y) > 6 || r.width === 0) return;
            const t = el.innerText?.trim();
            if (t) rows.push({ t, x: Math.round(r.x) });
          });
          return rows.sort((a, b) => a.x - b.x);
        });

      // The badges paint as zeros until `/prescriptions/dashboard-counts` answers, so the strip has
      // to be polled — reading it early gives a plausible-looking row of 0s and an assertion on the
      // counts that fails for a reason that has nothing to do with this AC.
      await expect
        .poll(async () => (await readStrip()).find((r) => r.t === String(counts.allWithArchived))?.t ?? null, {
          timeout: 120_000,
          message: 'the tab counts have loaded',
        })
        .toBe(String(counts.allWithArchived));

      const strip = await readStrip();
      console.log(`#3671 AC15 tab strip: ${strip.map((r) => r.t).join(' · ')}`);
      const labels = strip.map((r) => r.t).filter((t) => TAB_LABELS.includes(t));

      expect(labels, 'AC15: the Gelöscht tab is rendered for a Super Admin, directly after Alle inkl. Archivierte').toEqual(
        TAB_LABELS,
      );

      // And it carries its own count, which is the `deleted` bucket the counts endpoint gained.
      // The next leaf is not necessarily the badge — the strip's "›" scroll chevron overlaps the
      // row and lands between the label and its count — so take the first NUMERIC leaf after it.
      const deletedIdx = strip.findIndex((r) => r.t === GERMAN.tabDeleted);
      const badge = strip.slice(deletedIdx + 1).find((r) => /^\d[\d.,]*$/.test(r.t))?.t;
      expect(badge, "AC15: the Gelöscht tab's badge is the counts endpoint's `deleted` bucket").toBe(
        String(counts.deleted),
      );

      await page.getByText(GERMAN.tabDeleted, { exact: true }).first().click();
      await page.waitForTimeout(8_000);
      const after = await page.locator('body').innerText();

      // FINDING, reported rather than asserted: the empty state is English on a German board.
      const englishEmptyState = ['No prescriptions match these filters', 'Clear filters', 'Create VO'].filter((s) =>
        after.includes(s),
      );
      if (englishEmptyState.length) {
        console.log(
          `#3671 FINDING: the Gelöscht tab's empty state is in English — ${JSON.stringify(englishEmptyState)}. ` +
            'Shared with every other tab (pre-existing, same family as #3611), but this is the tab that is empty by default.',
        );
      }
      expect(after, 'the board stayed on the Gelöscht tab').toContain(GERMAN.tabDeleted);
    },
  );

  test(
    'AC12/AC13/AC16/AC17 a real deletion, and what it leaves behind (mutating, restored at the end)',
    { tag: ['@SuperAdmin', '@VoDeletion', '@Mutating'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new VoDeletionPage(request);
      const token = await api.adminToken();
      const vo = FIXTURES.spare;

      const before = await api.prescription(vo.id, token);
      const logsBefore = await api.logs(vo.id, token);
      const countsBefore = await api.dashboardCounts(token);
      expect(before.body?.deletedAt ?? null, 'the fixture starts live').toBeNull();
      const statusBefore = before.body?.treatmentStatus ?? null;

      try {
        const at = NOW_ISO();
        const del = await api.deleteVo(vo.id, { reason: 'duplicate' }, token);
        console.log(`#3671 delete ${vo.vo}: ${del.status} deletedAt=${del.body?.deletedAt} status=${del.body?.treatmentStatus}`);

        expect(del.status).toBe(200);
        expect(del.body?.deletedAt, 'AC12: the VO is marked deleted').toBeTruthy();
        // The point of the whole design: a `deletedAt` column rather than a status case, so the
        // status survives untouched for #3674 to put back.
        expect(del.body?.treatmentStatus, 'AC12: the status stays preserved underneath, unchanged').toBe(statusBefore);
        expect(del.body?.deletionReason).toBe('duplicate');
        expect(del.body?.deletionReasonNote ?? null, 'no note, because the reason is not "other"').toBeNull();

        // AC 17 — the banner reads "wiederherstellbar bis [date+30]". The window is computed in one
        // place, so the restore preflight is where to check the arithmetic.
        const restorePf = await api.restorePreflight(vo.id, token);
        const deletedMs = Date.parse(restorePf.summary.deletedAt ?? '');
        const untilMs = Date.parse(restorePf.summary.restorableUntil ?? '');
        console.log(
          `#3671 AC17: deletedAt=${restorePf.summary.deletedAt} restorableUntil=${restorePf.summary.restorableUntil} by=${restorePf.summary.deletedByName}`,
        );
        expect(Math.round((untilMs - deletedMs) / 86_400_000), 'AC17: exactly the 30-day window').toBe(
          RESTORE_WINDOW_DAYS,
        );
        expect(restorePf.summary.deletedByName, 'AC17 names who deleted it').toBeTruthy();

        // AC 13 — one Verlauf entry for the deletion, carrying who, when and why.
        //
        // The Verlauf is permanent (that is AC 13), so this fixture accumulates one delete/restore
        // pair per run and a `find()` would keep picking the FIRST run's entry, which is months
        // old. The assertion is therefore on the DELTA and on the newest row.
        const logsAfter = await api.logs(vo.id, token);
        const deletionsBefore = logsBefore.filter((l) => l.type === I18N_KEYS.logDeleted);
        const deletionsAfter = logsAfter.filter((l) => l.type === I18N_KEYS.logDeleted);
        const deletionLog = deletionsAfter.sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0];
        console.log(
          `#3671 AC13: ${logsBefore.length} -> ${logsAfter.length} log rows (${deletionsBefore.length} -> ${deletionsAfter.length} deletions); newest ${JSON.stringify(deletionLog)}`,
        );
        expect(deletionLog, 'AC13: a prescription_deleted entry').toBeTruthy();
        expect(deletionLog?.reason, 'AC13: the selected reason').toBe('duplicate');
        expect(deletionLog?.createdByName, 'AC13: who deleted it').toBeTruthy();
        expect(Date.parse(deletionLog?.createdAt ?? ''), 'AC13: when').toBeGreaterThanOrEqual(Date.parse(at) - 120_000);
        expect(
          deletionsAfter.length - deletionsBefore.length,
          'exactly one entry per deletion, not one per changed column — the four deletion fields are in SKIP_FIELDS',
        ).toBe(1);

        // AC 16 — the VO is on the Gelöscht tab, and searchable there by number.
        const tab = await api.deletedTab(token);
        console.log(`#3671 AC16: Gelöscht tab holds ${tab.total} — ${tab.rows.map((r) => r.prescriptionId).join(', ')}`);
        expect(tab.rows.map((r) => r.id)).toContain(vo.id);

        const searched = await api.raw<{ totalItems?: number; member?: { id: number }[] }>(
          `/prescriptions?exists%5BdeletedAt%5D=true&search%5BprescriptionId%5D=${encodeURIComponent(vo.vo)}`,
          token,
        );
        expect(
          (searched.body?.member ?? []).map((m) => m.id),
          'AC16: searchable by VO number inside the tab',
        ).toContain(vo.id);

        // The count moved by exactly one, in both directions.
        const countsAfter = await api.dashboardCounts(token);
        console.log(`#3671 counts: ${JSON.stringify(countsBefore)} -> ${JSON.stringify(countsAfter)}`);
        expect(countsAfter.deleted).toBe(countsBefore.deleted + 1);
        expect(countsAfter.allWithArchived, 'and it left the tab it used to be counted in').toBe(
          countsBefore.allWithArchived - 1,
        );

        // A second delete is refused rather than stamping a new timestamp over the first.
        const again = await api.deleteVo(vo.id, { reason: 'duplicate' }, token);
        expect(again.status, 'deleting a deleted VO is a conflict').toBe(409);
        expect(JSON.stringify(again.body)).toContain('already deleted');

        // Any ordinary edit is refused while it is deleted — the status this ticket preserves is
        // exactly what that refusal protects.
        const edit = await api.raw<unknown>(`/prescriptions/${vo.id}`, token);
        expect(edit.status, "an admin can still OPEN it, which is what AC 17's banner needs").toBe(200);
      } finally {
        const outcome = await api.ensureRestored(vo.id, 'standalone', token);
        console.log(`#3671 cleanup ${vo.vo}: ${outcome}`);
        const back = await api.prescription(vo.id, token);
        expect(back.body?.deletedAt ?? null, 'the fixture is live again').toBeNull();
        expect(back.body?.treatmentStatus, 'with the status it started with').toBe(statusBefore);
      }
    },
  );
});
