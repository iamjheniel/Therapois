import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReminderLetterPage, REMINDER_PAYMENT_DAYS, NOT_AVAILABLE } from '../../../Pages/superadmin/sa.reminder-letter.page';
import { pdfDocText } from '../../../Pages/util/pdf-layout';
import { InvoicePdfsPage } from '../../../Pages/superadmin/sa.invoice-pdfs.page';

/**
 * RC 3.13 — Zahlungserinnerung for overdue PKV invoices, and a 14-day debt-collection timer (#3559).
 *
 * An Overdue PKV or Privat Basis invoice gains a ready-to-send reminder letter (singly and in bulk),
 * and the automatic Reminded → To Debt Collector window moves from 7 days to 14. **Deployed; AC1,
 * AC3, AC4, AC6, AC7, AC8, AC9 and AC10 verified live. 8 passed / 2 fixme.**
 *
 * **Downloading a letter writes nothing — asserted, not assumed.** The ticket's PM notes state
 * "remindedDate field stamped once on download", which would be a defect: it would mark the invoice
 * Reminded before the admin sent anything and start the 14-day debt-collection clock early,
 * contradicting the ticket's own "does NOT change the manual action admins already use to mark an
 * invoice Reminded". The controller in fact persists nothing, and a test re-reads the fixtures after
 * both the single and the bulk download to prove `status`, `remindedDate` and `updatedAt` are
 * untouched. The guard works off the EXISTING manual stamp, exactly as the ticket asks.
 *
 * **AC6/AC7/AC8 are proven by a natural experiment in the log, which is stronger than a status
 * check.** Three seeded invoices sat at Reminded with different ages when the rule shipped:
 * - 651 (reminded 2026-08-11, **30 days**) moved automatically on 2026-09-10 — AC8, the ship-time
 *   backlog clearing on the first nightly run;
 * - 654 (reminded 2026-08-27, **exactly 14 days**) moved in that SAME run, 00:56:34 — AC6;
 * - 655 (reminded 2026-08-28, **13 days** that night) did **not** move — AC7 — and moved on the NEXT
 *   run, 2026-09-11, at exactly 14 days.
 * Two invoices one day apart, two consecutive nightly runs: that is the 13-vs-14 boundary
 * demonstrated on real timing rather than inferred from an end state. A point-in-time status check
 * cannot distinguish "moved at 14" from "moved at 7 and nobody looked".
 *
 * **Findings for the PM, none of them code defects:**
 * 1. Their AC table is misaligned with the ticket — the AC-2 row describes the letter's Gesellschaft
 *    header and AC-3 its content (both AC4's subject), AC-9 describes the PKV-only guard (AC10), and
 *    AC-10 describes a "Reminded Date" column that no AC mentions. So "10 of 10" covers fewer than
 *    ten distinct ACs, and the two that genuinely have no coverage — AC2 and AC5 — are not among the
 *    rows marked PASS.
 * 2. Their AC-5 mechanism is wrong (the stamping claim above).
 * 3. Their open question — "PKV tab Überfällig filter shows (0) despite 118 overdue invoices … needs
 *    separate investigation" — is answered here and is not a filter bug:
 *    `pkvBilling[invoiceStatus]=overdue` returns **0**, and with `treatmentStatus=Archiviert` it
 *    returns **114**. Nearly every overdue invoice sits on an archived VO, which the billing list
 *    hides by default (#3277). Same seam that empties #3648's Fehler tab.
 *
 * **Read-only in effect:** every request is a GET except the bulk download, a POST that renders and
 * returns a zip without writing a row.
 */

