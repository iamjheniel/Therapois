import { APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS, type Credentials } from '../util/api-token';

const API = 'https://api.staging.therapios.de';

export type Treatment = { id: number; code: string; kind: string; bv: boolean; area: string | null };
export type Verdict = { validationId: number; passed: boolean; autoNote: string | null };

/**
 * RC 3.15 #3841 + #3842 — the two billing checks that fail on Blanko VOs for the same reason: the
 * VO's prescribed Heilmittel list is not a specification on a Blanko VO, because the therapist
 * decides. Both shipped in one commit, `646440999` (`Ref #3841 #3842`), with **no PR**.
 *
 *  - **#3841** (check **17**, `billed_units_not_exceed_prescribed`): an early `return true` for a
 *    Blanko VO. Its prescribed quantity is 0 when the VO was created in Flow and an arbitrary
 *    TheOrg number when imported, so it is not a cap at all.
 *  - **#3842** (check **30**, `service_maps_to_remedy`): a billed position that is not on the list
 *    still passes when it is a Blanko position (`Treatment::isBv()`) of the VO's OWN Fachbereich.
 *
 * **There is no read-only evaluator.** `POST /prescriptions/{id}/check-billing-validation` is what
 * the validation page itself fires on load, and it is the only way to make either check speak. It
 * writes `prescription_validation` rows — measured here as leaving `validationStatus`,
 * `creationValidationStatus` and `treatmentStatus` untouched, so it records what the page would
 * show without moving the VO on or off the billing queue. That is exactly what the tickets' own
 * QA steps do ("open the validation page for VO 8978-1").
 */
export class BlankoBillingValidationPage {
  private token = '';

  /** The two checks under test. */
  static readonly CHECK_UNITS = 17;
  static readonly CHECK_MAPPING = 30;

  /**
   * `TreatmentAreaEnum::fromTherapyType`, ported.
   *
   * `TherapyType` is `physiotherapy` / **`ergotherapy`** / `speech_therapy` — NOT
   * `occupational_therapy`, which `/prescriptions?therapyType=` accepts silently and answers 0 for
   * (#3576). The area space is `treatment.area`, whose speech value is **`SSSST`, five S**.
   */
  static readonly AREA_OF_THERAPY: Record<string, string> = {
    physiotherapy: 'PT', ergotherapy: 'ERGO', speech_therapy: 'SSSST',
  };

  constructor(private request: APIRequestContext) {}

  async init(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    const t = (await res.json()).token as string;
    if (!this.token) this.token = t;
    return t;
  }

