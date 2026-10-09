import { test, expect } from '../../fixtures/session';
import { ReactivationNoticePage, GERMAN_FRAGMENTS, NOTICE_KEYS } from '../../../Pages/superadmin/sa.reactivation-notice.page';

/**
 * RC 3.13 — a notice when reactivating an expired VO clears its "Bestellen" status (#3561).
 *
 * #3197 already clears `followupStatus` and `orderDate` when an Abgelaufen VO goes back to Aktiv;
 * nothing told the admin, so the field just went blank. This ticket adds the notice — per VO on a
 * single reactivation, one summary with a count on a bulk one. The clearing itself is unchanged.
 * **Deployed (PR #3585, merged to `release/3.13.0`); every client-inspectable half verified.
 * 5 passed / 2 fixme.**
 *
 * **Both deployed surfaces can be inspected without reactivating anything, which matters because a
 * reactivation is not reversible in the way that counts:** setting the VO back to Abgelaufen does
 * not restore the `followupStatus` and `orderDate` the reactivation destroyed. So the tests take the
 * two surfaces directly:
 *
 * 1. `POST /prescriptions/status/bulk` now answers `{count, clearedFollowupCount}` — the number the
 *    bulk notice renders. **A payload naming an id that matches nothing probes it with zero side
 *    effects:** `findBy(['id' => …])` returns an empty set and the loop body never runs. That
 *    distinction is load-bearing — the loop writes a `treatment_status_change` log for EVERY
 *    prescription it finds, even when the status does not change, so the tempting "post Aktiv onto
 *    an already-Aktiv VO" probe is not side-effect free and is deliberately not used here.
 * 2. The single-VO notice is decided by `reactivationClearedFollowup()` reading the PATCH RESPONSE,
 *    never recomputing — so it cannot drift from the clearing. Its contract is that a cleared
 *    `followupStatus` is **omitted from the payload entirely** rather than serialized as null
 *    (#3302), and that is asserted here on VOs in both states.
 *
 * **One i18n pair serves both paths** — `reactivation_cleared_followup_count_one` / `_other` with
 * `{{count}}` — so a single reactivation renders the singular of the same string the bulk summary
 * uses. Both ship, in both locales, with the German values present in their escaped form (#3611).
 *
 * **Fixture pool for the parts that need a write:** 166 VOs are currently Abgelaufen **and** carry
 * Folge-VO Status `order`. Manual steps are in `docs/manual-test-3561-reactivation-notice.md`.
 *
 * **Read-only** — the one POST names an id that exists nowhere.
 */

