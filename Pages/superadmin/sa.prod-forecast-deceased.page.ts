import { type APIRequestContext, request as pwRequest } from '@playwright/test';
import { type Credentials, STAGING_CREDENTIALS } from '../util/api-token';

export const PROD_API = 'https://api.app.therapios.de';

export type Vo = {
  id: number;
  prescriptionId: string;
  date: string;
  treatmentStatus?: string;
  blankoVO?: boolean;
  followupStatus?: string | null;
  orderingStatus?: string | null;
  practice?: { name?: string } | null;
  patient?: { id?: number } | number | null;
};

export type TerminationLog = { id: number; createdAt: string; prescriptionId: number; metaText: string };

/** `PrescriptionIntervalEnum::TO_ORDER` — #3773 AC3's Blanko rule. */
export const TO_ORDER_DAYS = 91;

/** #3773's report window. */
export const WINDOW = { from: '2026-10-05', to: '2026-10-11' } as const;

/**
 * `FollowupOrderingStatus::BY_PRAXIS` / `BY_ER` — the two that take a VO out of the pipeline.
 *
 * **Their backing values are not what the case names suggest:** `BY_ADMIN = 'By Admin'` and
 * `BY_THERAPIST = 'By Therapist'`, but `BY_PRAXIS = 'Praxis'` and `BY_ER = 'ER bestellt selbst'`
 * (open hygiene ticket #3759). A gate written as `['By Praxis','By ER']` matches nothing the API
 * serves, so it never fires and the forecast silently keeps VOs the report must skip.
 */
export const BLOCKED_ORDERING = ['Praxis', 'ER bestellt selbst'] as const;

/** #3731's four in-progress statuses — the only ones a deceased marking may cancel. */
export const CANCELLABLE = ['Pending', 'Bereit', 'Aktiv', 'For Review'] as const;
/** The statuses the fix protects: a deceased marking must leave these alone. */
export const PROTECTED = ['Abgerechnet', 'Fertig Behandelt', 'Abgelaufen', 'Sent Back to Therapist'] as const;

/**
 * PRODUCTION side of RC 3.14 **#3773** (the quarter-change order forecast) and **#3731** (the
 * deceased cascade's scope).
 *
 * **READ-ONLY:** every request is a GET. #3773's command is console-only and is never run; #3731's
 * cascade is a write whose whole subject is what it would do, so nothing here marks a patient
 * deceased or cancels a VO.
 *
 * **No patient data.** #3773's report carries patient names by design; this file derives the
 * forecast's VO numbers, dates and practices and deliberately does not read or print names.
 */
export class ProdForecastDeceasedPage {
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

