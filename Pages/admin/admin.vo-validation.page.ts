import { Page, expect } from '@playwright/test';

/**
 * The VO edit form's Validierung panel — RC 3.11 #3339 (Home Visit check vs. the Hausbesuch toggle).
 *
 * Surfaces, all verified live on staging:
 *  - **Form:** `/vo-management/{id}/edit?id={id}`, reached from the Admin Board by clicking a VO
 *    number. Holds the Hausbesuch switch and, at the bottom, the Validierung panel: a summary line
 *    ("13 automatisch bestanden · 2 fehlgeschlagen"), a FEHLGESCHLAGEN list of the failing checks,
 *    and an "Alle Prüfungen anzeigen" expander for the rest.
 *  - **`GET /validations?timing=vo_creation&prescription=/prescriptions/{id}`** — which checks apply
 *    to this VO. The Home Visit check is **id 50, `home_visit_expected_for_care_facility`** (not id 3
 *    `home_visit_marked`, which is a billing-timing check with a similar name).
 *  - **`GET /prescription_validations?prescription=/prescriptions/{id}`** — the stored pass/fail per
 *    check, as `{validation: "/validations/50", passed: boolean}`.
 *
 * The facility this check is about is the VO's **`elderlyCareHome`** ("Einrichtung"), not `entity`
 * ("Gesellschaft") — the two are different fields and every VO has an entity.
 *
 * Read-only: nothing here saves the form or triggers a re-check.
 */

/** The two save buttons on the VO edit form (#3340). */
export const SAVE_FOR_FIXING = 'Zur Korrektur speichern';
export const SAVE_VALIDATE = 'Speichern';

/** `home_visit_expected_for_care_facility` — the check this ticket is about. */
export const HOME_VISIT_CHECK_ID = 50;

/** The failure message, as it renders in German on staging. */
export const HOME_VISIT_FAILURE_MESSAGE =
  'Der Patient ist in einer Einrichtung, aber Hausbesuch ist nicht ausgewählt.';

export type VoShape = {
  id: number;
  number: string;
  homeVisit: boolean | null;
  careFacility: string | null;
  treatmentCodes: string[];
  status: string;
  /** Set once a VO has been through creation validation — a good hint that check rows exist. */
  creationValidationStatus: string | null;
  /** True when an admin set the validation verdict by hand; such VOs draw "manuell" per check. */
  validationManuallySet: boolean;
  /** True when a Home Visit Heilmittel (HBH-*) is prescribed. */
  homeVisitRemedy: boolean;
};

export class VoValidationPage {
  static readonly API = 'https://api.staging.therapios.de';

  /** Status glyphs the expanded check list draws (an icon font, not text). */
  static readonly GLYPH_PASSED = '\u{F012C}';
  static readonly GLYPH_FAILED = '\u{F0156}';
  static readonly GLYPH_MANUAL = '\u{F06D0}';

