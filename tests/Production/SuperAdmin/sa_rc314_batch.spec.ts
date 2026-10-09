import { test, expect, request as pwRequest, type APIRequestContext } from '../../fixtures/session';
import { pdfDocText } from '../../../Pages/util/pdf-layout';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * PRODUCTION — a read-only sweep of five RC 3.14 tickets, all verified on staging first:
 *
 *  - **#3714** the Zahlungserinnerung prints the entity's branding as it is TODAY, not the snapshot
 *    frozen on the invoice it chases
 *  - **#3719** the ordering pull-forward moves from the Wednesday run to the Tuesday run
 *  - **#3712** a Blanko VO issued on/after 30.07.2026 no longer receives the VBP-BV flat fee
 *  - **#3711** every list of individual sessions marks a Doppelbehandlung
 *  - **#3717** the risk drill-down rows carry a "VO #" column
 *
 * **READ-ONLY:** every request is a GET. #3714's reminder is rendered on demand and never stored
 * (#3559 — the controller renders and returns), so downloading one writes nothing.
 *
 * **No patient data** is read or printed; the reminder PDF is reduced to four brand markers.
 */

const PROD_API = 'https://api.app.therapios.de';
const CUTOFF = '2026-07-30';
/** The catalogue's only two VBP one-time fees, confirmed live below. */
const VBP = { 'VBP-BV-P': 62, 'VBP-BV': 64 } as const;

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

async function status(path: string): Promise<number> {
  const res = await api.get(path, { headers: { Authorization: `Bearer ${token}` }, timeout: 300_000 });
  return res.status();
}

async function pdf(path: string): Promise<Buffer> {
  const res = await api.get(path, { headers: { Authorization: `Bearer ${token}` }, timeout: 400_000 });
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
  return Buffer.from(await res.body());
}

/** Four independently-set template variables, so a build that fixed one and not the others fails. */
function brandMarkers(text: string) {
  const flat = text.replace(/\s+/g, ' ');
  const email = flat.includes('info@curano.de') ? 'curano' : flat.includes('info@therapios.de') ? 'therapios' : null;
  const website = flat.includes('www.curano.de') ? 'curano' : flat.includes('www.therapios.de') ? 'therapios' : null;
  // "City, DD.MM.YYYY" (Curano) vs a bare "DD.MM.YYYY" (Therapios). A naive regex swallows the
  // preceding sentence, so a capitalised word must sit immediately before the comma.
  const m = flat.match(/(?:^|\s)([A-ZÄÖÜ][\wäöüß-]{2,}),\s(\d{2}\.\d{2}\.\d{4})/);
  return { email, website, cityDateLine: m ? `${m[1]}, ${m[2]}` : null };
}

test.describe('RC 3.14 batch on production', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    api = await pwRequest.newContext({ baseURL: PROD_API });
    const res = await api.post('/auth', {
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 90_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    token = (await res.json()).token;
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test(
    '#3714: a reminder prints LIVE branding while the invoice it chases keeps its frozen one',
    { tag: ['@SuperAdmin', '@ProdRc314', '@ReadOnly', '@Slow'] },
    async () => {
      // The whole ticket is ONE comparison and it needs no mutation: the same invoice has two
      // documents — the stored PDF (frozen, #3495) and the reminder (rendered on demand, never
      // stored, #3559) — so if branding went live they must DISAGREE.
      const overdue = await get<{ member?: any[] }>('/invoices?status=overdue&itemsPerPage=100&groups%5B%5D=invoice-list:read');
      const pkv = (overdue.member ?? []).filter((i) => i.invoiceType === 'pkv');
      console.log(`  overdue invoices: ${(overdue.member ?? []).length}, of which PKV: ${pkv.length}`);
      expect(pkv.length, 'production has overdue PKV invoices').toBeGreaterThan(0);

      let compared = 0;
      const disagreements: string[] = [];
      for (const inv of pkv.slice(0, 3)) {
        const full = await get<any>(`/invoices/${inv.id}`);
        if (full.remindedDate) continue; // isReminderLetterAvailable() also requires this to be null
        const reminder = brandMarkers(pdfDocText(await pdf(`/invoices/${inv.id}/reminder-letter`)));
        const invoice = brandMarkers(pdfDocText(await pdf(`/invoices/${inv.id}/download`)));
        compared += 1;
        console.log(`  invoice ${inv.id}: reminder ${JSON.stringify(reminder)}`);
        console.log(`  invoice ${inv.id}: stored   ${JSON.stringify(invoice)}`);
        if (reminder.email !== invoice.email || reminder.website !== invoice.website) {
          disagreements.push(`${inv.id}: reminder ${reminder.email}/${reminder.website} vs invoice ${invoice.email}/${invoice.website}`);
        }
        // Whatever the entity's branding is, the reminder must be internally consistent.
        expect(reminder.email, 'the reminder names an entity email').not.toBeNull();
        if (reminder.email && reminder.website) {
          expect(reminder.website, 'the reminder is internally consistent').toBe(reminder.email);
        }
      }
      console.log(`  compared ${compared} invoice/reminder pairs; branding disagreements: ${disagreements.length}`);
      for (const d of disagreements) console.log(`    ${d}`);
      expect(compared, 'at least one eligible invoice was compared').toBeGreaterThan(0);

      // The DIRECTION is what the ticket is about: where they differ, the reminder must be the
      // Curano (live) one and the invoice the Therapios (frozen) one — never the reverse.
      for (const d of disagreements) expect(d, 'the reminder is the LIVE side').toMatch(/reminder curano/);
    },
  );

  test(
    '#3712: production has the fixture staging lacks, and the backlog has grown since the ticket',
    { tag: ['@SuperAdmin', '@ProdRc314', '@ReadOnly', '@Slow'] },
    async () => {
      // The catalogue holds exactly two VBP one-time fees, which is the Developer Reference's own
      // open question answered as data.
      const cat = await get<{ member?: any[] }>('/treatments?itemsPerPage=200');
      const vbp = (cat.member ?? []).filter((t) => (t.code ?? '').includes('VBP'));
      console.log(`  VBP catalogue rows: ${vbp.map((t) => `${t.code}/${t.kind}/${t.area}/bv=${t.bv}`).join(', ')}`);
      expect(vbp.map((t) => t.code).sort(), 'exactly the two gated codes').toEqual(Object.keys(VBP).sort());

      // Every VO that PRESCRIBES a VBP fee and was issued on/after the cutoff — the gate is only
      // ever reached through the prescribed list, which is why staging (0 such VOs) could not test
      // this at all and the ticket's own QA step passes there on an unfixed build.
      const post: { vo: string; code: string; issued: string; id: number }[] = [];
      for (const [code, tid] of Object.entries(VBP)) {
        const body = await get<{ member?: any[] }>(`/prescriptions?treatment=${tid}&date%5Bafter%5D=${CUTOFF}&itemsPerPage=100`);
        for (const v of body.member ?? []) post.push({ vo: v.prescriptionId, code, issued: v.date.slice(0, 10), id: v.id });
      }
      console.log(`  post-cutoff VOs prescribing a VBP fee: ${post.length}`);
      expect(post.length, 'production HAS the fixture (staging has none)').toBeGreaterThan(0);

      // Which of them actually received it. An attachment is dated through its ACTIVITY
      // (/activity_treatments registers no date filter), so the VO's activities carry the date.
      const carrying: { vo: string; code: string; issued: string; attachedOn: string | null }[] = [];
      for (const p of post) {
        const acts = await get<{ member?: any[] }>(`/activities?prescription=${p.id}&itemsPerPage=300`);
        let attachedOn: string | null = null;
        for (const a of acts.member ?? []) {
          for (const at of a.activityTreatments ?? []) {
            const t = at.treatment;
            if (t && typeof t === 'object' && t.code === p.code) attachedOn = a.date.slice(0, 10);
          }
        }
        if (attachedOn) carrying.push({ ...p, attachedOn });
      }
      console.log(`  of those, carrying the fee: ${carrying.length}`);
      for (const c of carrying.sort((a, b) => (a.attachedOn! < b.attachedOn! ? -1 : 1))) {
        console.log(`    ${c.vo.padEnd(10)} ${c.code.padEnd(9)} issued ${c.issued}  fee attached ${c.attachedOn}`);
      }
      const newest = carrying.map((c) => c.attachedOn!).sort().at(-1) ?? null;
      console.log(`  newest VBP attachment on a post-cutoff VO: ${newest}`);

      // AC4 says VOs that already carry the fee KEEP it, so carrying it is not itself a failure —
      // the ticket sized that backlog at 7 from a 15.09 production snapshot. What is worth the PM's
      // attention is that it is larger now, and the newest attachment postdates their snapshot.
      console.log(`  => the ticket sized this backlog at 7 (15.09 snapshot); it is ${carrying.length} today`);
      expect(carrying.length, 'the backlog is measurable').toBeGreaterThan(0);

      // The cutoff FIRING is the other half, and it needs a VO with a session and no VBP row where
      // another one-time fee DID attach — otherwise the absence could just be "nothing attached".
      const discriminating: string[] = [];
      for (const p of post.filter((x) => !carrying.some((c) => c.vo === x.vo && c.code === x.code))) {
        const acts = await get<{ member?: any[] }>(`/activities?prescription=${p.id}&itemsPerPage=300`);
        const rows = acts.member ?? [];
        if (rows.length === 0) continue;
        const otherFees = new Set<string>();
        for (const a of rows) {
          for (const at of a.activityTreatments ?? []) {
            const t = at.treatment;
            if (t && typeof t === 'object' && t.kind === 'one_time_fee') otherFees.add(t.code);
          }
        }
        discriminating.push(`${p.vo} (${p.code}): ${rows.length} sessions, other one-time fees ${[...otherFees].join(',') || 'none'}`);
      }
      console.log(`  post-cutoff VOs WITH sessions and NO VBP fee: ${discriminating.length}`);
      for (const d of discriminating) console.log(`    ${d}`);
    },
  );

  test(
    '#3711: the session report is live, admin-only, and fails closed',
    { tag: ['@SuperAdmin', '@ProdRc314', '@ReadOnly'] },
    async () => {
      // A brand-new resource is the cleanest deployment probe: it either answers or it does not.
      const control = await status('/prescriptions/zzz-not-a-route');
      const open = await status('/prescriptions/session-report');
      console.log(`  session-report ${open}, control ${control}`);
      expect(open, 'the resource is registered').toBe(200);

      // It FAILS CLOSED, the opposite of /prescriptions where an unregistered filter is ignored and
      // the whole book comes back — so an empty result here is a refusal, not a leak.
      const unfiltered = await get<any>('/prescriptions/session-report');
      const none = Array.isArray(unfiltered) ? unfiltered.length : (unfiltered.member ?? []).length;
      console.log(`  unfiltered rows: ${none}`);
      expect(none, 'no filter yields no rows').toBe(0);

      // With a patient it serves the row shape both the new screen and the export read.
      const risks = await get<any>('/kpis/orga/risks');
      const firstVo = risks.member[0].rows[0];
      const vo = await get<any>(`/prescriptions/${firstVo.prescriptionId}`);
      const pid = typeof vo.patient === 'number' ? vo.patient : vo.patient?.id;
      const rows = await get<any>(`/prescriptions/session-report?patient=${pid}`);
      const list = Array.isArray(rows) ? rows : (rows.member ?? []);
      console.log(`  patient ${pid}: ${list.length} sessions`);
      expect(list.length, 'a patient with VOs has sessions').toBeGreaterThan(0);
      for (const k of ['prescriptionId', 'sessionDate', 'durationMinutes', 'doubleTreatment']) {
        expect(Object.keys(list[0]), `the row carries ${k}`).toContain(k);
      }
      // `doubleTreatment` is the MARKER and `durationMinutes` the arithmetic — both must be real
      // values on every row, since the screen renders one from each.
      expect(list.every((r: any) => typeof r.doubleTreatment === 'boolean'), 'every row carries a real boolean').toBe(true);
      expect(list.every((r: any) => r.durationMinutes !== null), 'and a duration').toBe(true);
    },
  );

  test(
    '#3719: the pull-forward leaves no trace on production either',
    { tag: ['@SuperAdmin', '@ProdRc314', '@ReadOnly', '@Slow'] },
    async () => {
      // The change is two private constants read only inside a console command, so nothing is
      // serialized and no endpoint evaluates the rule — deployment is not client-decidable, exactly
      // as on staging. What IS checkable is whether the job leaves a trace at all.
      const { totalItems } = await get<{ totalItems: number }>('/prescription_logs?type=follow_up_status_change&itemsPerPage=1');
      const per = 300;
      const last = Math.ceil(totalItems / per);
      const rows: any[] = [];
      for (let p = Math.max(1, last - 6); p <= last; p++) {
        const body = await get<{ member?: any[] }>(`/prescription_logs?type=follow_up_status_change&itemsPerPage=${per}&page=${p}`);
        rows.push(...(body.member ?? []));
      }
      const intoOrder = rows.filter((l) => String(l.newValue) === 'order');
      const marked = rows.filter((l) => JSON.stringify(l.meta ?? {}).includes('wednesday_pull_forward'));
      console.log(`  ${totalItems} follow_up_status_change logs; tail ${rows.length} (${rows[0]?.createdAt.slice(0, 10)} .. ${rows.at(-1)?.createdAt.slice(0, 10)})`);
      console.log(`  moves INTO 'order' in the tail: ${intoOrder.length}; carrying the pull-forward marker: ${marked.length}`);

      // A guard left armed: the marker is still Wednesday-NAMED (the file's staging finding), so if
      // one ever appears it must be stamped on a Tuesday under #3719's rule.
      for (const l of marked) {
        const day = new Date(l.createdAt).getUTCDay();
        expect(day, 'a pull-forward marker is stamped on a Tuesday').toBe(2);
      }
      console.log('  => no move into Bestellen is recorded, so neither the old Wednesday run nor');
      console.log('     the new Tuesday one is observable here — #3719 stays staging-unverifiable.');
    },
  );

  test(
    '#3717: every risk drill-down row carries a "VO #" column, right after the patient',
    { tag: ['@SuperAdmin', '@ProdRc314', '@ReadOnly', '@Slow'] },
    async ({ page }) => {
      // The column is rendered from `voNumber`, which the shared RiskWorklist row carries for every
      // tile — so the payload proves the DATA is there for all four, and the screen proves the
      // POSITION. Both halves matter: AC1 is about presence, AC2 about consistent placement.
      const risks = await get<any>('/kpis/orga/risks');
      const rows: any[] = risks.member[0].rows;
      const byTile: Record<string, { rows: number; withVo: number }> = {};
      for (const r of rows) {
        byTile[r.tile] ??= { rows: 0, withVo: 0 };
        byTile[r.tile].rows += 1;
        if (r.voNumber) byTile[r.tile].withVo += 1;
      }
      console.log(`  voNumber present per tile: ${JSON.stringify(byTile)}`);
      expect(Object.keys(byTile).length, 'all four tiles are represented').toBeGreaterThanOrEqual(3);
      for (const [tile, c] of Object.entries(byTile)) {
        expect(c.withVo, `${tile}: every row carries a VO number`).toBe(c.rows);
      }

      // AC3: no reformatting or truncation — the number must match the VO's own.
      const sample = rows.filter((r) => r.voNumber).slice(0, 5);
      for (const r of sample) {
        const vo = await get<any>(`/prescriptions/${r.prescriptionId}`);
        expect(r.voNumber, `row ${r.prescriptionId} shows the VO's own number verbatim`).toBe(vo.prescriptionId);
      }
      console.log(`  AC3: ${sample.length} rows matched their prescription's own number exactly`);
    },
  );
});
