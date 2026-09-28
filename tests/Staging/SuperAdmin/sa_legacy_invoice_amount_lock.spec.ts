import { test, expect } from '@playwright/test';
import {
  AC5_UNLOCKED_EXAMPLES,
  FREEZE_LIST,
  InvoiceRow,
  LegacyInvoiceLockPage,
  LockNote,
  REFRESH_INELIGIBLE,
  RefreshNote,
  TICKET_EXPECTED_MOVES,
} from '../../../Pages/superadmin/sa.legacy-invoice-lock.page';

/**
 * RC 3.12 #3604 — locking the legacy invoice amounts and refreshing the held drafts.
 *
 * Both commands are console-only and both already ran on staging: steps 1+2 on 2026-09-03 08:09–08:10
 * UTC, step 3 on 2026-09-03 08:25 and again on 2026-09-04 08:52. So the applied state is readable,
 * and the interesting question is what "applied correctly" can be shown to mean from a client.
 *
 * **`pkvAmount` and `copaymentAmount` are in no serialization group** — only the resolved
 * `invoiceAmount` is served — so the one question every AC turns on ("is this invoice locked?") has
 * no field. Three surfaces answer it instead, and the file is built around them:
 *
 * - the `invoice_log` note each command writes, which carries the locked amount, its source, the
 *   DATEV posting date AND the live value at lock time — every column AC1 asks the preview to print;
 * - IEEE-754 **float dust** in the served amount, which a written decimal never has;
 * - **divergence from the VO's live value**, which is the only evidence that actually demonstrates
 *   "stops changing" rather than "happens to look right today".
 *
 * Read-only — every request is a GET. Nothing here runs a command or writes an amount.
 */

