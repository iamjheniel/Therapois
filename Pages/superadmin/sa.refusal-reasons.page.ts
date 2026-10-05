import type { APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3899 + #3908 — two defects from the 2026-10-01 Sentry triage, both of the same shape:
 * a refusal that does not say why.
 *
 *  - **#3899** (`d2e9511456a`, `582f91a9b00`): five different server rules all reported on
 *    `propertyPath: prescription`, and the client deliberately sends only field names to Sentry,
 *    so 416 events across 101 users could not be told apart. Each refusal now carries a stable
 *    `code`.
 *  - **#3908** (`0980fe59cbb`): the "Heilmittel hinzufügen" picker offered Heilmittel already on
 *    the session, the API always refused, and the toast said only "HTTP 422".
 *
 * Both halves are reachable: the API's by making a save the rule MUST refuse (so nothing is
 * written), the client's by reading the served bundle.
 */

export const API_BASE = 'https://api.staging.therapios.de';
export const WEB_BASE = 'https://staging.therapios.de';

/** #3899 AC3's own filter, as `violationDigest` ships it. */
export const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export type Violation = { propertyPath: string; code?: string; message?: string; value?: unknown };

export class RefusalReasonsPage {
  private token: string | null = null;
  private js: string | null = null;

  constructor(private request: APIRequestContext) {}

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await this.request.post(`${API_BASE}/auth`, {
          headers: { 'Content-Type': 'application/json' },
          data: {
            username: STAGING_CREDENTIALS.superadmin.email,
            password: STAGING_CREDENTIALS.superadmin.password,
          },
          timeout: 60_000,
        });
        if (res.ok()) {
          this.token = (await res.json()).token as string;
          return this.token;
        }
      } catch {
        /* a connect timeout throws before any status exists */
      }
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    throw new Error('POST /auth failed');
  }

  private async get<T = any>(path: string): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
          timeout: 180_000,
        });
        if (res.ok()) return (await res.json()) as T;
        last = `status ${res.status()}`;
        if (res.status() < 500) break;
      } catch (e) {
        last = String(e).slice(0, 100);
      }
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    throw new Error(`GET ${path}: ${last}`);
  }

  /**
   * A VO that has used every prescribed treatment, so an activity save on it MUST be refused.
   *
   * That is what makes this safe: the request is a write whose only correct outcome is a 422, so
   * a passing run creates nothing. Picking a VO that could succeed would create a real Activity.
   */
  async voAtMaxTreatments(): Promise<{ id: number; number: string; therapistId: number } | null> {
    const b = await this.get<{ member: any[] }>(
      '/prescriptions?treatmentStatus=Fertig%20Behandelt&itemsPerPage=150',
    );
    for (const v of b.member ?? []) {
      const therapist = RefusalReasonsPage.idOf(v.therapist);
      if (Number(v.remainingTreatments ?? -1) === 0 && therapist) {
        return { id: Number(v.id), number: String(v.prescriptionId), therapistId: therapist };
      }
    }
    return null;
  }

  /**
   * Attempt one activity row through the bulk endpoint.
   *
   * TRAPS: the payload is a BARE ARRAY (wrapped in `{activities: […]}` it answers 400 "expected a
   * JSON array"), and each row needs a **`therapist` IRI** — the VO serializes its therapist as an
   * OBJECT, so passing it straight through answers 400 "item 0 is missing a therapist IRI", which
   * reads like the endpoint rejecting the row on its merits (#3672).
   */
  async attemptActivity(voId: number, therapistId: number, date: string): Promise<{ status: number; violations: Violation[]; raw: string }> {
    const res = await this.request.fetch(`${API_BASE}/activities/bulk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': 'application/json' },
      data: [
        {
          prescription: `/prescriptions/${voId}`,
          therapist: `/users/${therapistId}`,
          date,
          treatmentType: 'done',
        },
      ],
      timeout: 120_000,
    });
    const raw = await res.text();
    let violations: Violation[] = [];
    try {
      violations = JSON.parse(raw).violations ?? [];
    } catch {
      /* not a violation body */
    }
    return { status: res.status(), violations, raw: raw.slice(0, 400) };
  }

  /** The deployed web bundle, for the client halves of both tickets. */
  async bundle(): Promise<string> {
    if (this.js !== null) return this.js;
    const page = await this.request.get(WEB_BASE, { timeout: 120_000 });
    const html = await page.text();
    const chunks = [...new Set([...html.matchAll(/src="([^"]*entry[^"]*\.js)"/g)].map((m) => m[1]))];
    let js = '';
    for (const c of chunks) {
      const res = await this.request.get(c.startsWith('http') ? c : `${WEB_BASE}${c}`, { timeout: 120_000 });
      if (res.ok()) js += await res.text();
    }
    this.js = js;
    return js;
  }

  /**
   * Occurrences in the served bundle, counting BOTH the plain and the `\xNN`/`\uXXXX` escaped
   * forms — the build escapes non-ASCII, so a German literal searched plainly returns 0 and reads
   * exactly like "never shipped" (#3337, #3611, #3873).
   */
  async occurrences(s: string): Promise<number> {
    const js = await this.bundle();
    const escaped = Array.from(s)
      .map((ch) => {
        const n = ch.charCodeAt(0);
        if (n < 128) return ch;
        return n < 256 ? `\\x${n.toString(16)}` : `\\u${n.toString(16).padStart(4, '0')}`;
      })
      .join('');
    return (js.split(s).length - 1) + (escaped === s ? 0 : js.split(escaped).length - 1);
  }

  /** A window of the bundle around a literal, for reading shipped logic. */
  async context(needle: string, before = 300, after = 400): Promise<string | null> {
    const js = await this.bundle();
    const i = js.indexOf(needle);
    return i < 0 ? null : js.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' ');
  }

  static idOf(iri: unknown): number | null {
    if (typeof iri === 'string') {
      const n = Number(iri.split('/').pop());
      return Number.isFinite(n) ? n : null;
    }
    if (iri && typeof iri === 'object' && 'id' in (iri as any)) return Number((iri as any).id);
    return null;
  }
}
