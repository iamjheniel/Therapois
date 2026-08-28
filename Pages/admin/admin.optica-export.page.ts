import { Page, expect } from '@playwright/test';

/**
 * The Optica GKV export and its billing-readiness check — RC 3.11 #3288 (BSNR per VO).
 *
 * The export must submit the BSNR recorded on the prescription itself, falling back to the practice's
 * main BSNR when the VO has none, and the readiness check must read the same source.
 *
 * Surfaces, all verified live on staging:
 *  - **`GET /billing_batches/{id}/optica-export`** — the export. Three answers seen:
 *      * `422 {"type":"status","message":"This billing batch is not ready for export."}` for a
 *        `pending` batch;
 *      * `422 {"type":"validation","prescriptions":[{prescriptionId, vo, errors:[{code, message,
 *        hint}]}]}` — the **billing-readiness check**, which is where `MISSING_BSNR` surfaces;
 *      * a file, on a batch that passes both. No batch on staging reached that state.
 *  - **`GET /prescriptions/{id}`** (and the collection) carry the VO's own **`bsnr`**, *omitted
 *    entirely* when the VO has none — which is why an absent key, not `null`, means "pre-feature VO".
 *  - **`GET /practices/{id}`** carries `practiceBsnrs: [{number, isMain}]` (#3285) and `practiceId`,
 *    which equals the main BSNR.
 *
 * Read-only: exports are fetched, never sent; no batch status is touched.
 */

export type BatchRef = { id: number; status: string; batchId: string; prescriptionIds: number[] };
export type ReadinessError = { prescriptionId: number; vo: string; code: string; hint: string };
export type ExportAttempt = {
  batch: BatchRef;
  status: number;
  ms: number;
  bytes: number;
  /** 'file' | 'not_ready' | 'validation' | 'other' */
  outcome: 'file' | 'not_ready' | 'validation' | 'other';
  errors: ReadinessError[];
  body: string;
};

export type VoBsnr = {
  id: number;
  number: string;
  /** The VO's own recorded BSNR, or null when the field is absent (pre-feature VO). */
  ownBsnr: string | null;
  practiceId: number | null;
  practiceName: string | null;
  /** `practiceId` on the practice — the main BSNR. */
  practiceMainBsnr: string | null;
  hasDoctor: boolean;
};

export class OpticaExportPage {
  static readonly API = 'https://api.staging.therapios.de';

  private token: string | null = null;

  constructor(private page: Page) {}

  /**
   * Opens /billing and caches the bearer token.
   *
   * The billing page rather than the dashboard: the batch collection is only fetched reliably from
   * that context (see the #3191 spec, which hit intermittent rejections elsewhere).
   */
  async open(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1200 });
    await this.page.goto('/billing', { waitUntil: 'domcontentloaded' });
    // `auth-state` is written into localStorage from the .auth storageState BEFORE the page loads,
    // so the token is readable as soon as the document exists. The flat sleep this replaces was
    // waiting for nothing — it just delayed reading a value that was already there.
    await this.page
      .waitForFunction(() => !!localStorage.getItem('auth-state'), null, { timeout: 30_000 })
      .catch(() => {});
    this.token = await this.page.evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '');
        return state.token || state.accessToken || state.access_token || null;
      } catch {
        return null;
      }
    });
    expect(this.token, 'the session must carry a bearer token for the billing API').toBeTruthy();
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${OpticaExportPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
    });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  // ──────────────────────────────── batches ──────────────────────────────────

  async batches(pages = 3, perPage = 20): Promise<BatchRef[]> {
    const out: BatchRef[] = [];
    for (let page = 1; page <= pages; page++) {
      const body = await this.json(
        `/billing_batches?page=${page}&itemsPerPage=${perPage}&order%5BcreatedAt%5D=desc`,
      );
      for (const row of body.member ?? []) {
        out.push({
          id: row.id,
          status: row.status,
          batchId: row.batchId,
          prescriptionIds: (row.prescriptionBillingBatches ?? []).map((p: any) =>
            Number(String(p.prescription).split('/').pop()),
          ),
        });
      }
      if ((body.member ?? []).length < perPage) break;
    }
    return out;
  }

  /**
   * Attempts an export and classifies the answer.
   *
   * Capped at 90 s: on an eligible batch the endpoint has been seen not to answer within 45 s, and a
   * hanging request would take the suite with it.
   */
  async attemptExport(batch: BatchRef): Promise<ExportAttempt> {
    const started = Date.now();
    const res = await this.page.request
      .get(`${OpticaExportPage.API}/billing_batches/${batch.id}/optica-export`, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 90_000,
      })
      .catch(() => null);
    const ms = Date.now() - started;
    if (!res) {
      return { batch, status: -1, ms, bytes: 0, outcome: 'other', errors: [], body: 'timeout' };
    }
    const body = await res.text();
    if (res.status() === 200) {
      return { batch, status: 200, ms, bytes: body.length, outcome: 'file', errors: [], body };
    }
    const errors: ReadinessError[] = [];
    let outcome: ExportAttempt['outcome'] = 'other';
    try {
      const parsed = JSON.parse(body);
      if (parsed.type === 'status') outcome = 'not_ready';
      if (parsed.type === 'validation') {
        outcome = 'validation';
        for (const row of parsed.prescriptions ?? []) {
          for (const error of row.errors ?? []) {
            errors.push({ prescriptionId: row.prescriptionId, vo: row.vo, code: error.code, hint: error.hint ?? '' });
          }
        }
      }
    } catch {
      /* left as 'other' with the raw body for the caller to report */
    }
    return { batch, status: res.status(), ms, bytes: body.length, outcome, errors, body };
  }

  // ─────────────────────────── BSNR on VOs and practices ─────────────────────

  async voBsnr(prescriptionId: number): Promise<VoBsnr> {
    const row = await this.json(`/prescriptions/${prescriptionId}`);
    return {
      id: row.id,
      number: row.prescriptionId,
      ownBsnr: row.bsnr ?? null,
      practiceId: row.practice?.id ?? null,
      practiceName: row.practice?.name ?? null,
      practiceMainBsnr: row.practice?.practiceId ?? null,
      hasDoctor: !!row.doctor,
    };
  }

  /** VOs from one page of the collection, newest last — the collection serialises `bsnr` too. */
  async vosOnPage(pageNumber: number, perPage = 50): Promise<VoBsnr[]> {
    const body = await this.json(`/prescriptions?page=${pageNumber}&itemsPerPage=${perPage}`);
    return (body.member ?? []).map((row: any) => ({
      id: row.id,
      number: row.prescriptionId,
      ownBsnr: row.bsnr ?? null,
      practiceId: row.practice?.id ?? null,
      practiceName: row.practice?.name ?? null,
      practiceMainBsnr: row.practice?.practiceId ?? null,
      hasDoctor: !!row.doctor,
    }));
  }

  /** How many pages the prescription collection has at `perPage` — the newest VOs sit on the last. */
  async prescriptionPages(perPage = 50): Promise<{ total: number; lastPage: number }> {
    const body = await this.json(`/prescriptions?page=1&itemsPerPage=1`);
    const total = body.totalItems ?? 0;
    return { total, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }

  /** A practice's BSNR list (#3285): every number it holds, with which one is main. */
  async practiceBsnrs(practiceId: number): Promise<{ number: string; isMain: boolean }[]> {
    const body = await this.json(`/practices/${practiceId}`);
    return (body.practiceBsnrs ?? []).map((entry: any) => ({ number: String(entry.number), isMain: !!entry.isMain }));
  }
}
