import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * PRODUCTION — RC 3.14 **#3708** (Privat Basis VOs use the GKV check set) and **#3709** (they expire
 * automatically like GKV). Both shipped in the SAME commit `28f402375` plus migration
 * `Version20260916070000`, so deploying one deploys the other — which is why they are verified
 * together and each acts as an independent probe for the pair.
 *
 * **READ-ONLY:** every request is a GET. Nothing is validated, expired or saved.
 */

const PROD_API = 'https://api.app.therapios.de';
const TODAY = new Date().toISOString().slice(0, 10);
const OPEN = ['Aktiv', 'Pending', 'Bereit', 'For Review', 'Sent Back to Therapist'];

/** The 11 checks `Version20260916070000` excludes, and AC3's five categories they map to. */
const EXCLUDED_BY_CATEGORY: Record<string, string[]> = {
  'copayment / exemption': ['active_exemption_covering_period', 'co_payment_calculation', 'exemption_stored'],
  '9-month billing deadline': ['billing_deadline_9_months'],
  'Blanko / LHB / BVB': ['blank_prescription_deadline', 'bvb_icd_or_approval', 'lhb_icd_in_list', 'missed_lhb_bvb_option'],
  discharge: ['discharge_info_present', 'discharge_management_timing'],
  'group-therapy switch': ['group_therapy_switch_documented'],
};

let api: APIRequestContext;
let token = '';

async function get<T>(path: string, timeout = 400_000): Promise<T> {
  const res = await api.get(path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
    timeout,
  });
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
  return (await res.json()) as T;
}

type Validation = { description: string; timing: string; severity: string; applicableInsuranceTypes: string[] };
type Vo = {
  id: number; prescriptionId: string; date: string; treatmentStatus?: string;
  insuranceType?: string; urgentTreatmentNeed?: boolean; blankoVO?: boolean;
  treatmentStartDeadline?: string; validityDate?: string;
};

