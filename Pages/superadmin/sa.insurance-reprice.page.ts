import { Page, expect } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';

/**
 * Correcting a VO's Versicherungsart between PKV and Privat Basis (RC 3.12 #3535).
 *
 * The ticket has two halves that live in different places and deploy independently, so this page
 * object addresses both:
 *
 * | half | surface |
 * |---|---|
 * | the confirmation (AC3–AC6) | the VO edit form's Versicherungsart dropdown at `/vo-management/{id}/edit` |
 * | the repricing (AC1/AC2)    | `ActivityTreatment.resolvedTariff` — the per-session price snapshot |
 *
 * **`resolvedTariff` is the surface, and that is not an assumption.** It is the same column
 * #3378's retroactive recompute rewrites, and `repriceControl()` re-proves that live in every run:
 * a price entry with a past effective date moves those very rows and its deletion moves them back.
 * Nothing else on the VO is a per-session price — `totalRevenue` is *computed* and moves for a
 * reason that has nothing to do with this ticket (see below).
 *
 * **The trap that makes a false PASS easy.** The form's "Gesamtumsatz (Automatisch)" DOES change
 * when the insurance type is corrected, so the ticket's own QA step ("check the VO's
 * Behandlungsdetails or Preis view before and after") reports a change even when no session was
 * repriced. The reason is that a VO's revenue is `Σ resolvedTariff of the treatment lines` plus a
 * LIVE calculation of the per-treatment/one-time fee lines, and only the fee half follows the
 * VO's current insurance type. On the fixture below, PKV → Privat Basis moves the total 257,85 →
 * 224,65 while all three PNF sessions stay on the PKV tariff 61,95; full repricing would give
 * 178,33. Read the rows, never the total.
 *
 * **Insurance types.** The enum is `public` (GKV) / `private` (PKV) / `privat_basis` (Privat Basis)
 * / `accident` (UV/BG); the tariff types prices are keyed by are `GKV` / `PRIVAT` / `PRIVAT_BASIS`
 * / `BG` / `BEIHILFE`. Staging holds 24,137 `public`, 1,296 `private`, 31 `accident` and just
 * **4** `privat_basis` VOs, which is why the Privat-Basis-first direction (AC2) has exactly one
 * usable fixture.
 *
 * **Why the price history matters for AC1's "not today's date".** `PRIVAT` carries one flat entry
 * effective 2025-01-01 per treatment, while `PRIVAT_BASIS` carries a quarterly ladder
 * (2025-01-01 / 04-01 / 07-01 / 10-01 / 2026-01-01) at different prices. A fixture whose sessions
 * straddle one of those dates is what separates "repriced at each session's own date" from
 * "repriced at today's price" — `expectedTariff()` resolves the former.
 *
 * **Traps in driving the form.**
 * - The dropdown is not addressable by role. It is the first `div[tabindex="0"]` FOLLOWING the
 *   "Versicherungsart *" label, and its options are the usual `[data-testid*="flatlist"]` rows.
 * - The reprice dialog has **no `role="dialog"` and no `aria-modal`** — a `[role="dialog"]` query
 *   returns nothing and reads as "no dialog appeared". It is found by its text.
 * - Its buttons are **"Abbrechen" / "Ja"**, not Bestätigen/OK.
 * - **"Speichern" is inert whenever a creation-validation check has not auto-passed** — the
 *   already-recorded #3340 defect. It POSTs `check-creation-validation` and, short of `allPassed`,
 *   sends nothing and shows nothing. The SAME VO has gone both ways between runs here, so neither
 *   path may be assumed: `trySaveDirect()` reports whether anything was sent and callers fall back
 *   to `saveViaForFixing()`, which raises "Speichern bestätigen — Zur Prüfung — N bestanden, M
 *   nicht bestanden" and must then be confirmed. That route writes
 *   `creationValidationStatus: 'for_fixing'`, which the caller must restore.
 * - Navigating from one `/vo-management/{id}/edit` to another inside the same page does not
 *   remount the form; `openVoForm()` is written to be called once per test.
 */

/** VO insurance types, as the API stores them. */
export const INSURANCE = {
  GKV: 'public',
  PKV: 'private',
  PRIVAT_BASIS: 'privat_basis',
  BG: 'accident',
} as const;

/** The dropdown's German labels, keyed by the stored value. */
export const INSURANCE_LABEL: Record<string, string> = {
  public: 'GKV',
  private: 'PKV',
  privat_basis: 'Privat Basis',
  accident: 'BG',
};

