import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 — #3873 (`6deed2aa6`): the Therapeuten-Orga "VO läuft ab ≤ 7 T" tile keeps its title but
 * changes what it lists — from VOs whose VALIDITY ends within 7 days to VOs that have **not
 * started** and whose **Startfrist** falls within the next 7 days — with three new row texts.
 *
 * **Read-only:** every request is a GET.
 *
 * **The tile's own payload is the oracle and the rule is re-derived against it**, because the
 * change is which rows the provider emits: `GET /kpis/orga/risks` serves them, each VO's
 * `treatmentStartDeadline` is serialized, and `/activities` says whether it has started.
 */

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';
const TILE = 'laeuftAb';
const OPEN = ['Pending', 'Bereit', 'Aktiv', 'For Review', 'Sent Back to Therapist'];

/** The three texts this ticket introduces, and the three they replace. */
const NEW_TEXT = {
  topic: 'Startfrist in ≤ 7 Tagen',
  statusDeadline: 'Startfrist in {{days}} T ({{date}})',
  action: 'Behandlung vor der Startfrist beginnen',
} as const;
const REPLACED = {
  topic: 'VO läuft in ≤ 7 Tagen ab',
  statusDeadline: 'Läuft ab in {{days}} T ({{date}})',
  action: 'Vor Ablauf abrechnen / Folge-VO anstoßen',
} as const;
/** Controls: strings the ticket's Out of Scope keeps, so a zero above means something. */
const UNCHANGED = ['VO läuft ab ≤ 7 T', 'Offene Risiken', 'Empfohlene Aktion'] as const;

/** Marked test accounts are joined out of the risk board (#3505) — a pre-existing exclusion. */
const TEST_ACCOUNT_THERAPISTS = [6, 31, 198];

let api: APIRequestContext;
let token = '';

async function get<T>(path: string, timeout = 500_000): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const res = await api.get(path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout,
    });
    if (res.ok()) return (await res.json()) as T;
    if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
    await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
  }
  throw new Error(`GET ${path} failed`);
}

/**
 * The bundle escapes non-ASCII — and in BOTH forms: `ä` becomes `\xe4` but `≤` (U+2264) becomes
 * `≤`. A helper that only emits `\xNN` reports 0 for every string containing `≤`, including
 * the tile title this ticket does NOT change — which is how a correct build reads as un-shipped.
 */
function escapeNonAscii(text: string): string {
  return [...text]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 128) return ch;
      if (c < 256) return `\\x${c.toString(16).padStart(2, '0')}`;
      return `\\u${c.toString(16).padStart(4, '0')}`;
    })
    .join('');
}

function occurrences(hay: string, needle: string): number {
  const esc = escapeNonAscii(needle);
  const plain = hay.split(needle).length - 1;
  return plain + (esc === needle ? 0 : hay.split(esc).length - 1);
}

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

const TODAY = iso(new Date());
const HORIZON = iso(new Date(Date.parse(`${TODAY}T00:00:00Z`) + 7 * 86_400_000));

type Row = {
  tile: string; prescriptionId: number; voNumber: string; isPrivate: boolean;
  therapistId: number; statusDate: string | null; daysUntil: number | null;
  voStatus: string | null; activityCount: number | null; revenue: number | null;
};

