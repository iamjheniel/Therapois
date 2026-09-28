import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * An uploaded signed Honorarvereinbarung counts as the patient's signed fee agreement — RC 3.14
 * #3790, commit `0d5bc0d27` (2026-09-25 05:44, on `release/3.14.0` AND `release/3.15.0`, no PR).
 *
 * Uploading a signed fee agreement on the patient page created only a `PatientDocument`; the
 * patient's `Hono` was untouched, so the Document Center, the waiting PKV VOs and the ETI contract
 * date all still saw an unsigned agreement. `HonoUploadSigner` now moves the patient's open Hono to
 * SIGNED — as a status UPDATE on purpose, because `HonoStatusListener` reacts to updates only and is
 * the one place that stamps `signedDate`, writes the Hono log and activates the waiting PKV VOs.
 *
 * ## Everything the ACs name is readable; only the trigger is a write
 *
 * | AC surface | Endpoint |
 * |---|---|
 * | Document Center fee-agreements card | `GET /document_center/documents?type=hv&status=…` |
 * | its open count ("offen") | `GET /document_center/counts` → `hvActionable` / `hvTotal` |
 * | the row's view/download | the row's own `contentUrl` |
 * | the patient's Hono, its signed date and log | `GET /honos?patient=<id>` (+ `/hono_logs`) |
 * | the PKV VOs and their logs | `GET /prescriptions?patient.id=` , `/prescription_logs?prescription=` |
 * | AC3's tile | `GET /kpis/admin-performance/risks` → `honoFehlt` rows |
 *
 * ## THE TRAP THAT TESTS THE WRONG PATIENT, silently
 *
 * The ticket says "patient 8789", "patient 8786", "patient 9498". Those are the **patient NUMBER**
 * the UI shows (`patientNumber` on a Document Center row), not the API id — 8789 is patient id
 * **7517**, 9498 is **8286**. And `GET /patients/8789` answers **200** for an unrelated person, so a
 * spec written on the ticket's numbers reads a real patient, finds none of the described state and
 * concludes the ticket is wrong. {@link resolveByPatientNumber} does the lookup properly. Same shape
 * as #3577, where "patient 6330" was the VO-number prefix.
 *
 * ## Other traps
 *
 *  - **`?patient=` works on `/honos` and is SILENTLY IGNORED on `/patient_documents`** (it returns
 *    all 965 rows). Neither collection's convention predicts the other's (#3550), so
 *    {@link assertFiltersPartition} proves each one before a count from it is believed. On
 *    `/patient_documents` the registered filter is **`documentType`**; `type` is ignored.
 *  - **An upload cannot be undone from a client.** `DELETE /patient_documents/{id}` is **405** — no
 *    delete route exists — and the upload also archives the patient's unsigned Honos, signs one,
 *    writes a Hono log and activates PKV VOs. That is why the mutating test is env-gated.
 *  - The Document Center's `status` filter is a validated enum (a bogus value errors rather than
 *    being ignored), and `archived`/`signed_migrated` legitimately answer **0** there — the card
 *    lists Honos, and those two statuses are Hono statuses the card never shows.
 */

export const API = API_BASE;

/** The fee-agreements card's three filters, and what they partition (measured 2026-09-25). */
export const HV_STATUSES = ['signed', 'sent', 'not_sent'] as const;

/**
 * The ticket's own identifiers, resolved. Left as a map so a reader who arrives with the ticket's
 * numbers lands on the right patient instead of a stranger.
 */
export const TICKET_PATIENTS = {
  /** "patient 8789" — the repro; already consumed by a workaround run, per the ticket itself. */
  8789: 7517,
  /** "patient 8786" — the control whose edit-to-Signed worked. */
  8786: 7522,
  /** "patient 9498" — the billing team's REAL case. Leave it alone. */
  9498: 8286,
} as const;

export type Hono = {
  id: number;
  patient: string;
  status: string;
  /** OMITTED when unset — reads `undefined`, never `null`. */
  signedDate?: string | null;
  createdAt: string;
  logs: string[];
  honoDocumentId: number | null;
  pkvPrescriptionCount: number | null;
};

export type DocRow = {
  id: string;
  documentType: string;
  documentId: number;
  patientId: number;
  patientNumber: number;
  patientName: string;
  status: string;
  createdAt: string;
  signedAt?: string | null;
  contentUrl?: string | null;
};

export class FeeAgreementUploadPage {
  private static cache = new Map<string, Promise<unknown>>();
  private bearer: string | null = null;