  private async get<T>(path: string, timeout = 500_000): Promise<T> {
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

  async total(query = ''): Promise<number> {
    return (await this.get<{ totalItems: number }>(`/prescriptions?itemsPerPage=1${query ? `&${query}` : ''}`)).totalItems;
  }

  async statusCount(status: string): Promise<number> {
    return this.total(`treatmentStatus=${encodeURIComponent(status)}`);
  }

  /** Every VO issued in a window, with the collected count checked against `totalItems`. */
  async vosIssuedBetween(after: string, before: string): Promise<{ expected: number; vos: Vo[] }> {
    const q = `date%5Bafter%5D=${after}&date%5Bbefore%5D=${before}`;
    const expected = (await this.get<{ totalItems: number }>(`/prescriptions?${q}&itemsPerPage=1`)).totalItems;
    const vos: Vo[] = [];
    for (let page = 1; page <= 60; page++) {
      const body = await this.get<{ member?: Vo[] }>(`/prescriptions?${q}&itemsPerPage=100&page=${page}`);
      const m = body.member ?? [];
      vos.push(...m);
      if (m.length < 100) break;
    }
    return { expected, vos };
  }

  async vosByIds(ids: readonly number[], chunk = 30): Promise<Vo[]> {
    const out: Vo[] = [];
    for (let i = 0; i < ids.length; i += chunk) {
      const q = ids.slice(i, i + chunk).map((x) => `id%5B%5D=${x}`).join('&');
      const body = await this.get<{ member?: Vo[] }>(`/prescriptions?${q}&itemsPerPage=${chunk + 10}`);
      out.push(...(body.member ?? []));
    }
    return out;
  }

  async vosOfPatient(patientId: number): Promise<Vo[]> {
    // `?patient=` is silently ignored; the registered filter is `patient.id`.
    const body = await this.get<{ member?: Vo[] }>(`/prescriptions?patient.id=${patientId}&itemsPerPage=60`);
    return body.member ?? [];
  }

  /** The two deceased-dialog endpoints — #3731's dual oracle. */
  async activeVosCount(patientId: number): Promise<number | null> {
    const body = await this.get<any>(`/patients/${patientId}/active-vos-count`);
    return typeof body === 'number' ? body : (body?.count ?? null);
  }

  async activeVos(patientId: number): Promise<number | null> {
    const body = await this.get<any>(`/patients/${patientId}/active-vos`);
    const list = Array.isArray(body) ? body : body?.member;
    return Array.isArray(list) ? list.length : null;
  }

  /** Every `prescription_termination` log, flattened so the free-text reason can be matched. */
  async terminationLogs(): Promise<TerminationLog[]> {
    const out: TerminationLog[] = [];
    for (let page = 1; page <= 40; page++) {
      const body = await this.get<{ member?: Record<string, any>[] }>(
        `/prescription_logs?type=prescription_termination&itemsPerPage=300&page=${page}`,
      );
      const m = body.member ?? [];
      for (const l of m) {
        const pres = l.prescription;
        out.push({
          id: l.id,
          createdAt: l.createdAt,
          prescriptionId: typeof pres === 'number' ? pres : Number(String(pres).replace(/\/$/, '').split('/').pop()),
          metaText: JSON.stringify(l.meta ?? {}),
        });
      }
      if (m.length < 300) break;
    }
    return out;
  }

  // ------------------------------------------------------------- oracles

  static addDays(iso: string, days: number): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** The issue dates whose +91 lands inside the report window — the only server-side narrowing. */
  static issueWindow(): { after: string; before: string } {
    return {
      after: this.addDays(WINDOW.from, -TO_ORDER_DAYS),
      before: this.addDays(WINDOW.to, -TO_ORDER_DAYS),
    };
  }

  /**
   * `OrderReadyDateForecaster::forecastBlanko()`, ported.
   *
   * The two gates are `evaluate()`'s own first two, in its order. The treatment-status gate is
   * deliberately ABSENT, because `evaluate()` reaches its Blanko branch before applying it — which
   * is why an Archiviert VO can legitimately appear in the report.
   */
  static forecastBlanko(vo: Vo, today: string): { readyDate: string } | { skipped: string } {
    if (vo.followupStatus !== undefined && vo.followupStatus !== null) return { skipped: 'followupStatus set' };
    if ((BLOCKED_ORDERING as readonly string[]).includes(vo.orderingStatus ?? '')) return { skipped: 'orderingStatus blocked' };
    if (!vo.date) return { skipped: 'no issue date' };
    const ready = this.addDays(vo.date, TO_ORDER_DAYS);
    if (ready > WINDOW.to) return { skipped: 'beyond the window' };
    // `max($readyDate, $today)`: a VO already past its 91 days reports as due TODAY, which the
    // command then drops for being before the window.
    const clamped = ready > today ? ready : today;
    if (clamped < WINDOW.from) return { skipped: 'before the window' };
    return { readyDate: clamped };
  }

  static isDeceasedTermination(l: TerminationLog): boolean {
    // The command's own English substring, so the population matched is the one it acted on. The
    // stored reason is free text and also occurs in German spellings.
    return l.metaText.toLowerCase().includes('deceased');
  }
}
