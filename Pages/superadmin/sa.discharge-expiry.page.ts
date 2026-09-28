import { type Page, type APIRequestContext, request as pwRequest } from '@playwright/test';

export type Vo = {
  id: number;
  prescriptionId: string;
  date: string;
  treatmentStatus?: string;
  insuranceType?: string;
  isDischargeManagement?: boolean;
  treatmentStartDeadline?: string;
  validityDate?: string;
  urgentTreatmentNeed?: boolean;
};

export type ExpiryLog = {
  id: number;
  createdAt: string;
  prescriptionIri: string;
  reason: string;
  type?: string;
  author: unknown;
};

export type Kind = 'start7' | 'window12' | 'other';

/**
 * RC 3.14 #3800 — a discharge VO (Entlassmanagement) must expire when treatment has not
 * started by day 7, or when the 12-day treatment window is over.
 *
 * The job is console-only (`app:prescription:expire`, nightly at 20:02 UTC), so this reads
 * the two surfaces it leaves behind:
 *
 *   - `PrescriptionLog` (type `treatment_expired`), whose `meta.reason` carries the new
 *     `Entlassmanagement: …` wording with the dates interpolated. This is the ONLY surface
 *     that attributes an expiry to THIS ticket.
 *   - the VO's own serialized `treatmentStartDeadline` / `validityDate`, which read
 *     issue+7 / issue+12 for a discharge VO. Careful: that DISPLAY change is #3830
 *     (`4b1722ce7`/`a394b0af8`, both `Ref #3830`), which moved the presenter onto the shared
 *     `DischargeWindow`; #3800's own Out of Scope excluded touching Startfrist/Gültig bis.
 *     So the served fields probe the WINDOW DEFINITION and the log probes the EXPIRY.
 *
 * TWO SILENT-IGNORE TRAPS, and each one alone makes the fix look absent:
 *
 *   - `?isDischargeManagement=true` is accepted and IGNORED on `/prescriptions` — `true`,
 *     `false` and a nonsense key all return the unfiltered book. The population has to be
 *     derived instead (see `looksLikeDischargeWindow`).
 *   - `order[id]` is accepted and IGNORED on `/prescription_logs`: asc and desc return
 *     byte-identical pages and the collection is id-ascending. So a "newest N" scan returns
 *     the OLDEST N — 3,600 rows of 2025 history, carrying zero discharge reasons, which
 *     reads exactly like the job never running. Read the TAIL pages instead
 *     (`expiryLogTail`), and prove the order is ignored before trusting any ordering.
 */
export class DischargeExpiryPage {
  static readonly API = 'https://api.staging.therapios.de';

  /** The day-7 start deadline and the 12-day window, from the ticket's own rule. */
  static readonly START_DAYS = 7;
  static readonly WINDOW_DAYS = 12;

  /** AC4: only these two insurance types get the discharge window. */
  static readonly DISCHARGE_TYPES = ['public', 'privat_basis'];

  /** The reason wording, from the Localization Reference. Matched on parts, in order. */
  static readonly REASON_START = [
    'Entlassmanagement:',
    'Behandlungsbeginn nicht innerhalb von 7 Tagen nach Ausstellung',
    'Ausstellung:',
    'Frist:',
  ];

  static readonly REASON_WINDOW = [
    'Entlassmanagement:',
    'Behandlungszeitraum von 12 Tagen nach Ausstellung abgelaufen',
    'Ausstellung:',
    'Ende:',
  ];

  /**
   * The nightly runs this file reads. Both are real: the fix's first run caught 15 VOs
   * (5 of them real ones overdue since April–July), and the next caught the two whose
   * windows closed exactly ON the first run day — which is what shows the comparison is
   * strictly-after rather than on-or-after.
   */
  static readonly FIRST_RUN = '2026-09-25';
  static readonly SECOND_RUN = '2026-09-26';

