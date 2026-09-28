import { APIRequestContext } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The Blanko VBP-BV flat-fee cutoff — RC 3.14 #3712, commit `520f4d2f8` on `release/3.14.0`
 * (a `Ref #3712` trailer, no PR).
 *
 * A Blanko VO issued ON OR AFTER 30.07.2026 no longer receives the **Versorgungsbezogene
 * Pauschale** one-time flat fee when its first treatment is documented. VOs issued before that
 * date keep it, and nothing is corrected retroactively.
 *
 * ## The whole rule, ported
 *
 * ```php
 * // App\Util\BlankoFlatFeeCutoff
 * const CUTOFF_DATE = '2026-07-30';           // inclusive
 * const CODES = ['VBP-BV', 'VBP-BV-P'];
 * suppresses($t, $issueDate) = $t !== null && $issueDate !== null
 *     && in_array($t->getCode(), CODES, true)
 *     && $issueDate->format('Y-m-d') >= CUTOFF_DATE;
 * ```
 *
 * Four call sites read it: `ActivityFeeService` (the attach), `ActivityRevenueCalculator` and both
 * arms of `RawKpiCalculator` (the money), and `PopulateActivityTreatmentCommand` (re-attach).
 *
 * **The revenue gate is NOT a bare row check, and the difference is the whole of AC4.** On a
 * post-cutoff VO the fee bills only if its `ActivityTreatment` row exists — which the attach no
 * longer creates, so new VOs stop billing it while the ones that already carry a row keep
 * billing it. Applying that row check to every one-time fee would have unbilled 1,311 pre-cutoff
 * pairs (~EUR 25k, 1,230 already invoiced), because a one-time fee is prescribed at VO level and
 * plenty of historical sessions never carried a row for it.
 *
 * ## What staging can and cannot show
 *
 * The gate is only ever reached through `Prescription::getOneTimeFees()`, i.e. through the VO's
 * PRESCRIBED treatments — so a VO that does not prescribe a VBP fee never reaches it. On staging
 * **no VO issued on or after the cutoff prescribes one**, and the newest that does was issued
 * 15.07.2026, a fortnight before the cutoff. AC2/AC3 therefore have no fixture, and the ticket's
 * own PM/QA step produces a false pass (see the spec's FINDING).
 *
 * ## Traps
 *
 *  - **`bv` is absent from the prescription-embedded treatment.** `/treatments` serves it (41 of
 *    141 rows) and so does the `ActivityTreatment` embed, but a VO's `prescribedTreatments[].
 *    treatment` carries only `@id/@type/code/description/tariff*` — so "is this VO Blanko?" read
 *    there is silently always false. Resolve `bv` from the catalogue by code ({@link blankoCodes}).
 *  - **`/activity_treatments` registers only `activity`, `treatment` and `prescription`.** No date
 *    filter and no ordering: `order[id]=desc` is accepted and IGNORED (#3449's shape), and the row
 *    itself carries no date — an attachment is dated through its activity (#3603).
 *  - **`itemsPerPage` caps at 1000 there**, so "fewer than I asked for" is not the last page — and
 *    a 1000-row page hangs up under load, so the walk uses 500 and retries.
 *  - **`date[before]` and `date[after]` are both INCLUSIVE.** `after` being `>=` happens to match
 *    the cutoff's own semantics exactly, but the complement needs `strictly_before`, or the
 *    boundary day is counted twice.
 */

/** `BlankoFlatFeeCutoff::CUTOFF_DATE` — inclusive: a VO issued ON this date is already excluded. */
export const CUTOFF_DATE = '2026-07-30';

/** `BlankoFlatFeeCutoff::CODES` — one row per therapy area: VBP-BV is ERGO, VBP-BV-P is PT. */
export const VBP_CODES = ['VBP-BV', 'VBP-BV-P'] as const;

/** Page size for the attachment walk. 1000 is accepted but hangs up under load; 500 is reliable. */
const AT_PAGE_SIZE = 500;

export type Treatment = {
  id: number;
  code: string;
  description: string;
  kind: string | null;
  area: string | null;
  bv: boolean;
  tariffGkv: number | null;
};

export type PrescriptionRow = {
  id: number;
  prescriptionId: string;
  issueDate: string;
  treatmentStatus: string | null;
  activityCount: number | null;
  totalRevenue: number | null;
  imported: boolean;
  codes: string[];
};

export class BlankoFlatFeeCutoffPage {
  private token: string | null = null;
  private catalogueCache: Treatment[] | null = null;

  constructor(private request: APIRequestContext) {}

  async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  /**
   * A GET with a retry, because the pages this file needs are among the heaviest on staging.
   *
   * `/activity_treatments?itemsPerPage=500` reads out of a ~600k-row table and answers in seconds
   * when staging is quiet and with `socket hang up` when it is not — the documented load signature,
   * not a defect. Without this, a healthy build reports as a failing one.
   */
  private async get<T>(path: string, attempts = 3): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
          timeout: 300_000,
        });
        if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
        return (await res.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
    throw new Error(`GET ${path} failed after ${attempts} attempts: ${String(lastError).slice(0, 200)}`);
  }

  // ───────────────────────────── the ported rule ─────────────────────────────

  /**
   * `BlankoFlatFeeCutoff::suppresses()`.
   *
   * Both boundaries matter and both are the ticket's own ACs: the comparison is `>=`, so a VO
   * issued ON 30.07.2026 is already excluded (AC2) while 29.07.2026 keeps the fee (AC1); and a
   * **null issue date is never suppressed** — absent data must not silently remove a fee.
   */
  static suppresses(code: string | null | undefined, issueDate: string | null | undefined): boolean {
    if (!code || !issueDate) return false;
    if (!(VBP_CODES as readonly string[]).includes(code)) return false;
    return issueDate.slice(0, 10) >= CUTOFF_DATE;
  }

  // ───────────────────────────── catalogue ─────────────────────────────

  async catalogue(): Promise<Treatment[]> {
    if (this.catalogueCache) return this.catalogueCache;
    const body = await this.get<{ member: Record<string, any>[] }>('/treatments?itemsPerPage=1000');
    this.catalogueCache = (body.member ?? []).map((t) => ({
      id: t.id as number,
      code: (t.code as string) ?? '',
      description: (t.description as string) ?? '',
      kind: (t.kind as string) ?? null,
      area: (t.area as string) ?? null,
      bv: Boolean(t.bv),
      tariffGkv: (t.tariffGkv as number) ?? null,
    }));
    return this.catalogueCache;
  }

  async oneTimeFees(): Promise<Treatment[]> {
    return (await this.catalogue()).filter((t) => t.kind === 'one_time_fee');
  }

  /** The two gated treatments, resolved by CODE rather than by a hardcoded id. */
  async vbpTreatments(): Promise<Treatment[]> {
    return (await this.catalogue()).filter((t) => (VBP_CODES as readonly string[]).includes(t.code));
  }

  /** Every catalogue code flagged `bv` — the only reliable "this is a Blanko treatment" source. */
  async blankoCodes(): Promise<Set<string>> {
    return new Set((await this.catalogue()).filter((t) => t.bv).map((t) => t.code));
  }

  // ───────────────────────────── populations ─────────────────────────────

  /** `totalItems` for a `/prescriptions` query, the cheap way to size a population. */
  async total(query: string): Promise<number> {
    const body = await this.get<{ totalItems?: number }>(`/prescriptions?${query}&itemsPerPage=1`);
    return body.totalItems ?? -1;
  }

  /** How many VOs prescribe a treatment, optionally split at the cutoff. */
  async prescribingCount(treatmentId: number, era?: 'pre' | 'post'): Promise<number> {
    const date =
      era === 'post'
        ? `&date%5Bafter%5D=${CUTOFF_DATE}`
        : era === 'pre'
          ? `&date%5Bstrictly_before%5D=${CUTOFF_DATE}`
          : '';
    return this.total(`treatment=${treatmentId}${date}`);
  }

  /** Every VO issued on or after the cutoff, with its prescribed codes. */
  async postCutoffVos(): Promise<PrescriptionRow[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?date%5Bafter%5D=${CUTOFF_DATE}&itemsPerPage=300`,
    );
    return (body.member ?? []).map((x) => ({
      id: x.id as number,
      prescriptionId: (x.prescriptionId as string) ?? '',
      issueDate: ((x.date as string) ?? '').slice(0, 10),
      treatmentStatus: (x.treatmentStatus as string) ?? null,
      activityCount: (x.activityCount as number) ?? null,
      totalRevenue: (x.totalRevenue as number) ?? null,
      imported: Boolean(x.imported),
      codes: ((x.prescribedTreatments as Record<string, any>[]) ?? []).map((pt) => pt?.treatment?.code ?? ''),
    }));
  }

  /** VOs prescribing a treatment, newest issue date first. */
  async prescribingVos(treatmentId: number, limit = 100): Promise<PrescriptionRow[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?treatment=${treatmentId}&order%5Bdate%5D=desc&itemsPerPage=${limit}`,
    );
    return (body.member ?? []).map((x) => ({
      id: x.id as number,
      prescriptionId: (x.prescriptionId as string) ?? '',
      issueDate: ((x.date as string) ?? '').slice(0, 10),
      treatmentStatus: (x.treatmentStatus as string) ?? null,
      activityCount: (x.activityCount as number) ?? null,
      totalRevenue: (x.totalRevenue as number) ?? null,
      imported: Boolean(x.imported),
      codes: ((x.prescribedTreatments as Record<string, any>[]) ?? []).map((pt) => pt?.treatment?.code ?? ''),
    }));
  }

  /**
   * Every `ActivityTreatment` row for the two VBP codes, as `{voId -> attachments}`.
   *
   * `?treatment=<id>` is a registered filter, which is what makes the whole attachment population
   * enumerable in three requests instead of a walk of ~600k rows (#3603's technique). The page
   * cap is 1000, so the ERGO code needs two.
   */
  async vbpAttachments(): Promise<Map<number, { atId: number; code: string; activity: string | null }[]> > {
    const out = new Map<number, { atId: number; code: string; activity: string | null }[]>();
    for (const t of await this.vbpTreatments()) {
      for (let page = 1; page <= 20; page++) {
        const body = await this.get<{ member: Record<string, any>[] }>(
          `/activity_treatments?treatment=${t.id}&itemsPerPage=${AT_PAGE_SIZE}&page=${page}`,
        );
        const rows = body.member ?? [];
        for (const r of rows) {
          const iri = r.prescription as string | undefined;
          if (!iri) continue;
          const voId = Number(iri.split('/').pop());
          const list = out.get(voId) ?? [];
          list.push({ atId: r.id as number, code: r.treatment?.code ?? t.code, activity: (r.activity as string) ?? null });
          out.set(voId, list);
        }
        if (rows.length < AT_PAGE_SIZE) break;
      }
    }
    return out;
  }

  /** The treatment codes actually attached to a VO's sessions, counted. */
  async attachedCodes(prescriptionId: number): Promise<Record<string, number>> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/activities?prescription=${prescriptionId}&itemsPerPage=200`,
    );
    const counts: Record<string, number> = {};
    for (const a of body.member ?? []) {
      for (const at of (a.activityTreatments as Record<string, any>[]) ?? []) {
        const code = at?.treatment?.code;
        if (code) counts[code] = (counts[code] ?? 0) + 1;
      }
    }
    return counts;
  }

  /** The filters this file's counts are built on, proven to partition before any zero is believed. */
  async filtersPartition(): Promise<{
    all: number;
    beforeInclusive: number;
    strictlyBefore: number;
    afterInclusive: number;
    bogus: number;
    atOrderIgnored: boolean;
  }> {
    const [all, beforeInclusive, strictlyBefore, afterInclusive, bogus] = await Promise.all([
      this.total('x=1'),
      this.total(`date%5Bbefore%5D=${CUTOFF_DATE}`),
      this.total(`date%5Bstrictly_before%5D=${CUTOFF_DATE}`),
      this.total(`date%5Bafter%5D=${CUTOFF_DATE}`),
      this.total('zzzNotAFilter=1'),
    ]);
    // `/activity_treatments` registers no ordering, so asc and desc come back identical.
    const vbp = (await this.vbpTreatments())[0];
    const ids = async (dir: string) =>
      (
        await this.get<{ member: Record<string, any>[] }>(
          `/activity_treatments?treatment=${vbp.id}&order%5Bid%5D=${dir}&itemsPerPage=5`,
        )
      ).member.map((x) => x.id as number);
    const [asc, desc] = [await ids('asc'), await ids('desc')];
    return {
      all,
      beforeInclusive,
      strictlyBefore,
      afterInclusive,
      bogus,
      atOrderIgnored: JSON.stringify(asc) === JSON.stringify(desc),
    };
  }
}
