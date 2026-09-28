import { APIRequestContext, Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * The VO-creation form's Insurance Type pre-fill from a prescription scan (RC 3.14 #3710,
 * commit `bbee3b6a5`).
 *
 * A "Selbstzahler" scan only says the patient pays out of pocket; it does not distinguish PKV from
 * Privat Basis, and the form guessed **Privat Basis** every time, outranking the patient's own
 * stored insurance type. The fix makes the patient's value win for that one scan result, leaves the
 * field empty with a hint when the patient has none, and adds a second hint for a Blanko VO on a
 * Privat Basis patient. Named insurers, GKV and BG are untouched.
 *
 * ## The ticket is FRONTEND-ONLY, so `GET /status` cannot answer for it at all
 *
 * The API is on `3.14.0` and `bbee3b6a5` is an ancestor of `release/3.14.0` — and the change is
 * still **not in the served bundle**. The app bundle deploys independently (#3705), and this
 * ticket changes nothing on the API side, so the only surface that can decide deployment is the
 * bundle itself: `deploymentState()` looks for the two i18n keys and their German values, with the
 * sibling #3383 key `differs_from_patient_insurance` as the control that proves the same dictionary
 * section is present and merely lacks these additions.
 *
 * **Do not probe for `isSelfPayerScan`** — a function name is renamed by minification, so 0
 * occurrences would prove nothing either way. i18n keys and string literals survive.
 *
 * ## The rule is a pure function, so both versions of it are ported here
 *
 * `resolvePrefill()` implements the pre-fix and post-fix rules side by side, exactly as
 * `mapExtractionToFormValues` + `resolveInsurancePrefill` do — and the two together are what decide
 * what the form should show. Comparing the painted value against BOTH is how deployment is read off
 * behaviour rather than off a version string (the #3704 dual-oracle technique), and it is also what
 * makes a fixture's usefulness measurable: on a patient already stored `privat_basis` the two rules
 * agree, so that VO is **not evidence of anything**.
 *
 * ## Fixture facts that decide what can be tested (measured 2026-09-17)
 *
 *  - `extractedData.insuranceType.value` is **the raw AI text for older scans and the mapped enum
 *    for newer ones** — `'Selbstzahler'`, `'Privat'`, `'GKV'`, `'PKV'`, `'BG'` alongside `'public'`
 *    and `'private'`. **`privat_basis` never appears in stored data**; the collapse to it happens in
 *    the frontend's `mapInsuranceType()`. A probe that greps the API for `privat_basis` finds zero
 *    and reads as "no Selbstzahler scans exist" when nine do.
 *  - `getUsableScannedInsuranceType()` additionally gates on **confidence** — an unusable
 *    confidence makes the scan contribute nothing at all, so neither the pre-fill nor the AC2 hint
 *    fires. No AC mentions this third branch.
 *  - **`/patients?insuranceType=` is silently IGNORED** (every value returns all 8,384 patients), so
 *    a patient's stored type has to be read per patient.
 *  - Only `status=pending_review` images are still awaiting a VO, which is the population this
 *    ticket's flow acts on.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** `InsuranceType` — the enum the form and the mapper both speak. */
export const INSURANCE = {
  public: 'public',
  private: 'private',
  privatBasis: 'privat_basis',
  accident: 'accident',
} as const;

/** What the form paints for each enum value, as the German dropdown renders it. */
export const INSURANCE_LABEL: Record<string, string> = {
  public: 'GKV',
  private: 'PKV',
  privat_basis: 'Privat Basis',
  accident: 'BG',
};

/** The two keys #3710 adds, with the German that actually shipped. */
export const HINTS = {
  selfPayerKey: 'self_payer_choose_insurance',
  selfPayerDe: 'Selbstzahler erkannt: bitte PKV oder Privat Basis wählen.',
  selfPayerEn: 'Selbstzahler detected: choose PKV or Privat Basis.',
  blankoKey: 'blanko_privat_basis_hint',
  blankoDe: 'Blanko-VOs gelten möglicherweise nicht für Privat Basis. Bitte den Heilmittel-Typ prüfen.',
  blankoEn: 'Blanko VOs may not apply to Privat Basis. Please check the Heilmittel type.',
  /** #3383's badge — the control for the bundle probe, and the on-screen symptom of the bug. */
  differsKey: 'differs_from_patient_insurance',
  differsDe: 'Weicht von der Versicherung des Patienten ab',
} as const;

/**
 * Live fixtures, re-derived by the spec rather than trusted.
 *
 * **The discriminating ones are the point.** A Selbstzahler scan on a patient stored `privat_basis`
 * produces "Privat Basis" on either build, so it proves nothing; only a patient stored **PKV**
 * separates the old guess from the new rule.
 */
export const FIXTURES = {
  /** AC1, discriminating: Selbstzahler scan, patient stored PKV. Pre-fix shows Privat Basis, post-fix must show PKV. */
  selfPayerPkvPatient: { imageId: 10589, patientId: 5389, patientName: 'Katharina Overath', stored: INSURANCE.private },
  /** AC1, second discriminating fixture on a different patient. */
  selfPayerPkvPatient2: { imageId: 12133, patientId: 5287, patientName: 'Gertrud Gehrt', stored: INSURANCE.private },
  /** AC1, NOT discriminating — both rules say Privat Basis. Kept so nobody mistakes it for evidence. */
  selfPayerBasisPatient: { imageId: 11181, patientId: 7368, patientName: 'Christine Beyer', stored: INSURANCE.privatBasis },
  /** AC3: a named private insurer still pre-fills PKV. */
  namedInsurer: { imageId: 14180, patientId: 1957, insurer: 'DKV', expected: INSURANCE.private },
  /** AC4, discriminating: a BG scan on a patient stored GKV — the scan must still win. */
  bgScanGkvPatient: { imageId: 12342, patientId: 7580, stored: INSURANCE.public, expected: INSURANCE.accident },
} as const;

export type Extraction = {
  imageId: number;
  rawInsuranceType: string | null;
  confidence: number | null;
  blanko: boolean | null;
  patientId: number | null;
  patientName: string | null;
  insurerName: string | null;
  matchStatus: string | null;
  extractionStatus: string | null;
};

export class ScanInsurancePrefillPage {
  private bearerCache = new Map<string, string>();

  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async tokenFor(creds: Credentials): Promise<string> {
    const hit = this.bearerCache.get(creds.email);
    if (hit) return hit;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth failed for ${creds.email}: ${res.status()}`);
    const token = (await res.json()).token as string;
    this.bearerCache.set(creds.email, token);
    return token;
  }

  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.admin);

  private async get<T>(path: string, token: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  // ───────────────────────── the rule, both versions ─────────────────────────

  /**
   * A port of the frontend's `mapInsuranceType()`.
   *
   * Note both spellings are accepted for every case, because stored extractions carry the raw
   * German text on older rows and the mapped enum on newer ones.
   */
  static mapInsuranceType(value: string | null | undefined): string | null {
    if (!value) return null;
    const v = String(value).toLowerCase();
    if (v === INSURANCE.public || v === 'gkv') return INSURANCE.public;
    if (v === INSURANCE.private || v === 'pkv') return INSURANCE.private;
    if (v === INSURANCE.privatBasis || v === 'privat basis' || v === 'selbstzahler' || v === 'privat')
      return INSURANCE.privatBasis;
    if (v === INSURANCE.accident || v === 'bg') return INSURANCE.accident;
    return null;
  }

  /** `isSelfPayerScan()` — a mapped scan of exactly Privat Basis is the "Selbstzahler, no named insurer" case. */
  static isSelfPayerScan(mapped: string | null): boolean {
    return mapped === INSURANCE.privatBasis;
  }

  /**
   * What the Insurance Type field should start as, under BOTH rules.
   *
   * `before` is `scannedType ?? patientType` — the scan always wins when present, which is the bug.
   * `after` gives the patient's own value priority for a Selbstzahler scan only, and resolves to
   * null (empty field) when neither side has one.
   *
   * `discriminating` is false when the two agree, which is what disqualifies a fixture.
   */
  static resolvePrefill(scannedRaw: string | null, patientType: string | null) {
    const scanned = ScanInsurancePrefillPage.mapInsuranceType(scannedRaw);
    const before = scanned ?? patientType ?? null;
    const after = ScanInsurancePrefillPage.isSelfPayerScan(scanned)
      ? (patientType ?? null)
      : (scanned ?? patientType ?? null);
    return { scanned, before, after, discriminating: before !== after };
  }

  // ────────────────────────────── live fixtures ──────────────────────────────

  /** The images still awaiting a VO — the population this ticket's flow acts on. */
  async pendingReviewImageIds(token: string, cap = 2_000): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; ids.length < cap; page++) {
      const body = await this.get<{ member?: { id: number }[] }>(
        `/prescription_images?status=pending_review&itemsPerPage=100&page=${page}`,
        token,
      );
      const members = body.member ?? [];
      ids.push(...members.map((m) => m.id));
      if (members.length < 100) break;
    }
    return ids;
  }

  /**
   * One image's extraction.
   *
   * **The collection does not serialize `extractedData`** — only the item read does, and `groups[]`
   * is ignored there — so a fixture sweep costs one request per image.
   */
  async extraction(imageId: number, token: string): Promise<Extraction> {
    const d = await this.get<Record<string, unknown>>(`/prescription_images/${imageId}`, token);
    const ed = (d.extractedData ?? {}) as Record<string, { value?: unknown; confidence?: number; match?: Record<string, unknown>; matchStatus?: string }>;
    const patientName = ed.patientName ?? {};
    const match = (patientName.match ?? {}) as { id?: number; fullName?: string };
    return {
      imageId,
      rawInsuranceType: (ed.insuranceType?.value as string) ?? null,
      confidence: ed.insuranceType?.confidence ?? null,
      blanko: (ed.isBlankoVO?.value as boolean) ?? null,
      patientId: match.id ?? null,
      patientName: match.fullName ?? null,
      insurerName: (ed.insuranceCompanyName?.value as string) ?? null,
      matchStatus: patientName.matchStatus ?? null,
      extractionStatus: (d.extractionStatus as string) ?? null,
    };
  }

  /** A patient's STORED insurance type (#3382). The `insuranceType` query filter is silently ignored. */
  async patientInsuranceType(patientId: number, token: string): Promise<string | null> {
    const d = await this.get<{ insuranceType?: string | null; fullName?: string }>(`/patients/${patientId}`, token);
    return d.insuranceType ?? null;
  }

  // ─────────────────────────── the deployed bundle ───────────────────────────

  async entryBundle(): Promise<string> {
    const html = await (await this.request.get(`${STAGING_WEB}/`, { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3710: no entry bundle in the served HTML');
    return await (await this.request.get(`${STAGING_WEB}${src}`, { timeout: 240_000 })).text();
  }

  static occurrences(bundle: string, needle: string): number {
    return bundle.split(needle).length - 1;
  }

  /**
   * A literal as the bundle stores it: `\xNN` up to U+00FF, `\uXXXX` above it. Both appear in this
   * ticket's German — `ä`/`ö` are `\xe4`/`\xf6`, and any typographic punctuation is `\u…`.
   */
  static escaped(literal: string): string {
    return [...literal]
      .map((c) => {
        const code = c.codePointAt(0) ?? 0;
        if (code < 128) return c;
        if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
        return `\\u${code.toString(16).padStart(4, '0')}`;
      })
      .join('');
  }

  static escapedCount(bundle: string, literal: string): number {
    return ScanInsurancePrefillPage.occurrences(bundle, ScanInsurancePrefillPage.escaped(literal));
  }

  /**
   * Whether #3710's frontend change is in the served bundle.
   *
   * `control` is #3383's sibling key, which lives in the same dictionary section — it must be
   * present, or the probe is looking in the wrong place and a zero means nothing.
   */
  async deploymentState(): Promise<{
    deployed: boolean;
    selfPayerKey: number;
    blankoKey: number;
    selfPayerDe: number;
    blankoDe: number;
    control: number;
  }> {
    const bundle = await this.entryBundle();
    const state = {
      selfPayerKey: ScanInsurancePrefillPage.occurrences(bundle, HINTS.selfPayerKey),
      blankoKey: ScanInsurancePrefillPage.occurrences(bundle, HINTS.blankoKey),
      selfPayerDe: ScanInsurancePrefillPage.escapedCount(bundle, HINTS.selfPayerDe),
      blankoDe: ScanInsurancePrefillPage.escapedCount(bundle, HINTS.blankoDe),
      control: ScanInsurancePrefillPage.occurrences(bundle, HINTS.differsKey),
    };
    return { ...state, deployed: state.selfPayerKey > 0 && state.blankoKey > 0 };
  }

  // ─────────────────────────────── the screen ───────────────────────────────

  /**
   * Open the VO-creation form pre-filled from a scan and wait for it to paint.
   *
   * **Nothing is created** — the form only writes on an explicit save, which no test here performs.
   * Readiness is the Versicherungsart label, because the pre-fill lands in stages and reading early
   * gives an empty field that looks exactly like AC2's outcome.
   */
  async openScanForm(imageId: number, timeoutMs = 180_000): Promise<void> {
    const page = this.requirePage();
    await page.goto(`${STAGING_WEB}/vo-management/add?imageId=${imageId}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Versicherungsart', { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    // The patient-default effect fires after the lazy patient read settles, so the field can still
    // be empty for a moment after the label is up.
    await page.waitForTimeout(8_000);
  }

  /**
   * The value painted in the Versicherungsart field, as one of the enum's German labels — or null
   * when the field is empty, which is AC2's whole outcome.
   *
   * Read out of the form's flattened text rather than from a control, because the field is a
   * react-native-web dropdown with no input element and no testid.
   */
  async insuranceTypeValue(): Promise<string | null> {
    const body = await this.requirePage().locator('body').innerText();
    const flat = body.replace(/\n+/g, ' | ');
    const m = flat.match(/Versicherungsart \*?\s*●?\s*\|\s*([^|]+)\|/);
    const painted = m?.[1]?.trim() ?? null;
    if (!painted || painted === '-' || painted === '–') return null;
    // Longest label first: "Privat Basis" contains neither "PKV" nor "GKV", but be explicit anyway.
    for (const label of ['Privat Basis', 'PKV', 'GKV', 'BG']) {
      if (painted.startsWith(label)) return label;
    }
    return painted;
  }

  /** The whole form as one line, for hint assertions and for logging what a run actually saw. */
  async formText(): Promise<string> {
    return (await this.requirePage().locator('body').innerText()).replace(/\n+/g, ' | ');
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('ScanInsurancePrefillPage was constructed without a Page');
    return this.page;
  }
}