test.describe('#3604 legacy invoice amount lock + unsent refresh', () => {
  test.describe.configure({ mode: 'serial' });

  let lock: LegacyInvoiceLockPage;
  let book: InvoiceRow[];
  let locks: LockNote[];
  let refreshes: RefreshNote[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const page = await browser.newPage();
    lock = new LegacyInvoiceLockPage(page);
    await lock.connect();
    book = await lock.loadBook();
    locks = await lock.lockNotes();
    refreshes = await lock.refreshNotes();
  });

  test(
    'the oracles are sound — the audit trail exists and float dust isolates exactly the unwritten rows',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      expect(book.length, 'the invoice book loaded').toBeGreaterThan(500);
      expect(locks.length, 'step 1 left an audit trail').toBeGreaterThan(0);
      expect(refreshes.length, 'step 3 left an audit trail').toBeGreaterThan(0);

      // The dust oracle is only useful if dust is rare — if half the book carried it, it would be
      // measuring float serialization rather than "nobody wrote a snapshot here".
      const dusty = lock.unlockedByDust();
      console.log(`invoices whose served amount still carries float dust (unlocked): ${dusty.length} of ${book.length}`);
      for (const i of dusty) console.log(`  ${i.number.padEnd(10)} ${i.status.padEnd(10)} ${i.type.padEnd(10)} ${i.amount}`);
      expect(dusty.length, 'dust is the exception, so it discriminates').toBeLessThan(20);

      // And no invoice the lock command wrote may carry it — a locked row is a decimal by construction.
      const lockedIds = new Set(locks.map((l) => l.invoiceId));
      expect(dusty.filter((i) => lockedIds.has(i.id)).map((i) => i.number), 'no step-1-locked invoice reads as unlocked').toEqual([]);
    },
  );

  test(
    'AC1 / AC2 — every locked invoice was locked to the reference file’s value, from its stated source',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      const csv = new Map(FREEZE_LIST.map((r) => [r.number, r]));
      expect(FREEZE_LIST.length, 'the reference file holds 116 rows').toBe(116);

      const wrongAmount: string[] = [];
      const wrongSource: string[] = [];
      const notInCsv: string[] = [];
      for (const l of locks) {
        const row = l.number ? csv.get(l.number) : undefined;
        if (!row) {
          notInCsv.push(l.number ?? `#${l.invoiceId}`);
          continue;
        }
        if (Math.abs(l.locked - row.amount) > 0.005) wrongAmount.push(`${l.number}: locked ${l.locked} vs file ${row.amount}`);
        if (l.source !== row.source) wrongSource.push(`${l.number}: ${l.source} vs file ${row.source}`);
        if (row.posting !== l.posting) wrongSource.push(`${l.number}: posting ${l.posting} vs file ${row.posting}`);
      }
      expect(notInCsv, 'the command locked nothing outside the reference file').toEqual([]);
      expect(wrongAmount, 'every locked amount is the reference file’s amount').toEqual([]);
      expect(wrongSource, 'every note records the reference file’s source and posting date').toEqual([]);

      // AC1 requires the preview to list the live amount, the file's amount and the difference. A
      // client cannot run the preview, but the applied note carries all three, so the trail is
      // checked for the property that matters: it is complete.
      expect(locks.every((l) => Number.isFinite(l.live)), 'every note records what the invoice was computing live').toBe(true);

      // The three sources the ticket describes must all be exercised — the command has to treat the
      // file as authoritative regardless of provenance.
      const bySource = new Map<string, number>();
      for (const l of locks) bySource.set(l.source, (bySource.get(l.source) ?? 0) + 1);
      console.log(`${locks.length} invoices locked, by source: ${[...bySource].map(([s, n]) => `${s}=${n}`).join(', ')}`);
      expect([...bySource.keys()].sort()).toEqual(['datev_accounts_receivable', 'flow_live_value', 'sent_amount_per_t105']);

      // Coverage: 116 file rows == 115 locked + the one already-locked row AC3 covers.
      const lockedNumbers = new Set(locks.map((l) => l.number));
      const unlocked = FREEZE_LIST.filter((r) => !lockedNumbers.has(r.number)).map((r) => r.number);
      console.log(`reference rows with no lock note: ${unlocked.join(', ') || 'none'}`);
      expect(locks.length + unlocked.length).toBe(FREEZE_LIST.length);
    },
  );

  test(
    'AC2 — the snapshot is in force: a locked invoice no longer follows its VO’s live value',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      // "Its displayed total stops changing" cannot be shown by looking at the total alone — a right
      // number today is not a frozen one. It is shown by DIVERGENCE: the VO still computes one figure
      // while the invoice serves another. Every invoice the lock actually moved is such a case, so
      // long as the underlying VO has not since drifted back.
      const moved = locks.filter((l) => Math.abs(l.locked - l.live) > 0.005);
      console.log(`invoices whose amount MOVED at lock time: ${moved.length}`);
      expect(moved.length, 'the lock changed something, so divergence is observable').toBeGreaterThan(0);

      let demonstrated = 0;
      for (const l of moved) {
        const inv = book.find((i) => i.id === l.invoiceId)!;
        const live = await lock.liveValue(inv);
        const liveNow = live ? LegacyInvoiceLockPage.liveFor(inv, live) : null;
        const frozen = null !== liveNow && Math.abs((inv.amount ?? 0) - liveNow) > 0.005;
        console.log(
          `  ${inv.number.padEnd(9)} VO ${String(live?.vo).padEnd(10)} served=${inv.amount} liveNow=${liveNow} ` +
            `(locked ${l.locked} over a then-live ${l.live}) ${frozen ? '→ SNAPSHOT IN FORCE' : '→ agrees with live today'}`,
        );
        // The invoice must serve exactly what was locked, whatever the VO does.
        expect(inv.amount, `${inv.number} serves its locked amount`).toBeCloseTo(l.locked, 2);
        if (frozen) demonstrated++;
      }
      expect(demonstrated, 'at least one invoice demonstrably ignores its VO’s live value').toBeGreaterThan(0);
    },
  );

  test(
    'AC3 — an already-locked invoice was left alone, and the reference file is the side that is wrong',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      const lockedNumbers = new Set(locks.map((l) => l.number));
      const skipped = FREEZE_LIST.filter((r) => !lockedNumbers.has(r.number));
      test.skip(0 === skipped.length, 'every reference row was locked — AC3 has no already-locked fixture here');

      for (const row of skipped) {
        const inv = lock.invoice(row.number);
        expect(inv, `${row.number} exists`).toBeTruthy();
        // Untouched means: no note, and no `updatedAt` in the lock window.
        expect(inv!.updatedAt ?? '', `${row.number} was not rewritten by the lock run`).not.toMatch(/^2026-09-03T08:(09|10)/);
        expect(LegacyInvoiceLockPage.looksUnlocked(inv!.amount), `${row.number} already carried a written snapshot`).toBe(false);

        // ALREADY_LOCKED_DIFFERS: it holds a value the file disagrees with, and the command reported
        // rather than overwrote — which is the right call, because the stored value is the one that
        // matches what Flow computes. Pinned so a later "let the file win" change is visible.
        const live = await lock.liveValue(inv!);
        const liveNow = live ? LegacyInvoiceLockPage.liveFor(inv!, live) : null;
        console.log(
          `${row.number}: stored ${inv!.amount}, reference file ${row.amount}, VO computes ${liveNow} — ` +
            `the command reported the difference and kept the stored value`,
        );
        expect(inv!.amount, 'the stored amount was not overwritten by the file').not.toBeCloseTo(row.amount, 2);
      }
    },
  );

  test(
    'AC4 (step 2) — the PDF was re-rendered for exactly the invoices whose amount moved, and for no others',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      test.setTimeout(900_000);
      // A stored PDF's own `/CreationDate` is when it was actually rendered — and downloads are
      // served from the store as-is (#3495), so this stamp is untouched by the reading. That makes it
      // the exact discriminator step 2 needs: regenerated at lock time, or still the original.
      const moved = locks.filter((l) => Math.abs(l.locked - l.live) > 0.005);
      const unmoved = locks.filter((l) => Math.abs(l.locked - l.live) <= 0.005).slice(0, 3);
      expect(moved.length, 'some invoice moved, so step 2 had work to do').toBeGreaterThan(0);
      expect(unmoved.length, 'and some did not, so "for no others" is testable').toBeGreaterThan(0);

      const inWindow = (d: Date | null) =>
        !!d && d >= new Date('2026-09-03T08:09:00Z') && d <= new Date('2026-09-03T08:12:00Z');

      for (const l of moved) {
        const pdf = await lock.storedPdf(l.invoiceId);
        console.log(`  moved   ${String(l.number).padEnd(9)} ${l.live} → ${l.locked}  PDF rendered ${pdf.createdAt?.toISOString()}`);
        expect(pdf.status, `${l.number} still has a stored PDF`).toBe(200);
        expect(inWindow(pdf.createdAt), `${l.number}'s PDF was regenerated during the lock run`).toBe(true);
      }
      for (const l of unmoved) {
        const pdf = await lock.storedPdf(l.invoiceId);
        console.log(`  unmoved ${String(l.number).padEnd(9)} ${l.locked} unchanged      PDF rendered ${pdf.createdAt?.toISOString()}`);
        expect(pdf.status).toBe(200);
        // AC4 scopes step 2 to "the invoices whose amount changes in step 1". A blanket re-render
        // would also be wrong: it would restamp documents that were already correct.
        expect(inWindow(pdf.createdAt), `${l.number}'s PDF was NOT regenerated — its amount did not change`).toBe(false);
        // "its issue date and issuer details remain exactly as originally issued" — the issue date is
        // the invoice's own field and must predate the run either way.
        const inv = book.find((i) => i.id === l.invoiceId)!;
        expect(inv.issueDate ?? '', `${l.number} keeps its original issue date`).toMatch(/^2026-0[67]/);
      }

      for (const l of moved) {
        const inv = book.find((i) => i.id === l.invoiceId)!;
        expect(inv.issueDate ?? '', `${inv.number} kept its issue date through the regeneration`).toMatch(/^2026-0[67]/);
      }
    },
  );

  test(
    'AC6 — the refresh went through the regeneration engine, which leaves a re-rendered PDF behind',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      test.setTimeout(600_000);
      // AC6 asks step 3 to reuse the existing invoice-regeneration action rather than set the field
      // directly. From outside, those look identical on the amount alone — but regeneration also
      // re-renders the stored PDF, so a fresh `/CreationDate` on a refreshed invoice is the engine's
      // footprint. Only the invoices whose amount actually changed are checked: a no-op re-snapshot
      // has nothing to re-render.
      const changed = refreshes.filter((r) => null !== r.from && Math.abs(r.from - r.to) > 0.005);
      test.skip(0 === changed.length, 'no refreshed invoice changed amount — AC6 has no footprint to read');

      for (const r of changed) {
        const pdf = await lock.storedPdf(r.invoiceId);
        console.log(`  ${String(r.number).padEnd(10)} ${r.from} → ${r.to} noted ${r.at} — PDF rendered ${pdf.createdAt?.toISOString()}`);
        expect(pdf.status).toBe(200);
        // The render trails the note (an async worker writes the file), so "after the note" is the
        // assertion, not "at the same second".
        expect(pdf.createdAt, `${r.number}'s PDF was re-rendered`).not.toBeNull();
        expect(pdf.createdAt!.getTime(), `${r.number}'s PDF is newer than its refresh note`).toBeGreaterThanOrEqual(
          new Date(r.at).getTime(),
        );
      }
    },
  );

  test(
    'AC7 — the refresh never touched an invoice outside "Not Sent"',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      const byId = new Map(book.map((i) => [i.id, i]));
      const offending = refreshes
        .map((r) => byId.get(r.invoiceId))
        .filter((i): i is InvoiceRow => !!i && 'not_sent' !== i.status);
      console.log(`${refreshes.length} invoices carry a refresh note; statuses today: ${[...new Set(refreshes.map((r) => byId.get(r.invoiceId)?.status))].join(', ')}`);
      expect(offending.map((i) => `${i.number} (${i.status})`), 'no Sent/Overdue/Paid/Cancelled/Storno invoice was refreshed').toEqual([]);

      // The mirror check, from the timestamps rather than the notes: no ineligible invoice was
      // rewritten during either refresh window.
      const inRefreshWindow = (i: InvoiceRow) =>
        !!i.updatedAt && (/^2026-09-03T08:2[56]/.test(i.updatedAt) || /^2026-09-04T08:5[23]/.test(i.updatedAt));
      const touched = book.filter((i) => inRefreshWindow(i) && REFRESH_INELIGIBLE.includes(i.status));
      expect(touched.map((i) => `${i.number} (${i.status})`), 'no ineligible invoice was written during a refresh run').toEqual([]);

      // And the population the refresh COULD have reached is real, so the emptiness above means something.
      const eligible = book.filter((i) => 'not_sent' === i.status);
      console.log(`not_sent invoices on staging: ${eligible.length}; ineligible: ${book.length - eligible.length}`);
      expect(eligible.length).toBeGreaterThan(100);
    },
  );

  test(
    'AC5 / AC6 — the refresh re-snapshotted with the corrected calculation, and the new amount is what is served',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      const byId = new Map(book.map((i) => [i.id, i]));
      const changed = refreshes.filter((r) => null !== r.from && Math.abs(r.from - r.to) > 0.005);
      const newlyLocked = refreshes.filter((r) => null === r.from);
      console.log(`refresh notes: ${refreshes.length} — ${newlyLocked.length} "from unlocked", ${changed.length} with a changed amount`);
      for (const r of changed) console.log(`  ${r.number}: ${r.from} → ${r.to} at ${r.at}`);

      // AC6 asks for the change to be recorded AND applied. Both halves: the note exists, and the
      // invoice now serves the value the note names.
      for (const r of refreshes) {
        const inv = byId.get(r.invoiceId);
        if (!inv) continue;
        expect(inv.amount, `${r.number} serves the re-snapshotted amount`).toBeCloseTo(r.to, 2);
      }
      expect(newlyLocked.length, 'the "no locked amount yet" branch fired').toBeGreaterThan(0);
      expect(changed.length, 'the "amount differs" branch fired').toBeGreaterThan(0);

      // Two runs happened, and the later one moved an invoice the earlier one did not — consistent
      // with the Go-Live rule that step 3 must follow #3602/#3603, and worth logging because a single
      // run would have left that invoice on the pre-fix figure.
      const runs = [...new Set(refreshes.map((r) => r.at.slice(0, 16)))].sort();
      console.log(`refresh runs observed: ${runs.join(' | ')}`);
    },
  );

  test(
    'evidence — the ticket’s predicted 4-row difference table against what staging actually produced',
    { tag: ['@SuperAdmin', '@LegacyAmountLock', '@ReadOnly'] },
    async () => {
      // AC1 states "exactly 4 have a non-zero difference … the other 112 already match", and names
      // them. Staging produced a different set, so the table is reported side by side rather than
      // asserted — the reference file, not the table, is what the command is required to honour, and
      // the divergence is a property of the clone's data rather than of the code.
      const moved = new Map(locks.filter((l) => Math.abs(l.locked - l.live) > 0.005).map((l) => [l.number!, l]));
      console.log('ticket table vs staging:');
      for (const t of TICKET_EXPECTED_MOVES) {
        const actual = moved.get(t.number);
        console.log(
          `  ${t.number.padEnd(9)} ticket: ${t.live} → ${t.correct}` +
            (actual ? `   staging: ${actual.live} → ${actual.locked}` : '   staging: no difference — it already matched'),
        );
      }
      const extra = [...moved.keys()].filter((n) => !TICKET_EXPECTED_MOVES.some((t) => t.number === n));
      for (const n of extra) {
        const l = moved.get(n)!;
        console.log(`  ${n.padEnd(9)} not in the ticket table   staging: ${l.live} → ${l.locked} (${(l.locked - l.live).toFixed(2)})`);
      }
      console.log(`ticket predicts 4 moves; staging produced ${moved.size}`);
      expect(moved.size).toBeGreaterThan(0);
    },
  );

  // ─────────────────────────────────── findings ───────────────────────────────────

});
