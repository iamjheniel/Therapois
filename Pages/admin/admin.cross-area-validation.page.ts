import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * The cross-area fee/Heilmittel creation check — RC 3.13 #3576.
 *
 * A VO must not carry a fee or Heilmittel from a different treatment area than its own Fachbereich
 * (a Logopädie fee on a Physiotherapie VO, say). The check shipped as
 * `CreationValidationService::checkFeeAreaMatchesTherapyType()` plus one data migration
 * (`Version20260901142128`) seeding **validation id 54**, `fee_area_matches_therapy_type`, severity
 * **warning**, sort_order 42, category `remedy`, auto-check.
 *
 * ## The surface that makes this testable without writing anything
 *
 * `POST /prescriptions/preview-creation-validation` is what the CREATE form itself calls: it
 * hydrates a **transient** Prescription from a form payload, evaluates the checks in memory and
 * "does not read or write any PrescriptionValidation rows" (its controller's own words). So the
 * whole of AC2's nine-row truth table can be driven on demand — including combinations no VO on
 * staging has — with zero side effects. The payload only needs three keys:
 *
 * ```json
 * { "therapyType": "physiotherapy", "insuranceType": "public",
 *   "prescribedTreatments": [ { "treatment": "/treatments/68", "numberOfTreatments": 10 } ] }
 * ```
 *
 * The response's `results[]` carries `{validation, passed, autoNote, isAutoCheck}`, and a check is
 * only included when `ValidationApplicabilityService` says it applies — which is how the insurance
 * scoping is observable.
 *
 * ## THE TRAP, and it silently zeroes a third of any survey
 *
 * `TherapyType` is `physiotherapy` / `speech_therapy` / **`ergotherapy`**. It is NOT
 * `occupational_therapy` — and `/prescriptions?therapyType=occupational_therapy` is accepted and
 * answers **`totalItems: 0`**, exactly like `bogus_value`, while `ergotherapy` answers 9,113. Two
 * things in this repo got it wrong: the ticket's own Developer Reference (which says the enum is
 * `ergotherapy` but points at `THERAPY_TYPE_TO_AREA`'s `PT/LO/ET` codes, a different value space
 * entirely), and — worse — `sa.cross-area-fees.page.ts`'s `AREA_TO_THERAPY_TYPE`, which mapped
 * `ERGO` to `occupational_therapy`. Every #3577 probe against an Ergotherapie VO therefore came back
 * empty and the residual was reported as 5 combinations / 18 VO-hits. Corrected, it is **13
 * combinations / 34 hits over 29 VOs**, and the 8 hidden combinations are *all* on Ergotherapie VOs.
 *
 * `assertTherapyTypeVocabulary()` exists so no zero from this endpoint is ever believed on trust.
 *
 * ## Other things worth knowing
 *
 * - **`treatment.area` has exactly three values** — `PT`, `ERGO`, `SSSST` (79/43/11 of 135 rows on
 *   staging, 2 with no area). The Developer Reference's worry about specialty sub-areas (`PT_ZAE`,
 *   `ET_NUT`, `PO`) applies to `remedy_catalog.therapyArea`, a different column the check does not
 *   read, so there is no sub-area decision to make.
 * - **`SSSST` is five S.** `TreatmentAreaEnum` read `SSST` until this ticket needed it: nothing had
 *   ever compared against the speech-therapy case, so the typo was invisible, and anything that did
 *   ask "is this treatment speech therapy?" silently answered no. #3576 is its first consumer.
 * - **Every `PrescribedTreatment` is in scope**, not only `TreatmentKind::TREATMENT` as the other
 *   remedy checks in the service are: fees (`one_time_fee`, `per_treatment_fee`) and `passiv` rows
 *   count too, which the live population confirms (12 treatment / 11 one-time-fee / 8 per-treatment
 *   / 3 passiv offending rows).
 * - **An area-less catalogue row is not a mismatch** and passes silently (ids 80 `<FEHLER>` and 103
 *   `K` on staging), as does a VO with no `therapyType` at all.
 */

export const CHECK_ID = 54;
export const CHECK_KEY = 'fee_area_matches_therapy_type';

/** `treatment.area` → the `TherapyType` value a VO of that Fachbereich carries. */
export const AREA_TO_THERAPY_TYPE = {
  PT: 'physiotherapy',
  ERGO: 'ergotherapy',
  SSSST: 'speech_therapy',
} as const;

export type Area = keyof typeof AREA_TO_THERAPY_TYPE;

/** The German labels the check's own note uses (`CreationValidationService::areaLabel`). */
export const AREA_LABEL: Record<Area, string> = {
  PT: 'Physiotherapie',
  ERGO: 'Ergotherapie',
  SSSST: 'Logopädie',
};

/**
 * One `treatment`-kind Heilmittel and one fee per area, so AC2's table can be driven on both — the
 * ticket says "fee **or** Heilmittel" and the implementation deliberately covers every kind.
 */