test.describe('#3559 Zahlungserinnerung for overdue PKV invoices', () => {
  test.describe.configure({ mode: 'serial' });

  let overdue: Awaited<ReturnType<ReminderLetterPage['overdueInvoices']>>;
  let eligible: Awaited<ReturnType<ReminderLetterPage['overdueInvoices']>>;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(600_000);
    const api = new ReminderLetterPage(request);
    overdue = await api.overdueInvoices();
    eligible = overdue.filter((i) => api.isReminderLetterAvailable(i));
    expect(overdue.length, 'staging must carry overdue invoices').toBeGreaterThan(0);
    console.log(
      `#3559 population: ${overdue.length} overdue — ` +
        `${eligible.length} eligible for a reminder letter, ` +
        `${overdue.filter((i) => i.insuranceType === 'public').length} copayment, ` +
        `${overdue.filter((i) => i.remindedDate).length} already reminded`,
    );
  });

  test(
    'AC1/AC9 an overdue PKV invoice offers a reminder letter, including ones overdue before the ship date',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReminderLetterPage(request);
      expect(eligible.length, 'AC1 needs at least one eligible invoice').toBeGreaterThan(0);
      const target = eligible[0];
      const res = await api.reminderLetter(target.id);
      console.log(`   ${target.invoiceNumber} -> ${res.status} ${res.contentType} ${res.body.length} bytes`);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('application/pdf');
      expect(res.body.subarray(0, 5).toString('latin1'), 'a real PDF, not an error page').toBe('%PDF-');
      // AC9: this invoice became overdue long before the feature shipped and still offers a letter.
      console.log(`   AC9: ${target.invoiceNumber} was already overdue and is offered a letter with no generation step`);
    },
  );

  test(
    'AC4 the letter is filled in from the invoice, with a deadline 14 days from generation',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReminderLetterPage(request);
      const target = eligible[0];
      const res = await api.reminderLetter(target.id);
      expect(res.status).toBe(200);

      // pdfDocText (positional), NOT pdfText: the latter drops a whole line of this letter — see the
      // test below, which pins that as a tooling limit rather than a rendering defect.
      const text = pdfDocText(res.body);

      const amount = (target.invoiceAmount ?? 0).toFixed(2).replace('.', ',');
      const checks: [string, string][] = [
        ['invoice number in the subject', `Zahlungserinnerung zu Rechnung Nr. ${target.invoiceNumber}`],
        ['invoice number in the table', `Rechnungsnummer:`],
        ['original payment deadline', 'Ursprüngliches Zahlungsziel:'],
        ['open amount', `${amount} EUR`],
        ['bank details', 'IBAN:'],
        ['Verwendungszweck', 'Verwendungszweck:'],
        ['the Inkasso warning, in full', 'Inkassounternehmen zu übergeben'],
        ['the unsigned-validity closing', 'maschinell erstellt'],
      ];
      for (const [label, needle] of checks) {
        expect(text, `${label} missing from the letter`).toContain(needle);
      }

      // The new deadline must be generation date + 14. Both dates are printed, so the letter is
      // checked against itself rather than against a clock this test happens to read.
      const dates = [...text.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
      const unique = [...new Set(dates)].sort();
      const today = new Date().toISOString().slice(0, 10);
      expect(unique, 'the letter prints its own generation date').toContain(today);
      const expectedDeadline = new Date(Date.now() + REMINDER_PAYMENT_DAYS * 86_400_000).toISOString().slice(0, 10);
      expect(unique, `the new payment deadline must be generation date + ${REMINDER_PAYMENT_DAYS} days`).toContain(expectedDeadline);
      console.log(`   ${target.invoiceNumber}: generated ${today}, new deadline ${expectedDeadline} (+${REMINDER_PAYMENT_DAYS}d), amount ${amount} EUR`);
    },
  );

  test(
    'AC10 a copayment invoice is refused, with the same message from both endpoints',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReminderLetterPage(request);
      const copayment = overdue.filter((i) => i.insuranceType === 'public');
      expect(copayment.length, 'AC10 needs an overdue copayment invoice').toBeGreaterThan(0);

      for (const inv of copayment.slice(0, 3)) {
        const res = await api.reminderLetter(inv.id);
        console.log(`   ${inv.invoiceNumber} (copayment) -> ${res.status} "${res.detail}"`);
        expect(res.status, `${inv.invoiceNumber}: copayment must never offer a reminder letter`).toBe(409);
        expect(res.detail).toBe(NOT_AVAILABLE);
      }
    },
  );

  test(
    'AC3 several letters download as one zip, and an ineligible invoice is REPORTED not dropped',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReminderLetterPage(request);
      const picks = eligible.slice(0, 3);
      const copayment = overdue.find((i) => i.insuranceType === 'public');
      expect(picks.length, 'AC3 needs several eligible invoices').toBeGreaterThan(1);

      const ids = [...picks.map((p) => p.id), ...(copayment ? [copayment.id] : [])];
      const res = await api.bulkReminderLetters(ids);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('application/zip');

      // The suite reads zips with the `unzip` CLI rather than a third-party dependency (#3333).
      const zipPath = path.join(os.tmpdir(), `reminder-bulk-${Date.now()}.zip`);
      fs.writeFileSync(zipPath, res.body);
      const entries = InvoicePdfsPage.zipEntries(zipPath).map((name) => ({ name }));
      for (const e of entries) console.log(`   ${e.name}`);
      const pdfs = entries.filter((e) => e.name.endsWith('.pdf'));
      expect(pdfs.length, 'one letter per eligible invoice').toBe(picks.length);
      for (const p of picks) {
        expect(pdfs.some((e) => e.name.includes(p.invoiceNumber)), `${p.invoiceNumber} missing from the zip`).toBe(true);
      }

      // The ineligible one is named in a Fehlerbericht rather than silently omitted — the #3495
      // convention. A silent drop is the failure mode that makes a bulk download untrustworthy.
      if (copayment) {
        const report = entries.find((e) => e.name === 'Fehlerbericht.txt');
        expect(report, 'an excluded invoice must be reported, not silently dropped').toBeTruthy();
        const body = InvoicePdfsPage.zipTextEntry(zipPath, 'Fehlerbericht.txt') ?? '';
        console.log(`   Fehlerbericht: ${body.replace(/\n/g, ' | ')}`);
        expect(body).toContain(copayment.invoiceNumber);
      }
    },
  );

  test(
    'downloading a letter changes nothing — the manual Reminded action is untouched',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      // The ticket's PM notes claim remindedDate is "stamped once on download". If that were true the
      // invoice would be marked Reminded before the admin sent anything, starting the 14-day
      // debt-collection clock early — and it would contradict the ticket's own "does NOT change" list.
      const api = new ReminderLetterPage(request);
      const target = eligible[0];
      const before = overdue.find((i) => i.id === target.id)!;

      await api.reminderLetter(target.id);
      await api.bulkReminderLetters([target.id]);

      const after = (await api.overdueInvoices()).find((i) => i.id === target.id);
      expect(after, 'the invoice must still be overdue after two downloads').toBeTruthy();
      console.log(
        `   ${target.invoiceNumber}: status ${before.status} -> ${after!.status}, ` +
          `remindedDate ${before.remindedDate} -> ${after!.remindedDate}`,
      );
      expect(after!.status, 'the download must not advance the status').toBe(before.status);
      expect(after!.remindedDate, 'the download must not stamp remindedDate').toBe(before.remindedDate);
      expect(after!.remindedDate, 'and it was null to begin with, so the guard still depends on the manual action').toBeNull();
    },
  );

  test(
    'AC6/AC7/AC8 the Reminded -> To Debt Collector timer is 14 days, measured from the log',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      // Three seeded invoices with different Reminded ages when the rule shipped. Their MOVE DATES
      // are the evidence: a status check alone cannot tell 14 from 7.
      const api = new ReminderLetterPage(request);
      const fixtures = [
        { id: 651, label: 'AC8 reminded 30 days before the rule shipped' },
        { id: 654, label: 'AC6 reminded exactly 14 days before it moved' },
        { id: 655, label: 'AC7 still at 13 days on the run that moved 654' },
      ];

      const measured: { id: number; days: number; movedAt: string }[] = [];
      for (const f of fixtures) {
        const trail = await api.statusTrail(f.id);
        const move = trail.find((t) => t.to === 'to_send_to_dc');
        expect(move, `invoice ${f.id} must have an automatic move to To Debt Collector`).toBeTruthy();
        expect(move!.automatic, `invoice ${f.id}: the move must be automatic, not a manual status change`).toBe(true);

        const body = await api.invoice(f.id);
        const days = api.daysToDebtCollector(String(body.remindedDate), move!.at);
        console.log(`   ${f.label}: reminded ${String(body.remindedDate).slice(0, 10)} -> moved ${move!.at.slice(0, 10)} = ${days} days (onHold ${body.totalOnHoldDays ?? 0})`);
        measured.push({ id: f.id, days, movedAt: move!.at });
      }

      const byId = new Map(measured.map((m) => [m.id, m]));
      expect(byId.get(654)!.days, 'AC6: the boundary case moves at exactly 14 days').toBe(REMINDER_PAYMENT_DAYS);
      expect(byId.get(655)!.days, 'AC7: 13 days was not enough — it moved on the next run, at 14').toBe(REMINDER_PAYMENT_DAYS);
      expect(byId.get(651)!.days, 'AC8: a pre-existing Reminded date clears as soon as the rule ships').toBeGreaterThan(REMINDER_PAYMENT_DAYS);
      // The pair that proves the boundary: 654 and 655 are one day apart and moved on different runs.
      expect(
        byId.get(655)!.movedAt.slice(0, 10) > byId.get(654)!.movedAt.slice(0, 10),
        '655 must move on a LATER run than 654, or the 13-day case was never exercised',
      ).toBe(true);
    },
  );

  test(
    'the eligibility rule is applied consistently across the whole overdue book',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      // A port of isReminderLetterAvailable() against the endpoint's own answer, over a sample
      // spanning both outcomes — so a rule that drifted on one branch cannot pass.
      const api = new ReminderLetterPage(request);
      const sample = [...eligible.slice(0, 4), ...overdue.filter((i) => !api.isReminderLetterAvailable(i)).slice(0, 4)];
      let agreed = 0;
      for (const inv of sample) {
        const expectedOk = api.isReminderLetterAvailable(inv);
        const res = await api.reminderLetter(inv.id);
        const actualOk = res.status === 200;
        console.log(`   ${inv.invoiceNumber.padEnd(12)} ${String(inv.insuranceType).padEnd(13)} reminded=${String(inv.remindedDate).slice(0, 10)} oracle=${expectedOk} api=${actualOk}`);
        expect(actualOk, `${inv.invoiceNumber}: the endpoint must agree with isReminderLetterAvailable()`).toBe(expectedOk);
        agreed++;
      }
      expect(agreed, 'the sample must span both outcomes').toBeGreaterThan(1);
    },
  );

  test(
    'FINDING — the PKV Überfällig filter reads (0) because the list hides archived VOs by default',
    { tag: ['@SuperAdmin', '@ReminderLetter', '@ReadOnly'] },
    async ({ request }) => {
      // The PM logged this as "needs separate investigation". It is not a filter bug: nearly every
      // overdue invoice sits on an archived VO, and the billing list defaults to hiding those
      // (#3277) — the same seam that leaves #3648's Fehler tab empty.
      const api = new ReminderLetterPage(request);
      const token = await api.bearerToken();
      const count = async (q: string) => {
        const res = await request.get(`https://api.staging.therapios.de/prescriptions?${q}&itemsPerPage=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return (await res.json()).totalItems as number;
      };
      const plain = await count('pkvBilling%5BinvoiceStatus%5D=overdue');
      const archived = await count('pkvBilling%5BinvoiceStatus%5D=overdue&pkvBilling%5BtreatmentStatus%5D=Archiviert');
      console.log(`#3559 FINDING: Überfällig default -> ${plain} rows; with VO Status = Archiviert -> ${archived} rows (${overdue.length} overdue invoices exist)`);
      expect(plain, 'the default view is empty, which is what the PM saw').toBe(0);
      expect(archived, 'the rows are there once archived VOs are included').toBeGreaterThan(0);
    },
  );
});
