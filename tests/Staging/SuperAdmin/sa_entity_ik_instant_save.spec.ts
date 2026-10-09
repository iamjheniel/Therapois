import { test, expect, type Page, type APIRequestContext } from '../../fixtures/session';
import { EntityIkSavePage as P } from '../../../Pages/superadmin/sa.entity-ik-save.page';

/**
 * RC 3.15 #3815 — Entitäten: an IK number saves when its check mark is confirmed.
 * PR #3840 (2026-09-28) + the AC6 follow-up PR #3945 (2026-10-03 23:39Z, `release/3.15.0`).
 *
 * MUTATING, and confined to ONE QA Gesellschaft: entity 14 "FT3815 AC7 Gesellschaft", which the
 * PM created for this ticket and no VO belongs to. Only its Logopädie row is touched (empty at the
 * start) plus, for AC6, its IBAN — both restored in `afterAll` through the API. The real Curano
 * Gesellschaften are never opened for writing: their IKs decide which VOs can be billed (#3822).
 *
 * AC7 is read-only: a "Neue Entität" is filled and then CANCELLED, so nothing is created — the
 * AC's point is precisely that nothing is sent before "Save".
 *
 * One page and one session for the whole file: `mintUiSession` spends a single-use refresh token
 * (#3460) and `POST /auth` is throttled at 5/min per username (#3462), so "reopen" is done the
 * way an admin does it — "Cancel" back to the list and the pencil again, never a reload.
 */
const ENTITY_ID = 14;
const ENTITY = 'FT3815 AC7 Gesellschaft';
const FIELD = 'ikSpeechtherapy' as const;
const THERAPY = 'Logopädie';
const N1 = '999999961';
const N2 = '999999962';
const N3 = '999999963';
const IBAN_TYPED = 'DE89 3704 0044 0532 0130 99';

