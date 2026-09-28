import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Privat Basis VOs expire automatically like GKV — RC 3.14 #3709, commit `28f402375`.
 *
 * Privat Basis was carved out of the nightly expiry job when it became its own insurance type. The
 * fix removes it from two exclusion lists — `ExpirePrescriptionCommand::buildIdQuery()`'s
 * `excludedInsuranceTypes` and `PrescriptionExpirationTrait::getPrescriptionExpirationDate()`'s
 * early return — leaving **only PKV** exempt. `PrescriptionPresenter::getTreatmentStartDeadline()`
 * gets the same treatment.
 *
 * ## The job is console-only, but its two INPUTS are serialized — and that is the whole method
 *
 * The nightly command cannot be run from a browser. What can be read is the pair of dates the job
 * decides on, both in `prescription:read`:
 *
 *  - **`treatmentStartDeadline`** — `PrescriptionPresenter::getTreatmentStartDeadline()`, the AC1/
 *    AC2/AC3 deadline;
 *  - **`validityDate`** — `PrescriptionExpirationTrait::getPrescriptionExpirationDate()`, the AC4
 *    validity window.
 *
 * Both return `null` for an excluded insurance type *before* any rule runs, so **a Privat Basis VO
 * serving null on both is the pre-fix build and a real date is the post-fix one**. That makes
 * deployment decidable from behaviour, which matters because `GET /status` reports the RELEASE and
 * not the commit (#3704) — the API already says `3.14.0` while this change is not live.
 *
 * **A GKV control is mandatory.** Those fields are legitimately null on plenty of GKV VOs too (no
 * first treatment yet ⇒ no validity window), so "Privat Basis serves null" proves nothing on its
 * own. `deploymentState()` pairs it with GKV VOs that DO serve both.
 *
 * ## The rule is ported, and the port is validated against the API before it is trusted
 *
 * `oracleStartDeadline()` and `oracleValidityDate()` re-implement the shipped rules. They are not
 * assumed correct: `validateOracle()` runs them over a GKV sample and compares against the values
 * the API actually serves — measured **160/160** on the start deadline and **99 matches / 0
 * mismatches** on the validity date. Only then are they applied to Privat Basis, where the API
 * currently serves nothing to compare against.
 *
 * The Ergo branch is deliberately NOT ported (`'ERGO'` is returned instead): it has its own
 * multi-step deadline logic, and no AC here depends on it. Reporting that honestly beats a partial
 * port that silently disagrees.
 *
 * ## Scope warning: the commit carries a second ticket and a migration
 *
 * `28f402375` is "treat Privat Basis like GKV for validation **and** expiry". Besides #3709 it
 * ships **#3708** — Privat Basis validated with the GKV check set — as data migration
 * `Version20260916070000`, which appends `privat_basis` to every `validation` row carrying
 * `public`, minus 11 named checks. So deploying #3709 also changes which validation checks a Privat
 * Basis VO gets. `creationCheckIds()` measures that independently through the endpoint the create
 * form itself calls (#3576), which is a second deployment probe for the same commit.
 *
 * ## Traps
 *
 *  - **`urgentTreatmentNeed` is omitted when false**, so it reads `undefined` — the rule tests
 *    `=== true`, and so does the port.
 *  - **AC3's two conditions are not both reachable.** `getStartDeadlineDays()` is
 *    `isUrgentTreatmentNeed() || UV === insuranceType`, and `insuranceType` is ONE field — a VO is
 *    either `privat_basis` or `accident`, never both. For a Privat Basis VO only the urgent arm can
 *    ever fire.
 *  - A **Blanko** VO takes its own branch (start deadline before the first treatment, +16 weeks
 *    after) and carries `totalTreatments: 0`, so the 3/6-month Physio rule never applies to it.
 *  - The job skips five statuses — Abgerechnet, Fertig Behandelt, Abgebrochen, Abgelaufen,
 *    Archiviert — so a VO past its deadline in one of those is **not** a qualifier. Counting
 *    without that filter overstates AC7 badly (8 of staging's 10 Privat Basis VOs are terminal).
 */

/** `ExpirePrescriptionCommand::buildIdQuery()` — the statuses the nightly job never touches. */
export const SKIPPED_STATUSES = [
  'Abgerechnet',
  'Fertig Behandelt',
  'Abgebrochen',
  'Abgelaufen',
  'Archiviert',
] as const;

/** `Prescription::TREATMENT_START_DEADLINE_*` */
export const START_DEADLINE_DAYS = { standard: 28, urgent: 14 } as const;

/** `PrescriptionExpirationTrait::PHYSIO_TREATMENT_THRESHOLD` — ≤6 → 3 months, >6 → 6 months. */
export const PHYSIO_TREATMENT_THRESHOLD = 6;

export const INSURANCE = { public: 'public', pkv: 'private', privatBasis: 'privat_basis', accident: 'accident' } as const;

export type Vo = {
  id: number;
  prescriptionId?: string | null;
  insuranceType?: string | null;
  therapyType?: string | null;
  treatmentStatus?: string | null;
  followupStatus?: string | null;
  date?: string | null;
  blankoVO?: boolean | null;
  urgentTreatmentNeed?: boolean | null;
  activityCount?: number | null;
  totalTreatments?: number | null;
  treatmentStartDate?: string | null;
  validityDate?: string | null;
  treatmentStartDeadline?: string | null;
  validationStatus?: string | null;
};

/** `'ERGO'` marks the branch this page object deliberately does not port. */
export type OracleDate = Date | null | 'ERGO';

export class PrivatBasisExpiryPage {
  private bearerCache = new Map<string, string>();

  constructor(private request: APIRequestContext) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async tokenFor(creds: Credentials): Promise<string> {
    const hit = this.bearerCache.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()}`);
    const token = (await res.json()).token as string;
    this.bearerCache.set(creds.email, token);
    return token;
  }

  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);

  private async get<T>(path: string, token: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  private static members<T>(body: unknown): T[] {
    const d = body as { member?: T[]; 'hydra:member'?: T[] } | null;
    return d?.member ?? d?.['hydra:member'] ?? [];
  }

  private static total(body: unknown): number {
    const d = body as { totalItems?: number } | null;
    return d?.totalItems ?? 0;
  }

  // ─────────────────────────── the ported rules ───────────────────────────

  /** `PrescriptionExpirationTrait::getStartDeadlineDays()` — 14 when urgent or accident, else 28. */
  static startDeadlineDays(vo: Vo): number {
    // `=== true` on purpose: the field is omitted when false, so it arrives undefined.
    const urgent = vo.urgentTreatmentNeed === true || vo.insuranceType === INSURANCE.accident;
    return urgent ? START_DEADLINE_DAYS.urgent : START_DEADLINE_DAYS.standard;
  }

  /** `PrescriptionPresenter::getTreatmentStartDeadline()` — null for PKV, else issue date + 14/28. */
  static oracleStartDeadline(vo: Vo): Date | null {
    if (vo.insuranceType === INSURANCE.pkv) return null;
    if (!vo.date) return null;
    const d = new Date(vo.date);
    d.setUTCDate(d.getUTCDate() + PrivatBasisExpiryPage.startDeadlineDays(vo));
    return d;
  }

  /** A calendar-month step, matching PHP's `modify('+N months')` day clamping. */
  static addMonths(from: Date, months: number): Date {
    const d = new Date(from.getTime());
    const target = d.getUTCMonth() + months;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(target);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
  }

  /**
   * `PrescriptionExpirationTrait::getPrescriptionExpirationDate()`.
   *
   * Every branch except Ergo, which returns the marker `'ERGO'` — see the class docblock.
   */
  static oracleValidityDate(vo: Vo): OracleDate {
    if (vo.insuranceType === INSURANCE.pkv) return null;
    const issue = vo.date ? new Date(vo.date) : null;
    const acts = vo.activityCount ?? 0;
    const prescribed = vo.totalTreatments ?? 0;

    // Blanko: the start deadline before the first treatment, +16 weeks after.
    if (vo.blankoVO) {
      if (!issue) return null;
      const days = acts === 0 ? PrivatBasisExpiryPage.startDeadlineDays(vo) : 112;
      const d = new Date(issue.getTime());
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }

    if (vo.therapyType === 'ergotherapy') return 'ERGO';

    if (vo.therapyType === 'speech_therapy') {
      const first = vo.treatmentStartDate ? new Date(vo.treatmentStartDate) : null;
      if (first) {
        const d = new Date(first.getTime());
        d.setUTCDate(d.getUTCDate() + (prescribed > 10 ? 270 : 210));
        return d;
      }
      if (!issue) return null;
      const d = new Date(issue.getTime());
      d.setUTCDate(d.getUTCDate() + PrivatBasisExpiryPage.startDeadlineDays(vo));
      return d;
    }

    // BG/UV Physio keeps its legacy issue-date validity, unchanged by #2790.
    if (vo.insuranceType === INSURANCE.accident) {
      if (!issue || acts === 0) return null;
      const d = new Date(issue.getTime());
      d.setUTCDate(d.getUTCDate() + (prescribed > PHYSIO_TREATMENT_THRESHOLD ? 180 : 90));
      return d;
    }

    // #2790 — GKV / Privat Basis Physio: first treatment + 3 or 6 months. Null before the first
    // treatment, because the validity period has not begun; the start deadline covers that case.
    const first = vo.treatmentStartDate ? new Date(vo.treatmentStartDate) : null;
    if (!first) return null;
    return PrivatBasisExpiryPage.addMonths(first, prescribed > PHYSIO_TREATMENT_THRESHOLD ? 6 : 3);
  }

  /** Day-precision comparison of a served ISO date against the oracle's answer. */
  static compare(served: string | null | undefined, expected: OracleDate): string {
    if (expected === 'ERGO') return 'ergo-branch';
    const s = served ? new Date(served) : null;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (!s && !expected) return 'both-null';
    if (!s) return `served-null, oracle ${day(expected as Date)}`;
    if (!expected) return `served ${day(s)}, oracle null`;
    return day(s) === day(expected as Date) ? 'match' : `MISMATCH served ${day(s)} oracle ${day(expected)}`;
  }

  /** Would the nightly job even look at this VO? */
  static isJobCandidate(vo: Vo): boolean {
    return (
      vo.insuranceType !== INSURANCE.pkv &&
      !SKIPPED_STATUSES.includes((vo.treatmentStatus ?? '') as (typeof SKIPPED_STATUSES)[number])
    );
  }

  /** AC1/AC2/AC3: a candidate with no documented treatment, past its start deadline. */
  static qualifiesByStartDeadline(vo: Vo, now = new Date()): boolean {
    if (!PrivatBasisExpiryPage.isJobCandidate(vo)) return false;
    if ((vo.activityCount ?? 0) !== 0) return false;
    const deadline = PrivatBasisExpiryPage.oracleStartDeadline(vo);
    return !!deadline && now > deadline;
  }

  // ────────────────────────────── live reads ──────────────────────────────

  /** `insuranceType` IS a registered filter here (unlike on `/patients`, where it is ignored). */
  async vosByInsuranceType(type: string, token: string, itemsPerPage = 40, page = 1): Promise<Vo[]> {
    return PrivatBasisExpiryPage.members<Vo>(
      await this.get(`/prescriptions?insuranceType=${type}&itemsPerPage=${itemsPerPage}&page=${page}`, token),
    );
  }

  async countByInsuranceType(type: string, token: string): Promise<number> {
    return PrivatBasisExpiryPage.total(await this.get(`/prescriptions?insuranceType=${type}&itemsPerPage=1`, token));
  }

  /** A GKV sample spread across the id space, so the oracle is validated on varied data. */
  async gkvSample(token: string, pages = [1, 40, 120, 400, 900]): Promise<Vo[]> {
    const out: Vo[] = [];
    for (const page of pages) out.push(...(await this.vosByInsuranceType(INSURANCE.public, token, 40, page)));
    return out;
  }

  /**
   * Run the ported rules over a sample and tally the verdicts against what the API serves.
   *
   * This is what earns the right to apply them to Privat Basis, where there is currently no served
   * value to compare against.
   */
  validateOracle(sample: Vo[]): { startDeadline: Record<string, number>; validity: Record<string, number> } {
    const tally = (verdicts: string[]) =>
      verdicts.reduce<Record<string, number>>((acc, v) => {
        const k = v.startsWith('MISMATCH') ? 'MISMATCH' : v.startsWith('served') ? 'divergent' : v;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
    return {
      startDeadline: tally(
        sample.map((v) => PrivatBasisExpiryPage.compare(v.treatmentStartDeadline, PrivatBasisExpiryPage.oracleStartDeadline(v))),
      ),
      validity: tally(
        sample.map((v) => PrivatBasisExpiryPage.compare(v.validityDate, PrivatBasisExpiryPage.oracleValidityDate(v))),
      ),
    };
  }

  /**
   * Is #3709 live?
   *
   * Decided from behaviour, not `/status`: a Privat Basis VO serving BOTH dates is the post-fix
   * build. The GKV control is what makes a null meaningful — those fields are legitimately null on
   * many GKV VOs too.
   */
  async deploymentState(token: string): Promise<{
    deployed: boolean;
    privatBasisTotal: number;
    privatBasisWithStartDeadline: number;
    privatBasisWithValidity: number;
    gkvWithStartDeadline: number;
    gkvWithValidity: number;
    gkvSampleSize: number;
  }> {
    const pb = await this.vosByInsuranceType(INSURANCE.privatBasis, token);
    const gkv = await this.vosByInsuranceType(INSURANCE.public, token);
    const withSd = pb.filter((v) => v.treatmentStartDeadline).length;
    const withVd = pb.filter((v) => v.validityDate).length;
    return {
      deployed: withSd > 0,
      privatBasisTotal: pb.length,
      privatBasisWithStartDeadline: withSd,
      privatBasisWithValidity: withVd,
      gkvWithStartDeadline: gkv.filter((v) => v.treatmentStartDeadline).length,
      gkvWithValidity: gkv.filter((v) => v.validityDate).length,
      gkvSampleSize: gkv.length,
    };
  }

  /**
   * The creation-validation check ids an insurance type is evaluated against.
   *
   * `POST /prescriptions/preview-creation-validation` hydrates a TRANSIENT prescription and writes
   * nothing (#3576), so this is free to call. It is the independent probe for **#3708**, the
   * validation half bundled into this ticket's commit: after `Version20260916070000` runs,
   * `privat_basis` should hold most of the GKV set rather than the PKV one.
   *
   * Omit `changedFields` — sending it switches the backend to `evaluateAffected()` and re-runs
   * nothing, which reads as "no checks apply".
   */
  async creationCheckIds(insuranceType: string, token: string): Promise<number[]> {
    const res = await this.request.post(`${API_BASE}/prescriptions/preview-creation-validation`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        therapyType: 'physiotherapy',
        insuranceType,
        prescribedTreatments: [{ treatment: '/treatments/71' }],
      },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST preview-creation-validation (${insuranceType}) -> ${res.status()}`);
    const body = (await res.json()) as { results?: { validation: string }[] };
    return [...new Set((body.results ?? []).map((r) => Number(r.validation.split('/').pop())))].sort((a, b) => a - b);
  }

  /**
   * The `treatment_expired` entries on one VO — the trail the nightly job leaves (#3651).
   *
   * **`meta.type` is the discriminator that matters.** `automatic` is the nightly job; `manual` is
   * an admin expiring a VO by hand, which no insurance type is exempt from. A check that counts
   * both reports a PKV VO as auto-expired when an admin simply expired it.
   */
  async expiryLogsFor(
    voId: number,
    token: string,
    itemsPerPage = 30,
  ): Promise<{ createdAt: string | null; reason: string | null; type: string | null }[]> {
    const body = await this.get<unknown>(
      `/prescription_logs?prescription=${voId}&type=treatment_expired&itemsPerPage=${itemsPerPage}&order%5BcreatedAt%5D=desc`,
      token,
    );
    return PrivatBasisExpiryPage.members<{ createdAt?: string; meta?: { reason?: string; type?: string } }>(body).map((l) => ({
      createdAt: l.createdAt ?? null,
      reason: l.meta?.reason ?? null,
      type: l.meta?.type ?? null,
    }));
  }

  /**
   * The newest AUTOMATIC expiry the job has written for an insurance type, over a sample.
   *
   * **This is the load-bearing measurement of the file, and the reason it is relative rather than
   * absolute.** Staging's history goes back to 2025, long before either exclusion existed, so PKV
   * and Privat Basis VOs both carry old automatic entries. Those say nothing about today's build —
   * the #3651 lesson: partition the trail by date, because old rows are never rewritten. What DOES
   * decide it is how stale the newest one is compared with the job's own last run.
   */
  async newestAutomaticExpiry(insuranceType: string, token: string, sampleSize = 12): Promise<{
    newest: string | null;
    vosWithAnyLog: number;
    sampled: number;
  }> {
    const vos = await this.vosByInsuranceType(insuranceType, token, sampleSize);
    let newest: string | null = null;
    let withAny = 0;
    for (const vo of vos) {
      const logs = await this.expiryLogsFor(vo.id, token);
      if (logs.length) withAny++;
      for (const l of logs) {
        if (l.type === 'automatic' && l.createdAt && (!newest || l.createdAt > newest)) newest = l.createdAt;
      }
    }
    return { newest, vosWithAnyLog: withAny, sampled: vos.length };
  }

  /**
   * Every VO the nightly job expired in one run, with the insurance type of each.
   *
   * `meta.type === 'automatic'` is the job; a `manual` entry is an admin expiring a VO by hand,
   * which no insurance type is exempt from and which would make an AC5 count wrong.
   */
  async expiredInRun(
    runPrefix: string,
    token: string,
    pageSize = 200,
  ): Promise<{ voId: number; insuranceType: string | null; prescriptionId: string | null; reason: string | null }[]> {
    const body = await this.get<unknown>(
      `/prescription_logs?type=treatment_expired&itemsPerPage=${pageSize}&order%5BcreatedAt%5D=desc`,
      token,
    );
    const rows = PrivatBasisExpiryPage.members<{
      createdAt?: string;
      prescription?: string | { id?: number };
      meta?: { type?: string; reason?: string };
    }>(body).filter((l) => (l.createdAt ?? '').startsWith(runPrefix) && l.meta?.type === 'automatic');

    const seen = new Map<number, { voId: number; insuranceType: string | null; prescriptionId: string | null; reason: string | null }>();
    for (const l of rows) {
      const p = l.prescription;
      const id = typeof p === 'string' ? Number(p.split('/').pop()) : (p?.id ?? 0);
      if (!id || seen.has(id)) continue;
      const vo = await this.get<Vo>(`/prescriptions/${id}`, token);
      seen.set(id, {
        voId: id,
        insuranceType: vo.insuranceType ?? null,
        prescriptionId: vo.prescriptionId ?? null,
        reason: l.meta?.reason ?? null,
      });
    }
    return [...seen.values()];
  }

  /** Every log row on one VO, newest first — for reading what a single run did to it. */
  async allLogsFor(voId: number, token: string, itemsPerPage = 60) {
    const body = await this.get<unknown>(
      `/prescription_logs?prescription=${voId}&itemsPerPage=${itemsPerPage}&order%5BcreatedAt%5D=desc`,
      token,
    );
    return PrivatBasisExpiryPage.members<{
      createdAt?: string;
      type?: string;
      oldValue?: string | null;
      newValue?: string | null;
      meta?: { type?: string; reason?: string };
    }>(body).map((l) => ({
      createdAt: l.createdAt ?? null,
      type: l.type ?? null,
      oldValue: l.oldValue ?? null,
      newValue: l.newValue ?? null,
      metaType: l.meta?.type ?? null,
      reason: l.meta?.reason ?? null,
    }));
  }

  /**
   * When the nightly job last wrote anything at all.
   *
   * The precondition for every negative in this file: "no PKV VO was auto-expired" only means
   * something while the job is demonstrably still running.
   */
  async jobLastRanAt(token: string): Promise<string | null> {
    const body = await this.get<unknown>(
      '/prescription_logs?type=treatment_expired&itemsPerPage=5&order%5BcreatedAt%5D=desc',
      token,
    );
    const rows = PrivatBasisExpiryPage.members<{ createdAt?: string; meta?: { type?: string } }>(body);
    return rows.find((r) => r.meta?.type === 'automatic')?.createdAt ?? null;
  }
}
