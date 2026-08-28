import { Locator, Page, expect } from '@playwright/test';
import { settleAfter } from '../util/settle';

/**
 * The "Doku erfassen" (document treatment) modal — the primary action on both the therapist board
 * and the Admin/Super-Admin T Board.
 *
 * The redesign reshaped it, and every selector the suite used for it moved:
 *  - the surface testid is **`modal-surface`**; `surface` no longer exists on this modal (it is still
 *    used elsewhere in the app, so don't replace it globally),
 *  - the title reads **"Doku erfassen (N)"** (was "Mark as Treated (N)"),
 *  - the note is a **`<textarea>`** placeheld "Doku eingeben" — not a `text-input-outlined` input —
 *    and it is the one required field, so "Speichern" stays `disabled` until it is filled,
 *  - the save button is **"Speichern"** (was "Save") and cancel is "Abbrechen",
 *  - the required **"Heilmittel auswählen"** step is gone,
 *  - "Behandlungsart" offers two radios, "Durchgeführt" and "Geplant", and
 *    "Patient:in hat die Behandlung verweigert" is a `[role="checkbox"]`.
 */
export class DokuModalPage {
  constructor(private page: Page) {}

  /** Behandlungsart options the modal offers. */
  static readonly TREATMENT_KINDS = ['Durchgeführt', 'Geplant'] as const;

  /**
   * The modal surface.
   *
   * `.first()` matters: saving can briefly mount a SECOND `modal-surface` container, and a
   * multi-match locator makes every read throw a strict-mode violation — which, behind the
   * `.catch()` guards these waits need, looks identical to "still open" and hangs the wait.
   */
  modal(): Locator {
    return this.page.getByTestId('modal-surface').first();
  }

  /** True once the modal is gone — either unmounted entirely or present but hidden. */
  private async isModalGone(): Promise<boolean> {
    if ((await this.page.getByTestId('modal-surface').count()) === 0) return true;
    return await this.modal().isHidden().catch(() => false);
  }

  /** Opens the modal for the current row selection via the selection bar's "Doku erfassen (N)". */
  async open(): Promise<void> {
    await this.page.getByRole('button', { name: /Doku erfassen/ }).first().click();
    await expect(this.modal(), 'the Doku modal must open').toBeVisible({ timeout: 20_000 });
    await expect(this.modal()).toContainText('Doku erfassen', { timeout: 15_000 });
  }

  /** Asserts the modal is scoped to `count` selected patients. */
  async expectSelectionCount(count: number): Promise<void> {
    await expect(this.modal(), `the modal must be scoped to ${count} selected patient(s)`).toContainText(
      `Doku erfassen (${count})`,
      { timeout: 15_000 },
    );
  }

  /** The note field — required, and the gate on "Speichern". */
  noteField(index = 0): Locator {
    return this.modal().locator('textarea').nth(index);
  }

  async fillNote(note: string, index = 0): Promise<void> {
    const field = this.noteField(index);
    await field.click();
    await field.fill(note);
  }

  /** Picks a Behandlungsart. Defaults to the first option, matching the old `radio.first()` calls. */
  async chooseBehandlungsart(kind: (typeof DokuModalPage.TREATMENT_KINDS)[number] | 'first' = 'first'): Promise<void> {
    if (kind === 'first') {
      await this.page.getByRole('radio').first().click();
      return;
    }
    await this.page.getByRole('radio').filter({ hasText: kind }).first().click();
  }

  /** Ticks "Patient:in hat die Behandlung verweigert". */
  async markRefused(): Promise<void> {
    await this.modal().locator('[role="checkbox"]').first().click({ force: true });
  }

  /** Copies the previous documentation into the note field. */
  async useLastNote(): Promise<void> {
    // Copying the previous documentation fetches it; settle on that request.
    await settleAfter(
      this.page,
      () => this.modal().getByText('Letzte Doku übernehmen', { exact: true }).click(),
      { budgetMs: 10_000 },
    );
  }

  // ───────────────────────── multi-patient entries ──────────────────────────

  /** The chevron glyphs an entry's toggle renders: collapsed vs expanded. */
  private static readonly COLLAPSED_GLYPH = '\u{F0140}';
  private static readonly EXPANDED_GLYPH = '\u{F0143}';

