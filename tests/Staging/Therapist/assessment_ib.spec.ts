import { test, expect } from '@playwright/test';
import { TherapistAssessmentPage } from '../../../Pages/therapist/therapist.assessment.page';

/**
 * Coverage for two therapist-dashboard features, both surfaced as columns on "Meine VOs":
 *
 *   - Assessment (BF column) — a Befund status per VO row; the chip opens an assessment modal.
 *   - Initialbefund (IB column) — a "+ IB" control per active row that opens an Initialbefund modal.
 *
 * **BF and IB are both opt-in now.** Each is one of the nine columns the board's "Spalten" picker
 * leaves unchecked, so both sets of tests turn their column on first — the feature is reachable,
 * not on by default. (IB used to ship in the default set; v3.11.0 moved it out, alongside HM.)
 *
 * The column *presence + per-row status/affordance* is asserted directly (stable, non-data-gated).
 * The modal-open flow is data-gated: the control is inert for patient states that don't currently
 * allow a Befund/Initialbefund (e.g. the QA therapist's staging patients), so those tests attempt
 * the interaction and test.skip() when no modal surfaces — the assertion still runs whenever the
 * feature is live for the resolved patient. Staging only (per scope); mirror to Production later.
 */
test.describe('Therapist Assessment (BF) & Initialbefund (IB)', () => {
  let dashboard: TherapistAssessmentPage;

  test.beforeEach(async ({ page }) => {
    dashboard = new TherapistAssessmentPage(page);
    await dashboard.open();
    await dashboard.filterPatients('Test');
    await dashboard.expandActivePatients();
    test.skip((await dashboard.activeRowCount()) < 1, 'No active patients in this therapist\'s list');
  });

  // --------------------------------------------------------------------- Assessment (BF)

  test('Assessment (BF) column is offered by the Spalten picker', { tag: ['@Therapist', '@assessment'] }, async () => {
    // Off by default: the column must not be in the table until it is asked for.
    await expect(dashboard.columnHeader('BF'), 'BF ships opt-in').toHaveCount(0);

    await dashboard.enableColumn('BF');
    await expect(dashboard.columnHeader('BF'), 'enabling BF must put it in the table').toBeVisible({
      timeout: 15_000,
    });
    // And every row gets a Befund cell, whether or not it has a Befund.
    await expect
      .poll(async () => dashboard.columnCells('BF').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('Open Assessment (BF) modal from a patient row', { tag: ['@Therapist', '@assessment'] }, async () => {
    await dashboard.enableColumn('BF');
    await expect(dashboard.columnHeader('BF')).toBeVisible({ timeout: 15_000 });

    const opened = await dashboard.openModalFromFirstRow('BF');
    test.skip(!opened, 'Assessment (BF) is not actionable for the available patient state — no modal opened');

    await dashboard.assertModalIsForm();
    await dashboard.closeModal();
  });

  // --------------------------------------------------------------------- Initialbefund (IB)

  test('Initialbefund (IB) column exposes an add control for active patients', { tag: ['@Therapist', '@IB'] }, async () => {
    // Off by default: the column must not be in the table until it is asked for.
    await expect(dashboard.columnHeader('IB'), 'IB ships opt-in').toHaveCount(0);

    await dashboard.enableColumn('IB');
    await expect(dashboard.columnHeader('IB'), 'enabling IB must put it in the table').toBeVisible({
      timeout: 15_000,
    });
    // Every active VO row carries a "+ IB" add-Initialbefund control.
    await expect
      .poll(async () => dashboard.ibAddControl().count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(dashboard.ibAddControl().first()).toBeVisible();
  });

  test('Open Initialbefund (IB) modal from a patient row', { tag: ['@Therapist', '@IB'] }, async () => {
    await dashboard.enableColumn('IB');
    await expect(dashboard.columnHeader('IB')).toBeVisible({ timeout: 15_000 });

    const opened = await dashboard.openModalFromFirstRow('IB');
    test.skip(!opened, 'Initialbefund (IB) is not actionable for the available patient state — no modal opened');

    await dashboard.assertModalIsForm();
    await dashboard.closeModal();
  });
});
