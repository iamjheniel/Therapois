import { test, expect } from '@playwright/test';
import { SAVE_FOR_FIXING, SAVE_VALIDATE, VoValidationPage } from '../../../Pages/admin/admin.vo-validation.page';

/**
 * RC 3.11 — "Zur Korrektur speichern" choice gets silently overridden (#3340).
 *
 * The post-save recompute in `PrescriptionValidationListener` forced VALIDATED whenever every check
 * passed, and FOR_FIXING whenever one failed — discarding whichever choice the admin had actually
 * clicked (production VO 3227-19 was saved For Fixing and ended up Validated; the 10 Aug dump counted
 * 76 automatic upgrades and 69 automatic downgrades). The fix adds
 * `creationValidationStatusManuallySet`: when set, the recompute is skipped in both directions.
 *
 * **These tests write, and restore.** The protection is only observable across a write, so each test
 * records the VO's `creationValidationStatus` / marker / `actionRequired`, drives the transition, and
 * PATCHes everything back — asserting the restore landed. Only QA-owned VOs are touched (patients
 * "Yuji ItadoriTest", "Gianni ActubTest", "Test3307 Completion"), and no clinical field is changed:
 * the recompute is re-fired by flipping `actionRequired`, a plain flag, which is enough to produce the
 * Doctrine flush the listener hooks.
 *
 * Run as Super Admin: the Admin role gets 403 on PATCHing these QA VOs (verified on VO 965005-1),
 * which is also the role the PM used.
 *
 * Two mechanics worth knowing, both verified live:
 *  - PATCHing `creationValidationStatus` **sets the marker to true by itself**, and PATCHing the
 *    status back to `null` clears it — the API treats an explicit status write as an explicit choice,
 *    exactly like the save buttons do.
 *  - The recompute fires on a VO flush, not on a re-check request: `POST
 *    /prescriptions/{id}/check-creation-validation` re-evaluates checks but persists nothing when the
 *    verdicts are unchanged, so it leaves the status alone.
 */

/** QA fixtures, chosen for their check state. */
const ALL_PASSING_VO = 34226; // 965110-4, 15/15 pass, validated + marker
const SOME_FAILING_VO = 34167; // 965005-1, 2 of 26 fail, validated + marker
const NO_CHOICE_VO = 34225; // 9653-1, 8 of 15 fail, status null + no marker

