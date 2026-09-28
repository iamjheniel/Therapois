import { APIRequestContext } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Automatic Vorabinformation is skipped for a GKV VO with no Einrichtung (RC 3.13 #3512).
 *
 * #3202 stopped automatic generation for patients at Praxis-VO facilities; a VO with NO facility
 * still slipped through, because `PRAXIS_VO !== null` is true. The fix (`ce9df2b44`) puts a shared
 * `PreTreatmentNoticeAutoGenerationPolicy` in front of BOTH creation paths — the API processor and
 * the CSV importer, which had never received #3202's guard at all.
 *
 * **The rule keys off the VO's Einrichtung, not the patient profile's**, and the dev called that out
 * for a concrete reason: the CSV importer never writes the patient's Einrichtung, so a
 * patient-profile check would wrongly skip generation for patients who genuinely are at a facility.
 * A notice, however, records only its PATIENT — so patient-profile facility is a proxy here, and the
 * tests say so rather than implying the two are the same field.
 *
 * **THE TRAP, and it inverts the result completely:** `groups[]=billing:read` **replaces** the
 * default serialization group (`overrideDefaultGroups: true`), and `elderlyCareHome` is not in it —
 * so a VO read through that group reports **no facility for every VO on staging**, which reads
 * exactly like "the whole population is unaffected by this rule". Read VOs WITHOUT the override.
 * `assertFacilityIsSerialized()` pins the difference so the trap cannot return silently.
 *
 * **The cutover is the 3.13.0 staging deploy, not the commit date.** `ce9df2b44` is dated
 * 2026-08-27 but is an ancestor of `release/3.13.0` ONLY (it diverged from `release/3.12.0` and
 * `main`), and staging took 3.13.0 at 2026-09-09T02:38 — so notices created between those two dates
 * are still pre-fix. Partitioning on the commit date instead would misclassify the most recent
 * violation, notice 10228 of 2026-09-04.
 */

export type Notice = { id: number; patientId: string; createdAt: string; status: string; discipline: string };

/** The 3.13.0 staging deploy — where this rule starts applying. */
export const CUTOVER = '2026-09-09T02:38';

/**
 * The pre-fix population AC5 protects: notices held by patients with no facility, all created
 * before the cutover. Pinned as a fixture because AC5's whole content is that they do not change —
 * re-deriving it each run would cost a 3,272-patient sweep to prove a list that must be static.
 */
export const PRE_FIX_NO_FACILITY_NOTICES = [
  { noticeId: 6937, patientId: '7655', createdAt: '2026-06-02T12:22:25', name: 'Rosemarie Wörnle' },
  { noticeId: 8316, patientId: '7899', createdAt: '2026-06-17T07:32:26', name: 'Doris Nattin' },
  { noticeId: 9256, patientId: '8135', createdAt: '2026-07-01T07:15:44', name: 'Stefanie Ottow Ketschendorfer ALT' },
  { noticeId: 9533, patientId: '8201', createdAt: '2026-07-07T08:46:30', name: 'Ralf Modess (NICHT NUTZEN)' },
  { noticeId: 9562, patientId: '8217', createdAt: '2026-07-07T10:39:57', name: 'Christel Augustin' },
  { noticeId: 9680, patientId: '8262', createdAt: '2026-07-09T11:28:57', name: 'Frauke Frehsee' },
  { noticeId: 9932, patientId: '8376', createdAt: '2026-07-16T08:42:08', name: 'Benno Hinze' },
  { noticeId: 10079, patientId: '8431', createdAt: '2026-07-29T01:32:25', name: 'Offline Testpatient S3b' },
  { noticeId: 10080, patientId: '8432', createdAt: '2026-07-29T01:44:22', name: 'Offline Testpatient S3c' },
  { noticeId: 10081, patientId: '8433', createdAt: '2026-07-29T01:44:33', name: 'Offline Testpatient S3d' },
  { noticeId: 10127, patientId: '13', createdAt: '2026-08-07T03:00:27', name: 'Gisela Adler' },
  { noticeId: 10138, patientId: '7050', createdAt: '2026-08-17T00:58:56', name: 'Jungkook Test' },
  { noticeId: 10228, patientId: '8479', createdAt: '2026-09-04T04:17:11', name: 'FT3602 DoppelTest' },
] as const;

/** The clearest surviving demonstration of the defect: a GKV VO with no facility, and its notice. */
export const DEFECT_DEMO = { prescriptionId: 34264, voNumber: '9656-1', noticeId: 10228, patientId: '8479' };

export class VorabinfoNoFacilityPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext, token?: string) {
    this.token = token ?? null;
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const creds: Credentials = STAGING_CREDENTIALS.superadmin;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
    });
    if (!res.ok()) throw new Error(`POST /auth failed: ${res.status()}`);
    this.token = (await res.json()).token;
    return this.token!;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.bearer();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120_000,
      });
      if (res.ok()) return (await res.json()) as T;
      if (res.status() === 401) this.token = null;
      if (attempt === 2) throw new Error(`GET ${path} -> ${res.status()}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error('unreachable');
  }

  /** One notice, or null when it no longer exists — AC5's question. */
  async notice(id: number): Promise<Notice | null> {
    const token = await this.bearer();
    const res = await this.request.get(`${API_BASE}/pre_treatment_notices/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60_000,
    });
    if (res.status() === 404) return null;
    if (!res.ok()) throw new Error(`GET notice ${id} -> ${res.status()}`);
    const b = await res.json();
    return {
      id: b.id,
      patientId: String(b.patient ?? '').split('/').pop() ?? '',
      createdAt: String(b.createdAt ?? '').slice(0, 19),
      status: b.status,
      discipline: b.discipline,
    };
  }

  /** Notices created on or after a timestamp — the post-fix window is tiny, so this is cheap. */
  async noticesSince(iso: string): Promise<Notice[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      '/pre_treatment_notices?itemsPerPage=400&order%5BcreatedAt%5D=desc',
    );
    return body.member
      .map((m) => ({
        id: m.id,
        patientId: String(m.patient ?? '').split('/').pop() ?? '',
        createdAt: String(m.createdAt ?? '').slice(0, 19),
        status: m.status,
        discipline: m.discipline,
      }))
      .filter((n) => n.createdAt >= iso);
  }

  /** Facility on the PATIENT profile, by name. `?id[]=` works on /patients (it does NOT on /invoices). */
  async patientFacilities(ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 50) {
      const q = ids.slice(i, i + 50).map((p) => `id%5B%5D=${p}`).join('&');
      const body = await this.get<{ member: Record<string, any>[] }>(`/patients?${q}&itemsPerPage=60`);
      for (const m of body.member) {
        const ech = m.elderlyCareHome;
        out.set(String(m.id), (typeof ech === 'string' ? ech : ech?.name) ?? null);
      }
    }
    return out;
  }

  /** A VO read WITHOUT the group override, so `elderlyCareHome` survives. */
  async prescription(id: number): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(`/prescriptions/${id}`);
  }

  /**
   * Proves the `groups[]` trap before any facility count is believed: the same VO reports its
   * Einrichtung under the default group and omits the field entirely under `billing:read`.
   */
  async facilitySerialization(id: number): Promise<{ withDefault: string | null; withBillingGroup: boolean }> {
    const plain = await this.get<Record<string, any>>(`/prescriptions/${id}`);
    const scoped = await this.get<Record<string, any>>(`/prescriptions/${id}?groups%5B%5D=billing:read`);
    const ech = plain.elderlyCareHome;
    return {
      withDefault: (typeof ech === 'string' ? ech : ech?.name) ?? null,
      withBillingGroup: 'elderlyCareHome' in scoped,
    };
  }

  /** The newest VOs, read WITHOUT the override, with their facility and creation time. */
  async recentPrescriptions(limit = 150): Promise<
    { id: number; number: string; insuranceType: string | null; facility: string | null; createdAt: string; patientId: string }[]
  > {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?itemsPerPage=${limit}&order%5Bid%5D=desc`,
    );
    return body.member.map((m) => {
      const ech = m.elderlyCareHome;
      const p = m.patient ?? {};
      return {
        id: m.id,
        number: m.prescriptionId,
        insuranceType: m.insuranceType ?? null,
        facility: (typeof ech === 'string' ? ech : ech?.name) ?? null,
        createdAt: String(m.createdAt ?? '').slice(0, 19),
        patientId: String(p['@id'] ?? p ?? '').split('/').pop() ?? '',
      };
    });
  }
}
