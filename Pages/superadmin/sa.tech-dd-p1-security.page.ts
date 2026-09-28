import { APIRequestContext, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The tech-DD P1 security batch — RC 3.14, all six tickets in PR **#3748** (`task/tech-dd-p1`,
 * merged to `release/3.14.0` 2026-09-21, merge commit `d8f17bd13`).
 *
 * | Ticket | Commit | What it closes |
 * |---|---|---|
 * | #3545 | `8a8ecc4f1` | `GET /prescriptions/reports-data` served any facility's roster to any `ROLE_USER` |
 * | #3546 | `2927b5c41` | `GET /therapist-prescription-groups` forwarded `?therapist=` unchecked |
 * | #3547 | `7ad138c30` | `PrescriptionImage` / `Document` ran at bare `ROLE_USER` |
 * | #3552 | `d6961534e` | Eight raw file-download routes relied on path unguessability |
 * | #3692 | `c320c9d0c` | No secret scanning in pre-commit or CI (SEC-08) |
 * | #3736 | `5d652173f` | Password-only authentication (SEC-06) |
 *
 * **Read-only and deliberately non-exfiltrating.** Every assertion here is a STATUS CODE or a
 * COUNT. These four authorization tickets are about Article 9 patient data, so verifying them means
 * showing the door is shut — never walking through it and printing what is inside. No patient name,
 * roster row or file byte is read or logged by this file.
 *
 * ## Traps, and the first one cost a false finding before it was understood
 *
 *  - **#3545 needs FOUR query parameters, and returns `[]` BEFORE the gate if any is missing.**
 *    `ReportsDataProvider` reads `startDate`, `endDate`, `elderlyCareHome` and `department`, and
 *    `return []`s on the first missing one — so an incomplete request is answered **200 with zero
 *    rows** and the access check never runs. A probe built from the ticket's own wording (which says
 *    `?ech=<id>` + department) therefore sees 200 for a facility the therapist has nothing to do
 *    with, and reads exactly like the fix being absent. It is not: with all four supplied the gate
 *    fires. The parameter is **`elderlyCareHome`**, not `ech`.
 *  - **#3552's path is a URL SEGMENT, not a query parameter** — `/document/download/{path}` with
 *    `requirements: ['path' => '.+']`. A `?path=` probe answers **404** and reads like the route
 *    having been removed, when the guard was never reached.
 *  - **#3547 denies with 404, not 403** — deliberately, "as for the scoped item read", so a caller
 *    cannot learn that a row exists. A test expecting 403 reports a working gate as broken.
 *  - **#3736: never enrol 2FA on the shared QA accounts.** An enrolment would make every other spec
 *    in this suite unable to log in, and only a super-admin reset could undo it. Everything here is
 *    a read or a method probe.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** The four parameters `ReportsDataProvider` requires before its gate is reached (#3545). */
export const REPORT_PARAMS = { startDate: '2026-06-01', endDate: '2026-09-30', department: 'Physiotherapie' } as const;

/** The seven `access_control` routes #3552 puts behind an HMAC signature. */
export const SIGNED_DOWNLOAD_ROUTES = [
  'prescription_image',
  'prescription_back_image',
  'document',
  'copayment_exemption',
  'patient_document',
  'ib_record',
  'pre_treatment_notice',
] as const;

/** The eighth route, gated in-body on `ROLE_SUPER_ADMIN` instead — it takes no signature. */
export const EXPORT_DOWNLOAD_ROUTE = 'prescription_export';

/** #3736's endpoints. All POST-only, so a GET answering 405 is the presence probe. */
export const TWO_FACTOR_ROUTES = [
  '/me/2fa/enroll',
  '/me/2fa/confirm',
  '/me/2fa/recovery-codes',
  '/me/2fa/disable',
] as const;

export type Me = { id: number; roles: string[]; twoFactorEnabled?: boolean };

export class TechDdP1SecurityPage {
  private tokens = new Map<string, string>();

  constructor(private request: APIRequestContext) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async token(creds: Credentials): Promise<string> {
    const hit = this.tokens.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    const token = (await res.json()).token as string;
    this.tokens.set(creds.email, token);
    return token;
  }

  adminToken = () => this.token(STAGING_CREDENTIALS.superadmin);
  therapistToken = () => this.token(STAGING_CREDENTIALS.therapist);

  async me(token: string): Promise<Me> {
    const res = await this.request.get(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 60_000,
    });
    expect(res.status(), 'GET /me').toBe(200);
    const body = await res.json();
    return { id: body.id, roles: body.roles ?? [], twoFactorEnabled: body.twoFactorEnabled };
  }

  // ─────────────────────────────── plumbing ───────────────────────────────

  /**
   * A status code, retrying a 5xx.
   *
   * These are authorization assertions, so a 504 must never be read as a verdict: it would look
   * like a denial. Only a 4xx/2xx answers the question.
   */
  async status(
    path: string,
    opts: { token?: string | null; method?: 'GET' | 'POST'; base?: string } = {},
  ): Promise<number> {
    const { token, method = 'GET', base = API_BASE } = opts;
    const headers: Record<string, string> = { Accept: 'application/ld+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let last = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res =
        method === 'GET'
          ? await this.request.get(`${base}${path}`, { headers, timeout: 180_000 })
          : await this.request.post(`${base}${path}`, { headers, data: {}, timeout: 180_000 });
      last = res.status();
      if (last < 500) return last;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
    return last;
  }

  /** `totalItems` for a collection, or null when the payload does not carry one. */
  async total(path: string, token: string): Promise<number | null> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 240_000,
    });
    if (res.status() !== 200) return null;
    const body = await res.json().catch(() => null);
    return typeof body?.totalItems === 'number' ? body.totalItems : null;
  }

  /** The raw body of a refusal, so it can be checked for leaked detail. Never logged wholesale. */
  async refusalBody(path: string, token: string): Promise<string> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    return (await res.text()).slice(0, 600);
  }

  // ─────────────────────────── #3545 facility report ───────────────────────

  /** The report path with all four required parameters — anything less never reaches the gate. */
  reportPath(facilityId: number | string): string {
    const p = REPORT_PARAMS;
    return `/prescriptions/reports-data?startDate=${p.startDate}&endDate=${p.endDate}&department=${encodeURIComponent(p.department)}&elderlyCareHome=${facilityId}`;
  }

  /**
   * Facilities where a therapist has at least one ACTIVE VO, and some where they have none.
   *
   * `therapistHasActiveAtFacility()` is the shipped predicate (own, non-deleted, ACTIVE), so the
   * fixture is derived from the same three conditions rather than hardcoded — a therapist's
   * caseload moves, and a stale fixture would silently test the wrong arm.
   */
  async facilitiesFor(therapistId: number, adminToken: string): Promise<{ withActive: number[]; counts: Record<number, number> }> {
    const res = await this.request.get(
      `${API_BASE}/prescriptions?therapist=${therapistId}&treatmentStatus=Aktiv&itemsPerPage=100`,
      { headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/ld+json' }, timeout: 240_000 },
    );
    expect(res.status(), 'reading the therapist caseload').toBe(200);
    const body = await res.json();
    const counts: Record<number, number> = {};
    for (const vo of body.member ?? []) {
      const id = vo?.elderlyCareHome?.id;
      if (typeof id === 'number') counts[id] = (counts[id] ?? 0) + 1;
    }
    return { withActive: Object.keys(counts).map(Number), counts };
  }

  // ─────────────────────────── #3552 download routes ───────────────────────

  /** `/{resource}/download/{path}` — the path is a SEGMENT, which is the trap. */
  downloadPath(resource: string, storagePath = 'some/made-up/path.pdf'): string {
    return `/${resource}/download/${storagePath}`;
  }

  // ─────────────────────────── #3692 repo/CI state ─────────────────────────

  /**
   * A file from the monorepo at a ref, through `gh`.
   *
   * #3692 is a repository control with no runtime surface, so the only way to verify it from here
   * is to read the repo. Needs `GITHUB_TOKEN` or a logged-in `gh`; callers gate rather than fail
   * when neither is available, because an unauthenticated 404 is indistinguishable from "absent".
   */
  static repoFile(path: string, ref = 'release/3.14.0'): string | null {
    try {
      const out = execFileSync(
        'gh',
        ['api', `repos/therapios/monorepo/contents/${path}?ref=${ref}`, '--jq', '.content'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return Buffer.from(out.trim(), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  static ghAvailable(): boolean {
    return TechDdP1SecurityPage.repoFile('README.md') !== null;
  }
}
