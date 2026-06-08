import { Page, Locator, expect } from '@playwright/test';

/**
 * Page Object for the "VO erstellen" (Create VO) form reached from the Admin/SA dashboard.
 *
 * Covers the "VO Direct Practice Assignment" epic (therapios/monorepo#2670, RC 3.6.0):
 * practice is now a direct, REQUIRED field on the VO (searchable by name AND BSNR) and the
 * doctor became OPTIONAL. See #2671 for the form-level acceptance criteria.
 *
 * The form is React Native Web: labels are plain divs, a required field renders a trailing
 * `<span> *</span>` so the label's text reads e.g. "Praxis *". The practice control is a
 * custom dropdown showing the placeholder "Praxis suchen..." that, when clicked, reveals a
 * `input[placeholder="Search"]` and a flatlist of "Practice Name (BSNR)" options.
 */
export class VoFormPage {
  constructor(private page: Page) {}

  /** Opens the dashboard and the Create VO form. Uses the project baseURL (staging/prod). */
  async openCreateVoForm() {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const createBtn = this.page.getByText('VO erstellen', { exact: true }).first();
    await createBtn.waitFor({ state: 'visible', timeout: 45_000 });
    await createBtn.click();
    await expect(this.page.getByText('Create VO', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }

  /** Required field labels render their text with a trailing " *". */
  private requiredLabel(label: string): Locator {
    return this.page.getByText(`${label} *`, { exact: true });
  }

  /** Asserts the People & Facilities section shows a REQUIRED Praxis field (epic headline). */
  async expectPracticeRequired() {
    await this.page
      .getByText('People & Facilities', { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(this.page.getByText('Praxis suchen...', { exact: true })).toBeVisible();
    await expect(this.requiredLabel('Praxis')).toBeVisible();
  }

  /** Asserts the Doctor field is present but OPTIONAL (no required asterisk). */
  async expectDoctorOptional() {
    await expect(this.page.getByText('Search doctor...', { exact: true })).toBeVisible();
    await expect(this.page.getByText('Doctor', { exact: true })).toBeVisible();
    // The doctor label must NOT carry the required asterisk.
    await expect(this.requiredLabel('Doctor')).toHaveCount(0);
  }

  /** Opens the practice dropdown and reveals its search input. */
  async openPracticeDropdown() {
    await this.page
      .getByText('People & Facilities', { exact: true })
      .scrollIntoViewIfNeeded();
    await this.page.getByText('Praxis suchen...', { exact: true }).click();
    await expect(this.practiceSearchInput()).toBeVisible({ timeout: 15_000 });
  }

  private practiceSearchInput(): Locator {
    return this.page.locator('input[placeholder="Search"]');
  }

  /**
   * Opens the practice dropdown (if needed) and types a query. Typing fires a request to
   * `/practices?...search[name]=<q>&search[practiceId]=<q>` — i.e. it searches by name AND
   * BSNR (practiceId), which is the searchability requirement of #2671 AC1.
   */
  async searchPractice(query: string) {
    if (!(await this.practiceSearchInput().isVisible().catch(() => false))) {
      await this.openPracticeDropdown();
    }
    await this.practiceSearchInput().pressSequentially(query, { delay: 120 });
  }

  /** The dropdown option rows, formatted "Practice Name (BSNR)". */
  private practiceOptions(): Locator {
    return this.page
      .locator('[data-testid="undefined flatlist"]')
      .getByText(/\(\d{6,}\)/);
  }

  /** Number of practice options currently offered (0 when the /practices API is unavailable). */
  async practiceOptionCount(timeout = 8_000): Promise<number> {
    await this.practiceOptions()
      .first()
      .waitFor({ state: 'visible', timeout })
      .catch(() => {});
    return this.practiceOptions().count();
  }

  /** Selects the first practice option and returns its name (BSNR suffix stripped). */
  async selectFirstPractice(): Promise<string> {
    const option = this.practiceOptions().first();
    const raw = (await option.innerText()).trim();
    await option.click();
    return raw.replace(/\s*\(\d+\)\s*$/, '').trim();
  }

  async cancel() {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  /**
   * Asserts the Admin/SA dashboard offers a "Praxis" column in the "Spalten anzeigen"
   * (show columns) menu — the surface that displays a VO's directly-assigned practice
   * (#2673). Opening the menu adds a "Praxis" entry, so the exact-"Praxis" count grows
   * beyond the always-present sidebar item.
   */
  async expectDashboardPraxisColumnOption() {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const showCols = this.page.getByText('Spalten anzeigen', { exact: true });
    await showCols.waitFor({ state: 'visible', timeout: 45_000 });
    const baseline = await this.page.getByText('Praxis', { exact: true }).count();
    await showCols.click();
    await expect
      .poll(() => this.page.getByText('Praxis', { exact: true }).count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(baseline);
  }
}