function day(v?: string): string | null {
  return v ? v.slice(0, 10) : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

test.describe('#3708 + #3709 Privat Basis on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_200_000);

  let checks: Validation[];
  let pb: Vo[];

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    api = await pwRequest.newContext({ baseURL: PROD_API });
    const res = await api.post('/auth', {
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 90_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    token = (await res.json()).token;
    checks = (await get<{ member?: Validation[] }>('/validations?itemsPerPage=100')).member ?? [];
    pb = (await get<{ member?: Vo[] }>('/prescriptions?insuranceType=privat_basis&itemsPerPage=50')).member ?? [];
    console.log(`  ${checks.length} validations; ${pb.length} Privat Basis VOs`);
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test(
    "#3708: Privat Basis holds the GKV set minus exactly the migration's 11 exclusions",
    { tag: ['@SuperAdmin', '@ProdPrivatBasis', '@ReadOnly'] },
    async () => {
      // The whole ticket is ONE served column, so no sampled VO is needed. `/validations` needs its
      // itemsPerPage raised or the default page hides most of the 51.
      const withType = (t: string) => new Set(checks.filter((c) => (c.applicableInsuranceTypes ?? []).includes(t)).map((c) => c.description));
      const pub = withType('public');
      const basis = withType('privat_basis');
      const priv = withType('private');
      const disabled = checks.filter((c) => (c.applicableInsuranceTypes ?? []).length === 0);
      console.log(`  public ${pub.size}, privat_basis ${basis.size}, private ${priv.size}, disabled ${disabled.length}`);

      // CONTAINMENT FIRST: the migration appends `privat_basis` to every row carrying `public`, so
      // without this `public − excluded` is not a superset and the target silently under-counts.
      const strays = [...basis].filter((d) => !pub.has(d));
      console.log(`  privat_basis checks NOT carrying public: ${strays.length} ${JSON.stringify(strays)}`);
      expect(strays, 'every Privat Basis check is a GKV check').toHaveLength(0);

      // The migration's arithmetic, exactly: public − 11 = privat_basis.
      const excluded = [...pub].filter((d) => !basis.has(d)).sort();
      console.log(`  public MINUS privat_basis (${excluded.length}): ${JSON.stringify(excluded)}`);
      expect(basis.size, 'privat_basis = public − the 11 exclusions').toBe(pub.size - 11);
      expect(excluded.length, 'exactly 11 are excluded').toBe(11);

      // AC3 names five CATEGORIES and the migration names eleven descriptions — the correspondence
      // is what nothing else states, so it is pinned rather than counted.
      const mapped = Object.values(EXCLUDED_BY_CATEGORY).flat().sort();
      expect(excluded, "the exclusions are AC3's five categories, itemised").toEqual(mapped);
      for (const [cat, list] of Object.entries(EXCLUDED_BY_CATEGORY)) {
        for (const d of list) {
          // Each must exist AND be a GKV check — an "exclusion" GKV does not have either would be
          // a migration no-op and a sign the list had drifted.
          expect(checks.some((c) => c.description === d), `${d} exists`).toBe(true);
          expect(pub.has(d), `${d} is a GKV check`).toBe(true);
          expect(basis.has(d), `${d} is off for Privat Basis`).toBe(false);
        }
        console.log(`    ${cat}: ${list.length}`);
      }

      const byTiming = [...basis].reduce<Record<string, number>>((a, d) => {
        const t = checks.find((c) => c.description === d)!.timing;
        a[t] = (a[t] ?? 0) + 1;
        return a;
      }, {});
      console.log(`  privat_basis by timing: ${JSON.stringify(byTiming)}`);

      // AC5: the PKV set must NOT change. Structural, since the migration matches on `public` and
      // never on `private` — but asserted, because it is the other half of the ticket.
      expect(priv.size, 'the PKV set is untouched').toBeGreaterThan(0);
      console.log(`  PKV set: ${priv.size} checks (AC5 — unchanged by the migration)`);
    },
  );

  test(
    '#3709 IS deployed: a Privat Basis VO serves both expiry inputs, and PKV still serves neither',
    { tag: ['@SuperAdmin', '@ProdPrivatBasis', '@ReadOnly'] },
    async () => {
      // The job is console-only, but its two INPUTS are serialized — and both return null for an
      // excluded insurance type BEFORE any rule runs, so a Privat Basis VO serving them IS the
      // deployed build. `/status` cannot settle it (release, not commit — #3704).
      expect(pb.length, 'production has Privat Basis VOs').toBeGreaterThan(0);
      const missing = pb.filter((v) => !v.treatmentStartDeadline);
      console.log(`  Privat Basis VOs serving a start deadline: ${pb.length - missing.length} of ${pb.length}`);
      expect(missing, 'every Privat Basis VO gets a start deadline').toHaveLength(0);

      // THE CONTROL IS MANDATORY: both fields are legitimately null on many GKV VOs (no first
      // treatment ⇒ no validity window), so "Privat Basis serves a value" only means something
      // beside a type that serves none.
      const gkv = (await get<{ member?: Vo[] }>('/prescriptions?insuranceType=public&itemsPerPage=40&date%5Bafter%5D=2026-06-01')).member ?? [];
      const pkv = (await get<{ member?: Vo[] }>('/prescriptions?insuranceType=private&itemsPerPage=40')).member ?? [];
      const gkvStart = gkv.filter((v) => v.treatmentStartDeadline).length;
      const gkvValid = gkv.filter((v) => v.validityDate).length;
      const pkvStart = pkv.filter((v) => v.treatmentStartDeadline).length;
      const pkvValid = pkv.filter((v) => v.validityDate).length;
      console.log(`  GKV control (${gkv.length}): start ${gkvStart}, validity ${gkvValid}  <- validity is legitimately absent on some`);
      console.log(`  PKV control (${pkv.length}): start ${pkvStart}, validity ${pkvValid}  <- excluded from expiry entirely`);
      expect(pkvStart, 'AC5: PKV still gets no start deadline').toBe(0);
      expect(pkvValid, 'AC5: PKV still gets no validity').toBe(0);
      expect(gkvStart, 'GKV does get one, so the fields are not globally off').toBeGreaterThan(0);
    },
  );

  test(
    "#3709 AC2/AC3: the 28-day rule, and the 14-day urgent branch which staging could not exercise",
    { tag: ['@SuperAdmin', '@ProdPrivatBasis', '@ReadOnly'] },
    async () => {
      const rows = pb.map((v) => ({
        vo: v.prescriptionId,
        issued: day(v.date)!,
        gap: daysBetween(v.date, v.treatmentStartDeadline!),
        urgent: v.urgentTreatmentNeed === true,
        blanko: v.blankoVO === true,
        status: v.treatmentStatus,
      }));
      for (const r of rows.sort((a, b) => a.issued.localeCompare(b.issued))) {
        console.log(`    ${r.vo.padEnd(11)} issued ${r.issued}  +${String(r.gap).padStart(2)}d  urgent=${r.urgent}  ${r.status}`);
      }

      // `urgentTreatmentNeed` is OMITTED when false, so it reads undefined — the rule tests === true
      // and so does this.
      const urgent = rows.filter((r) => r.urgent);
      const plain = rows.filter((r) => !r.urgent);
      console.log(`  urgent ${urgent.length} (expect +14), not urgent ${plain.length} (expect +28)`);
      for (const r of plain) expect(r.gap, `${r.vo} takes the 28-day rule`).toBe(28);
      for (const r of urgent) expect(r.gap, `${r.vo} takes the 14-day urgent rule`).toBe(14);

      // AC3's urgent branch has a LIVE instance here, which staging lacked — on staging the only
      // urgent Privat Basis VO was already Fertig Behandelt and so out of scope.
      expect(urgent.length, "AC3's urgent branch is exercised on production").toBeGreaterThan(0);

      // AC3's other half cannot ever apply: the rule is `isUrgentTreatmentNeed() || UV === type`,
      // and a VO is either privat_basis or accident, never both — so for a Privat Basis VO only
      // the urgent condition can produce 14 days. Asserted as data.
      expect(pb.every((v) => v.insuranceType === 'privat_basis'), 'none is also an accident VO').toBe(true);
    },
  );

  test(
    '#3709: nothing is stranded — the catch-up invariant holds on production',
    { tag: ['@SuperAdmin', '@ProdPrivatBasis', '@ReadOnly', '@Slow'] },
    async () => {
      // The durable form (#3709's own lesson): a flat "no Privat Basis VO is overdue" would fail
      // every day between a deadline passing and the next nightly run, so the question is whether
      // any OPEN VO is past a boundary the rule would have acted on.
      const stranded: string[] = [];
      for (const v of pb) {
        const acts = (await get<{ member?: any[] }>(`/activities?prescription=${v.id}&itemsPerPage=300`)).member ?? [];
        const done = acts
          .filter((a) => a.treatmentType !== 'planned' && !(a.rejectedTreatment && !a.rejectedTreatmentWithSignature))
          .map((a) => a.date.slice(0, 10))
          .sort();
        const first = done[0] ?? null;
        const sd = day(v.treatmentStartDeadline);
        const vd = day(v.validityDate);
        const open = OPEN.includes(v.treatmentStatus ?? '');
        const due = open && ((!first && sd && sd < TODAY) || (first && vd && vd < TODAY));
        const logs = (await get<{ member?: any[] }>(`/prescription_logs?prescription=${v.id}&type=treatment_expired&itemsPerPage=5`)).member ?? [];
        console.log(`    ${v.prescriptionId.padEnd(11)} ${String(v.treatmentStatus).padEnd(17)} start ${sd} valid ${vd} 1stBeh ${first ?? '-'} due=${due} logs=${logs.length}`);
        if (due && logs.length === 0) stranded.push(`${v.prescriptionId}: start ${sd}, validity ${vd}, first treatment ${first ?? 'none'}`);
      }
      console.log(`  OPEN Privat Basis VOs the rule says should have expired, with no expiry log: ${stranded.length}`);
      for (const s of stranded) console.log(`    ${s}`);

      // Unlike #3800 on production, nothing here is sitting past a boundary: every open VO that
      // passed its start deadline had its first treatment BEFORE that deadline, so the rule
      // correctly does not fire, and none has passed its validity date.
      expect(stranded, 'no Privat Basis VO is stranded past a boundary').toHaveLength(0);
    },
  );
});
