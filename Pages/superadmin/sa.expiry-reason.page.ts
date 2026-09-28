import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * The VO expiry reason text — RC 3.13 #3651 (commit `2eb764c8d`, PR #3654).
 *
 * When a VO expires the reason is stored as free text in `PrescriptionLog.value.meta.reason`
 * (type `treatment_expired`) and rendered verbatim by both the Änderungsprotokoll and the in-app
 * notification. It used to be English and, on the Ergo branch, hardcoded "28 days" even when the
 * 14-day urgent / Berufsgenossenschaft deadline had fired. The fix makes it a structured
 * `ExpiryReason` — a machine-readable `ExpiryReasonTypeEnum` plus a German sentence whose day count
 * is interpolated from the very `getStartDeadlineDays()` call that made the decision.
 *
 * **Read-only — every request is a GET.** The log is the authoritative surface: the change log and
 * the notification both interpolate the same stored string, so verifying the string verifies both.
 *
 * ## The cutover, which is the whole trap
 *
 * The ticket says plainly: *"Existing change log entries are not rewritten retroactively. Only
 * expirations that happen after this fix ships get the corrected text."* `release/3.13.0` first
 * reached staging at **2026-09-09 02:38 UTC**, so:
 *
 * - entries **before** that are expected to be English, and stay that way for good;
 * - entries **after** it must be German.
 *
 * A spec that asserts "every expiry reason is German" fails on 1,100+ historical rows that the
 * ticket deliberately leaves alone. Partition by `createdAt` first, always.
 *
 * ## The bug, and how to detect it without knowing the rule
 *
 * The old Ergo prose carried its own dates, so it can be checked against itself: the stated day
 * count must equal `Frist − Ausstellung`. That invariant needs no knowledge of urgency or insurance
 * type and it is exactly what the bug violated. Across the newest 1,200 expiry logs it finds
 * **3 self-contradicting entries** — VO 5691-6, 6390-3 and 8673-3, all urgent, all logged
 * 2026-08-07 — each announcing "28 days" over dates 14 days apart. A fourth sits outside that
 * window and was found through the accident population instead: **VO 905302-3, expired
 * 2026-06-15**, "28 days passed … deadline: 2026-06-13, issue date: 2026-05-30" — 14 days. So the
 * bug hit both the urgent and the Berufsgenossenschaft branch. The same invariant holds on every
 * post-fix entry.
 *
 * ## What the population looks like on staging (2026-09-11)
 *
 * Across the newest 1,200 entries, by shape:
 *
 * | shape | count | era |
 * |---|---|---|
 * | `Start deadline expired` (bare — no number, no dates) | 729 | pre-fix, Physio/Logo |
 * | `N days passed from issue date without starting (…)` | 321 | pre-fix, Ergo |
 * | `Validity period expired` (bare) | 97 | pre-fix |
 * | `Gültigkeitszeitraum abgelaufen (N Monate ab erster Behandlung, …)` | 41 | **post-fix** |
 * | `Manual expiration` | 8 | manual, out of scope |
 * | `Behandlungsbeginn nicht innerhalb von N Tagen nach Ausstellung (…)` | 2 | **post-fix** |
 * | `Break accumulation: …` | 1 | pre-fix |
 *
 * So the commit's claim that **Physio and Logo start-deadline reasons previously carried no numbers
 * or dates at all** is visible in the data: 729 bare strings against 321 detailed Ergo ones.
 *
 * **Only two of the six reason types have a post-fix instance** (validity period, standard start
 * deadline). The urgent and BG variants, the 16-Wochen rules and Behandlungsunterbrechungen have
 * none yet — see the spec's fixme, which records that rather than skipping quietly.
 *
 * ## Traps
 *
 * - **`urgentTreatmentNeed` is NOT a registered filter.** `?urgentTreatmentNeed=true`, `=false` and
 *   `=bogus` all return the same 3,074 Aktiv VOs — it is accepted and silently ignored, so a
 *   candidate hunt built on it returns non-urgent VOs and reads as a fixture. Filter client-side.
 *   `insuranceType` IS real (`accident` → 31 VOs).
 * - `urgentTreatmentNeed` is also **omitted when false**, so it reads `undefined`, never `false`.
 * - The qualifier separator is an **en dash** (` – `), not the ticket's proposed `--`.
 */

