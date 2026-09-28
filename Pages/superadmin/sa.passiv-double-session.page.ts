import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * A passive Heilmittel on a double session must be billed ONCE (RC 3.12 #3647).
 *
 * #3603 made `passiv` catalogue items (AEB, AEB-BV) billable at all; #3602 made the doubling
 * per-session. Their intersection was wrong: `ActivityRevenueCalculator` applied the double-session
 * `$multiplier` to passive rows too, so an assessment attached to a doubled session was counted
 * twice — in the VO total, the Optica export quantity, the PKV invoice and KPI revenue. The fix
 * drops the multiplier for `TreatmentKind::PASSIVE` only, leaving the treatment doubling and the
 * fee-once rules alone.
 *
 * ## The best oracle here is the export file, not a revenue model
 *
 * A Blanko VO prices its treatment lines by DURATION on a separate branch, so re-implementing the
 * calculator to predict a total means porting that branch too. The `.rz` Optica export sidesteps it
 * entirely by stating quantities outright:
 *
 * ```
 * rz2|<vo>|03|54003|1,00|49,65|49,65|…|Analyse ergoth. Bedarf (BV)   ← position, QUANTITY, unit, sum
 * rz1|<vo>|01|01.07.2026|173|2,00|…                                   ← treatment daily line, doubled
 * rz1|<vo>|03|01.07.2026|173|1,00|…                                   ← passive daily line, ONCE
 * ```
 *
 * `rz2` is one line per position (quantity = units billed across the whole VO) and `rz1` is one line
 * per position per treatment date. Together they answer AC3 directly and, because the same
 * calculator feeds every surface, they corroborate AC1/AC4/AC5 without modelling any pricing.
 *
 * **`GET /billing_batches/{id}/optica-export` works on a `complete_and_sent` batch.** Every earlier
 * spec in this suite records the export as unreachable (422) — that was measured on *pending*
 * batches only, where the #3288 readiness check legitimately blocks it. A sent batch returns 200 and
 * an ISO-8859-1 body. That correction is why AC3 is testable at all.
 *
 * ## Traps
 *
 * - **The file is ISO-8859-1, not UTF-8** ("Logopädie", "Antoniuskirhcstr."). Decode it explicitly;
 *   a UTF-8 read mangles the description column the assertions match on.
 * - **Numbers are German-formatted** — `1,00`, `49,65`, `312,72`. Parse on the comma.
 * - **`activity.doubleTreatment` is unreliable as a falsy read**: it arrives as `true`, as `false`,
 *   or omitted entirely on the same VO. Only `true === a.doubleTreatment` is safe.
 * - A passive row on a NON-double session was always billed once, so it proves nothing — the
 *   population that matters is `passiv attachment ∧ session marked double`.
 */

/** The ticket's fixtures. */
export const FIXTURES = {
  /** GKV Blanko Ergo VO; 17 Jul 2026 session is double with an AEB-BV attached. */
  blanko: { vo: '7080-2', prescriptionId: 29506, doubleDate: '2026-07-17', singleDate: '2026-07-16' },
  /** Logopädie VO whose 01 Jul 2026 session is double with an AEB-BV; sits in a SENT batch. */
  exported: { vo: '7048-4', prescriptionId: 30235, doubleDate: '2026-07-01' },
  /** The sent GKV batch carrying `exported`. */
  batch: { batchId: 'S-2026-216-002', id: 50 },
} as const;

/**
 * VO 7080-2's totals, as measured on either side of the deploy.
 *
 * The 2026-09-05 figure was recorded by this suite's #3603 run before the fix shipped; the 09-07
 * figure is what the API serves now. They differ by exactly the AEB-BV price, which is the whole
 * ticket in one number.
 */
export const BLANKO_TOTALS = { passivDoubled: 2888.8, passivOnce: 2839.15, aebBv: 49.65 } as const;

/** AC1/AC2's per-session figures for VO 7080-2. */
export const BLANKO_SESSIONS = { double: 257.42, doublePreFix: 307.07, single: 112.87 } as const;

export const PASSIV = 'passiv';
export const FEE_KINDS = new Set(['one_time_fee', 'per_treatment_fee']);

export type Row = { code: string; kind: string; tariff: number; quantity: number };

export type Session = {
  id: number;
  date: string;
  /** Only `true` counts — the field is sometimes `false`, sometimes absent. */
  double: boolean;
  countable: boolean;
  durationMinutes: number | null;
  rows: Row[];
  treatmentLines: number;
  feeLines: number;
  passivLines: number;
};

/** One `rz2` position line: the per-VO summary for a Heilmittel. */
export type ExportPosition = {
  vo: string;
  index: string;
  positionNumber: string;
  quantity: number;
  unitPrice: number;
  total: number;
  description: string;
};

/** One `rz1` line: a position on a specific treatment date. */
export type ExportDailyLine = { vo: string; index: string; date: string; quantity: number };

export type OpticaExport = {
  status: number;
  raw: string;
  positions: ExportPosition[];
  daily: ExportDailyLine[];
  /** The `rze` trailer's total. */
  total: number | null;
};

export class PassivDoubleSessionPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3647: no bearer token');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string, timeout = 180_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, { headers: this.headers(), timeout });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(4_000);
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? (Array.isArray(body) ? body : []);
  }

  /** German decimal → number: `1.234,56` → 1234.56. */
  static num(s: string): number {
    return Number(String(s).replace(/\./g, '').replace(',', '.'));
  }

  // ──────────────────────────────── VO + sessions ────────────────────────────────

  async voTotal(prescriptionId: number): Promise<{ vo: string; totalRevenue: number | null; blankoVO: boolean; insuranceType: string | null; invoice: { number: string; status: string; amount: number | null } | null }> {
    const p = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    const light = await this.json(`/prescriptions/${prescriptionId}`);
    const inv = p.invoice ?? null;
    return {
      vo: p.prescriptionId,
      totalRevenue: p.totalRevenue ?? null,
      blankoVO: !!light.blankoVO,
      insuranceType: p.insuranceType ?? null,
      invoice: inv ? { number: inv.invoiceNumber, status: inv.status, amount: inv.invoiceAmount ?? null } : null,
    };
  }

  /** The VO's sessions in the shape the validation page reads them (`pagination=false`, date order). */
  async sessions(prescriptionId: number): Promise<Session[]> {
    const rows = PassivDoubleSessionPage.members(
      await this.json(`/activities?pagination=false&order%5Bdate%5D=asc&prescription=${prescriptionId}`),
    );
    return rows.map((a: any) => {
      const parsed: Row[] = (a.activityTreatments ?? []).map((t: any) => ({
        code: t.treatment?.code ?? '?',
        kind: t.treatment?.kind ?? '',
        tariff: t.resolvedTariff ?? 0,
        quantity: t.quantity ?? 1,
      }));
      const sum = (pred: (r: Row) => boolean) => parsed.filter(pred).reduce((n, r) => n + r.tariff * r.quantity, 0);
      return {
        id: a.id,
        date: String(a.date ?? '').slice(0, 10),
        double: true === a.doubleTreatment,
        countable: !(a.rejectedTreatment && !a.rejectedTreatmentWithSignature) && 'planned' !== a.treatmentType,
        durationMinutes: a.treatmentDuration ?? null,
        rows: parsed,
        treatmentLines: sum((r) => !FEE_KINDS.has(r.kind) && PASSIV !== r.kind),
        feeLines: sum((r) => FEE_KINDS.has(r.kind)),
        passivLines: sum((r) => PASSIV === r.kind),
      };
    });
  }

  /**
   * Solves the VO's per-session treatment price from its own total, so a Blanko VO's duration-based
   * pricing never has to be modelled.
   *
   * With `T` the price of one countable session's treatment content, the served total under the
   * FIXED rule is `Σ(T × mult) + Σfees + Σpassiv`; the two rules differ only by the passive lines on
   * doubled sessions, a constant. So solving for `T` under each rule and reporting both lets a test
   * say which one the API is running without pricing a single Heilmittel.
   */
  static solveTreatmentPrice(sessions: Session[], served: number, opts: { passivDoubled: boolean }): number {
    const countable = sessions.filter((s) => s.countable);
    const multSum = countable.reduce((n, s) => n + (s.double ? 2 : 1), 0);
    const fees = countable.reduce((n, s) => n + s.feeLines, 0);
    const passiv = countable.reduce((n, s) => n + s.passivLines * (opts.passivDoubled && s.double ? 2 : 1), 0);
    return (served - fees - passiv) / multSum;
  }

  /** What the VO total would be if passive lines were doubled on doubled sessions. */
  static passivOnDoubleSessions(sessions: Session[]): number {
    return sessions.filter((s) => s.countable && s.double).reduce((n, s) => n + s.passivLines, 0);
  }

  // ──────────────────────────────── the .rz export ────────────────────────────────

  /**
   * The Optica export for a batch, parsed.
   *
   * Works on a `complete_and_sent` batch; a `pending` one answers 422 from the #3288 readiness
   * check, which is why this returns the status rather than throwing.
   */
  async opticaExport(batchId: number): Promise<OpticaExport> {
    const res = await this.page.request.get(`${API_BASE}/billing_batches/${batchId}/optica-export`, {
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 240_000,
    });
    if (200 !== res.status()) return { status: res.status(), raw: '', positions: [], daily: [], total: null };
    // The file is ISO-8859-1; decoding it as UTF-8 mangles the German descriptions.
    const raw = new TextDecoder('iso-8859-1').decode(await res.body());
    const positions: ExportPosition[] = [];
    const daily: ExportDailyLine[] = [];
    let total: number | null = null;
    for (const line of raw.split(/\r?\n/)) {
      const f = line.split('|');
      if ('rz2' === f[0] && f.length > 7) {
        positions.push({
          vo: f[1],
          index: f[2],
          positionNumber: f[3],
          quantity: PassivDoubleSessionPage.num(f[4]),
          unitPrice: PassivDoubleSessionPage.num(f[5]),
          total: PassivDoubleSessionPage.num(f[6]),
          description: f[13] ?? '',
        });
      } else if ('rz1' === f[0] && f.length > 5) {
        daily.push({ vo: f[1], index: f[2], date: f[3], quantity: PassivDoubleSessionPage.num(f[5]) });
      } else if ('rze' === f[0] && f.length > 3) {
        total = PassivDoubleSessionPage.num(f[3]);
      }
    }
    return { status: 200, raw, positions, daily, total };
  }

  /** Batches, so a test can pick a sent one rather than assume the export is unreachable. */
  async batches(): Promise<{ id: number; batchId: string; status: string; therapyType: string | null }[]> {
    const out: any[] = [];
    for (let page = 1; page <= 5; page++) {
      const rows = PassivDoubleSessionPage.members(await this.json(`/billing_batches?itemsPerPage=100&page=${page}`));
      out.push(...rows);
      if (0 === rows.length || out.length >= 400) break;
    }
    return out.map((b: any) => ({ id: b.id, batchId: b.batchId, status: b.status, therapyType: b.therapyType ?? null }));
  }

  async batchByBatchId(batchId: string): Promise<{ id: number; status: string } | null> {
    const hit = PassivDoubleSessionPage.members(await this.json(`/billing_batches?batchId=${encodeURIComponent(batchId)}`))[0];
    return hit ? { id: hit.id, status: hit.status } : null;
  }

  // ─────────────────────────── population + deployed bundle ───────────────────────────

  /** Every passive attachment, flagged with whether its session is a double one. */
  async passivOnDoubleSessions(): Promise<{ at: number; code: string; vo: string | null; date: string | null; double: boolean; insuranceType: string | null; blankoVO: boolean; tariff: number | null }[]> {
    const catalogue = PassivDoubleSessionPage.members(await this.json('/treatments?itemsPerPage=200'));
    const passiv = catalogue.filter((t: any) => PASSIV === t.kind);
    const out: any[] = [];
    const cache = new Map<string, { light: any; billing: any; acts: Map<string, any> }>();
    for (const t of passiv) {
      for (const r of PassivDoubleSessionPage.members(await this.json(`/activity_treatments?treatment=${t.id}&itemsPerPage=200`))) {
        const presc: string | null = r.prescription ?? null;
        if (!presc || !r.activity) {
          out.push({ at: r.id, code: t.code, vo: null, date: null, double: false, insuranceType: null, blankoVO: false, tariff: r.resolvedTariff ?? null });
          continue;
        }
        if (!cache.has(presc)) {
          const id = presc.split('/').pop();
          cache.set(presc, {
            light: await this.json(presc),
            billing: await this.json(`${presc}?groups%5B%5D=billing%3Aread`),
            acts: new Map(
              PassivDoubleSessionPage.members(
                await this.json(`/activities?pagination=false&order%5Bdate%5D=asc&prescription=${id}`),
              ).map((a: any) => [String(a['@id']), a]),
            ),
          });
        }
        const c = cache.get(presc)!;
        const a = c.acts.get(String(r.activity));
        out.push({
          at: r.id,
          code: t.code,
          vo: c.billing.prescriptionId ?? null,
          date: a ? String(a.date ?? '').slice(0, 10) : null,
          double: !!a && true === a.doubleTreatment,
          insuranceType: c.billing.insuranceType ?? null,
          blankoVO: !!c.light.blankoVO,
          tariff: r.resolvedTariff ?? null,
        });
      }
    }
    return out;
  }

  /**
   * The served app bundle, for the client half of AC1.
   *
   * `expandDoubleTreatmentRows` renders the second row of a double session by cloning the first and
   * dropping some kinds. Before the fix that exclusion list was `['one_time_fee','per_treatment_fee']`
   * — passive rows were cloned, so the validation page displayed the assessment twice. After, it
   * reads `['one_time_fee','per_treatment_fee','passiv']`.
   */
  async entryBundle(): Promise<string> {
    const html = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3647: no entry bundle in the served HTML');
    return await (await this.page.request.get(`https://staging.therapios.de${src}`, { timeout: 180_000 })).text();
  }
}