test.describe('VO validation choice — an explicit save is not overridden', () => {
  // The AC1 and AC2 tests share ALL_PASSING_VO and both write to it.
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1 — an explicit For Fixing survives even when every check passes',
    { tag: ['@SuperAdmin', '@ValidationChoice', '@CreationValidation'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const vos = new VoValidationPage(page);
      await vos.open();

      const before = await vos.validationState(ALL_PASSING_VO);
      console.log(`before: ${JSON.stringify(before)}`);
      expect(before.evaluated, 'the fixture must have evaluated checks').toBeGreaterThan(0);
      expect(
        before.failing,
        'AC1 is about the all-checks-pass case — the fixture must have no failing check',
      ).toBe(0);

      try {
        expect(await vos.patch(ALL_PASSING_VO, { creationValidationStatus: 'for_fixing' }), 'set For Fixing').toBe(200);
        const chosen = await vos.validationState(ALL_PASSING_VO);
        console.log(`after choosing For Fixing: ${JSON.stringify(chosen)}`);
        // The override used to ride the same write as the save, which is why this is checked before
        // any further recompute: VO 3227-19 never even logged a status change.
        expect(
          chosen.status,
          'the explicit For Fixing must survive the recompute that runs on the same write — this is the ' +
            'silent upgrade to Validated the ticket is about',
        ).toBe('for_fixing');
        expect(chosen.manuallySet, 'an explicit status write must be marked as a manual choice').toBe(true);

        // And again on a later, unrelated write, which is when the second reported flavour struck.
        await vos.triggerRecompute(ALL_PASSING_VO, chosen.actionRequired);
        const after = await vos.validationState(ALL_PASSING_VO);
        console.log(`after a later write: ${JSON.stringify(after)}`);
        expect(after.status, 'a later save must not upgrade the VO to Validated either').toBe('for_fixing');
        expect(after.failing, 'and the checks themselves must still all pass').toBe(0);
      } finally {
        await vos.patch(ALL_PASSING_VO, { actionRequired: before.actionRequired });
        await vos.patch(ALL_PASSING_VO, { creationValidationStatus: before.status });
        const restored = await vos.validationState(ALL_PASSING_VO);
        console.log(`restored: ${JSON.stringify(restored)}`);
        expect(restored.status, 'the fixture must be left as it was found').toBe(before.status);
        expect(restored.actionRequired, 'including its actionRequired flag').toBe(before.actionRequired);
      }
    },
  );

  test(
    'AC2 — an explicit Validated stays Validated when every check passes',
    { tag: ['@SuperAdmin', '@ValidationChoice', '@CreationValidation'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const vos = new VoValidationPage(page);
      await vos.open();

      const before = await vos.validationState(ALL_PASSING_VO);
      console.log(`before: ${JSON.stringify(before)}`);
      expect(before.status, 'the fixture carries an explicit Validated choice').toBe('validated');
      expect(before.manuallySet, 'with the manual marker set').toBe(true);
      expect(before.failing, 'and no failing check').toBe(0);

      try {
        await vos.triggerRecompute(ALL_PASSING_VO, before.actionRequired);
        const after = await vos.validationState(ALL_PASSING_VO);
        console.log(`after a write: ${JSON.stringify(after)}`);
        expect(after.status, 'existing correct behaviour must be preserved — Validated stays Validated').toBe(
          'validated',
        );
        expect(after.manuallySet, 'and the choice stays marked as the admin’s').toBe(true);
      } finally {
        await vos.patch(ALL_PASSING_VO, { actionRequired: before.actionRequired });
        expect((await vos.validationState(ALL_PASSING_VO)).actionRequired).toBe(before.actionRequired);
      }
    },
  );

  test(
    'AC3 — an explicit Validated is not flipped back when a check fails',
    { tag: ['@SuperAdmin', '@ValidationChoice', '@CreationValidation'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const vos = new VoValidationPage(page);
      await vos.open();

      const before = await vos.validationState(SOME_FAILING_VO);
      console.log(`before: ${JSON.stringify(before)}`);
      expect(before.status, 'the fixture carries an explicit Validated choice').toBe('validated');
      expect(before.manuallySet, 'with the manual marker set').toBe(true);
      expect(
        before.failing,
        'AC3 needs a VO that has a failing check while sitting at Validated — that is the downgrade case',
      ).toBeGreaterThan(0);

      try {
        await vos.triggerRecompute(SOME_FAILING_VO, before.actionRequired);
        const after = await vos.validationState(SOME_FAILING_VO);
        console.log(`after a write: ${JSON.stringify(after)}`);
        expect(
          after.status,
          `the VO has ${after.failing} failing check(s) but was explicitly saved as Validated — the ` +
            `overall status must not flip itself back to For Fixing`,
        ).toBe('validated');
        // The individual check must still show its failure — the ticket keeps that visible on purpose.
        expect(after.failing, 'the failing check itself stays failing in the panel').toBeGreaterThan(0);
      } finally {
        await vos.patch(SOME_FAILING_VO, { actionRequired: before.actionRequired });
        expect((await vos.validationState(SOME_FAILING_VO)).actionRequired).toBe(before.actionRequired);
      }
    },
  );

  test(
    'AC4 — the marker only appears from an explicit choice, and clears with it',
    { tag: ['@SuperAdmin', '@ValidationChoice', '@CreationValidation'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const vos = new VoValidationPage(page);
      await vos.open();

      // AC4 protects VOs that never had an explicit choice: they must keep recomputing. What is
      // directly checkable is the gate that decides it — the marker — plus the fact that the automatic
      // path is still what produced most of today's statuses.
      const before = await vos.validationState(NO_CHOICE_VO);
      console.log(`before: ${JSON.stringify(before)}`);
      expect(before.manuallySet, 'the fixture must have no explicit choice on it').toBe(false);

      try {
        // A plain write must not invent a choice for it.
        await vos.triggerRecompute(NO_CHOICE_VO, before.actionRequired);
        const afterWrite = await vos.validationState(NO_CHOICE_VO);
        console.log(`after an unrelated write: ${JSON.stringify(afterWrite)}`);
        expect(afterWrite.manuallySet, 'an ordinary save must not mark an unset status as a manual choice').toBe(false);

        // Writing the status IS a choice, and it marks it — that is the gate the fix keys off.
        expect(await vos.patch(NO_CHOICE_VO, { creationValidationStatus: 'for_fixing' }), 'set For Fixing').toBe(200);
        const chosen = await vos.validationState(NO_CHOICE_VO);
        console.log(`after an explicit status write: ${JSON.stringify(chosen)}`);
        expect(chosen.status, 'the chosen status is stored').toBe('for_fixing');
        expect(chosen.manuallySet, 'and marked as manual — this is what switches the recompute off').toBe(true);
      } finally {
        await vos.patch(NO_CHOICE_VO, { creationValidationStatus: before.status });
        await vos.patch(NO_CHOICE_VO, { actionRequired: before.actionRequired });
        const restored = await vos.validationState(NO_CHOICE_VO);
        console.log(`restored: ${JSON.stringify(restored)}`);
        expect(restored.status, 'the fixture is left unset again').toBe(before.status);
        expect(restored.manuallySet, 'and unmarked — clearing the status clears the marker').toBe(false);
      }

      // The automatic path is still what most statuses come from: read off the for_fixing population.
      const queue = await vos.vosByValidationStatus('for_fixing', 30);
      const automatic = queue.filter((vo) => !vo.validationManuallySet).length;
      console.log(`for_fixing VOs: ${queue.length}, of which ${automatic} were set automatically (no marker)`);
      expect(
        automatic,
        'VOs with no explicit choice must still be getting their status automatically — if the marker ' +
          'were being set indiscriminately, this population would be empty',
      ).toBeGreaterThan(0);
    },
  );

  test(
    'AC5 — the confirmation dialog matches the button that opened it',
    { tag: ['@SuperAdmin', '@ValidationChoice', '@CreationValidation'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const vos = new VoValidationPage(page);
      await vos.open();

      // A VO with failing checks is the only state that offers both buttons.
      await vos.openForm(SOME_FAILING_VO);
      const buttons = await vos.saveButtons();
      console.log(`buttons on a VO with failing checks: ${JSON.stringify(buttons)}`);
      expect(buttons, 'the For-Fixing save must be offered here').toContain(SAVE_FOR_FIXING);

      const forFixing = await vos.openSaveDialog(SAVE_FOR_FIXING);
      console.log(`For-Fixing dialog: ${JSON.stringify(forFixing)}`);
      expect(forFixing, 'the For-Fixing save must confirm before saving').not.toBeNull();
      expect(
        forFixing,
        'and its heading must name the choice being made (Zur Prüfung) with the check tally, not ' +
          'Validate-style wording',
      ).toMatch(/Zur Prüfung — \d+ bestanden, \d+ nicht bestanden/);

      // The validate path cannot show the wrong wording any more because it shows no dialog at all:
      // with every check passing it submits straight away (asserted here on the all-passing fixture,
      // where only that button exists), and with a check failing the button does nothing (see the
      // fixme'd finding below).
      await vos.openForm(ALL_PASSING_VO);
      const passingButtons = await vos.saveButtons();
      console.log(`buttons on an all-passing VO: ${JSON.stringify(passingButtons)}`);
      expect(
        passingButtons,
        'with every check passing the form offers only the validate save — the For-Fixing button is ' +
          'not rendered, so the mismatched-wording case cannot arise there either',
      ).not.toContain(SAVE_FOR_FIXING);
      expect(passingButtons, 'the validate save is offered').toContain(SAVE_VALIDATE);
    },
  );

  test('“Speichern” does nothing on a VO with a failing check', { tag: ['@SuperAdmin', '@ValidationChoice'] }, async () => {
    test.fixme(
      true,
      'FINDING (staging, 2026-08-18), adjacent to AC5 rather than covered by it: on a VO with failing ' +
        'checks the validate button "Speichern" is rendered fully enabled (opacity 1, cursor pointer, ' +
        'no aria-disabled) but clicking it does nothing at all — no confirmation dialog, no PATCH ' +
        'attempted, no toast, no console error (VO 965005-1, 2 of 26 checks failing). On an ' +
        'all-passing VO the same button submits immediately. If validating a VO with failures is ' +
        'intentionally disallowed the control should be disabled or say why; silently swallowing the ' +
        'click leaves the admin unsure whether the save happened, which is the same class of problem ' +
        'as the silent status override this ticket fixes. Un-fixme once the button either acts or ' +
        'explains itself.',
    );
  });
});