export const AC2_FIXTURES = {
  heilmittel: { PT: { id: 4, code: 'BEP-A' }, ERGO: { id: 25, code: 'MFB-E-HB' }, SSSST: { id: 28, code: 'L-E30H' } },
  fee: { PT: { id: 2, code: 'AB-P' }, ERGO: { id: 1, code: 'AB-E' }, SSSST: { id: 68, code: 'AB-L' } },
} as const;

/** The two catalogue rows with no area at all — neither is evidence of a mismatch. */
export const AREA_LESS_TREATMENTS = [
  { id: 80, code: '<FEHLER>' },
  { id: 103, code: 'K' },
] as const;

/** `passiv` rows, one per area, for the "every kind is in scope" case. */
export const PASSIV_FIXTURES = {
  ERGO: { id: 3, code: 'AEB' },
  PT: { id: 23, code: 'KT-H-BV' },
} as const;

export type CheckResult = { passed: boolean | null; autoNote: string | null; isAutoCheck: boolean } | null;

export type PreviewResponse = { checked: number; results: Array<{ validation: string; passed: boolean | null; autoNote: string | null; isAutoCheck: boolean }> };

export type Treatment = { id: number; code: string | null; area: Area | null; kind: string | null };

export type ValidationRow = {
  id: number;
  description: string;
  severity: string;
  sortOrder: number | null;
  category: string | null;
  isAutoCheck: boolean;
  applicableInsuranceTypes: string[];
  applicableTherapyAreas: string[];
  applicableVoKinds: string[];
};

export type CrossAreaHit = {
  prescriptionId: number;
  vo: string;
  voArea: Area;
  code: string;
  feeArea: Area;
  kind: string | null;
  imported: boolean | null;
  treatmentStatus: string | null;
  creationValidationStatus: string | null;
};

