import { Page, Locator, expect } from '@playwright/test';
import { AppPage } from '../base/app.page';

/**
 * Guardian Contacts — patient address form (RC 3.10, epic #3187 / #3188).
 *
 * Surface: the ADRESSEN section of `/patient-management/{id}/edit`. Each address is a card with
 * a label, a Rechnung (billing) switch, the Adresstyp selector, and — for person types only — an
 * Anrede dropdown and a "Name der Person" field, followed by the pre-existing Kontaktname,
 * Kontaktnummer, Adresse and Notizen fields.
 *
 * DOM notes, all verified live on staging (React Native Web):
 *  - **The billing switch IS the `<input role="switch" type="checkbox">`**, and the *active* one is
 *    rendered `disabled` — an address cannot un-bill itself, only another address taking over can.
 *    So "which address is billing" reads as `disabled` + live `.checked`.
 *  - **The switch's `checked` ATTRIBUTE goes stale** after React re-renders; the live `.checked`
 *    property is the truth. Reading `aria-checked` returns null — it isn't set at all.
 *  - **Adresstyp and Anrede are portalled dropdowns**, not `<select>`. Their options render at the
 *    end of the document once the trigger is pressed, so an option is only findable page-wide and
 *    only while the list is open (`.last()` when picking — the same string also appears in the
 *    closed trigger).
 *  - **"Name der Person" and "Kontaktname" share the placeholder `z.B. Max Mustermann`**, so they
 *    can only be told apart by order/geometry: Name der Person renders ABOVE Kontaktname.
 *  - Field visibility is the AC under test, so presence is asserted from the section's own text
 *    rather than page-wide (the labels "Anrede"/"Name" also occur in the personal-details section).
 */
export class PatientAddressesPage extends AppPage {
  /** Adresstyp options, in the order the dropdown lists them (#3188 AC1). */
  static readonly TYPES = {
    careHome: 'Pflegeheim',
    legalGuardian: 'Gesetzliche/r Betreuer/in / Bevollmächtigte/r',
    relative: 'Angehörige/r',
    other: 'Sonstiges',
  } as const;

  /** The three "person" types that reveal Anrede + Name der Person (#3188 AC3). */
  static readonly PERSON_TYPES = [
    PatientAddressesPage.TYPES.legalGuardian,
    PatientAddressesPage.TYPES.relative,
    PatientAddressesPage.TYPES.other,
  ] as const;

  /** Backend enum values, as exposed on the PatientAddress payload. */
  static readonly API_TYPES = ['care_home', 'legal_guardian', 'relative', 'other'] as const;

  /** Fields that exist on every address card regardless of type (#3188 AC2). */
  static readonly ALWAYS_FIELDS = ['Kontaktname', 'Kontaktnummer (optional)', 'Adresse', 'Notizen'] as const;

  /** Fields that appear only for person types (#3188 AC3). */
  static readonly PERSON_FIELDS = ['Anrede', 'Name der Person'] as const;

  constructor(page: Page) {
    super(page);
  }

  // ─────────────────────────────── navigation ────────────────────────────

  async openPatientForm(id: number) {
    await this.page.setViewportSize({ width: 1920, height: 1200 });
    await this.goto(`/patient-management/${id}/edit?id=${id}`);
    await expect(this.page.getByText('Patient bearbeiten', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // Section headings are uppercased by CSS, so the screen (and `innerText`) reads "ADRESSEN" while
    // the DOM text is "Adressen". Playwright matches text content, not the rendered transform, so
    // `getByText('ADRESSEN', { exact: true })` finds nothing at all.
    await expect(this.page.getByText(/^Adressen$/i).first()).toBeVisible({ timeout: 30_000 });
    await this.page.waitForTimeout(2500);
  }

  /** Text of the ADRESSEN section only — the scope every visibility assertion is made against. */
  async sectionText(): Promise<string> {
    const t = (await this.page.locator('#root').innerText()) || '';
    const start = t.indexOf('ADRESSEN');
    if (start < 0) return '';
    const end = t.indexOf('ZUZAHLUNGSBEFREIUNG', start);
    return t.slice(start, end > start ? end : start + 3000);
  }

  /** The section text of a single address card, split on the per-card "Rechnung" header. */
  async cardText(index: number): Promise<string> {
    const cards = (await this.sectionText())
      .split(/\bRechnung\b/)
      .slice(1)
      .map((c) => c.replace(/\+ Adresse hinzufügen[\s\S]*$/, ''));
    return cards[index] ?? '';
  }

  async cardCount(): Promise<number> {
    return await this.page.locator('input[role="switch"]').count();
  }

  // ───────────────────────────── Adresstyp ───────────────────────────────

  /**
   * The Adresstyp trigger of one card. Located by the type label it currently shows, scoped to the
   * card by index — the trigger has no accessible name of its own.
   */
  private async typeTriggerHandle(index: number) {
    return await this.page.evaluateHandle((i) => {
      const labels = ['Pflegeheim', 'Gesetzliche/r Betreuer/in / Bevollmächtigte/r', 'Angehörige/r', 'Sonstiges'];
      const triggers = [...document.querySelectorAll('div')]
        .filter((e) => e.children.length === 0 && labels.includes((e.textContent || '').trim()))
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0)
        .sort((a, b) => a.r.top - b.r.top);
      return triggers[i]?.e ?? null;
    }, index);
  }

  /** Adresstyp currently selected on a card. */
  async selectedType(index = 0): Promise<string | null> {
    const el = (await this.typeTriggerHandle(index)).asElement();
    return el ? ((await el.textContent()) || '').trim() : null;
  }

  /** Opens a card's Adresstyp dropdown and returns the options it offers. */
  async openTypeDropdown(index = 0): Promise<string[]> {
    await this.page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1')),
    );
    const el = (await this.typeTriggerHandle(index)).asElement();
    if (!el) throw new Error(`openTypeDropdown: no Adresstyp trigger for card #${index}`);
    await el.click({ force: true });
    await this.page.waitForTimeout(2000);
    return await this.freshOptions();
  }

