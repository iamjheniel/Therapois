import { Page, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';
import { DokuModalPage } from '../therapist/therapist.doku-modal.page';
import { settleAfter, waitForStable } from '../util/settle';

/**
 * The T Board "Doku erfassen" (document treatment) flow, as driven by Admin and Super Admin.
 *
 * Three things about the current build shape this page object:
 *  - the therapist picker is a real button labelled "Therapeut:in wählen" opening a searchable
 *    `[role="dialog"]`; the old "Therapist: (Select)" text trigger is gone.
 *  - the Doku modal's REQUIRED "Heilmittel auswählen *" multi-select is gone again. The note is the
 *    only required field now, and it is a `<textarea>` placeheld "Doku eingeben" — the
 *    `text-input-outlined` testid no longer appears on this modal. Save reads "Speichern".
 *  - the app renders no success snackbar, so the observable outcome of a save is the modal closing
 *    rather than an `aria-live` toast.
 *
 * The modal itself is encapsulated in `Pages/therapist/therapist.doku-modal.page.ts`, which the
 * therapist specs drive too — this class only adds the Admin/SA-specific therapist selection.
 */
export class AdminTBoardPage {
  constructor(private page: Page) {}

  private modal() {
    return this.page.getByTestId('modal-surface');
  }

  /** Opens the T Board. Navigating directly is more reliable than the (often off-screen) rail item. */
  async open(baseUrl = 'https://staging.therapios.de') {
    await new AppPage(this.page).goto(`${baseUrl}/therapist`);
    // The only thing this method owes its caller is a board that can accept a therapist choice, and
    // the picker trigger appearing IS that condition - so wait for it instead of sleeping 8 s on
    // every open. It also fails usefully: an 8 s sleep on a board that never painted handed the
    // caller a dead page and the failure surfaced later, somewhere else.
    await expect(this.therapistPickerTrigger()).toBeVisible({ timeout: 45_000 });
  }

  /** The Admin/SA therapist picker trigger. See {@link selectTherapist} for the label history. */
  private therapistPickerTrigger() {
    return this.page
      .getByRole('button', { name: 'Therapeut:in wählen', exact: true })
      .or(this.page.getByText('Therapist: (Select)'))
      .first();
  }

  /**
   * Picks a therapist — the board does not auto-populate for Admin/SA accounts; until one is chosen
   * it shows "Keine Therapeut:in ausgewählt".
   *
   * The trigger was relabelled and localised: "Therapist: (Select)" is now a real button labelled
   * **"Therapeut:in wählen"**. It opens a `[role="dialog"]` with its own "Therapeut:in suchen" box,
   * listing each therapist over their discipline ("Sandra Zeibig" / "physiotherapy"). The older
   * label is still accepted so the page object works against an environment that has not updated.
   */
  async selectTherapist(name: string) {
    const trigger = this.therapistPickerTrigger();
    await trigger.click();

    const picker = this.page.locator('[role="dialog"]');
    // The list is long enough to virtualise, so type into its search box when there is one.
    const search = picker.getByPlaceholder(/Therapeut:in suchen/i);
    if (await search.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await search.first().fill(name);
      // The filtered list is what the next step reads, so wait for it to stop changing rather than
      // guessing at 1.5 s.
      await waitForStable(picker.getByText(/\S/));
    }

    const option = (await picker.count())
      ? picker.getByText(name, { exact: true }).first()
      : this.page.getByText(name, { exact: true }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    // Choosing a therapist refetches the whole board. Settle on those requests instead of the flat
    // 6 s, which was simultaneously the single most expensive wait in this flow and no guarantee at
    // all that the board had actually arrived.
    await settleAfter(this.page, () => option.click(), { budgetMs: 20_000 });
  }

  /** Selects the first patient row (nth(0) is the header checkbox) and opens the Doku modal. */
  async openDokuForFirstRow() {
    await this.page.getByRole('checkbox').nth(1).click({ force: true });
    await this.page.getByRole('button', { name: /Doku erfassen/ }).first().click();
    await expect(this.modal()).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Fills the note, picks the first Behandlungsart, then saves.
   *
   * Accepts either outcome the backend can return: the modal closes on success, or it stays open
   * reporting a conflict — "… bereits erfasst. Datum ändern oder Patient entfernen." — when that
   * patient already has an activity for the date. The conflict is expected whenever another role's
   * T Board spec documented the same patient/day earlier in the run.
   */
  async documentTreatment(note: string) {
    return await new DokuModalPage(this.page).documentTreatment(note);
  }
}
