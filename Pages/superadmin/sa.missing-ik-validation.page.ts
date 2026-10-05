import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3822 — billing validation of a GKV or BG VO is REFUSED, with a message naming
 * the Gesellschaft and the therapy type, when that Gesellschaft has no IK number for the
 * type. Before the fix the validation succeeded, the VO joined no billing submission and
 * nothing said so; five Curano Stuttgart speech-therapy VOs sat like that on production.
 *
 * Commit `23089bebf` (`Ref #3822`, **no PR**) carries BOTH halves — `PrescriptionPresenter::getMissingIk()`,
 * the refusal in `PrescriptionUpdateProcessor` + `BulkPostValidationStatusController`, the new
 * `MissingIkException`, and the two app messages — so the bundle probe and the API probe
 * should agree. A follow-up, `0eae51982` (2026-10-04), fixes the one FAIL the PM recorded.
 *
 * ## Why a WRITE ticket can be driven live
 *
 * **Every validation this ticket is about is one the fix must REFUSE, and a refused request
 * writes nothing** — the check runs before the flush, so neither the batch listener nor the
 * copayment-invoice listener fires. That is the #3899 / #3869 / #3549 shape: a write whose
 * only correct outcome is a 422 needs no permission, and a refusal that ever stops being one
 * IS the defect. The bulk path is safer still, because AC3 makes it ALL-OR-NOTHING: a batch
 * containing one missing-IK VO refuses the whole request, so a has-IK control VO can ride
 * along as the discriminator and still not be written.
 *
 * The POSITIVE paths (AC4, AC5) are real writes — they create a submission and a copayment
 * invoice — so they are **not** driven here. They do not need to be: the PM's 3 Oct run left
 * a dated, attributable footprint for every one of them (the #3821 / #3796 technique).
 *
 * ## THE ORACLE: `ikNumber` is served, and it IS `getIkNumber()`
 *
 * `getMissingIk()` is not serialized, but the value it tests is: a prescription carries
 * **`ikNumber`**, the output of the very `PrescriptionPresenter::getIkNumber()` the check
 * calls. So for a GKV/BG VO with an entity and a therapy type, `ikNumber` ABSENT ⟺ the
 * refusal fires — the whole predicate, read-only, over the whole book.
 *
 * **TRAP — and it hides the field exactly where the ticket lives:** `ikNumber` is
 * **omitted when null** (#3302/#3709), so reading it on a VO in the state this ticket is
 * about shows no key at all and reads like "the field is not served". It is also absent
 * from the `/prescriptions/{id}` ITEM read and from `/v2/prescriptions`, and `billing:read`
 * additionally drops `therapyType`, `therapist.therapyDepartment` and `entity.id`
 * (`overrideDefaultGroups`, #3512/#3576) — so the port's three inputs only come back
 * together on the PLAIN `/prescriptions` COLLECTION.
 *
 * ## Traps
 *
 * - **`entity`, `entity.id` and `billingBatchCount` are SILENTLY IGNORED as filters** on
 *   `/prescriptions` (each returns the whole 35,964-row book, byte-identical to a bogus
 *   key), so the population is narrowed by `validationStatus` + `insuranceType` — which
 *   DO narrow — and sorted out client-side.
 * - **The client keys off `missingIk`, not the type URI.** `/errors/missing-ik` occurs
 *   **0** times in the bundle; a probe written on it reads as not-deployed.
 * - The German message escapes non-ASCII (`ist keine IK-Nummer f\xfcr` — plain 0, escaped
 *   1), the #3611 trap in the direction that fakes a pass, so every German lookup goes
 *   through {@link escapedOccurrences} and a control literal proves the helper can find one.
 * - `GET /billing_batches/{id}` answers **422** (the #3288 readiness check), and a
 *   `prescriptionBillingBatch`'s `billingBatch` IRI is rendered as
 *   `/billing_batches/{id}/optica-export` — so resolve a submission's number from the
 *   `/billing_batches` COLLECTION, never by following the IRI.
 */

export type Credential = Credentials;

export const CREDS: Record<'superadmin' | 'admin' | 'therapist', Credential> = STAGING_CREDENTIALS;

/** The entity column that holds each therapy type's IK — `Entities::getIkNumberByTherapyType()`. */
export const IK_COLUMN: Record<string, string> = {
  physiotherapy: 'ikPhysiotherapy',
  ergotherapy: 'ikErgotherapy',
  speech_therapy: 'ikSpeechtherapy',
};

/** The insurance types that go into a billing submission, i.e. the ones the check covers. */
export const SUBMITTED_INSURANCE_TYPES = ['public', 'accident'] as const;

/** The two i18n keys the fix adds, read from the deployed dictionary. */
export const MESSAGE_KEYS = ['billing.missing_ik.single', 'billing.missing_ik.bulk'] as const;

export const GERMAN_SINGLE = 'Diese VO kann nicht validiert werden.';
export const GERMAN_SINGLE_CLAUSE = 'ist keine IK-Nummer für';
export const GERMAN_BULK = 'Es wurden keine VOs validiert.';
export const ENGLISH_SINGLE = 'This VO cannot be validated.';
export const ENGLISH_BULK = 'No VOs were validated.';

/** A German literal this ticket does not touch — proves {@link escapedOccurrences} can find one. */
export const ESCAPING_CONTROL = 'Rechnung neu erstellen';

export type Entity = {
  id: number;
  name: string;
  ikPhysiotherapy?: string | null;
  ikErgotherapy?: string | null;
  ikSpeechtherapy?: string | null;
};

export type Vo = {
  id: number;
  prescriptionId: string;
  insuranceType?: string | null;
  therapyType?: string | null;
  validationStatus?: string | null;
  treatmentStatus?: string | null;
  billingBatchCount?: number | null;
  /** `PrescriptionPresenter::getIkNumber()` — OMITTED when the IK is missing. */
  ikNumber?: string | null;
  updatedAt?: string | null;
  entity?: { id?: number | null; name?: string | null } | null;
  therapist?: { fullName?: string | null; therapyDepartment?: string | null } | null;
};

export type MissingIk = { entity: string; therapyType: string };

export type Refusal = { status: number; body: Record<string, unknown> };

export class MissingIkValidationPage {
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly request: APIRequestContext,
    private readonly api: string = API_BASE,
  ) {}

  /**
   * A faithful port of `PrescriptionPresenter::getMissingIk()`:
   *
   * ```php
   * if (!in_array($insuranceType, [GKV, UV], true))            return null;
   * $therapyType = $therapist?->getTherapyDepartment() ?? $vo->getTherapyType();
   * if (!$entity || !$therapyType || null !== $entity->getIkNumberByTherapyType($tt)) return null;
   * return ['entity' => $entity->getName(), 'therapyType' => $therapyType];
   * ```
   *
   * The two early returns the commit deliberately leaves out of scope (no Gesellschaft, no
   * therapy type) are reproduced, so the port cannot refuse a VO the API would not.
   * `getIkNumberByTherapyType()` TRIMS, so an all-whitespace IK counts as missing.
   *
   * Validated against the API's own `ikNumber` before use — see the port test.
   */
  missingIk(vo: Vo, entities: Map<number, Entity>): MissingIk | null {
    if (!SUBMITTED_INSURANCE_TYPES.includes(vo.insuranceType as never)) return null;
    const entityId = vo.entity?.id;
    const therapyType = vo.therapist?.therapyDepartment || vo.therapyType;
    if (!entityId || !therapyType) return null;
    const entity = entities.get(entityId);
    const raw = entity ? (entity as Record<string, unknown>)[IK_COLUMN[therapyType] ?? ''] : null;
    if (typeof raw === 'string' && raw.trim() !== '') return null;
    return { entity: String(entity?.name ?? vo.entity?.name ?? ''), therapyType };
  }

  /** The therapy type the check resolves — the therapist's department, else the VO's own. */
  resolvedTherapyType(vo: Vo): string | null {
    return vo.therapist?.therapyDepartment || vo.therapyType || null;
  }

  async token(role: keyof typeof CREDS = 'superadmin'): Promise<string> {
    const cached = this.tokens.get(role);
    if (cached) return cached;
    const creds = CREDS[role];
    const res = await this.request.post(`${this.api}/auth`, {
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    expect(res.status(), `POST /auth for ${role}`).toBe(200);
    const token = ((await res.json()) as { token: string }).token;
    this.tokens.set(role, token);
    return token;
  }

  private async get(path: string, role: keyof typeof CREDS = 'superadmin'): Promise<any> {
    const token = await this.token(role);
    let last = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const res = await this.request.get(`${this.api}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
          timeout: 300_000,
        });
        // A 5xx is the server being unhealthy, not the route being absent (#3774).
        if (res.status() < 500) {
          expect(res.status(), `GET ${path}`).toBeLessThan(400);
          return res.json();
        }
        last = `HTTP ${res.status()}`;
      } catch (error) {
        // A `socket hang up` THROWS before any status exists (#3872), so retry it too.
        last = String(error);
      }
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    throw new Error(`GET ${path} failed after 4 attempts: ${last}`);
  }

  /** `totalItems` for a query — the cheap way to prove a filter narrows. */
  async total(query: string): Promise<number> {
    const data = await this.get(`/prescriptions?itemsPerPage=1&${query}`);
    return Number(data.totalItems ?? 0);
  }

  async entities(): Promise<Map<number, Entity>> {
    const data = await this.get('/entities?itemsPerPage=100');
    const rows: Entity[] = data.member ?? data['hydra:member'] ?? [];
    return new Map(rows.map((e) => [e.id, e]));
  }

  /** `?prescriptionId[]=` is a registered multi-value filter — 33 VOs in one request (#3830). */
  async byNumber(numbers: string[]): Promise<Map<string, Vo>> {
    const query = numbers.map((n) => `prescriptionId%5B%5D=${encodeURIComponent(n)}`).join('&');
    const data = await this.get(`/prescriptions?itemsPerPage=${Math.max(numbers.length, 30)}&${query}`);
    const rows: Vo[] = data.member ?? data['hydra:member'] ?? [];
    return new Map(rows.map((v) => [v.prescriptionId, v]));
  }

  /**
   * Walks a `/prescriptions` query. THROWS on a short read, because a truncated walk would
   * silently report a clean population (#3821).
   */
  async walk(query: string, perPage = 300): Promise<Vo[]> {
    const out: Vo[] = [];
    let page = 1;
    let total: number | null = null;
    for (;;) {
      const data = await this.get(`/prescriptions?${query}&itemsPerPage=${perPage}&page=${page}`);
      total ??= Number(data.totalItems ?? 0);
      const rows: Vo[] = data.member ?? data['hydra:member'] ?? [];
      out.push(...rows);
      if (out.length >= total || rows.length === 0) break;
      page += 1;
    }
    expect(out.length, `short read on /prescriptions?${query}`).toBe(total);
    return out;
  }

  /** Every validated GKV + BG VO — the population the end-goal invariant runs over. */
  async validatedSubmittable(): Promise<Vo[]> {
    const out: Vo[] = [];
    for (const insurance of SUBMITTED_INSURANCE_TYPES) {
      out.push(...(await this.walk(`validationStatus=validated&insuranceType=${insurance}`)));
    }
    return out;
  }

  /** The single-VO path: the validation screen's and both VO edit forms' save. */
  async patchValidationStatus(
    id: number,
    status: string,
    role: keyof typeof CREDS = 'superadmin',
  ): Promise<Refusal> {
    const token = await this.token(role);
    const res = await this.request.patch(`${this.api}/prescriptions/${id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json' },
      data: { validationStatus: status },
      timeout: 120_000,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  }

  /** The bulk path — `{id: [...], validationStatus}`, NOT `{prescriptions}` or `{ids}`. */
  async bulkValidationStatus(
    ids: number[],
    status: string,
    role: keyof typeof CREDS = 'superadmin',
  ): Promise<Refusal> {
    const token = await this.token(role);
    const res = await this.request.post(`${this.api}/prescriptions/validation-status/bulk`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { id: ids, validationStatus: status },
      timeout: 120_000,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  }

  /** The VO numbers a 422 names, in order. */
  refusedNumbers(refusal: Refusal): string[] {
    const rows = (refusal.body.missingIk ?? []) as { prescriptionId?: string }[];
    return rows.map((r) => String(r.prescriptionId ?? ''));
  }

  /** `?prescription.id=` narrows here; the bare `?prescription=` is IGNORED (#3821). */
  async submissionCount(id: number): Promise<number> {
    const data = await this.get(`/prescription_billing_batches?prescription.id=${id}&itemsPerPage=50`);
    return Number(data.totalItems ?? 0);
  }

  /** The submission ids a VO belongs to. */
  async submissionIds(id: number): Promise<number[]> {
    const data = await this.get(`/prescription_billing_batches?prescription.id=${id}&itemsPerPage=50`);
    const rows: { billingBatch?: unknown }[] = data.member ?? data['hydra:member'] ?? [];
    return rows
      .map((r) => {
        const raw = typeof r.billingBatch === 'string' ? r.billingBatch : (r.billingBatch as any)?.['@id'];
        const found = /\/billing_batches\/(\d+)/.exec(String(raw ?? ''));
        return found ? Number(found[1]) : NaN;
      })
      .filter((n) => Number.isFinite(n));
  }

  /** `?prescription=` narrows here — the exact OPPOSITE of the batches collection (#3821). */
  async invoices(id: number): Promise<{ invoiceNumber?: string; invoiceType?: string; status?: string }[]> {
    const data = await this.get(`/invoices?prescription=${id}&itemsPerPage=50&groups%5B%5D=invoice-list:read`);
    return data.member ?? data['hydra:member'] ?? [];
  }

  async logs(id: number): Promise<{ createdAt?: string; type?: string; oldValue?: unknown; newValue?: unknown }[]> {
    const data = await this.get(`/prescription_logs?prescription=${id}&itemsPerPage=100`);
    return data.member ?? data['hydra:member'] ?? [];
  }

  /** A VO's full billing state — what a refusal must leave exactly as it was. */
  async billingState(id: number): Promise<{
    validationStatus: string | null;
    ikNumber: string | null;
    billingBatchCount: number | null;
    updatedAt: string | null;
    submissions: number;
    invoices: number;
    logs: number;
  }> {
    const data = await this.get(`/prescriptions?itemsPerPage=1&id%5B%5D=${id}`);
    const vo: Vo = (data.member ?? data['hydra:member'] ?? [])[0] ?? ({} as Vo);
    // An ignored filter would hand back the first row of the whole book, and a before/after
    // comparison of the SAME wrong VO would pass for the wrong reason.
    expect(vo.id, `/prescriptions?id[]=${id} must return that VO`).toBe(id);
    return {
      validationStatus: vo.validationStatus ?? null,
      ikNumber: vo.ikNumber ?? null,
      billingBatchCount: vo.billingBatchCount ?? null,
      updatedAt: vo.updatedAt ?? null,
      submissions: await this.submissionCount(id),
      invoices: (await this.invoices(id)).length,
      logs: (await this.logs(id)).length,
    };
  }

  private bundleText: string | null = null;

  /** The served entry bundle — the only surface that answers for the frontend (#3705). */
  async bundle(): Promise<string> {
    if (this.bundleText) return this.bundleText;
    const index = await this.request.get('https://staging.therapios.de/', { timeout: 120_000 });
    const entry = /\/_expo\/static\/js\/web\/entry-[a-z0-9]+\.js/.exec(await index.text())?.[0];
    expect(entry, 'entry bundle in the served index').toBeTruthy();
    const res = await this.request.get(`https://staging.therapios.de${entry}`, { timeout: 300_000 });
    expect(res.status()).toBe(200);
    this.bundleText = await res.text();
    return this.bundleText;
  }

  /**
   * Counts a literal in BOTH its plain and its escaped form. The build escapes non-ASCII as
   * `\xNN` below 256 and `\uXXXX` above (#3873), so a plain search for a German string
   * returns 0 and reads exactly like "never shipped" (#3337/#3611).
   */
  async escapedOccurrences(literal: string): Promise<{ plain: number; escaped: number; total: number }> {
    const text = await this.bundle();
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asEscaped = [...literal]
      .map((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 128) return escapeRe(ch);
        if (code < 256) return escapeRe(`\\x${code.toString(16).padStart(2, '0')}`);
        return escapeRe(`\\u${code.toString(16).padStart(4, '0')}`);
      })
      .join('');
    const plain = (text.match(new RegExp(escapeRe(literal), 'g')) ?? []).length;
    const escaped = (text.match(new RegExp(asEscaped, 'g')) ?? []).length;
    return { plain, escaped, total: plain + escaped };
  }
}
