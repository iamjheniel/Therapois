import { Page } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, mintUiSession } from '../util/api-token';

/**
 * The completed-session count on the five VO list views (RC 3.13 #3704).
 *
 * A documented visit marked Doppelbehandlung on a VO using the OLDER recording style counted as one
 * completed session instead of two, and a visit carrying only a fee-type Heilmittel counted as none.
 * The T-Board and the VO's own completion logic were always right, so a VO could auto-complete to
 * Fertig Behandelt while these five views still showed sessions "offen".
 *
 * ## One field, five views — which is what makes this testable read-only
 *
 * All five surfaces (Admin Board list, its mobile card, the Dokumentation window, the Patient
 * Management prescription table and the GKV Unbatch view) read **`activityCount` on
 * `GET /v2/prescriptions`**, computed by its own SQL in `PrescriptionListProvider::batchComputed()`.
 * `bd2da1cb6` changes that one expression and nothing else, so verifying the field verifies the five
 * views, and a single on-screen read confirms the wiring.
 *
 * ## The two expressions, and why a dual oracle is the only honest test
 *
 * `/status` reports the release, not the commit, so it cannot say whether THIS fix is in the image.
 * Both expressions are ported below and the served count is compared against both: the one it
 * matches is the one that is deployed. On the affected population they give different numbers, so
 * the comparison is decisive rather than merely consistent.
 *
 * ```sql
 * -- pre-fix:  COALESCE(treatment_qty, CASE WHEN double AND NOT v2 THEN 2 ELSE 1 END)
 * -- post-fix: WHEN treatment_at_count = 0 THEN (CASE WHEN double THEN 2 ELSE 1 END)
 * --           ELSE treatment_qty * (CASE WHEN double AND NOT v2 THEN 2 ELSE 1 END)
 * ```
 *
 * The pre-fix `COALESCE` only reached its 1-or-2 fallback when the LEFT JOIN produced NULL — i.e.
 * when the visit had **no `activity_treatment` row at all**. A V1 double at quantity 1 therefore
 * took `treatment_qty = 1` and never doubled, and a fee-only visit took `treatment_qty = 0` and
 * counted nothing.
 *
 * ## Traps
 *
 * - **`activity.doubleTreatment` is omitted when false** (#3602) and on the same VO arrives as
 *   `true`, as `false`, or absent — only `=== true` is safe. Reading it as truthy-or-missing
 *   mis-scores half the population.
 * - **`/v2/prescriptions` returns a BARE ARRAY** under `Accept: application/json` and carries no
 *   `totalItems`; `application/ld+json` on `/prescriptions` is what gives the book size.
 * - **`doubleTreatment` / `doubleTreatmentV2` are silently IGNORED as filters** on
 *   `/v2/prescriptions` — the filtered and unfiltered pages come back with byte-identical row ids
 *   (#3449's shape), so the double population must be found by walking, never by filtering.
 * - `/activities` registers `prescription` (and `prescription[]`, which takes many ids per request —
 *   what makes a census affordable); `prescription.id` is NOT registered (#3533).
 * - The embedded `treatment` carries `kind`, which is the whole discriminator; a fee-only visit is
 *   one with `activityTreatments` but none of `kind: "treatment"`.
 *
 * ## An edge the ACs do not cover
 *
 * The shipped post-fix branch for "no treatment-kind row" doubles on `double_treatment` **without**
 * checking V2 — faithful to `Activity::getActivityCountContribution()`, but it means a V2 VO with a
 * double-flagged visit carrying no `activity_treatment` row would shift 1 → 2, which AC3 forbids.
 * `v2EdgeInstances()` counts them; on production there are none, so the divergence is latent.
 */

export const PROD_API = 'https://api.app.therapios.de';
export const PROD_WEB = 'https://app.therapios.de';

/** The ticket's own AC1 example: V1 double, one double-flagged visit on 10.08.2026, 10 prescribed. */
export const TICKET_FIXTURE = '8950-1';

/**
 * Fee-only fixtures for AC2, all **Archiviert** so their counts cannot move between runs.
 *
 * `3206-5` and `4838-7` are the severe shape — *every* documented visit carries only a fee — so the
 * pre-fix expression scored them **0**, and 4838-7 was a finished VO reading 0 of 6.
 */
