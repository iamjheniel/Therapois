import { test, expect } from '../../fixtures/crm-serial';
import { request as pwRequest, type APIRequestContext } from '../../fixtures/session';
import { AbsenceIndicatorPage as A, type Indicator } from '../../../Pages/crm/crm.absence-indicator.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.15 — #3721 (PR #3782, merged into `release/3.15.0` 2026-09-23): a coloured dot on the CRM
 * practice detail's two VO lists says that nothing is happening because the therapist is away —
 * RED on Nachverfolgen when they are absent today (AC1/AC2), AMBER on Bestellen when an absence
 * falls inside the practice's ordering lead-time window (AC3/AC4).
 *
 * **Read-only** — every request a GET; the CRM is navigated and read, which is also AC5 (the
 * indicator is informational and nothing here or there writes).
 *
 * **Personal-data discipline, which the feature itself sets the standard for.** The new endpoint
 * returns two booleans and nothing else, precisely so that "Krankheit on Thursday" about a named
 * employee never reaches a CRM list. This file mirrors that: the independent oracle reads
 * `/absence-days` for DATES only, the absence type is never requested, and no assertion or log
 * line puts a date against a person — everything is a boolean or a count.
 *
 * Imports `test` from `tests/fixtures/crm-serial` (the CRM group's cross-file lock).
 */

/** A practice that holds BOTH lists for the same absent-today therapist — resolved live below. */
const PRACTICE_ID = 633;
const PRACTICE_SEARCH = 'Schühle';

let api: APIRequestContext;
let page: A;
let today = '';
let leadTimeDays = 0;
let therapistIds: number[] = [];
let flags = new Map<number, Indicator>();

test.describe('#3721 the CRM absence indicator', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    api = await pwRequest.newContext();
    page = new A(api);
    await page.init();
    today = A.iso(new Date());
    const practice = await page.practice(PRACTICE_ID);
    leadTimeDays = Number(practice.leadTimeDays ?? 21);
    therapistIds = await page.therapistIds();
    flags = await page.indicators(PRACTICE_ID, therapistIds);
    const t = [...flags.values()].filter((f) => f.absentToday).length;
    const w = [...flags.values()].filter((f) => f.absentInLeadTimeWindow).length;
    console.log(`  today ${today}; practice ${PRACTICE_ID} lead time ${leadTimeDays}d`);
    console.log(`  ${flags.size} therapists answered: ${t} absent today, ${w} in the lead-time window`);
  });

  test.afterAll(async () => { await api?.dispose(); });

  test(
    'DEPLOYED: the endpoint exists, fails closed, and returns TWO BOOLEANS and nothing else',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly'] },
    async () => {
      // A brand-new route is the cleanest probe there is — against a 404 control, so "200" means
      // the route rather than a catch-all.
      expect(await page.status('/zzz-not-a-route'), 'the control 404s').toBe(404);
      expect(await page.status(`${A.ROUTE}?practice=${PRACTICE_ID}&therapist%5B%5D=${therapistIds[0]}`),
        'the route answers').toBe(200);
      // Kebab-case, like `/absence-days` (#3394) — the snake_case form every other collection uses
      // 404s here and reads exactly like "not deployed".
      expect(await page.status('/therapist_absence_indicators'), 'the snake_case form does not exist').toBe(404);
      // ...and it FAILS CLOSED: with no parameters it refuses rather than answering about everyone.
      expect(await page.status(A.ROUTE), 'no parameters is a 400, not a full roster').toBe(400);

      // The privacy shape. An AbsenceDay carries the absence TYPE and the DATE; this DTO must carry
      // neither, or a CRM list rendering a coloured dot would be holding health-adjacent data.
      const raw = await page.rawIndicators(PRACTICE_ID, therapistIds.slice(0, 3));
      const keys = [...new Set(raw.flatMap((r) => Object.keys(r)))].filter((k) => !k.startsWith('@'));
      console.log(`  payload fields: ${JSON.stringify(keys)}`);
      expect(keys.sort(), 'exactly the three fields, no date and no absence type')
        .toEqual([...A.FIELDS].sort());
      for (const r of raw) {
        expect(typeof r.absentToday, 'absentToday is a boolean').toBe('boolean');
        expect(typeof r.absentInLeadTimeWindow, 'absentInLeadTimeWindow is a boolean').toBe('boolean');
      }
    },
  );

  test(
    'AC1/AC3: both flags re-derived independently from /absence-days',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly'] },
    async () => {
      // A sample spanning all three combinations, so the oracle is exercised on each branch rather
      // than on whichever happens to dominate.
      const byCombo = { today: [] as number[], windowOnly: [] as number[], neither: [] as number[] };
      for (const [id, f] of flags) {
        if (f.absentToday) byCombo.today.push(id);
        else if (f.absentInLeadTimeWindow) byCombo.windowOnly.push(id);
        else byCombo.neither.push(id);
      }
      console.log(`  combinations: absent today ${byCombo.today.length},` +
        ` in-window only ${byCombo.windowOnly.length}, neither ${byCombo.neither.length}`);
      expect(byCombo.today.length, 'AC1 has a fixture').toBeGreaterThan(0);
      // The in-window-only group is AC2's own discriminating case: a therapist who DOES have an
      // absence, just not today. A naive "has any absence" check turns red for every one of them.
      expect(byCombo.windowOnly.length, "AC2's discriminating case exists").toBeGreaterThan(0);
      expect(byCombo.neither.length, 'and a negative control').toBeGreaterThan(0);

      const sample = [...byCombo.today.slice(0, 4), ...byCombo.windowOnly.slice(0, 4), ...byCombo.neither.slice(0, 4)];
      let checked = 0;
      for (const id of sample) {
        const dates = await page.absenceDates(id);
        const derived = {
          absentToday: A.derivedToday(dates, today),
          absentInLeadTimeWindow: A.derivedWindow(dates, today, leadTimeDays),
        };
        const served = flags.get(id)!;
        console.log(`  therapist ${String(id).padStart(4)}: served (${served.absentToday}, ${served.absentInLeadTimeWindow})` +
          `  derived (${derived.absentToday}, ${derived.absentInLeadTimeWindow})  [${dates.length} absence days]`);
        expect(derived.absentToday, `therapist ${id}: absentToday`).toBe(served.absentToday);
        expect(derived.absentInLeadTimeWindow, `therapist ${id}: absentInLeadTimeWindow`).toBe(served.absentInLeadTimeWindow);
        checked++;
      }
      expect(checked, 'the sample was walked').toBeGreaterThan(8);
    },
  );

  test(
    "the window really is the practice's lead time, measured over every therapist",
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly', '@Slow'] },
    async () => {
      // The length is falsifiable from the data: a therapist whose nearest upcoming absence is
      // BEYOND the window must not be flagged. Without such a case the flag could mean "has any
      // future absence at all" and still pass.
      const buckets: Record<string, number> = {};
      const wrong: string[] = [];
      for (const id of therapistIds) {
        const dates = await page.absenceDates(id);
        const n = A.daysToNextAbsence(dates, today);
        const served = flags.get(id)?.absentInLeadTimeWindow ?? false;
        const bucket = n === null ? 'no upcoming absence' : n <= leadTimeDays ? `within ${leadTimeDays}d` : `beyond ${leadTimeDays}d`;
        const key = `${bucket} → ${served}`;
        buckets[key] = (buckets[key] ?? 0) + 1;
        const expectFlag = n !== null && n <= leadTimeDays;
        if (expectFlag !== served) wrong.push(`${id} (next in ${n}d, served ${served})`);
      }
      console.log(`  ${JSON.stringify(buckets, null, 0)}`);
      console.log(`  disagreements: ${wrong.length ? JSON.stringify(wrong) : 'none'}`);
      expect(wrong, 'every therapist agrees with the window rule').toHaveLength(0);
      // The boundary case must OCCUR, or the window length is untested.
      const beyond = Object.entries(buckets).find(([k]) => k.startsWith('beyond'));
      console.log(`  therapists with an absence just beyond the window: ${beyond?.[1] ?? 0}`);
      expect(beyond?.[1] ?? 0, 'the window length is exercised from the far side').toBeGreaterThan(0);

      // Structural: today is inside the window, so a red row is always also an amber-eligible one.
      const brokenImplication = [...flags.values()].filter((f) => f.absentToday && !f.absentInLeadTimeWindow);
      expect(brokenImplication, 'absentToday implies absentInLeadTimeWindow').toHaveLength(0);
    },
  );

  test(
    'the endpoint is ROLE_ADMIN: a therapist is refused and learns nothing',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@Security', '@ReadOnly'] },
    async () => {
      // It answers about OTHER PEOPLE by construction and has no self-service case, so the gate is
      // the whole of its access control. Asserted as status codes — never by reading the data.
      const q = `${A.ROUTE}?practice=${PRACTICE_ID}&therapist%5B%5D=${therapistIds[0]}`;
      const sa = await page.status(q);
      const admin = await page.status(q, await page.init(STAGING_CREDENTIALS.admin));
      const therapist = await page.status(q, await page.init(STAGING_CREDENTIALS.therapist));
      console.log(`  superadmin ${sa} | admin ${admin} | therapist ${therapist}`);
      expect(sa, 'a super admin may ask').toBe(200);
      expect(admin, 'an admin may ask').toBe(200);
      expect(therapist, 'a therapist may not').toBe(403);
    },
  );

  test(
    'AC1/AC2 on screen: red dots on Nachverfolgen, and none for a therapist who is not absent today',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly'] },
    async ({ page: browserPage }) => {
      const ui = new A(api, browserPage);
      await ui.init();                       // its own bearer: the shared instance's is not shared
      await ui.openPractice(PRACTICE_SEARCH);
      await ui.openTab('Nachverfolgung');

      const dots = await ui.dots('absence-today');
      const labels = await ui.absenceLabels();
      console.log(`  Nachverfolgung: ${dots.length} red dots; requests ${JSON.stringify(ui.requests)}`);
      console.log(`  aria-labels on the page: ${JSON.stringify(labels)}`);
      expect(dots.length, 'the tab paints red indicators').toBeGreaterThan(0);
      for (const d of dots) {
        expect(d.color, `${d.testId} is red`).toBe(A.RED);
        expect(d.aria, `${d.testId} says someone is away`).toBe(A.LABEL_TODAY);
      }
      // AC2's half: the amber tone does NOT appear on this list — a dot of the wrong tone would be
      // invisible to a count of red ones.
      expect(labels, 'only the today label is used here').toEqual([A.LABEL_TODAY]);
      expect(await ui.dots('absence-window'), 'no window dots on Nachverfolgen').toHaveLength(0);

      // The batching AC: ONE request for the whole page, keyed off its therapists — a practice's
      // list repeats the same handful of therapists across rows, so per-row would be an N+1 for an
      // identical answer.
      expect(ui.requests, 'one batched request per rendered page').toHaveLength(1);
      const ids = [...ui.requests[0].matchAll(/therapist\[\]=(\d+)/g)].map((m) => Number(m[1]));
      console.log(`  one request for ${ids.length} therapists across ${dots.length} dotted rows`);
      expect(ids.length, 'it asks about several therapists at once').toBeGreaterThan(0);
      expect(ids.length, 'and far fewer times than there are rows').toBeLessThanOrEqual(dots.length + 2);

      // AC2 proper: of the therapists on this page, exactly those the endpoint calls absent today
      // may carry a dot. A page with only absent therapists could not show that, so the mix is
      // asserted first.
      const served = await ui.indicators(PRACTICE_ID, ids);
      const absent = ids.filter((i) => served.get(i)?.absentToday);
      console.log(`  of ${ids.length} therapists on the page, ${absent.length} are absent today`);
      expect(absent.length, 'at least one is').toBeGreaterThan(0);
      if (ids.length > absent.length) {
        const notAbsent = ids.filter((i) => !served.get(i)?.absentToday);
        console.log(`  → the page also carries ${notAbsent.length} NOT-absent therapist(s)` +
          ` (${JSON.stringify(notAbsent)}), so the undotted rows ARE AC2's case`);
        // Each of them has an absence history of its own, which is what makes AC2 non-trivial:
        // a "has any absence" check would have dotted them too.
        let withHistory = 0;
        for (const i of notAbsent) if ((await ui.absenceDates(i)).length > 0) withHistory++;
        console.log(`  ...and ${withHistory} of them do have absences on other days`);
      }
    },
  );

  test(
    'AC3/AC4 on screen: amber dots on Bestellen, in the tone the row already uses',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly'] },
    async ({ page: browserPage }) => {
      const ui = new A(api, browserPage);
      await ui.init();                       // its own bearer: the shared instance's is not shared
      await ui.openPractice(PRACTICE_SEARCH);
      await ui.openTab('Bestellung');

      const dots = await ui.dots('absence-window');
      const labels = await ui.absenceLabels();
      console.log(`  Bestellung: ${dots.length} amber dots; requests ${JSON.stringify(ui.requests)}`);
      expect(dots.length, 'the tab paints amber indicators').toBeGreaterThan(0);
      for (const d of dots) {
        expect(d.color, `${d.testId} is amber`).toBe(A.AMBER);
        expect(d.aria, `${d.testId} names the lead-time window`).toBe(A.LABEL_WINDOW);
      }
      expect(labels, 'only the window label is used here').toEqual([A.LABEL_WINDOW]);
      expect(await ui.dots('absence-today'), 'no red dots on Bestellen').toHaveLength(0);
      expect(ui.requests, 'one batched request per rendered page').toHaveLength(1);

      // Every dotted row's VO is in Bestellen and its therapist is flagged for the window.
      const ids = [...ui.requests[0].matchAll(/therapist\[\]=(\d+)/g)].map((m) => Number(m[1]));
      const served = await ui.indicators(PRACTICE_ID, ids);
      const inWindow = ids.filter((i) => served.get(i)?.absentInLeadTimeWindow);
      console.log(`  of ${ids.length} therapists on the page, ${inWindow.length} have an absence in the window`);
      expect(inWindow.length, 'at least one does').toBeGreaterThan(0);
    },
  );

  test(
    'AC5 + coverage: the indicator changes nothing, and what staging cannot exercise',
    { tag: ['@Admin', '@CRMAbsenceIndicator', '@ReadOnly'] },
    async () => {
      // AC5 is "visual only". The endpoint is a GET and the rows it describes are read elsewhere,
      // so the checkable form is that a VO's ordering fields are what they were before the screen
      // was looked at — taken over the practice's own Bestellen list.
      const before = await page.get<any>(
        `/prescriptions?itemsPerPage=10&followupStatus=order&practice=${PRACTICE_ID}`);
      const snap = (b: any) => (b.member ?? []).map((v: any) =>
        `${v.prescriptionId}:${v.followupStatus}:${v.orderDate ?? '-'}:${v.treatmentStatus}`).sort();
      const a = snap(before);
      await page.indicators(PRACTICE_ID, therapistIds.slice(0, 20));
      const after = snap(await page.get<any>(
        `/prescriptions?itemsPerPage=10&followupStatus=order&practice=${PRACTICE_ID}`));
      console.log(`  ${a.length} VOs on the practice's Bestellen list, unchanged after asking: ${a.join(' ') === after.join(' ')}`);
      expect(after, 'no VO status or order date moved').toEqual(a);

      // What staging cannot exercise, measured rather than assumed.
      const portions = new Set<string>();
      for (const id of therapistIds.slice(0, 10)) for (const p of await page.dayPortions(id)) portions.add(p);
      console.log(`  dayPortion values present: ${JSON.stringify([...portions])}`);
      if (!portions.has('FIRST_HALF') && !portions.has('SECOND_HALF')) {
        console.log('  → AC1/AC3 say a HALF day counts. Every absence row on staging is FULL');
        console.log('    (the standing #3394/#3663 finding), so that clause is unexercised here.');
      }
      const leads = new Set<number>();
      const practices = await page.get<any>('/practices?itemsPerPage=200&page=1');
      for (const p of practices.member ?? []) leads.add(Number(p.leadTimeDays));
      console.log(`  practice lead times in a 200 sample: ${JSON.stringify([...leads])}`);
      if (leads.size === 1) {
        console.log(`  → every practice is ${[...leads][0]}d (#3302), so a provider that ignored the`);
        console.log('    practice\'s own value and hardcoded the standard would pass here. The PR\'s');
        console.log('    own boundary test uses a 10-day practice for exactly that reason.');
      }
      expect(portions.size, 'absence rows were read at all').toBeGreaterThan(0);
    },
  );
});