test.describe('#3815 Entitäten — an IK number saves on its check mark', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let api: APIRequestContext;
  let page: Page;
  let ui: P;
  let original: any;

  test.beforeAll(async ({ browser, playwright }) => {
    test.setTimeout(300_000);
    api = await playwright.request.newContext();
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    ui = new P(api, page);
    await ui.init();
    original = await ui.entity(ENTITY_ID);
    expect(original.name, 'the fixture is the QA Gesellschaft').toBe(ENTITY);
    // A run that died mid-way leaves one of OUR numbers behind; repair that, refuse anything else.
    if ([N1, N2, N3].includes(original[FIELD])) {
      await ui.patch(ENTITY_ID, { [FIELD]: null });
      original = await ui.entity(ENTITY_ID);
    }
    expect(original[FIELD] ?? null, `the ${THERAPY} row starts empty`).toBeNull();
    console.log(`  fixture: entity ${ENTITY_ID} "${ENTITY}" iban="${original.iban}" ${FIELD}=null`);
    await ui.open();
  });

  test.afterAll(async () => {
    try {
      const now = await ui.entity(ENTITY_ID);
      const restore: Record<string, unknown> = {};
      if ((now[FIELD] ?? null) !== null) restore[FIELD] = null;
      if (now.iban !== original.iban) restore.iban = original.iban;
      if (Object.keys(restore).length) await ui.patch(ENTITY_ID, restore);
      const after = await ui.entity(ENTITY_ID);
      console.log(`  restored: ${JSON.stringify(restore)} → ${FIELD}=${after[FIELD] ?? null} iban="${after.iban}"`);
    } finally {
      await page?.close();
      await api?.dispose();
    }
  });

  test('deployment: the new strings and the save spinner ship (#3840 + #3945)', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@ReadOnly'],
  }, async () => {
    // Frontend-only change — `/status` answers for the API only (#3705). The bundle escapes
    // non-ASCII, so these are the ASCII-safe literals. `ik-saving-` is #3945's spinner, which
    // is what separates "the AC6 follow-up is live" from "only #3840 is".
    const html = await (await api.get('https://staging.therapios.de/')).text();
    const entry = /\/_expo\/static\/js\/web\/entry-[^"]+\.js/.exec(html)![0];
    const js = await (await api.get(`https://staging.therapios.de${entry}`, { timeout: 120_000 })).text();
    for (const s of [P.SAVED, P.REMOVE_TITLE, 'IK-Nummer konnte nicht gespeichert werden: {{reason}}',
      '`ik-confirm-', '`ik-saving-']) {
      expect(js.includes(s), `the bundle carries ${s}`).toBe(true);
    }
  });

  test('AC1 + AC6 bullet 2: + on the empty row, check mark → saved at once, and it survives Cancel', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    await ui.openEntity(ENTITY);
    expect(await ui.rowValue(THERAPY), 'the row starts empty').toBe('—');
    await ui.tid('add', FIELD).click();
    await (await ui.ikInput(FIELD)).fill(N1);
    const mark = ui.writes.length;
    await ui.tid('confirm', FIELD).click();
    await expect(page.getByText(P.SAVED, { exact: true }).first(), 'the "IK-Nummer gespeichert." message').toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe(N1);
    const w = ui.since(mark);
    console.log(`  writes: ${JSON.stringify(w)}`);
    expect(w, 'exactly one save request').toHaveLength(1);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].url).toBe(`/entities/${ENTITY_ID}`);
    expect(w[0].body, 'only this one IK is sent').toEqual({ [FIELD]: N1 });
    expect((await ui.entity(ENTITY_ID))[FIELD], 'the API holds it').toBe(N1);

    // AC6 bullet 2 — "Cancel" after the check mark does not undo it.
    const m2 = ui.writes.length;
    await ui.cancelForm();
    expect(ui.since(m2), '"Cancel" sends nothing').toEqual([]);
    await ui.openEntity(ENTITY);
    expect(await ui.rowValue(THERAPY), 'reopened: the number is still there').toBe(N1);
  });

  test('AC2: pencil, change, check mark → the new number is saved at once', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    await ui.tid('edit', FIELD).click();
    const box = await ui.ikInput(FIELD);
    expect(await box.inputValue(), 'edit mode opens on the saved number').toBe(N1);
    await box.fill(N2);
    const mark = ui.writes.length;
    await ui.tid('confirm', FIELD).click();
    await expect(page.getByText(P.SAVED, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe(N2);
    expect(ui.since(mark).map((w) => w.body)).toEqual([{ [FIELD]: N2 }]);
    expect((await ui.entity(ENTITY_ID))[FIELD]).toBe(N2);
  });

  test('AC3 + AC4 cancel: the delete icon asks first, naming type, number and Gesellschaft; Abbrechen keeps it', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    const mark = ui.writes.length;
    await ui.tid('delete', FIELD).click();
    await expect(page.getByText(P.REMOVE_TITLE, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    const msg = P.removeMessage(THERAPY, N2, ENTITY);
    await expect(page.getByText(msg, { exact: true }).first(), 'the Localization Reference text, filled in').toBeVisible();
    await expect(page.getByText('Entfernen', { exact: true }).first()).toBeVisible();
    expect(ui.since(mark), 'nothing is sent while the confirmation is open').toEqual([]);
    await page.getByText('Abbrechen', { exact: true }).last().click();
    await expect(page.getByText(P.REMOVE_TITLE, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(ui.since(mark), 'Abbrechen sends nothing').toEqual([]);
    expect(await ui.rowValue(THERAPY), 'the number stays').toBe(N2);
    expect((await ui.entity(ENTITY_ID))[FIELD]).toBe(N2);
  });

  test('AC4 confirm: Entfernen removes and saves at once, sending null for this one IK', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    const mark = ui.writes.length;
    await ui.tid('delete', FIELD).click();
    await page.getByText('Entfernen', { exact: true }).last().click();
    await expect(page.getByText(P.SAVED, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe('—');
    expect(ui.since(mark).map((w) => w.body)).toEqual([{ [FIELD]: null }]);
    expect((await ui.entity(ENTITY_ID))[FIELD] ?? null).toBeNull();
  });

  test('AC5: a refused save shows the reason and stays in edit mode; a 5xx names its status; retry works; a failed delete keeps the IK', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    test.setTimeout(300_000);
    // The failure is SIMULATED with page.route, so nothing reaches the server: a 422 the way API
    // Platform words a violation, then a body-less 502 (retried ~31 s by the client) — #3945's
    // fix is that the latter names "HTTP 502" instead of "Unknown error".
    const route = `**/entities/${ENTITY_ID}`;
    await page.route(route, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 422, contentType: 'application/problem+json',
        body: JSON.stringify({ violations: [{ propertyPath: FIELD, message: 'QA simulated refusal' }] }) })
      : r.fallback());
    await ui.tid('add', FIELD).click();
    await (await ui.ikInput(FIELD)).fill(N3);
    await ui.tid('confirm', FIELD).click();
    await expect(page.getByText(`${P.FAILED_PREFIX}QA simulated refusal`, { exact: true }).first(),
      'the failure message carries the server\'s reason').toBeVisible({ timeout: 60_000 });
    expect(await (await ui.ikInput(FIELD)).inputValue(), 'the row stays in edit mode with the typed number').toBe(N3);
    await page.unroute(route);

    await page.route(route, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 502, body: '' }) : r.fallback());
    const t0 = Date.now();
    await ui.tid('confirm', FIELD).click();
    await expect(ui.tid('saving', FIELD), 'the check mark shows a spinner while it retries (#3945)').toBeVisible({ timeout: 10_000 });
    // The 422 message from above can still be painted — match only a NEW failure message.
    const failed = page.getByText(new RegExp(`^${P.FAILED_PREFIX}(?!QA simulated refusal)`)).first();
    await expect(failed).toBeVisible({ timeout: 90_000 });
    const text = (await failed.textContent())!.trim();
    console.log(`  5xx message after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(text)}`);
    expect(text, 'a body-less 5xx names its status, not "Unknown error"').toContain('502');
    expect(text).not.toContain('Unknown error');
    expect(await (await ui.ikInput(FIELD)).inputValue()).toBe(N3);
    expect((await ui.entity(ENTITY_ID))[FIELD] ?? null, 'nothing was saved').toBeNull();
    await page.unroute(route);

    // Connection back → the same check mark saves.
    await ui.tid('confirm', FIELD).click();
    await expect(page.getByText(P.SAVED, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    expect((await ui.entity(ENTITY_ID))[FIELD], 'try again works').toBe(N3);

    // A failed delete leaves the IK in its row with the same message.
    await page.route(route, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 422, contentType: 'application/problem+json',
        body: JSON.stringify({ violations: [{ propertyPath: FIELD, message: 'QA simulated refusal' }] }) })
      : r.fallback());
    await ui.tid('delete', FIELD).click();
    await page.getByText('Entfernen', { exact: true }).last().click();
    await expect(page.getByText(`${P.FAILED_PREFIX}QA simulated refusal`, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await page.unroute(route);
    // Close the confirmation if the failure left it open, then read the row.
    if (await page.getByText(P.REMOVE_TITLE, { exact: true }).count()) {
      await page.getByText('Abbrechen', { exact: true }).last().click();
    }
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe(N3);
    expect((await ui.entity(ENTITY_ID))[FIELD], 'the IK is still saved').toBe(N3);
  });

  test('AC6 bullet 1: an unsaved IBAN survives an IK save, is NOT sent with it, and "Save" saves it', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@Mutating'],
  }, async () => {
    // The PM's 3 Oct FAIL: the single-IK save refreshed the entity query, the form re-seeded every
    // field from the server and the typed IBAN snapped back — so "Save" then sent the OLD one.
    const iban = await ui.input('IBAN *');
    await iban.fill(IBAN_TYPED);
    await ui.tid('edit', FIELD).click();
    await (await ui.ikInput(FIELD)).fill(N1);
    const mark = ui.writes.length;
    await ui.tid('confirm', FIELD).click();
    await expect(page.getByText(P.SAVED, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3_000); // the PM saw the reset within 400 ms of the PATCH; give it room to happen
    expect(ui.since(mark).map((w) => w.body), 'the IK save carries the IK alone').toEqual([{ [FIELD]: N1 }]);
    expect(await (await ui.input('IBAN *')).inputValue(), 'the typed IBAN is still in the field').toBe(IBAN_TYPED);
    expect((await ui.entity(ENTITY_ID)).iban, 'and it has not been saved yet').toBe(original.iban);

    const m2 = ui.writes.length;
    await page.getByText('Save', { exact: true }).last().click();
    await page.getByText('Entitätsverwaltung').first().waitFor({ timeout: 60_000 });
    const save = ui.since(m2);
    console.log(`  "Save" sent iban=${JSON.stringify(save[0]?.body?.iban)} ${FIELD}=${JSON.stringify(save[0]?.body?.[FIELD])}`);
    expect(save.length, '"Save" sends one request').toBe(1);
    expect(save[0].body.iban, '"Save" sends the TYPED IBAN, not the reset one').toBe(IBAN_TYPED);
    expect(save[0].body[FIELD], 'and the already-saved IK unchanged').toBe(N1);
    expect((await ui.entity(ENTITY_ID)).iban).toBe(IBAN_TYPED);
    // Restore the IBAN now rather than leave it to afterAll.
    await ui.patch(ENTITY_ID, { iban: original.iban });
  });

  test('AC6 bullet 3: the input rules are checked before saving, with today\'s messages and no request', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@ReadOnly'],
  }, async () => {
    await ui.openEntity(ENTITY);
    const mark = ui.writes.length;
    await ui.tid('edit', FIELD).click();
    for (const [value, message] of [
      ['99999A995', 'Only numbers are allowed'],
      ['1'.repeat(21), 'IK number must be at most 20 characters'],
    ] as const) {
      await (await ui.ikInput(FIELD)).fill(value);
      await ui.tid('confirm', FIELD).click();
      await expect(page.getByText(message, { exact: true }).first(), `"${value}" → ${message}`).toBeVisible({ timeout: 15_000 });
    }
    await page.waitForTimeout(1_500);
    expect(ui.since(mark), 'neither invalid value is sent').toEqual([]);
    expect((await ui.entity(ENTITY_ID))[FIELD], 'the saved number is untouched').toBe(N1);
    await ui.cancelForm();
  });

  test('AC7: on "Neue Entität" the check mark and delete only change the row — no request, no confirmation', {
    tag: ['@SuperAdmin', '@EntityIkSave', '@ReadOnly'],
  }, async () => {
    const mark = ui.writes.length;
    await page.getByText('Neue Entität').first().click();
    await page.getByText('IK-Nummern').first().waitFor({ timeout: 60_000 });
    await ui.tid('add', FIELD).click();
    await (await ui.ikInput(FIELD)).fill(N3);
    await ui.tid('confirm', FIELD).click();
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe(N3);
    await page.waitForTimeout(2_000);
    await expect(page.getByText(P.SAVED, { exact: true }), 'no "saved" message').toHaveCount(0);
    await ui.tid('delete', FIELD).click();
    await page.waitForTimeout(1_000);
    await expect(page.getByText(P.REMOVE_TITLE, { exact: true }), 'no confirmation').toHaveCount(0);
    await expect.poll(() => ui.rowValue(THERAPY), { timeout: 15_000 }).toBe('—');
    expect(ui.since(mark), 'nothing is sent before "Save"').toEqual([]);
    // Leave without saving — nothing is created.
    await ui.cancelForm();
    expect(ui.since(mark)).toEqual([]);
  });
});
