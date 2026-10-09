import { test, expect } from '../../fixtures/session';
import { COL, EXPORT_COLUMNS, InvoiceExportPage } from '../../../Pages/superadmin/sa.invoice-export.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.12 — Per-Gesellschaft date-range invoice export (#3493, PR #3521).
 *
 * A new audit screen, **Rechnungsexport** at `/invoice-export`: pick one Gesellschaft and a date
 * range, review the matching invoices on screen, and download the same set as a CSV. It is
 * deliberately read-only — the Copayment/PKV billing screens keep every mutating action.
 *
 * **Deployed on staging** (2026-08-31): the screen renders, `POST /invoices/audit/export` answers
 * `text/csv`, and every AC below is asserted against live data rather than code reading.
 *
 * **Three surfaces have to agree** and this file compares them directly:
 *  - the FILE — `POST /invoices/audit/export {entity, from, to}`;
 *  - the LIST behind the table — `GET /invoices?billingEntity=&issuedFrom=&issuedTo=`, which is the
 *    exact request the screen makes;
 *  - the SCREEN, driven through the row `aria-label`s ("PDF anzeigen" / "Log anzeigen").
 *
 * **The strongest evidence here is not any single AC but the partition**: the seven per-Gesellschaft
 * exports together contain all 550 invoices in the system, each under exactly one Gesellschaft, none
 * missing and none double-counted. For a file whose purpose is a tax audit, "nothing was silently
 * dropped" is the property that matters, and it is checkable from outside.
 *
 * **Read-only throughout** — every request is a GET, or the export POST, which writes nothing.
 */

/** The date-of-record window used across the file; staging's invoices are all 2026. */
const YEAR = { from: '2026-01-01', to: '2026-12-31' };

/** A Gesellschaft holding both cancelled invoices and their Stornos (AC8). */
const ENTITY_WITH_STORNOS = { id: 1, name: 'Curano Berlin-Brandenburg GmbH' };

/** Small enough to page through on screen, and it holds a Storno pair too. */
const SMALL_ENTITY = { id: 7, name: 'Curano Stuttgart GmbH' };

