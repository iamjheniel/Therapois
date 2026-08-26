import { test, expect } from '@playwright/test';
import { TherapistListPage } from '../../../Pages/therapist/therapist.list.page';

/**
 * RC 3.9 "Deceased Patient Marking" epic (#2995), therapist-facing pieces:
 *   - #2997 AC5: the T Board shows a "Verstorben" indicator next to a deceased patient's name.
 *   - #2998 AC2: terminating a VO offers the "Patient*in verstorben" reason, which escalates to a
 *     patient-level confirmation. This test verifies the reason is present + selectable (the
 *     escalation trigger) and then CANCELS — it never confirms, because confirming would mark the
 *     patient deceased and terminate all their active VOs (destructive on shared staging data).
 *   - #2996 AC1: the admin-only "Als verstorben markieren" action is not reachable by therapists.
 *
 * Staging only (per scope); mirror to Production later.
 */
const DECEASED_NAME = 'NikkiQA DingdingTest';

test.describe('Therapist — Deceased Patient', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });

  test('T Board shows a "Verstorben" indicator next to a deceased patient', {
    tag: ['@Therapist', '@DeceasedIndicators'],
  }, async ({ page }) => {
    const list = new TherapistListPage(page);
    await list.searchPatient('Dingding').catch(() => {});
    await page.waitForTimeout(2500);
    const row = page.getByText(DECEASED_NAME, { exact: false }).filter({ visible: true });
    test.skip(!(await row.count()), 'deceased patient not in this therapist\'s list in this environment');
    // AC5: informational "Verstorben" indicator next to the patient name.
    await expect(page.getByText('Verstorben', { exact: true }).filter({ visible: true }).first())
      .toBeVisible({ timeout: 10_000 });
  });

  test('VO termination offers the "Patient*in verstorben" reason (escalation trigger)', {
    tag: ['@Therapist', '@DeceasedEscalation'],
  }, async ({ page }) => {
    // Select the first patient row and open the termination flow.
    test.skip((await page.getByRole('checkbox').count()) < 2, 'No patient rows available in this therapist\'s list');
    await page.getByRole('checkbox').nth(1).click({ force: true });
    await page.waitForTimeout(700);
    const abbrechen = page.getByRole('button', { name: 'Abbrechen VO' });
    test.skip(!(await abbrechen.isVisible({ timeout: 8000 }).catch(() => false)), 'Selected patient has no cancellable VO');
    await abbrechen.click({ force: true });
    await page.waitForTimeout(2000);

    // "VO Beendigung" → choose the "Abbrechen VO" card to reach the termination-reason step.
    const modal = page.getByTestId('modal-surface').filter({ visible: true }).first();
    await modal.getByText('Abbrechen VO', { exact: true }).first().click({ force: true, timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // AC2 trigger: the "Patient*in verstorben" reason is offered. Selecting it (and confirming)
    // would escalate to a patient-level "mark deceased + terminate all VOs" confirmation — which we
    // deliberately do NOT drive to completion here (destructive on shared data).
    const reason = modal.getByText('Patient*in verstorben', { exact: true }).filter({ visible: true });
    await expect(reason.first()).toBeVisible({ timeout: 8000 });
    await reason.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);

    // Cancel out of the whole flow without committing anything.
    await modal.getByText(/^(Cancel|Abbrechen)$/).filter({ visible: true }).first()
      .click({ force: true, timeout: 4000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  });

  test('Therapists do not have the admin Patienten-Management / Mark-as-Deceased surface', {
    tag: ['@Therapist', '@DeceasedMarking'],
  }, async ({ page }) => {
    // #2996 AC1: the "Als verstorben markieren" action lives on the admin patient form, which
    // therapists cannot reach — they have no Patienten-Management navigation entry.
    await expect(page.getByText('Patienten Management', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Als verstorben markieren', { exact: true })).toHaveCount(0);
  });
});
