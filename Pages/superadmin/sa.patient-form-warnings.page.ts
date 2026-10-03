import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3806 (GKV insurance-number warning) and #3807 (duplicate warning on last
 * name + birth date) — the two patient-form tickets, tested together because they share
 * `PatientForm.tsx` and both surface in the same three places.
 *
 * **BOTH CHECKS ARE READS THE FORM ITSELF CALLS WHILE TYPING**, which is what makes two
 * tickets about *creating patients* testable without creating one:
 *
 * | | Endpoint | Answers |
 * |---|---|---|
 * | #3806 | `GET /patients/insurance-number-check?number=` | `{matchType: 'bsnr' \| 'lanr' \| null}` |
 * | #3807 | `GET /patients/duplicate-check?firstName=&lastName=&lenient=1&birthDate=` | members carrying `matchType` |
 *
 * So every row of #3807's AC3 table and #3806's BSNR/LANR rows is driven exactly, the
 * way #3576 drove a validation table through the create form's own endpoint.
 *
 * **#3806's OTHER HALF IS CLIENT-SIDE, AND THE DEPLOYED RULE SURVIVES MINIFICATION
 * VERBATIM** — so it is ported from the bundle rather than reconstructed from the AC:
 *
 * ```js
 * y = /^[A-Za-z]\d{9}$/,
 * N = (e,n) => 'public'===n && /^\d{9}$/.test(e.trim()),
 * f = (e,n,t) => { const s = e.trim();
 *   return 'public'!==n || ''===s ? null : null!==t ? t : y.test(s) ? null : 'format' }
 * ```
 *
 * That is AC1 and AC2 entire: the trim, the empty case, the insurance-type gate, the
 * format regex — and `null !== t ? t`, which IS "the BSNR or LANR warning replaces the
 * format warning". `N` also explains why a correct number never costs a lookup: the
 * server is asked only for values that are exactly nine digits.
 *
 * **TRAP — two filters that are silently ignored, so a fixture cannot be confirmed with
 * them:** `/practice_bsnrs?number=` and `/doctors?doctorId=` both return the whole
 * collection (1,459 and 1,946), exactly like a bogus key. The fixtures are therefore
 * validated by WALKING, which also establishes something the AC needs and a filter could
 * not show: that each is unambiguous — 723253500 is a BSNR and not anyone's LANR,
 * 820665702 a LANR and no practice's BSNR. Without that, a number matching both would
 * make the expected warning undefined.
 *
 * **TRAP — do not use a plain 9-digit number as a "format only" example.** `123456789`
 * is itself a BSNR on staging, so it answers `bsnr`; the PM hit this too.
 */

export type InsuranceMatch = 'bsnr' | 'lanr' | null;
export type Warning = 'format' | 'bsnr' | 'lanr' | null;

/** #3806's fixtures, each pinned with the AC1 row it demonstrates. */
export const NUMBERS = {
  /** A practice's MAIN BSNR. */
  mainBsnr: '723253500',
  /** An ADDITIONAL BSNR — AC1 says "main or additional". */
  additionalBsnr: '773748000',
  /** The ticket's own example (patient 8864's number). */
  ticketBsnr: '724432800',
  /** A doctor's LANR. */
  lanr: '820665702',
  /** Nine digits AND a BSNR on staging — never use it as a "format only" case. */
  nineDigitBsnr: '123456789',
} as const;

/** #3807's fixtures: the AC3 table, as the PM seeded it. */
export const DUPLICATE_ROWS = [
  { row: 1, label: 'Anna Mueller (ue)',        first: 'Anna',  last: 'Testmueller FT3807 R1',      expect: 'name_dob',      patient: 99849 },
  { row: 2, label: 'Anna Muller (u)',          first: 'Anna',  last: 'Testmuller FT3807 R2',       expect: 'name_dob',      patient: 99850 },
  { row: 3, label: 'trailing space',           first: 'Anna ', last: 'Testmüller FT3807 R3',       expect: 'name_dob',      patient: 99851 },
  { row: 4, label: 'vs Anna Maria',            first: 'Anna',  last: 'Testmüller FT3807 R4',       expect: 'last_name_dob', patient: 99852 },
  { row: 5, label: 'vs Peter',                 first: 'Anna',  last: 'Testmüller FT3807 R5',       expect: 'last_name_dob', patient: 99853 },
  { row: 6, label: 'first/last swapped',       first: 'Anna',  last: 'Testmüller FT3807 R6',       expect: 'name_dob',      patient: 99854 },
  { row: 7, label: 'hyphen vs none',           first: 'Anna',  last: 'Schmidt-Müller FT3807 R7',   expect: 'name_dob',      patient: 99855 },
  { row: 8, label: 'different birth date',     first: 'Anna',  last: 'Testmüller FT3807 R8',       expect: null,            patient: 99856 },
] as const;

