import { test, expect } from '@playwright/test';
import {
  DocRow,
  FeeAgreementUploadPage,
  HV_STATUSES,
  TICKET_PATIENTS,
} from '../../../Pages/superadmin/sa.fee-agreement-upload.page';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.14 #3790 — an uploaded signed Honorarvereinbarung must count as the patient's signed fee
 * agreement everywhere Flow checks for one. Commit `0d5bc0d27`.
 *
 * Run at `--workers=1`: `/kpis/admin-performance/risks` and the Document Center walks are among the
 * slowest reads on staging.
 */
test.describe('#3790 an uploaded signed fee agreement is the patient signed Hono', () => {
  test.describe.configure({ mode: 'serial' });
  test.slow();

  let api: FeeAgreementUploadPage;

  test.beforeAll(async ({ playwright }) => {
    api = new FeeAgreementUploadPage(await playwright.request.newContext());
  });

  test('the filters this file rests on actually partition', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async () => {
    // An unregistered filter is accepted and IGNORED on this API, so every count below would be a
    // plausible-looking lie. The two collections disagree about which key works, which is exactly
    // how a spec ends up reading the whole book and calling it a patient's documents.
    await api.assertFiltersPartition();

    // The Document Center's status filter is a validated enum rather than a silently-ignored one.
    const all = await api.total('/document_center/documents?type=hv&itemsPerPage=1');
    let sum = 0;
    for (const s of HV_STATUSES) {
      const n = await api.total(`/document_center/documents?type=hv&status=${s}&itemsPerPage=1`);
      console.log(`  hv status=${s.padEnd(9)} ${n}`);
      sum += n;
    }
    expect(sum, 'the three card filters tile the card exactly').toBe(all);
  });

  test('THE TRAP: the ticket\'s "patient 8789" is the UI patient NUMBER, not the API id', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async ({ request }) => {
    // Pinned as its own test because getting this wrong is silent: the number resolves to a real
    // patient, so the spec reads somebody else's data and reports the ticket as unreproducible.
    for (const [number, expectedId] of Object.entries(TICKET_PATIENTS)) {
      const resolved = await api.resolveByPatientNumber(Number(number));
      console.log(`  ticket "patient ${number}" -> API patient id ${resolved}`);
      expect(resolved, `patient number ${number} resolves`).toBe(expectedId);
      expect(resolved, `and is NOT the id ${number}`).not.toBe(Number(number));
    }

    // The half that makes it dangerous rather than merely wrong.
    const token = await api.token();
    const stranger = await request.get(`https://api.staging.therapios.de/patients/8789`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(stranger.status(), 'GET /patients/8789 resolves — to an unrelated person').toBe(200);
  });

  test('AC1 the invariant, over every signed fee-agreement document on staging', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async () => {
    // The whole ticket in one sentence: a patient holding a SIGNED Honorarvereinbarung document must
    // have a signed Hono, because every consumer the ACs name reads the Hono and not the document.
    const [docs, honos] = await Promise.all([api.signedFeeAgreementDocuments(), api.honos()]);
    const byPatient = new Map<string, { status: string; createdAt: string }[]>();
    for (const h of honos) {
      const list = byPatient.get(h.patient) ?? [];
      list.push({ status: h.status, createdAt: h.createdAt });
      byPatient.set(h.patient, list);
    }

    const diverged = docs.filter((d) => {
      const hs = byPatient.get(String(d.patient)) ?? [];
      const live = hs.filter((h) => h.status !== 'archived' && h.status !== 'deleted');
      return !live.some((h) => h.status === 'signed' || h.status === 'signed_migrated');
    });

    console.log(`#3790 signed HV documents: ${docs.length}; patients whose Hono is NOT signed: ${diverged.length}`);
    for (const d of diverged) {
      const hs = byPatient.get(String(d.patient)) ?? [];
      console.log(`   doc ${d.id} ${String(d.createdAt).slice(0, 16)} ${d.patient} honos=${JSON.stringify(hs.map((h) => h.status))}`);
    }

    // Reported rather than asserted to zero: the ticket does NOT backfill, so an upload made before
    // 2026-09-25 legitimately still diverges. Partitioning on the fix date is what makes this
    // meaningful — the same rule #3651 and #3709 needed (old log rows are never rewritten).
    const CUTOVER = '2026-09-25T05:44:00';
    const after = diverged.filter((d) => String(d.createdAt) >= CUTOVER);
    console.log(`#3790 of those, uploaded AFTER the fix shipped: ${after.length}`);
    expect(after, 'no document uploaded since the fix leaves its Hono unsigned').toHaveLength(0);
  });

  test('AC3 the tile already reads the document, and still does', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async () => {
    // AC3 is the "do not regress" half: HonoStatusChecker and findHonoFehlt() read the signed
    // DOCUMENT, which is why they worked before this fix. So no patient holding a signed fee
    // agreement document may sit on the tile — asserted over the whole tile, not a sample.
    const [docs, tile] = await Promise.all([api.signedFeeAgreementDocuments(), api.honoFehltVoNumbers()]);
    const signedPatientIds = new Set(docs.map((d) => String(d.patient)));
    console.log(`#3790 honoFehlt rows: ${tile.size}; patients with a signed HV document: ${signedPatientIds.size}`);

    const offenders: string[] = [];
    for (const patient of signedPatientIds) {
      const id = Number(String(patient).split('/').pop());
      const vos = await api.prescriptionsFor(id);
      for (const vo of vos) {
        const n = String(vo.prescriptionId);
        if (tile.has(n)) offenders.push(`${n} (patient ${id})`);
      }
    }
    console.log(`#3790 VOs of signed-document patients on the honoFehlt tile: ${offenders.length}`);
    expect(offenders, 'AC3: a signed fee agreement keeps its VOs off the tile').toEqual([]);
  });

  test('the ticket\'s real-world case, pinned and deliberately left untouched', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async () => {
    // The billing team's own case (ticket "patient 9498"). It is the last untouched instance of the
    // reported state, and the ticket records that its OTHER repro patient was consumed by a
    // workaround run — so this file reads it and writes somewhere else.
    const id = TICKET_PATIENTS[9498];
    const honos = await api.honosFor(id);
    const vos = await api.prescriptionsFor(id);
    console.log(`#3790 patient ${id}: honos=${JSON.stringify(honos.map((h) => [h.id, h.status]))}`);
    console.log(`#3790 patient ${id}: VOs=${JSON.stringify(vos.map((v) => [v.prescriptionId, v.treatmentStatus, v.insuranceType]))}`);

    expect(honos.length, 'the patient has exactly one Hono').toBe(1);
    expect(honos[0].status, 'still Sent — the state the ticket reported').toBe('sent');
    // `signedDate` is OMITTED when unset, not serialized null (#3302/#3709's shape), so it reads
    // `undefined` — a `toBeNull()` here fails on exactly the state the test is trying to pin.
    expect(honos[0].signedDate ?? null, 'and unsigned').toBeNull();
    const pkvWaiting = vos.filter(
      (v) => v.insuranceType === 'private' && ['For Review', 'Pending'].includes(String(v.treatmentStatus)),
    );
    expect(pkvWaiting.length, 'with a PKV VO still waiting on it').toBeGreaterThan(0);
  });

  test('deployment: the app half of the fix is in the served bundle', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@ReadOnly'],
  }, async ({ page }) => {
    // `/status` cannot answer for this ticket: it reports the release, not the commit (#3704), and
    // says nothing about the frontend at all (#3705). The API half adds no route and no serialized
    // field, so it has no read-only probe — but the app half is one commit with it, and its query
    // invalidation is a literal block that survives minification.
    const { source } = await new TranslationsPage(page).loadDictionaries();
    const block = /'?honorarvereinbarung'?===\w+&&\(\w+\.invalidateQueries\(\{queryKey:\['honos'\]\}\)/;
    expect(source, 'the #3790 fee-agreement invalidation block is deployed').toMatch(block);
    for (const key of ['document_center/documents', 'document-center', 'status-counts']) {
      expect(source.includes(key), `the bundle carries the ${key} invalidation`).toBe(true);
    }
  });

  test('AC1/AC2 end to end — uploading a signed fee agreement signs the Hono and activates the VOs', {
    tag: ['@SuperAdmin', '@FeeAgreementUpload', '@Mutating'],
  }, async () => {
    const patientId = Number(process.env.FEE_AGREEMENT_PATIENT_ID ?? '');
    test.skip(
      !patientId,
      'IRREVERSIBLE — set FEE_AGREEMENT_PATIENT_ID=<api patient id> to run. There is no delete ' +
        'route for a patient document (DELETE is 405), and the upload also archives the patient\'s ' +
        'unsigned Honos, signs one, and moves their PKV VOs to Aktiv. Candidates are patients with ' +
        'an open Hono and a PKV VO in For Review/Pending; do NOT use 8286, the ticket\'s real case.',
    );
    expect(patientId, 'never the ticket\'s untouched real case').not.toBe(TICKET_PATIENTS[9498]);

    const before = {
      honos: await api.honosFor(patientId),
      vos: await api.prescriptionsFor(patientId),
      counts: await api.docCenterCounts(),
    };
    console.log(`#3790 BEFORE honos=${JSON.stringify(before.honos.map((h) => [h.id, h.status, h.signedDate]))}`);
    console.log(`#3790 BEFORE VOs=${JSON.stringify(before.vos.map((v) => [v.prescriptionId, v.treatmentStatus]))}`);
    const waiting = before.vos.filter(
      (v) => v.insuranceType === 'private' && ['For Review', 'Pending'].includes(String(v.treatmentStatus)),
    );
    expect(before.honos.some((h) => ['not_sent', 'sent'].includes(h.status)), 'an open Hono to sign').toBe(true);
    expect(waiting.length, 'a PKV VO waiting on it — otherwise the test proves nothing').toBeGreaterThan(0);

    const up = await api.uploadSignedFeeAgreement(patientId, FeeAgreementUploadPage.tinyPdf('QA 3790'));
    console.log(`#3790 upload -> ${up.status} ${up.body.slice(0, 200)}`);
    expect(up.status, 'the upload is accepted').toBe(201);

    // AC1: the patient's Hono is now signed, with the upload date as its signed date.
    const honos = await api.honosFor(patientId);
    console.log(`#3790 AFTER honos=${JSON.stringify(honos.map((h) => [h.id, h.status, h.signedDate]))}`);
    const live = honos.filter((h) => !['archived', 'deleted'].includes(h.status));
    const signed = live.find((h) => h.status === 'signed');
    expect(signed, 'the patient now has a signed Hono').toBeTruthy();
    expect(signed!.signedDate, 'stamped with a signed date').toBeTruthy();
    expect(new Date(signed!.signedDate!).toISOString().slice(0, 10), 'the upload date').toBe(
      new Date().toISOString().slice(0, 10),
    );
    expect(signed!.logs.length, 'and carrying a Hono log').toBeGreaterThan(0);

    // AC1: every waiting PKV VO moved to Aktiv, each with the German log entry.
    const after = await api.prescriptionsFor(patientId);
    console.log(`#3790 AFTER VOs=${JSON.stringify(after.map((v) => [v.prescriptionId, v.treatmentStatus]))}`);
    for (const w of waiting) {
      const now = after.find((v) => v.prescriptionId === w.prescriptionId);
      expect(String(now?.treatmentStatus), `${w.prescriptionId} moved to Aktiv`).toBe('Aktiv');
      const logs = await api.prescriptionLogs(Number(w.id));
      const entry = logs.find((l) => JSON.stringify(l).includes('Honorarvereinbarung unterschrieben'));
      expect(entry, `${w.prescriptionId} has the "Honorarvereinbarung unterschrieben" log`).toBeTruthy();
    }

    // AC1: the Document Center lists it under Signed, with the uploaded file, and not under the others.
    const rows = await api.docCenterRows();
    const mine = rows.filter((r: DocRow) => r.patientId === patientId);
    console.log(`#3790 Document Center rows for the patient: ${JSON.stringify(mine.map((r) => [r.id, r.status, r.signedAt]))}`);
    expect(mine.some((r) => r.status === 'signed'), 'listed under Signed').toBe(true);
    expect(mine.every((r) => r.status !== 'sent' && r.status !== 'not_sent'), 'and no longer under Sent/Not sent').toBe(true);
    const row = mine.find((r) => r.status === 'signed')!;
    expect(row.contentUrl, 'the row serves a file').toBeTruthy();

    // Out of Scope, asserted rather than assumed: only PKV VOs wait on a fee agreement, so a VO of
    // any other insurance type must be untouched. Free control on this fixture, which carries a GKV
    // VO beside the two PKV ones.
    const nonPkv = before.vos.filter((v) => v.insuranceType !== 'private');
    for (const v of nonPkv) {
      const now = after.find((x) => x.prescriptionId === v.prescriptionId);
      expect(String(now?.treatmentStatus), `${v.prescriptionId} (${v.insuranceType}) is untouched`).toBe(
        String(v.treatmentStatus),
      );
    }
    console.log(`#3790 non-PKV VOs left alone: ${JSON.stringify(nonPkv.map((v) => [v.prescriptionId, v.insuranceType, v.treatmentStatus]))}`);

    // AC3: the VOs leave the "Privat-VO ohne Honorarvereinb." tile.
    const tile = await api.honoFehltVoNumbers();
    for (const w of waiting) {
      expect(tile.has(String(w.prescriptionId)), `${w.prescriptionId} is off the honoFehlt tile`).toBe(false);
    }
  });
});
