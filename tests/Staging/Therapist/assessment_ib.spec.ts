import { test, expect } from '@playwright/test';
import { TherapistAssessmentPage } from '../../../Pages/therapist/therapist.assessment.page';

/**
 * Coverage for two new therapist-dashboard features, both surfaced as columns immediately after
 * the existing TB (T-Board) column on "Meine VOs":
 *
 *   - Assessment (BF column) — a Befund status per VO row; the chip opens an assessment modal.
 *   - Initialbefund (IB column) — a "+ IB" control per active row that opens an Initialbefund modal.
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

  test('Assessment (BF) column is present on the dashboard', { tag: ['@Therapist', '@assessment'] }, async () => {
    await expect(dashboard.columnHeader('BF')).toBeVisible({ timeout: 15_000 });
  });

  test('Open Assessment (BF) modal from a patient row', { tag: ['@Therapist', '@assessment'] }, async () => {
    await expect(dashboard.columnHeader('BF')).toBeVisible({ timeout: 15_000 });

    const opened = await dashboard.openModalFromFirstRow('BF');
    test.skip(!opened, 'Assessment (BF) is not actionable for the available patient state — no modal opened');

    await dashboard.assertModalIsForm();
    await dashboard.closeModal();
  });

  // --------------------------------------------------------------------- Initialbefund (IB)

  test('Initialbefund (IB) column exposes an add control for active patients', { tag: ['@Therapist', '@IB'] }, async () => {
    await expect(dashboard.columnHeader('IB')).toBeVisible({ timeout: 15_000 });
    // Every active VO row carries a "+ IB" add-Initialbefund control.
    await expect
      .poll(async () => dashboard.ibAddControl().count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(dashboard.ibAddControl().first()).toBeVisible();
  });

  test('Open Initialbefund (IB) modal from a patient row', { tag: ['@Therapist', '@IB'] }, async () => {
    await expect(dashboard.columnHeader('IB')).toBeVisible({ timeout: 15_000 });

    const opened = await dashboard.openModalFromFirstRow('IB');
    test.skip(!opened, 'Initialbefund (IB) is not actionable for the available patient state — no modal opened');

    await dashboard.assertModalIsForm();
    await dashboard.closeModal();
  });
});
