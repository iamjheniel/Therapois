import { type APIRequestContext, request as pwRequest } from '@playwright/test';
import { type Credentials, STAGING_CREDENTIALS } from '../util/api-token';

export const PROD_API = 'https://api.app.therapios.de';

export type Vo = {
  id: number;
  prescriptionId: string;
  date: string;
  treatmentStatus?: string;
  insuranceType?: string;
  therapyType?: string;
  isDischargeManagement?: boolean;
  blankoVO?: boolean;
  urgentTreatmentNeed?: boolean;
  treatmentStartDeadline?: string;
  validityDate?: string;
};

export type ExpiryLog = { id: number; createdAt: string; reason: string; type?: string; author: unknown };
export type Activity = { date: string; treatmentType?: string; rejectedTreatment?: boolean; rejectedTreatmentWithSignature?: boolean; prescription?: unknown };

/**
 * PRODUCTION side of RC 3.14 **#3800** (a discharge VO expires after day 7 or day 12) and **#3830**
 * (the same two days are what every screen SHOWS).
 *
 * **READ-ONLY.** Every request is a GET. Nothing runs the nightly command, and the creation-check
 * preview — the transient `POST /prescriptions/preview-creation-validation` that carries #3830's
 * AC6 on staging — is deliberately not called here, because it is a POST.
 *
 * **The two tickets share one probe.** `4b1722ce7` put the window in a single `App\Util\DischargeWindow`
 * that BOTH the presenter (the shown dates) and #3800's nightly reason read, so the served
 * `treatmentStartDeadline` / `validityDate` answer for the display directly and place the shared
 * util in the build. `GET /status` cannot: it reports the release, not the commit (#3704).
 *
 * **TRAPS, both confirmed on production as well as staging:**
 *  - `?isDischargeManagement=` is accepted and SILENTLY IGNORED, so the population must be walked
 *    and the flag read per row (the FIELD is serialized even though the filter is not).
 *  - `order[id]` is silently ignored on `/prescription_logs`, and the collection is id-ascending,
 *    so an `order[id]=desc` "newest N" scan returns the OLDEST N — on production that is 2019-era
 *    history carrying no discharge reason, which reads exactly like the rule never firing. Page
 *    from `totalItems` instead.
 *  - the signed-treatment fields are `rejectedTreatment` / `rejectedTreatmentWithSignature`; the
 *    shorter names do not exist, so a predicate built on them silently excludes nothing.
 */
export class ProdDischargePage {
  static readonly START_DAYS = 7;
  static readonly VALIDITY_DAYS = 12;
  /** The insurance types the window applies to (#3800's own set). */
  static readonly DISCHARGE_TYPES = ['public', 'privat_basis'];
  static readonly OPEN = ['Aktiv', 'Pending', 'Bereit', 'For Review', 'Sent Back to Therapist'];
  /** The marker #3800 writes into `PrescriptionLog.meta.reason`. */
  static readonly DISCHARGE_MARKER = 'Entlassmanagement';