  /** Statuses `ExpirePrescriptionCommand` skips (AC5/AC6). */
  static readonly TERMINAL = [
    'Abgerechnet',
    'Fertig Behandelt',
    'Abgebrochen',
    'Abgelaufen',
    'Archiviert',
    'Gelöscht',
  ];

  private api!: APIRequestContext;
  private token = '';

  constructor(private readonly page?: Page) {}

  /** Mints its own token: this file drives no screen, so there is no localStorage to read. */
  async connect(
    credentials = { username: 'sa.jhen@gmail.com', password: 'thera.rocks' },
  ): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: DischargeExpiryPage.API });
    const res = await this.api.post('/auth', { data: credentials, timeout: 60_000 });
    if (!res.ok()) throw new Error(`POST /auth ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 180_000): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      last = `${res.status()} ${path}`;
      // A 5xx here is staging being unhealthy, never the route being absent.
      if (res.status() < 500) break;
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
    throw new Error(`GET failed: ${last}`);
  }

  // ---------------------------------------------------------------- VOs

  async voByNumber(number: string): Promise<Vo | null> {
    const body = await this.get<{ member?: Vo[] }>(
      `/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}&itemsPerPage=1`,
    );
    return body.member?.[0] ?? null;
  }

  async voById(id: number): Promise<Vo> {
    return this.get<Vo>(`/prescriptions/${id}`);
  }

  async voCount(query = ''): Promise<number> {
    const body = await this.get<{ totalItems: number }>(
      `/prescriptions?itemsPerPage=1${query ? `&${query}` : ''}`,
    );
    return body.totalItems;
  }

  /** Every completed session date on a VO, ascending. A planned or rejected one is not a start. */
  async firstTreatmentDate(voId: number): Promise<string | null> {
    const body = await this.get<{ member?: { date: string; rejected?: boolean; treatmentType?: string }[] }>(
      `/activities?prescription=${voId}&itemsPerPage=300`,
    );
    const done = (body.member ?? [])
      .filter((a) => !a.rejected && a.treatmentType !== 'planned')
      .map((a) => a.date.slice(0, 10))
      .sort();
    return done[0] ?? null;
  }

  // ------------------------------------------------------- expiry logs

  /**
   * The LAST `pages` pages of the `treatment_expired` collection — the only way to reach
   * recent entries, because `order[id]` is ignored (see the class docblock).
   */
  async expiryLogTail(pages = 4, per = 300): Promise<ExpiryLog[]> {
    const { totalItems } = await this.get<{ totalItems: number }>(
      '/prescription_logs?type=treatment_expired&itemsPerPage=1',
    );
    const last = Math.ceil(totalItems / per);
    const out: ExpiryLog[] = [];
    for (let p = Math.max(1, last - pages + 1); p <= last; p++) {
      const body = await this.get<{ member?: Record<string, any>[] }>(
        `/prescription_logs?type=treatment_expired&itemsPerPage=${per}&page=${p}`,
      );
      for (const l of body.member ?? []) {
        const pres = l.prescription;
        out.push({
          id: l.id,
          createdAt: l.createdAt,
          prescriptionIri: typeof pres === 'string' ? pres : String(pres?.['@id'] ?? pres),
          reason: l.meta?.reason ?? '',
          type: l.meta?.type,
          author: l.author ?? null,
        });
      }
    }
    return out;
  }

  /** Per-VO expiry logs — exact, and the way to attribute one fixture's expiry. */
  async expiryLogsFor(voId: number): Promise<ExpiryLog[]> {
    const body = await this.get<{ member?: Record<string, any>[] }>(
      `/prescription_logs?prescription=${voId}&type=treatment_expired&itemsPerPage=30`,
    );
    return (body.member ?? []).map((l) => ({
      id: l.id,
      createdAt: l.createdAt,
      prescriptionIri: String(l.prescription),
      reason: l.meta?.reason ?? '',
      type: l.meta?.type,
      author: l.author ?? null,
    }));
  }

  static isDischargeReason(reason: string): boolean {
    return reason.includes('Entlassmanagement');
  }

  static kindOf(reason: string): Kind {
    if (reason.includes('nicht innerhalb von 7 Tagen')) return 'start7';
    if (reason.includes('Behandlungszeitraum von 12 Tagen')) return 'window12';
    return 'other';
  }

  static idFromIri(iri: string): number {
    return Number(iri.replace(/\/$/, '').split('/').pop());
  }

  // ------------------------------------------------------------ oracle

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

  /**
   * The discharge window identifies itself: no other rule puts the start deadline exactly
   * 7 days after issue (standard is 28, urgent and BG 14). That is how the population is
   * reached at all, since the `isDischargeManagement` filter is silently ignored.
   */
  static looksLikeDischargeWindow(vo: Vo): boolean {
    if (!vo.treatmentStartDeadline) return false;
    return this.daysBetween(vo.date, vo.treatmentStartDeadline) === this.START_DAYS;
  }

  /**
   * The ticket's rule, ported: which expiry (if any) a discharge VO has earned by `today`.
   * `null` means it stays open. The comparison is STRICTLY after the boundary day — the
   * deadline day itself is still inside the window, which two live VOs demonstrate by
   * surviving the run on their own closing day and expiring on the next.
   */
  static expectedExpiry(
    vo: Vo,
    firstTreatment: string | null,
    today: string,
  ): { kind: Kind; boundary: string } | null {
    if (!this.DISCHARGE_TYPES.includes(vo.insuranceType ?? '')) return null;
    if (this.TERMINAL.includes(vo.treatmentStatus ?? '')) return null;

    const startBy = this.addDays(vo.date, this.START_DAYS);
    const windowEnd = this.addDays(vo.date, this.WINDOW_DAYS);

    if (!firstTreatment) {
      return today > startBy ? { kind: 'start7', boundary: startBy } : null;
    }
    if (firstTreatment > startBy) return { kind: 'start7', boundary: startBy };
    return today > windowEnd ? { kind: 'window12', boundary: windowEnd } : null;
  }

  /** The dates the reason interpolates, as ISO, so they can be checked against the VO. */
  static datesInReason(reason: string): string[] {
    return [...reason.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map(
      (m) => `${m[3]}-${m[2]}-${m[1]}`,
    );
  }

  static containsInOrder(haystack: string, parts: string[]): boolean {
    let at = 0;
    for (const p of parts) {
      const i = haystack.indexOf(p, at);
      if (i < 0) return false;
      at = i + p.length;
    }
    return true;
  }


  /**
   * Every VO issued in a window, paged. The discharge population has to be reached this way
   * because `isDischargeManagement` is not a registered filter; `date[after]`/`date[before]`
   * are (and both are INCLUSIVE — #3712).
   */
  async voWalk(after: string, before: string, maxPages = 25): Promise<Vo[]> {
    const q = `date%5Bafter%5D=${after}&date%5Bbefore%5D=${before}`;
    const out: Vo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.get<{ member?: Vo[] }>(`/prescriptions?${q}&itemsPerPage=100&page=${page}`);
      const m = body.member ?? [];
      out.push(...m);
      if (m.length < 100) break;
    }
    return out;
  }


  /** Proves a filter partitions the book before any zero from it is believed. */
  async filterIsHonoured(key: string, value: string): Promise<boolean> {
    const all = await this.voCount();
    const hit = await this.voCount(`${key}=${encodeURIComponent(value)}`);
    return hit !== all;
  }

  /** Proves `order[…]` is honoured on a collection before any ordering is trusted. */
  async orderIsHonoured(path: string, field: string): Promise<boolean> {
    const ids = async (dir: string) => {
      const body = await this.get<{ member?: { id: number }[] }>(
        `${path}&itemsPerPage=3&order%5B${field}%5D=${dir}`,
      );
      return (body.member ?? []).map((m) => m.id).join(',');
    };
    return (await ids('asc')) !== (await ids('desc'));
  }
}