test.describe('Rechnungsexport — per-Gesellschaft date-range invoice export', () => {
  test(
    'AC1 — the screen offers a Gesellschaft selector and a date range, and gates the export on them',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();

      expect(await screen.dateRangeLabel(), 'the From/To range must be shown').toMatch(
        /Von \/ Bis: \d{2}\.\d{2}\.\d{4} - \d{2}\.\d{2}\.\d{4}/,
      );
      expect(await screen.hintVisible(), 'before a selection the screen must say what is needed').toBe(true);

      // Gated, not merely ignored: the button is `disabled`, and a forced click sends no request and
      // downloads nothing. (The range ships pre-filled with the current year — the PR's stated
      // reading of AC1 — so the Gesellschaft is the only thing left to gate on.)
      expect(await screen.exportDisabled(), 'the export must be disabled before a Gesellschaft is picked').toBe(true);
      const exportPosts: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('audit/export')) exportPosts.push(request.url());
      });
      const attempted = await screen.clickExport(15_000);
      expect(attempted.filename, 'nothing may download before a Gesellschaft is picked').toBeNull();
      expect(exportPosts, 'and no export request may be sent either').toHaveLength(0);

      const options = await screen.openGesellschaftDropdown();
      console.log(`Gesellschaft options: ${options.join(' | ')}`);
      const entities = await screen.entities();
      expect(options.length, 'the selector must offer every Gesellschaft').toBeGreaterThanOrEqual(entities.length);
      for (const entity of entities) {
        expect(options, `${entity.name} must be selectable`).toContain(entity.name);
      }

      await page.keyboard.press('Escape').catch(() => {});
      await screen.selectGesellschaft(SMALL_ENTITY.name);
      expect(await screen.exportDisabled(), 'picking a Gesellschaft must enable the export').toBe(false);
    },
  );

  test(
    'AC2/AC7 — the export lists every invoice in range, both kinds, with the seven required columns',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      const csv = await screen.exportCsv(ENTITY_WITH_STORNOS.id, YEAR.from, YEAR.to);
      console.log(
        `export: ${csv.status} ${csv.contentType} "${csv.filename}" BOM=${csv.hasBom} rows=${csv.rows.length}`,
      );
      expect(csv.status, 'the export must be served').toBe(200);
      expect(csv.contentType, 'as a CSV').toContain('text/csv');
      expect(csv.hasBom, 'with the UTF-8 BOM, or Excel mangles the umlauts in patient names').toBe(true);
      expect(
        csv.filename,
        'the filename must record what was exported — an audit file that cannot be traced back to ' +
          'its Gesellschaft and window is not much use',
      ).toMatch(/^rechnungsexport-gesellschaft-\d+-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);

      // AC7: one row per invoice, carrying the seven required fields (plus the Storno reference).
      expect(csv.header, 'the header must carry every column AC7 names').toEqual([...EXPORT_COLUMNS]);
      expect(csv.rows.length, 'the Gesellschaft must have invoices to export').toBeGreaterThan(0);
      for (const row of csv.rows) {
        expect(row, `row ${row[0]} must have a cell per column`).toHaveLength(EXPORT_COLUMNS.length);
        for (const column of ['Rechnungsnummer', 'Datum', 'Status', 'Betrag', 'Versicherungsart', 'Patient:in', 'Gesellschaft'] as const) {
          expect(row[COL[column]], `row ${row[0]} must carry a ${column}`).not.toBe('');
        }
        expect(row[COL.Datum], `row ${row[0]}'s date must be printed German-style`).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
        expect(row[COL.Betrag], `row ${row[0]}'s amount must be a German decimal`).toMatch(/^-?\d+,\d{2}$/);
        expect(row[COL.Gesellschaft], 'every row must name the Gesellschaft that was exported').toBe(
          ENTITY_WITH_STORNOS.name,
        );
      }

      // Both invoice kinds, active and cancelled — the AC's explicit inclusion list.
      const kinds = new Set(csv.rows.map((r) => r[COL.Versicherungsart]));
      const statuses = new Set(csv.rows.map((r) => r[COL.Status]));
      console.log(`kinds: ${[...kinds].join(', ')} | statuses: ${[...statuses].join(', ')}`);
      expect(kinds, 'GKV copayment invoices must be included').toContain('copayment');
      expect(kinds, 'PKV invoices must be included').toContain('pkv');
      expect(statuses, 'cancelled invoices must be included, not dropped').toContain('cancelled');
      expect([...statuses].some((s) => s !== 'cancelled'), 'and active ones too').toBe(true);
    },
  );

  test(
    'AC2/AC4 — the file and the on-screen list are the same set, for every Gesellschaft',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      // The screen's table and the file come from two different queries upstream (a list filter and
      // a repository method), so "they agree" is a real assertion, not a tautology — and an auditor
      // who reviews on screen and then exports must not get two different answers.
      for (const entity of await screen.entities()) {
        const csv = await screen.exportCsv(entity.id, YEAR.from, YEAR.to);
        const list = await screen.list(entity.id, YEAR.from, YEAR.to, { perPage: 300 });
        console.log(`${entity.name}: csv=${csv.rows.length} list=${list.total}`);
        expect(csv.status, `export for ${entity.name}`).toBe(200);
        expect(list.status, `list for ${entity.name}`).toBe(200);
        expect(csv.rows.length, `${entity.name}: the file must hold exactly what the table shows`).toBe(list.total);
        expect(
          new Set(csv.rows.map((r) => r[COL.Rechnungsnummer])),
          `${entity.name}: and the same invoice numbers, not just the same count`,
        ).toEqual(new Set(list.rows.map((r) => r.invoiceNumber)));
      }
    },
  );

  test(
    'AC2/AC8 — the seven exports partition the whole invoice book, cancelled invoices included',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      // A wide window, so the only thing being tested is the Gesellschaft partition.
      const wide = { from: '2000-01-01', to: '2030-12-31' };
      const owner = new Map<string, number[]>();
      for (const entity of await screen.entities()) {
        const csv = await screen.exportCsv(entity.id, wide.from, wide.to);
        expect(csv.status, `export for ${entity.name}`).toBe(200);
        for (const row of csv.rows) {
          const number = row[COL.Rechnungsnummer];
          owner.set(number, [...(owner.get(number) ?? []), entity.id]);
        }
      }

      const everyInvoice = await screen.listEveryInvoice();
      const exported = new Set(owner.keys());
      const missing = everyInvoice.filter((i) => !exported.has(i.invoiceNumber));
      const duplicated = [...owner.entries()].filter(([, entities]) => entities.length > 1);
      console.log(
        `invoices in the system: ${everyInvoice.length}; rows across all Gesellschaft exports: ${exported.size}; ` +
          `missing: ${missing.length}; under more than one Gesellschaft: ${duplicated.length}`,
      );
      expect(
        missing.map((i) => `${i.id}/${i.invoiceNumber}`),
        'an invoice that belongs to no Gesellschaft export is invisible to an audit — the export ' +
          'would silently under-report',
      ).toEqual([]);
      expect(
        duplicated.map(([number, entities]) => `${number} -> ${entities.join(',')}`),
        'and one billed under two Gesellschaften would double-count',
      ).toEqual([]);

      // AC8, from the other side: every cancelled invoice must be present, marked cancelled, and
      // carry the number of the Storno that reverses it — which must itself be a row, negative.
      const cancelled = everyInvoice.filter((i) => i.status === 'cancelled');
      expect(cancelled.length, 'staging must have cancelled invoices for this to mean anything').toBeGreaterThan(0);
      const rowsByNumber = new Map<string, string[]>();
      for (const entity of await screen.entities()) {
        const csv = await screen.exportCsv(entity.id, wide.from, wide.to);
        for (const row of csv.rows) rowsByNumber.set(row[COL.Rechnungsnummer], row);
      }
      for (const invoice of cancelled) {
        const row = rowsByNumber.get(invoice.invoiceNumber);
        expect(row, `cancelled invoice ${invoice.invoiceNumber} must appear in its Gesellschaft's export`).toBeTruthy();
        expect(row![COL.Status], `${invoice.invoiceNumber} must be shown as cancelled`).toBe('cancelled');
        const storno = row![COL.Stornorechnung];
        expect(storno, `${invoice.invoiceNumber} must name its Stornorechnung`).not.toBe('');
        const stornoRow = rowsByNumber.get(storno);
        expect(stornoRow, `the Stornorechnung ${storno} must be its own row, traceable on its own`).toBeTruthy();
        expect(
          stornoRow![COL.Betrag],
          `and ${storno} must reverse the amount, or the export does not foot`,
        ).toMatch(/^-/);
        console.log(`  ${invoice.invoiceNumber} ${row![COL.Betrag]} -> ${storno} ${stornoRow![COL.Betrag]}`);
      }
    },
  );

  test(
    'AC8 — the Stornos are only in the export because the date filter falls back to createdAt',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      // The filter is on COALESCE(issueDate, createdAt). That is not a defensive nicety on this data:
      // every Storno document on staging has a NULL issueDate, so an issueDate-only filter would drop
      // all of them — and AC8 is precisely that they must never be dropped.
      const everyInvoice = await screen.listEveryInvoice();
      const withoutIssueDate = everyInvoice.filter((i) => !i.issueDate);
      console.log(
        `invoices with no issueDate: ${withoutIssueDate.length} — ` +
          withoutIssueDate.map((i) => i.invoiceNumber).join(', '),
      );
      expect(withoutIssueDate.length, 'staging must still hold invoices with no issueDate').toBeGreaterThan(0);

      for (const invoice of withoutIssueDate) {
        const day = (invoice.createdAt ?? '').slice(0, 10);
        expect(day, `${invoice.invoiceNumber} must at least have a createdAt to fall back to`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const entity = await screen.entityOfInvoice(invoice.invoiceNumber);
        expect(entity, `${invoice.invoiceNumber} must belong to a Gesellschaft`).toBeTruthy();
        const sameDay = await screen.exportCsv(entity!, day, day);
        expect(
          sameDay.rows.map((r) => r[COL.Rechnungsnummer]),
          `${invoice.invoiceNumber} has no issueDate, so it can only be found by its createdAt (${day})`,
        ).toContain(invoice.invoiceNumber);
      }
    },
  );

  test(
    'AC3 — an empty range downloads a file with no rows, never an error',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      const entities = await screen.entities();
      const counts = await Promise.all(
        entities.map(async (e) => ({ entity: e, total: (await screen.list(e.id, '2000-01-01', '2030-12-31', { perPage: 1 })).total })),
      );
      const empty = counts.find((c) => c.total === 0);

      // Two ways to be empty, and the AC covers both: a Gesellschaft with no invoices at all, and a
      // window that happens to contain none.
      const cases = [
        ...(empty ? [{ label: `${empty.entity.name} (no invoices at all)`, entity: empty.entity.id, from: '2000-01-01', to: '2030-12-31' }] : []),
        { label: `${entities[0].name} in 2019`, entity: entities[0].id, from: '2019-01-01', to: '2019-12-31' },
      ];
      for (const { label, entity, from, to } of cases) {
        const csv = await screen.exportCsv(entity, from, to);
        console.log(`${label}: ${csv.status}, ${csv.rows.length} rows, header ${csv.header.join('|')}`);
        expect(csv.status, `${label} must still download`).toBe(200);
        expect(csv.header, `${label} must carry the header — proof the check ran`).toEqual([...EXPORT_COLUMNS]);
        expect(csv.rows, `${label} must have no invoice rows`).toHaveLength(0);
      }
      if (!empty) console.log('no Gesellschaft is invoice-free on staging today; the empty window case still covers AC3');
    },
  );

  test(
    'AC4/AC7 — the on-screen table shows the same rows, with the columns AC7 lists',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();
      await screen.selectGesellschaft(SMALL_ENTITY.name);

      const headers = await screen.tableHeaders();
      console.log(`table headers: ${headers.join(' | ')}`);
      for (const column of EXPORT_COLUMNS) {
        expect(headers, `the table must show a ${column} column`).toContain(column);
      }
      expect(headers, 'and the per-row view actions AC5 asks for').toContain('Anzeigen');

      const total = await screen.pagerTotal();
      const list = await screen.list(SMALL_ENTITY.id, YEAR.from, YEAR.to, { perPage: 300 });
      console.log(`pager total ${total} vs list total ${list.total}`);
      expect(total, 'the table must show the whole matching set, not a truncated page').toBe(list.total);

      // One row, cell by cell, against the API's own record of that invoice.
      const numbers = await screen.rowNumbers();
      expect(numbers.length, 'the first page must paint rows').toBeGreaterThan(0);
      const first = list.rows.find((r) => r.invoiceNumber === numbers[0])!;
      const cells = await screen.rowCells(numbers[0]);
      console.log(`row ${numbers[0]}: ${cells?.join(' | ')}`);
      expect(cells, `row ${numbers[0]} must render`).toBeTruthy();
      // The row renders the amount as "22,82 €" with a NON-BREAKING space before the sign, so the
      // comparison normalises whitespace; the value itself is built the German way (1.143,72).
      const rendered = cells!.join(' ').replace(/\u00a0/g, ' ');
      expect(rendered, 'the row must name its patient').toContain(first.patient!);
      expect(rendered, 'and its Gesellschaft').toContain(SMALL_ENTITY.name);
      expect(rendered, 'and the invoice kind as GKV or PKV').toMatch(/\b(GKV|PKV)\b/);
      const germanAmount = first.invoiceAmount!.toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(rendered, 'and the amount, formatted for the reader').toContain(`${germanAmount} €`);
    },
  );

  // The two row actions are exercised in separate tests on purpose: only one overlay can be mounted
  // at a time, so a modal left open swallows the next click — which reads as "the action does
  // nothing" rather than as the test's own fault.
  test(
    'AC5 — a row opens its invoice PDF without leaving the screen',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();
      await screen.selectGesellschaft(SMALL_ENTITY.name);

      const calls: string[] = [];
      page.on('request', (request) => {
        if (/\/invoices\/\d+\/(storno\/)?download/.test(request.url())) calls.push(request.url());
      });

      const target = (await screen.rowNumbers())[0];
      expect(await screen.clickRowAction(target, 'PDF anzeigen'), `row ${target} must offer a PDF action`).toBe(true);
      await expect
        .poll(() => calls.length, { message: 'the PDF action must fetch the invoice document', timeout: 60_000 })
        .toBeGreaterThan(0);
      console.log(`PDF action for ${target} fetched: ${calls[0]}`);
      expect(page.url(), 'and it must not navigate away from the export screen').toContain(InvoiceExportPage.ROUTE);
    },
  );

  test(
    'AC5 — a row opens its status change log without leaving the screen',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();
      await screen.selectGesellschaft(SMALL_ENTITY.name);

      const calls: string[] = [];
      page.on('request', (request) => {
        if (/invoice_logs/.test(request.url())) calls.push(request.url());
      });

      const target = (await screen.rowNumbers())[0];
      expect(await screen.clickRowAction(target, 'Log anzeigen'), `row ${target} must offer a Log action`).toBe(true);
      await expect
        .poll(() => calls.length, { message: 'the Log action must fetch that invoice\'s history', timeout: 60_000 })
        .toBeGreaterThan(0);
      const heading = await screen.logModalHeading();
      console.log(`log modal: ${heading} (request ${calls[0]})`);
      expect(heading, 'the log must open in place, naming the invoice it belongs to').toContain(target);
      expect(page.url(), 'still without leaving the screen').toContain(InvoiceExportPage.ROUTE);
    },
  );

  test(
    'AC5 — a Storno row serves the cancellation document, which is addressed by the ORIGINAL invoice',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      // A Storno is its own Invoice row in the export, but its PDF is NOT at its own id: the
      // cancellation document hangs off the invoice it reverses. Getting this wrong is invisible in
      // a list and fatal for the one row an auditor most wants to open.
      const list = await screen.list(ENTITY_WITH_STORNOS.id, YEAR.from, YEAR.to, { perPage: 300 });
      const storno = list.rows.find((r) => r.invoiceType === 'storno');
      expect(storno, 'this Gesellschaft must hold a Storno row').toBeTruthy();
      expect(storno!.originalInvoiceId, 'the row must expose the original invoice it reverses').toBeTruthy();

      const viaOriginal = await screen.downloadPdf(`/invoices/${storno!.originalInvoiceId}/storno/download`);
      const viaItself = await screen.downloadPdf(`/invoices/${storno!.id}/storno/download`);
      console.log(
        `${storno!.invoiceNumber}: via original ${storno!.originalInvoiceId} -> ${viaOriginal.status} ` +
          `${viaOriginal.bytes}B; via its own id ${storno!.id} -> ${viaItself.status} "${viaItself.detail}"`,
      );
      expect(viaOriginal.status, 'the Storno document must be served through its original invoice').toBe(200);
      expect(viaOriginal.bytes, 'and be a real document').toBeGreaterThan(1000);
      expect(viaItself.status, 'a Storno has no Storno of its own — that route must 404').toBe(404);

      const logs = await screen.invoiceLogs(storno!.originalInvoiceId!);
      expect(logs.total, 'the cancelled invoice must carry a status history to show').toBeGreaterThan(0);
      expect(
        JSON.stringify(logs.entries),
        'and that history must record the cancellation that produced this Storno',
      ).toContain(storno!.invoiceNumber);
    },
  );

  test(
    'AC6 — the screen offers nothing beyond viewing and exporting',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();
      await screen.selectGesellschaft(SMALL_ENTITY.name);

      // The labels every mutating action on the Copayment/PKV billing screens is reached by. None of
      // them may exist here — this screen is also what the read-only Auditor role (#3494) will see.
      const forbidden = [
        'Als gesendet markieren',
        'Als bezahlt markieren',
        'Stornieren',
        'Rechnung neu erstellen',
        'Entwurf ersetzen',
        'Status ändern',
        'An ETI Experts senden',
        'Mahnung',
        'Löschen',
      ];
      const found = await screen.labelsPresent(forbidden);
      console.log(`mutating labels on the screen: ${JSON.stringify(found)}`);
      for (const [label, count] of Object.entries(found)) {
        expect(count, `"${label}" must not be offered on the export screen`).toBe(0);
      }

      // The status cells are rendered as disabled chips — on the billing screens the same cell is the
      // control that changes the status.
      const chip = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
        const status = nodes.find((n) => /^(Nicht gesendet|Gesendet|Überfällig|Storniert|Bezahlt|Gemahnt)$/.test((n as HTMLElement).innerText?.trim() ?? ''));
        if (!status) return null;
        const el = status as HTMLElement;
        return {
          text: el.innerText.trim(),
          disabled: (el as HTMLButtonElement).disabled,
          ariaDisabled: el.getAttribute('aria-disabled'),
          pointerEvents: getComputedStyle(el).pointerEvents,
        };
      });
      console.log(`status chip: ${JSON.stringify(chip)}`);
      if (chip) {
        expect(
          chip.disabled || chip.ariaDisabled === 'true' || chip.pointerEvents === 'none',
          `the status chip "${chip.text}" must be inert here, not a status control`,
        ).toBe(true);
      }

      // And the PDF preview must not carry the billing screens' action either.
      const numbers = await screen.rowNumbers();
      await screen.clickRowAction(numbers[0], 'PDF anzeigen');
      await page.waitForTimeout(5000);
      const inModal = await screen.labelsPresent(['Als gesendet markieren', 'Rechnung neu erstellen']);
      console.log(`mutating labels inside the PDF preview: ${JSON.stringify(inModal)}`);
      for (const [label, count] of Object.entries(inModal)) {
        expect(count, `"${label}" must not be offered inside the preview either`).toBe(0);
      }
      await screen.closeOverlay();
    },
  );

  test(
    'AC1/AC2 — the export button downloads the same file the API serves',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const screen = new InvoiceExportPage(page);
      await screen.openScreen();
      await screen.selectGesellschaft(SMALL_ENTITY.name);

      const download = await screen.clickExport();
      console.log(`downloaded "${download.filename}" (${download.text?.length ?? 0} chars)`);
      expect(download.filename, 'the button must actually download a file').toMatch(/\.csv$/);
      expect(download.filename, 'named for the Gesellschaft and window it covers').toContain(
        `gesellschaft-${SMALL_ENTITY.id}`,
      );
      const rows = InvoiceExportPage.parseCsv((download.text ?? '').replace(/^﻿/, ''));
      expect(rows[0], 'with the audit columns').toEqual([...EXPORT_COLUMNS]);

      const api = await screen.exportCsv(SMALL_ENTITY.id, YEAR.from, YEAR.to);
      expect(
        rows.slice(1).map((r) => r[COL.Rechnungsnummer]),
        'and the same rows the endpoint serves — the button must not filter differently',
      ).toEqual(api.rows.map((r) => r[COL.Rechnungsnummer]));
    },
  );

  test(
    'Access — the export and its list are admin-only',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      // The gate is a dedicated voter (AUDIT_INVOICES), which is the single seam #3494's read-only
      // Auditor role widens — so where it stands today is worth pinning.
      const therapist = await screen.tokenFor(STAGING_CREDENTIALS.therapist);
      const therapistExport = await screen.exportCsv(ENTITY_WITH_STORNOS.id, YEAR.from, YEAR.to, therapist);
      const therapistList = await screen.list(ENTITY_WITH_STORNOS.id, YEAR.from, YEAR.to, { token: therapist });
      console.log(`therapist: export ${therapistExport.status} ("${therapistExport.detail}"), list ${therapistList.status}`);
      expect(therapistExport.status, 'a therapist must not be able to export invoices').toBe(403);
      expect(therapistList.status, 'nor read the list behind the table').toBe(403);

      const admin = await screen.tokenFor(STAGING_CREDENTIALS.admin);
      const adminExport = await screen.exportCsv(ENTITY_WITH_STORNOS.id, YEAR.from, YEAR.to, admin);
      console.log(`admin: export ${adminExport.status}, ${adminExport.rows.length} rows`);
      expect(adminExport.status, 'an admin is an authorized user for this screen').toBe(200);
      expect(adminExport.rows.length, 'and gets the same file').toBeGreaterThan(0);
    },
  );

  test(
    'Input validation — a malformed request is rejected with a message that names the field',
    { tag: ['@SuperAdmin', '@InvoiceExport', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const screen = new InvoiceExportPage(page);
      await screen.connect();

      const cases: { label: string; entity: number | string; from: string; to: string; detail: string }[] = [
        { label: 'German dates', entity: 1, from: '01.01.2026', to: '31.12.2026', detail: 'from must be a Y-m-d date.' },
        { label: 'to before from', entity: 1, from: '2026-12-31', to: '2026-01-01', detail: 'to must not be before from.' },
        { label: 'no entity', entity: '', from: YEAR.from, to: YEAR.to, detail: 'entity must be a Gesellschaft id.' },
      ];
      for (const { label, entity, from, to, detail } of cases) {
        const csv = await screen.exportCsv(entity, from, to);
        console.log(`${label}: ${csv.status} "${csv.detail}"`);
        expect(csv.status, `${label} must be rejected`).toBe(400);
        expect(csv.detail, `${label} must say which field is wrong`).toBe(detail);
      }
    },
  );

  test('AC7 — the file prints the same status and insurance labels the screen does', { tag: ['@SuperAdmin', '@InvoiceExport'] }, async () => {
    test.fixme(
      true,
      'Product decision, not a bug: the file and the screen disagree on two of AC7\'s own columns. ' +
        'For the same rows the on-screen table prints "Nicht gesendet" / "Überfällig" / "Storniert" ' +
        'and "GKV" / "PKV", while the CSV prints the raw enum — not_sent, overdue, cancelled, ' +
        'to_send_to_dc — and copayment / pkv / storno. AC7 asks for "the insurance type (GKV or PKV) ' +
        '… matching what admins already see on the Copayment/PKV billing screens", and those screens ' +
        'label statuses in words ("Not Sent", "Overdue", "Sent to Optica", "Cancelled"); the PM\'s own ' +
        'note expects "Sent to Optica" to appear as a column value. A Finanzamt auditor reading ' +
        'to_send_to_dc in a tax file is the case to weigh. Everything else about the columns is ' +
        'asserted above; only the vocabulary is at issue.',
    );
  });

  test('AC3 — an unknown Gesellschaft id is answered with an empty file rather than an error', { tag: ['@SuperAdmin', '@InvoiceExport'] }, async () => {
    test.fixme(
      true,
      'Observation for the PM, deliberately not asserted either way. POST {entity: 999} — an id no ' +
        'Gesellschaft has — returns 200 with a header-only file, indistinguishable from "this ' +
        'Gesellschaft issued no invoices in this window" (AC3\'s intended outcome). The screen can ' +
        'only send ids from its own dropdown, so a user cannot reach it; but the endpoint is also ' +
        'the seam #3494 opens to an external auditor, where an empty file that means "your id was ' +
        'wrong" is a worse answer than a 404. Malformed dates and a missing entity ARE rejected — ' +
        'see the validation test above.',
    );
  });
});