  private token: string | null = null;

  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(6000);
    this.token = await this.page.evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '');
        return state.token || state.accessToken || state.access_token || null;
      } catch {
        return null;
      }
    });
    expect(this.token, 'the session must carry a bearer token').toBeTruthy();
  }

  private async json(path: string): Promise<any> {
    const res = await this.page.request.get(`${VoValidationPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
    });
    expect(res.status(), `GET ${path}`).toBe(200);
    return await res.json();
  }

  // ──────────────────────────────── VO lookup ────────────────────────────────

  static shape(row: any): VoShape {
    const codes = (row.treatmentCodes ?? []).map((c: any) => String(c.code));
    return {
      id: row.id,
      number: row.prescriptionId,
      homeVisit: row.homeVisit ?? null,
      careFacility: row.elderlyCareHome?.name ?? (typeof row.elderlyCareHome === 'string' ? row.elderlyCareHome : null),
      treatmentCodes: codes,
      status: row.treatmentStatus,
      creationValidationStatus: row.creationValidationStatus ?? null,
      validationManuallySet: row.creationValidationStatusManuallySet === true,
      homeVisitRemedy: codes.some((code: string) => code.startsWith('HBH-')),
    };
  }

  async voByNumber(number: string): Promise<VoShape | null> {
    const body = await this.json(`/prescriptions?page=1&itemsPerPage=5&prescriptionId=${encodeURIComponent(number)}`);
    const row = (body.member ?? []).find((m: any) => m.prescriptionId === number);
    return row ? VoValidationPage.shape(row) : null;
  }

  /** Full detail — the collection response omits `elderlyCareHome` on some rows. */
  async voById(id: number): Promise<VoShape> {
    return VoValidationPage.shape(await this.json(`/prescriptions/${id}`));
  }

  /** The stored pass/fail of one check, or null when it has never been evaluated for this VO. */
  async checkResult(prescriptionId: number, validationId = HOME_VISIT_CHECK_ID): Promise<boolean | null> {
    const body = await this.json(
      `/prescription_validations?pagination=false&prescription=%2Fprescriptions%2F${prescriptionId}`,
    );
    const row = (body.member ?? []).find((m: any) => m.validation === `/validations/${validationId}`);
    return row ? row.passed : null;
  }

  /** The check ids that apply to a VO at creation timing. */
  async applicableChecks(prescriptionId: number): Promise<number[]> {
    const body = await this.json(
      `/validations?pagination=false&timing=vo_creation&prescription=%2Fprescriptions%2F${prescriptionId}`,
    );
    return (body.member ?? []).map((m: any) => m.id);
  }

  /**
   * Non-closed VOs, sampled across `pageNumbers` pages of 100.
   *
   * `homeVisit`, treatment-code and facility filters are all ignored by the API (they return the
   * full 34k collection), so the population #3339 defines has to be assembled client-side. Only
   * `exclude[treatmentStatus]` actually filters.
   */
  async samplePopulation(pageNumbers: number[]): Promise<{ total: number; pages: number; rows: VoShape[] }> {
    const exclude =
      'exclude%5BtreatmentStatus%5D%5B%5D=Archiviert' +
      '&exclude%5BtreatmentStatus%5D%5B%5D=Abgerechnet' +
      '&exclude%5BtreatmentStatus%5D%5B%5D=Abgebrochen';
    const first = await this.json(`/prescriptions?page=1&itemsPerPage=100&${exclude}`);
    const total = first.totalItems ?? 0;
    const pages = Math.max(1, Math.ceil(total / 100));
    const rows: VoShape[] = [];
    for (const pageNumber of pageNumbers) {
      const target = Math.min(pageNumber, pages);
      const body = target === 1 ? first : await this.json(`/prescriptions?page=${target}&itemsPerPage=100&${exclude}`);
      for (const row of body.member ?? []) rows.push(VoValidationPage.shape(row));
    }
    return { total, pages, rows };
  }

  /**
   * The creation-validation state #3340 protects.
   *
   * `manuallySet` is the marker the fix introduced: with it set, the automatic recompute is skipped in
   * both directions. Note that **PATCHing `creationValidationStatus` sets the marker to true by
   * itself**, and PATCHing the status back to `null` clears it — which is what makes a round trip here
   * fully restorable.
   */
  async validationState(prescriptionId: number): Promise<{
    number: string;
    status: string | null;
    manuallySet: boolean;
    actionRequired: boolean;
    failing: number;
    evaluated: number;
  }> {
    const row = await this.json(`/prescriptions/${prescriptionId}`);
    const results = await this.json(
      `/prescription_validations?pagination=false&prescription=%2Fprescriptions%2F${prescriptionId}`,
    );
    const rows = results.member ?? [];
    return {
      number: row.prescriptionId,
      status: row.creationValidationStatus ?? null,
      manuallySet: row.creationValidationStatusManuallySet === true,
      actionRequired: row.actionRequired === true,
      failing: rows.filter((r: any) => r.passed === false).length,
      evaluated: rows.length,
    };
  }

  /** PATCHes a prescription; returns the HTTP status so callers can assert on it. */
  async patch(prescriptionId: number, data: Record<string, unknown>): Promise<number> {
    const res = await this.page.request.patch(`${VoValidationPage.API}/prescriptions/${prescriptionId}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/merge-patch+json' },
      data,
      timeout: 60_000,
    });
    return res.status();
  }

  /**
   * Forces the post-save recompute to run again without touching clinical data.
   *
   * `actionRequired` is a plain boolean flag on the VO, so flipping it produces a real Doctrine flush
   * (which is what fires `PrescriptionValidationListener`) and is trivially restorable. Re-PATCHing a
   * field to its current value would change nothing and therefore fire nothing.
   */
  async triggerRecompute(prescriptionId: number, currentActionRequired: boolean): Promise<void> {
    expect(await this.patch(prescriptionId, { actionRequired: !currentActionRequired }), 'recompute trigger').toBe(200);
    await this.page.waitForTimeout(1500);
  }

  /**
   * VOs sitting at a given creation-validation status.
   *
   * `creationValidationStatus=for_fixing` is the only cheap way to get VOs whose checks have actually
   * been evaluated: `/prescription_validations` never serialises its `prescription`, so stored
   * results cannot be mapped back to VOs from that side, and only ~1% of the collection has results.
   */
  async vosByValidationStatus(status: string, limit = 30): Promise<VoShape[]> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=${limit}&creationValidationStatus=${encodeURIComponent(status)}`,
    );
    return (body.member ?? []).map((row: any) => VoValidationPage.shape(row));
  }

  // ─────────────────────────────── the edit form ─────────────────────────────

  async openForm(prescriptionId: number): Promise<void> {
    await this.page.goto(`/vo-management/${prescriptionId}/edit?id=${prescriptionId}`, {
      waitUntil: 'domcontentloaded',
    });
    await this.page.waitForTimeout(13_000);
    await expect(
      this.page.getByText('Validierung', { exact: true }).filter({ visible: true }).first(),
      'the VO edit form must render its Validierung panel',
    ).toBeVisible({ timeout: 20_000 });
  }

  /**
   * The Hausbesuch switch's state.
   *
   * The form renders a row of labelled switches (Hausbesuch, Therapiebericht, Doppelbehandlung …) as
   * `input[role="switch"]` under their labels, so the right one is found by proximity to the
   * "Hausbesuch" label rather than by any stable attribute. Returns null when no switch is found.
   */
  async homeVisitToggle(): Promise<boolean | null> {
    return await this.page.evaluate(() => {
      const label = [...document.querySelectorAll('div')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === 'Hausbesuch',
      ) as HTMLElement | undefined;
      if (!label) return null;
      const anchor = label.getBoundingClientRect();
      const switches = [...document.querySelectorAll('input[role="switch"]')] as HTMLInputElement[];
      const scored = switches
        .map((input) => {
          const rect = input.getBoundingClientRect();
          return {
            input,
            dy: rect.top - anchor.top,
            dx: Math.abs(rect.left + rect.width / 2 - (anchor.left + anchor.width / 2)),
          };
        })
        .filter((s) => s.dy >= -10 && s.dy <= 60)
        .sort((a, b) => a.dx - b.dx);
      return scored.length ? scored[0].input.checked : null;
    });
  }

  /** The panel's summary counts, e.g. "13 automatisch bestanden · 2 fehlgeschlagen". */
  async summary(): Promise<{ passed: number; failed: number } | null> {
    const text = (await this.page.locator('#root').innerText()) || '';
    const match = text.match(/(\d+)\s+automatisch bestanden\s*·\s*(\d+)\s+fehlgeschlagen/);
    return match ? { passed: Number(match[1]), failed: Number(match[2]) } : null;
  }

  /**
   * The FEHLGESCHLAGEN block — everything the panel lists as failing, as one text blob.
   *
   * Each failing check contributes its message(s) and its label, so a check is failing iff its label
   * or message appears in here. Passing checks live behind "Alle Prüfungen anzeigen".
   */
  async failedChecksText(): Promise<string> {
    const text = (await this.page.locator('#root').innerText()) || '';
    const start = text.indexOf('FEHLGESCHLAGEN');
    if (start < 0) return '';
    const end = text.indexOf('Alle Prüfungen anzeigen', start);
    return text.slice(start, end < 0 ? start + 4000 : end);
  }

  /**
   * Clicks a save button and returns the confirmation dialog's text, or null when none appears.
   *
   * Never confirms: the dialog is cancelled before returning, so the form is not saved. Two live
   * behaviours matter here — the validate button submits **without** a dialog when every check passes,
   * and does nothing at all when some check fails.
   */
  async openSaveDialog(button: string): Promise<string | null> {
    const control = this.page.getByText(button, { exact: true }).filter({ visible: true }).last();
    await control.click({ force: true }).catch(() => {});
    await this.page.waitForTimeout(5000);
    const text = (await this.page.locator('#root').innerText()) || '';
    const at = text.indexOf('bestätigen');
    if (at < 0) return null;
    const dialog = text.slice(Math.max(0, at - 40), at + 260);
    await this.page
      .getByText('Abbrechen', { exact: true })
      .filter({ visible: true })
      .last()
      .click({ force: true })
      .catch(() => {});
    await this.page.waitForTimeout(1500);
    return dialog;
  }

  /** Whether a save button is rendered on the form at all (the For-Fixing one is conditional). */
  async saveButtons(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const wanted = ['Speichern', 'Zur Korrektur speichern', 'Abbrechen'];
      const found = new Set<string>();
      for (const el of [...document.querySelectorAll('div[tabindex],button')] as HTMLElement[]) {
        const text = (el.innerText || '').trim();
        if (wanted.includes(text) && el.getBoundingClientRect().width > 0) found.add(text);
      }
      return [...found];
    });
  }

  /**
   * The Hausbesuch check's state as the expanded panel draws it.
   *
   * Each check renders its section title in caps followed by a status glyph: ✓-style for passed,
   * ✗-style for failed, and a third glyph for "manuell" — a check an admin has overridden by hand,
   * which is neither an automatic pass nor an automatic fail (those VOs also lose the
   * "N automatisch bestanden" summary line entirely).
   */
  async homeVisitCheckState(): Promise<'passed' | 'failed' | 'manual' | null> {
    const text = await this.expandAllChecks();
    const at = text.indexOf('HAUSBESUCH');
    if (at < 0) return null;
    const glyph = text
      .slice(at + 'HAUSBESUCH'.length)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (!glyph) return null;
    if (glyph.startsWith(VoValidationPage.GLYPH_PASSED)) return 'passed';
    if (glyph.startsWith(VoValidationPage.GLYPH_FAILED)) return 'failed';
    if (glyph.startsWith(VoValidationPage.GLYPH_MANUAL)) return 'manual';
    return null;
  }

  /** Expands the full check list and returns the panel text from the expander onwards. */
  async expandAllChecks(): Promise<string> {
    const expander = this.page.getByText('Alle Prüfungen anzeigen', { exact: false }).filter({ visible: true }).first();
    if (await expander.count()) {
      await expander.click({ force: true }).catch(() => {});
      await this.page.waitForTimeout(4000);
    }
    const text = (await this.page.locator('#root').innerText()) || '';
    const start = text.indexOf('Validierung');
    return start < 0 ? text : text.slice(start);
  }
}