/** #3807 AC2's normalisation table, each case against the patient it must find. */
export const NORMALISATION_ROWS = [
  { rule: 'ä / ae / a',       first: 'Bärbel',  last: 'Testmoller Bar FT3807 N3',     patient: 99859 },
  { rule: 'ö / oe / o',       first: 'Barbel',  last: 'Testmöller Bär FT3807 N3',     patient: 99859 },
  { rule: 'ae/oe base form',  first: 'Baerbel', last: 'Testmoeller Baer FT3807 N3',   patient: 99859 },
  { rule: 'ß / ss',           first: 'Anna',    last: 'Straße FT3807 N1',             patient: 99857 },
  { rule: 'ss base form',     first: 'Anna',    last: 'Strasse FT3807 N1',            patient: 99857 },
  { rule: 'upper / lower',    first: 'anna',    last: 'testmüller ft3807 n2',         patient: 99858 },
  { rule: 'spaces anywhere',  first: 'Anna',    last: 'TestmüllerFT3807R3',           patient: 99851 },
] as const;

export const BIRTH_DATE = '1950-02-01T11:00:00.000Z';

const WEB = 'https://staging.therapios.de';

export class PatientFormWarningsPage {
  private token: string | null = null;
  private bundle: string | null = null;

  constructor(private readonly request: APIRequestContext) {}

