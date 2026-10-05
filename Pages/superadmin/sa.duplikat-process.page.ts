import { Locator, Page, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * The Duplikat-VO process — epic #3501 and its five sub-tickets (#3503 lifecycle, #3504 activity
 * log, #3505 Ärzte-Management section, #3506 re-creation warning, #3507 worklist columns/sorting).
 *
 * A VO whose paper prescription never reached the office cannot be billed. Six weeks after it ends
 * (Fertig Behandelt / Abgebrochen / Abgelaufen) it is supposed to enter a tracked process —
 * Anfordern → Erhalten → Versendet → Abgerechnet, with two manual ways out — visible as a risk tile
 * plus a worklist on the Therapeuten-Orga board and as the "Duplikat-Anforderungen" section on the
 * Ärzte-Management board.
 *
 * ## The one fact that shapes every spec here: staging holds NO instance of this feature
 *
 * `release/3.13.0` reached staging for the first time at **2026-09-09 02:38 UTC** (the run before it
 * was 3.12.0 on 09-08), and on arrival:
 *
 * - `GET /kpis/duplikat/worklist` → `rows: []`, `/kpis/orga/risks` → `tiles.duplikatOffen: 0`;
 * - `/prescription_logs?type=duplikat_status_change` and `…=duplikat_comment` → `totalItems: 0`;
 * - `prescription.duplikatStatus` is null on every VO, and `treatmentEndedAt` — the column the
 *   six-week clock runs from — is null on every VO too, because the migration created it empty and
 *   **no VO has reached an ending status since the deploy** (0 `treatment_status_change` logs into
 *   Fertig Behandelt / Abgebrochen / Abgelaufen after 02:38).
 *
 * So the population has to be MANUFACTURED. Every spec that asserts anything about a row, a tile, a
 * column or a log first puts its own fixture VOs into the process through
 * `POST /prescriptions/{id}/duplikat-status` — the same route the board's dropdown posts — and
 * dismisses them again at the end, which is the product's own way out and restores both boards to
 * the empty state. What it cannot restore is the enum column itself (there is no "clear" value) or
 * the log entries, so a fixture VO keeps a dismissal and its history for good. Fixtures are picked
 * accordingly: ended, unbilled, un-batched VOs with **no invoice at all**, so nothing this suite does
 * can move money and no auto-close can fire behind its back.
 *
 * ## Traps
 *
 * - **Test accounts are excluded in SQL.** `DuplikatWorklistCandidates` joins
 *   `user t ON … AND t.is_test_account = 0` (#3182), and staging now has three marked accounts —
 *   **6 Sandra Zeibig, 31, 198 Jhenqa Test** (the older note that none were marked is out of date).
 *   A VO put into the process on a QA therapist's caseload is invisible on BOTH boards, which reads
 *   exactly like the feature being broken. `TEST_ACCOUNT_CONTROL_VO` turns that into an assertion.
 * - **Nulls are omitted, not serialized.** "Not in the process" reads `undefined` from
 *   `/prescriptions/{id}`, never `null` — the same shape #3302 and #3603 record for other fields.
 * - **A repeated status is a no-op, not an error.** `DuplikatStatusUpdater::apply()` returns early
 *   when the status is unchanged, so the route answers 200 with the same state and writes NO second
 *   log entry. A test that counts entries must therefore drive real transitions.
 * - **Log counts accumulate across runs.** "Verlauf (N)" grows every time the suite runs, so assert
 *   on the DELTA (`logCount` before → after), never on an absolute N.
 * - **`/kpis/orga/risks` is the slow one.** It carries all four tiles' rows (5,481 on staging) and
 *   measures ~22 s cold; `/kpis/duplikat/worklist` answers in ~1 s. Both are `kpi_data`-cached for
 *   300 s, but a Duplikat write updates the Prescription, and `KpiCacheInvalidationListener` watches
 *   Prescription — so a status change IS immediately visible. A **comment** is only a
 *   PrescriptionLog, which that listener deliberately ignores; nothing on a row changes, so this
 *   matters only if a spec expects otherwise.
 * - **A nonexistent `entity` id answers 200 with 0 rows**, indistinguishable from a Gesellschaft
 *   that legitimately holds none (same shape as #3493's unknown-entity export).
 * - **Concurrency.** Three spec files share this one global worklist. Every count assertion here is
 *   written as an INVARIANT over one payload (tile count == open rows in the same read; tile revenue
 *   == their sum) plus the presence/order of the file's OWN fixtures, so a parallel file's writes
 *   cannot turn a correct build red.
 */

// ───────────────────────────────── the enum, as shipped ─────────────────────────────────

/** `DuplikatStatusEnum` — the values ARE the German labels the board shows. */
export const DUPLIKAT = {
  ANFORDERN: 'Anfordern',
  ERHALTEN: 'Erhalten',
  VERSENDET: 'Versendet',
  ABGERECHNET: 'Abgerechnet',
  ORIGINAL_LIEGT_VOR: 'Original liegt vor',
  NICHT_MOEGLICH: 'Nicht möglich',
  /** #3722: the terminal status a past-deadline VO reaches automatically. */
  VERLOREN: 'Verloren',
} as const;

export type DuplikatStatus = (typeof DUPLIKAT)[keyof typeof DUPLIKAT];

/** `DuplikatStatusEnum::open()` — the three that keep a VO on the worklist and in the tile. */
export const OPEN_STATUSES: DuplikatStatus[] = [DUPLIKAT.ANFORDERN, DUPLIKAT.ERHALTEN, DUPLIKAT.VERSENDET];

/** `manuallySelectable()` — everything except Abgerechnet (AC7 makes that one automatic). */
export const SELECTABLE_STATUSES: DuplikatStatus[] = [
  DUPLIKAT.ANFORDERN,
  DUPLIKAT.ERHALTEN,
  DUPLIKAT.VERSENDET,
  DUPLIKAT.ORIGINAL_LIEGT_VOR,
  DUPLIKAT.NICHT_MOEGLICH,
];

/**
 * #3722: the statuses set ONLY by a job, never by hand.
 *
 * Abgerechnet was the first; Verloren joins it, and AC3 asks for exactly that parity. Both refuse
 * a hand-set with `"<status>" is set automatically …`, which is what distinguishes them from the
 * `Unknown Duplikat status` a nonsense value gets.
 */
export const AUTOMATIC_ONLY_STATUSES: DuplikatStatus[] = [DUPLIKAT.ABGERECHNET, DUPLIKAT.VERLOREN];

/** #3722: the Therapeuten-Orga tile keys for the two Duplikat populations. */
export const DUPLIKAT_TILES = { OPEN: 'duplikatOffen', LOST: 'duplikatVerloren' } as const;

/** #3503 AC8's colour table, as `STATUS_STYLE` ships it (read back with `getComputedStyle`). */
export const STATUS_BACKGROUND: Record<DuplikatStatus, string> = {
  Anfordern: 'rgb(254, 226, 226)',
  Erhalten: 'rgb(254, 243, 199)',
  Versendet: 'rgb(220, 252, 231)',
  Abgerechnet: 'rgb(229, 231, 235)',
  'Original liegt vor': 'rgb(243, 244, 246)',
  'Nicht möglich': 'rgb(243, 244, 246)',
  // #3722 ships no new colour entry; the tile is what surfaces Verloren, not a row pill.
  Verloren: 'rgb(243, 244, 246)',
};

/** #3507 AC3 — the countdown badge turns red at 60 days or fewer. */
export const DEADLINE_RED_AT_DAYS = 60;

// ─────────────────────────────────────── fixtures ───────────────────────────────────────

export type Fixture = {
  id: number;
  vo: string;
  patientId: number;
  doctorId: number;
  practiceId: number;
  /** The `region.name` of `practiceId` — #3507 AC1 reads the PRACTICE's region, not the therapist's. */
  region: string;
  practiceName: string;
  /** One Heilmittel code the VO carries; #3506's matcher needs at least one shared code. */
  code: string;
  /** `lastTreatmentDate`, the anchor of #3507 AC2's deadline. `null` ⇒ no deadline at all. */
  lastTreatment: string | null;
  revenue: number;
  entityId: number;
};

/**
 * Every fixture is Fertig Behandelt or Abgebrochen, un-batched, and carries **zero invoices**
 * (`/invoices?prescription=<id>` → 0 for all of them, checked when they were picked), so no
 * `DuplikatAutoCloseListener` arm can fire while a spec is running.
 *
 * The deadline spread is deliberate and is what makes #3507 testable:
 *
 * | fixture   | last treatment | deadline (AC2) | badge (AC3) |
 * |-----------|----------------|----------------|-------------|
 * | `OVERDUE` | 2025-10-16     | 2026-08-01     | negative → red |
 * | `TIE_HIGH`| 2025-12-11     | 2026-10-01     | ≤ 60 → red |
 * | `TIE_MID` | 2025-12-03     | 2026-10-01     | ≤ 60 → red |
 * | `TIE_LOW` | 2025-12-15     | 2026-10-01     | ≤ 60 → red |
 * | `FAR`     | 2026-02-02     | 2026-12-01     | > 60 → neutral |
 * | `NO_DEADLINE` | (none)     | —              | no badge |
 *
 * `TIE_HIGH`/`TIE_MID`/`TIE_LOW` share a deadline with revenues 4.347,09 / 630,00 / 250,08 €, which
 * is the only arrangement that can tell AC5's revenue tie-break apart from any other ordering.
 */
export const FIXTURES = {
  /** #3503/#3504 own these two. */
  OVERDUE: {
    id: 8119, vo: '3114-4', patientId: 2205, doctorId: 123, practiceId: 478,
    region: 'Berlin / Brandenburg', practiceName: 'MVZ Breitenbachplatz',
    code: 'KG-H', lastTreatment: '2025-10-16', revenue: 416.8, entityId: 3,
  },
  TIE_MID: {
    id: 12369, vo: '5366-2', patientId: 4168, doctorId: 198, practiceId: 56,
    region: 'Hamburg', practiceName: 'Gemeinschaftspraxis Mittelweg',
    code: 'KG-H', lastTreatment: '2025-12-03', revenue: 630, entityId: 4,
  },
  /** #3505/#3507 own these four. */
  TIE_HIGH: {
    id: 10936, vo: '5528-1', patientId: 4276, doctorId: 683, practiceId: 82,
    region: 'Berlin / Brandenburg', practiceName: 'Dr. med. Uwe Kalinka',
    code: 'VBP-BV', lastTreatment: '2025-12-11', revenue: 4347.09, entityId: 3,
  },
  TIE_LOW: {
    id: 14156, vo: '5739-3', patientId: 4504, doctorId: 198, practiceId: 56,
    region: 'Hamburg', practiceName: 'Gemeinschaftspraxis Mittelweg',
    code: 'KG-H', lastTreatment: '2025-12-15', revenue: 250.08, entityId: 4,
  },
  FAR: {
    id: 13301, vo: '3485-5', patientId: 1799, doctorId: 36, practiceId: 16,
    region: 'Berlin / Brandenburg',
    practiceName: 'Dr. med. Arwin Ansari - Facharztpraxis für Neurologie & Psychiatrie',
    code: 'NOB-E-HB', lastTreatment: '2026-02-02', revenue: 750.2, entityId: 1,
  },
  /** Abgebrochen with zero documented treatments — AC2's "no deadline", AC5's "sorted last". */
  NO_DEADLINE: {
    id: 33855, vo: '6611-10', patientId: 5373, doctorId: 631, practiceId: 220,
    region: 'Berlin / Brandenburg', practiceName: 'orthozentrum plus',
    code: 'KG', lastTreatment: null, revenue: 0, entityId: 3,
  },
  /** #3506 owns this one, so it never collides with the two files above. */
  RECREATION: {
    id: 13264, vo: '6218-4', patientId: 4948, doctorId: 835, practiceId: 794,
    region: 'Berlin / Brandenburg',
    practiceName: 'Dr. med. Volker Schumann - Arzt für Nervenheilkunde',
    code: 'SPB-E-HB', lastTreatment: '2026-01-05', revenue: 938.8, entityId: 3,
  },
} satisfies Record<string, Fixture>;

/**
 * A VO on **Jhenqa Test** (user 198, `isTestAccount: true`), used as a negative control: put into
 * the process it must still be absent from both boards, because #3182's exclusion lives in the
 * candidate query itself.
 */
export const TEST_ACCOUNT_CONTROL_VO = { id: 34091, vo: '963403-3', therapistId: 198 } as const;

/** The three accounts staging marks as test accounts today. */
export const STAGING_TEST_ACCOUNT_IDS = [6, 31, 198] as const;

/**
 * #3505 AC4's three named staff, and the `AERZTE_MANAGEMENT_ALLOWLIST` value staging now carries.
 *
 * The allowlist was set on the live stack during the 3.13.0 FT run and committed to
 * `staging-service.json` in `80b2741a8` (2026-09-10 01:41, deployed 01:45) — before that it held
 * only `superadmin@test.therapios.com`, which matches no staging user at all, which is why the
 * grant side of AC4 was unverifiable when this file was first written.
 *
 * **Which of the three actually demonstrates the allowlist matters.** `FlowBoardVoter` grants
 * `AERZTE_MANAGEMENT` on `ROLE_SUPER_ADMIN` **or** an allowlisted email, so Benjamin Gärtner —
 * `ROLE_SUPER_ADMIN` on staging — opens the board through the first arm whether or not he is listed.
 * Only Yasmin Hamann and Caroline Karanikolas, both plain `ROLE_ADMIN`, can show the allowlist doing
 * the work.
 */
export const AERZTE_ALLOWLIST = {
  value: 'superadmin@test.therapios.com,benjamin.gaertner@therapios.de,yasmin.hamann@therapios.de,caroline.karanikolas@therapios.de',
  /** Named by AC4. `demonstratesAllowlist` is false where the super-admin arm would grant anyway. */
  staff: [
    { email: 'benjamin.gaertner@therapios.de', userId: 246, role: 'ROLE_SUPER_ADMIN', demonstratesAllowlist: false },
    { email: 'yasmin.hamann@therapios.de', userId: 199, role: 'ROLE_ADMIN', demonstratesAllowlist: true },
    { email: 'caroline.karanikolas@therapios.de', userId: 216, role: 'ROLE_ADMIN', demonstratesAllowlist: true },
  ],
} as const;

/** The first staging deploy of `release/3.13.0` — the cutover AC3 (#3503) is defined by. */
export const RC_313_STAGING_DEPLOY = '2026-09-09T02:38Z';

/** AC2 (#3503): six weeks from the ending status. */
export const OVERDUE_WEEKS = 6;

// ───────────────────────────────────── row shape ─────────────────────────────────────

/** The shared #3246 risk-row, as both endpoints serve it (see `RiskWorklistEnricher`). */
export type DuplikatRow = {
  tile: string;
  prescriptionId: number;
  voNumber: string;
  patientInitials: string;
  therapistId: number;
  therapistName: string;
  therapistActive: boolean;
  revenue: number;
  duplikatStatus: DuplikatStatus | null;
  practiceName: string | null;
  duplikatChangedAt: string | null;
  issueDate: string | null;
  region: string | null;
  billingDeadline: string | null;
  daysToDeadline: number | null;
};

export type DuplikatLogEntry = {
  id: number;
  type: 'duplikat_status_change' | 'duplikat_comment';
  value: string | null;
  createdAt: string;
  createdByName: string | null;
};

/** One login per process, so a file's tests don't spend #3462's 5-per-minute `/auth` budget. */
const tokenCache = new Map<string, Promise<string>>();

export class DuplikatProcessPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = await this.tokenFor(credentials);
  }

  /** A bearer token for any role — the access-control tests need three of them. */
  async tokenFor(credentials: Credentials): Promise<string> {
    const cached = tokenCache.get(credentials.email);
    if (cached) return cached;
    const minted = (async () => {
      const t = await apiBearerToken(this.page, { credentials });
      if (!t) throw new Error(`#3501: no bearer token for ${credentials.email}`);
      return t;
    })();
    tokenCache.set(credentials.email, minted);
    return minted;
  }

  // ───────────────────────────────── raw requests ─────────────────────────────────

  private async get(path: string, opts: { token?: string; timeout?: number } = {}): Promise<{ status: number; body: any }> {
    const res = await this.page.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${opts.token ?? this.token}`, Accept: 'application/ld+json' },
      timeout: opts.timeout ?? 180_000,
    });
    const text = await res.text();
    return { status: res.status(), body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  }

  private async post(path: string, data: unknown, token?: string): Promise<{ status: number; body: any }> {
    const res = await this.page.request.post(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token ?? this.token}`,
        'Content-Type': 'application/ld+json',
        Accept: 'application/ld+json',
      },
      data: data as any,
      timeout: 120_000,
    });
    const text = await res.text();
    return { status: res.status(), body: text.startsWith('{') ? JSON.parse(text) : text };
  }

  // ───────────────────────────────── reads ─────────────────────────────────

  /** `GET /kpis/duplikat/worklist` — #3505's endpoint. `entity` = the VO's own Gesellschaft. */
  async worklist(entityId?: number, token?: string): Promise<DuplikatRow[]> {
    const qs = entityId === undefined ? '' : `?entity=${entityId}`;
    const { body } = await this.get(`/kpis/duplikat/worklist${qs}`, { token });
    return (body?.member?.[0]?.rows ?? []) as DuplikatRow[];
  }

  async worklistStatus(token: string): Promise<number> {
    return (await this.get('/kpis/duplikat/worklist', { token })).status;
  }

  /** `GET /kpis/orga/risks` — the Therapeuten-Orga board. Slow: all four tiles' rows. */
  async orgaRisks(token?: string): Promise<{ tiles: Record<string, number>; rows: DuplikatRow[] }> {
    const { body } = await this.get('/kpis/orga/risks', { token, timeout: 240_000 });
    const member = body?.member?.[0] ?? {};
    return { tiles: member.tiles ?? {}, rows: (member.rows ?? []) as DuplikatRow[] };
  }

  static duplikatRows(rows: DuplikatRow[]): DuplikatRow[] {
    return rows.filter((r) => 'duplikatOffen' === r.tile);
  }

  /** Staging's user accounts, keyed by lower-cased email. The field is `email`, not `username`. */
  async usersByEmail(): Promise<Map<string, { id: number; roles: string[]; active: boolean; fullName: string }>> {
    const { body } = await this.get('/users?itemsPerPage=1000');
    const out = new Map<string, { id: number; roles: string[]; active: boolean; fullName: string }>();
    for (const u of body?.member ?? []) {
      out.set(String(u.email ?? '').toLowerCase(), {
        id: u.id,
        roles: u.roles ?? [],
        active: !!u.active,
        fullName: u.fullName ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
      });
    }
    return out;
  }

  /** The VO record. `duplikatStatus` etc. are in `prescription:read` but OMITTED when null. */
  async vo(id: number): Promise<Record<string, any>> {
    return (await this.get(`/prescriptions/${id}`)).body;
  }

  async duplikatStatusOf(id: number): Promise<DuplikatStatus | undefined> {
    return (await this.vo(id)).duplikatStatus;
  }

  /** #3504's history: the two Duplikat log types of one VO, oldest first — what the panel reads. */
  async logs(id: number): Promise<DuplikatLogEntry[]> {
    const { body } = await this.get(
      `/prescription_logs?prescription=${id}` +
        '&type%5B%5D=duplikat_status_change&type%5B%5D=duplikat_comment' +
        '&order%5BcreatedAt%5D=asc&pagination=false',
    );
    return (body?.member ?? []).map((m: any) => ({
      id: m.id,
      type: m.type,
      value: m.value ?? null,
      createdAt: m.createdAt,
      createdByName: m.createdBy?.fullName ?? null,
    }));
  }

  async logCount(id: number): Promise<number> {
    return (await this.logs(id)).length;
  }

  /** How many Duplikat log entries of one type exist across the whole database. */
  async logTotal(type: 'duplikat_status_change' | 'duplikat_comment', token?: string): Promise<number> {
    const { body } = await this.get(`/prescription_logs?type=${type}&itemsPerPage=1`, { token });
    return body?.totalItems ?? 0;
  }

  /** Every Duplikat log entry id one token may read, across both types — the scope test's subject. */
  async logIdsVisibleTo(token: string): Promise<number[]> {
    const { body } = await this.get(
      '/prescription_logs?type%5B%5D=duplikat_status_change&type%5B%5D=duplikat_comment&pagination=false',
      { token },
    );
    return (body?.member ?? []).map((m: any) => m.id as number);
  }

  /** `GET /prescriptions/duplicate-check` — #3506. A GET: reads nothing into the database. */
  async duplicateCheck(params: {
    patient: number;
    doctor: number;
    practice?: number;
    treatmentCodes: string;
    issueDate: string;
    currentId?: number;
    icdCode?: number;
    diagnosisGroup?: string;
  }, token?: string): Promise<Array<{ prescriptionId: string; matchType: string; duplikatStatus?: string; id: number }>> {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
    ).toString();
    const { body } = await this.get(`/prescriptions/duplicate-check?${qs}`, { token });
    return body?.member ?? [];
  }

  // ───────────────────────────────── writes ─────────────────────────────────

  /**
   * `POST /prescriptions/{id}/duplikat-status` — the route the board's dropdown posts. The response
   * is the board's own row update: `{prescriptionId, duplikatStatus, duplikatChangedAt}`.
   */
  async setStatus(id: number, status: string, token?: string): Promise<{ status: number; body: any }> {
    return this.post(`/prescriptions/${id}/duplikat-status`, { status }, token);
  }

  async setStatusOk(id: number, status: DuplikatStatus): Promise<void> {
    const res = await this.setStatus(id, status);
    expect(res.status, `POST duplikat-status ${status} on VO ${id}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.duplikatStatus).toBe(status);
  }

  /** `POST /prescriptions/{id}/duplikat-comment` — #3504 AC3. */
  async addComment(id: number, comment: string, token?: string): Promise<{ status: number; body: any }> {
    return this.post(`/prescriptions/${id}/duplikat-comment`, { comment }, token);
  }

  /**
   * Puts a fixture into the process, and returns a restorer that dismisses it again.
   *
   * "Original liegt vor" is the product's own way out (AC6) and takes the VO off the worklist, out of
   * the tile and out of #3506's warning — so both boards return to the state the run found them in.
   * The enum column and the log entries are permanent; there is no clear-to-null route.
   */
  async enterProcess(id: number, status: DuplikatStatus = DUPLIKAT.ANFORDERN): Promise<void> {
    await this.setStatusOk(id, status);
  }

  async dismiss(id: number, status: DuplikatStatus = DUPLIKAT.ORIGINAL_LIEGT_VOR): Promise<void> {
    const res = await this.setStatus(id, status);
    // A cleanup must not mask a real failure, but it also must not throw out of afterAll and hide
    // the assertion that already failed.
    if (200 !== res.status) console.log(`#3501 cleanup: VO ${id} → ${status} answered ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }

  // ───────────────────────────────── oracles ─────────────────────────────────

  /**
   * #3507 AC2, re-implemented rather than read back: **first day of the month after the last
   * treatment, plus 9 months** — i.e. the first of the last-treatment month plus 10 months. The
   * ticket's worked example is 19 Mar 2026 → 1 Jan 2027, which this reproduces.
   */
  static expectedBillingDeadline(lastTreatment: string | null): string | null {
    if (!lastTreatment) return null;
    const [y, m] = lastTreatment.slice(0, 10).split('-').map(Number);
    const total = (y * 12 + (m - 1)) + 10;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  }

  /** Whole days from `today` to the deadline, the sign convention the API uses (negative = overdue). */
  static expectedDaysToDeadline(deadline: string | null, today = new Date()): number | null {
    if (!deadline) return null;
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const [y, m, d] = deadline.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - t) / 86_400_000);
  }

  /**
   * #3507 AC5/AC6's default order, ported from `DuplikatWorklistCandidates::applyDefaultOrder()`:
   * soonest deadline first, deadline-less rows last, higher revenue breaking a tie.
   */
  static applyDefaultOrder<T extends { daysToDeadline: number | null; revenue: number }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => {
      const da = a.daysToDeadline ?? Number.MAX_SAFE_INTEGER;
      const db = b.daysToDeadline ?? Number.MAX_SAFE_INTEGER;
      return da !== db ? da - db : (b.revenue ?? 0) - (a.revenue ?? 0);
    });
  }

  /** #3504 AC2's discriminator, as `useDuplikat.ts` ships it: a status change with no author. */
  static isAutomaticEntry(entry: DuplikatLogEntry): boolean {
    return 'duplikat_status_change' === entry.type && !entry.createdByName;
  }

  // ───────────────────────────────── UI ─────────────────────────────────

  /** `[data-testid]` hooks the two boards expose. */
  static readonly UI = {
    section: 'duplikat-anforderungen-section',
    worklist: 'duplikat-worklist',
    empty: 'duplikat-worklist-empty',
    emptyForStatus: 'duplikat-worklist-empty-for-status',
    chipAll: 'duplikat-chip-alle',
    chip: (status: DuplikatStatus) => `duplikat-chip-${status}`,
    row: (id: number) => `duplikat-row-${id}`,
    pill: (id: number) => `duplikat-pill-${id}`,
    deadlineDays: (id: number) => `duplikat-deadline-days-${id}`,
    historyToggle: (id: number) => `duplikat-history-toggle-${id}`,
    historyPanel: (id: number) => `duplikat-history-panel-${id}`,
    entry: (logId: number) => `duplikat-entry-${logId}`,
    commentInput: (id: number) => `duplikat-comment-input-${id}`,
    commentSubmit: (id: number) => `duplikat-comment-submit-${id}`,
    sort: (key: 'therapist' | 'praxis' | 'deadline') => `duplikat-sort-${key}`,
    tile: 'risk-tile-duplikatOffen',
    tileSubtitle: 'risk-tile-duplikatOffen-subtitle',
    manualEntry: (id: number) => `risk-duplikat-request-${id}`,
  } as const;

  /** The German column headers, in the order `DuplikatWorklist` renders them. */
  static readonly COLUMN_HEADERS = [
    'VO-Nr.',
    'Ausstellungsdatum',
    'Patient:in',
    'Therapeut:in',
    'Praxis',
    'Region',
    'Duplikat-Status',
    'Abrechnung möglich bis',
    'Letzte Aktivität',
    'Wert',
  ] as const;

  /** The ids of every row the worklist has painted, in painted order. */
  async paintedRowIds(): Promise<number[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="duplikat-row-"]')].map((el) =>
        Number(el.getAttribute('data-testid')!.replace('duplikat-row-', '')),
      ),
    );
  }

  /**
   * A chip's selection state. **There is no `aria-checked`** — `accessibilityState={{selected}}`
   * never reaches the DOM (the same React-Native-Web gap #3400 and #3343 found for
   * `aria-expanded`), so the only readable signal is the border colour the selected style sets.
   */
  async chipSelection(): Promise<Array<{ id: string; role: string | null; ariaChecked: string | null; selected: boolean }>> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="duplikat-chip-"]')].map((el) => {
        const h = el as HTMLElement;
        return {
          id: el.getAttribute('data-testid')!,
          role: el.getAttribute('role'),
          ariaChecked: el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected'),
          selected: 'rgb(233, 233, 233)' !== getComputedStyle(h).borderColor,
        };
      }),
    );
  }

  /** The countdown badge's own colour and its pill background, for #3507 AC3. */
  async deadlineBadge(id: number): Promise<{ text: string; color: string; background: string } | null> {
    return this.page.evaluate((testId) => {
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!el) return null;
      return {
        text: el.innerText,
        color: getComputedStyle(el).color,
        background: getComputedStyle(el.parentElement!).backgroundColor,
      };
    }, DuplikatProcessPage.UI.deadlineDays(id));
  }

  /**
   * The status cell's background for one row. A non-billed row renders a `SingleSelectDropdown`
   * whose `dropdownStyle.backgroundColor` is the AC8 colour; a billed row renders a plain pill.
   */
  async statusCellBackground(id: number): Promise<{ status: string | null; background: string | null; interactive: boolean }> {
    return this.page.evaluate((testId) => {
      const row = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!row) return { status: null, background: null, interactive: false };
      const words = /^(Anfordern|Erhalten|Versendet|Abgerechnet|Original liegt vor|Nicht möglich)$/;
      const holders = [...row.querySelectorAll('div')].filter((d) => words.test((d as HTMLElement).innerText || ''));
      const leaf = holders[holders.length - 1] as HTMLElement | undefined;
      const styled = leaf?.closest('[style*="background"]') as HTMLElement | null;
      const pill = row.querySelector('[data-testid^="duplikat-pill-"]') as HTMLElement | null;
      return {
        status: leaf?.innerText ?? null,
        background: pill ? getComputedStyle(pill).backgroundColor : styled ? getComputedStyle(styled).backgroundColor : null,
        interactive: !pill,
      };
    }, DuplikatProcessPage.UI.row(id));
  }

  /** The rendered history panel: one entry per line, with the greyed/italic flag AC2 asks for. */
  async panelEntries(id: number): Promise<Array<{ id: number; text: string; italic: boolean; greyed: boolean }>> {
    return this.page.evaluate((testId) => {
      const panel = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!panel) return [];
      return [...panel.querySelectorAll('[data-testid^="duplikat-entry-"]')].map((el) => {
        const h = el as HTMLElement;
        const first = h.firstElementChild as HTMLElement;
        const style = getComputedStyle(first);
        return {
          id: Number(el.getAttribute('data-testid')!.replace('duplikat-entry-', '')),
          text: h.innerText.replace(/\n/g, ' | '),
          italic: 'italic' === style.fontStyle,
          greyed: 'rgb(34, 34, 34)' !== style.color,
        };
      });
    }, DuplikatProcessPage.UI.historyPanel(id));
  }

  /**
   * Polls `/kpis/duplikat/worklist` until a VO shows the expected status, and returns its row.
   *
   * A Duplikat write is visible on the boards only once `KpiCacheInvalidationListener` has dropped
   * the `kpi_data` entry the two providers cache for 300 s. That happens on the Prescription update,
   * so it IS prompt — but it is not synchronous with the POST: measured at up to 9 s on a loaded
   * staging. Reading the worklist once, straight after the write, therefore fails intermittently
   * with "the VO is not on the worklist", which reads exactly like the row never arriving.
   *
   * Never poll for absence with this — use {@link waitForWorklistWithout}.
   */
  async waitForWorklistRow(prescriptionId: number, status: DuplikatStatus, timeoutMs = 120_000): Promise<DuplikatRow> {
    const deadline = Date.now() + timeoutMs;
    let last: DuplikatRow | undefined;
    for (;;) {
      const rows = await this.worklist();
      last = rows.find((row) => row.prescriptionId === prescriptionId);
      if (last && status === last.duplikatStatus) return last;
      if (Date.now() > deadline) {
        throw new Error(
          `#3501: VO ${prescriptionId} did not reach the worklist as "${status}" within ${timeoutMs} ms ` +
            `(last seen: ${last ? last.duplikatStatus : 'absent'})`,
        );
      }
      await this.page.waitForTimeout(3_000);
    }
  }

  /** The mirror image: polls until a VO has LEFT the open worklist (AC6's dismissals). */
  async waitForWorklistWithout(prescriptionId: number, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await this.worklist();
      if (!rows.some((row) => row.prescriptionId === prescriptionId)) return;
      if (Date.now() > deadline) throw new Error(`#3501: VO ${prescriptionId} never left the worklist within ${timeoutMs} ms`);
      await this.page.waitForTimeout(3_000);
    }
  }

  /**
   * Waits for a board section to paint, retrying its "Erneut versuchen" control when the section
   * renders #3233's error state instead.
   *
   * `/kpis/orga/risks` carries all four tiles' rows and is one of the slowest reads on staging; when
   * it fails, `TherapeutenOrgaRisks` suppresses the tiles AND the worklist by design and shows
   * "Daten konnten nicht geladen werden." — so a plain `toBeVisible` on the worklist waits out its
   * whole timeout and reports "element(s) not found", which reads as the feature being absent.
   */
  async waitForSectionOrRetry(testId: string, attempts = 3, perAttemptMs = 120_000): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const appeared = await this.page
        .getByTestId(testId)
        .waitFor({ state: 'visible', timeout: perAttemptMs })
        .then(() => true)
        .catch(() => false);
      if (appeared) return;

      const retry = this.page.getByText('Erneut versuchen', { exact: true }).first();
      const errored = await retry.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!errored) continue;
      console.log(`#3501: the section failed to load (attempt ${attempt}) — clicking "Erneut versuchen"`);
      await retry.click({ timeout: 30_000 }).catch(() => {});
      await this.page.waitForTimeout(5_000);
    }
    throw new Error(`#3501: "${testId}" never painted — the section kept reporting a failed read`);
  }

  row(id: number): Locator {
    return this.page.getByTestId(DuplikatProcessPage.UI.row(id));
  }
}
