import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * Cross-area fees on TheOrg-imported VOs (RC 3.12 #3577).
 *
 * 93 VOs imported from TheOrg carry a fee or Heilmittel belonging to a DIFFERENT therapy area than
 * the VO itself — 60 of them the speech-therapy fee `AB-L` on a physio or ergo VO. The correction is
 * a one-off console command (`app:prescription:remove-cross-area-fees`, preview by default,
 * `--execute` to apply) that deletes exactly the listed `PrescribedTreatment` row from each VO.
 *
 * **The command is console-only, so what a client can test is its OUTCOME — and the run already
 * happened on staging (applied 2026-09-03, re-previewed 2026-09-04).** That is enough for the ACs
 * that describe a state, and this file is careful about which ones those are:
 *
 * | AC | what is actually checkable here |
 * |---|---|
 * | 1 (preview lists each removal) | not runnable — no console. The applied outcome stands in. |
 * | 2 (removes exactly the listed entry, nothing else) | BOTH halves: every listed pair is gone, AND the correction did not stray beyond the list |
 * | 3 (the 7 validated/edit-locked VOs corrected anyway) | yes, on the 3 that are validated on staging — and they are STILL validated, i.e. the lock was bypassed, not lifted |
 * | 4 (Ingeborg Aleth's invoices untouched) | yes — see the patient-id trap below |
 * | 5 (3 already-sent GKV batches untouched) | only the generic form; no listed VO sits in a staging batch |
 * | 6 (report attached to the ticket) | not a product surface |
 * | 7 (staging is a rehearsal) | not a product surface |
 *
 * **AC2's second half is the interesting one and needs an independent detector, not a diff.** There
 * is no pre-run snapshot to diff against from a client, so "nothing else changed" is approached from
 * the other side: re-derive the cross-area rule over the WHOLE book and check where it still fires.
 * `/prescriptions?treatment=<id>&therapyType=<x>` does this cheaply — ask for `itemsPerPage=1` and
 * read `totalItems`. If a residual pair were ON the list, the removal missed it; if the list's pairs
 * are all gone AND residuals exist off-list, the command was list-scoped exactly as AC2 requires.
 *
 * **Traps.**
 *
 * - **`therapyType` is `physiotherapy` / `ergotherapy` / `speech_therapy`, not the
 *   spreadsheet's `PT` / `ERGO` / `SSSST`.** The filter accepts an unknown value **silently** and
 *   answers `totalItems: 0`, which reads exactly like "no cross-area VOs left" — i.e. like the
 *   ticket passing. `AREA_TO_THERAPY_TYPE` is the map, and `assertTherapyTypeVocabulary()` proves
 *   the filter is live before any zero is believed.
 * - **The `6330` in "patient Ingeborg Aleth (patient 6330)" is the VO-number prefix, NOT the API
 *   patient id.** `GET /patients/6330` is Margarete Schultz, an unrelated person, and
 *   `?prescription.patient=6330` returns her invoices. Ingeborg Aleth is patient **5054**; the way
 *   in is her VO (`6330-8` → prescription 23602) and the invoice hanging off it.
 * - **`billing:read` serializes the patient WITHOUT an `id`** (only `fullName`), so a patient id has
 *   to come from the light payload or from the invoice list group.
 * - A VO's `treatmentStatus`/`validationStatus` on staging is **not** what the spreadsheet's columns
 *   say — the sheet was built from production. Only 3 of the 7 rows marked `validated` are validated
 *   here, so AC3 is asserted on the live value, never on the sheet's.
 *
 * Read-only throughout — every request is a GET.
 */

/** A row of the PM-verified list attached to #3577 (`stray-fees-affected-vos.xlsx`, 93 rows / 90 VOs). */
export type ListedFee = {
  vo: string;
  wrongCode: string;
  feeKind: 'one_time_fee' | 'per_treatment_fee';
  /** The area the WRONG fee belongs to. */
  feeArea: 'PT' | 'ERGO' | 'SSSST';
  /** The area of the VO carrying it. */
  voArea: 'PT' | 'ERGO' | 'SSSST';
  correctCode: string;
  insurance: string;
  voStatus: string;
  /** The sheet's "Validation Status" — `validated` marks the 7 edit-locked VOs of AC3. */
  validated: boolean;
  invoice: string | null;
  action: string;
};

/** The 93 listed (VO, wrong fee) pairs, verbatim from the ticket's attachment. */
export const LISTED_FEES: ListedFee[] = [
  { vo: '7683-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4651-7',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5982-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6330-8',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: 'R526-55',             action: 'Needs unlock first' },
  { vo: '6330-7',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: 'R526-128,R526-156',   action: 'Needs unlock first' },
  { vo: '6330-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6330-3',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6330-6',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6330-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3530-10',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5308-6',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4953-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6916-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '1969-17',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4509-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5403-6',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '2602-10',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'GKV',  voStatus: 'Aktiv',             validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6897-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6897-3',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6897-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5646-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7055-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6407-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5656-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3301-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: null,                  action: 'Needs unlock first' },
  { vo: '6104-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: true,  invoice: '426-15',              action: 'Needs unlock first' },
  { vo: '5305-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5177-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6827-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6827-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6057-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3039-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3039-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3039-3',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3798-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: null,                  action: 'Needs unlock first' },
  { vo: '7619-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7803-3',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4946-3',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7647-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7290-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7209-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4375-9',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6674-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4164-15',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4164-13',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4164-18',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: '126-5',               action: 'Needs unlock first' },
  { vo: '3219-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '2746-6',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7446-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '8349-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Abgerechnet',       validated: true,  invoice: null,                  action: 'Needs unlock first' },
  { vo: '137-6',     wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7249-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4592-1',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4674-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'ERGO',  correctCode: 'AB-E',     insurance: 'PKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4674-5',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4286-11',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4418-4',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'PKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4224-11',   wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5100-7',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7352-2',    wrongCode: 'AB-L',     feeKind: 'one_time_fee',      feeArea: 'SSSST',  voArea: 'PT',    correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3309-7',    wrongCode: 'AB-E',     feeKind: 'one_time_fee',      feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'AB-PT',    insurance: 'GKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3810-9',    wrongCode: 'AB-E',     feeKind: 'one_time_fee',      feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'AB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4838-6',    wrongCode: 'AB-E-BV',  feeKind: 'one_time_fee',      feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'AB-PT-BV', insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4838-7',    wrongCode: 'AB-E-BV',  feeKind: 'one_time_fee',      feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'AB-PT-BV', insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5010-5',    wrongCode: 'AB-P',     feeKind: 'one_time_fee',      feeArea: 'PT',     voArea: 'ERGO',  correctCode: 'AB-P',     insurance: 'GKV',  voStatus: 'Fertig Behandelt',  validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6893-1',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5426-3',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '7508-2',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '2517-7',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4745-9',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4745-10',   wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4745-11',   wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6880-2',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6880-1',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4147-4',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '460-5',     wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3945-1',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3979-7',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3979-12',   wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '659-2',     wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6896-2',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6306-1',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '578-4',     wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '578-5',     wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6940-1',    wrongCode: 'HB-E',     feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HB-PT',    insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '2880-17',   wrongCode: 'HB-PT',    feeKind: 'per_treatment_fee', feeArea: 'PT',     voArea: 'SSSST', correctCode: 'HB-L',     insurance: 'unset', voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '2666-11',   wrongCode: 'HB-PT',    feeKind: 'per_treatment_fee', feeArea: 'PT',     voArea: 'SSSST', correctCode: 'HB-L',     insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3309-7',    wrongCode: 'HBH-E',    feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HBH-PT',   insurance: 'GKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '6679-3',    wrongCode: 'HBH-E',    feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HBH-PT',   insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '3810-9',    wrongCode: 'HBH-E',    feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HBH-PT',   insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '4251-8',    wrongCode: 'HBH-E-BV', feeKind: 'per_treatment_fee', feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'HBH-PT-BV', insurance: 'GKV',  voStatus: 'Archiviert',        validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '5010-5',    wrongCode: 'HBH-PT',   feeKind: 'per_treatment_fee', feeArea: 'PT',     voArea: 'ERGO',  correctCode: 'HBH-E',    insurance: 'GKV',  voStatus: 'Fertig Behandelt',  validated: false, invoice: null,                  action: 'Can fix directly' },
  { vo: '1000015-4', wrongCode: 'VBP-BV',   feeKind: 'one_time_fee',      feeArea: 'ERGO',   voArea: 'PT',    correctCode: 'VBP-BV',   insurance: 'GKV',  voStatus: 'Abgebrochen',       validated: false, invoice: null,                  action: 'Can fix directly' },];

/**
 * The API's `therapyType` vocabulary, keyed by the spreadsheet's area code.
 *
 * **`ERGO` is `ergotherapy`.** It read `occupational_therapy` here until #3576's testing caught it,
 * and because an unknown `therapyType` is accepted SILENTLY and answers `totalItems: 0` (exactly
 * like a nonsense value), every probe this file made against an Ergotherapie VO came back empty.
 * The residual cross-area population was reported as 5 combinations / 18 hits on that basis; with
 * the value corrected it is 13 / 34 over 29 VOs, and all 8 hidden combinations were Ergo VOs.
 * `assertTherapyTypeVocabulary()` is what stops that from recurring — do not remove it.
 */
export const AREA_TO_THERAPY_TYPE: Record<string, string> = {
  PT: 'physiotherapy',
  ERGO: 'ergotherapy',
  SSSST: 'speech_therapy',
};

/** The two invoices AC4 exempts, and the VO that carries the reachable one. */
export const ALETH = { vo: '6330-8', invoices: ['R526-55', 'R526-156'] } as const;

export type Treatment = { id: number; code: string; area: string | null; kind: string; archivedAt: string | null };

export type VoFees = {
  vo: string;
  id: number;
  /** Every prescribed treatment on the VO, fees and Heilmittel alike. */
  codes: { code: string; kind: string; area: string | null }[];
  therapyType: string | null;
  treatmentStatus: string | null;
  validationStatus: string | null;
  imported: boolean;
  totalRevenue: number | null;
  invoice: { number: string; status: string; amount: number | null; updatedAt: string | null } | null;
  billingBatchCount: number;
};

export type CrossAreaPair = {
  vo: string;
  prescriptionId: number;
  code: string;
  /** Area of the fee. */
  feeArea: string;
  /** Area of the VO carrying it. */
  voArea: string;
  treatmentStatus: string | null;
  validationStatus: string | null;
  imported: boolean;
};

export class CrossAreaFeesPage {
  private token = '';
  private treatments: Treatment[] = [];

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3577: no bearer token — cannot read the correction outcome');
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string, timeout = 120_000): Promise<any> {
    const res = await this.page.request.get(`${API_BASE}${path}`, { headers: this.auth(), timeout });
    if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}`);
    return await res.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ──────────────────────────── the treatment catalogue ────────────────────────────

  /**
   * `/treatments` is the authority on which area a code belongs to — the spreadsheet's "Fee Area"
   * column is only a claim, and the whole cross-area rule is defined by this table.
   */
  async loadTreatments(): Promise<Treatment[]> {
    const body = await this.json('/treatments?itemsPerPage=200');
    this.treatments = CrossAreaFeesPage.members(body).map((t: any) => ({
      id: t.id,
      code: t.code,
      area: t.area ?? null,
      kind: t.kind ?? '',
      archivedAt: t.archivedAt ?? null,
    }));
    return this.treatments;
  }

  treatment(code: string): Treatment | null {
    return this.treatments.find((t) => t.code === code) ?? null;
  }

  /** Every `one_time_fee` / `per_treatment_fee` in the catalogue — the rows a cross-area check ranges over. */
  feeTreatments(): Treatment[] {
    return this.treatments.filter((t) => 'one_time_fee' === t.kind || 'per_treatment_fee' === t.kind);
  }

  // ──────────────────────────────── per-VO reads ────────────────────────────────

  /**
   * One VO by its number. Two payloads are needed: `prescribedTreatments` (with the treatment's own
   * `code`/`kind`/`area`) rides on the LIGHT `/prescriptions` serialization, while `totalRevenue`,
   * `validationStatus` and the active invoice are only in `billing:read`.
   */
  async voByNumber(vo: string): Promise<VoFees | null> {
    const found = CrossAreaFeesPage.members(await this.json(`/prescriptions?prescriptionId=${encodeURIComponent(vo)}`));
    const light = found.find((p: any) => p.prescriptionId === vo);
    if (!light) return null;
    const billing = await this.json(`/prescriptions/${light.id}?groups%5B%5D=billing%3Aread`);
    const inv = billing.invoice ?? null;
    // `billing:read` embeds the invoice WITHOUT `updatedAt` — that field lives only in the default
    // serialization, so AC4's "was this invoice rewritten by the run?" needs a second read. Only the
    // handful of listed VOs that carry an invoice pay for it.
    const invUpdatedAt = inv?.id ? ((await this.json(`/invoices/${inv.id}`)).updatedAt ?? null) : null;
    return {
      vo,
      id: light.id,
      codes: (light.prescribedTreatments ?? [])
        .map((pt: any) => pt.treatment)
        .filter(Boolean)
        .map((t: any) => ({ code: t.code, kind: t.kind ?? '', area: t.area ?? null })),
      therapyType: light.therapyType ?? null,
      treatmentStatus: billing.treatmentStatus ?? light.treatmentStatus ?? null,
      validationStatus: billing.validationStatus ?? null,
      imported: !!light.imported,
      totalRevenue: billing.totalRevenue ?? null,
      invoice: inv
        ? { number: inv.invoiceNumber, status: inv.status, amount: inv.invoiceAmount ?? null, updatedAt: invUpdatedAt }
        : null,
      billingBatchCount: billing.billingBatchCount ?? 0,
    };
  }

  /** The listed VOs, resolved concurrently. A VO absent from staging maps to `null`. */
  async listedVos(concurrency = 6): Promise<Map<string, VoFees | null>> {
    const numbers = [...new Set(LISTED_FEES.map((f) => f.vo))];
    const out = new Map<string, VoFees | null>();
    const queue = [...numbers];
    const worker = async () => {
      for (let vo = queue.shift(); vo; vo = queue.shift()) {
        out.set(vo, await this.voByNumber(vo).catch(() => null));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
  }

  // ───────────────────────── the independent cross-area detector ─────────────────────────

  /**
   * Proves the `therapyType` filter is a live filter before any of its zeros are trusted.
   *
   * An unknown value is accepted silently and answers `totalItems: 0` — so "no cross-area VOs"
   * and "I spelled the enum wrong" are the same response. The guard: the fee's OWN area must return
   * a non-zero population.
   */
  async assertTherapyTypeVocabulary(code = 'AB-L'): Promise<{ own: number; total: number }> {
    const t = this.treatment(code);
    if (!t || !t.area) throw new Error(`#3577: ${code} is not in the treatment catalogue`);
    const total = (await this.json(`/prescriptions?treatment=${t.id}&itemsPerPage=1`)).totalItems ?? 0;
    const own = (await this.json(`/prescriptions?treatment=${t.id}&therapyType=${AREA_TO_THERAPY_TYPE[t.area]}&itemsPerPage=1`)).totalItems ?? 0;
    return { own, total };
  }

  /** How many VOs of `voArea` carry the fee `code` — `totalItems` only, one cheap request. */
  async crossAreaCount(code: string, voArea: string): Promise<number> {
    const t = this.treatment(code);
    if (!t) return 0;
    const tt = AREA_TO_THERAPY_TYPE[voArea];
    return (await this.json(`/prescriptions?treatment=${t.id}&therapyType=${tt}&itemsPerPage=1`)).totalItems ?? 0;
  }

  /** The VOs behind a non-zero `crossAreaCount`. */
  async crossAreaCarriers(code: string, voArea: string, limit = 50): Promise<CrossAreaPair[]> {
    const t = this.treatment(code);
    if (!t) return [];
    const body = await this.json(`/prescriptions?treatment=${t.id}&therapyType=${AREA_TO_THERAPY_TYPE[voArea]}&itemsPerPage=${limit}`);
    return CrossAreaFeesPage.members(body).map((p: any) => ({
      vo: p.prescriptionId,
      prescriptionId: p.id,
      code,
      feeArea: t.area ?? '?',
      voArea,
      treatmentStatus: p.treatmentStatus ?? null,
      validationStatus: p.validationStatus ?? null,
      imported: !!p.imported,
    }));
  }

  /**
   * Every (fee, VO-area) combination in which a fee still sits on a VO of another area — the whole
   * `fee catalogue x areas` grid, `totalItems` only, so it stays affordable (56 requests).
   */
  async residualCrossAreaGrid(): Promise<{ code: string; feeArea: string; voArea: string; count: number }[]> {
    const jobs: { code: string; feeArea: string; voArea: string }[] = [];
    for (const t of this.feeTreatments()) {
      if (!t.area) continue;
      for (const voArea of Object.keys(AREA_TO_THERAPY_TYPE)) {
        if (voArea !== t.area) jobs.push({ code: t.code, feeArea: t.area, voArea });
      }
    }
    const out: { code: string; feeArea: string; voArea: string; count: number }[] = [];
    const queue = [...jobs];
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        out.push({ ...j, count: await this.crossAreaCount(j.code, j.voArea).catch(() => 0) });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return out.filter((r) => r.count > 0);
  }

  // ───────────────────────────── the exempted surfaces ─────────────────────────────

  async invoiceByNumber(number: string): Promise<{ id: number; number: string; status: string; amount: number | null; updatedAt: string | null; patientId: number | null; patientName: string | null } | null> {
    const body = await this.json('/invoices?itemsPerPage=1000&groups%5B%5D=invoice-list%3Aread');
    const hit = CrossAreaFeesPage.members(body).find((i: any) => i.invoiceNumber === number);
    if (!hit) return null;
    const full = await this.json(`/invoices/${hit.id}`);
    return {
      id: hit.id,
      number,
      status: hit.status,
      amount: hit.invoiceAmount ?? null,
      updatedAt: full.updatedAt ?? null,
      patientId: hit.prescription?.patient?.id ?? null,
      patientName: hit.prescription?.patient?.fullName ?? null,
    };
  }

  /** Every billing batch with its status and last-modified stamp — AC5's "not reopened, modified or resent". */
  async billingBatches(): Promise<{ id: number; batchId: string; status: string; therapyType: string | null; sentDate: string | null; updatedAt: string }[]> {
    const out: any[] = [];
    for (let page = 1; page <= 5; page++) {
      const body = await this.json(`/billing_batches?itemsPerPage=100&page=${page}`);
      const rows = CrossAreaFeesPage.members(body);
      out.push(...rows);
      // The collection caps a page at 50 however large `itemsPerPage` is, so "fewer than I asked
      // for" is NOT the last page — walk until a page comes back empty or nothing new arrives.
      if (0 === rows.length || out.length >= (body.totalItems ?? out.length)) break;
    }
    return out.map((b: any) => ({
      id: b.id,
      batchId: b.batchId,
      status: b.status,
      therapyType: b.therapyType ?? null,
      sentDate: b.sentDate ?? null,
      updatedAt: b.updatedAt,
    }));
  }

  /** The prescription ids inside one batch — used to ask whether a listed VO was ever batched. */
  async batchPrescriptions(batchId: number): Promise<{ id: number; vo: string }[]> {
    const body = await this.json(`/prescriptions?billingBatch=${batchId}&itemsPerPage=400`);
    return CrossAreaFeesPage.members(body).map((p: any) => ({ id: p.id, vo: p.prescriptionId }));
  }
}
