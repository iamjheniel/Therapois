import { test, expect } from '@playwright/test';
import { L, PraxisPatientTextsPage } from '../../../Pages/praxis/praxis.patient-texts.page';

/**
 * RC 3.15 #3895 — Patient Texts and Cancel Page: Wording From the Operations Review.
 *
 * Deployed on both halves. The Praxis half (the cancel-page fee sentence and the Settings
 * preview) shipped as praxis `c0404551749`; the API half (the stop line and the freed-slot
 * offer's closing clause) shipped as monorepo `0e349765c87`.
 *
 * RUN AT `--workers=1`, AND NEVER TWO COPIES AT ONCE. The active practice is ONE per-user
 * preference, so a second run of this file switches it underneath the first — which fails AC4
 * with the preview naming a practice nobody selected, and looks exactly like the preview not
 * following the switcher. That happened here, from a background run overlapping a foreground one.
 *
 * READ-ONLY. Every API request is a GET; the Praxis app is signed into, navigated and read, and
 * the one control this file operates — the practice switcher — changes which practice the
 * SCREEN shows and writes nothing. Nothing sends a text, redeems a one-time link or saves a
 * setting; the reminder lead-time control sitting beside the preview is deliberately not touched.
 */

const SAMPLE = { date: 'Fr, 16.10.', time: '09:00', link: '[Link]', stopLink: '[Link]' };
const SAMPLE_EN = { date: 'Fri, 16.10.', time: '09:00', link: '[link]', stopLink: '[link]' };