export class CrossAreaValidationPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3576: no bearer token');
  }

  private async get(path: string, timeout = 180_000): Promise<any> {
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

  // ─────────────────────────── the check's registration ───────────────────────────

  /** Every `vo_creation`-timed check, as the form's own `getList('validations')` reads them. */
  async voCreationChecks(): Promise<ValidationRow[]> {
    const body = await this.get('/validations?timing=vo_creation&pagination=false');
    return (body.member ?? []).map((v: any) => ({
      id: v.id,
      description: v.description,
      severity: v.severity,
      sortOrder: v.sortOrder ?? null,
      category: v.category ?? null,
      isAutoCheck: !!v.isAutoCheck,
      applicableInsuranceTypes: v.applicableInsuranceTypes ?? [],
      applicableTherapyAreas: v.applicableTherapyAreas ?? [],
      applicableVoKinds: v.applicableVoKinds ?? [],
    }));
  }

  // ─────────────────────────── the transient evaluation ───────────────────────────

  /**
   * Runs the creation checks against a transient VO. Writes nothing — see the class docblock.
   *
   * `changedFields` is deliberately NOT sent: omitting it requests a FULL evaluation, which is what
   * the very first check on a create form does. Sending it (even empty) switches the backend to
   * `evaluateAffected()` and re-runs only the listed checks, so a probe that sent `[]` would get an
   * empty result set and read as "the check does not exist".
   */
  async preview(payload: Record<string, unknown>): Promise<PreviewResponse> {
    const res = await this.page.request.post(`${API_BASE}/prescriptions/preview-creation-validation`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/ld+json',
        Accept: 'application/ld+json',
      },
      data: payload as any,
      timeout: 120_000,
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`POST preview-creation-validation → ${res.status()} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** The #3576 check's own result, or `null` when it was not applicable to this payload. */
  static resultFor(response: PreviewResponse, validationId = CHECK_ID): CheckResult {
    const hit = response.results.find((r) => r.validation === `/validations/${validationId}`);
    return hit ? { passed: hit.passed, autoNote: hit.autoNote, isAutoCheck: hit.isAutoCheck } : null;
  }

  /** Evaluates one VO shape: a Fachbereich plus a list of catalogue ids. */
  async checkFor(
    therapyType: string | null,
    treatmentIds: number[],
    insuranceType = 'public',
  ): Promise<{ response: PreviewResponse; check: CheckResult }> {
    const response = await this.preview({
      ...(therapyType === null ? {} : { therapyType }),
      insuranceType,
      prescribedTreatments: treatmentIds.map((id) => ({ treatment: `/treatments/${id}`, numberOfTreatments: 10 })),
    });
    return { response, check: CrossAreaValidationPage.resultFor(response) };
  }

  /** The note the check writes for a mismatch, rebuilt from the ticket's own wording. */
  static expectedNote(voArea: Area, offending: Array<{ code: string; area: Area }>): string {
    return (
      `Der Fachbereich der VO ist ${AREA_LABEL[voArea]}, aber folgende Heilmittel/Gebühren ` +
      `gehören zu einem anderen Fachbereich: ${offending.map((o) => `${o.code} (${AREA_LABEL[o.area]})`).join(', ')}.`
    );
  }

  // ─────────────────────────── the catalogue and the population ───────────────────────────

  async treatments(): Promise<Treatment[]> {
    const body = await this.get('/treatments?pagination=false');
    return (body.member ?? []).map((t: any) => ({
      id: t.id,
      code: t.code ?? null,
      area: (t.area ?? null) as Area | null,
      kind: t.kind ?? null,
    }));
  }

  /**
   * Proves the `therapyType` filter partitions before any zero from it is believed.
   *
   * Returns the row count per value plus the count for a deliberately bogus one — an unknown value
   * is accepted silently and answers 0, so "0 rows" alone never distinguishes "no such data" from
   * "wrong vocabulary". This is the guard the earlier #3577 survey lacked.
   */
  async assertTherapyTypeVocabulary(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const value of [...Object.values(AREA_TO_THERAPY_TYPE), 'occupational_therapy', 'definitely_not_a_therapy']) {
      const body = await this.get(`/prescriptions?therapyType=${encodeURIComponent(value)}&itemsPerPage=1`);
      out[value] = body.totalItems ?? 0;
    }
    return out;
  }

  /** How many VOs of `voArea` carry the catalogue row `treatmentId`. */
  async crossAreaCount(treatmentId: number, voArea: Area): Promise<number> {
    const body = await this.get(
      `/prescriptions?treatment=${treatmentId}&therapyType=${AREA_TO_THERAPY_TYPE[voArea]}&itemsPerPage=1`,
    );
    return body.totalItems ?? 0;
  }

  /**
   * The whole live cross-area population: every catalogue row against both foreign therapy types.
   *
   * 266 probes on staging (133 areas-known rows × 2), run at a small concurrency. This is the only
   * way to state the population rather than sample it — and `totalItems` on a filtered collection
   * makes it affordable, the same technique #3577 used for the fee-only grid.
   */
  async crossAreaHits(concurrency = 6): Promise<CrossAreaHit[]> {
    const catalogue = (await this.treatments()).filter((t) => t.area !== null);
    const jobs: Array<{ t: Treatment; voArea: Area }> = [];
    for (const t of catalogue) {
      for (const voArea of Object.keys(AREA_TO_THERAPY_TYPE) as Area[]) {
        if (voArea !== t.area) jobs.push({ t, voArea });
      }
    }

    const hits: CrossAreaHit[] = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const job = jobs[cursor++];
        if (!job) return;
        const body = await this.get(
          `/prescriptions?treatment=${job.t.id}&therapyType=${AREA_TO_THERAPY_TYPE[job.voArea]}&itemsPerPage=50`,
        );
        for (const m of body.member ?? []) {
          hits.push({
            prescriptionId: m.id,
            vo: m.prescriptionId,
            voArea: job.voArea,
            code: job.t.code ?? String(job.t.id),
            feeArea: job.t.area!,
            kind: job.t.kind,
            imported: m.imported ?? null,
            treatmentStatus: m.treatmentStatus ?? null,
            creationValidationStatus: m.creationValidationStatus ?? null,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return hits;
  }

  /** The stored per-check verdicts of one VO, keyed by validation id. */
  async storedVerdicts(prescriptionId: number): Promise<Map<number, boolean | null>> {
    const body = await this.get(
      `/prescription_validations?pagination=false&prescription=%2Fprescriptions%2F${prescriptionId}`,
    );
    const out = new Map<number, boolean | null>();
    for (const row of body.member ?? []) {
      const raw = row.validation;
      const id = typeof raw === 'object' && raw ? raw.id : Number(String(raw ?? '').split('/').pop());
      if (Number.isFinite(id)) out.set(Number(id), row.passed ?? null);
    }
    return out;
  }

  /** A VO's own Fachbereich and catalogue ids, for re-evaluating a REAL VO through the preview. */
  async voShape(prescriptionId: number): Promise<{ vo: string; therapyType: string | null; insuranceType: string | null; treatmentIds: number[]; codes: string[] }> {
    // No `groups[]`: the GroupFilter is registered with `overrideDefaultGroups: true`, so naming a
    // group REPLACES the default set — `groups[]=billing:read` is exactly how `therapyType` came
    // back null in the first survey of this population.
    const body = await this.get(`/prescriptions/${prescriptionId}`);
    const ids: number[] = [];
    const codes: string[] = [];
    for (const pt of body.prescribedTreatments ?? []) {
      const t = pt.treatment;
      if (!t) continue;
      // An EMBEDDED treatment carries `@id` but no bare `id` — the same shape #3603 records for an
      // embedded ActivityTreatment. Reading `t.id` here yields undefined for every row and the
      // rebuilt payload comes back with nothing prescribed, which the check then passes.
      const id = t.id ?? Number(String(t['@id'] ?? '').split('/').pop());
      if (Number.isFinite(id)) {
        ids.push(Number(id));
        codes.push(t.code ?? String(id));
      }
    }
    return {
      vo: body.prescriptionId,
      therapyType: body.therapyType ?? null,
      insuranceType: body.insuranceType ?? null,
      treatmentIds: ids,
      codes,
    };
  }
}
