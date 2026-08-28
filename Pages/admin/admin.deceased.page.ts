import { Page, Locator } from '@playwright/test';
import { settleAfter, waitForOpen, waitForStable } from '../util/settle';

/**
 * Page Object for the RC 3.9 "Deceased Patient Marking" epic (#2995): the admin "Als verstorben
 * markieren" action + confirmation dialog (#2996), the deceased banner/badge/indicators and the
 * Patienten-Management "Verstorben" filter (#2997), and the VO-creation deceased warning (#2998).
 *
 * Navigation uses direct URLs (all verified to work): the Admin Board is /dashboard, the patient
 * detail/edit form is /patient-management/<id>/edit, the Patienten-Management list is
 * /patient-management, and the VO-creation form is /vo-management/add.
 *
 * A known, stable deceased QA patient is reused for the read-only indicator/banner/undo checks —
 * "NikkiQA DingdingTest" (id 8124), marked deceased by SA Jhen; its VOs are already terminated so
 * it is safe as fixture data. SAFETY: this POM never CONFIRMS a deceased marking, termination, or
 * VO creation — it opens each destructive affordance up to its confirmation and then cancels.
 */
export const DECEASED_PATIENT = { name: 'NikkiQA DingdingTest', id: 8124 };

export class DeceasedPage {
  constructor(private page: Page, private baseUrl = 'https://staging.therapios.de') {}

  private root(): Locator {
    return this.page.locator('#root');
  }

  // ---------------------------------------------------------------- Admin Board (#2997 AC4)

