import { APIRequestContext, Page, expect } from '@playwright/test';
import { apiBearerToken, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3821 — the one-off billing-submission correction
 * (`app:billing-batch:correct-3821`), read-only surfaces.
 *
 * The command is CONSOLE-ONLY, so it has no route of its own and `GET /status`
 * cannot answer for it (it gives the release, not the commit — #3704). What IS
 * readable is everything the command reads and everything it leaves behind:
 *
 *   - `/billing_batches`            the submissions, their status and live totals
 *   - `/prescription_billing_batches`  the VO<->submission link rows
 *   - `/billing_batch_logs`         the submission history ("Batch erstellt" /
 *                                   "Rezept hinzugefügt" — AC5's own evidence)
 *   - `/prescription_logs`          the VO's Änderungsprotokoll
 *   - `/prescription_back_images`   Part 1's back sides
 *   - `/entities`                   the IK numbers criterion 1 checks
 *
 * THREE TRAPS, each pinned by its own assertion in the spec:
 *
 * 1. The per-VO filter convention is NOT shared between collections, and getting
 *    it wrong returns the WHOLE collection rather than failing:
 *      /prescription_billing_batches  ->  `prescription.id=`  (bare `prescription=` ignored)
 *      /invoices                      ->  `prescription=`     (`prescription.id=` ignored)
 *    They are exact opposites. Neither predicts the other (#3550).
 *
 * 2. Page size is capped PER COLLECTION below `itemsPerPage`: back images at 30,
 *    billing batches at 50, the rest at 100. "Fewer rows than I asked for" is
 *    therefore not the last page, so a walk that breaks on a short page silently
 *    reads 1% of the table — which here reported "0 movable back sides" out of
 *    3,284. `walk()` stops on `totalItems` and THROWS on a truncated read.
 *
 * 3. `entity`, `entity.id` and `billingBatchCount` are accepted and IGNORED on
 *    `/prescriptions`, so narrowing by Gesellschaft has to happen client-side.
 */

const API = 'https://api.staging.therapios.de';

/** The Part 2 staging fixture the ticket names. */
export const PART2 = {
  vo: '2707-27',
  prescriptionId: 22075,
  entityId: 3,
  entityName: 'Curano Berlin-Brandenburg 3 GmbH',
  therapyType: 'speech_therapy',
  /** The stuck validation, from the ticket's Background. */
  validatedAt: '2026-09-25',
} as const;

/** Submission-history entry types (AC5 / Localization Reference). */
export const HISTORY = {
  /** "Batch erstellt" */
  batchCreated: 'batch_created',
  /** "Rezept hinzugefügt" */
  voAdded: 'vo_added',
  voRemoved: 'vo_removed',
} as const;

export type Batch = {
  id: number;
  batchId: string;
  status: string;
  therapyType?: string;
  entity?: { id: number; name: string };
  sentDate?: string;
  ikNumber?: string;
  totalPrescriptions?: number;
  totalRevenue?: number;
  copaymentTotal?: number;
  confirmedImagesCount?: number;
  createdAt?: string;
};

export class SubmissionCorrectionPage {
  private token: string | null = null;

  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    this.token = await apiBearerToken(this.page, {
      credentials: STAGING_CREDENTIALS.superadmin,
    });
    expect(this.token, 'a bearer token is required for every read here').toBeTruthy();
  }

  private get req(): APIRequestContext {
    return this.page.request;
  }

  /** One GET, retried on a 5xx — these collections flap under load, and a 504 is
   *  the server being unhealthy, never evidence about the data (#3774). */
  async get(path: string): Promise<{ status: number; body: any }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.req.get(`${API}${path}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/ld+json',
          },
          timeout: 90_000,
        });
        if (res.status() >= 500) {
          await this.page.waitForTimeout(2_000 * (attempt + 1));
          continue;
        }
        const text = await res.text();
        try {
          return { status: res.status(), body: JSON.parse(text) };
        } catch {
          return { status: res.status(), body: text.slice(0, 400) };
        }
      } catch (error) {
        lastError = error;
        await this.page.waitForTimeout(2_000 * (attempt + 1));
      }
    }
    throw new Error(`GET ${path} failed after 3 attempts: ${String(lastError)}`);
  }

  static members(body: any): any[] {
    if (!body || typeof body !== 'object') return [];
    return body.member ?? body['hydra:member'] ?? (Array.isArray(body) ? body : []);
  }

  async totalItems(path: string): Promise<number> {
    const sep = path.includes('?') ? '&' : '?';
    const r = await this.get(`${path}${sep}itemsPerPage=1`);
    return r.body?.totalItems ?? SubmissionCorrectionPage.members(r.body).length;
  }

  /**
   * Walk a collection to completion.
   *
   * Stops on `totalItems`, NEVER on a short page — see trap 2 above — and throws
   * when the read came back short, so a truncated walk can never be mistaken for
   * a small population.
   */
  async walk(path: string, opts: { cap?: number } = {}): Promise<any[]> {
    const cap = opts.cap ?? 20_000;
    const sep = path.includes('?') ? '&' : '?';
    const first = await this.get(`${path}${sep}itemsPerPage=100&page=1`);
    const total = first.body?.totalItems ?? SubmissionCorrectionPage.members(first.body).length;
    let rows = SubmissionCorrectionPage.members(first.body);
    for (let page = 2; rows.length < Math.min(total, cap) && page <= 500; page++) {
      const r = await this.get(`${path}${sep}itemsPerPage=100&page=${page}`);
      const m = SubmissionCorrectionPage.members(r.body);
      if (!m.length) break;
      rows = rows.concat(m);
    }
    if (total <= cap && rows.length < total) {
      throw new Error(`truncated walk of ${path}: collected ${rows.length} of ${total}`);
    }
    return rows;
  }

  /** The batch id out of the `billingBatch` IRI, which renders with a trailing
   *  `/optica-export` segment on the link rows. */
  static batchIdFromIri(iri: unknown): number | undefined {
    const match = String(iri).match(/billing_batches\/(\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  async batches(): Promise<Batch[]> {
    return (await this.walk('/billing_batches')) as Batch[];
  }

  /** Every VO<->submission link row. NOTE the filter convention (trap 1). */
  async links(): Promise<any[]> {
    return this.walk('/prescription_billing_batches');
  }

  async linksForVo(prescriptionId: number): Promise<any[]> {
    return SubmissionCorrectionPage.members(
      (await this.get(`/prescription_billing_batches?prescription.id=${prescriptionId}&itemsPerPage=30`)).body,
    );
  }

  async batch(id: number): Promise<Batch> {
    return (await this.get(`/billing_batches/${id}`)).body as Batch;
  }

  async batchHistory(id: number): Promise<any[]> {
    return SubmissionCorrectionPage.members(
      (await this.get(`/billing_batch_logs?billingBatch.id=${id}&itemsPerPage=100`)).body,
    );
  }

  async voLog(prescriptionId: number): Promise<any[]> {
    return SubmissionCorrectionPage.members(
      (await this.get(`/prescription_logs?prescription=${prescriptionId}&itemsPerPage=100`)).body,
    );
  }

  async vo(prescriptionNumber: string): Promise<any | undefined> {
    return SubmissionCorrectionPage.members(
      (await this.get(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(prescriptionNumber)}`)).body,
    )[0];
  }

  async entities(): Promise<any[]> {
    return SubmissionCorrectionPage.members((await this.get('/entities?itemsPerPage=50')).body);
  }

  /** The submission-number prefix is the last three digits of the Gesellschaft's
   *  IK for that therapy type — which is exactly why criterion 1 has to check for
   *  a collision between Gesellschaften before Part 2 adds anything. */
  static ikPrefix(ik: unknown): string {
    return String(ik ?? '').slice(-3);
  }

  /** Invoices of one VO. NOTE: the opposite key to the link collection (trap 1). */
  async invoicesForVo(prescriptionId: number): Promise<any[]> {
    return SubmissionCorrectionPage.members(
      (await this.get(`/invoices?prescription=${prescriptionId}&itemsPerPage=30`)).body,
    );
  }
}
