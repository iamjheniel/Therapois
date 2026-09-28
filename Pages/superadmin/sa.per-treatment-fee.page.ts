import { Page, expect } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * A per-treatment fee removed from a day's session must stop being billed (RC 3.12 #3484).
 *
 * Both revenue engines used to bill every fee on `Prescription::getPerTreatmentFees()` once per
 * VO per day unconditionally, so deleting the fee's `ActivityTreatment` row from a session left
 * the VO's total, its invoice, the KPI figures and the exports all reporting a fee the session no
 * longer shows — Stefan's VO 6330-7, rows 363,30 EUR against a total of 387,30 EUR.
 *
 * The fix (`838538240`, PR #3498, `release/3.12.0`) makes a fee bill **once per VO per (UTC) day,
 * on the first same-day countable session that still carries the fee's `ActivityTreatment`**, in
 * both engines. Two carve-outs matter for any assertion written against live data:
 *
 * - **A session with NO `ActivityTreatment` rows at all keeps the unconditional behaviour**
 *   (pre-AT legacy data), mirroring the prescribedTreatments fallback beside it. So "the fee has
 *   no AT on this day" is NOT the same predicate as "the fee is dropped" — a day whose only
 *   session carries no AT at all still bills every prescribed fee.
 * - **One-time fees and the copayment walk are untouched**, which is why AC6 is asserted by
 *   watching the one-time fee line survive a per-treatment fee's removal, and why a GKV copayment
 *   invoice is the wrong surface for AC2 (its amount is not the VO's revenue).
 *
 * ## The oracle
 *
 * `expectedRevenue()` is a faithful port of `ActivityRevenueCalculator::calculatePrescriptionBreakdowns()`
 * and takes a `mode`, so the same VO can be priced under the **pre-fix** rule (fee billed once a
 * day regardless) and the **post-fix** rule (fee billed only while carried). Comparing both
 * against the served `totalRevenue` is what decides deployment from outside — a version string
 * cannot, and on a VO with no removed fee the two predictions are identical, which is precisely
 * why VO 6330-7 no longer discriminates on its own (every session carries HBH-PT again today).
 *
 * The port has to reproduce three things exactly or it reports false mismatches:
 *
 * | rule | why it matters |
 * |---|---|
 * | countable = NOT (rejected AND !rejectedWithSignature) AND treatmentType != `planned` | 6330-7 has 7 activities and an `activityCount` of 5; the two rejected ones still carry their HBH-PT rows |
 * | treatment lines price at the AT's `resolvedTariff`, fee lines price from the price HISTORY at the session date | `PrescriptionPresenter` builds a **resolver-less** calculator, so a fee has no snapshot to read and resolves level 2 from the entity graph |
 * | one-time fee attaches to the VO's **lowest-id** countable activity | `$activities` is ordered by date, not id |
 *
 * ## Traps
 *
 * - **`/activity_treatments` is full CRUD** (`Delete` is `ROLE_ADMIN`), and that is the only way
 *   to reproduce the ticket: PATCHing an activity's `treatments` array cannot remove a fee —
 *   `ActivityTreatmentsProcessor::updateActivityTreatments()` diffs **treatment-kind rows only**,
 *   "exclude fees so they survive the diff".
 * - **The removal is self-restoring, and that is not luck.** `ActivityTreatmentPriceListener::prePersist`
 *   resolves and persists `resolvedTariff` on creation, so a re-POSTed fee row comes back with the
 *   same price at the same date; only the row id changes. `resolvedTariff` is read-only over the
 *   API (`activity_treatment:read`), so it cannot be written directly — the listener is the
 *   mechanism, and without it a restore would leave a priceless row behind.
 * - **A fee AT's own `resolvedTariff` does not price the fee.** The engines read the fee's price
 *   from the tariff/price-history at the session date; the AT row is consulted only for
 *   EXISTENCE. Asserting on the row's number instead of the VO total tests nothing.
 * - **KPI reads are cached ~5 minutes** (#3401), so a mutation is not visible in
 *   `/kpis/management/billing-backlog` straight away. AC3 is therefore asserted as SQL-vs-PHP
 *   parity across the whole backlog rather than as a live delta.
 */

export const API = 'https://api.staging.therapios.de';

/** `Treatment.kind`, as the API serialises it. */
export const KIND = {
  TREATMENT: 'treatment',
  PER_TREATMENT_FEE: 'per_treatment_fee',
  ONE_TIME_FEE: 'one_time_fee',
} as const;

/** Which tariff column an insurance type prices from. */
export const TARIFF_FOR_INSURANCE: Record<string, string> = {
  public: 'GKV',
  private: 'PRIVAT',
  privat_basis: 'PRIVAT_BASIS',
  accident: 'BG',
  beihilfe: 'BEIHILFE',
};

export type SessionTreatment = {
  /** The `ActivityTreatment` row id — what a removal deletes. */
  id: number;
  treatmentId: number;
  code: string;
  kind: string;
  quantity: number;
  /** The snapshotted price. Load-bearing for treatment rows, ignored for fee rows. */
  resolvedTariff: number | null;
};

export type Session = {
  id: number;
  /** `YYYY-MM-DD`, the day the once-per-day fee key is built from. */
  date: string;
  countable: boolean;
  rejected: boolean;
  rejectedWithSignature: boolean;
  treatmentType: string | null;
  treatments: SessionTreatment[];
};

export type PrescribedRow = { treatmentId: number; code: string; kind: string };

export type VoSnapshot = {
  id: number;
  vo: string;
  insuranceType: string | null;
  treatmentStatus: string | null;
  blankoVO: boolean;
  doubleTreatment: boolean;
  doubleTreatmentV2: boolean;
  /** The API's own count of countable sessions — the cross-check on the port's filter. */
  activityCount: number;
  /** `PrescriptionPresenter::getTotalRevenue()`, i.e. the PHP engine. */
  totalRevenue: number | null;
  activeInvoice: { id: number; number: string; status: string; amount: number | null } | null;
  billingBatchCount: number;
  prescribed: PrescribedRow[];
  sessions: Session[];
};

export type RevenueLine = { activityId: number; date: string; code: string; kind: string; amount: number };
export type RevenueResult = { total: number; lines: RevenueLine[]; blankoSkipped?: boolean };

/** A day the fix stops billing: a prescribed fee with no carrier on any countable session. */
export type RemovedFeeDay = {
  date: string;
  code: string;
  treatmentId: number;
  /** What the day loses — the fee's tariff resolved at that date. */
  amount: number;
  sessionIds: number[];
};

type PriceEntry = { effectiveDate: string; price: number; changedAt: string };

export class PerTreatmentFeePage {
  static readonly API = API;

  private token: string | null = null;
  private tariffByCode = new Map<string, Record<string, number | null>>();
  private historyByCode = new Map<string, Record<string, PriceEntry[]>>();

  constructor(private page: Page) {}

  // ──────────────────────────────── session ──────────────────────────────────

  /** API-only entry: a bearer token, tolerating a spent `.auth` storageState. */
  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  /** For the few probes that call an endpoint this class does not wrap (the Optica export). */
  authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async json(path: string, timeout = 120_000): Promise<any> {
    const res = await this.page.request.get(`${API}${path}`, { headers: this.auth(), timeout });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ───────────────────────────── price catalogue ─────────────────────────────

  /**
   * The tariff columns and the full price history, which the oracle needs to price a fee line the
   * way a resolver-less `ActivityRevenueCalculator` does (level 2 from the entity graph, level 3
   * from the Treatment's own tariff column).
   */
  async loadPriceCatalogue(): Promise<void> {
    if (this.tariffByCode.size) return;
    const idToCode = new Map<number, string>();
    for (let page = 1; ; page++) {
      const rows = PerTreatmentFeePage.members(await this.json(`/treatments?page=${page}&itemsPerPage=200`));
      if (!rows.length) break;
      for (const t of rows) {
        idToCode.set(t.id, t.code);
        this.tariffByCode.set(t.code, {
          GKV: t.tariffGkv ?? null,
          PRIVAT: t.tariffPrivat ?? null,
          PRIVAT_BASIS: t.tariffPrivatBasis ?? null,
          BG: t.tariffBg ?? null,
          BEIHILFE: t.tariffBeihilfe ?? null,
        });
      }
      if (rows.length < 200) break;
    }

    for (let page = 1; ; page++) {
      const rows = PerTreatmentFeePage.members(
        await this.json(`/treatment_price_histories?page=${page}&itemsPerPage=1000`),
      );
      if (!rows.length) break;
      for (const e of rows) {
        const code = idToCode.get(Number(String(e.treatment).split('/').pop()));
        if (!code) continue;
        const byTariff = this.historyByCode.get(code) ?? {};
        (byTariff[e.tariffType] ??= []).push({
          effectiveDate: String(e.effectiveDate).slice(0, 10),
          price: e.price,
          changedAt: String(e.changedAt ?? ''),
        });
        this.historyByCode.set(code, byTariff);
      }
      if (rows.length < 1000) break;
    }
  }

  /**
   * `ActivityRevenueCalculator::resolveTariff()` without a resolver: the newest price-history
   * entry of the insurance's tariff type effective on or before the session date (ties broken on
   * the later `changedAt`, matching `findLatestActiveEntry()`), else the Treatment's own column.
   */
  priceAt(code: string, insuranceType: string | null, date: string): number {
    const tariffType = TARIFF_FOR_INSURANCE[insuranceType ?? ''] ?? 'GKV';
    const entries = (this.historyByCode.get(code)?.[tariffType] ?? [])
      .filter((e) => e.effectiveDate <= date)
      .sort((a, b) =>
        a.effectiveDate === b.effectiveDate
          ? a.changedAt.localeCompare(b.changedAt)
          : a.effectiveDate.localeCompare(b.effectiveDate),
      );
    if (entries.length) return entries[entries.length - 1].price;
    return this.tariffByCode.get(code)?.[tariffType] ?? 0;
  }

  // ──────────────────────────────── reading ──────────────────────────────────

  /** Everything a revenue assertion needs about one VO, in two calls. */
  async voSnapshot(prescriptionId: number): Promise<VoSnapshot> {
    const p = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    const light = await this.json(`/prescriptions/${prescriptionId}`);
    const activities = PerTreatmentFeePage.members(
      await this.json(`/activities?page=1&itemsPerPage=200&prescription=${prescriptionId}&order%5Bdate%5D=asc`),
    );
    return {
      id: p.id,
      vo: p.prescriptionId,
      insuranceType: p.insuranceType ?? null,
      treatmentStatus: p.treatmentStatus ?? null,
      blankoVO: !!light.blankoVO,
      doubleTreatment: !!light.doubleTreatment,
      doubleTreatmentV2: !!light.doubleTreatmentV2,
      activityCount: p.activityCount ?? 0,
      totalRevenue: p.totalRevenue ?? null,
      activeInvoice: p.invoice
        ? {
            id: p.invoice.id,
            number: p.invoice.invoiceNumber,
            status: p.invoice.status,
            amount: p.invoice.invoiceAmount ?? null,
          }
        : null,
      billingBatchCount: p.billingBatchCount ?? 0,
      prescribed: (light.prescribedTreatments ?? [])
        .map((pt: any) => pt.treatment)
        .filter(Boolean)
        .map((t: any) => ({ treatmentId: t.id ?? Number(String(t['@id']).split('/').pop()), code: t.code, kind: t.kind })),
      sessions: activities.map((a: any) => PerTreatmentFeePage.toSession(a)),
    };
  }

  static toSession(activity: any): Session {
    const rejected = !!activity.rejectedTreatment;
    const rejectedWithSignature = !!activity.rejectedTreatmentWithSignature;
    const treatmentType = activity.treatmentType ?? null;
    return {
      id: activity.id,
      date: String(activity.date ?? '').slice(0, 10),
      // The exact filter `calculatePrescriptionBreakdowns()` applies before pricing anything.
      countable: !(rejected && !rejectedWithSignature) && 'planned' !== treatmentType,
      rejected,
      rejectedWithSignature,
      treatmentType,
      treatments: (activity.activityTreatments ?? []).map((at: any) => ({
        id: at.id ?? Number(String(at['@id'] ?? '').split('/').pop()),
        treatmentId: at.treatment?.id ?? Number(String(at.treatment?.['@id'] ?? '').split('/').pop()),
        code: at.treatment?.code ?? '?',
        kind: at.treatment?.kind ?? '?',
        quantity: at.quantity ?? 1,
        resolvedTariff: at.resolvedTariff ?? null,
      })),
    };
  }

  perTreatmentFees(vo: VoSnapshot): PrescribedRow[] {
    return vo.prescribed.filter((p) => KIND.PER_TREATMENT_FEE === p.kind);
  }

  oneTimeFees(vo: VoSnapshot): PrescribedRow[] {
    return vo.prescribed.filter((p) => KIND.ONE_TIME_FEE === p.kind);
  }

  // ──────────────────────────────── the oracle ───────────────────────────────

  /**
   * A port of `calculatePrescriptionBreakdowns()`, priced either way.
   *
   * `mode: 'post'` is the #3484 rule (a fee bills only while a countable session that day carries
   * its AT); `mode: 'pre'` is what shipped before it (once per day, unconditionally). Blanko VOs
   * return `blankoSkipped` rather than a number — BV duration pricing is a different branch and
   * is deliberately out of this port's scope.
   */
  expectedRevenue(vo: VoSnapshot, mode: 'post' | 'pre' = 'post'): RevenueResult {
    const valid = vo.sessions.filter((s) => s.countable);
    if (!valid.length) return { total: 0, lines: [] };
    if (vo.blankoVO && valid.some((s) => s.treatments.length)) return { total: NaN, lines: [], blankoSkipped: true };

    const multiplier = vo.doubleTreatment && !vo.doubleTreatmentV2 ? 2 : 1;
    const fees = this.perTreatmentFees(vo);
    const oneTime = this.oneTimeFees(vo);
    const prescribedTreatments = vo.prescribed.filter((p) => KIND.TREATMENT === p.kind);
    // One-time fees belong to the VO's first-EVER activity, and `$activities` is date-ordered,
    // not id-ordered — the engine takes the minimum id, so this does too.
    const firstEverId = Math.min(...valid.map((s) => s.id));

    const feeBilled = new Set<string>();
    let oneTimeBilled = false;
    const lines: RevenueLine[] = [];
    let total = 0;

    for (const session of valid) {
      if (session.treatments.length) {
        for (const at of session.treatments) {
          if (KIND.TREATMENT !== at.kind) continue;
          const price = at.resolvedTariff ?? this.priceAt(at.code, vo.insuranceType, session.date);
          const amount = price * at.quantity * multiplier;
          total += amount;
          lines.push({ activityId: session.id, date: session.date, code: at.code, kind: 'treatment', amount });
        }
      } else {
        for (const pt of prescribedTreatments) {
          const amount = this.priceAt(pt.code, vo.insuranceType, session.date) * multiplier;
          total += amount;
          lines.push({ activityId: session.id, date: session.date, code: pt.code, kind: 'treatment', amount });
        }
      }

      if (fees.length) {
        const isLegacySession = 0 === session.treatments.length;
        for (const fee of fees) {
          const key = `${vo.id}:${session.date}:${fee.treatmentId}`;
          if (feeBilled.has(key)) continue;
          const carried = session.treatments.some((at) => at.treatmentId === fee.treatmentId);
          if ('post' === mode && !isLegacySession && !carried) continue;
          feeBilled.add(key);
          const amount = this.priceAt(fee.code, vo.insuranceType, session.date);
          total += amount;
          lines.push({ activityId: session.id, date: session.date, code: fee.code, kind: KIND.PER_TREATMENT_FEE, amount });
        }
      }

      if (oneTime.length && !oneTimeBilled && session.id === firstEverId) {
        oneTimeBilled = true;
        for (const fee of oneTime) {
          const amount = this.priceAt(fee.code, vo.insuranceType, session.date);
          total += amount;
          lines.push({ activityId: session.id, date: session.date, code: fee.code, kind: KIND.ONE_TIME_FEE, amount });
        }
      }
    }

    return { total: Math.round(total * 100) / 100, lines };
  }

  /**
   * The days the fix stops billing: a prescribed per-treatment fee with no carrier row on ANY
   * countable session of that day, and no legacy (AT-less) session there either.
   */
  removedFeeDays(vo: VoSnapshot): RemovedFeeDay[] {
    const fees = this.perTreatmentFees(vo);
    if (!fees.length) return [];
    const byDay = new Map<string, Session[]>();
    for (const session of vo.sessions.filter((s) => s.countable)) {
      byDay.set(session.date, [...(byDay.get(session.date) ?? []), session]);
    }
    const out: RemovedFeeDay[] = [];
    for (const [date, sessions] of byDay) {
      if (sessions.some((s) => 0 === s.treatments.length)) continue; // legacy arm bills regardless
      for (const fee of fees) {
        if (sessions.some((s) => s.treatments.some((at) => at.treatmentId === fee.treatmentId))) continue;
        out.push({
          date,
          code: fee.code,
          treatmentId: fee.treatmentId,
          amount: this.priceAt(fee.code, vo.insuranceType, date),
          sessionIds: sessions.map((s) => s.id),
        });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Fee rows a session documents that the VO does NOT prescribe.
   *
   * Nothing bills these: the engines read per-treatment fees from
   * `Prescription::getPerTreatmentFees()` only, and the per-session loop skips every row whose
   * kind is not `treatment`. So a session showing `HBH-E 17,97` while the VO prescribes `HB-E`
   * contributes no fee at all once #3484 stops billing the unmatched prescribed one.
   */
  foreignFeeRows(vo: VoSnapshot): { date: string; sessionId: number; row: SessionTreatment }[] {
    const prescribed = new Set(this.perTreatmentFees(vo).map((f) => f.treatmentId));
    return vo.sessions
      .filter((s) => s.countable)
      .flatMap((s) =>
        s.treatments
          .filter((t) => KIND.PER_TREATMENT_FEE === t.kind && !prescribed.has(t.treatmentId))
          .map((row) => ({ date: s.date, sessionId: s.id, row })),
      );
  }

  /** The first countable session carrying a given fee — the row a repro deletes. */
  feeCarrier(vo: VoSnapshot, code: string): { session: Session; row: SessionTreatment } | null {
    for (const session of vo.sessions.filter((s) => s.countable)) {
      const row = session.treatments.find((at) => at.code === code);
      if (row) return { session, row };
    }
    return null;
  }

  /** Days holding more than one countable session — AC5's once-per-day case. */
  sameDayGroups(vo: VoSnapshot): Map<string, Session[]> {
    const byDay = new Map<string, Session[]>();
    for (const s of vo.sessions.filter((x) => x.countable)) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
    return new Map([...byDay].filter(([, sessions]) => sessions.length > 1));
  }

  // ──────────────────────────────── writing ──────────────────────────────────

  /**
   * The ticket's reproduction: remove a fee from one day's session.
   *
   * `DELETE /activity_treatments/{id}` is the ONLY path — see the class docs on why an Activity
   * PATCH cannot do it. `ROLE_ADMIN` gated.
   */
  async removeFee(activityTreatmentId: number): Promise<number> {
    const res = await this.page.request.delete(`${API}/activity_treatments/${activityTreatmentId}`, {
      headers: this.auth(),
      timeout: 120_000,
    });
    return res.status();
  }

  /**
   * Puts the row back. The new row carries a fresh id but the same price: `prePersist` resolves
   * `resolvedTariff` from the session's own date, and the field is not writable over the API.
   */
  async restoreFee(input: { treatmentId: number; activityId: number; prescriptionId: number }): Promise<{
    status: number;
    id: number | null;
    resolvedTariff: number | null;
  }> {
    const res = await this.page.request.post(`${API}/activity_treatments`, {
      headers: { ...this.auth(), 'Content-Type': 'application/ld+json' },
      data: {
        treatment: `/treatments/${input.treatmentId}`,
        activity: `/activities/${input.activityId}`,
        prescription: `/prescriptions/${input.prescriptionId}`,
      },
      timeout: 120_000,
    });
    const body = await res.json().catch(() => ({}) as any);
    return { status: res.status(), id: body?.id ?? null, resolvedTariff: body?.resolvedTariff ?? null };
  }

  /** Regenerates a `not_sent` draft in place — the AC2 surface (#3332 AC2). */
  async regenerateInvoice(prescriptionId: number): Promise<number> {
    const res = await this.page.request.post(`${API}/prescriptions/${prescriptionId}/generate-invoice`, {
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      data: {},
      timeout: 180_000,
    });
    return res.status();
  }

  // ───────────────────────────────── the KPIs ────────────────────────────────

  /**
   * Per-VO treated revenue as the **SQL** engine computes it
   * (`RawKpiCalculator::calculateLifetimeRevenueByPrescription`), read off the Abrechnungs-Stau
   * drill-down — the one client-reachable surface that reports a KPI revenue figure per VO.
   *
   * Note the ~5-minute server cache on the KPI reads (#3401): this is a parity surface, not a
   * live delta one.
   */
  async backlogRevenueByPrescription(): Promise<Map<number, number>> {
    const body = await this.json('/kpis/management/billing-backlog', 180_000);
    const root = PerTreatmentFeePage.members(body)[0] ?? body;
    const out = new Map<number, number>();
    for (const team of root.teams ?? []) {
      for (const therapist of team.therapists ?? []) {
        for (const vo of therapist.prescriptions ?? []) out.set(vo.prescriptionId, vo.revenue);
      }
    }
    return out;
  }
}