  private api!: APIRequestContext;
  private token = '';

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: PROD_API });
    const res = await this.api.post('/auth', {
      data: { username: credentials.email, password: credentials.password },
      timeout: 90_000,
    });
    if (!res.ok()) throw new Error(`POST ${PROD_API}/auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 400_000): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      last = `${res.status()} ${path}`;
      if (res.status() < 500) break;
      await new Promise((r) => setTimeout(r, 4_000 * (attempt + 1)));
    }
    throw new Error(`GET failed: ${last}`);
  }

  async status(): Promise<{ version: string }> {
    return this.get('/status', 60_000);
  }

  async voCount(query = ''): Promise<number> {
    return (await this.get<{ totalItems: number }>(`/prescriptions?itemsPerPage=1${query ? `&${query}` : ''}`)).totalItems;
  }

  /** Every discharge VO issued since `after`. ~108 pages on production, so it is the slow part. */
  async dischargeVosSince(after: string, maxPages = 120): Promise<{ scanned: number; discharge: Vo[] }> {
    const q = `date%5Bafter%5D=${after}`;
    const discharge: Vo[] = [];
    let scanned = 0;
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.get<{ member?: Vo[] }>(`/prescriptions?${q}&itemsPerPage=100&page=${page}`);
      const m = body.member ?? [];
      scanned += m.length;
      discharge.push(...m.filter((r) => r.isDischargeManagement === true));
      if (m.length < 100) break;
    }
    return { scanned, discharge };
  }

  /** The LAST `pages` pages of the expiry log — the only way to reach recent entries. */
  async expiryLogTail(pages = 6, per = 300): Promise<ExpiryLog[]> {
    const { totalItems } = await this.get<{ totalItems: number }>('/prescription_logs?type=treatment_expired&itemsPerPage=1');
    const last = Math.ceil(totalItems / per);
    const out: ExpiryLog[] = [];
    for (let p = Math.max(1, last - pages + 1); p <= last; p++) {
      const body = await this.get<{ member?: Record<string, any>[] }>(
        `/prescription_logs?type=treatment_expired&itemsPerPage=${per}&page=${p}`,
      );
      for (const l of body.member ?? []) {
        out.push({ id: l.id, createdAt: l.createdAt, reason: l.meta?.reason ?? '', type: l.meta?.type, author: l.author ?? null });
      }
    }
    return out;
  }

  async expiryLogsFor(voId: number): Promise<ExpiryLog[]> {
    const body = await this.get<{ member?: Record<string, any>[] }>(
      `/prescription_logs?prescription=${voId}&type=treatment_expired&itemsPerPage=20`,
    );
    return (body.member ?? []).map((l) => ({ id: l.id, createdAt: l.createdAt, reason: l.meta?.reason ?? '', type: l.meta?.type, author: l.author ?? null }));
  }

  /** First completed session per VO, batched — `/activities` registers `prescription[]`. */
  async firstTreatmentDates(voIds: readonly number[], chunk = 30): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>();
    for (const id of voIds) out.set(id, null);
    for (let i = 0; i < voIds.length; i += chunk) {
      const slice = voIds.slice(i, i + chunk);
      const q = slice.map((id) => `prescription%5B%5D=${id}`).join('&');
      const body = await this.get<{ member?: Activity[] }>(`/activities?${q}&itemsPerPage=1000`);
      const byVo = new Map<number, string[]>();
      for (const a of body.member ?? []) {
        if (!ProdDischargePage.isSigned(a)) continue;
        const pr = a.prescription;
        const id = typeof pr === 'number' ? pr : Number(String((pr as any)?.['@id'] ?? pr).split('/').pop());
        if (!Number.isFinite(id)) continue;
        (byVo.get(id) ?? byVo.set(id, []).get(id)!).push(a.date.slice(0, 10));
      }
      for (const id of slice) out.set(id, (byVo.get(id) ?? []).sort()[0] ?? null);
    }
    return out;
  }

  static isSigned(a: Activity): boolean {
    if (a.treatmentType === 'planned') return false;
    if (a.rejectedTreatment && !a.rejectedTreatmentWithSignature) return false;
    return true;
  }

  // ------------------------------------------------------------- oracle

  static addDays(iso: string, days: number): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  static daysBetween(from: string, to: string): number {
    const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
    return Math.round((b - a) / 86_400_000);
  }

  static inScope(vo: Vo): boolean {
    return vo.isDischargeManagement === true && this.DISCHARGE_TYPES.includes(vo.insuranceType ?? '');
  }

  static iso(v?: string): string | null {
    return v ? v.slice(0, 10) : null;
  }

  /**
   * #3800's rule, ported. `null` = stays open. The comparison is STRICTLY after the boundary day:
   * day 7 and day 12 are the LAST VALID days, which is why the shown dates equal the printed
   * `Frist` / `Ende` and must not be "aligned" with the ordinary rules.
   */
  static dueExpiry(vo: Vo, firstTreatment: string | null, today: string): { kind: 'start7' | 'window12'; boundary: string } | null {
    if (!this.inScope(vo)) return null;
    if (!this.OPEN.includes(vo.treatmentStatus ?? '')) return null;
    const startBy = this.addDays(vo.date, this.START_DAYS);
    const windowEnd = this.addDays(vo.date, this.VALIDITY_DAYS);
    if (!firstTreatment) return today > startBy ? { kind: 'start7', boundary: startBy } : null;
    if (firstTreatment > startBy) return { kind: 'start7', boundary: startBy };
    return today > windowEnd ? { kind: 'window12', boundary: windowEnd } : null;
  }

  static isDischargeReason(reason: string): boolean {
    return reason.includes(ProdDischargePage.DISCHARGE_MARKER);
  }
}