/** Which tariff column a VO's prices resolve from. */
export const TARIFF_FOR_INSURANCE: Record<string, string> = {
  public: 'GKV',
  private: 'PRIVAT',
  privat_basis: 'PRIVAT_BASIS',
  accident: 'BG',
};

export type SessionRow = {
  /** `ActivityTreatment` id — the row that carries the price snapshot. */
  activityTreatmentId: number;
  activityId: number;
  /** `YYYY-MM-DD`; the date the repricing must resolve against. */
  date: string;
  code: string;
  kind: string;
  /** The snapshotted price. `null` rows resolve dynamically and are never stale. */
  resolvedTariff: number | null;
};

export type VoSnapshot = {
  id: number;
  vo: string;
  insuranceType: string | null;
  treatmentStatus: string | null;
  /** The form's "Gesamtumsatz (Automatisch)" — computed, see the class docs. */
  totalRevenue: number | null;
  /** What the dialog counts (AC5); it is `activityCount`, not the documented-session count. */
  activityCount: number;
  activeInvoice: { number: string; status: string } | null;
  cancelledInvoiceCount: number;
  creationValidationStatus: string | null;
  rows: SessionRow[];
};

export type PriceEntry = { id: number; tariffType: string; effectiveDate: string; price: number };

export class InsuranceReprisePage {
  static readonly API = 'https://api.staging.therapios.de';
  static readonly DIALOG_TITLE = 'Behandlungen neu bepreisen?';
  static readonly CONFIRM = 'Ja';
  static readonly CANCEL = 'Abbrechen';
  static readonly SAVE = 'Speichern';
  static readonly SAVE_FOR_FIXING = 'Zur Korrektur speichern';
  static readonly SAVE_CONFIRM_TITLE = 'Speichern bestätigen';

  private token: string | null = null;

  constructor(private page: Page) {}

  // ──────────────────────────────── sessions ─────────────────────────────────

