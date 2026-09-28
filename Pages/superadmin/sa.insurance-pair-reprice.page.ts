import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Insurance-type corrections reprice across EVERY pair (RC 3.13 #3562).
 *
 * #3535 built confirm-and-reprice for PKV <-> Privat Basis only; #3562 widens the guard to every
 * pair and adds a validation-status reset. **#3535's repricing never actually ran**, and this file
 * exists partly to prove it now does: the guard compared the changeset value with
 * `instanceof InsuranceTypeEnum`, but Doctrine hands back the BACKING STRING, so it was false on
 * every correction and the pass was skipped silently. Fixed in `be7b69c53`, whose docblock cites
 * this suite's own diagnostic on VO 4355-1 verbatim.
 *
 * **The evidence is a straddling fixture, not a total.** VO **4355-1** has three PNF sessions either
 * side of the PRIVAT_BASIS price step on **2025-07-01** (44,15 → 47,69 → 45,92 → 45,92 → 47,06), so
 * it separates the three things a reprice can do:
 * - priced at each session's OWN date → 47,69 / 45,92 / 45,92 (correct, AC1's "not today's date");
 * - priced at today → 47,06 three times;
 * - not repriced at all → the old PKV 61,95 three times.
 * Reading the VO's total cannot tell these apart — `Gesamtumsatz` moves anyway, because a VO's
 * revenue is snapshotted treatment lines PLUS a live fee calculation, and only the fee half follows
 * the current type. That is the #3535 false pass. **Read `ActivityTreatment.resolvedTariff`.**
 *
 * **AC5's reset leaves a distinctive trace** — a `validation_status_change` log with reason
 * "Validation reset after an insurance-type correction" — so whether it has ever fired is a
 * read-only question. It also only fires when the VO's billing `validationStatus` is non-null.
 */

export type SessionTariff = { date: string; code: string; resolvedTariff: number | null };
export type PriceStep = { effectiveDate: string; price: number };

/** The straddling fixture named in the fix's own docblock. */
export const FIXTURE = { number: '4355-1', prescriptionId: 5314, treatmentCode: 'PNF', treatmentId: 54, step: '2025-07-01' };

/** What each session must read if it was priced at its own treatment date. */
export const EXPECTED_BY_DATE: Record<string, number> = {
  '2025-06-26': 47.69,
  '2025-07-03': 45.92,
  '2025-07-10': 45.92,
};

/** The reason string the AC5 reset stamps on its log. */
export const RESET_REASON = 'Validation reset after an insurance-type correction';

/** Every pair #3562 must cover; #3535 handled only the first. */
export const PAIRS = [
  ['private', 'privat_basis'],
  ['public', 'private'],
  ['public', 'privat_basis'],
  ['accident', 'public'],
  ['accident', 'private'],
  ['accident', 'privat_basis'],
] as const;

export class InsurancePairRepricePage {
  private bearer: string | null = null;

  constructor(private request: APIRequestContext, token?: string) {
    this.bearer = token ?? null;
  }

  private async auth(): Promise<string> {
    if (this.bearer) return this.bearer;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.bearer = (await res.json()).token;
    return this.bearer!;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.auth();
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  /** The VO under the billing group — insurance type, validation status, active invoice. */
  async prescription(id: number): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(`/prescriptions/${id}?groups%5B%5D=billing:read`);
  }

  /**
   * Every session's `resolvedTariff` — the ONLY column that separates a real reprice from the
   * live-fee movement that made #3535 look fixed when it was not.
   */
  async sessionTariffs(prescriptionId: number, code?: string): Promise<SessionTariff[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/activities?prescription=${prescriptionId}&itemsPerPage=100`,
    );
    const out: SessionTariff[] = [];
    for (const a of body.member) {
      for (const at of a.activityTreatments ?? []) {
        const c = at.treatment?.code ?? '?';
        if (code && c !== code) continue;
        out.push({ date: String(a.date ?? '').slice(0, 10), code: c, resolvedTariff: at.resolvedTariff ?? null });
      }
    }
    return out.sort((x, y) => x.date.localeCompare(y.date));
  }

  /** One tariff's price ladder, oldest first. */
  async priceLadder(treatmentId: number, tariffType: string): Promise<PriceStep[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/treatment_price_histories?treatment=${treatmentId}&itemsPerPage=100`,
    );
    return body.member
      .filter((m) => m.tariffType === tariffType)
      .map((m) => ({ effectiveDate: String(m.effectiveDate ?? '').slice(0, 10), price: m.price }))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  }

  /** The price in force on a given day — the rule AC1 demands ("not today's date"). */
  priceOn(ladder: PriceStep[], isoDay: string): number | null {
    let price: number | null = null;
    for (const step of ladder) if (step.effectiveDate <= isoDay) price = step.price;
    return price;
  }

  /** Whether AC5's reset has ever fired, and on which VOs. */
  async validationResets(): Promise<{ at: string; prescriptionId: string; from: string | null; reason: string }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      '/prescription_logs?type=validation_status_change&itemsPerPage=800&order%5BcreatedAt%5D=desc',
    );
    return body.member
      .filter((l) => String(l.reason ?? '').includes('insurance-type correction'))
      .map((l) => ({
        at: String(l.createdAt ?? '').slice(0, 19),
        prescriptionId: String(l.prescription ?? '').split('/').pop() ?? '',
        from: l.oldValue ?? null,
        reason: String(l.reason ?? ''),
      }));
  }

  /** Insurance-type changes on one VO, oldest first — the correction trail. */
  async insuranceChanges(prescriptionId: number): Promise<{ at: string; from: string | null; to: string | null }[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescription_logs?prescription=${prescriptionId}&type=field_change&itemsPerPage=100&order%5BcreatedAt%5D=asc`,
    );
    const types = new Set(['public', 'private', 'privat_basis', 'accident']);
    return body.member
      .filter((l) => types.has(String(l.oldValue)) && types.has(String(l.newValue)))
      .map((l) => ({ at: String(l.createdAt ?? '').slice(0, 19), from: l.oldValue ?? null, to: l.newValue ?? null }));
  }

  /** How many VOs sit in each insurance type — the fixture pool for the untested pairs. */
  async countByInsuranceType(type: string): Promise<number> {
    const body = await this.get<{ totalItems: number }>(`/prescriptions?insuranceType=${type}&itemsPerPage=1`);
    return body.totalItems;
  }

  async bundle(): Promise<string> {
    const html = await (await this.request.get('https://staging.therapios.de/', { timeout: 120_000 })).text();
    const src = [...html.matchAll(/src="([^"]*entry[^"]*\.js)"/g)].map((m) => m[1])[0];
    if (!src) throw new Error('no entry bundle');
    return (await this.request.get(src.startsWith('http') ? src : `https://staging.therapios.de${src}`, { timeout: 180_000 })).text();
  }

  escapedCount(source: string, needle: string): number {
    const escaped = [...needle]
      .map((c) => (c.charCodeAt(0) < 128 ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
      .join('');
    return source.split(escaped).length - 1;
  }
}