  async setType(type: string, index = 0) {
    const options = await this.openTypeDropdown(index);
    if (!options.includes(type)) {
      throw new Error(`Adresstyp "${type}" not on offer for card #${index}; got ${JSON.stringify(options)}`);
    }
    await this.page.getByText(type, { exact: true }).last().click();
    await this.page.waitForTimeout(2500);
  }

  // ─────────────────────────────── Anrede ────────────────────────────────

  /** Opens the Anrede dropdown of a person-type card and returns its options (expects Herr/Frau). */
  async openAnredeDropdown(): Promise<string[]> {
    await this.page.evaluate(() =>
      document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1')),
    );
    // The trigger shows its placeholder "z.B. Herr, Frau" until a value is chosen.
    await this.page
      .getByText(/^(z\.B\. Herr, Frau|Herr|Frau)$/)
      .filter({ visible: true })
      .last()
      .click({ force: true });
    await this.page.waitForTimeout(2000);
    return await this.freshOptions();
  }

  async setAnrede(value: 'Herr' | 'Frau') {
    const options = await this.openAnredeDropdown();
    if (!options.includes(value)) {
      throw new Error(`Anrede "${value}" not on offer; got ${JSON.stringify(options)}`);
    }
    await this.page.getByText(value, { exact: true }).last().click();
    await this.page.waitForTimeout(1500);
  }

  // ─────────────────────────── text fields ───────────────────────────────

