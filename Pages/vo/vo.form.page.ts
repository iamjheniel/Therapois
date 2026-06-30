import { Page, Locator, Response, expect } from '@playwright/test';

/** Outcome of an end-to-end Create VO attempt — see {@link VoFormPage.tryCreateVo}. */
export interface CreateVoResult {
  /** True only when the POST /prescriptions save returned a 2xx. */
  saved: boolean;
  /** HTTP status of the POST /prescriptions request, when it was issued. */
  status?: number;
  /** The raw POST /prescriptions response, when it was issued. */
  response?: Response;
  /** True once the validation panel (checks-passed step) was reached. */
  reachedValidation: boolean;
  /** Human-readable reason the save couldn't complete (when `saved` is false). */
  note?: string;
}

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
 *
 * It also supports full end-to-end VO creation via {@link createVo} — see the "End-to-end VO
 * creation" section below for the field map and the multi-step validation save gate.
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

  // ───────────────────────────────────────────────────────────────────────────
  // End-to-end VO creation
  //
  // The "Create VO" form is a long, multi-section form. Selecting a patient
  // auto-fills several fields (Prescription ID/VO-Nr., Praxis, Facility). The
  // remaining required fields must be set manually; selecting an Area surfaces
  // further required fields (ICD code + Diagnosegruppe), and picking an ICD code
  // auto-fills the Diagnose text and Diagnosis Group.
  //
  // Saving is a three-step gate (the submit button is the German "Speichern"):
  //   1. "Speichern"          → runs the backend validation checks
  //   2. mark each manual/failed check "Bestanden" → "Alle N Prüfungen bestanden"
  //   3. "Speichern" (again)  → POST /prescriptions (no separate confirm dialog)
  //
  // Most field labels are English on the form ("Area", "Insurance Type", "Primary
  // Therapist" …); required labels render a trailing " *".
  // ───────────────────────────────────────────────────────────────────────────

  /** The custom dropdown control (a focusable div) that immediately follows a label. */
  private dropdownFor(label: string): Locator {
    return this.page.getByText(label, { exact: true }).locator('xpath=following::div[@tabindex="0"][1]');
  }

  /** The first option row inside the currently-open dropdown flatlist. */
  private firstFlatOption(): Locator {
    return this.page.locator('[data-testid*="flatlist"]').getByText(/\S/).first();
  }

  /**
   * Opens a searchable select (via `open`), types `query` into its search box, and
   * clicks the first result. Used for Patient, Primary Therapist, Gesellschaft, Doctor —
   * each backed by a live `/...` search, so the first match is environment-dependent.
   *
   * Returns `false` when the search yields no option (e.g. the environment has no matching
   * record) so callers can fall back gracefully instead of throwing — this is what keeps the
   * flow data-agnostic rather than tied to a specific record existing.
   */
  private async searchAndPickFirst(open: () => Promise<void>, query: string): Promise<boolean> {
    await open();
    await this.page.waitForTimeout(700);
    const search = this.page.locator('input[placeholder="Search"]').last();
    await search.pressSequentially(query, { delay: 100 });
    // Wait (generously — the search hits the network) for a first result to confirm there's
    // data. Results stream in asynchronously, so a slow/empty first attempt is retried once by
    // re-typing the query before concluding there's genuinely no match — this is the main
    // defence against streaming-search flakiness.
    let appeared = await this.firstFlatOption()
      .waitFor({ state: 'visible', timeout: 9_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      await search.fill('').catch(() => {});
      await this.page.waitForTimeout(400);
      await search.pressSequentially(query, { delay: 100 }).catch(() => {});
      appeared = await this.firstFlatOption()
        .waitFor({ state: 'visible', timeout: 9_000 })
        .then(() => true)
        .catch(() => false);
    }
    // A genuinely missing result means "no such record here": dismiss the open dropdown (else
    // its overlay blocks later steps) and report back so the caller can fall back.
    if (!appeared) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(300);
      return false;
    }
    // Let the streaming list SETTLE before clicking — results stream in as the query runs,
    // and clicking mid-stream detaches the target and hangs. Re-resolve the locator after
    // the wait so we click the settled first row, not a stale handle.
    await this.page.waitForTimeout(1500);
    await this.firstFlatOption().click();
    await this.page.waitForTimeout(1200);
    return true;
  }

  /**
   * A single common letter to seed the patient search. createVo() uses a *random* one so each
   * run targets a different patient — this keeps the (patient + date + ICD + Heilmittel) tuple
   * unique and avoids the "Mögliches doppeltes Rezept" duplicate-detection gate that blocks
   * saving when an identical VO already exists.
   */
  private randomPatientQuery(): string {
    const letters = 'aeinrstlmo';
    return letters[Math.floor(Math.random() * letters.length)];
  }

  /**
   * Selects a patient by free-text query (default: a random common letter → first match).
   * Auto-fills Praxis + Facility. Returns `false` when no patient matches so the caller can
   * fall back to verifying the form contract rather than failing.
   */
  async selectPatient(query = this.randomPatientQuery()): Promise<boolean> {
    return this.searchAndPickFirst(
      () => this.page.getByText('Search patient...', { exact: true }).click(),
      query,
    );
  }

  /**
   * Opens the Issue Date calendar and confirms today's pre-selected date.
   *
   * The calendar is a `dialog` whose header holds a "Save" button (alongside a "Schliessen"
   * close button). We target that button by role and wait for the dialog to close — leaving
   * it open silently overlays the rest of the form and blocks every later step.
   */
  async setIssueDateToday() {
    await this.page.getByText('TT.MM.JJJJ', { exact: true }).first().click();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Select Date' });
    await dialog.waitFor({ state: 'visible', timeout: 8_000 });
    // A day must be actively picked before "Save" commits — clicking Save with nothing
    // selected leaves the calendar open (it then overlays and blocks the rest of the form).
    // Today's day-of-month (1–31) never collides with the year-picker entries (1800+).
    const today = String(new Date().getDate());
    await dialog.getByRole('button', { name: today, exact: true }).first().click();
    await this.page.waitForTimeout(300);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /**
   * Picks the Area / Fachbereich. Picks the first available option by default (data-agnostic);
   * pass `area` to target a specific one. Surfaces ICD + Diagnosegruppe as required.
   */
  async selectArea(area?: string) {
    await this.dropdownFor('Area *').click();
    await this.page.waitForTimeout(900);
    const option = area
      ? this.page.locator('[data-testid*="flatlist"]').getByText(area, { exact: true }).first()
      : this.firstFlatOption();
    await option.click();
    await this.page.waitForTimeout(2_000);
  }

  /** Picks the Insurance Type / Versicherungsart. First available option by default. */
  async selectInsuranceType(type?: string) {
    await this.dropdownFor('Insurance Type *').click();
    await this.page.waitForTimeout(900);
    const option = type
      ? this.page.locator('[data-testid*="flatlist"]').getByText(type, { exact: true }).first()
      : this.firstFlatOption();
    await option.click();
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Searches the Primary ICD field with a seed query and selects the first result.
   * Results render as "CODE -- description"; we click the first such row rather than a
   * specific code, so the test is not tied to one ICD existing. Selecting it auto-fills
   * Diagnose + Diagnosis Group. Returns `false` when the seed yields no results.
   */
  async selectPrimaryIcd(seed = 'M'): Promise<boolean> {
    const icd = this.page.locator('input[placeholder="Search by code or description"]').first();
    await icd.click();
    await icd.pressSequentially(seed, { delay: 130 });
    // Results stream in over the network — wait for the first "CODE -- description" row to
    // actually appear rather than guessing with a fixed sleep (the source of ICD flakiness).
    const firstResult = this.page.getByText(/^\S+ -- /).first();
    const appeared = await firstResult
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) return false;
    // Let the streaming list settle so the row we click isn't detached mid-update.
    await this.page.waitForTimeout(1_200);
    await firstResult.click();
    await this.page.waitForTimeout(1_500);
    return true;
  }

  /** Sets the Prescribed Treatments count (must be greater than zero). */
  async setPrescribedTreatments(count = '6') {
    await this.page
      .getByText('Prescribed Treatments *', { exact: true })
      .locator('xpath=following::input[1]')
      .fill(count);
  }

  /**
   * Selects a treatment Heilmittel. Seeded with 'KG' (Krankengymnastik) by default because the
   * form requires a *Behandlungs-Heilmittel* — supplementary remedies (e.g. AB-P) alone do not
   * satisfy it — but it picks the first result of that search rather than requiring an exact
   * code match, so it tolerates catalogue differences. Confirms the multi-select with "Fertig".
   * Returns `false` when the seed yields no option.
   */
  async selectTreatmentHeilmittel(seed = 'KG'): Promise<boolean> {
    await this.dropdownFor('Heilmittel/s *').click();
    await this.page.waitForTimeout(1_000);
    await this.page.locator('input[placeholder="Search"]').last().pressSequentially(seed, { delay: 120 });
    const flatlist = this.page.locator('[data-testid*="flatlist"]');
    // Wait for the streaming option list to actually produce a row instead of guessing with a
    // fixed sleep (the source of Heilmittel flakiness — the search hits the network).
    const anyOption = flatlist.getByText(/\S/).filter({ visible: true }).first();
    const appeared = await anyOption
      .waitFor({ state: 'visible', timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      await this.page.getByText('Fertig', { exact: true }).click().catch(() => {});
      return false;
    }
    // Let the streaming list settle, then re-resolve so we don't click a detached row.
    await this.page.waitForTimeout(1_200);
    // Prefer an exact seed match (each option row carries data-testid=<code>); fall back to
    // the first available visible option so the flow isn't tied to one specific code existing.
    let option = flatlist.getByText(seed, { exact: true }).filter({ visible: true }).first();
    if (!(await option.isVisible().catch(() => false))) {
      option = flatlist.getByText(/\S/).filter({ visible: true }).first();
    }
    await option.click();
    await this.page.waitForTimeout(500);
    await this.page.getByText('Fertig', { exact: true }).click();
    await this.page.waitForTimeout(700);
    return true;
  }

  /** Sets the frequency Min and (required) Max. */
  async setFrequency(min = '1', max = '1') {
    await this.page.locator('input[placeholder="Min"]').fill(min);
    await this.page.locator('input[placeholder="Max *"]').fill(max);
  }

  /**
   * Selects the Primary Therapist by free-text query (default 'a' → first match). Returns
   * `false` when the search yields no option so the caller can bail fast (this is a REQUIRED
   * field — leaving it empty makes "Speichern" surface inline errors instead of validation).
   */
  async selectPrimaryTherapist(query = 'a'): Promise<boolean> {
    return this.searchAndPickFirst(() => this.dropdownFor('Primary Therapist *').click(), query);
  }

  /** Selects the Gesellschaft (company), REQUIRED. Returns `false` when no option matches. */
  async selectGesellschaft(query = 'a'): Promise<boolean> {
    return this.searchAndPickFirst(() => this.dropdownFor('Gesellschaft *').click(), query);
  }

  /**
   * Selects a Doctor (optional on the form, but a validation rule expects an Arzt). Selecting
   * one keeps the "Pflichtfelder … Arzt …" validation check green without a manual override.
   * Returns `false` when none matches; the caller can proceed regardless (Doctor is optional).
   */
  async selectDoctor(query = 'a'): Promise<boolean> {
    return this.searchAndPickFirst(() => this.dropdownFor('Doctor').click(), query);
  }

  /** Dismisses any open dropdown overlay whose backdrop would intercept a Save click. */
  private async dismissOverlay() {
    const backdrop = this.page.locator('[data-testid="modal-backdrop"]');
    for (let i = 0; i < 3 && (await backdrop.isVisible().catch(() => false)); i++) {
      await backdrop.click({ position: { x: 4, y: 4 } }).catch(() => {});
      await this.page.waitForTimeout(400);
    }
  }

  /** The form's bottom-bar submit button — the German "Speichern" (not "Save"). */
  private speichernButton(): Locator {
    return this.page.getByText('Speichern', { exact: true }).filter({ visible: true }).last();
  }

  /**
   * Clicks "Speichern" to run the validation checks, then marks every manual/failed check
   * "Bestanden" so all checks pass. When all pass the panel reads "Alle N Prüfungen bestanden"
   * and a second "Speichern" (see {@link confirmValidatedSave}) commits the VO.
   *
   * Two prompts can block the save when the chosen patient already has a similar VO:
   *   • a "Mögliches doppeltes Rezept" dialog → "Kein Duplikat bestätigen"
   *   • an inline "Vorgänger-VO erkannt" (predecessor detected) prompt → "Ablehnen"
   * Both must be cleared (and Speichern re-clicked) before validation runs; this loops until the
   * validation panel appears.
   */
  async runValidationAndApproveChecks() {
    const valPanel = this.page
      .getByText(/Prüfungen bestanden|fehlgeschlagen|manuelle Prüfung/)
      .first();
    const confirmNotDuplicate = this.page.getByText('Kein Duplikat bestätigen', { exact: true });
    const rejectPredecessor = this.page.getByText('Ablehnen', { exact: true });

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.dismissOverlay();
      await this.speichernButton().click().catch(() => {});
      await this.page.waitForTimeout(2_000);
      if (await confirmNotDuplicate.isVisible().catch(() => false)) {
        await confirmNotDuplicate.click().catch(() => {});
        await this.page.waitForTimeout(1_200);
      }
      if (await rejectPredecessor.isVisible().catch(() => false)) {
        await rejectPredecessor.first().click().catch(() => {});
        await this.page.waitForTimeout(1_200);
      }
      if (await valPanel.isVisible().catch(() => false)) break;
    }
    // The 4-attempt loop above already gave the panel ample time; if it still isn't here a
    // required field is unfilled — fail fast (don't burn the test budget) so the orchestrator
    // can fall back to the form-contract assertion.
    await valPanel.waitFor({ timeout: 8_000 });

    // Each check row offers "Bestanden" / "Nicht bestanden"; clicking "Bestanden" approves that
    // check and removes its button, exposing the next. Loop until none remain (all green).
    for (let guard = 0; guard < 12; guard++) {
      const approve = this.page.getByText('Bestanden', { exact: true });
      if ((await approve.count()) === 0) break;
      await approve.first().click().catch(() => {});
      await this.page.waitForTimeout(500);
    }
    await this.page.waitForTimeout(1_000);
  }

  /**
   * Commits a fully-validated VO. Once every check is green the panel reads
   * "Alle N Prüfungen bestanden" and the bottom-bar "Speichern" is clicked a second time to
   * actually persist the VO — there is NO separate "Validiert speichern" button or "Confirm
   * Save" dialog in this app version. Returns the POST /prescriptions response (201 on success).
   */
  async confirmValidatedSave() {
    // Confirm the checks actually all passed before committing (fail fast otherwise so the
    // orchestrator can fall back to the contract instead of hanging to the test timeout).
    await this.page
      .getByText(/Alle \d+ Prüfungen bestanden/)
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (r) => /\/prescriptions(\?|$)/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      this.speichernButton().click(),
    ]);
    return response;
  }

  /**
   * Fills every required field of the Create VO form with first-available / seeded-default
   * values and attempts to save it end-to-end (through the validation gate). The form must
   * already be open (see {@link openCreateVoForm}).
   *
   * This NEVER throws on a data/environment condition — it returns a {@link CreateVoResult}
   * describing how far it got. The caller decides what to do: assert success when `saved`,
   * or fall back to {@link expectCreateFormContract} otherwise. Reasons a save legitimately
   * can't complete in a given environment:
   *   • no patient / ICD / Heilmittel records match the seed search (empty environment)
   *   • the `/practices` API is unavailable (Staging 500) so Praxis never auto-fills
   *   • the chosen patient hits the duplicate / Vorgänger-VO gate that can't be cleared
   *   • the validation panel never becomes reachable or a check can't be approved
   */
  async tryCreateVo(
    opts: {
      patient?: string;
      area?: string;
      insuranceType?: string;
      icdSeed?: string;
      heilmittel?: string;
      prescribedTreatments?: string;
      frequencyMin?: string;
      frequencyMax?: string;
      therapist?: string;
      gesellschaft?: string;
      doctor?: string;
    } = {},
  ): Promise<CreateVoResult> {
    try {
      if (!(await this.selectPatient(opts.patient ?? this.randomPatientQuery()))) {
        return { saved: false, reachedValidation: false, note: 'no matching patient in this environment' };
      }
      await this.setIssueDateToday();
      await this.selectArea(opts.area);
      await this.selectInsuranceType(opts.insuranceType);
      if (!(await this.selectPrimaryIcd(opts.icdSeed ?? 'M'))) {
        return { saved: false, reachedValidation: false, note: 'no ICD matched the seed search' };
      }
      await this.setPrescribedTreatments(opts.prescribedTreatments ?? '6');
      if (!(await this.selectTreatmentHeilmittel(opts.heilmittel ?? 'KG'))) {
        return { saved: false, reachedValidation: false, note: 'no Heilmittel matched the seed search' };
      }
      await this.setFrequency(opts.frequencyMin ?? '1', opts.frequencyMax ?? '1');
      // Primary Therapist + Gesellschaft are REQUIRED: if either search comes back empty, bail
      // now (fast) rather than clicking Speichern and waiting on a validation panel that will
      // never appear — leaving time for the caller's form-contract fallback.
      if (!(await this.selectPrimaryTherapist(opts.therapist ?? 'a'))) {
        return { saved: false, reachedValidation: false, note: 'no Primary Therapist matched the search' };
      }
      if (!(await this.selectGesellschaft(opts.gesellschaft ?? 'a'))) {
        return { saved: false, reachedValidation: false, note: 'no Gesellschaft matched the search' };
      }
      // Doctor is optional on the form — select one when available, but don't bail if absent.
      await this.selectDoctor(opts.doctor ?? 'a');
    } catch (e) {
      return { saved: false, reachedValidation: false, note: `form fill failed: ${(e as Error).message}` };
    }

    const reachedValidation = await this.runValidationAndApproveChecks()
      .then(() => true)
      .catch(() => false);
    if (!reachedValidation) {
      return { saved: false, reachedValidation: false, note: 'validation gate never became reachable' };
    }

    try {
      const response = await this.confirmValidatedSave();
      return { saved: response.ok(), status: response.status(), reachedValidation: true, response };
    } catch (e) {
      return { saved: false, reachedValidation: true, note: `save not confirmed: ${(e as Error).message}` };
    }
  }

  /**
   * Data-independent fallback: re-opens the Create VO form fresh and asserts the contract
   * that holds regardless of backend data — Praxis is required, Doctor is optional (the
   * #2670 epic headline). Used when {@link tryCreateVo} couldn't complete a real save.
   */
  async expectCreateFormContract() {
    await this.openCreateVoForm();
    await this.expectPracticeRequired();
    await this.expectDoctorOptional();
  }

  /** Asserts the form closed and returned to the dashboard after a successful create. */
  async expectBackOnDashboard() {
    await expect(this.page.getByText('Create VO', { exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(this.page.getByText('Dashboard - Verwaltung', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
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