test.describe('#3873 the expiry tile lists unstarted VOs by Startfrist', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  let tiles: Record<string, number>;
  let rows: Row[];
  let tileRows: Row[];

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    api = await pwRequest.newContext({ baseURL: API });
    const res = await api.post('/auth', {
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 90_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    token = (await res.json()).token;
    const body = await get<{ member?: { tiles: Record<string, number>; rows: Row[] }[] }>('/kpis/orga/risks');
    tiles = body.member![0].tiles;
    rows = body.member![0].rows;
    tileRows = rows.filter((r) => r.tile === TILE);
    console.log(`  today ${TODAY}; tiles ${JSON.stringify(tiles)}; ${TILE} rows ${tileRows.length}`);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: the three new texts ship and the three they replace are gone',
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly'] },
    async ({ page }) => {
      const html = await (await page.request.get(`${WEB}/`, { timeout: 120_000 })).text();
      const entry = html.match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/);
      expect(entry, 'the served HTML names an entry bundle').not.toBeNull();
      const js = await (await page.request.get(`${WEB}${entry![0]}`, { timeout: 300_000 })).text();

      // A frontend-only text change, so the dictionary is the probe (/status is the API, #3705).
      for (const [k, v] of Object.entries(NEW_TEXT)) {
        const n = occurrences(js, v);
        console.log(`  new [${k}]: ${n}  ${JSON.stringify(v)}`);
        expect(n, `the new ${k} text ships`).toBeGreaterThan(0);
      }
      // A replacement, not an addition — so the old ones must be gone, which is the half that shows
      // the cutover rather than merely that something new exists.
      for (const [k, v] of Object.entries(REPLACED)) {
        const n = occurrences(js, v);
        console.log(`  replaced [${k}]: ${n}`);
        expect(n, `the superseded ${k} text is gone`).toBe(0);
      }
      // ...and the controls the Out of Scope keeps, so those zeros mean something. The tile TITLE
      // is the sharpest control here: it contains "≤" and is explicitly unchanged, so if the
      // escaping is wrong it reads 0 too and every assertion above is worthless.
      for (const t of UNCHANGED) {
        const n = occurrences(js, t);
        console.log(`  unchanged [${t}]: ${n}`);
        expect(n, `${t} is still shipped`).toBeGreaterThan(0);
      }
    },
  );

  test(
    'AC1/AC5: every listed VO is unstarted, open, non-PKV, and the tile number equals the rows',
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly'] },
    async () => {
      expect(tileRows.length, 'the tile number equals its row count').toBe(tiles[TILE]);
      expect(tileRows.length, 'the tile has rows to check').toBeGreaterThan(0);

      const started = tileRows.filter((r) => (r.activityCount ?? 0) !== 0);
      const pkv = tileRows.filter((r) => r.isPrivate === true);
      const closed = tileRows.filter((r) => !OPEN.includes(r.voStatus ?? ''));
      console.log(`  activityCount: ${JSON.stringify(tileRows.reduce<Record<string, number>>((a, r) => { const k = String(r.activityCount); a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
      console.log(`  voStatus: ${JSON.stringify([...new Set(tileRows.map((r) => r.voStatus))])}`);
      console.log(`  started ${started.length}, PKV ${pkv.length}, not-open ${closed.length}`);
      expect(started, 'no VO in treatment is listed (AC7)').toHaveLength(0);
      expect(pkv, 'no PKV VO is listed — PKV has no Startfrist').toHaveLength(0);
      expect(closed, 'every listed VO is in an open status').toHaveLength(0);

      // The Out of Scope keeps the Value column, and says it is 0,00 € for every VO here — which
      // follows from "not started" and is worth pinning, since it is the visible consequence.
      const nonZero = tileRows.filter((r) => (r.revenue ?? 0) !== 0);
      console.log(`  rows with a non-zero Wert: ${nonZero.length}`);
      expect(nonZero, 'an unstarted VO has no documented value').toHaveLength(0);
    },
  );

  test(
    "AC2: the tile uses the VO's OWN Startfrist and does not calculate its own",
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly'] },
    async () => {
      // AC2's point is that the tile reuses the date Flow already shows, so the check is an
      // identity against `treatmentStartDeadline` — not a re-implementation of the 28/14/7 rules,
      // which would pass even if the tile had its own copy that happened to agree.
      const seen: string[] = [];
      for (const r of tileRows) {
        const found = await get<{ member?: any[] }>(
          `/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(r.voNumber)}&itemsPerPage=1`,
        );
        const vo = await get<any>(`/prescriptions/${found.member![0].id}`);
        const sd = (vo.treatmentStartDeadline ?? '').slice(0, 10);
        const gap = daysBetween(vo.date, sd);
        console.log(`  ${r.voNumber.padEnd(11)} issue ${vo.date.slice(0, 10)} startDl ${sd} (issue+${gap}) statusDate ${String(r.statusDate).slice(0, 10)} daysUntil ${r.daysUntil}`);
        expect(String(r.statusDate).slice(0, 10), `${r.voNumber}: the row's date IS the VO's Startfrist`).toBe(sd);
        expect(r.daysUntil, `${r.voNumber}: daysUntil counts from today to it`).toBe(daysBetween(TODAY, sd));
        expect(r.daysUntil!, `${r.voNumber}: within the 7-day window`).toBeGreaterThanOrEqual(0);
        expect(r.daysUntil!, `${r.voNumber}: within the 7-day window`).toBeLessThanOrEqual(7);
        seen.push(`issue+${gap}`);
      }
      // AC2's table has three rules (28 / 14 / 7). Report which are exercised rather than requiring
      // all three, since that depends on what is live today.
      console.log(`  Startfrist rules exercised: ${JSON.stringify([...new Set(seen)])}`);
      expect(new Set(seen).size, 'at least one Startfrist rule is exercised').toBeGreaterThan(0);
    },
  );

  test(
    'AC4: rows are ordered soonest Startfrist first',
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly'] },
    async () => {
      const days = tileRows.map((r) => r.daysUntil ?? 0);
      console.log(`  daysUntil in served order: ${JSON.stringify(days)}`);
      const sorted = [...days].sort((a, b) => a - b);
      expect(days, 'the soonest Startfrist is listed first').toEqual(sorted);
    },
  );

  test(
    'the rule re-derived independently over the whole candidate window',
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly', '@Slow'] },
    async () => {
      // A Startfrist inside [today, today+7] means an issue date inside [today-28, today+7-7], so
      // the candidate set is reachable by the one filter that narrows. The collected count is
      // checked against totalItems, or a truncated read would invent agreement.
      const after = iso(new Date(Date.parse(`${TODAY}T00:00:00Z`) - 29 * 86_400_000));
      const q = `date%5Bafter%5D=${after}&date%5Bbefore%5D=${HORIZON}`;
      const expected = (await get<{ totalItems: number }>(`/prescriptions?${q}&itemsPerPage=1`)).totalItems;
      const vos: any[] = [];
      for (let page = 1; page <= 30; page++) {
        const m = (await get<{ member?: any[] }>(`/prescriptions?${q}&itemsPerPage=100&page=${page}`)).member ?? [];
        vos.push(...m);
        if (m.length < 100) break;
      }
      console.log(`  candidate window ${after}..${HORIZON}: ${vos.length} of ${expected}`);
      expect(vos.length, 'the candidate walk is complete').toBe(expected);

      const shouldList: string[] = [];
      const excludedByTestAccount: string[] = [];
      const excludedByStart: string[] = [];
      for (const v of vos) {
        if (!OPEN.includes(v.treatmentStatus ?? '')) continue;
        if (v.insuranceType === 'private') continue;
        const full = await get<any>(`/prescriptions/${v.id}`);
        const sd = (full.treatmentStartDeadline ?? '').slice(0, 10);
        if (!sd || sd < TODAY || sd > HORIZON) continue;
        const acts = (await get<{ member?: any[] }>(`/activities?prescription=${v.id}&itemsPerPage=300`)).member ?? [];
        // AC1's definition: a planned appointment and a refused session WITHOUT a signature do not
        // count as a session.
        const done = acts.filter(
          (a) => a.treatmentType !== 'planned' && !(a.rejectedTreatment && !a.rejectedTreatmentWithSignature),
        );
        if (done.length > 0) { excludedByStart.push(`${v.prescriptionId} (${done.length} sessions)`); continue; }
        const th = full.therapist;
        const thId = typeof th === 'number' ? th : th?.id ?? null;
        if (thId !== null && TEST_ACCOUNT_THERAPISTS.includes(thId)) {
          excludedByTestAccount.push(`${v.prescriptionId} (therapist ${thId})`);
          continue;
        }
        shouldList.push(v.prescriptionId);
      }
      const listed = new Set(tileRows.map((r) => r.voNumber));
      console.log(`  rule says list: ${shouldList.length} ${JSON.stringify(shouldList)}`);
      console.log(`  tile lists:     ${listed.size} ${JSON.stringify([...listed])}`);
      console.log(`  excluded because treatment has started: ${JSON.stringify(excludedByStart)}`);
      console.log(`  excluded because the therapist is a marked test account: ${JSON.stringify(excludedByTestAccount)}`);

      // AC7's own case must occur, or "a VO in treatment is not listed" is vacuous.
      expect(excludedByStart.length, 'at least one started VO was in range and correctly left off').toBeGreaterThan(0);
      expect([...shouldList].sort(), 'the tile lists exactly the VOs the rule selects').toEqual([...listed].sort());
    },
  );

  test(
    'the test-account exclusion is systematic, which is why the re-derivation must model it',
    { tag: ['@SuperAdmin', '@ExpiryTileStartfrist', '@ReadOnly'] },
    async () => {
      // Pinned because without it the re-derivation above reports a VO the tile "should" list and
      // does not — reading as a defect. The board joins marked test accounts out (#3505), and that
      // is pre-existing rather than #3873's doing.
      const byTherapist = rows.reduce<Record<number, number>>((a, r) => { a[r.therapistId] = (a[r.therapistId] ?? 0) + 1; return a; }, {});
      console.log(`  risks payload: ${rows.length} rows across ${Object.keys(byTherapist).length} therapists`);
      for (const t of TEST_ACCOUNT_THERAPISTS) {
        const u = await get<any>(`/users/${t}`);
        console.log(`    therapist ${t} (${u.fullName ?? ''}): isTestAccount=${u.isTestAccount}, rows on the board ${byTherapist[t] ?? 0}`);
        expect(u.isTestAccount, `therapist ${t} is a marked test account`).toBe(true);
        expect(byTherapist[t] ?? 0, `therapist ${t} contributes no rows`).toBe(0);
      }
      // The control that stops this being "the board is empty for everyone".
      const busiest = Object.entries(byTherapist).sort((a, b) => b[1] - a[1])[0];
      const u = await get<any>(`/users/${busiest[0]}`);
      console.log(`    busiest therapist ${busiest[0]}: ${busiest[1]} rows, isTestAccount=${u.isTestAccount}`);
      expect(u.isTestAccount ?? false, 'a non-test therapist does contribute rows').toBeFalsy();
    },
  );
});