  /**
   * Fills the input belonging to a given field LABEL inside the address section.
   *
   * "Name der Person" and "Kontaktname" share the placeholder `z.B. Max Mustermann`, so a
   * placeholder-based locator silently fills the wrong one — and a save assertion would then pass
   * against `contactPerson` while `personName` stayed empty. Anchoring on the label and taking the
   * first matching input BELOW it is unambiguous. `occurrence` picks the card when several cards
   * show the same label (0 = topmost).
   */
  async fillLabelledField(label: string, value: string, occurrence = 0) {
    const focused = await this.page.evaluate(
      ([lbl, occ]) => {
        const labels = [...document.querySelectorAll('div')]
          .filter((e) => e.children.length === 0 && (e.textContent || '').trim() === lbl)
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0)
          .sort((a, b) => a.r.top - b.r.top);
        const anchor = labels[occ as number];
        if (!anchor) return false;
        const input = [...document.querySelectorAll('input, textarea')]
          .map((i) => ({ i, r: i.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.top >= anchor.r.bottom - 4)
          .sort((a, b) => a.r.top - b.r.top)[0];
        if (!input) return false;
        (input.i as HTMLInputElement).focus();
        return true;
      },
      [label, occurrence] as const,
    );
    if (!focused) throw new Error(`fillLabelledField: no input found under label "${label}" #${occurrence}`);
    await this.page.keyboard.type(value);
    await this.page.waitForTimeout(700);
  }

  /** "Name der Person" on the nth person-type card (see `fillLabelledField` for why by label). */
  async fillPersonName(value: string, occurrence = 0) {
    await this.fillLabelledField('Name der Person', value, occurrence);
  }

  /** Fills a card field by its placeholder (Adresse, Kontaktnummer, Notizen, label). */
  async fillByPlaceholder(placeholder: string, value: string, nth = 0) {
    const box = this.page.getByPlaceholder(placeholder).filter({ visible: true }).nth(nth);
    await box.fill(value);
    await this.page.waitForTimeout(500);
  }

  // ─────────────────────────── billing switch ────────────────────────────

  /**
   * Live billing state of every address card, top to bottom.
   *
   * `checked` is read as the live DOM property, not the attribute: React leaves the attribute stale
   * after a re-render, so the attribute still says "checked" on an address that has just been
   * un-billed. `disabled` is the app's own marker for "this is the billing address" — the active
   * switch is disabled so it cannot be turned off directly (#3188 AC5).
   */
  async billingStates(): Promise<{ checked: boolean; disabled: boolean }[]> {
    return await this.page.evaluate(() =>
      [...document.querySelectorAll('input[role="switch"]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => a.r.top - b.r.top)
        .map(({ el }) => ({
          checked: (el as HTMLInputElement).checked,
          disabled: (el as HTMLInputElement).disabled,
        })),
    );
  }

  billingSwitch(index: number): Locator {
    return this.page.locator('input[role="switch"]').nth(index);
  }

  async enableBilling(index: number) {
    await this.billingSwitch(index).click({ force: true });
    await this.page.waitForTimeout(2500);
  }

  // ───────────────────────── add / save / delete ─────────────────────────

  async addAddress() {
    await this.page.getByText('+ Adresse hinzufügen', { exact: true }).click();
    await this.page.waitForTimeout(2500);
  }

  saveButton(): Locator {
    return this.page.getByText('Änderungen speichern', { exact: true }).filter({ visible: true }).last();
  }

  async save() {
    await this.saveButton().click({ force: true });
    await this.page.waitForTimeout(6000);
  }

  /**
   * Deletes the address card at `index` via its row action. Only non-billing addresses can be
   * deleted — the app blocks deleting the billing address.
   */
  async deleteAddress(index: number): Promise<boolean> {
    return await this.page.evaluate((i) => {
      const switches = [...document.querySelectorAll('input[role="switch"]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .sort((a, b) => a.r.top - b.r.top);
      const card = switches[i];
      if (!card) return false;
      // The delete control is an icon-only `div[tabindex="0"]` on the card header row, immediately
      // right of the billing switch. It carries a font glyph rather than an <svg>, so requiring an
      // svg child finds nothing. It is also absent on the billing card — the app blocks deleting the
      // billing address — which is why this returns false rather than throwing.
      const candidates = [...document.querySelectorAll('div[tabindex="0"]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && Math.abs(r.top - card.r.top) < 40 && r.left >= card.r.right)
        .sort((a, b) => a.r.left - b.r.left);
      if (!candidates.length) return false;
      (candidates[0].el as HTMLElement).click();
      return true;
    }, index);
  }

  // ──────────────────────────────── API ─────────────────────────────────

  /**
   * A patient's addresses straight from the API — the only way to confirm what was actually SAVED
   * (`type`, `salutation`, person name and `isBilling` are all serialized on PatientAddress).
   *
   * Runs inside the page: the API is a separate host authenticating with a bearer token from the
   * `auth-state` localStorage entry, so an APIRequestContext would be unauthenticated.
   */
  async apiAddresses(patientId: number): Promise<any[]> {
    const res = await this.page.evaluate(async (id) => {
      let token: string | null = null;
      try {
        const j = JSON.parse(localStorage.getItem('auth-state') || '');
        token = j.token || j.accessToken || j.access_token || null;
      } catch {
        /* the caller asserts on what it gets */
      }
      const r = await fetch(`https://api.staging.therapios.de/patients/${id}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' },
      });
      if (!r.ok) return { status: r.status, addresses: [] };
      const j = await r.json();
      return { status: r.status, addresses: j.patientAddresses ?? [] };
    }, patientId);
    expect(res.status, `GET /patients/${patientId}`).toBe(200);
    return res.addresses;
  }

  /**
   * Scans the patients collection for addresses of the given types — how the #3189 import's results
   * are found.
   *
   * `PatientAddress` is not an ApiResource of its own (`/patient_addresses` 404s), so there is no way
   * to query guardian addresses directly; the patients collection is the only place they are
   * serialized. It does include them, with `type`, so a bounded page scan is the practical approach.
   */
  async findPatientsWithAddressType(
    types: readonly string[],
    pages = 8,
    perPage = 100,
  ): Promise<{ patientId: number; id: number; isDeceased: boolean; addresses: any[] }[]> {
    return await this.page.evaluate(
      async ([wanted, pageCount, itemsPerPage]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* unauthenticated — the caller sees an empty result */
        }
        const hits: any[] = [];
        for (let p = 1; p <= (pageCount as number); p++) {
          const r = await fetch(
            `https://api.staging.therapios.de/patients?page=${p}&itemsPerPage=${itemsPerPage}`,
            { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' } },
          );
          if (!r.ok) break;
          const j = await r.json();
          const members = j.member ?? j['hydra:member'] ?? [];
          if (!members.length) break;
          for (const m of members) {
            const addrs = m.patientAddresses ?? [];
            if (addrs.some((a: any) => (wanted as string[]).includes(a.type))) {
              hits.push({
                patientId: m.patientId,
                id: m.id,
                isDeceased: !!m.isDeceased,
                addresses: addrs,
              });
            }
          }
        }
        return hits;
      },
      [types, pages, perPage] as any,
    );
  }

  // ──────────────────────────────── helpers ──────────────────────────────

  /** Option labels of a portalled dropdown that has just been opened (see class docs). */
  private async freshOptions(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const ICON_ONLY = /^[-\s]+$/;
      return [...document.querySelectorAll('*:not([data-qa-seen])')]
        .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
        .map((e) => (e.textContent || '').trim())
        .filter((t) => t && !ICON_ONLY.test(t));
    });
  }
}