  /** Loads the Admin Board VO table (wide viewport) and waits for rows. */
  async openAdminBoard(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.goto(`${this.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    await this.page.getByText('Name', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    // The header paints ahead of the rows; callers read rows. Wait for the row set to settle.
    await waitForStable(this.page.getByRole('checkbox'));
  }

  /** A deceased "Verstorben" inline indicator badge (used on Admin Board / T Board / CRM). */
  deceasedIndicator(): Locator {
    return this.page.getByText('Verstorben', { exact: true }).filter({ visible: true });
  }

  /**
   * Runs an interaction and waits for the requests it fires to come back, rather than sleeping a
   * flat guess. `fallbackMs` is the sleep this replaced, kept only as the upper bound — see
   * `Pages/util/settle.ts`.
   */
  private async settle<T>(action: () => Promise<T>, fallbackMs: number): Promise<T> {
    return await settleAfter(this.page, action, { budgetMs: Math.max(fallbackMs, 10_000) });
  }

  /** Searches the Admin Board VO table (top-right "Suchen" box) to surface a patient's rows. */
  async searchAdminBoard(term: string): Promise<void> {
    // Case-insensitive: the Admin Board box is now "Patient, VO-Nr. suchen …" (lower-case verb),
    // and a RegExp passed to getByPlaceholder matches case-sensitively unless flagged.
    const box = this.page.getByPlaceholder(/suchen/i).filter({ visible: true }).last();
    await box.fill(term);
    await this.settle(() => box.press('Enter'), 3000);
  }

  // ---------------------------------------------------------------- Patient detail form (#2996/#2997 AC3)

  /** Opens a patient's detail/edit form by id and waits for it to render. */
  async openPatientForm(id: number): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.settle(
      () =>
        this.page.goto(`${this.baseUrl}/patient-management/${id}/edit?id=${id}`, {
          waitUntil: 'domcontentloaded',
        }),
      4500,
    );
  }

  /** Opens the first patient on the Admin Board (by name link) and returns to their edit form. */
  async openFirstPatientForm(): Promise<boolean> {
    await this.openAdminBoard();
    const firstName = this.page.locator('a, [href*="patient-management"]').filter({ visible: true });
    // Patient names are links in the Name column; click the first that navigates to a patient form.
    const nameLink = this.page.getByText(/^[A-ZÄÖÜ][a-zäöü]+ [A-ZÄÖÜ]/).filter({ visible: true }).first();
    await this.settle(() => nameLink.click({ force: true }).catch(() => {}), 4000);
    return /patient-management\/\d+\/edit/.test(this.page.url());
  }

  markAsDeceasedButton(): Locator {
    return this.page.getByText('Als verstorben markieren', { exact: true }).filter({ visible: true });
  }

  undoDeceasedButton(): Locator {
    return this.page.getByText("Markierung 'Verstorben' rückgängig machen", { exact: true }).filter({ visible: true });
  }

  /** The deceased banner on a marked patient's form ("Als verstorben markiert am [Datum] von [Admin].") */
  deceasedBanner(): Locator {
    return this.page.getByText(/Als verstorben markiert am .* von /).filter({ visible: true });
  }

  // ---- confirmation dialog (#2996 AC2/AC3) ----

  confirmDialogTitle(): Locator {
    return this.page.getByText('Patient als verstorben markieren', { exact: true });
  }

  /** Opens the "Mark as Deceased" confirmation dialog. Returns whether it appeared. */
  async openMarkDialog(): Promise<boolean> {
    await this.markAsDeceasedButton().first().click({ force: true, timeout: 6000 }).catch(() => {});
    return this.confirmDialogTitle()
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Cancels the confirmation dialog WITHOUT marking the patient deceased. The dialog renders last in
   * the DOM (portal), so its "Abbrechen" is the LAST visible one — clicking .first() would hit a
   * control behind the modal overlay and leave the dialog open.
   */
  async cancelMarkDialog(): Promise<void> {
    await this.page.getByText('Abbrechen', { exact: true }).filter({ visible: true }).last()
      .click({ force: true, timeout: 4000 }).catch(() => {});
    await this.page.waitForTimeout(600);
  }

  // ---------------------------------------------------------------- Patienten Management (#2997 AC1/AC2)

  async openPatientManagement(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.settle(
      () => this.page.goto(`${this.baseUrl}/patient-management`, { waitUntil: 'domcontentloaded' }),
      5000,
    );
  }

  /** The deceased filter dropdown (defaults to "Verstorben: Ausblenden" = hide deceased). */
  deceasedFilter(): Locator {
    return this.page.getByText(/^Verstorben: (Ausblenden|Alle anzeigen)$/).filter({ visible: true }).first();
  }

  /** Toggles the deceased filter to show all patients (incl. deceased). */
  async showDeceased(): Promise<void> {
    const box = await this.deceasedFilter().boundingBox();
    if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const showAll = this.page
      .getByText('Verstorben: Alle anzeigen', { exact: true })
      .filter({ visible: true })
      .first();
    // The option appearing is what the click below needs; wait for it instead of 1.2 s.
    await waitForOpen(showAll, 6_000);
    await showAll.click({ force: true, timeout: 5000 }).catch(() => {});
    await this.settle(async () => {}, 2500);
  }

  async searchPatients(term: string): Promise<void> {
    const box = this.page.getByRole('textbox').filter({ visible: true }).last();
    await box.fill(term);
    await this.settle(() => box.press('Enter'), 3000);
  }

  // ---------------------------------------------------------------- VO creation warning (#2998 AC1)

  async openCreateVo(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.settle(
      () => this.page.goto(`${this.baseUrl}/vo-management/add`, { waitUntil: 'domcontentloaded' }),
      4000,
    );
  }

  /** Selects a patient in the Create-VO patient picker by name. Returns whether it was selected. */
  async selectVoPatient(name: string): Promise<boolean> {
    await this.page.getByText('Search patient...', { exact: true }).filter({ visible: true }).first()
      .click({ force: true, timeout: 6000 }).catch(() => {});
    // "Search" → "Suchen" in v3.11.0; accept either so Production's older build still resolves.
    const search = this.page
      .locator('input[placeholder="Search"], input[placeholder="Suchen"]')
      .filter({ visible: true })
      .first();
    // The search box appearing IS "the picker opened", so wait for that rather than 1 s flat. The
    // `count()` guard below still decides whether the picker exists at all in this build.
    await waitForOpen(search, 6_000);
    if (!(await search.count())) return false;
    await search.click().catch(() => {});
    await search.fill(name).catch(() => {});
    const opt = this.page.getByText(name, { exact: false }).filter({ visible: true }).first();
    // Results stream in over the network; wait for the list to stop changing before reading it.
    await waitForStable(this.page.getByText(name, { exact: false }).filter({ visible: true }));
    if (!(await opt.count())) return false;
    // Selecting a patient back-fills Praxis + Einrichtung from the backend, so settle on that.
    await settleAfter(
      this.page,
      () => opt.click({ force: true, timeout: 6000 }).catch(() => {}),
      { budgetMs: 12_000 },
    );
    return true;
  }

  deceasedVoWarning(): Locator {
    return this.page.getByText(/Dieser Patient ist als verstorben markiert\. Eine VO kann trotzdem erstellt werden/);
  }
}