/** The first staging deploy of `release/3.13.0` — the line either side of which the text differs. */
export const CUTOVER = '2026-09-09T02:38';

/** `ExpiryReasonTypeEnum`, and the German sentence each type produces. */
export const REASON_SHAPES = {
  START_DEADLINE: /^Behandlungsbeginn nicht innerhalb von (\d+) Tagen nach Ausstellung/,
  VALIDITY_PERIOD: /^Gültigkeitszeitraum abgelaufen \(/,
  SIXTEEN_WEEK: /^Gültigkeitszeitraum von 16 Wochen abgelaufen \(/,
  BREAK_ACCUMULATION: /^Behandlungsunterbrechungen: insgesamt (\d+) überzählige Tage/,
} as const;

/** The two qualifiers AC1 requires on a 14-day deadline, with the shipped en dash. */
export const QUALIFIERS = {
  urgent: ' – dringender Behandlungsbedarf',
  accident: ' – Berufsgenossenschaft',
} as const;

/** The pre-fix English shapes, kept so the cutover can be asserted rather than assumed. */
export const ENGLISH_SHAPES = [
  'Start deadline expired',
  'days passed from issue date without starting',
  'Validity period expired',
  'Break accumulation:',
  '16-week',
  'Manual expiration',
] as const;

/** AC3's named reproduction case — expired a month before the fix shipped. */
export const AC3_VO = { number: '5691-6', prescriptionId: 34030, area: 'ergotherapy', urgent: true, issued: '2026-07-15' } as const;

/** The PM's Session-E fixture: a standard 28-day case, and the one they actually screenshotted. */
export const PM_VO = { number: '965110-3', urgent: false, insuranceType: 'public' } as const;

export type ExpiryLog = {
  id: number;
  prescriptionId: number;
  createdAt: string;
  reason: string;
  voNumber: string | null;
  metaType: string | null;
};

export type Vo = {
  id: number;
  number: string | null;
  therapyType: string | null;
  treatmentStatus: string | null;
  insuranceType: string | null;
  urgentTreatmentNeed: boolean;
  issueDate: string | null;
  blankoVO: boolean;
};

export class ExpiryReasonPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3651: no bearer token');
  }

  private async get(path: string, timeout = 300_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(3_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  /** The newest expiry log entries, newest first. 200 per page; 1,200 covers back to ~July. */
  async expiryLogs(pages = 6): Promise<ExpiryLog[]> {
    const out: ExpiryLog[] = [];
    for (let page = 1; page <= pages; page++) {
      const body = await this.get(
        `/prescription_logs?type=treatment_expired&order%5BcreatedAt%5D=desc&itemsPerPage=200&page=${page}`,
      );
      const member = body.member ?? [];
      if (!member.length) break;
      for (const row of member) {
        const meta = row.meta ?? {};
        out.push({
          id: row.id,
          prescriptionId: Number(String(row.prescription).split('/').pop()),
          createdAt: row.createdAt,
          reason: meta.reason ?? '',
          voNumber: meta.voNumber ?? null,
          metaType: meta.type ?? null,
        });
      }
    }
    return out;
  }

  /** One VO's expiry entries — what the Änderungsprotokoll shows for it. */
  async expiryLogsFor(prescriptionId: number): Promise<ExpiryLog[]> {
    const body = await this.get(
      `/prescription_logs?prescription=%2Fprescriptions%2F${prescriptionId}&type=treatment_expired`,
    );
    return (body.member ?? []).map((row: any) => ({
      id: row.id,
      prescriptionId,
      createdAt: row.createdAt,
      reason: (row.meta ?? {}).reason ?? '',
      voNumber: (row.meta ?? {}).voNumber ?? null,
      metaType: (row.meta ?? {}).type ?? null,
    }));
  }

  async vo(prescriptionId: number): Promise<Vo> {
    const body = await this.get(`/prescriptions/${prescriptionId}`);
    return ExpiryReasonPage.shape(body);
  }

  /** Resolves a VO by its human number (`exact[prescriptionId]`). */
  async voByNumber(number: string): Promise<Vo | null> {
    const body = await this.get(`/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(number)}`);
    const row = (body.member ?? [])[0];
    return row ? ExpiryReasonPage.shape(row) : null;
  }

  private static shape(row: any): Vo {
    return {
      id: row.id,
      number: row.prescriptionId ?? null,
      therapyType: row.therapyType ?? null,
      treatmentStatus: row.treatmentStatus ?? null,
      insuranceType: row.insuranceType ?? null,
      // Omitted when false — reads `undefined`, never `false`.
      urgentTreatmentNeed: true === row.urgentTreatmentNeed,
      issueDate: row.date ? String(row.date).slice(0, 10) : null,
      blankoVO: true === row.blankoVO,
    };
  }

  // ─────────────────────────────── the reason text, parsed ───────────────────────────────

  static isGerman(reason: string): boolean {
    return Object.values(REASON_SHAPES).some((re) => re.test(reason));
  }

  static isEnglish(reason: string): boolean {
    return ENGLISH_SHAPES.some((shape) => reason.includes(shape));
  }

  static isPostCutover(entry: ExpiryLog): boolean {
    return entry.createdAt.slice(0, 16) >= CUTOVER;
  }

  /**
   * The stated deadline and the two dates, from either era's start-deadline text.
   *
   * Both the old English prose and the new German one carry the day count AND the dates, which is
   * what makes the self-consistency check (`Frist − Ausstellung === days`) work across the cutover —
   * and it is precisely the check the bug fails.
   */
  static parseStartDeadline(reason: string): { days: number; issued: Date; deadline: Date } | null {
    const german = reason.match(
      /innerhalb von (\d+) Tagen nach Ausstellung.*?\(Frist: (\d{2})\.(\d{2})\.(\d{4}), Ausstellung: (\d{2})\.(\d{2})\.(\d{4})/,
    );
    if (german) {
      return {
        days: Number(german[1]),
        deadline: new Date(Date.UTC(+german[4], +german[3] - 1, +german[2])),
        issued: new Date(Date.UTC(+german[7], +german[6] - 1, +german[5])),
      };
    }
    const english = reason.match(
      /(\d+) days passed from issue date without starting \(now: [\d-]+ >= deadline: (\d{4})-(\d{2})-(\d{2}), issue date: (\d{4})-(\d{2})-(\d{2})/,
    );
    if (english) {
      return {
        days: Number(english[1]),
        deadline: new Date(Date.UTC(+english[2], +english[3] - 1, +english[4])),
        issued: new Date(Date.UTC(+english[5], +english[6] - 1, +english[7])),
      };
    }
    return null;
  }

  static daysBetween(from: Date, to: Date): number {
    return Math.round((to.getTime() - from.getTime()) / 86_400_000);
  }

  /** `getStartDeadlineDays()`: 14 when urgent or accident insurance, else 28. */
  static expectedDeadlineDays(vo: Vo): number {
    return vo.urgentTreatmentNeed || 'accident' === vo.insuranceType ? 14 : 28;
  }

  /** A normalised shape, for counting the reason population without the dates. */
  static shapeOf(reason: string): string {
    return reason
      .replace(/\d{2}\.\d{2}\.\d{4}/g, 'DD.MM.YYYY')
      .replace(/\d{4}-\d{2}-\d{2}/g, 'YYYY-MM-DD')
      .replace(/\b\d+\b/g, 'N');
  }
}
