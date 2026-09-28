import { Page, expect } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';

/**
 * Optica GKV export problems surfaced before the download step (RC 3.12 #3343).
 *
 * The six export checks used to run only when someone downloaded the `.rz` file. They now also run
 * ahead of time and appear in three places: an amber badge on the GKV-Abrechnung batch list, a
 * warning marker with an inline issue panel inside a batch, and a non-blocking warning when a batch
 * is marked Ready to Send.
 *
 * **The data behind all three is one endpoint: `GET /billing_batches/export-problems`** (`fa9c81e4c`),
 * one item per Pending / Ready-to-Send batch with at least one failing VO, carrying
 * `OpticaExportValidator`'s groups verbatim plus `doctorId` / `practiceId` for the fix links. Sent
 * batches are excluded server-side, which is what makes AC4 true rather than a UI filter.
 *
 * **The screens are well hooked, so none of this needs text matching:**
 *
 * | surface | hook |
 * |---|---|
 * | overview badge | `[data-testid="export-problems-badge-<batchId>"]` |
 * | per-VO marker | `[data-testid="export-problem-marker-<prescriptionId>"]`, with `aria-expanded` |
 * | GKV tab | `/billing?tab=gkv_billing` |
 *
 * **Traps**
 * - **The badge renders only when the batch is unsent AND has an entry**
 *   (`'complete_and_sent' !== status && problems.get(id)`), so counting badges is a test of both
 *   halves at once — compare the badge SET against the endpoint, not just the total.
 * - **The marker cell returns `null` for a clean VO** — there is no disabled or empty control to
 *   find, so AC9 is asserted as absence against the VO numbers actually painted, not against the
 *   whole batch.
 * - **The detail table paginates.** Batch 63 has 13 problem VOs but a page shows 10 rows, so only
 *   the problem VOs on the visible page carry markers. Compare within the painted rows.
 * - **The screen renders issue text from its OWN translation map**, keyed by error code
 *   (`billing_batch.optica.errors.<CODE>` / `.hints.<CODE>`), not from the API strings. The same map
 *   feeds the download-blocked dialog, so both surfaces match — but the API's English wording and
 *   the frontend's differ for `MISSING_BSNR`, which is a finding rather than a selector problem.
 */

export const API = 'https://api.staging.therapios.de';
export const GKV_TAB_URL = 'https://staging.therapios.de/billing?tab=gkv_billing';

export type ExportIssue = { code: string; message: string; hint: string };
export type ProblemVo = {
  prescriptionId: number;
  vo: string;
  errors: ExportIssue[];
  doctorId: number | null;
  practiceId: number | null;
};
export type ProblemBatch = {
  batchId: number;
  batchLabel: string;
  status: string;
  problemVoCount: number;
  prescriptions: ProblemVo[];
};

export class OpticaExportProblemsPage {
  static readonly API = API;
  /** The batch statuses the badge is allowed to appear on (AC3/AC4). */
  static readonly UNSENT = ['pending', 'ready_to_send'];

  private token: string | null = null;

  constructor(private page: Page) {}

