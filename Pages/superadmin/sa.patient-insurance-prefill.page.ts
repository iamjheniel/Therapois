import { APIRequestContext, Page, expect } from '@playwright/test';
import { STAGING_CREDENTIALS, mintUiSession } from '../util/api-token';

/**
 * Patient-level Insurance Type + Versichertenstatus and their one-time pre-fill (RC 3.12 #3382).
 *
 * Two nullable fields on the patient, filled once from the patient's VO history. The fill's rule,
 * read from `PrefillPatientInsuranceCommand` rather than inferred:
 *
 *   ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY date DESC, id DESC)
 *     over prescriptions WHERE insurance_type IS NOT NULL
 *
 * — newest **issue date** wins, ties break on the highest prescription id — carrying
 * `versichertenstatus` only when the winner is GKV, and writing `WHERE id = ? AND insurance_type IS
 * NULL` so it is idempotent and can never overwrite a value an admin set.
 *
 * `expectedFill()` re-implements exactly that, so a spec can re-derive the whole population instead
 * of eyeballing one patient.
 *
 * **The trap that cost a false finding here: `versichertenstatus` is NOT in the `billing:read`
 * serialization group.** It appears only under the default group. Reading VOs through the light
 * group — the natural choice, since it is 5x smaller — returns `undefined` for every VO, which is
 * indistinguishable from "not set", and every patient whose winning VO carries a code then looks
 * like a mismatch. `winningVoVersichertenstatus()` re-reads the one VO that matters under the
 * default group.
 *
 * **A second silent-filter trap in the same area:** `/patients` registers no facility or insurance
 * filter, and API Platform ignores unknown query parameters without complaint — a "filtered" total
 * that equals the unfiltered one is being ignored, not answered.
 */

export type PatientInsurance = {
  id: number;
  number: number;
  insuranceType: string;
  versichertenstatus: string;
};

export type VoInsurance = {
  number: string;
  /** Ausstellungsdatum — the issue date the fill orders on, not the creation date. */
  date: string;
  insuranceType: string;
};

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

export class PatientInsurancePrefillPage {
  static readonly API = 'https://api.staging.therapios.de';
  /** The four options AC1 requires, as the enum stores them. */
  static readonly INSURANCE_TYPES = ['public', 'private', 'accident', 'privat_basis'] as const;
  /** AC2's four codes. */
  static readonly VERSICHERTENSTATUS_CODES = ['10000', '30000', '50000', '50001'] as const;

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private async json(path: string): Promise<any> {
    const response = await this.request.get(`${PatientInsurancePrefillPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  /**
   * A spread sample of patients. `/patients` is ~14 KB per patient and a contiguous walk 504s, so
   * pages are taken across the id space.
   */
  async samplePatients(opts: { perPage?: number; stride?: number; pages?: number } = {}): Promise<PatientInsurance[]> {
    const perPage = opts.perPage ?? 40;
    const stride = opts.stride ?? 13;
    const pages = opts.pages ?? 16;
    const out: PatientInsurance[] = [];
    const seen = new Set<number>();
    for (let page = 1, taken = 0; taken < pages; page += stride, taken++) {
      const body = await this.json(`/patients?page=${page}&itemsPerPage=${perPage}`);
      const rows = PatientInsurancePrefillPage.members(body);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push({
          id: row.id,
          number: row.patientId,
          insuranceType: text(row.insuranceType),
          versichertenstatus: text(row.versichertenstatus),
        });
      }
    }
    return out;
  }

  /** One patient's VOs, newest issue date first. The light group is enough for the type and date. */
  async voHistory(patientId: number): Promise<VoInsurance[]> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=100&patient.id=${patientId}&groups%5B%5D=billing%3Aread&order%5Bdate%5D=desc`,
    );
    return PatientInsurancePrefillPage.members(body).map((row: any) => ({
      number: String(row.prescriptionId ?? ''),
      date: text(row.date).slice(0, 10),
      insuranceType: text(row.insuranceType),
    }));
  }

  /**
   * The winning VO's Versichertenstatus, re-read under the DEFAULT group — `billing:read` omits the
   * field entirely, so reading it there yields `undefined` for every VO. See the class docs.
   */
  async winningVoVersichertenstatus(voNumber: string): Promise<string> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=3&exact%5BprescriptionId%5D=${encodeURIComponent(voNumber)}`,
    );
    return text(PatientInsurancePrefillPage.members(body)[0]?.versichertenstatus);
  }

  /**
   * The command's selection, re-implemented: newest issue date wins, and Versichertenstatus rides
   * along only for GKV. Returns `winner: null` when no VO carries an insurance type (AC4).
   */
  static expectedFill(
    history: VoInsurance[],
  ): { insuranceType: string; winner: VoInsurance | null; sameDateCount: number } {
    const withInsurance = history.filter((vo) => vo.insuranceType !== '');
    if (withInsurance.length === 0) return { insuranceType: '', winner: null, sameDateCount: 0 };
    const winner = withInsurance.reduce((a, b) => (b.date > a.date ? b : a));
    return {
      insuranceType: winner.insuranceType,
      winner,
      // The command breaks a date tie on the highest prescription id, which the API's date ordering
      // does not expose — a caller must resolve these rather than count them as failures.
      sameDateCount: withInsurance.filter((vo) => vo.date === winner.date).length,
    };
  }

  /** Opens a patient's edit form for the AC1/AC2 visibility checks. Call BEFORE any navigation. */
  static async openPatientForm(page: Page, patientId: number): Promise<void> {
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
    await page.setViewportSize({ width: 1600, height: 1400 });
    await page.goto(`/patient-management/${patientId}/edit`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Patient bearbeiten').first()).toBeVisible({ timeout: 60_000 });
    // The form paints its section headers before the values arrive.
    await expect(page.getByText('VERSICHERUNG', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await page.evaluate(() => document.body.innerText)).includes('Versicherungsart'), {
        timeout: 30_000,
        intervals: [500],
      })
      .toBe(true);
  }

  /** The labels the Versicherung section renders, in order — enough to assert presence and order. */
  static async insuranceSectionLines(page: Page): Promise<string[]> {
    const body = await page.evaluate(() => document.body.innerText);
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    const start = lines.findIndex((line) => /^Versicherungsart$/i.test(line));
    return start < 0 ? [] : lines.slice(start, start + 8);
  }
}