  constructor(private request: APIRequestContext) {}

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  /** A GET that retries a 5xx rather than scoring it — these are slow endpoints (#3774). */
  async get<T>(path: string, tries = 3): Promise<T> {
    const token = await this.token();
    let last = 0;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const res = await this.request.get(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout: 300_000,
        failOnStatusCode: false,
      });
      last = res.status();
      if (last < 500) {
        expect(last, `GET ${path}`).toBe(200);
        return (await res.json()) as T;
      }
      if (attempt < tries) await new Promise((r) => setTimeout(r, 10_000 * attempt));
    }
    throw new Error(`GET ${path} -> ${last} after ${tries} attempts`);
  }

  async total(path: string): Promise<number> {
    const b = await this.get<{ totalItems?: number }>(path);
    return b.totalItems ?? 0;
  }

  /** Walks a Hydra collection, asserting it collected everything it was promised. */
  async walk<T>(path: string, per = 100): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const b = await this.get<{ member?: T[]; totalItems?: number }>(`${path}${sep}itemsPerPage=${per}&page=${page}`);
      const m = b.member ?? [];
      out.push(...m);
      if (!m.length || out.length >= (b.totalItems ?? 0)) {
        expect(out.length, `walked ${path} completely`).toBe(b.totalItems ?? out.length);
        return out;
      }
    }
  }

  // ─────────────────────────────── the surfaces ───────────────────────────────

  honos = () => this.walk<Hono>('/honos');
  honosFor = (patientId: number) => this.walk<Hono>(`/honos?patient=${patientId}`);
  docCenterRows = (status?: string) =>
    this.walk<DocRow>(`/document_center/documents?type=hv${status ? `&status=${status}` : ''}`);
  docCenterCounts = () => this.get<Record<string, number>>('/document_center/counts');

  async prescriptionsFor(patientId: number): Promise<Record<string, unknown>[]> {
    const b = await this.get<{ member?: Record<string, unknown>[] }>(
      `/prescriptions?patient.id=${patientId}&groups%5B%5D=billing:read&itemsPerPage=50`,
    );
    return b.member ?? [];
  }

  async honoFehltVoNumbers(): Promise<Set<string>> {
    const body = await this.get<Record<string, unknown>>('/kpis/admin-performance/risks');
    const dto = (Array.isArray((body as { member?: unknown[] }).member)
      ? (body as { member: Record<string, unknown>[] }).member[0]
      : body) as { rows?: Record<string, unknown>[] };
    return new Set(
      (dto.rows ?? []).filter((r) => r.tile === 'honoFehlt').map((r) => String(r.voNumber)),
    );
  }

  /** Signed Honorarvereinbarung DOCUMENTS — the upload side of the comparison. */
  signedFeeAgreementDocuments = () =>
    this.walk<Record<string, unknown>>('/patient_documents?documentType=honorarvereinbarung&status=signed');

  async prescriptionLogs(prescriptionId: number): Promise<Record<string, unknown>[]> {
    const b = await this.get<{ member?: Record<string, unknown>[] }>(
      `/prescription_logs?prescription=${prescriptionId}&itemsPerPage=100`,
    );
    return b.member ?? [];
  }

  // ───────────────────────────── the ticket's numbers ─────────────────────────

  /**
   * The UI patient NUMBER → the API patient id, read off a Document Center row.
   *
   * Never pass the ticket's number to `/patients/{id}`: it resolves, to somebody else.
   */
  async resolveByPatientNumber(patientNumber: number): Promise<number | null> {
    const rows = await this.docCenterRows();
    return rows.find((r) => r.patientNumber === patientNumber)?.patientId ?? null;
  }

  // ─────────────────────────────── the one write ──────────────────────────────

  /**
   * `POST /patient_documents/upload` with a signed fee agreement — the action under test.
   *
   * Note the path: the collection is `/patient_documents`, but the multipart create is its own
   * `uriTemplate` and posting to the collection answers **405**. The fields are `patient` (an IRI),
   * `documentType`, `status` and `file`; the controller runs them through `decodeJsonField`, so a
   * raw string works as well as the JSON-quoted form the app sends.
   *
   * **Irreversible.** There is no delete route, and the request also archives the patient's unsigned
   * Honos, signs one (stamping `signedDate` and a Hono log) and moves their waiting PKV VOs to
   * Aktiv. Only ever called from the env-gated test.
   */
  async uploadSignedFeeAgreement(patientId: number, pdf: Buffer, name = 'qa-3790-signed.pdf'): Promise<{ status: number; body: string }> {
    const token = await this.token();
    const res = await this.request.post(`${API}/patient_documents/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        patient: `/patients/${patientId}`,
        documentType: 'honorarvereinbarung',
        status: 'signed',
        file: { name, mimeType: 'application/pdf', buffer: pdf },
      },
      timeout: 180_000,
      failOnStatusCode: false,
    });
    return { status: res.status(), body: (await res.text()).slice(0, 600) };
  }

  /** A minimal valid one-page PDF, so nothing depends on a fixture file on disk. */
  static tinyPdf(label: string): Buffer {
    const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 10 Tf 12 50 Td (${label}) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
    return Buffer.from(body, 'latin1');
  }

  // ────────────────────────────── filter guards ───────────────────────────────

  /**
   * Proves each filter this file relies on actually narrows, before any count from it is believed.
   *
   * On this API an unregistered filter is accepted and IGNORED, so a zero (or a full book) reads
   * exactly like a real answer — and the two collections here disagree about which key works.
   */
  async assertFiltersPartition(): Promise<void> {
    const allDocs = await this.total('/patient_documents?itemsPerPage=1');
    const byType = await this.total('/patient_documents?documentType=honorarvereinbarung&itemsPerPage=1');
    const wrongKey = await this.total('/patient_documents?type=honorarvereinbarung&itemsPerPage=1');
    const bogus = await this.total('/patient_documents?zzzNotAFilter=1&itemsPerPage=1');
    expect(byType, 'documentType is a registered filter').toBeLessThan(allDocs);
    expect(wrongKey, '`type` is IGNORED on /patient_documents').toBe(allDocs);
    expect(bogus, 'and so is an unknown key').toBe(allDocs);

    const allHonos = await this.total('/honos?itemsPerPage=1');
    const oneP = await this.total(`/honos?patient=${TICKET_PATIENTS[9498]}&itemsPerPage=1`);
    expect(oneP, '`patient` IS registered on /honos').toBeLessThan(allHonos);
  }
}