  // ────────────────────────────────── API ───────────────────────────────────

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = await apiBearerToken(this.page, { credentials });
    if (!this.token) {
      const response = await this.page.request.post(`${API}/auth`, {
        headers: { 'Content-Type': 'application/json' },
        data: { username: credentials.email, password: credentials.password },
        timeout: 120_000,
      });
      expect(response.status(), 'POST /auth').toBe(200);
      this.token = (await response.json()).token;
    }
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private async json(path: string, timeout = 240_000): Promise<any> {
    const response = await this.page.request.get(`${API}${path}`, { headers: this.auth(), timeout });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  /** The pre-send endpoint the three surfaces are built from. */
  async exportProblems(): Promise<ProblemBatch[]> {
    return OpticaExportProblemsPage.members(await this.json('/billing_batches/export-problems')).map((row: any) => ({
      batchId: row.batchId,
      batchLabel: row.batchLabel,
      status: row.status,
      problemVoCount: row.problemVoCount,
      prescriptions: (row.prescriptions ?? []).map((p: any) => ({
        prescriptionId: p.prescriptionId,
        vo: p.vo,
        errors: p.errors ?? [],
        doctorId: p.doctorId ?? null,
        practiceId: p.practiceId ?? null,
      })),
    }));
  }

  /**
   * Every VO in a batch — the endpoint lists only the FAILING ones, so AC9's clean population has
   * to come from here. Batch 63: 22 VOs, 13 flagged, 9 clean.
   */
  async batchPrescriptions(batchId: number): Promise<{ id: number; vo: string }[]> {
    return OpticaExportProblemsPage.members(
      await this.json(`/prescriptions?pagination=false&billingBatch=${batchId}&groups%5B%5D=billing%3Aread`),
    ).map((row: any) => ({ id: row.id, vo: String(row.prescriptionId ?? '') }));
  }

  async batches(): Promise<{ id: number; status: string; batchId: string }[]> {
    return OpticaExportProblemsPage.members(await this.json('/billing_batches?pagination=false')).map((row: any) => ({
      id: row.id,
      status: String(row.status ?? ''),
      batchId: String(row.batchId ?? ''),
    }));
  }

  /**
   * The authoritative download-time check. A blocked batch answers 422 with the same per-VO
   * groups; a Pending batch answers 422 with a status message instead, which is NOT the check.
   */
  async downloadCheckWording(batchIds: number[]): Promise<Map<string, string>> {
    const wording = new Map<string, string>();
    for (const id of batchIds) {
      const response = await this.page.request.get(`${API}/billing_batches/${id}/optica-export`, {
        headers: this.auth(),
        timeout: 240_000,
      });
      if (422 !== response.status()) continue;
      let body: any;
      try {
        body = JSON.parse(await response.text());
      } catch {
        continue;
      }
      for (const prescription of body.prescriptions ?? []) {
        for (const error of prescription.errors ?? []) {
          if (!wording.has(error.code)) wording.set(error.code, `${error.message} || ${error.hint}`);
        }
      }
    }
    return wording;
  }

  /** Round-trips a batch's status; the AC1 test reverts with this in a `finally`. */
  async setBatchStatus(batchId: number, status: string): Promise<number> {
    const response = await this.page.request.patch(`${API}/billing_batches/${batchId}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/merge-patch+json' },
      data: { status },
      timeout: 120_000,
    });
    return response.status();
  }

  // ─────────────────────────────────── UI ───────────────────────────────────

  /** Opens GKV-Abrechnung with a freshly minted session (the saved one is single-use). */
  async openGkvTab(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await mintUiSession(this.page, credentials);
    await this.page.goto(GKV_TAB_URL, { waitUntil: 'domcontentloaded' });
    await expect
      .poll(async () => this.page.locator('[data-testid^="export-problems-badge-"]').count(), {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(0);
  }

  badge(batchId: number) {
    return this.page.locator(`[data-testid="export-problems-badge-${batchId}"]`);
  }

  async badgeBatchIds(): Promise<number[]> {
    const badges = this.page.locator('[data-testid^="export-problems-badge-"]');
    const ids: number[] = [];
    for (let i = 0; i < (await badges.count()); i++) {
      const testId = (await badges.nth(i).getAttribute('data-testid')) ?? '';
      ids.push(Number(testId.replace('export-problems-badge-', '')));
    }
    return ids.sort((a, b) => a - b);
  }

  marker(prescriptionId: number) {
    return this.page.locator(`[data-testid="export-problem-marker-${prescriptionId}"]`);
  }

  async markerPrescriptionIds(): Promise<number[]> {
    const markers = this.page.locator('[data-testid^="export-problem-marker-"]');
    const ids: number[] = [];
    for (let i = 0; i < (await markers.count()); i++) {
      const testId = (await markers.nth(i).getAttribute('data-testid')) ?? '';
      ids.push(Number(testId.replace('export-problem-marker-', '')));
    }
    return ids.sort((a, b) => a - b);
  }

  /** Clicking the badge opens the batch detail (AC5); markers appearing is the readiness signal. */
  async openBatchFromBadge(batchId: number): Promise<void> {
    // The row is inside a horizontally scrolling table and the cell container is aria-disabled,
    // so a plain click can hang with actionTimeout at 0.
    await this.badge(batchId).click({ force: true, timeout: 30_000 });
    await expect
      .poll(async () => this.page.locator('[data-testid^="export-problem-marker-"]').count(), {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(0);
  }
}