  /**
   * Expands one entry in the modal by its title (a patient name, or an activity type like "Pause").
   *
   * With more than one patient selected every entry ships COLLAPSED — there are no note fields at all
   * until each is opened — so a multi-patient save has to expand each one first. A SINGLE selected
   * patient, by contrast, ships already expanded, so this is idempotent: it only clicks when the
   * toggle shows the collapsed chevron, otherwise a call would close the entry it was asked to open.
   *
   * The toggle is a button whose `aria-label` is the entry's own title.
   */
  async expandEntry(title: string): Promise<boolean> {
    const toggle = this.modal().getByRole('button', { name: title, exact: true });
    if (!(await toggle.count())) return false;
    const glyph = ((await toggle.first().innerText().catch(() => '')) || '').trim();
    if (glyph === DokuModalPage.EXPANDED_GLYPH) return true; // already open
    await toggle.first().click({ force: true });
    // Expanding reveals this entry's note field, which is exactly what the caller goes on to fill.
    await this.modal()
      .getByPlaceholder('Doku eingeben')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => {});
    return true;
  }

  /**
   * Opens every collapsed entry in the modal.
   *
   * Driven off the collapsed chevron rather than off entry titles: the titles have to be read before
   * anything is clicked, and each expansion re-renders the list, so a title-driven loop is racy.
   * Repeats until no collapsed toggle is left (bounded, so a non-collapsing entry can't spin).
   */
  async expandAllEntries(): Promise<number> {
    for (let round = 0; round < 12; round++) {
      const collapsed = this.modal()
        .locator('button[aria-label]')
        .filter({ hasText: DokuModalPage.COLLAPSED_GLYPH });
      const before = await collapsed.count();
      if (before === 0) break;
      await collapsed.first().click({ force: true });
      // Expanding an entry removes it from the collapsed set, so that count dropping is the
      // completion signal - and it is reached in ~100 ms rather than the flat 1.2 s this paid on
      // every one of up to 12 rounds.
      await expect
        .poll(() => collapsed.count(), { timeout: 5_000, intervals: [100, 150, 250, 400] })
        .toBeLessThan(before)
        .catch(() => {});
    }
    return await this.noteFieldCount();
  }

  /** The patient entries the modal holds, in order — one per selected row. */
  async entryTitles(): Promise<string[]> {
    return await this.modal()
      .locator('button[aria-label]')
      .evaluateAll((els) =>
        els
          .map((e) => e.getAttribute('aria-label') || '')
          .filter((l) => l && !/^(Entfernen|Abbrechen|Speichern|Aktivität|Datum der Behandlung)/.test(l)),
      );
  }

  /** How many note fields are currently revealed (one per expanded patient entry). */
  async noteFieldCount(): Promise<number> {
    return await this.modal().locator('textarea').count();
  }

  /** Expands every patient entry and fills each one's note with the same text. */
  async fillNoteForEveryPatient(note: string): Promise<number> {
    await this.expandAllEntries();
    const fields = this.modal().locator('textarea');
    const count = await fields.count();
    for (let i = 0; i < count; i++) {
      await fields.nth(i).click();
      await fields.nth(i).fill(note);
    }
    return count;
  }

  // ──────────────────────────── activity entries ────────────────────────────

  /**
   * Adds an activity entry via the "Aktivität" control.
   *
   * This no longer opens a picker: it appends an entry that defaults to type "Pause", which then
   * needs a duration ("Dauer (Minuten) *") before the modal will save.
   */
  async addActivity(): Promise<void> {
    await this.modal().getByRole('button', { name: 'Aktivität', exact: true }).click();
    // The appended entry defaults to type "Pause" and requires a duration; that field appearing is
    // the signal the entry actually landed.
    await this.modal()
      .getByPlaceholder('In Minuten')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => {});
  }

  /** Sets the expanded activity entry's duration in minutes. */
  async setActivityDuration(minutes: number): Promise<void> {
    const field = this.modal().getByPlaceholder('In Minuten').first();
    await field.click();
    await field.fill(String(minutes));
    await this.page.waitForTimeout(800);
  }

  saveButton(): Locator {
    return this.page.getByRole('button', { name: 'Speichern', exact: true });
  }

  /** True while the modal refuses to save — the required-field gate. */
  async isSaveBlocked(): Promise<boolean> {
    return await this.saveButton().isDisabled().catch(() => true);
  }

  /** The request a real save fires. Nothing at all is sent when the save is silently blocked. */
  static readonly SAVE_ENDPOINT = /\/activities\/bulk/;

  /**
   * Saves and reports which of three things happened.
   *
   * - **`saved`** — `POST /activities/bulk` went out and the modal closed.
   * - **`conflict`** — the modal stayed open and said why.
   * - **`rejected`** — the request went out and came back 4xx/5xx, but the modal shows nothing.
   * - **`blocked`** — the modal stayed open, every required field is satisfied, and **no request was
   *   fired at all**. This is what a repeat save does: documenting a patient who already has an
   *   activity for the chosen date is refused entirely client-side, silently.
   *
   * Both `rejected` and `blocked` are silent-failure paths with no user feedback — see the `fixme`'d
   * defect test in `document_treatment.spec.ts`. These specs are non-idempotent by construction (they
   * document the same rows on every run), so callers accept those outcomes rather than failing on
   * them; the classification is what keeps the distinction visible in the log.
   */
  async save(): Promise<'saved' | 'conflict' | 'rejected' | 'blocked'> {
    await expect(this.saveButton(), '"Speichern" must enable once the note is filled').toBeEnabled({
      timeout: 15_000,
    });

    let requested = false;
    let failedStatus: number | null = null;
    const onRequest = (req: { method(): string; url(): string }) => {
      if (req.method() === 'POST' && DokuModalPage.SAVE_ENDPOINT.test(req.url())) requested = true;
    };
    const onResponse = (res: { url(): string; status(): number }) => {
      if (DokuModalPage.SAVE_ENDPOINT.test(res.url()) && res.status() >= 400) failedStatus = res.status();
    };
    this.page.on('request', onRequest);
    this.page.on('response', onResponse);
    try {
      await this.saveButton().click();
      const outcome = await this.awaitSaveOutcome(
        () => requested,
        () => failedStatus,
      );
      if (failedStatus !== null) console.log(`save request failed with HTTP ${failedStatus}`);
      return outcome;
    } finally {
      this.page.off('request', onRequest);
      this.page.off('response', onResponse);
    }
  }

  private async awaitSaveOutcome(
    requested: () => boolean,
    failedStatus: () => number | null,
  ): Promise<'saved' | 'conflict' | 'rejected' | 'blocked'> {

    // Waited manually rather than with expect.poll so the failure can quote what the modal actually
    // says — a refused save that matches none of the known conflict strings is otherwise a bare
    // timeout with nothing to diagnose.
    const conflict = this.page
      .getByText(/bereits erfasst|Validation failed|Conflicting activity|konnte nicht|fehlgeschlagen/i)
      .first();
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (await this.isModalGone()) return 'saved';
      if (await conflict.isVisible().catch(() => false)) return 'conflict';
      // The server refused it and the modal says nothing about it.
      if (failedStatus() !== null) return 'rejected';
      // No request went out, the modal is still up, and nothing is flagged as missing: the save was
      // dropped on the floor. Give it a few seconds in case the click was simply slow to dispatch.
      if (!requested() && Date.now() > deadline - 35_000) {
        const text = ((await this.modal().innerText().catch(() => '')) || '');
        if (!/erforderlichen Felder|Please fill|Please set/i.test(text)) return 'blocked';
      }
      await this.page.waitForTimeout(1000);
    }
    const text = ((await this.modal().innerText().catch(() => '')) || '').replace(/\n/g, ' | ');
    throw new Error(
      `the Doku modal neither closed nor reported a recognised conflict within 45s. Modal reads: ${text}`,
    );
  }

  /** Documents a treatment end to end: note, Behandlungsart, save. */
  async documentTreatment(
    note: string,
    kind: (typeof DokuModalPage.TREATMENT_KINDS)[number] | 'first' = 'first',
  ): Promise<'saved' | 'conflict' | 'rejected' | 'blocked'> {
    await this.fillNote(note);
    await this.chooseBehandlungsart(kind);
    return await this.save();
  }

  async cancel(): Promise<void> {
    const cancel = this.page.getByRole('button', { name: 'Abbrechen', exact: true });
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    else await this.page.keyboard.press('Escape').catch(() => {});
    await expect(this.modal()).toBeHidden({ timeout: 15_000 });
  }
}
