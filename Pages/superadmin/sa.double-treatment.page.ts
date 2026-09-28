import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * Doppelbehandlung must double the sessions actually marked double, not every session on the VO
 * (RC 3.12 #3602).
 *
 * `ActivityRevenueCalculator::calculateActivityRevenue()` computed
 * `$multiplier = ($isDouble && !$isV2) ? 2 : 1` from **`prescription`**`->isDoubleTreatment()` — a
 * VO-level flag — and applied it to every branch, so turning the VO setting on doubled the billed
 * amount of every session, including ones the therapist never ticked. `RawKpiCalculator` carried
 * the same rule in SQL (`DOUBLE_TREATMENT_MULTIPLIER_EXPR`). The fix substitutes the per-session
 * `Activity::getDoubleTreatment()` in both engines, leaving V2 VOs (whose quantities already carry
 * the doubling) on multiplier 1.
 *
 * ## The problem this page object solves
 *
 * **The per-session flag is exposed by no serialization group** — `/activities` returns it under
 * none of `billing:read`, `activity:read`, `doku:read` … and neither `/prescriptions` nor
 * `/activities` registers a filter for double treatment. `order[doubleTreatment]` is accepted and
 * **silently ignored** (asc and desc return byte-identical pages — the #3449 trap), so the affected
 * VOs cannot be sorted to the top either.
 *
 * Two findings from the deployed bundle unlock it:
 *
 * 1. **The field IS on the activity payload; API Platform omits it when false.** The validation
 *    page's own line builder reads `t.doubleTreatment` and, when true, duplicates the session's
 *    treatment lines *after filtering out fees*:
 *    `(t.activityTreatments ?? []).filter(e => 'one_time_fee' !== e.treatment?.kind && 'per_treatment_fee' !== e.treatment?.kind)`.
 *    So `true === activity.doubleTreatment` is readable, absence means false, and AC8's "fees are
 *    never doubled" is visible in the client's own rule.
 *
 * 2. **A discriminator that needs no per-session flag at all.** For a V1 double VO the OLD rule can
 *    produce only two totals — `fees + base` (flag off) or `fees + 2*base` (flag on) — while the new
 *    rule produces `fees + Σ(line × (session double ? 2 : 1))`, which lands strictly between them
 *    whenever the VO has a mix. **A served total strictly between the two is proof the per-session
 *    rule is running**, whatever the individual flags say. `classify()` implements exactly that, and
 *    reports `ambiguous` — never a pass — for a VO whose sessions are all double or all single,
 *    where the two rules agree by construction and the VO is therefore not evidence.
 *
 * ## Traps
 *
 * - **There is no way to enumerate the population cheaply.** `/prescriptions` costs ~0.13 s per row,
 *   so a full 34.247-VO walk is ~74 minutes, and three concurrent 1.000-row pages 504 every request.
 *   `sample()` walks pages spread across the id space at a page size staging tolerates.
 * - **`/activities/{id}` is 404** (no item Get, #3398) — read sessions through the collection.
 * - **`insuranceType` is omitted** on these VOs, so the price resolver defaults to GKV; the oracle
 *   here prices off each row's stored `resolvedTariff` and never re-resolves, which sidesteps it.
 * - The ticket's two named staging fixtures, **VOs 6421-14 and 8708-3, do not exist** — verified
 *   with `exact[prescriptionId]`, which returns 1 for a control VO and 0 for both of these.
 */

/** V1 double VOs found on staging, with the shape that decides whether each is evidence. */
export const KNOWN_V1_DOUBLE_VOS = [
  '1482-16', '1503-25', '1281-16', '1714-14', '4056-1',
  '215-19', '1163-18', '216-19', '200-17', '221-18',
  '137-27', '184-28', '1278-17', '4900-2', '4908-4',
  '1116-14', '3568-9', '2165-14', '1421-20',
] as const;

/** The VOs the ticket names as V2 — neither resolves on staging. */
export const TICKET_V2_VOS = ['6421-14', '8708-3'] as const;

/** `Treatment.kind` values that are fees, and are never doubled (AC8). */
export const FEE_KINDS = new Set(['one_time_fee', 'per_treatment_fee']);

export type SessionRow = {
  id: number;
  date: string;
  /** `true` only when the payload carries the flag — it is omitted when false. */
  double: boolean;
  countable: boolean;
  /** Sum of the session's non-fee lines at their stored tariff. */
  treatmentLines: number;
  /** Sum of the session's fee lines. */
  feeLines: number;
  codes: string[];
};

export type DoubleVo = {
  vo: string;
  id: number;
  insuranceType: string | null;
  blankoVO: boolean;
  doubleTreatment: boolean;
  doubleTreatmentV2: boolean;
  treatmentStatus: string | null;
  served: number | null;
  invoice: { number: string; status: string; amount: number | null } | null;
  copaymentAmount: number | null;
  sessions: SessionRow[];
};

export type Pricing = {
  /** Every session billed singly. */
  single: number;
  /** The per-session rule — the fix. */
  perSession: number;
  /** The old VO-level rule: every session doubled. */
  voLevel: number;
  fees: number;
  doubleSessions: number;
  countableSessions: number;
};

export type Verdict = 'per-session' | 'vo-level' | 'ambiguous' | 'neither';

export class DoubleTreatmentPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3602: no bearer token');
  }

  private async json(path: string, timeout = 180_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(5_000);
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? (Array.isArray(body) ? body : []);
  }

  // ──────────────────────────────── reading a VO ────────────────────────────────

  async voByNumber(number: string): Promise<DoubleVo | null> {
    const hit = DoubleTreatmentPage.members(
      await this.json(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`),
    ).find((p: any) => p.prescriptionId === number);
    if (!hit) return null;
    return await this.vo(hit.id);
  }

  async vo(prescriptionId: number): Promise<DoubleVo> {
    const billing = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    const light = await this.json(`/prescriptions/${prescriptionId}`);
    // The validation page's own request shape — `pagination=false`, date-ordered.
    const acts = DoubleTreatmentPage.members(
      await this.json(`/activities?pagination=false&order%5Bdate%5D=asc&prescription=${prescriptionId}`),
    );
    const inv = billing.invoice ?? null;
    return {
      vo: billing.prescriptionId ?? light.prescriptionId,
      id: prescriptionId,
      insuranceType: billing.insuranceType ?? null,
      blankoVO: !!light.blankoVO,
      doubleTreatment: !!light.doubleTreatment,
      doubleTreatmentV2: !!light.doubleTreatmentV2,
      treatmentStatus: billing.treatmentStatus ?? null,
      served: billing.totalRevenue ?? null,
      invoice: inv ? { number: inv.invoiceNumber, status: inv.status, amount: inv.invoiceAmount ?? null } : null,
      copaymentAmount: billing.copaymentAmount ?? null,
      sessions: acts.map((a: any) => DoubleTreatmentPage.toSession(a)),
    };
  }

  static toSession(a: any): SessionRow {
    const rejected = !!a.rejectedTreatment;
    let treatmentLines = 0;
    let feeLines = 0;
    const codes: string[] = [];
    for (const t of a.activityTreatments ?? []) {
      const kind = t.treatment?.kind ?? '';
      const amount = (t.resolvedTariff ?? 0) * (t.quantity ?? 1);
      codes.push(t.treatment?.code ?? '?');
      if (FEE_KINDS.has(kind)) feeLines += amount;
      else treatmentLines += amount;
    }
    return {
      id: a.id,
      date: String(a.date ?? '').slice(0, 10),
      // Omitted when false — presence IS the flag.
      double: true === a.doubleTreatment,
      countable: !(rejected && !a.rejectedTreatmentWithSignature) && 'planned' !== a.treatmentType,
      treatmentLines,
      feeLines,
      codes,
    };
  }

  // ──────────────────────────────── the dual oracle ────────────────────────────────

  /**
   * The three totals the two rules can produce. Fees are summed once in all of them — never
   * doubled — which is what AC8 asserts and what the client's own line builder does.
   */
  static price(vo: DoubleVo): Pricing {
    const countable = vo.sessions.filter((s) => s.countable);
    let base = 0;
    let perSession = 0;
    let fees = 0;
    for (const s of countable) {
      base += s.treatmentLines;
      perSession += s.treatmentLines * (s.double ? 2 : 1);
      fees += s.feeLines;
    }
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      single: r(fees + base),
      perSession: r(fees + perSession),
      voLevel: r(fees + base * 2),
      fees: r(fees),
      doubleSessions: countable.filter((s) => s.double).length,
      countableSessions: countable.length,
    };
  }

  /**
   * Which rule the served total is consistent with.
   *
   * `ambiguous` when the two rules coincide — a VO whose sessions are ALL double (or all single)
   * cannot distinguish them, and must never be counted as a pass.
   */
  static classify(vo: DoubleVo, p: Pricing = DoubleTreatmentPage.price(vo)): Verdict {
    const served = vo.served;
    if (null === served) return 'neither';
    const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
    if (near(p.perSession, p.voLevel)) return 'ambiguous';
    if (near(served, p.perSession)) return 'per-session';
    if (near(served, p.voLevel)) return 'vo-level';
    return 'neither';
  }

  // ──────────────────────────── finding the population ────────────────────────────

  /**
   * Walks pages spread across the id space looking for double-flagged VOs.
   *
   * A full enumeration is ~74 minutes (34.247 VOs at ~0.13 s each) and concurrent large pages 504,
   * so this samples instead. It returns what it found plus how much it looked at, so a caller can
   * report prevalence honestly rather than implying a census.
   */
  async sample(pages: number[], perPage = 200): Promise<{ scanned: number; found: { vo: string; id: number; v1: boolean; v2: boolean; activityCount: number }[] }> {
    const found: { vo: string; id: number; v1: boolean; v2: boolean; activityCount: number }[] = [];
    let scanned = 0;
    for (const n of pages) {
      const rows = DoubleTreatmentPage.members(
        await this.json(`/prescriptions?itemsPerPage=${perPage}&order%5Bid%5D=asc&page=${n}`).catch(() => ({})),
      );
      scanned += rows.length;
      for (const p of rows) {
        if (p.doubleTreatment || p.doubleTreatmentV2) {
          found.push({
            vo: p.prescriptionId,
            id: p.id,
            v1: !!p.doubleTreatment && !p.doubleTreatmentV2,
            v2: !!p.doubleTreatmentV2,
            activityCount: p.activityCount ?? 0,
          });
        }
      }
    }
    return { scanned, found };
  }

  /** `exact[prescriptionId]` — returns the match count, for proving a named VO is absent. */
  async voExists(number: string): Promise<number> {
    return (await this.json(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`)).totalItems ?? 0;
  }

  /** The Admin Board's own list, which serves `amount` beside `totalRevenue`. */
  async boardRow(number: string): Promise<{ amount: number | null; totalRevenue: number | null } | null> {
    const hit = DoubleTreatmentPage.members(
      await this.json(`/v2/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`),
    ).find((p: any) => p.prescriptionId === number);
    return hit ? { amount: hit.amount ?? null, totalRevenue: hit.totalRevenue ?? null } : null;
  }

  /** Whether `order[<field>]` actually sorts, or is silently ignored (#3449's trap). */
  async orderIsHonoured(field: string): Promise<boolean> {
    const ids = async (dir: string) =>
      DoubleTreatmentPage.members(
        await this.json(`/prescriptions?itemsPerPage=20&order%5B${encodeURIComponent(field)}%5D=${dir}`),
      ).map((p: any) => p.id);
    const [asc, desc] = [await ids('asc'), await ids('desc')];
    return JSON.stringify(asc) !== JSON.stringify(desc);
  }
}
