import { APIRequestContext, Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Privat Basis VOs use the GKV validation check set — RC 3.14 #3708, commit `28f402375`,
 * migration `Version20260916070000`.
 *
 * #3608 (RC 3.13) gave Privat Basis the **PKV** set by mirroring `private`. Privat Basis is the
 * PKV-Basistarif, which follows the GKV contractual framework for treatment rules, so this ticket
 * re-points it at **GKV** instead — minus eleven checks that do not apply to a Basistarif patient.
 *
 * ## The whole ticket is one column, and it is served
 *
 * `GET /validations` exposes `applicableInsuranceTypes` per check, alongside `description`,
 * `timing`, `severity`, `scope` and `category`. AC1, AC3 and AC5 are all statements about that
 * column, so the registry is the authoritative surface — not a screen and not a sampled VO. 51
 * checks, read in one request.
 *
 * **The migration is data-driven and its rule is arithmetic**, which makes the post-deploy
 * expectation exact rather than approximate: it appends `privat_basis` to every row carrying
 * `public` and not already carrying it, `WHERE description NOT IN (…11 names…)`. Measured on
 * staging: 44 rows carry `public`, 14 carry `privat_basis`, and all 14 are inside the 44 — so
 * after the migration Privat Basis must hold **exactly 44 − 11 = 33**, and the 19 rows in
 * `shouldGain()` are precisely the difference.
 *
 * ## Three surfaces agree, which is what makes the verdict trustworthy
 *
 *  1. **the registry** (`/validations`) — the data the migration writes;
 *  2. **`POST /prescriptions/preview-creation-validation`** — the endpoint the create form calls,
 *     hydrating a TRANSIENT prescription and writing nothing (#3576);
 *  3. **the Validierungskonfiguration screen** at `/validation-config`, whose Privat Basis column
 *     is display-only and rendered from the same data (AC4).
 *
 * All three currently report **6 creation checks** for Privat Basis against GKV's 18, so the
 * not-deployed verdict is reached three independent ways.
 *
 * ## Traps
 *
 *  - **`severity` is a property of the CHECK, not of the insurance type** — one column per row, no
 *    per-type override. AC2's "same severity and message as it would for a GKV VO" is therefore
 *    true by construction and cannot fail; asserting the structure is the honest version of that
 *    AC, and inventing a per-type severity comparison would be asserting something that does not
 *    exist.
 *  - **Six rows carry an EMPTY `applicableInsuranceTypes`** — disabled checks. The migration
 *    deliberately skips them (`JSON_CONTAINS(… 'public')` is false), so they are not part of any
 *    count and must not be read as "missing from Privat Basis".
 *  - The screen's Privat Basis column is at a fixed x; its cells are leaf nodes sharing that
 *    column, so read them by **x-band and y-order** — there is no per-cell testid.
 *  - `/validations` needs `itemsPerPage` raised, or the default page hides most of the 51.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

export const INSURANCE = { public: 'public', pkv: 'private', privatBasis: 'privat_basis', accident: 'accident' } as const;

/**
 * `Version20260916070000::EXCLUDED_CHECKS` — the eleven the migration leaves off, grouped by the
 * five categories AC 3 names. The grouping is the part worth asserting: AC 3 is written as five
 * categories and the implementation is eleven descriptions, and nothing else states the mapping.
 */
export const EXCLUDED_BY_CATEGORY: Record<string, string[]> = {
  'Copayment/exemption (Zuzahlung/Befreiung)': ['co_payment_calculation', 'exemption_stored', 'active_exemption_covering_period'],
  '9-month deadline': ['billing_deadline_9_months'],
  'Blanko/LHB/BVB': ['blank_prescription_deadline', 'lhb_icd_in_list', 'bvb_icd_or_approval', 'missed_lhb_bvb_option'],
  'Discharge (Entlassmanagement)': ['discharge_info_present', 'discharge_management_timing'],
  'Group-therapy switch (Gruppenbehandlung)': ['group_therapy_switch_documented'],
};

export const EXCLUDED_CHECKS: string[] = Object.values(EXCLUDED_BY_CATEGORY).flat();

export type Validation = {
  id: number;
  description: string;
  scope?: string | null;
  category?: string | null;
  timing?: string | null;
  severity?: string | null;
  sortOrder?: number | null;
  isAutoCheck?: boolean | null;
  applicableInsuranceTypes?: string[] | null;
  applicableTherapyAreas?: string[] | null;
  applicableVoKinds?: string[] | null;
};

export class PrivatBasisCheckSetPage {
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

  adminToken = () => this.tokenFor(STAGING_CREDENTIALS.superadmin);

  // ───────────────────────────── the registry ─────────────────────────────

  /** All 51 checks. `itemsPerPage` is raised deliberately — the default hides most of them. */
  async validations(token: string): Promise<Validation[]> {
    const res = await this.request.get(`${API_BASE}/validations?itemsPerPage=200`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`GET /validations -> ${res.status()}`);
    const body = (await res.json()) as { member?: Validation[]; 'hydra:member'?: Validation[] };
    return body.member ?? body['hydra:member'] ?? [];
  }

  static applies(v: Validation, insuranceType: string): boolean {
    return (v.applicableInsuranceTypes ?? []).includes(insuranceType);
  }

  /** A check with an empty list is disabled — not "missing from Privat Basis". */
  static isDisabled(v: Validation): boolean {
    return (v.applicableInsuranceTypes ?? []).length === 0;
  }

  static forType(rows: Validation[], insuranceType: string): Validation[] {
    return rows.filter((v) => PrivatBasisCheckSetPage.applies(v, insuranceType));
  }

  /**
   * The rows the migration will add `privat_basis` to: every `public` row that lacks it and is not
   * one of the eleven exclusions. After deploy this must be empty.
   */
  static shouldGain(rows: Validation[]): Validation[] {
    return rows.filter(
      (v) =>
        PrivatBasisCheckSetPage.applies(v, INSURANCE.public) &&
        !PrivatBasisCheckSetPage.applies(v, INSURANCE.privatBasis) &&
        !EXCLUDED_CHECKS.includes(v.description),
    );
  }

  /** The eleven AC 3 exclusions that are (correctly) still off for Privat Basis. */
  static excludedAndOff(rows: Validation[]): Validation[] {
    return rows.filter(
      (v) => EXCLUDED_CHECKS.includes(v.description) && !PrivatBasisCheckSetPage.applies(v, INSURANCE.privatBasis),
    );
  }

  /**
   * AC1's exact post-migration target: `public` minus the eleven exclusions.
   *
   * Sound only while every current `privat_basis` row is also a `public` row — asserted by the spec
   * before this number is used, because otherwise the arithmetic silently under-counts.
   */
  static expectedAfterMigration(rows: Validation[]): number {
    return PrivatBasisCheckSetPage.forType(rows, INSURANCE.public).filter(
      (v) => !EXCLUDED_CHECKS.includes(v.description),
    ).length;
  }

  /**
   * The rows a given column of the Validierungskonfiguration screen actually renders.
   *
   * **Two filters beyond the insurance type, and missing either makes the screen look wrong.**
   *  - The screen splits GKV into four columns by **VO kind** — Standard / LHB / BVB / Blanko — so
   *    "GKV Standard" is `public` AND `standard`, not simply `public`. Three GKV checks are
   *    kind-specific (`blank_prescription_deadline`, `lhb_icd_in_list`, `bvb_icd_or_approval`) and
   *    correctly show ✗ in the Standard column. PKV, Privat Basis and UV/BG each get ONE column.
   *  - The screen has exactly two tables, Erstellungsprüfungen and Abrechnungsprüfungen, so a check
   *    whose `timing` is neither (`not_needed`) is rendered nowhere.
   *
   * Together those explain 44 → 40 for GKV Standard: 44 carry `public`, 41 of them are `standard`,
   * and one of those is `not_needed`.
   */
  static renderedInColumn(rows: Validation[], insuranceType: string, voKind = 'standard'): Validation[] {
    return rows.filter(
      (v) =>
        PrivatBasisCheckSetPage.applies(v, insuranceType) &&
        (v.applicableVoKinds ?? []).includes(voKind) &&
        (v.timing === 'vo_creation' || v.timing === 'billing'),
    );
  }

  /** Is the migration in? Decided from the data it writes, not from a version string (#3704). */
  static migrationApplied(rows: Validation[]): boolean {
    return PrivatBasisCheckSetPage.shouldGain(rows).length === 0;
  }

  // ─────────────────────── the create form's own endpoint ───────────────────────

  /**
   * The creation checks an insurance type is evaluated against, through the endpoint the form
   * calls. Transient — it writes nothing (#3576).
   *
   * Omit `changedFields`: sending it switches the backend to `evaluateAffected()` and re-runs
   * nothing, which reads as "no checks apply".
   */
  async creationCheckIds(insuranceType: string, token: string): Promise<number[]> {
    const res = await this.request.post(`${API_BASE}/prescriptions/preview-creation-validation`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { therapyType: 'physiotherapy', insuranceType, prescribedTreatments: [{ treatment: '/treatments/71' }] },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST preview-creation-validation (${insuranceType}) -> ${res.status()}`);
    const body = (await res.json()) as { results?: { validation: string }[] };
    return [...new Set((body.results ?? []).map((r) => Number(r.validation.split('/').pop())))].sort((a, b) => a - b);
  }

  /**
   * The same preview call, keeping each check's VERDICT rather than only its id.
   *
   * `passed` is `true` / `false` / `null` (not applicable to this payload), and the three are kept
   * distinct: collapsing `null` into `false` would invent failures and make AC2's parity check pass
   * for the wrong reason.
   */
  async creationVerdicts(insuranceType: string, token: string): Promise<Map<number, boolean | null>> {
    const res = await this.request.post(`${API_BASE}/prescriptions/preview-creation-validation`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { therapyType: 'physiotherapy', insuranceType, prescribedTreatments: [{ treatment: '/treatments/71' }] },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST preview-creation-validation (${insuranceType}) -> ${res.status()}`);
    const body = (await res.json()) as { results?: { validation: string; passed: boolean | null }[] };
    return new Map((body.results ?? []).map((r) => [Number(r.validation.split('/').pop()), r.passed ?? null]));
  }

  // ─────────────────────── the Validierungskonfiguration screen ───────────────────────

  async openConfigScreen(timeoutMs = 180_000): Promise<void> {
    const page = this.requirePage();
    await page.goto(`${STAGING_WEB}/validation-config`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Validierungskonfiguration', { exact: true }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    // The two tables paint after the registry read lands; the header alone is up much earlier.
    await page.getByText('Erstellungsprüfungen', { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
  }

  /**
   * One column of the matrix, read top to bottom.
   *
   * There is no per-cell testid, so the column is located by its header's x-band and its cells are
   * the leaf nodes sharing that band, ordered by y. Returns the ✓/✗ marks only — the header itself
   * and any stray label are dropped.
   */
  async columnMarks(header: string, bandPx = 30): Promise<string[]> {
    return this.requirePage().evaluate(
      ({ header, bandPx }) => {
        const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0) as HTMLElement[];
        const anchor = leaves.find((e) => e.innerText?.trim() === header);
        if (!anchor) return [];
        const a = anchor.getBoundingClientRect();
        const centre = a.x + a.width / 2;
        return leaves
          .map((el) => ({ el, b: el.getBoundingClientRect() }))
          .filter(({ b }) => b.width > 0 && Math.abs(b.x + b.width / 2 - centre) <= bandPx)
          .sort((p, q) => p.b.y - q.b.y)
          .map(({ el }) => el.innerText?.trim() ?? '')
          .filter((t) => t === '✓' || t === '✗');
      },
      { header, bandPx },
    );
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('PrivatBasisCheckSetPage was constructed without a Page');
    return this.page;
  }
}
