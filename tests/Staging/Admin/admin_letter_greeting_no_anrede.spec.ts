import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { LetterGreetingPage as L } from '../../../Pages/admin/admin.letter-greeting.page';

/**
 * RC 3.15 — #3848 (PR #3866, merged into `release/3.15.0` 2026-09-29): a patient whose Anrede is
 * not Herr/Herrn/Frau must be greeted by FIRST AND LAST name, and the Vorabinformation must name
 * them the same way in its "Behandlung für …" line. Patients with Herr or Frau are unchanged, and
 * so are letters addressed to a guardian.
 *
 * **A rendering ticket has one authoritative surface and it is not the archive** (#3668): a notice
 * is archived at generation and never re-rendered, so the archive can DATE the change but never
 * confirm it. Every AC assertion here runs on a letter this file generated, or on one rendered on
 * demand. `/status` cannot settle it either — it reports the release, not the commit (#3704).
 *
 * **AC1 is driven as a CONTROLLED EXPERIMENT on one patient**, cycling its Anrede through all four
 * rows, because four patients with four different names would confound the rule with the names.
 * The patient is a QA record and the write is self-restoring in a `finally`.
 */

const QA = L.FIXTURES.regular;          // patient 8474 Quincy TrugelloTest, physiotherapy
const QA_BLANKO = L.FIXTURES.blankoPhysio; // patient 8472 Xena MacaseroTest, blanko

/** Reminder-eligible invoices, resolved live in `beforeAll` rather than pinned. */
let REMINDER_NO_SALUTATION: { id: number; number: string; patientId: number } | null = null;
let REMINDER_KNOWN: { id: number; number: string; patientId: number }[] = [];
let REMINDER_GUARDIAN: { id: number; number: string; patientId: number } | null = null;
let PATIENTS = new Map<number, any>();

