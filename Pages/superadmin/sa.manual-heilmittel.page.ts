import { Page } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS } from '../util/api-token';
import { KIND, PerTreatmentFeePage, Session, VoSnapshot } from './sa.per-treatment-fee.page';

/**
 * Manually attached Heilmittel must be billed everywhere the validation view shows them
 * (RC 3.12 #3603).
 *
 * A handful of catalogue items exist so an admin can attach them to a documented session during
 * billing review rather than being auto-attached — AEB (Analyse des ergotherapeutischen Bedarfs)
 * and its Blanko twin AEB-BV. They carry `kind: "passiv"`, and both revenue engines skipped them:
 * `ActivityRevenueCalculator`'s loop did `if (TreatmentKind::TREATMENT !== $treatment->getKind())
 * continue;` and `RawKpiCalculator`'s SQL filtered `treatment.kind = 'treatment'`. The line showed,
 * priced, on the session row while the VO total, the PKV invoice, the Optica export and KPI revenue
 * all omitted it. The fix widens both filters to include `passiv`; a separate console command
 * (`app:treatment:correct-aeb-bv-catalog`) does AC9's catalogue correction.
 *
 * **The population is tiny and completely enumerable, which is what makes this ticket testable.**
 * `/activity_treatments?treatment=<id>` is a registered filter, so every attachment of every passiv
 * code can be listed out of all ~455k rows in three requests. On staging that is **12 rows** — 9
 * AEB, 3 AEB-BV, 0 KT-H-BV — over 10 VOs. Every assertion here ranges over the whole population
 * rather than a sample.
 *
 * ## How each AC is decided
 *
 * - **AC1/AC4 by a DUAL ORACLE, not by reading the total.** `expectedRevenue()` is a port of
 *   `calculatePrescriptionBreakdowns()` whose only parameter is whether `passiv` rows count.
 *   Priced both ways, a VO carrying an attachment must match the POST-fix number and differ from
 *   the PRE-fix one. Reading the served total alone proves nothing: for VO 1762-28 the pre-fix
 *   figure is 1.035,25 — exactly what the ticket quotes — and the post-fix figure is what the API
 *   now returns, so only the pair identifies which rule is running.
 * - **AC5/AC9 by re-deriving the price.** `PerTreatmentFeePage.priceAt()` already implements
 *   `resolveTariff()` — the newest price-history entry of the VO's tariff type effective on or
 *   before the session date, else the catalogue column. Every attachment's stored `resolvedTariff`
 *   is checked against it. That single rule settles both ACs, including AC9's date split, because
 *   the catalogue correction shipped as a **price-history row** (GKV 49,65 effective 2026-07-01)
 *   rather than an overwrite.
 *
 * ## Traps
 *
 * - **`GET /activities/{id}` is 404** — the resource declares no item Get (see #3398). An
 *   attachment is dated by walking its VO's `/activities?prescription=` collection, never by
 *   fetching the activity directly; doing the latter costs three timeouts per row.
 * - **`resolvedTariff` is a SNAPSHOT taken when the row was created**, not a live lookup. So a
 *   price-resolution fix applies to NEW attachments only, and a row written before it keeps its old
 *   number — which is exactly how the finding below is visible.
 * - **Do not price AEB-BV from the catalogue column alone.** Its GKV tariff now reads 49,65, but
 *   two of the three live rows are dated before 2026-07-01 and correctly hold 47,69. Comparing
 *   against `tariffGkv` reports two false mismatches; the price history is the rule.
 * - **`billingBatchCount` is OMITTED, not zero**, on these VOs, so "is it batched" cannot be read
 *   off it.
 * - Prescribing a passiv item and attaching one are unrelated: **1.203 VOs list AEB in
 *   `prescribedTreatments`** while only 9 sessions in the whole database carry an AEB row. That gap
 *   is AC7's evidence, and it also means `?treatment=` on `/prescriptions` answers a different
 *   question from `?treatment=` on `/activity_treatments`.
 */

/** `Treatment.kind` for the manually-attached-only items this ticket is about. */
export const PASSIV = 'passiv';

/** The ticket's reproduction VO: ergo, PKV, AEB attached to a documented session. */
export const REPRO = { vo: '1762-28', prescriptionId: 29059 } as const;

/**
 * The pre-fix total the ticket quotes for the repro VO — 5x MFB-E 67,79 + 5x SPB-E 91,26 +
 * 10x HBH-E 24,00. Everything except the passiv lines.
 */
export const REPRO_PRE_FIX_TOTAL = 1035.25;

/** AC9's catalogue correction, as it must read after the command has run. */
export const AEB_BV_CORRECTED = { code: 'AEB-BV', positionNumber: '54003', gkvPrice: 49.65, effectiveFrom: '2026-07-01' } as const;