export const FEE_ONLY_FIXTURES = ['3206-5', '4838-7', '5096-2', '4956-4'] as const;

export type Activity = {
  id: number;
  date: string;
  doubleTreatment?: boolean;
  rejectedTreatment?: boolean;
  rejectedTreatmentWithSignature?: boolean;
  treatmentType?: string;
  activityTreatments?: { quantity?: number; treatment?: { code?: string; kind?: string } }[];
};

export type VoRow = {
  id: number;
  prescriptionId: string;
  doubleTreatment?: boolean;
  doubleTreatmentV2?: boolean;
  activityCount?: number;
  totalTreatments?: number;
  remainingTreatments?: number;
  treatmentStatus?: string;
  startActivityDate?: string | null;
  lastActivityDate?: string | null;
  currentWeekTreatments?: number;
};

export class SessionCountParityPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    // `POST /auth` is the single non-GET call in this file; everything else is read-only.
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.page.request.post(`${PROD_API}/auth`, {
          headers: { 'Content-Type': 'application/json' },
          data: { username: credentials.email, password: credentials.password },
          timeout: 90_000,
        });
        if (res.ok()) {
          this.token = (await res.json()).token;
          if (this.token) return;
        }
        last = `HTTP ${res.status()}`;
      } catch (err) {
        last = err;
      }
      await this.page.waitForTimeout(8_000 * (attempt + 1));
    }
    throw new Error(`#3704: no production bearer token — ${String(last).slice(0, 160)}`);
  }

  private async json(path: string, params: Record<string, any> = {}, accept = 'application/json'): Promise<any> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.append(k, String(v));
    }
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.page.request.get(`${PROD_API}${path}?${qs}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
        timeout: 240_000,
      });
      if (res.ok()) return res.json();
      last = `HTTP ${res.status()}`;
      if (res.status() === 401) await this.connect();
      await this.page.waitForTimeout(4_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  private static rows(payload: any): any[] {
    return Array.isArray(payload) ? payload : (payload?.member ?? payload?.['hydra:member'] ?? []);
  }

  /** One VO row as the five views receive it. `exact[prescriptionId]` addresses a VO by its number. */
  async vo(prescriptionId: string): Promise<VoRow | null> {
    const rs = SessionCountParityPage.rows(await this.json('/v2/prescriptions', { 'exact[prescriptionId]': prescriptionId }));
    return rs[0] ?? null;
  }

  /** How many VOs exist — only `/prescriptions` under `ld+json` reports a total. */
  async bookSize(): Promise<number> {
    const body = await this.json('/prescriptions', { itemsPerPage: 1 }, 'application/ld+json');
    return body.totalItems ?? body['hydra:totalItems'] ?? 0;
  }

  /** Activities for many VOs at once — `prescription[]` is registered and takes a batch. */
  async activitiesFor(voIds: number[], batch = 25): Promise<Map<number, Activity[]>> {
    const out = new Map<number, Activity[]>();
    voIds.forEach((id) => out.set(id, []));
    for (let i = 0; i < voIds.length; i += batch) {
      const chunk = voIds.slice(i, i + batch);
      const rs = SessionCountParityPage.rows(
        await this.json('/activities', { 'prescription[]': chunk, itemsPerPage: 3000 }),
      );
      for (const a of rs) {
        const pid = a?.prescription?.id;
        if (out.has(pid)) out.get(pid)!.push(a);
      }
    }
    return out;
  }

  /** Walks `/v2/prescriptions`. The double flags are not filterable, so the population is a walk. */
  async walkVos(pageSize = 500, maxPages = 200, onPage?: (n: number) => void, fromPage = 1): Promise<VoRow[]> {
    const all: VoRow[] = [];
    for (let p = fromPage; p < fromPage + maxPages; p++) {
      const rs = SessionCountParityPage.rows(await this.json('/v2/prescriptions', { itemsPerPage: pageSize, page: p }));
      all.push(...rs);
      onPage?.(all.length);
      if (rs.length < pageSize) break;
    }
    return all;
  }

  /**
   * The most recently created VOs.
   *
   * The collection is ordered by id ascending, so an **Aktiv** VO — the state the five views are
   * actually read in — lives at the END of the book. A slice taken from page 1 is almost all
   * archived history, which is why a screen test fed from there finds no live fixture and skips.
   */
  async walkRecentVos(pages = 20, pageSize = 500): Promise<VoRow[]> {
    const lastPage = Math.max(1, Math.ceil((await this.bookSize()) / pageSize));
    return this.walkVos(pageSize, pages, undefined, Math.max(1, lastPage - pages + 1));
  }

  // ───────────────────────────── the two expressions, ported ─────────────────────────────

  private static excluded(a: Activity): boolean {
    if (a.rejectedTreatment && !a.rejectedTreatmentWithSignature) return true;
    return a.treatmentType === 'planned';
  }

  /** Per-visit contribution. `postFix: false` is the pre-#3704 `COALESCE` expression. */
  static contribution(a: Activity, v2: boolean, postFix: boolean): number {
    if (SessionCountParityPage.excluded(a)) return 0;
    const ats = a.activityTreatments ?? [];
    const isDouble = a.doubleTreatment === true; // omitted when false (#3602)
    const treatmentKind = ats.filter((x) => x.treatment?.kind === 'treatment');
    const qty = treatmentKind.reduce((s, x) => s + (x.quantity ?? 0), 0);
    if (postFix) {
      if (treatmentKind.length === 0) return isDouble ? 2 : 1; // note: no V2 check, as shipped
      return qty * (isDouble && !v2 ? 2 : 1);
    }
    if (ats.length === 0) return isDouble && !v2 ? 2 : 1; // the join was NULL only with no AT row
    return qty;
  }

  static counts(activities: Activity[], v2: boolean): { pre: number; post: number } {
    return {
      pre: activities.reduce((s, a) => s + SessionCountParityPage.contribution(a, v2, false), 0),
      post: activities.reduce((s, a) => s + SessionCountParityPage.contribution(a, v2, true), 0),
    };
  }

  static isV1Double(v: VoRow): boolean {
    return v.doubleTreatment === true && v.doubleTreatmentV2 !== true;
  }

  /** AC2's shape: the visit carries fee rows but no treatment-kind row, and it counts. */
  static isFeeOnlyVisit(a: Activity): boolean {
    if (SessionCountParityPage.excluded(a)) return false;
    const ats = a.activityTreatments ?? [];
    return ats.length > 0 && !ats.some((x) => x.treatment?.kind === 'treatment');
  }

  /** The AC3 edge: a double-flagged visit on a V2 VO carrying no activity_treatment row at all. */
  static v2EdgeInstances(activities: Activity[]): number {
    return activities.filter((a) => (a.activityTreatments ?? []).length === 0 && a.doubleTreatment === true).length;
  }

  // ───────────────────────────────── the board on screen ─────────────────────────────────

  /**
   * Opens the production Admin Board, searches one VO, and returns BOTH the board's own
   * `/v2/prescriptions` row and the text of its Beh. Status cell — so the number asserted on screen
   * is compared against the payload it was actually painted from (#3471's technique), never against
   * a figure this file fetched separately.
   *
   * The board defaults to the non-archived list, so only a VO in it can be found this way.
   */
  async boardRow(prescriptionId: string): Promise<{ served: VoRow | null; fraction: string | null }> {
    await this.page.setViewportSize({ width: 2400, height: 1200 });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin, { api: PROD_API });

    let served: VoRow | null = null;
    this.page.on('response', async (r) => {
      if (!r.url().includes('/v2/prescriptions') || r.status() !== 200) return;
      try {
        const hit = SessionCountParityPage.rows(await r.json()).find((x: any) => x.prescriptionId === prescriptionId);
        if (hit) served = hit;
      } catch {
        /* a torn body is not evidence of anything */
      }
    });

    await this.page.goto(`${PROD_WEB}/dashboard`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(
      () => ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes('Verordnungen'),
      null,
      { timeout: 180_000 },
    );
    const box = this.page.locator('input[placeholder*="uchen"], input[placeholder*="Search"]').first();
    await box.click({ timeout: 30_000 });
    await box.fill(prescriptionId);
    await box.press('Enter');
    await this.page.waitForTimeout(15_000);

    const text = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    const fraction = text.match(/\d+\s*\/\s*\d+/)?.[0] ?? null;
    return { served, fraction };
  }
}