  private headers(token = this.token) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' };
  }

  async get<T>(path: string, token = this.token, timeout = 600_000): Promise<T> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(token), timeout });
        if (res.ok()) return (await res.json()) as T;
        if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
        last = String(res.status());
      } catch (e: any) {
        if (/-> \d{3}$/.test(e?.message ?? '')) throw e;
        last = e?.message ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  async total(path: string): Promise<number> {
    const b = await this.get<any>(path);
    return b.totalItems ?? b['hydra:totalItems'] ?? (Array.isArray(b) ? b.length : 0);
  }

  // ───────────────────────────── catalogue + VO data ─────────────────────────────

  /** The Heilmittel catalogue, keyed by id. `bv` and `area` are only served here. */
  async treatments(): Promise<Map<number, Treatment>> {
    const b = await this.get<any>('/treatments?itemsPerPage=300');
    const m = new Map<number, Treatment>();
    for (const t of b.member ?? []) {
      m.set(t.id, { id: t.id, code: String(t.code ?? ''), kind: String(t.kind ?? ''), bv: t.bv === true, area: t.area ?? null });
    }
    return m;
  }

  async prescription(id: number): Promise<any> { return this.get<any>(`/prescriptions/${id}`); }

  async prescriptionByNumber(voNumber: string): Promise<any | null> {
    const b = await this.get<any>(
      `/prescriptions?itemsPerPage=1&exact%5BprescriptionId%5D=${encodeURIComponent(voNumber)}`);
    return (b.member ?? [])[0] ?? null;
  }

  /**
   * The VO's prescribed treatments as `treatmentId -> prescribed quantity`.
   *
   * **`numberOfTreatments` is serialized as a STRING**, so a bare `>` against a billed count
   * compares a number with a string and throws (or, in a looser language, silently misorders).
   * And the embedded `treatment` carries `@id` but **no bare `id`** (#3576).
   */
  static prescribedMap(vo: any): Map<number, number> {
    const out = new Map<number, number>();
    for (const p of vo.prescribedTreatments ?? []) {
      const iri = p?.treatment?.['@id'];
      if (!iri) continue;
      out.set(Number(String(iri).split('/').pop()), Number(p.numberOfTreatments ?? 0) || 0);
    }
    return out;
  }

  /**
   * Billed rows per treatment id, from `/activity_treatments?prescription=` (#3712).
   *
   * **This counts EVERY attachment, which is not what the units check counts.** Use
   * {@link deliveredCounts} for anything compared against a prescribed quantity — see the note
   * there; this one is kept for questions about which positions were attached at all.
   */
  async billedCounts(prescriptionId: number): Promise<Map<number, number>> {
    const b = await this.get<any>(`/activity_treatments?prescription=${prescriptionId}&itemsPerPage=400`);
    const out = new Map<number, number>();
    for (const r of b.member ?? []) {
      const t = r.treatment;
      const id = typeof t === 'object' ? t?.id : Number(String(t).split('/').pop());
      if (id) out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
  }

  /**
   * DELIVERED rows per treatment id — the count `billed_units_not_exceed_prescribed` actually
   * compares against the prescribed quantity.
   *
   * **The trap this exists for.** A planned session and a rejected-without-signature one both
   * carry `ActivityTreatment` rows, so a count over the raw attachments runs ahead of the real
   * one. Measured on VO 6381-4: 11 attachments against 10 prescribed KG-H, which reads exactly
   * like a VO over its units — and the check correctly passes it, because only 10 were
   * delivered. An oracle built on {@link billedCounts} therefore reports a working check as
   * broken, and (worse, in the other direction) invents pre-fix failures that never happened.
   *
   * The predicate is #3649's `isDeliveredSession()`: NOT planned, and NOT rejected unless the
   * rejection carries a signature. The fields are **`rejectedTreatment` /
   * `rejectedTreatmentWithSignature`** — the shorter `rejected` / `rejectedWithSignature` do
   * not exist on an Activity, so a predicate written on them excludes nothing and silently
   * degrades back to the raw attachment count.
   */
  async deliveredCounts(prescriptionId: number): Promise<Map<number, number>> {
    const [ats, acts] = await Promise.all([
      this.get<any>(`/activity_treatments?prescription=${prescriptionId}&itemsPerPage=400`),
      this.get<any>(`/activities?prescription=${prescriptionId}&itemsPerPage=400`),
    ]);
    const delivered = new Map<number, boolean>();
    for (const a of acts.member ?? []) {
      const id = Number(String(a['@id'] ?? a.id).split('/').pop());
      const rejectedUnsigned = Boolean(a.rejectedTreatment) && !a.rejectedTreatmentWithSignature;
      delivered.set(id, a.treatmentType !== 'planned' && !rejectedUnsigned);
    }
    const out = new Map<number, number>();
    for (const r of ats.member ?? []) {
      const t = r.treatment;
      const tid = typeof t === 'object' ? t?.id : Number(String(t).split('/').pop());
      if (!tid) continue;
      const aid = r.activity ? Number(String(r.activity).split('/').pop()) : null;
      // An attachment whose activity is not served (it is not in this VO's collection) is
      // counted — dropping it would under-count, which is the direction that hides a failure.
      if (aid !== null && delivered.get(aid) === false) continue;
      out.set(tid, (out.get(tid) ?? 0) + 1);
    }
    return out;
  }

  // ───────────────────────────── the checks ─────────────────────────────

  /**
   * Runs the billing checks and returns the verdicts the response carries.
   *
   * **A write**, bounded: verdict rows only. Callers restrict it to VOs whose `validationStatus` is
   * null, so nothing already validated is re-judged.
   */
  async runBillingChecks(prescriptionId: number): Promise<Map<number, Verdict>> {
    const res = await this.request.post(
      `${API}/prescriptions/${prescriptionId}/check-billing-validation`,
      { headers: { ...this.headers(), 'Content-Type': 'application/ld+json' }, data: {}, timeout: 600_000 },
    );
    if (!res.ok()) throw new Error(`check-billing-validation ${prescriptionId} -> ${res.status()}`);
    const body = await res.json();
    const out = new Map<number, Verdict>();
    for (const r of body.results ?? []) {
      out.set(Number(String(r.validation).split('/').pop()),
        { validationId: Number(String(r.validation).split('/').pop()), passed: r.passed === true, autoNote: r.autoNote ?? null });
    }
    return out;
  }

  /** A VO's stored verdicts, read-only. */
  async storedVerdicts(prescriptionId: number): Promise<Map<number, boolean>> {
    const b = await this.get<any>(`/prescription_validations?itemsPerPage=80&prescription=${prescriptionId}`);
    const out = new Map<number, boolean>();
    for (const r of b.member ?? []) out.set(Number(String(r.validation).split('/').pop()), r.passed === true);
    return out;
  }

  /**
   * The stored verdict ROWS, with their ids.
   *
   * The id matters for #3842 AC2: a correction must UPDATE the existing row rather than add a
   * second one, and comparing `passed` alone cannot tell those apart.
   */
  async storedVerdictRows(
    prescriptionId: number,
  ): Promise<Array<{ id: number; validation: number; passed: boolean | null; note?: string }>> {
    const b = await this.get<any>(`/prescription_validations?itemsPerPage=80&prescription=${prescriptionId}`);
    return (b.member ?? []).map((r: any) => ({
      id: r.id,
      validation: Number(String(r.validation).split('/').pop()),
      passed: r.passed ?? null,
      note: r.autoNote ?? r.note ?? undefined,
    }));
  }

  /** The state the POST must NOT move. */
  async queueState(prescriptionId: number): Promise<Record<string, unknown>> {
    const vo = await this.prescription(prescriptionId);
    return {
      validationStatus: vo.validationStatus ?? null,
      creationValidationStatus: vo.creationValidationStatus ?? null,
      treatmentStatus: vo.treatmentStatus ?? null,
    };
  }

  // ───────────────────────────── oracles ─────────────────────────────

  /**
   * Check 17 as it was BEFORE #3841: per TREATMENT-kind prescribed remedy, billed must not exceed
   * the prescribed quantity. Returns the offending remedies, so a test can say which.
   */
  /**
   * The pre-fix rule for check 17: a prescribed treatment-kind position whose DELIVERED count
   * exceeds the quantity on the VO. Feed it {@link deliveredCounts}, never {@link billedCounts}.
   *
   * A Blanko VO prescribes `numberOfTreatments: "0"` — its budget is a BV one, not a session
   * count — so under this rule the FIRST delivered session already exceeds it. That is the
   * whole of #3841: not an off-by-one, but a check asking a question the VO does not answer.
   */
  static unitsOverPreFix(
    pres: Map<number, number>, billed: Map<number, number>, tr: Map<number, Treatment>,
  ): { code: string; billed: number; prescribed: number }[] {
    const out: { code: string; billed: number; prescribed: number }[] = [];
    for (const [id, qty] of pres) {
      const t = tr.get(id);
      if (!t || t.kind !== 'treatment') continue;
      const n = billed.get(id) ?? 0;
      if (n > qty) out.push({ code: t.code, billed: n, prescribed: qty });
    }
    return out;
  }

  /** Billed TREATMENT-kind positions that are not on the VO's list, classified for #3842 AC1. */
  static unlistedPositions(
    pres: Map<number, number>, billed: Map<number, number>, tr: Map<number, Treatment>, therapyType: string | null,
  ): { code: string; bucket: 'own-area-bv' | 'other-area-bv' | 'not-bv' }[] {
    const area = therapyType ? BlankoBillingValidationPage.AREA_OF_THERAPY[therapyType] : undefined;
    const out: { code: string; bucket: 'own-area-bv' | 'other-area-bv' | 'not-bv' }[] = [];
    for (const [id] of billed) {
      const t = tr.get(id);
      if (!t || t.kind !== 'treatment' || pres.has(id)) continue;
      out.push({
        code: t.code,
        bucket: !t.bv ? 'not-bv' : t.area === area ? 'own-area-bv' : 'other-area-bv',
      });
    }
    return out;
  }

  /** Check 30 after #3842: every unlisted billed position must be an own-area Blanko one. */
  static mappingPasses(
    pres: Map<number, number>, billed: Map<number, number>, tr: Map<number, Treatment>,
    therapyType: string | null, isBlanko: boolean,
  ): boolean {
    const unlisted = BlankoBillingValidationPage.unlistedPositions(pres, billed, tr, therapyType);
    if (!unlisted.length) return true;
    if (!isBlanko) return false;
    return unlisted.every((u) => u.bucket === 'own-area-bv');
  }
}
