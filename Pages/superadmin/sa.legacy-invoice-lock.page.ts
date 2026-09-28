import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * Locking the legacy invoice amounts, and refreshing the held drafts (RC 3.12 #3604).
 *
 * 117 invoices issued 15 Jun – 16 Jul 2026 predate the amount snapshot (#3052/#3093), so
 * `Invoice::getInvoiceAmount()` falls through to a LIVE recompute every time they are read — and a
 * later change to the billing calculation silently moves what an already-issued invoice displays.
 * The correction is two console commands: `app:invoice:lock-legacy-amounts --file=… [--force]`
 * (steps 1+2: write the snapshot from a reference CSV, re-render the PDFs whose amount moved) and
 * `app:invoice:refresh-unsent-amounts [--force]` (step 3: re-snapshot every `not_sent` invoice with
 * the corrected calculation, only after #3602/#3603 are live).
 *
 * **The central problem this page object solves: the API does not expose the snapshot.** Neither
 * `pkvAmount` nor `copaymentAmount` is in ANY serialization group — `invoice-list:read`,
 * `billing:read` and the default all return only the resolved `invoiceAmount`. So "is this invoice
 * locked?" — the one question every AC turns on — has no field to read. Two independent oracles
 * answer it instead:
 *
 * 1. **Float dust.** A written snapshot is a DB decimal and round-trips as a clean 2-place number; a
 *    live recompute is IEEE-754 arithmetic and arrives as `35.632000000000005`. Across the whole
 *    564-invoice book exactly 6 rows carry dust, and they are precisely the ones no command wrote.
 *    `looksUnlocked()` is that test. It is a one-way signal — a locked value can coincidentally be
 *    clean — so it is used to prove UNLOCKED, never to prove locked.
 * 2. **Divergence from the live value.** The VO carries the live figure the fallback would compute:
 *    `totalRevenue` for a PKV invoice, `copaymentAmount` for a copayment one. When the served amount
 *    differs from it, the snapshot is demonstrably in force. This is the positive proof of AC2, and
 *    it is the only one that actually demonstrates "stops changing" rather than "looks right today".
 *
 * **The audit trail is the third surface, and the richest.** Both commands write an `InvoiceLog` note,
 * readable at `GET /invoice_logs?type=note`, carrying exactly the columns AC1 asks the preview to
 * print:
 *
 *   "Invoice amount locked at 256.32 (source datev_accounts_receivable, DATEV posting 2026-07-14)
 *    — was computing live at 378 (#3604)."
 *   "Invoice amount re-snapshotted from unlocked to 35.62 with the corrected calculation (…)."
 *
 * `lockNotes()` / `refreshNotes()` parse these. Note the em dash — it is U+2014, not a hyphen.
 *
 * **Traps.**
 *
 * - **There is no `invoiceNumber` filter on `/invoices`.** `?invoiceNumber=R526-18` is accepted and
 *   IGNORED, returning the unfiltered collection — so a naive lookup silently reads the first row of
 *   the book instead of the invoice asked for. Numbers are resolved from a single bulk read here.
 * - **`billing:read` serializes the prescription's patient WITHOUT an `id`**, and an invoice's
 *   `updatedAt` is only in the DEFAULT group while its `invoiceType` is only in `invoice-list:read` —
 *   three reads, three shapes.
 * - **A step-3 write does not always move `updatedAt`.** 83 invoices carry a refresh note but only 3
 *   have an `updatedAt` in the refresh window, so bucketing by timestamp UNDERCOUNTS step 3 while
 *   being exact for step 1. Use the notes for step 3 and the timestamps only as corroboration.
 *
 * Read-only throughout — every request is a GET.
 */

/** One row of `freeze-list-datev-amounts.csv`, the reference file attached to #3604 (116 rows). */
export type FreezeRow = {
  number: string;
  /** Which snapshot property the command must set — the CSV is the authority, not the insurance type. */
  field: 'pkv_amount' | 'copayment_amount';
  amount: number;
  source: 'datev_accounts_receivable' | 'sent_amount_per_t105' | 'flow_live_value';
  posting: string | null;
};

/** The reference file, verbatim. */
export const FREEZE_LIST: FreezeRow[] = [
  { number: '126-12',    field: 'pkv_amount',        amount: 1236.00,   source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '126-14',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '126-15',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '126-16',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '126-17',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '126-4',     field: 'pkv_amount',        amount: 78.00,     source: 'flow_live_value',           posting: null },
  { number: '126-5',     field: 'pkv_amount',        amount: 953.10,    source: 'sent_amount_per_t105',      posting: '2026-06-16' },
  { number: '126-6',     field: 'pkv_amount',        amount: 756.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '126-7',     field: 'pkv_amount',        amount: 1260.00,   source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '226-1',     field: 'pkv_amount',        amount: 63.00,     source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '226-2',     field: 'pkv_amount',        amount: 390.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '226-3',     field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '326-31',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '326-33',    field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '326-34',    field: 'pkv_amount',        amount: 1103.10,   source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '326-35',    field: 'pkv_amount',        amount: 677.90,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '326-36',    field: 'pkv_amount',        amount: 234.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '326-40',    field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '326-41',    field: 'pkv_amount',        amount: 1836.00,   source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '326-42',    field: 'pkv_amount',        amount: 1035.25,   source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '326-43',    field: 'pkv_amount',        amount: 702.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '326-44',    field: 'pkv_amount',        amount: 390.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-14',    field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '426-15',    field: 'pkv_amount',        amount: 1512.00,   source: 'sent_amount_per_t105',      posting: '2026-06-16' },
  { number: '426-16',    field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '426-17',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '426-18',    field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '426-19',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '426-20',    field: 'pkv_amount',        amount: 1283.40,   source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '426-21',    field: 'pkv_amount',        amount: 859.50,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '426-22',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '426-32',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-33',    field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-34',    field: 'pkv_amount',        amount: 426.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-35',    field: 'pkv_amount',        amount: 1143.72,   source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-36',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '426-37',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '526-1',     field: 'pkv_amount',        amount: 991.40,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '526-12',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '526-13',    field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-06-25' },
  { number: '526-2',     field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '526-3',     field: 'pkv_amount',        amount: 756.00,    source: 'datev_accounts_receivable', posting: '2026-06-16' },
  { number: '526-4',     field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: '526-5',     field: 'pkv_amount',        amount: 1260.00,   source: 'datev_accounts_receivable', posting: '2026-06-17' },
  { number: 'R126-10',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-11',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-12',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-13',   field: 'pkv_amount',        amount: 510.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-14',   field: 'pkv_amount',        amount: 1283.40,   source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-15',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-16',   field: 'pkv_amount',        amount: 1155.00,   source: 'datev_accounts_receivable', posting: '2026-07-07' },
  { number: 'R126-17',   field: 'pkv_amount',        amount: 1260.00,   source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R126-18',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R126-33',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R126-34',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R126-35',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R126-45',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R126-46',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R126-47',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R126-48',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R126-49',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R126-50',   field: 'pkv_amount',        amount: 85.44,     source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R126-6',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-7',    field: 'pkv_amount',        amount: 740.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-8',    field: 'pkv_amount',        amount: 591.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R126-9',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R226-13',   field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R226-14',   field: 'pkv_amount',        amount: 115.26,    source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R226-15',   field: 'pkv_amount',        amount: 859.50,    source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R226-16',   field: 'pkv_amount',        amount: 385.02,    source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R226-23',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R226-24',   field: 'pkv_amount',        amount: 390.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R226-38',   field: 'copayment_amount',  amount: 35.63,     source: 'datev_accounts_receivable', posting: '2026-07-16' },
  { number: 'R326-12',   field: 'pkv_amount',        amount: 2566.80,   source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R326-13',   field: 'pkv_amount',        amount: 99.14,     source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R326-21',   field: 'pkv_amount',        amount: 171.90,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R326-22',   field: 'pkv_amount',        amount: 234.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R326-23',   field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R326-24',   field: 'pkv_amount',        amount: 390.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R326-8',    field: 'pkv_amount',        amount: 120.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R326-9',    field: 'pkv_amount',        amount: 740.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-10',   field: 'pkv_amount',        amount: 550.74,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-11',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-12',   field: 'pkv_amount',        amount: 300.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-13',   field: 'pkv_amount',        amount: 1020.00,   source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-14',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-15',   field: 'pkv_amount',        amount: 189.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-16',   field: 'pkv_amount',        amount: 307.79,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-17',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-29',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-08' },
  { number: 'R426-31',   field: 'pkv_amount',        amount: 189.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-32',   field: 'pkv_amount',        amount: 315.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-33',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-34',   field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-35',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-36',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R426-56',   field: 'pkv_amount',        amount: 991.40,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R426-57',   field: 'pkv_amount',        amount: 1194.40,   source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R426-59',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R426-60',   field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R426-61',   field: 'pkv_amount',        amount: 256.32,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R426-62',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-15' },
  { number: 'R426-8',    field: 'pkv_amount',        amount: 756.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R426-9',    field: 'pkv_amount',        amount: 1152.60,   source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-17',   field: 'pkv_amount',        amount: 126.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R526-18',   field: 'pkv_amount',        amount: 1325.20,   source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R526-19',   field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R526-20',   field: 'pkv_amount',        amount: 756.00,    source: 'datev_accounts_receivable', posting: '2026-07-13' },
  { number: 'R526-30',   field: 'pkv_amount',        amount: 126.00,    source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R526-31',   field: 'pkv_amount',        amount: 1376.85,   source: 'datev_accounts_receivable', posting: '2026-07-14' },
  { number: 'R526-4',    field: 'pkv_amount',        amount: 917.90,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-5',    field: 'pkv_amount',        amount: 1283.40,   source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-6',    field: 'pkv_amount',        amount: 1283.40,   source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-7',    field: 'pkv_amount',        amount: 770.04,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-8',    field: 'pkv_amount',        amount: 378.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },
  { number: 'R526-9',    field: 'pkv_amount',        amount: 630.00,    source: 'datev_accounts_receivable', posting: '2026-07-06' },];

/** The four rows the ticket's AC-1 table predicts will move, with its stated before/after. */
export const TICKET_EXPECTED_MOVES = [
  { number: 'R526-18', live: 1283.4, correct: 1325.2 },
  { number: 'R426-57', live: 1152.6, correct: 1194.4 },
  { number: 'R426-61', live: 378.0, correct: 256.32 },
  { number: 'R126-50', live: 126.0, correct: 85.44 },
] as const;

/** The two invoices AC5 names as having no locked amount for step 3 to pick up. */
export const AC5_UNLOCKED_EXAMPLES = ['126-11', 'R426-43'] as const;

/** Statuses step 3 must never touch (AC7). */
export const REFRESH_INELIGIBLE = ['sent', 'overdue', 'paid', 'cancelled', 'to_send_to_dc', 'sent_to_dc', 'reminded'];

export type InvoiceRow = {
  id: number;
  number: string;
  status: string;
  /** `copayment` | `pkv` | `storno`. */
  type: string;
  amount: number | null;
  issueDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  prescriptionIri: string | null;
  prescriptionNumber: string | null;
  patientName: string | null;
};

export type LockNote = {
  invoiceId: number;
  number: string | null;
  /** The amount the command wrote. */
  locked: number;
  /** What `getInvoiceAmount()` was returning at the moment it was locked — AC1's "current live amount". */
  live: number;
  source: string;
  posting: string | null;
  at: string;
};

export type RefreshNote = {
  invoiceId: number;
  number: string | null;
  /** `null` when the note reads "from unlocked" — the AC5 branch. */
  from: number | null;
  to: number;
  at: string;
};

/** What the VO would compute today, i.e. what an unlocked invoice would display. */
export type LiveValue = { prescriptionId: number; vo: string | null; pkv: number | null; copayment: number | null };

export class LegacyInvoiceLockPage {
  private token = '';
  private book: InvoiceRow[] = [];

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3604: no bearer token — cannot read the lock outcome');
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string, timeout = 180_000): Promise<any> {
    let last = '';
    // Staging answers these bulk reads with an HTML gateway page when it is busy; a JSON parse of
    // that is an unhelpful `Unexpected token '<'`, so retry rather than surface it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, { headers: this.auth(), timeout });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON body (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(3_000);
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ────────────────────────────────── the invoice book ──────────────────────────────────

  /**
   * The whole book, once. Two groups have to be merged: `invoice-list:read` carries `invoiceType`
   * and the prescription/patient stub, while `updatedAt` exists only in the default serialization.
   */
  async loadBook(): Promise<InvoiceRow[]> {
    const listed = LegacyInvoiceLockPage.members(await this.json('/invoices?itemsPerPage=1000&groups%5B%5D=invoice-list%3Aread'));
    const plain = LegacyInvoiceLockPage.members(await this.json('/invoices?itemsPerPage=1000'));
    const updated = new Map<number, string>(plain.map((i: any) => [i.id, i.updatedAt]));
    this.book = listed.map((i: any) => ({
      id: i.id,
      number: i.invoiceNumber,
      status: i.status,
      type: i.invoiceType ?? '',
      amount: i.invoiceAmount ?? null,
      issueDate: i.issueDate ?? null,
      createdAt: i.createdAt ?? null,
      updatedAt: updated.get(i.id) ?? null,
      prescriptionIri: i.prescription?.['@id'] ?? null,
      prescriptionNumber: i.prescription?.prescriptionId ?? null,
      patientName: i.prescription?.patient?.fullName ?? null,
    }));
    return this.book;
  }

  invoices(): InvoiceRow[] {
    return this.book;
  }

  /** By number — there is no server-side filter for this, see the trap in the class docblock. */
  invoice(number: string): InvoiceRow | null {
    return this.book.find((i) => i.number === number) ?? null;
  }

  // ──────────────────────────────── the two lock oracles ────────────────────────────────

  /**
   * Whether the served amount still carries IEEE-754 dust from a live recompute.
   *
   * One-way: dust proves the invoice is UNLOCKED; clean does not prove it is locked (a live value
   * can land on a clean number). Used only in the direction it is sound in.
   */
  static looksUnlocked(amount: number | null): boolean {
    return null !== amount && Math.abs(Math.round(amount * 100) / 100 - amount) > 1e-9;
  }

  /** Every invoice in the book whose amount is still being computed live. */
  unlockedByDust(): InvoiceRow[] {
    return this.book.filter((i) => LegacyInvoiceLockPage.looksUnlocked(i.amount));
  }

  /**
   * The live figure the fallback would produce for one invoice's VO — `totalRevenue` for PKV,
   * `copaymentAmount` for a copayment invoice. A served amount that differs from this is a snapshot
   * demonstrably in force.
   */
  async liveValue(invoice: InvoiceRow): Promise<LiveValue | null> {
    if (!invoice.prescriptionIri) return null;
    const id = Number(invoice.prescriptionIri.split('/').pop());
    const p = await this.json(`/prescriptions/${id}?groups%5B%5D=billing%3Aread`);
    return {
      prescriptionId: id,
      vo: p.prescriptionId ?? null,
      pkv: p.totalRevenue ?? null,
      copayment: p.copaymentAmount ?? null,
    };
  }

  /** The live figure that matches the invoice's own type. */
  static liveFor(invoice: InvoiceRow, live: LiveValue): number | null {
    return 'copayment' === invoice.type ? live.copayment : live.pkv;
  }

  // ───────────────────────────────── the audit trail ─────────────────────────────────

  private notesCache: any[] | null = null;

  private async notes(): Promise<any[]> {
    if (!this.notesCache) this.notesCache = LegacyInvoiceLockPage.members(await this.json('/invoice_logs?type=note&itemsPerPage=1000'));
    return this.notesCache;
  }

  /**
   * Step 1's audit entries. The note carries the locked amount, the source, the DATEV posting date
   * AND the live value at lock time — every column AC1 requires the preview to print, which is why
   * the applied trail can stand in for the preview a client cannot run.
   */
  async lockNotes(): Promise<LockNote[]> {
    const re = /locked at ([\d.]+) \(source ([a-z_0-9]+), DATEV posting ([\d-]+|n\/a)\)[^\d]*live at ([\d.]+)/;
    const byId = new Map(this.book.map((i) => [i.id, i]));
    return (await this.notes())
      .map((n: any) => ({ n, m: re.exec(String(n.value ?? '')) }))
      .filter((x): x is { n: any; m: RegExpExecArray } => !!x.m)
      .map(({ n, m }) => {
        const invoiceId = Number(String(n.invoice).split('/').pop());
        return {
          invoiceId,
          number: byId.get(invoiceId)?.number ?? null,
          locked: Number(m[1]),
          source: m[2],
          posting: 'n/a' === m[3] ? null : m[3],
          live: Number(m[4]),
          at: n.createdAt,
        };
      });
  }

  /** Step 3's audit entries. `from === null` is the note's "from unlocked" — AC5's branch. */
  async refreshNotes(): Promise<RefreshNote[]> {
    const re = /re-snapshotted from (unlocked|[\d.]+) to ([\d.]+)/i;
    const byId = new Map(this.book.map((i) => [i.id, i]));
    return (await this.notes())
      .map((n: any) => ({ n, m: re.exec(String(n.value ?? '')) }))
      .filter((x): x is { n: any; m: RegExpExecArray } => !!x.m)
      .map(({ n, m }) => {
        const invoiceId = Number(String(n.invoice).split('/').pop());
        return {
          invoiceId,
          number: byId.get(invoiceId)?.number ?? null,
          from: 'unlocked' === m[1].toLowerCase() ? null : Number(m[1]),
          to: Number(m[2]),
          at: n.createdAt,
        };
      });
  }

  // ─────────────────────────────────── step 2: PDFs ───────────────────────────────────

  /**
   * The stored PDF's own `/CreationDate` plus its text. Downloads are served from the store (#3495),
   * so this stamp is when the file was actually rendered — which is how a step-2 regeneration is
   * distinguished from an untouched original.
   */
  async storedPdf(invoiceId: number): Promise<{ status: number; createdAt: Date | null; bytes: number; text: string }> {
    const res = await this.page.request.get(`${API_BASE}/invoices/${invoiceId}/download`, {
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 240_000,
    });
    if (200 !== res.status()) return { status: res.status(), createdAt: null, bytes: 0, text: '' };
    const buf = await res.body();
    const raw = buf.toString('latin1');
    const stamp = raw.match(/\/CreationDate\s*\(D:(\d{14})/)?.[1] ?? null;
    return {
      status: 200,
      createdAt: stamp
        ? new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14)))
        : null,
      bytes: buf.length,
      text: '',
    };
  }
}