test.describe('#3848 letters greet by full name when no Anrede is set', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1_800_000);

  let ctx: APIRequestContext;
  let page: L;
  let token = '';

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    ctx = await pwRequest.newContext();
    page = new L(ctx);
    token = await page.adminToken();

    // Partition the reminder population by WHO the letter greets, which is not the same question
    // as what the patient's Anrede is (see `billingPerson`).
    const invoices = await page.overduePkvInvoices(token);
    PATIENTS = await page.patientsById([...new Set(invoices.map((i) => i.patientId))], token);
    for (const inv of invoices) {
      const p = PATIENTS.get(inv.patientId);
      if (!p) continue;
      if (L.billingPerson(p)) { REMINDER_GUARDIAN ??= inv; continue; }
      if (!p.salutation) REMINDER_NO_SALUTATION ??= inv;
      else if (REMINDER_KNOWN.length < 2) REMINDER_KNOWN.push(inv);
    }
    console.log(`  overdue PKV invoices: ${invoices.length} over ${PATIENTS.size} patients`);
  });

  test.afterAll(async () => { await ctx?.dispose(); });

  test(
    'DEPLOYED / AC1: all four Anrede rows on a freshly generated Vorabinformation',
    { tag: ['@Admin', '@LetterGreeting', '@Mutating'] },
    async () => {
      const p = await page.patient(QA.patientId, token);
      const { firstName: first, lastName: last } = p;
      console.log(`  patient ${QA.patientId}: ${first} ${last} (stored Anrede ${JSON.stringify(p.salutation ?? null)})`);
      expect(L.billingPerson(p), 'the fixture is addressed as the PATIENT, not a guardian').toBeNull();

      let discriminating = 0;
      for (const sal of L.AC1_ROWS) {
        const letter = await page.withSalutation(QA.patientId, sal, token,
          () => page.generateNotice(QA, token));
        const greeting = L.greetingIn(letter.text);
        const reference = L.referenceIn(letter.text);
        const wantG = L.expectedGreeting(sal, first, last);
        const wantR = L.expectedReference(sal, first, last);
        console.log(`  Anrede ${JSON.stringify(sal).padEnd(8)} -> ${JSON.stringify(greeting)} | "Behandlung für ${reference}"`);
        expect(greeting, `the greeting for Anrede ${JSON.stringify(sal)}`).toBe(wantG);
        expect(reference, `the "Behandlung für" line for Anrede ${JSON.stringify(sal)}`).toBe(wantR);

        // The half that shows the CHANGE rather than merely a plausible letter: on the two rows
        // where the rule moved, what the pre-fix build printed must be absent.
        if (L.discriminates(sal, first, last)) {
          discriminating++;
          const legacy = L.legacyGreeting(sal, last);
          console.log(`     pre-fix would have printed ${JSON.stringify(legacy)} — absent: ${!letter.text.includes(legacy)}`);
          expect(letter.text, `the pre-fix greeting is gone for Anrede ${JSON.stringify(sal)}`)
            .not.toContain(legacy);
          expect(letter.text, 'and the body no longer names the patient by last name alone')
            .not.toContain(`Behandlung für ${last} übernehmen`);
        }
      }
      // Without this the four rows could all be non-discriminating and the test would prove nothing.
      expect(discriminating, 'at least the two no-Anrede rows actually separate the two rules')
        .toBeGreaterThanOrEqual(2);
    },
  );

  test(
    'AC2: the Blanko Vorabinformation follows the same rule, in both lines',
    { tag: ['@Admin', '@LetterGreeting', '@Mutating'] },
    async () => {
      const p = await page.patient(QA_BLANKO.patientId, token);
      const { firstName: first, lastName: last } = p;
      console.log(`  patient ${QA_BLANKO.patientId}: ${first} ${last} (${QA_BLANKO.variant}/${QA_BLANKO.discipline})`);
      // The discriminating pair is enough here: the full table is already driven above on the same
      // resolver, and each render archives a notice.
      for (const sal of ['Frau', null] as (string | null)[]) {
        const letter = await page.withSalutation(QA_BLANKO.patientId, sal, token,
          () => page.generateNotice(QA_BLANKO, token));
        console.log(`  Anrede ${JSON.stringify(sal).padEnd(6)} -> ${JSON.stringify(L.greetingIn(letter.text))}` +
          ` | "Behandlung für ${L.referenceIn(letter.text)}"  (${letter.pages}p)`);
        expect(L.greetingIn(letter.text)).toBe(L.expectedGreeting(sal, first, last));
        expect(L.referenceIn(letter.text)).toBe(L.expectedReference(sal, first, last));
        if (L.discriminates(sal, first, last)) {
          expect(letter.text, 'the Blanko letter dropped the last-name-only greeting too')
            .not.toContain(L.legacyGreeting(sal, last));
        }
        // #3522's one-page rule still holds — the longer name must not have cost a page.
        expect(letter.pages, 'the longer greeting did not push the letter to a second page').toBe(1);
      }
    },
  );

  test(
    'AC2: the Zahlungserinnerung follows it too — rendered live, so nothing is written',
    { tag: ['@Admin', '@LetterGreeting', '@ReadOnly'] },
    async () => {
      // A reminder is rendered on demand and never stored (#3559), so this needs no fixture
      // preparation and no write at all: the population already contains both cases.
      test.skip(!REMINDER_NO_SALUTATION, 'no overdue PKV invoice has a patient without an Anrede');
      const cases = [REMINDER_NO_SALUTATION!, ...REMINDER_KNOWN];
      let discriminating = 0;
      for (const inv of cases) {
        const p = PATIENTS.get(inv.patientId)!;
        const { text } = await page.reminderLetter(inv.id, token);
        const greeting = L.greetingIn(text);
        const want = L.expectedGreeting(p.salutation, p.firstName, p.lastName);
        console.log(`  invoice ${inv.number.padEnd(9)} patient ${inv.patientId} Anrede ${JSON.stringify(p.salutation ?? null).padEnd(8)}` +
          ` -> ${JSON.stringify(greeting)}`);
        expect(greeting, `the reminder for ${inv.number}`).toBe(want);
        if (L.discriminates(p.salutation, p.firstName, p.lastName)) {
          discriminating++;
          expect(text, 'and not the pre-fix last-name-only greeting')
            .not.toContain(L.legacyGreeting(p.salutation, p.lastName));
        }
      }
      expect(discriminating, 'one of the reminders is a no-Anrede patient, or this proves nothing')
        .toBeGreaterThan(0);
      expect(REMINDER_KNOWN.length, 'with Herr/Frau controls beside it').toBeGreaterThan(0);
    },
  );

  test(
    'AC3: a letter addressed to a guardian keeps its own greeting',
    { tag: ['@Admin', '@LetterGreeting', '@ReadOnly'] },
    async () => {
      test.skip(!REMINDER_GUARDIAN, 'no reminder-eligible invoice is addressed to a guardian');
      const inv = REMINDER_GUARDIAN!;
      const p = PATIENTS.get(inv.patientId)!;
      const g = L.billingPerson(p)!;
      const { text } = await page.reminderLetter(inv.id, token);
      const greeting = L.greetingIn(text);
      console.log(`  invoice ${inv.number}: patient ${p.firstName} ${p.lastName} (Anrede ${JSON.stringify(p.salutation)})`);
      console.log(`    billing contact: ${g.type} ${JSON.stringify(g.salutation)} ${JSON.stringify(g.personName)}`);
      console.log(`    greeting: ${JSON.stringify(greeting)}`);

      const contactLast = String(g.personName ?? '').trim().split(/\s+/).pop() ?? '';
      const want = g.salutation
        ? `${L.greetingPhrase(g.salutation)} ${g.salutation} ${contactLast},`
        : `Sehr geehrte/r ${String(g.personName).trim()},`;
      expect(greeting, 'the guardian is greeted by the guardian rule').toBe(want);

      // The point of AC3 is that the PATIENT rule did not leak into this path.
      if (p.salutation !== g.salutation) {
        expect(greeting, "and the patient's own Anrede does not appear")
          .not.toBe(L.expectedGreeting(p.salutation, p.firstName, p.lastName));
      }

      // The other half of AC3 — a guardian with NO Anrede keeps the full name — has no fixture, and
      // that is a measurement rather than an assumption.
      const guardians = [...PATIENTS.values()].map(L.billingPerson).filter(Boolean) as any[];
      const withoutAnrede = guardians.filter((a) => !a.salutation);
      console.log(`  guardian billing contacts in this population: ${guardians.length}, without an Anrede: ${withoutAnrede.length}`);
      expect(guardians.length, 'the guardian path is exercised at all').toBeGreaterThan(0);
    },
  );

  test(
    'Out of Scope: letters already generated are not rewritten, which also dates the change',
    { tag: ['@Admin', '@LetterGreeting', '@ReadOnly'] },
    async () => {
      const rows = await page.notices.recentNotices(token, 90);
      const ids = [...new Set(rows.map((r) => Number(r.patient?.split('/').pop())).filter(Boolean))];
      const pats = await page.patientsById(ids, token);
      // Only a no-Anrede patient's letter can show the difference at all.
      const candidates = rows.filter((r) => {
        const p = pats.get(Number(r.patient?.split('/').pop()));
        return p && !p.salutation && !L.billingPerson(p);
      });
      console.log(`  archive ${rows.length} notices (${rows[rows.length - 1]?.createdAt} … ${rows[0]?.createdAt});` +
        ` ${candidates.length} belong to a patient with no Anrede`);
      test.skip(candidates.length === 0, 'no archived notice belongs to a no-Anrede patient');

      let old = 0; let fresh = 0; let newestOld = '';
      for (const r of candidates.slice(0, 8)) {
        const p = pats.get(Number(r.patient?.split('/').pop()))!;
        const read = await page.notices.readNotice(r, token);
        const greeting = L.greetingIn(read.text);
        const isOld = greeting === L.legacyGreeting(null, p.lastName);
        const isNew = greeting === L.expectedGreeting(null, p.firstName, p.lastName);
        console.log(`  notice ${read.noticeId} ${read.createdAt} ${p.firstName} ${p.lastName}: ${JSON.stringify(greeting)}` +
          ` ${isOld ? '[pre-fix]' : isNew ? '[post-fix]' : '[?]'}`);
        if (isOld) { old++; if (!newestOld || (read.createdAt ?? '') > newestOld) newestOld = read.createdAt ?? ''; }
        if (isNew) fresh++;
        expect(isOld || isNew, 'every archived letter is one of the two known forms').toBe(true);
      }
      // These letters were generated before the deploy and must be exactly as they were — the
      // ticket's Out of Scope. A rewrite would show up as a post-fix greeting on an old notice.
      expect(old, 'archived pre-fix letters are still on file, unmodified').toBeGreaterThan(0);
      console.log(`  pre-fix ${old}, post-fix ${fresh}; newest pre-fix letter ${newestOld}`);
      console.log('  NOTE: the newest pre-fix letter post-dates the PR merge (2026-09-29T23:45Z),');
      console.log('        so the deploy — not the merge — is the cutover (#3512).');
    },
  );

  test(
    'the population, and the trap that a letter may not greet the patient at all',
    { tag: ['@Admin', '@LetterGreeting', '@ReadOnly'] },
    async () => {
      // Pages spread across the id space rather than a walk: /patients embeds addresses and a
      // 150-row page already costs ~25 s, so a full 8,900-row walk is not affordable here (#3373).
      const pages = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
      const counts: Record<string, number> = {};
      const guardian: Record<string, number> = {};
      let seen = 0;
      for (const pg of pages) {
        const res = await ctx.get(
          `https://api.staging.therapios.de/patients?page=${pg}&itemsPerPage=150`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' }, timeout: 600_000 });
        if (!res.ok()) continue;
        for (const p of (await res.json()).member ?? []) {
          seen++;
          const k = p.salutation || '(none)';
          counts[k] = (counts[k] ?? 0) + 1;
          const g = L.billingPerson(p);
          if (g) { const gk = g.salutation || '(none)'; guardian[gk] = (guardian[gk] ?? 0) + 1; }
        }
      }
      console.log(`  sampled ${seen} patients: ${JSON.stringify(counts)}`);
      console.log(`  their guardian billing contacts: ${JSON.stringify(guardian)}`);
      const none = counts['(none)'] ?? 0;
      expect(seen, 'the sample is large enough to mean something').toBeGreaterThan(1_000);
      expect(none, 'the ticket\'s population exists on staging').toBeGreaterThan(0);
      console.log(`  → ~${Math.round((none / seen) * 8927)} of 8,927 patients have no Anrede` +
        ` (${((none / seen) * 100).toFixed(1)}%); the ticket cites 1,448 on production.`);
      // Every salutation stored on staging is one the resolver knows, or empty — so the "any other
      // text" row of AC1 (production's single "null") is exercised only by the write above.
      const unknown = Object.keys(counts).filter(
        (k) => k !== '(none)' && !(L.KNOWN as readonly string[]).includes(k));
      console.log(`  stored values outside Herr/Herrn/Frau: ${JSON.stringify(unknown)}`);
    },
  );
});