  /**
   * Mint a token, retrying a TRANSPORT failure as well as a 5xx.
   *
   * A `socket hang up` THROWS before any status exists, so a retry written only around
   * `res.status() >= 500` never fires and the whole serial describe cascades from one
   * blip (#3872 hit the same thing).
   */
  async authenticate(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.request.post(`${API_BASE}/auth`, {
          headers: { 'Content-Type': 'application/json' },
          data: { username: creds.email, password: creds.password },
          timeout: 60_000,
        });
        if (res.status() >= 500) {
          lastError = new Error(`POST /auth -> ${res.status()}`);
        } else if (!res.ok()) {
          throw new Error(`POST /auth -> ${res.status()}`);
        } else {
          this.token = (await res.json()).token;
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000 * (attempt + 1)));
    }
    throw new Error(`POST /auth failed after 3 attempts: ${String(lastError)}`);
  }

  /** One GET, retrying a 5xx AND a thrown transport error (see {@link authenticate}). */
  async get(path: string): Promise<{ status: number; body: any }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
          timeout: 90_000,
        });
        if (res.status() >= 500) {
          lastError = new Error(`GET ${path} -> ${res.status()}`);
        } else {
          const text = await res.text();
          try {
            return { status: res.status(), body: JSON.parse(text) };
          } catch {
            return { status: res.status(), body: text.slice(0, 300) };
          }
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
    throw new Error(`GET ${path} failed after 3 attempts: ${String(lastError)}`);
  }

  static members(body: any): any[] {
    if (!body || typeof body !== 'object') return [];
    return body.member ?? body['hydra:member'] ?? (Array.isArray(body) ? body : []);
  }

  /** #3806's server half. */
  async insuranceNumberCheck(number: string): Promise<InsuranceMatch> {
    const res = await this.get(`/patients/insurance-number-check?number=${encodeURIComponent(number)}`);
    expect(res.status, `insurance-number-check(${JSON.stringify(number)})`).toBe(200);
    return res.body.matchType ?? null;
  }

  /** #3807's check, exactly as the form issues it. */
  async duplicateCheck(firstName: string, lastName: string, birthDate = BIRTH_DATE): Promise<
    { patientId: number; matchType: string; firstName: string; lastName: string }[]
  > {
    const res = await this.get(
      `/patients/duplicate-check?firstName=${encodeURIComponent(firstName)}` +
        `&lastName=${encodeURIComponent(lastName)}&lenient=1&birthDate=${encodeURIComponent(birthDate)}`,
    );
    expect(res.status, `duplicate-check(${firstName} ${lastName})`).toBe(200);
    return PatientFormWarningsPage.members(res.body);
  }

  /** The served entry bundle — the only surface that answers for a frontend change (#3705). */
  async entryBundle(): Promise<string> {
    if (this.bundle) return this.bundle;
    const shell = await this.request.get(WEB, { timeout: 90_000 });
    expect(shell.status(), 'GET / serves the app shell').toBe(200);
    const name = [
      ...new Set(
        [...(await shell.text()).matchAll(/\/_expo\/static\/js\/web\/(entry-[A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]),
      ),
    ][0];
    expect(name, 'the shell references an entry bundle').toBeTruthy();
    const js = await this.request.get(`${WEB}/_expo/static/js/web/${name}`, { timeout: 180_000 });
    expect(js.status(), `GET ${name}`).toBe(200);
    this.bundle = await js.text();
    return this.bundle;
  }

  /**
   * Occurrences of a literal, counted in BOTH forms.
   *
   * The bundle escapes non-ASCII — below 256 as `\xNN`, above as `\uXXXX` — so a plain
   * search for a German string can return 0 and read exactly like "never shipped"
   * (#3611, #3873).
   */
  async occurrences(literal: string): Promise<number> {
    const js = await this.entryBundle();
    const plain = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escaped = [...literal]
      .map((ch) => {
        const code = ch.codePointAt(0)!;
        if (code < 128) return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return code < 256
          ? `\\\\x${code.toString(16).padStart(2, '0')}`
          : `\\\\u${code.toString(16).padStart(4, '0')}`;
      })
      .join('');
    const count = (pattern: string) => (js.match(new RegExp(pattern, 'g')) ?? []).length;
    return count(plain) + (escaped === plain ? 0 : count(escaped));
  }

  /**
   * The shipped client rule, read out of the bundle and returned as a pure function.
   *
   * Ported rather than reconstructed from the AC: the source survives minification, so
   * this is the DEPLOYED rule. `serverMatch` is what the lookup answered — the third
   * argument of the real `getInsuranceNumberWarning`.
   */
  async warningRule(): Promise<{
    source: string;
    warn: (value: string, insuranceType: string, serverMatch: InsuranceMatch) => Warning;
    looksUp: (value: string, insuranceType: string) => boolean;
  }> {
    const js = await this.entryBundle();
    const anchor = js.indexOf('^[A-Za-z]');
    expect(anchor, 'the format regex is in the bundle').toBeGreaterThan(-1);
    const source = js.slice(Math.max(0, anchor - 40), anchor + 260);
    expect(source, 'the shipped format regex').toContain('/^[A-Za-z]\\d{9}$/');
    expect(source, 'the lookup is gated on exactly nine digits').toContain('/^\\d{9}$/');

    const format = /^[A-Za-z]\d{9}$/;
    return {
      source,
      warn: (value, insuranceType, serverMatch) => {
        const trimmed = value.trim();
        if (insuranceType !== 'public' || trimmed === '') return null;
        if (serverMatch !== null) return serverMatch;
        return format.test(trimmed) ? null : 'format';
      },
      looksUp: (value, insuranceType) => insuranceType === 'public' && /^\d{9}$/.test(value.trim()),
    };
  }

  /** Walk a collection to completion; several of these ignore their filters. */
  async walk(path: string): Promise<any[]> {
    const sep = path.includes('?') ? '&' : '?';
    let rows: any[] = [];
    for (let page = 1; page <= 60; page++) {
      const res = await this.get(`${path}${sep}itemsPerPage=100&page=${page}`);
      const batch = PatientFormWarningsPage.members(res.body);
      if (!batch.length) break;
      rows = rows.concat(batch);
      if (rows.length >= (res.body?.totalItems ?? 0)) break;
    }
    return rows;
  }
}
