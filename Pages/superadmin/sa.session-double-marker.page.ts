import { Page, expect } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS, mintUiSession, type Credentials } from '../util/api-token';

/**
 * Doppelbehandlung marked and timed as double on every session list — RC 3.14 #3711, commit
 * `871ab6cc1` on `release/3.14.0` (a `Ref #3711` trailer, no PR).
 *
 * ## Two halves, and the API half is a WHOLE NEW RESOURCE
 *
 * Two of the five surfaces the ticket names did not exist and were built by the commit — the
 * Patient Management session table and the Berichte session export — both reading a new
 * admin-only **`GET /prescriptions/session-report`** backed by `TreatmentSessionRow` /
 * `SessionReportProvider`. A brand-new resource answering at all is therefore an unambiguous
 * deployment probe for the API half, which `/status` could not give (it reports the release, not
 * the commit — #3704).
 *
 * The row is deliberately shaped so no client can get the arithmetic wrong:
 *
 *  - **`durationMinutes` is `Activity::getCalculatedTreatmentDuration()` VERBATIM** — already
 *    doubled for a legacy (V1) Doppel VO, already NOT doubled for a V2 one, whose doubling lives
 *    in `ActivityTreatment::quantity`. "Never multiply this client-side."
 *  - **`doubleTreatment` is the MARKER, not the arithmetic** — true for a V1 and a V2 double
 *    alike, so both render the same tag while their minutes legitimately differ.
 *
 * ## Traps
 *
 *  - **The tag is CSS-uppercased.** `DoubleTreatmentTag` sets `textTransform: 'uppercase'`, so
 *    `innerText` reads `DOPPELBEHANDLUNG ×2 · 60 MIN` while `textContent` keeps the real string
 *    (#3718). Read `textContent`, or match case-insensitively.
 *  - **The `×` is U+00D7, not the letter x.** The ticket writes "Doppelbehandlung x2"; the shipped
 *    string is `Doppelbehandlung ×2`, and the bundle escapes it as `\xd7` (#3666's `÷`).
 *  - **The new keys are NOT where the ticket's Localization Reference implies.** They live at
 *    `common.double_treatment_x2*`, `patients.form.session*` and `reports.*`; the pre-existing
 *    Flow-Boards key is `therapist_board.double_treatment_x2` and is untouched — so the commit
 *    added a SECOND key holding the same German rather than reusing the first (see the finding).
 *  - **`activity.doubleTreatment` is `true`, `false`, or OMITTED on the same VO** (#3602), so only
 *    `=== true` is safe when building the expectation the report is checked against.
 *  - **An unknown filter on this endpoint returns 0, not everything** — unlike `/prescriptions`,
 *    where an unregistered filter is ignored and the whole book comes back. The endpoint fails
 *    closed: no selection, no rows.
 *  - **Never `page.reload()` after `mintUiSession`** (single-use refresh token, #3460) — the
 *    patient form is therefore reached with ONE `goto` straight to its URL.
 */

/** The new session-level resource both built surfaces read. */
export const SESSION_REPORT = '/prescriptions/session-report';

/** The tag's German text, with the real multiplication sign. */
export const TAG_TEXT = 'Doppelbehandlung ×2';

/**
 * The screen fixture: patient 3019 (Ka-Ming Lau) holds exactly 13 sessions, all on VO 4056-1,
 * twelve of them single at 30 minutes and ONE double at 60 — and the double is the tenth by date,
 * so it lands on the session table's first page. Same VO, same Heilmittel, only the flag differs,
 * which is what makes AC4's "no marker, undoubled duration" a control rather than a second claim.
 */
export const SCREEN_FIXTURE = {
  patientId: 3019,
  vo: '4056-1',
  singleMinutes: 30,
  doubleMinutes: 60,
  doubleSessionDate: '20.08.2025',
} as const;

/** A second, richer mixed VO for the API half: 5 sessions, 2 single at 20 and 3 double at 40. */
export const MIXED_VOS = [
  { vo: '3568-9', prescriptionId: 13888, patientId: 2426 },
  { vo: '1281-16', prescriptionId: 4972, patientId: 756 },
  { vo: '1503-25', prescriptionId: 4837, patientId: 494 },
] as const;

