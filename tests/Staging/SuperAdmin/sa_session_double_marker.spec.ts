import { test, expect } from '../../fixtures/session';
import {
  SessionDoubleMarkerPage,
  SESSION_REPORT,
  TAG_TEXT,
  SCREEN_FIXTURE,
  MIXED_VOS,
} from '../../../Pages/superadmin/sa.session-double-marker.page';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.14 #3711 — a Doppelbehandlung must be marked, and timed as double, on every list of
 * individual sessions.
 *
 * READ-ONLY: every request is a GET; the screen half only navigates and reads.
 */

const S = SessionDoubleMarkerPage;

test.describe('#3711 double sessions marked and timed as double', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: SessionDoubleMarkerPage;

  test.beforeEach(({ page }) => {
    api = new SessionDoubleMarkerPage(page);
  });

  test(
    'deployment — the new session-level resource answers, and it fails closed without a selection',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      // Two of the five surfaces did not exist and were built by this commit, both reading this
      // resource — so its presence is the API half's deployment probe. `/status` cannot say: it
      // reports the release, not the commit (#3704).
      const withPatient = await api.sessionReport(`?patient=${SCREEN_FIXTURE.patientId}`);
      console.log(`#3711 GET ${SESSION_REPORT}?patient=${SCREEN_FIXTURE.patientId} -> ${withPatient.status}, ${withPatient.total} rows`);
      expect(withPatient.status, `${SESSION_REPORT} is not on this API`).toBe(200);
      expect(withPatient.total).toBeGreaterThan(0);

      // The row shape the two clients depend on.
      const row = withPatient.rows[0];
      console.log(`#3711 row shape: ${JSON.stringify(row)}`);
      for (const field of [
        'patientName',
        'patientLastName',
        'patientBirthDate',
        'prescriptionId',
        'sessionDate',
        'heilmittelCodes',
        'therapistName',
        'durationMinutes',
        'doubleTreatment',
      ]) {
        expect(row, `the row is missing ${field}`).toHaveProperty(field);
      }
      expect(typeof row.doubleTreatment, 'doubleTreatment must be a real boolean, never omitted').toBe('boolean');

      // Health data: no selection, no rows. Note this is the OPPOSITE of `/prescriptions`, where an
      // unregistered filter is ignored and the whole book comes back.
      for (const q of ['', '?zzzNotAFilter=1', '?startDate=2025-08-01&endDate=2025-08-31']) {
        const r = await api.sessionReport(q);
        console.log(`#3711 ${SESSION_REPORT}${q || ' (no filter)'} -> ${r.total} rows`);
        expect(r.total, `"${q}" returned rows — the endpoint does not fail closed`).toBe(0);
      }

      // The full Berichte selection is the other supported shape and does return rows.
      const berichte = await api.sessionReport(
        '?startDate=2025-08-01&endDate=2025-08-31&elderlyCareHome=21&department=physiotherapy',
      );
      console.log(`#3711 the Berichte selection (facility + discipline + range) -> ${berichte.total} rows`);
      expect(berichte.total).toBeGreaterThan(0);
    },
  );

  test(
    'the session report is admin-only',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@Security', '@ReadOnly'] },
    async () => {
      // Article 9 health data, one row per session — the resource and the operation both carry
      // ROLE_ADMIN and every field an explicit group, so default-deny holds.
      const asTherapist = await api.sessionReport(
        `?patient=${SCREEN_FIXTURE.patientId}`,
        STAGING_CREDENTIALS.therapist,
      );
      console.log(`#3711 therapist -> ${asTherapist.status}`);
      expect(asTherapist.status).toBe(403);
    },
  );

  test(
    'AC1/AC2/AC3 — every session the therapist marked double is reported double, with doubled minutes',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      for (const fixture of MIXED_VOS) {
        const kind = await api.isV2(fixture.vo);
        expect(kind.exists, `fixture VO ${fixture.vo} has gone`).toBe(true);
        expect(kind.v1, `${fixture.vo} is no longer a legacy (V1) double VO`).toBe(true);

        const flags = await api.sessionFlags(fixture.prescriptionId);
        const rows = (await api.sessionsForPatient(fixture.patientId)).filter(
          (r) => r.prescriptionId === fixture.vo,
        );
        expect(rows.length, `no session-report rows for ${fixture.vo}`).toBeGreaterThan(0);

        const singles = rows.filter((r) => !r.doubleTreatment).map((r) => r.durationMinutes);
        const doubles = rows.filter((r) => r.doubleTreatment).map((r) => r.durationMinutes);
        console.log(
          `#3711 ${fixture.vo}: ${rows.length} sessions — ${doubles.length} double ${JSON.stringify([...new Set(doubles)])} min, ` +
            `${singles.length} single ${JSON.stringify([...new Set(singles)])} min`,
        );

        // The report must agree with the flag the therapist actually set, session by session.
        for (const r of rows) {
          const flagged = flags.get(S.iso(r.sessionDate));
          expect(flagged, `no activity on ${fixture.vo} for ${r.sessionDate}`).not.toBeUndefined();
          expect(r.doubleTreatment, `${fixture.vo} ${r.sessionDate} marker`).toBe(flagged);
        }

        // AC4's control, and it is what makes "doubled" mean something: the same VO's single
        // sessions carry the undoubled value, so the doubled rows must be exactly twice it.
        expect(new Set(singles).size, `${fixture.vo}'s single sessions disagree on duration`).toBe(1);
        expect(new Set(doubles).size, `${fixture.vo}'s double sessions disagree on duration`).toBe(1);
        expect(doubles[0], `${fixture.vo}: ${doubles[0]} is not twice ${singles[0]}`).toBe(singles[0]! * 2);
      }
    },
  );

  test(
    'AC4 — a session that is not a Doppelbehandlung reports no marker and its plain minutes',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      // Over a whole Berichte selection rather than a chosen VO, so the negative half is checked
      // at scale instead of on the fixtures that were picked for having a double.
      const { rows } = await api.sessionReport(
        '?startDate=2025-08-01&endDate=2025-08-31&elderlyCareHome=21&department=physiotherapy',
      );
      const singles = rows.filter((r) => !r.doubleTreatment);
      const doubles = rows.filter((r) => r.doubleTreatment);
      console.log(`#3711 August selection: ${rows.length} sessions, ${doubles.length} double, ${singles.length} single`);

      // Every row answers the question one way or the other — never null, never absent.
      for (const r of rows) expect(typeof r.doubleTreatment).toBe('boolean');
      // And a duration is always reported, so a client never has to guess.
      expect(rows.filter((r) => r.durationMinutes === null).length).toBe(0);

      // The selection has to contain both kinds, or "no marker on a single" is vacuous.
      expect(singles.length, 'no single sessions in the window').toBeGreaterThan(0);
      expect(doubles.length, 'no double sessions in the window — AC4 has no contrast here').toBeGreaterThan(0);

      const singleMinutes = [...new Set(singles.map((r) => r.durationMinutes))].sort((a, b) => a! - b!);
      const doubleMinutes = [...new Set(doubles.map((r) => r.durationMinutes))].sort((a, b) => a! - b!);
      console.log(`#3711 single durations ${JSON.stringify(singleMinutes)} | double durations ${JSON.stringify(doubleMinutes)}`);
    },
  );

  test(
    'the V2 split representation is deliberately NOT doubled — and has no instance on staging',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      // `doubleTreatment` is the MARKER and `durationMinutes` the arithmetic: a V2 double carries
      // the marker but not the x2, because its doubling lives in ActivityTreatment::quantity.
      // #3602 established staging has no V2 double VO at all — including the two the ticket for
      // that fix named — so the branch is unexercised here, which is worth saying rather than
      // leaving as an untested silence.
      const checked: string[] = [];
      for (const fixture of MIXED_VOS) {
        const kind = await api.isV2(fixture.vo);
        checked.push(`${fixture.vo} v1=${kind.v1} v2=${kind.v2}`);
        expect(kind.v2).toBe(false);
      }
      console.log(`#3711 ${checked.join(' | ')}`);
      console.log(
        '#3711 every double VO reachable here is the legacy (V1) shape, so the report\'s ' +
          '"marker yes, x2 no" branch for V2 is not exercised on staging (#3602 found 0 V2 double VOs ' +
          'in a 1,400-VO sample, and the two that ticket named do not exist).',
      );
    },
  );

  test(
    'AC4/AC2 localization — the new strings ship in both locales, at their real key paths',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async ({ page }) => {
      const { de, en } = (await new TranslationsPage(page).loadDictionaries()) as any;
      const pairs: [string, string, string][] = [
        ['common.double_treatment_x2', 'Doppelbehandlung ×2', 'Double treatment ×2'],
        ['common.double_treatment_x2_minutes', 'Doppelbehandlung ×2 · {{minutes}} Min', 'Double treatment ×2 · {{minutes}} min'],
        ['common.minutes_short', 'Min', 'min'],
        ['patients.form.sessions_title', 'Behandlungen', 'Treatments'],
        ['patients.form.sessions_empty', 'Keine Behandlungen für diesen Patienten gefunden.', 'No treatments found for this patient.'],
        ['patients.form.session_date', 'Datum', 'Date'],
        ['patients.form.session_duration', 'Dauer', 'Duration'],
        ['reports.controls.export_sessions_pdf', 'Behandlungen exportieren', 'Export Treatments'],
        ['reports.session_export.columns.double_treatment', 'Doppelbehandlung', 'Double Treatment'],
      ];
      for (const [key, deValue, enValue] of pairs) {
        console.log(`#3711 ${key}  de=${JSON.stringify(de[key])}  en=${JSON.stringify(en[key])}`);
        expect(de[key], `${key} missing from de`).toBe(deValue);
        expect(en[key], `${key} missing from en`).toBe(enValue);
      }

      // The whole export column set, so a missing column in the Berichte PDF is visible here.
      const exportColumns = Object.keys(de).filter((k) => k.startsWith('reports.session_export.columns.'));
      console.log(`#3711 export columns: ${JSON.stringify(exportColumns.map((k) => k.split('.').pop()))}`);
      expect(exportColumns.length).toBeGreaterThanOrEqual(8);

      // FINDING, reported rather than failed. The Testing Guidance says to REUSE the existing tag
      // and translation key from the Flow Boards calendar; what shipped is a second key holding
      // the same German, with the original left in place and still used there.
      console.log(
        `#3711 FINDING: the pre-existing Flow-Boards key therapist_board.double_treatment_x2 = ` +
          `${JSON.stringify(de['therapist_board.double_treatment_x2'])} is untouched, and the commit added a ` +
          `SECOND key common.double_treatment_x2 with the identical value instead of reusing it — two keys now ` +
          `hold the same string on two surfaces and can drift apart. Deliberate per the component's docblock ` +
          `(the calendar's is a dashed BOX around two cards, this one an inline chip), but it diverges from the ` +
          `ticket's own guidance and is worth a PM decision.`,
      );
      expect(de['therapist_board.double_treatment_x2']).toBe(de['common.double_treatment_x2']);
    },
  );

  test(
    'AC2 on screen — the Patient Management session table marks the double row and doubles its minutes',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      await api.openPatientSessions(SCREEN_FIXTURE.patientId);
      const rows = await api.sessionTableRows();
      console.log(`#3711 patient ${SCREEN_FIXTURE.patientId} session table: ${rows.length} rows painted`);
      for (const r of rows) {
        console.log(`#3711   ${r.date} | ${r.vo} | ${r.heilmittel} | ${r.therapist} | ${r.duration} | tag=${r.tag ?? '—'}`);
      }
      expect(rows.length).toBeGreaterThan(0);

      const tagged = rows.filter((r) => r.tag !== null);
      const plain = rows.filter((r) => r.tag === null);
      expect(tagged.length, 'no Doppelbehandlung row is painted on this page').toBeGreaterThan(0);
      expect(plain.length, 'every row is tagged — AC4 has no contrast on this page').toBeGreaterThan(0);

      // AC2: the marker, and the DOUBLED minutes, on the session the API reports as double.
      const double = tagged.find((r) => r.date === SCREEN_FIXTURE.doubleSessionDate);
      expect(double, `the ${SCREEN_FIXTURE.doubleSessionDate} session is not tagged`).toBeTruthy();
      expect(double!.tag).toContain(TAG_TEXT);
      expect(double!.tag).toContain(`${SCREEN_FIXTURE.doubleMinutes} Min`);
      expect(double!.duration).toBe(`${SCREEN_FIXTURE.doubleMinutes} Min`);

      // AC4: the same VO's other sessions, same Heilmittel, carry no marker and half the minutes.
      for (const r of plain) {
        expect(r.vo, 'the fixture patient has sessions on another VO now').toBe(SCREEN_FIXTURE.vo);
        expect(r.duration, `${r.date} should be the single duration`).toBe(`${SCREEN_FIXTURE.singleMinutes} Min`);
      }

      // The tag is CSS-uppercased, so a test reading innerText would be comparing against
      // "DOPPELBEHANDLUNG ×2 · 60 MIN" and an exact-text assertion would fail on a correct build.
      const tags = await api.tags();
      console.log(`#3711 tag readings: ${JSON.stringify(tags)}`);
      for (const t of tags) {
        expect(t.textContent).toContain(TAG_TEXT);
        expect(t.innerText).toBe(t.innerText.toUpperCase());
      }
    },
  );

  test(
    'evidence — the report agrees with the screen, row for row',
    { tag: ['@SuperAdmin', '@SessionDoubleMarker', '@ReadOnly'] },
    async () => {
      // The two surfaces are supposed to be the same data; asserting it pins the hook between the
      // new endpoint and the new screen, which is the only thing that could silently drift.
      const served = await api.sessionsForPatient(SCREEN_FIXTURE.patientId);
      await api.openPatientSessions(SCREEN_FIXTURE.patientId);
      const painted = await api.sessionTableRows();

      const byDate = new Map(served.map((r) => [r.sessionDate, r]));
      let compared = 0;
      for (const row of painted) {
        const api_ = byDate.get(row.date);
        if (!api_) continue;
        compared++;
        expect(row.duration, `${row.date} duration`).toBe(`${api_.durationMinutes} Min`);
        expect(row.tag !== null, `${row.date} marker`).toBe(api_.doubleTreatment);
      }
      console.log(`#3711 ${compared} of ${painted.length} painted rows compared against the API, 0 mismatches`);
      expect(compared).toBeGreaterThan(0);
    },
  );
});