test.describe('#3895 patient text wording from the operations review', () => {
  test.describe.configure({ mode: 'serial' });
  let px: PraxisPatientTextsPage;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    px = new PraxisPatientTextsPage(request);
  });

  test('deployment — the Praxis build serves the new wording and none of the old', async () => {
    test.setTimeout(180_000);

    // The control FIRST. Flow's bundle escapes non-ASCII (#3337/#3611) and a probe written for it
    // reports 0 for every German string, which reads exactly like "never shipped". Praxis's does
    // not — proven here on a string this ticket does not touch, so that every zero below means
    // something.
    const unchanged = await px.occurrences('Wir freuen uns auf Sie');
    expect(unchanged, 'a non-ASCII-free control string must be present').toBeGreaterThan(0);
    const umlaut = await px.occurrences('Terminerinnerung');
    expect(umlaut).toBeGreaterThan(0);
    expect(await px.occurrences('H\\xf6he'), 'the Praxis build must not \\xNN-escape').toBe(0);

    const table: [string, string, number][] = [];
    for (const loc of ['de', 'en'] as const) {
      table.push([`L2 stop line NEW ${loc}`, L.stopNew[loc], await px.occurrences(L.stopNew[loc])]);
      table.push([`L7 fee NEW ${loc}`, L.feeNew[loc], await px.occurrences(L.feeNew[loc])]);
      table.push([`L1 stop line OLD ${loc}`, L.stopOld[loc], await px.occurrences(L.stopOld[loc])]);
      table.push([`L6 fee OLD ${loc}`, L.feeOld[loc], await px.occurrences(L.feeOld[loc])]);
    }
    for (const [label, , n] of table) console.log(`[#3895] ${String(n).padStart(3)}  ${label}`);

    for (const [label, , n] of table.filter(([l]) => l.includes('NEW'))) {
      expect(n, `${label} must be in the served build`).toBeGreaterThan(0);
    }
    for (const [label, , n] of table.filter(([l]) => l.includes('OLD'))) {
      expect(n, `${label} must be gone`).toBe(0);
    }

    // L8: the preview used to name another practice outright. Its disappearance is what shows
    // (d) is a replacement rather than an addition.
    expect(await px.occurrences(L.previewOldPractice)).toBe(0);
  });

  test('AC1 row L7 — the cancel page names the amount, in both locales', async () => {
    const notes = await px.cancelNotes();
    for (const loc of ['de', 'en'] as const) {
      expect(notes[loc].noteB, `fee variant ${loc}`).toBe(L.feeNew[loc]);
      expect(notes[loc].noteB).not.toBe(L.feeOld[loc]);
    }
    console.log('[#3895] AC1/L7 de:', JSON.stringify(notes.de.noteB));
    console.log('[#3895] AC1/L7 en:', JSON.stringify(notes.en.noteB));
  });

  test('AC2 — the cancel page\'s other three lines did not move', async () => {
    const notes = await px.cancelNotes();
    for (const loc of ['de', 'en'] as const) {
      expect(notes[loc].noteA, `soft 24h note ${loc}`).toBe(L.noteSoft[loc]);
      expect(notes[loc].withinA, `inside-24h soft ${loc}`).toBe(L.withinDaySoft[loc]);
      expect(notes[loc].withinB, `inside-24h fee ${loc}`).toBe(L.withinDayFee[loc]);
    }
  });

  test('AC2 — the stop page is untouched, both steps', async () => {
    const stop = await px.stopPage();
    expect(stop.de.stopBody).toBe(L.stopPageBodyDe);
    expect(stop.de.unsubscribedBody).toBe(L.unsubscribedBodyDe);
    // The English pair is checked structurally, not against a literal the ticket never states.
    for (const v of [stop.en.stopBody, stop.en.unsubscribedBody]) {
      expect(v).toContain('{{practice}}');
      expect(v.length).toBeGreaterThan(40);
    }
    // The stop PAGE must not have picked up the stop LINE's new wording.
    expect(stop.de.stopBody).not.toContain(L.stopNew.de);
    expect(stop.en.stopBody).not.toContain(L.stopNew.en);
  });

  test('AC1 row L9 — the Settings preview string, both locales', async () => {
    const r = await px.reminderBlock();
    for (const loc of ['de', 'en'] as const) {
      expect(r[loc].sample, `preview ${loc}`).toBe(L.previewNew[loc]);
      expect(r[loc].sampleTitle, `preview title ${loc}`).toBe(L.previewTitle[loc]);
      // AC3's "on its own line" is a real newline in the stored value, not a sentence break.
      expect(r[loc].sample.split('\n')).toHaveLength(2);
      expect(r[loc].sample).toContain('{{practice}}');
    }
    // The Developer Reference asked for a sentence-initial fallback rather than reusing
    // `practice.confirm.unnamedPractice` ("der gewählten Praxis"), which is written for the middle
    // of a sentence. A separate key shipped, and the two are asserted to be DIFFERENT — one key
    // reused in both places is the failure this guards.
    expect(r.de.unnamedPractice).toBe('Ihre Praxis');
    expect(r.en.unnamedPractice).toBe('Your practice');
    expect(await px.occurrences('der gewählten Praxis')).toBeGreaterThan(0);
    expect(r.de.unnamedPractice).not.toBe('der gewählten Praxis');
  });

  test('AC3 — the preview is exactly what render() produces, which is the cross-repo invariant', async () => {
    const r = await px.reminderBlock();
    const de = PraxisPatientTextsPage.renderReminder('de', { practice: '{{practice}}', ...SAMPLE });
    const en = PraxisPatientTextsPage.renderReminder('en', { practice: '{{practice}}', ...SAMPLE_EN });

    expect(r.de.sample, 'the German preview must equal the ported render()').toBe(de);
    expect(r.en.sample, 'the English preview must equal the ported render()').toBe(en);

    // Anti-vacuity: the port must be able to disagree. Under the PRE-fix stop line it does.
    const stale = de.replace(L.stopNew.de, 'Keine SMS mehr:');
    expect(stale).not.toBe(r.de.sample);

    // The reminder text ABOVE the stop line is AC2's "stays exactly as it is" — row L8 and row L9
    // carry the identical body, so only the practice name and the date format moved.
    const bodyOf = (s: string) => s.split('\n')[0];
    expect(bodyOf(r.de.sample)).toContain('Erinnerung an Ihren Termin am');
    expect(bodyOf(r.de.sample)).toContain('Wir freuen uns auf Sie. Absagen:');
    // Row L9's own note: the sample date gains the comma the texts have always used.
    expect(bodyOf(r.de.sample)).toContain('Fr, 16.10.');
    expect(bodyOf(r.de.sample)).not.toContain('Do 16.10.');
  });

  test('FINDING — the API half has no client-reachable surface at all', async () => {
    test.setTimeout(180_000);
    const { fields, routes, newestId } = await px.apiBodySurfaces();

    // No serialization group exposes a body, because the entity has no body column: the rendered
    // text is handed to the provider and never persisted.
    for (const [group, keys] of Object.entries(fields)) {
      console.log(`[#3895] ${group.padEnd(18)} -> ${keys.join(', ')}`);
      for (const bodyish of ['textMessage', 'body', 'text', 'content', 'message']) {
        expect(keys, `${group} must not expose ${bodyish}`).not.toContain(bodyish);
      }
    }
    expect(fields.collection.length).toBeGreaterThan(0);

    // And no route renders one — against a 404 control, so the zeros mean "absent" and not
    // "something else refused me".
    console.log('[#3895] routes:', JSON.stringify(routes));
    expect(routes['/zzz-not-a-route']).toBe(404);
    for (const [p, s] of Object.entries(routes)) expect([404, 405], `${p}`).toContain(s);

    const log = await px.messageLog();
    const byTemplate: Record<string, number> = {};
    for (const m of log) byTemplate[`${m.template}/${m.status}`] = (byTemplate[`${m.template}/${m.status}`] ?? 0) + 1;
    console.log(`[#3895] message log: ${log.length} rows, newest id ${newestId}`, JSON.stringify(byTemplate));
    expect(log.length).toBeGreaterThan(0);

    console.log(
      '[#3895] FINDING: rows L2/L4/L5 (the stop line and the offer clause) cannot be read on ' +
        'staging — the text exists only in flight. The source on release/3.15.0 carries them ' +
        '(monorepo 0e349765c87) and the deployed preview above agrees with it, but reading what a ' +
        'patient received needs the allowlisted phone or the provider dashboard (#3637).',
    );
  });

  test('AC3 on screen — the preview names the ACTIVE practice and carries the stop line', async ({ page }) => {
    test.setTimeout(300_000);
    await px.openTreatmentSettings(page);

    const active = await px.activePractice(page);
    const preview = await px.preview(page);
    console.log('[#3895] active practice:', JSON.stringify(active));
    console.log('[#3895] preview:', JSON.stringify(preview));

    expect(active.length, 'the switcher must name a practice').toBeGreaterThan(0);
    expect(preview.startsWith(`${active}:`), 'the preview must open with the active practice').toBe(true);

    // The whole preview equals render() for that practice — the same invariant, now end to end.
    expect(preview).toBe(PraxisPatientTextsPage.renderReminder('de', { practice: active, ...SAMPLE }));

    // AC3's three parts: name, reminder with a sample date and a link placeholder, stop line on
    // its own line.
    const lines = preview.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Fr, 16.10.');
    expect(lines[0]).toContain('Absagen: [Link]');
    expect(lines[1]).toBe('Keine SMS mehr erhalten: [Link]');

    // The pre-fix render is asserted ABSENT, which is what makes this a before/after rather than
    // a plausible-looking string: it hardcoded another practice's name and had no stop line.
    expect(preview).not.toContain(L.previewOldPractice);
    expect(preview).not.toContain('Keine SMS mehr: ');

    // TRAP: the block title is CSS-uppercased, so innerText gives DAS ERHÄLT DER PATIENT while
    // textContent keeps the shipped string — and Playwright's text engine matches textContent.
    const title = page.getByText(L.previewTitle.de, { exact: true }).first();
    expect(await title.textContent()).toBe(L.previewTitle.de);
    expect((await title.innerText()).toUpperCase()).toBe((await title.innerText()));
  });

  test('AC4 on screen — switching practice moves the name in the preview', async ({ page }) => {
    test.setTimeout(300_000);
    await px.openTreatmentSettings(page);

    const before = await px.activePractice(page);
    const previewBefore = await px.preview(page);
    const options = await px.practiceOptions(page);
    console.log('[#3895] switcher offers', options.length, 'practices:', JSON.stringify(options.slice(0, 15)));
    expect(options.length, 'AC4 needs a second practice to switch to').toBeGreaterThan(1);

    const target = options.find((o) => o !== before);
    expect(target, 'a different practice must be reachable').toBeTruthy();

    let landedOn = '';
    let after = '';
    let previewAfter = '';
    try {
      ({ landedOn } = await px.switchPractice(page, target!));
      after = await px.activePractice(page);
      previewAfter = await px.preview(page);
    } finally {
      // The active practice is a per-user preference that survives the run, so it is put back —
      // which is what lets this file call itself read-only. Restoring is itself the same switch,
      // so a failure here is reported rather than thrown over the real result.
      try {
        if ((await px.activePractice(page)) !== before) await px.switchPractice(page, before);
        console.log('[#3895] restored the active practice to', JSON.stringify(await px.activePractice(page)));
      } catch (e) {
        console.log('[#3895] could not restore the active practice:', String(e).slice(0, 200));
      }
    }
    console.log(`[#3895] ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    console.log('[#3895] preview after:', JSON.stringify(previewAfter));

    expect(after).not.toBe(before);
    expect(previewAfter).not.toBe(previewBefore);
    expect(previewAfter.startsWith(`${after}:`), 'the preview must follow the switcher').toBe(true);
    expect(previewAfter).toBe(PraxisPatientTextsPage.renderReminder('de', { practice: after, ...SAMPLE }));

    // Both renders keep the stop line, so the switch moved the NAME and nothing else.
    expect(previewAfter.split('\n')[1]).toBe(previewBefore.split('\n')[1]);

    // Reported, not failed: AC4 is written as though the user stays put ("Given a user ... is on
    // the Treatments tab"), but choosing a practice sends the app to the Kalender, so the preview
    // is only seen to follow after navigating back. Pre-existing switcher behaviour rather than
    // anything #3895 introduced — a question for the PM about AC4's wording.
    console.log('[#3895] the switch landed on', JSON.stringify(landedOn));
    if (!landedOn.includes('/settings/treatments')) {
      console.log(
        '[#3895] FINDING: switching practice leaves Settings -> Treatments (lands on ' +
          `${landedOn}), so AC4's "Then the preview shows the newly active practice's name" is ` +
          'only observable after navigating back to the tab.',
      );
    }
  });
});