  /** API-only entry: a bearer token, tolerating a spent `.auth` storageState. */
  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
    this.token = await apiBearerToken(this.page, { credentials });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private auth() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${InsuranceReprisePage.API}${path}`, {
      headers: this.auth(),
      timeout: 120_000,
    });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ────────────────────────────────── API ────────────────────────────────────

  /**
   * Everything a repricing assertion needs about one VO, in one call.
   *
   * The sessions are read activity-first because `activity_treatments` cannot be filtered by
   * prescription date or ordered; the ids that come back are stable and are what the assertions
   * are keyed on.
   */
  async snapshot(prescriptionId: number): Promise<VoSnapshot> {
    const p = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    const activities = InsuranceReprisePage.members(
      await this.json(`/activities?page=1&itemsPerPage=100&prescription=${prescriptionId}&order%5Bdate%5D=asc`),
    );
    const rows: SessionRow[] = [];
    for (const activity of activities) {
      for (const at of activity.activityTreatments ?? []) {
        rows.push({
          // The EMBEDDED ActivityTreatment carries `@id` but no bare `id`, unlike the same resource
          // fetched on its own — so `at.id` is `undefined` here and every row would collapse onto one
          // key, silently comparing a PNF row against an HBH-PT one. Take the id from the IRI.
          activityTreatmentId: at.id ?? Number(String(at['@id'] ?? '').split('/').pop()),
          activityId: activity.id,
          date: String(activity.date ?? '').slice(0, 10),
          code: at.treatment?.code ?? '?',
          kind: at.treatment?.kind ?? '?',
          resolvedTariff: at.resolvedTariff ?? null,
        });
      }
    }
    rows.sort((a, b) => a.activityTreatmentId - b.activityTreatmentId);
    return {
      id: p.id,
      vo: p.prescriptionId,
      insuranceType: p.insuranceType ?? null,
      treatmentStatus: p.treatmentStatus ?? null,
      totalRevenue: p.totalRevenue ?? null,
      // `invoice` IS `getActiveInvoice()` server-side — cancelled invoices and Stornos are excluded
      // from it, which is exactly AC3's "non-cancelled invoice".
      activityCount: p.activityCount ?? 0,
      activeInvoice: p.invoice ? { number: p.invoice.invoiceNumber, status: p.invoice.status } : null,
      cancelledInvoiceCount: Array.isArray(p.cancelledInvoices) ? p.cancelledInvoices.length : 0,
      creationValidationStatus: p.creationValidationStatus ?? null,
      rows,
    };
  }

  /** The rows whose snapshot differs between two snapshots of the same VO, keyed by row id. */
  static repricedRows(before: VoSnapshot, after: VoSnapshot) {
    const previous = new Map(before.rows.map((r) => [r.activityTreatmentId, r]));
    return after.rows
      .map((r) => ({ ...r, from: previous.get(r.activityTreatmentId)?.resolvedTariff ?? null }))
      .filter((r) => r.from !== r.resolvedTariff);
  }

  /** Sessions that carry a price snapshot — the rows AC1/AC2 are about. */
  static pricedRows(snapshot: VoSnapshot): SessionRow[] {
    return snapshot.rows.filter((r) => r.resolvedTariff !== null);
  }

  /**
   * Writes the corrected insurance type the way the form's Save does — a merge-patch on the
   * prescription, which is the only write path for this field.
   */
  async setInsuranceType(prescriptionId: number, insuranceType: string): Promise<number> {
    const res = await this.page.request.patch(`${InsuranceReprisePage.API}/prescriptions/${prescriptionId}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/merge-patch+json' },
      data: { insuranceType },
      timeout: 120_000,
    });
    return res.status();
  }

  /** Restores a VO's stored `creationValidationStatus`, which a form save overwrites. */
  async setCreationValidationStatus(prescriptionId: number, status: string | null): Promise<number> {
    const res = await this.page.request.patch(`${InsuranceReprisePage.API}/prescriptions/${prescriptionId}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/merge-patch+json' },
      data: { creationValidationStatus: status },
      timeout: 120_000,
    });
    return res.status();
  }

  /** Every price entry of one treatment code, newest effective date first. */
  async priceHistory(code: string): Promise<PriceEntry[]> {
    const treatments = InsuranceReprisePage.members(
      await this.json(`/treatments?page=1&itemsPerPage=10&code=${encodeURIComponent(code)}`),
    );
    const treatment = treatments.find((t: any) => t.code === code);
    expect(treatment, `treatment ${code} must exist on this environment`).toBeTruthy();
    const body = await this.json(
      `/treatment_price_histories?page=1&itemsPerPage=100&treatment=${treatment.id}&order%5BeffectiveDate%5D=desc`,
    );
    return InsuranceReprisePage.members(body).map((e: any) => ({
      id: e.id,
      tariffType: e.tariffType,
      effectiveDate: String(e.effectiveDate).slice(0, 10),
      price: e.price,
    }));
  }

  /**
   * AC1/AC2's expected price: the latest entry of that tariff type already effective **on the
   * session's own date**, never today's.
   */
  async expectedTariff(code: string, insuranceType: string, date: string): Promise<number | null> {
    const tariffType = TARIFF_FOR_INSURANCE[insuranceType];
    const applicable = (await this.priceHistory(code))
      .filter((e) => e.tariffType === tariffType && e.effectiveDate <= date)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    if (applicable.length) return applicable[0].price;

    // No history entry for that tariff type: the resolver falls through to the Treatment's own
    // tariff COLUMN (its level 3), so this must too. Returning null here reads as "no expectation"
    // and fails against a legitimately-zero fee — AB-P has no PRIVAT history row and prices at
    // 0,00 under PKV, which is exactly the shape that caught this.
    return await this.tariffColumn(code, tariffType);
  }

  /** The Treatment entity's own tariff column for one tariff type — the resolver's last resort. */
  async tariffColumn(code: string, tariffType: string): Promise<number | null> {
    const treatments = InsuranceReprisePage.members(
      await this.json(`/treatments?page=1&itemsPerPage=10&code=${encodeURIComponent(code)}`),
    );
    const treatment = treatments.find((t: any) => t.code === code);
    if (!treatment) return null;
    const column: Record<string, string> = {
      GKV: 'tariffGkv',
      PRIVAT: 'tariffPrivat',
      PRIVAT_BASIS: 'tariffPrivatBasis',
      BG: 'tariffBg',
      BEIHILFE: 'tariffBeihilfe',
    };
    return treatment[column[tariffType] ?? ''] ?? null;
  }

  /**
   * The control for the whole file: proves `ActivityTreatment.resolvedTariff` is both the right
   * surface and writable by the recalculator **on this environment, in this run**.
   *
   * Creates a price entry with a past effective date, reports how many snapshots it moved, then
   * deletes it — the delete recomputes the same rows back, which is what makes it self-restoring
   * (#3378 AC3). Callers should pick a `price` a cent away from the standing one so the change is
   * unambiguous and the blast radius is a rounding difference for the seconds it exists.
   */
  async repriceControl(input: {
    code: string;
    tariffType: string;
    effectiveDate: string;
    price: number;
  }): Promise<{ created: number; deleted: number; entryId: number | null }> {
    const treatments = InsuranceReprisePage.members(
      await this.json(`/treatments?page=1&itemsPerPage=10&code=${encodeURIComponent(input.code)}`),
    );
    const treatment = treatments.find((t: any) => t.code === input.code);
    expect(treatment, `treatment ${input.code} must exist`).toBeTruthy();

    const post = await this.page.request.post(`${InsuranceReprisePage.API}/treatment_price_histories`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/ld+json' },
      data: {
        treatment: `/treatments/${treatment.id}`,
        tariffType: input.tariffType,
        effectiveDate: input.effectiveDate,
        price: input.price,
      },
      timeout: 120_000,
    });
    expect(post.status(), 'POST /treatment_price_histories').toBe(201);
    const entry = await post.json();
    return { created: entry.retroactiveTreatmentsUpdated ?? 0, deleted: -1, entryId: entry.id ?? null };
  }

  /** Deletes a control entry and reports how many snapshots the delete recomputed back. */
  async deletePriceEntry(entryId: number): Promise<number> {
    const res = await this.page.request.delete(`${InsuranceReprisePage.API}/treatment_price_histories/${entryId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 120_000,
    });
    expect(res.status(), `DELETE /treatment_price_histories/${entryId}`).toBe(200);
    return (await res.json())?.retroactiveTreatmentsUpdated ?? 0;
  }

  // ────────────────────────────────── the form ───────────────────────────────

  /**
   * Opens the VO edit form with a session the app can actually boot with.
   *
   * Call once per test: a second `goto` to another VO's edit URL does not remount the form.
   */
  async openVoForm(prescriptionId: number, credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = await mintUiSession(this.page, credentials);
    await this.page.setViewportSize({ width: 1600, height: 1100 });
    await this.page.goto(`/vo-management/${prescriptionId}/edit?id=${prescriptionId}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(this.insuranceLabel(), 'the VO edit form must render its Versicherungsart field').toBeVisible({
      timeout: 60_000,
    });
    // The form paints its labels before the values arrive; wait for the dropdown to hold one.
    await expect
      .poll(async () => (await this.insuranceTrigger().innerText()).trim(), { timeout: 30_000, intervals: [500] })
      .not.toBe('');
  }

  private insuranceLabel() {
    return this.page.getByText(/^Versicherungsart ?\*?$/).first();
  }

  private insuranceTrigger() {
    return this.insuranceLabel().locator('xpath=following::div[@tabindex="0"][1]');
  }

  /** The label currently shown in the Versicherungsart dropdown ("PKV", "Privat Basis", …). */
  async insuranceValue(): Promise<string> {
    return (await this.insuranceTrigger().innerText()).trim();
  }

  /** The form's "Gesamtumsatz (Automatisch)" figure, as printed ("€257.85"). */
  async gesamtumsatz(): Promise<string> {
    return (
      await this.page.getByText(/Gesamtumsatz/).first().locator('xpath=following::*[1]').innerText()
    ).trim();
  }

  /** Opens the dropdown and returns the option labels it offers. */
  async insuranceOptions(): Promise<string[]> {
    await this.insuranceTrigger().click();
    const list = this.page.locator('[data-testid*="flatlist"]').first();
    await list.waitFor({ state: 'visible', timeout: 20_000 });
    const text = await list.innerText();
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Picks an option from the (already open, or not) Versicherungsart dropdown. */
  async chooseInsurance(label: string): Promise<void> {
    const list = this.page.locator('[data-testid*="flatlist"]').first();
    if (!(await list.isVisible().catch(() => false))) await this.insuranceTrigger().click();
    await list.waitFor({ state: 'visible', timeout: 20_000 });
    await list.getByText(label, { exact: true }).first().click();
  }

  /**
   * The reprice confirmation, or `null` when none appeared.
   *
   * Read out of the body text on purpose — the dialog carries **no `role="dialog"` and no
   * `aria-modal`**, so a role query finds nothing and would read as "the dialog is missing".
   * Polls, because the dialog mounts a beat after the option is picked.
   */
  async repriceDialog(timeoutMs = 8_000): Promise<{ message: string; count: number; from: string; to: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const body = await this.page.evaluate(() => document.body.innerText);
      const index = body.indexOf(InsuranceReprisePage.DIALOG_TITLE);
      if (index >= 0) {
        const message = body.slice(index, index + 400).split('\n')[1] ?? '';
        const count = Number(message.match(/(\d+)\s+bereits dokumentierte/)?.[1] ?? NaN);
        // The two type names are in GERMAN quotes — „…“ (U+201E / U+201C), not the „…” pair a
        // naive class guesses at. Pull every quoted run instead of pinning one closing character.
        const quoted = [...message.matchAll(/[„"']([^„“”"']+)[“”"']/g)].map((m) => m[1].trim());
        return { message, count, from: quoted[0] ?? '', to: quoted[1] ?? '' };
      }
      await this.page.waitForTimeout(400);
    }
    return null;
  }

  /** Confirms the reprice dialog ("Ja"). */
  async confirmReprice(): Promise<void> {
    await this.clickable(InsuranceReprisePage.CONFIRM).click({ timeout: 20_000 });
    await this.page.waitForTimeout(1_000);
  }

  /** Dismisses the reprice dialog ("Abbrechen") — the field must keep its old value. */
  async cancelReprice(): Promise<void> {
    await this.clickable(InsuranceReprisePage.CANCEL).click({ timeout: 20_000 });
    await this.page.waitForTimeout(1_000);
  }

  private clickable(label: string) {
    return this.page
      .locator('div[tabindex="0"], [role="button"], button')
      .filter({ hasText: new RegExp(`^${label}$`) })
      .last();
  }

  /**
   * The save that actually persists on staging.
   *
   * "Speichern" runs the creation validation first and sends **nothing** unless every check
   * auto-passed (#3340), which is the minority case here; "Zur Korrektur speichern" raises a
   * "Speichern bestätigen" dialog that, once confirmed, PATCHes the whole form payload. Returns
   * the PATCH status, or `null` when no request was made — which is itself the assertion for the
   * inert-Speichern case.
   *
   * Side effect: it writes `creationValidationStatus: 'for_fixing'`. Restore it.
   */
  async saveViaForFixing(): Promise<{ status: number | null; sentInsuranceType: string | null }> {
    let status: number | null = null;
    let sent: string | null = null;
    const listener = async (response: any) => {
      const request = response.request();
      if (request.method() === 'PATCH' && /\/prescriptions\/\d+$/.test(response.url())) {
        status = response.status();
        try {
          sent = JSON.parse(request.postData() || '{}').insuranceType ?? null;
        } catch {
          /* the status alone answers "did the form save" */
        }
      }
    };
    this.page.on('response', listener);
    try {
      const button = this.clickable(InsuranceReprisePage.SAVE_FOR_FIXING);
      // `actionTimeout` is 0 project-wide, so an unbounded scrollIntoViewIfNeeded() on a button
      // that never renders waits for the WHOLE test budget and then blames a line number. A VO
      // whose creation-validation checks all pass offers only "Speichern" — no For-Fixing button
      // exists to scroll to — which is exactly how this hung for 420 s.
      //
      // Absence is a legitimate outcome, not an error: `trySaveDirect()` can report "nothing sent"
      // simply because its listener window closed early under load, and the direct save may have
      // landed anyway. Report it and let the caller confirm against the API, which is the source of
      // truth either way.
      if (0 === (await button.count())) return { status: null, sentInsuranceType: null };
      await button.scrollIntoViewIfNeeded({ timeout: 20_000 });
      await button.click({ timeout: 20_000 });
      await expect(
        this.page.getByText(InsuranceReprisePage.SAVE_CONFIRM_TITLE).first(),
        'the save must raise its own confirmation',
      ).toBeVisible({ timeout: 30_000 });
      await this.clickable(InsuranceReprisePage.SAVE).click({ timeout: 20_000 });
      await expect
        .poll(() => status, { timeout: 60_000, intervals: [1_000] })
        .not.toBeNull();
    } finally {
      this.page.off('response', listener);
    }
    return { status, sentInsuranceType: sent };
  }

  /**
   * Clicks "Speichern" and reports whether it sent anything. Used to pin the #3340 interaction:
   * on a VO with a non-auto-passing check it POSTs `check-creation-validation` and stops there.
   */
  async trySaveDirect(waitMs = 12_000): Promise<{ patched: boolean; checkedValidation: boolean }> {
    let patched = false;
    let checkedValidation = false;
    const listener = (request: any) => {
      if (request.method() === 'PATCH' && /\/prescriptions\/\d+$/.test(request.url())) patched = true;
      if (request.url().includes('check-creation-validation')) checkedValidation = true;
    };
    this.page.on('request', listener);
    try {
      const button = this.clickable(InsuranceReprisePage.SAVE);
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 20_000 });
      await this.page.waitForTimeout(waitMs);
    } finally {
      this.page.off('request', listener);
    }
    return { patched, checkedValidation };
  }
}