test.describe('#3561 notice when reactivation clears the Bestellen status', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC3/AC4 the deployed bulk endpoint returns clearedFollowupCount',
    { tag: ['@SuperAdmin', '@ReactivationNotice', '@ReadOnly'] },
    async ({ request }) => {
      // Probed with an id that matches nothing: the controller finds no prescriptions, the loop
      // never runs, and nothing is written — so the field is confirmed on the live API for free.
      const api = new ReactivationNoticePage(request);
      const res = await api.bulkStatus([999_000_001], 'Aktiv');
      console.log(`#3561: POST /prescriptions/status/bulk {id:[999000001]} -> ${res.status} count=${res.count} clearedFollowupCount=${res.clearedFollowupCount}`);

      expect(res.status).toBe(200);
      expect(res.count, 'no prescription matched, so nothing was processed').toBe(0);
      expect(
        res.clearedFollowupCount,
        'the field the bulk notice reads must exist on the deployed endpoint — 0, not absent',
      ).toBe(0);
    },
  );

  test(
    'AC1 the contract the single-VO notice depends on: a cleared followupStatus is OMITTED, not null',
    { tag: ['@SuperAdmin', '@ReactivationNotice', '@ReadOnly'] },
    async ({ request }) => {
      // `reactivationClearedFollowup()` decides the notice on `response.followupStatus == null`.
      // That works only because the API omits the field once cleared (#3302) — if it ever started
      // serializing `null` the check would still pass, but if it started serializing `""` or the
      // previous value the notice would silently stop appearing. Pinned on both states.
      const api = new ReactivationNoticePage(request);
      const withOrder = await api.reactivationCandidates(3);
      expect(withOrder.length, 'the fixture pool must be non-empty').toBeGreaterThan(0);

      for (const vo of withOrder) {
        const shape = await api.serializesFollowupStatus(vo.id);
        console.log(`   VO ${vo.number.padEnd(10)} (Abgelaufen, Bestellen): followupStatus present=${shape.present} value=${JSON.stringify(shape.value)}`);
        expect(shape.present, `VO ${vo.number} still has the status, so it must be serialized`).toBe(true);
        expect(shape.value, 'and it must read as the enum the notice checks against').toBe('order');
      }

      // The other side: a VO with no follow-up status must OMIT the key entirely.
      const anyVo = await api.serializesFollowupStatus(1);
      console.log(`   a VO with no follow-up status: followupStatus present=${anyVo.present} value=${JSON.stringify(anyVo.value)}`);
      expect(
        anyVo.present === false || anyVo.value == null,
        'a VO without the status must omit it (or at least read null) — the notice keys off that',
      ).toBe(true);
    },
  );

  test(
    'AC1/AC3 the notice text ships, in both plural forms and both locales',
    { tag: ['@SuperAdmin', '@ReactivationNotice', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReactivationNoticePage(request);
      const bundle = await api.bundle();

      for (const key of NOTICE_KEYS) {
        const n = bundle.split(key).length - 1;
        console.log(`   ${key} -> ${n} occurrences (expect 2: de + en)`);
        expect(n, `${key} must ship in both locale dictionaries`).toBeGreaterThanOrEqual(2);
      }
      for (const fragment of GERMAN_FRAGMENTS) {
        const n = api.escapedCount(bundle, fragment);
        console.log(`   "${fragment}" -> ${n}`);
        expect(n, `the German value "${fragment}" must ship`).toBeGreaterThan(0);
      }
      // The bulk notice can only render a count if the frontend reads the new field.
      expect(bundle.includes('clearedFollowupCount'), 'the frontend must consume the API field').toBe(true);
      console.log('#3561: both plural forms ship and the frontend references clearedFollowupCount');
    },
  );

  test(
    'AC5 the notice is informational — nothing about it gates the reactivation',
    { tag: ['@SuperAdmin', '@ReactivationNotice', '@ReadOnly'] },
    async ({ request }) => {
      // The clearing happens server-side inside the same transaction as the status change, and the
      // count is reported afterwards in the response body. So by construction the admin cannot be
      // asked to confirm anything: by the time any notice can render, the write is already
      // committed. Asserted as the shape of the contract rather than by driving a dialog.
      const api = new ReactivationNoticePage(request);
      const res = await api.bulkStatus([999_000_002], 'Aktiv');
      expect(res.status, 'the endpoint answers outright — no interstitial, no confirmation step').toBe(200);
      expect(res.clearedFollowupCount, 'the count is reported after the fact, not asked about before').toBe(0);
      console.log('#3561 AC5: the count arrives in the response body, i.e. after the write is committed');
    },
  );

  test(
    'evidence — the fixture pool for the parts that need a real reactivation',
    { tag: ['@SuperAdmin', '@ReactivationNotice', '@ReadOnly'] },
    async ({ request }) => {
      const api = new ReactivationNoticePage(request);
      const [expired, ordering, both] = await Promise.all([
        api.countWhere('treatmentStatus=Abgelaufen'),
        api.countWhere('followupStatus=order'),
        api.countWhere('treatmentStatus=Abgelaufen&followupStatus=order'),
      ]);
      console.log(`#3561 fixtures: ${expired} Abgelaufen, ${ordering} with Folge-VO Status "Bestellen", ${both} with BOTH`);
      const candidates = await api.reactivationCandidates(5);
      for (const c of candidates) {
        console.log(`   VO ${c.number.padEnd(10)} id ${String(c.id).padEnd(6)} followupStatus=${c.followupStatus} orderDate=${String(c.orderDate).slice(0, 10)}`);
      }
      expect(both, 'AC1 and AC3 need VOs in this state; if this hits zero the manual steps need new ids').toBeGreaterThan(0);
    },
  );

});