export type SessionRow = {
  id: number;
  patientName: string;
  prescriptionId: string | null;
  sessionDate: string;
  heilmittelCodes: string;
  therapistName: string;
  durationMinutes: number | null;
  doubleTreatment: boolean;
};

export type TableRow = {
  date: string;
  vo: string;
  heilmittel: string;
  therapist: string;
  duration: string;
  /** The tag's `textContent`, or null when the row carries none. */
  tag: string | null;
};

export class SessionDoubleMarkerPage {
  private static tokens = new Map<string, string>();

  constructor(private page: Page) {}

  async bearer(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    const cached = SessionDoubleMarkerPage.tokens.get(credentials.email);
    if (cached) return cached;
    const res = await this.page.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth as ${credentials.email} -> ${res.status()}`);
    const token = (await res.json()).token as string;
    SessionDoubleMarkerPage.tokens.set(credentials.email, token);
    return token;
  }

  private async get<T>(path: string, credentials?: Credentials): Promise<{ status: number; body: T }> {
    const res = await this.page.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer(credentials)}`, Accept: 'application/ld+json' },
      timeout: 240_000,
    });
    return { status: res.status(), body: (await res.json().catch(() => null)) as T };
  }

  // ───────────────────────────── the session report ─────────────────────────────

  async sessionReport(query: string, credentials?: Credentials): Promise<{ status: number; rows: SessionRow[]; total: number }> {
    const { status, body } = await this.get<{ member?: SessionRow[]; totalItems?: number }>(
      `${SESSION_REPORT}${query}`,
      credentials,
    );
    return { status, rows: body?.member ?? [], total: body?.totalItems ?? 0 };
  }

  async sessionsForPatient(patientId: number): Promise<SessionRow[]> {
    return (await this.sessionReport(`?patient=${patientId}`)).rows;
  }

  /** `dd.mm.yyyy` → a sortable ISO string, since the row serializes German dates. */
  static iso(germanDate: string): string {
    const [d, m, y] = germanDate.split('.');
    return `${y}-${m}-${d}`;
  }

  /**
   * The per-session double flags straight off `/activities`, which is the source the report must
   * agree with.
   *
   * The field is omitted when false (#3602), so `=== true` is the only safe read and the map is
   * built as `date -> boolean` rather than by trusting presence.
   */
  async sessionFlags(prescriptionId: number): Promise<Map<string, boolean>> {
    const { body } = await this.get<{ member?: Record<string, any>[] }>(
      `/activities?prescription=${prescriptionId}&itemsPerPage=200`,
    );
    const out = new Map<string, boolean>();
    for (const a of body?.member ?? []) {
      out.set(String(a.date).slice(0, 10), a.doubleTreatment === true);
    }
    return out;
  }

  /** Whether a VO uses the newer split representation, where the report must NOT double. */
  async isV2(prescriptionNumber: string): Promise<{ exists: boolean; v1: boolean; v2: boolean }> {
    const { body } = await this.get<{ member?: Record<string, any>[] }>(
      `/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(prescriptionNumber)}&itemsPerPage=1`,
    );
    const vo = body?.member?.[0];
    return {
      exists: Boolean(vo),
      v1: vo?.doubleTreatment === true && vo?.doubleTreatmentV2 !== true,
      v2: vo?.doubleTreatmentV2 === true,
    };
  }

  // ───────────────────────────── the patient session table ─────────────────────────────

  /**
   * Opens a patient's form straight at its URL.
   *
   * ONE navigation, deliberately: `mintUiSession` writes a single-use refresh token, so a second
   * `goto` or a `reload` lands on the login form (#3460). Searching the patient list and clicking
   * through would also take the FIRST name match — `openPatientDetail('Seidel')` opens Alfred, not
   * Enrico — so the id is addressed directly.
   */
  async openPatientSessions(patientId: number): Promise<void> {
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto(`https://staging.therapios.de/patient-management/${patientId}/edit`, {
      waitUntil: 'domcontentloaded',
    });
    await this.page.getByText('Behandlungen', { exact: true }).first().waitFor({ timeout: 90_000 });
    await expect
      .poll(async () => (await this.sessionTableRows()).length, { timeout: 60_000, intervals: [1500] })
      .toBeGreaterThan(0);
  }

  /**
   * The rendered "Behandlungen" table, one entry per painted row.
   *
   * Read by geometry from the section heading down, because the table carries no testids: cells
   * are grouped into rows by their y band and assigned to columns by the header x positions.
   */
  async sessionTableRows(): Promise<TableRow[]> {
    return await this.page.evaluate(() => {
      const leaves = [...document.querySelectorAll('div,span')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim(),
      ) as HTMLElement[];
      const heading = leaves.find((e) => (e.textContent || '').trim() === 'Behandlungen');
      if (!heading) return [];
      const top = heading.getBoundingClientRect().top;
      const header = leaves.find((e) => (e.textContent || '').trim() === 'Datum' && e.getBoundingClientRect().top > top);
      if (!header) return [];
      const headerTop = header.getBoundingClientRect().top;
      const columns = leaves
        .filter((e) => Math.abs(e.getBoundingClientRect().top - headerTop) < 6)
        .map((e) => ({ name: (e.textContent || '').trim(), x: e.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x);

      const body = leaves
        .filter((e) => e.getBoundingClientRect().top > headerTop + 6)
        .map((e) => ({ t: (e.textContent || '').trim(), r: e.getBoundingClientRect() }))
        .filter((c) => c.r.width > 0 && /\S/.test(c.t));

      // Rows are anchored on their DATE cell and gathered by vertical OVERLAP, not by a rounded
      // band: the Doppelbehandlung tag is a chip with its own padding, so it sits a few pixels off
      // its row's baseline and a band key drops it into a row of its own — which reads as "no row
      // is tagged" on a build where every row is tagged correctly.
      const anchors = body
        .filter((c) => /^\d{2}\.\d{2}\.\d{4}$/.test(c.t))
        .sort((a, b) => a.r.top - b.r.top);

      // The LAST row needs a floor of its own, or it swallows everything painted below the table —
      // the app's nav chrome sits at a greater `top` than a scrolled-up table, so an unbounded last
      // row reports "▾ | Berichte" as its VO and therapist.
      const pitch =
        anchors.length > 1
          ? Math.min(...anchors.slice(1).map((a, i) => a.r.top - anchors[i].r.top))
          : 80;

      const out: TableRow[] = [];
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const nextTop = i + 1 < anchors.length ? anchors[i + 1].r.top : anchor.r.top + pitch;
        const inRow = body.filter((c) => {
          const mid = c.r.top + c.r.height / 2;
          return mid >= anchor.r.top - 8 && mid < nextTop - 8;
        });
        const pick = (name: string) => {
          const col = columns.find((c) => c.name === name);
          if (!col) return '';
          const hit = inRow.find((c) => Math.abs(c.r.left - col.x) < 60 && !/Doppelbehandlung/i.test(c.t));
          return hit ? hit.t : '';
        };
        const tag = inRow.find((c) => /Doppelbehandlung/i.test(c.t));
        out.push({
          date: anchor.t,
          vo: pick('VO Nummer'),
          heilmittel: pick('Heilmittel'),
          therapist: pick('Therapeut'),
          duration: pick('Dauer'),
          tag: tag ? tag.t : null,
        });
      }
      return out;
    });
  }

  /** Every Doppelbehandlung tag on the page, in both readings — the CSS-uppercase trap. */
  async tags(): Promise<{ textContent: string; innerText: string }[]> {
    return await this.page.evaluate(() =>
      [...document.querySelectorAll('div,span')]
        .filter((e) => e.children.length === 0 && /Doppelbehandlung/i.test(e.textContent || ''))
        .map((e) => ({ textContent: (e.textContent || '').trim(), innerText: (e as HTMLElement).innerText })),
    );
  }
}