export type Attachment = {
  /** `ActivityTreatment` id. */
  id: number;
  code: string;
  treatmentId: number;
  /** The stored price. */
  resolvedTariff: number | null;
  calculatedTariff: number | null;
  quantity: number;
  /** `null` when the row carries no prescription link — see the finding in the spec. */
  prescriptionIri: string | null;
  activityIri: string | null;
  vo: string | null;
  insuranceType: string | null;
  blankoVO: boolean | null;
  /** The session's date, resolved through the VO's activity collection. */
  date: string | null;
};

export class ManualHeilmittelPage {
  /** Reused wholesale for auth, the price catalogue, `priceAt()`, `voSnapshot()` and the KPI read. */
  readonly fees: PerTreatmentFeePage;

  constructor(private page: Page) {
    this.fees = new PerTreatmentFeePage(page);
  }

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await this.fees.connect(credentials);
    await this.fees.loadPriceCatalogue();
  }

  private async json(path: string, timeout = 120_000): Promise<any> {
    const res = await this.page.request.get(`https://api.staging.therapios.de${path}`, {
      headers: this.fees.authHeader(),
      timeout,
    });
    if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}`);
    return await res.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ─────────────────────────────── the catalogue ───────────────────────────────

  private catalogue: any[] = [];

  async loadCatalogue(): Promise<any[]> {
    if (!this.catalogue.length) this.catalogue = ManualHeilmittelPage.members(await this.json('/treatments?itemsPerPage=200'));
    return this.catalogue;
  }

  /** Every `passiv` item — the exact set whose exclusion this ticket removes. */
  passivTreatments(): { id: number; code: string; positionNumber: string | null; tariffGkv: number | null; tariffPrivat: number | null }[] {
    return this.catalogue
      .filter((t) => PASSIV === t.kind)
      .map((t) => ({
        id: t.id,
        code: t.code,
        positionNumber: t.positionNumber ?? null,
        tariffGkv: t.tariffGkv ?? null,
        tariffPrivat: t.tariffPrivat ?? null,
      }));
  }

  treatment(code: string): any | null {
    return this.catalogue.find((t) => t.code === code) ?? null;
  }

  /** The price-history rows for one code, as AC9's correction writes them. */
  async priceHistory(treatmentId: number): Promise<{ id: number; tariffType: string; effectiveDate: string; price: number; changedAt: string }[]> {
    const rows = ManualHeilmittelPage.members(await this.json(`/treatment_price_histories?treatment=${treatmentId}&itemsPerPage=200`));
    return rows.map((r: any) => ({
      id: r.id,
      tariffType: r.tariffType,
      effectiveDate: String(r.effectiveDate).slice(0, 10),
      price: r.price,
      changedAt: String(r.changedAt ?? ''),
    }));
  }

  // ───────────────────────────── the whole population ─────────────────────────────

  /**
   * Every attachment of every passiv code, joined to its VO and session date.
   *
   * Three collection reads plus one per distinct VO. The date comes from the VO's activity
   * collection because the activity item route does not exist.
   */
  async passivAttachments(): Promise<Attachment[]> {
    await this.loadCatalogue();
    const out: Attachment[] = [];
    const rawByCode: { code: string; treatmentId: number; rows: any[] }[] = [];
    for (const t of this.passivTreatments()) {
      rawByCode.push({
        code: t.code,
        treatmentId: t.id,
        rows: ManualHeilmittelPage.members(await this.json(`/activity_treatments?treatment=${t.id}&itemsPerPage=200`)),
      });
    }

    const prescCache = new Map<string, any>();
    const dateCache = new Map<string, Map<string, string>>();
    for (const { code, treatmentId, rows } of rawByCode) {
      for (const r of rows) {
        const presc: string | null = r.prescription ?? null;
        let p: any = {};
        if (presc) {
          if (!prescCache.has(presc)) prescCache.set(presc, await this.json(`${presc}?groups%5B%5D=billing%3Aread`));
          p = prescCache.get(presc);
          if (!dateCache.has(presc)) {
            const acts = ManualHeilmittelPage.members(
              await this.json(`/activities?page=1&itemsPerPage=200&prescription=${presc.split('/').pop()}&order%5Bdate%5D=asc`),
            );
            dateCache.set(presc, new Map(acts.map((a: any) => [String(a['@id']), String(a.date ?? '').slice(0, 10)])));
          }
        }
        out.push({
          id: r.id,
          code,
          treatmentId,
          resolvedTariff: r.resolvedTariff ?? null,
          calculatedTariff: r.calculatedTariff ?? null,
          quantity: r.quantity ?? 1,
          prescriptionIri: presc,
          activityIri: r.activity ?? null,
          vo: p.prescriptionId ?? null,
          insuranceType: p.insuranceType ?? null,
          blankoVO: presc ? !!p.blankoVO : null,
          date: presc && r.activity ? (dateCache.get(presc)?.get(String(r.activity)) ?? null) : null,
        });
      }
    }
    return out;
  }

  /** The distinct VOs carrying at least one passiv attachment. */
  static prescriptionIdsOf(attachments: Attachment[]): number[] {
    return [...new Set(attachments.filter((a) => a.prescriptionIri).map((a) => Number(a.prescriptionIri!.split('/').pop())))];
  }

  // ──────────────────────────────── the dual oracle ────────────────────────────────

  /**
   * `calculatePrescriptionBreakdowns()` with the kind filter as the only variable.
   *
   * `includePassiv: false` is the pre-fix engine (`kind === 'treatment'` only); `true` is the fix.
   * Fees ride their own path in both, unchanged, so this differs from
   * `PerTreatmentFeePage.expectedRevenue()` in exactly one predicate — which is the point.
   */
  expectedRevenue(vo: VoSnapshot, opts: { includePassiv: boolean }): { total: number; passivTotal: number } {
    const countable = vo.sessions.filter((s: Session) => s.countable);
    const multiplier = vo.doubleTreatment && !vo.doubleTreatmentV2 ? 2 : 1;
    const fees = this.fees.perTreatmentFees(vo);
    const oneTime = this.fees.oneTimeFees(vo);
    const prescribedTreatments = vo.prescribed.filter((p) => KIND.TREATMENT === p.kind);
    const firstEverId = countable.length ? Math.min(...countable.map((s) => s.id)) : -1;

    const feeBilled = new Set<string>();
    let oneTimeBilled = false;
    let total = 0;
    let passivTotal = 0;

    for (const session of countable) {
      if (session.treatments.length) {
        for (const at of session.treatments) {
          const isPassiv = PASSIV === at.kind;
          if (KIND.TREATMENT !== at.kind && !isPassiv) continue;
          if (isPassiv && !opts.includePassiv) continue;
          const price = at.resolvedTariff ?? this.fees.priceAt(at.code, vo.insuranceType, session.date);
          // A passiv line is never doubled — it is not a treatment unit.
          const amount = price * at.quantity * (isPassiv ? 1 : multiplier);
          total += amount;
          if (isPassiv) passivTotal += amount;
        }
      } else {
        for (const pt of prescribedTreatments) {
          total += this.fees.priceAt(pt.code, vo.insuranceType, session.date) * multiplier;
        }
      }

      for (const fee of fees) {
        const key = `${vo.id}:${session.date}:${fee.treatmentId}`;
        if (feeBilled.has(key)) continue;
        const isLegacySession = 0 === session.treatments.length;
        const carried = session.treatments.some((at) => at.treatmentId === fee.treatmentId);
        if (!isLegacySession && !carried) continue;
        feeBilled.add(key);
        total += this.fees.priceAt(fee.code, vo.insuranceType, session.date);
      }

      if (oneTime.length && !oneTimeBilled && session.id === firstEverId) {
        oneTimeBilled = true;
        for (const fee of oneTime) total += this.fees.priceAt(fee.code, vo.insuranceType, session.date);
      }
    }
    return { total: Math.round(total * 100) / 100, passivTotal: Math.round(passivTotal * 100) / 100 };
  }

  /** The price `resolveTariff()` should have produced for one attachment. */
  expectedPrice(a: Attachment): number | null {
    if (!a.insuranceType || !a.date) return null;
    return this.fees.priceAt(a.code, a.insuranceType, a.date);
  }

  async voSnapshot(prescriptionId: number): Promise<VoSnapshot> {
    return await this.fees.voSnapshot(prescriptionId);
  }

  /** Per-VO revenue from the SQL engine — AC4's surface. */
  async kpiRevenueByPrescription(): Promise<Map<number, number>> {
    return await this.fees.backlogRevenueByPrescription();
  }

  /** AC3's export, which staging cannot serve — every batch answers 422 (see #3288). */
  async opticaExport(batchId: number): Promise<{ status: number; body: string }> {
    const res = await this.page.request.get(`https://api.staging.therapios.de/billing_batches/${batchId}/optica-export`, {
      headers: this.fees.authHeader(),
      timeout: 120_000,
    });
    return { status: res.status(), body: (await res.text()).slice(0, 400) };
  }

  async pendingBatchIds(limit = 8): Promise<number[]> {
    const rows = ManualHeilmittelPage.members(await this.json(`/billing_batches?status=pending&itemsPerPage=${limit}`));
    return rows.map((b: any) => b.id);
  }

  /** How many VOs merely PRESCRIBE a code — AC7's contrast with how many have it attached. */
  async prescribingVoCount(treatmentId: number): Promise<number> {
    return (await this.json(`/prescriptions?treatment=${treatmentId}&itemsPerPage=1`)).totalItems ?? 0;
  }

  async prescription(prescriptionId: number): Promise<any> {
    return await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
  }

  async prescriptionLight(prescriptionId: number): Promise<any> {
    return await this.json(`/prescriptions/${prescriptionId}`);
  }
}
