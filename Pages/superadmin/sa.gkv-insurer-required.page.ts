import { type Page, type APIRequestContext, request as pwRequest } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

export type Vo = {
  id: number; prescriptionId: string; insuranceType?: string;
  versichertenstatus?: string | null; treatmentStatus?: string; patient?: any;
};
export type Patient = {
  id: number; patientId?: number; insuranceType?: string;
  insuranceProvider?: { id: number; ik: string; name: string } | null;
  insuranceCompany?: string | null; versichertenstatus?: string | null;
};

/**
 * RC 3.15 #3810 — an insurer is required for GKV on both VO forms, the Create Patient pop-up and
 * the patient form; a GKV VO also needs its OWN Versichertenstatus.
 *
 * **THE RULE IS DELIBERATELY FORM-ONLY, and that decides how it can be tested.** The ticket's Out
 * of Scope rules out "a rule on every save outside these forms … it would break Praxis Flow saves,
 * the deceased marking, the merge command and the nightly jobs" — so there is no server-side
 * validation to probe, AC9 holds by construction, and AC2/AC3/AC6/AC7 exist only on screen.
 *
 * **Which is what makes this testable without writing:** every save this file attempts is one the
 * rule must REFUSE, and a refused save writes nothing. The fixtures are chosen so that even a
 * broken build would write back the values the record already holds.
 *
 * **Traps in finding those fixtures — three filters that are silently IGNORED:**
 *  - `/patients?insuranceType=` (#3710) and `?exists[insuranceProvider]=` (#3560) both return the
 *    whole 8,901-row table, so a GKV patient without an insurer cannot be selected server-side.
 *  - `insuranceProvider` is absent from the `/patients` LIST payload and present only on the item
 *    read, so the population has to be sampled one patient at a time.
 *  - `versichertenstatus` is OMITTED when null on a VO (not serialized as null), so "has none"
 *    reads `undefined`.
 */
export class GkvInsurerRequiredPage {
  /** The two new required messages, as the Localization Reference proposes them. */
  static readonly MSG = {
    insurer: 'Versicherung ist bei GKV erforderlich',
    versichertenstatus: 'Versichertenstatus ist bei GKV erforderlich',
  } as const;

  /** Existing strings the new field reuses (AC1). */
  static readonly EXISTING = {
    createInsurer: 'Neue Versicherung erstellen',
    searchPlaceholder: 'Versicherung nach Name oder IK suchen',
    alsoSaved: 'wird auch im Profil von',
    insuranceLabel: 'Versicherung',
    insuranceTypeLabel: 'Versicherungsart',
    versichertenstatusLabel: 'Versichertenstatus',
  } as const;

  private api!: APIRequestContext;
  private token = '';

  constructor(private readonly page?: Page) {}

  private requirePage(): Page {
    if (!this.page) throw new Error('GkvInsurerRequiredPage needs a Page');
    return this.page;
  }

  async connect(): Promise<void> {
    this.api = await pwRequest.newContext({ baseURL: API });
    const res = await this.api.post('/auth', {
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async dispose(): Promise<void> {
    await this.api?.dispose();
  }

  private async get<T>(path: string, timeout = 300_000): Promise<T> {
    for (let i = 0; i < 3; i++) {
      const res = await this.api.get(path, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) return (await res.json()) as T;
      if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
      await new Promise((r) => setTimeout(r, 2_500 * (i + 1)));
    }
    throw new Error(`GET ${path} failed`);
  }

  async status(): Promise<{ version: string }> { return this.get('/status', 60_000); }
  async vo(id: number): Promise<Vo> { return this.get(`/prescriptions/${id}`); }
  async patient(id: number): Promise<Patient> { return this.get(`/patients/${id}`); }
  async insurerCount(): Promise<number> {
    return (await this.get<{ totalItems: number }>('/insurance_providers?itemsPerPage=1')).totalItems;
  }

  /** Proves a filter narrows before any count from it is believed. */
  async patientFilterIgnored(query: string): Promise<{ all: number; hit: number }> {
    const all = (await this.get<{ totalItems: number }>('/patients?itemsPerPage=1')).totalItems;
    const hit = (await this.get<{ totalItems: number }>(`/patients?${query}&itemsPerPage=1`)).totalItems;
    return { all, hit };
  }

  // ------------------------------------------------------------- screens

  async signIn(): Promise<void> {
    await mintUiSession(this.requirePage(), STAGING_CREDENTIALS.superadmin);
  }

  /**
   * The VO edit form.
   *
   * "Speichern" is the form's action row and paints EARLY — the insurance section lands later, so a
   * gate on Speichern alone hands the caller a form whose fields are not there yet and the reads
   * that follow report the section as missing. (That is intermittent, which is the worst kind: this
   * file's AC1 test passed on one run and failed on the next with the same code.) Wait for the
   * thing the caller is about to read.
   */
  async openVoForm(voId: number, timeout = 240_000): Promise<void> {
    const page = this.requirePage();
    await page.setViewportSize({ width: 1600, height: 1400 });
    await page.goto(`${WEB}/vo-management/${voId}/edit?id=${voId}`, { waitUntil: 'domcontentloaded', timeout });
    await page.getByText('Speichern', { exact: true }).first().waitFor({ state: 'visible', timeout });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const t = await this.formText();
      if (t.includes('Versicherungsart') && t.includes('Versichertenstatus')) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error('the VO form did not paint its insurance section');
  }

  /**
   * The patient edit form. The route takes NO `?id=` query — adding one never resolves, and with
   * `actionTimeout` at 0 the readiness wait then burns the whole test budget rather than failing
   * fast. Readiness is the form's own heading plus a painted VERSICHERUNG section, because the
   * section headers render before the values arrive.
   */
  async openPatientForm(patientId: number, timeout = 240_000): Promise<void> {
    const page = this.requirePage();
    await page.setViewportSize({ width: 1600, height: 1400 });
    await page.goto(`${WEB}/patient-management/${patientId}/edit`, { waitUntil: 'domcontentloaded', timeout });
    await page.getByText('Patient bearbeiten').first().waitFor({ state: 'visible', timeout: 90_000 });
    // The section header is CSS-UPPERCASED: it paints as "VERSICHERUNG" but its textContent stays
    // "Versicherung", and Playwright's text engine matches textContent — so
    // `getByText('VERSICHERUNG', { exact: true })` never resolves and the wait burns its whole
    // timeout, which reads exactly like the section being absent. Poll innerText instead, and wait
    // for the FIELD, since the section headers paint before the values arrive.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const t = await this.formText();
      if (t.includes('Versicherungsart') && /Versicherung \*|Versicherung\n/.test(t)) return;
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error('the patient form did not paint its Versicherung section');
  }

  /**
   * The patient form's save control and whether it is currently actionable.
   *
   * It reads **"Änderungen speichern"**, not "Speichern" (the VO form's label), and it carries
   * `aria-disabled="true"` while the form is PRISTINE — so a click on an untouched form waits out
   * its actionability timeout rather than failing, which reads like the button being broken.
   */
  async patientSaveState(): Promise<{ label: string; ariaDisabled: string | null } | null> {
    return this.requirePage().evaluate(() => {
      const el = [...document.querySelectorAll('div,span,button')].find(
        (n) => n.children.length === 0 && (n.textContent ?? '').trim() === 'Änderungen speichern',
      ) as HTMLElement | undefined;
      if (!el) return null;
      let p: HTMLElement | null = el;
      let dis: string | null = null;
      for (let i = 0; i < 5 && p; i++) {
        if (p.getAttribute('aria-disabled')) { dis = p.getAttribute('aria-disabled'); break; }
        p = p.parentElement;
      }
      return { label: 'Änderungen speichern', ariaDisabled: dis };
    });
  }

  /** Types into the insurer search box — the most on-topic way to dirty the form, and it sets no value. */
  async typeInInsurerSearch(text: string): Promise<boolean> {
    const page = this.requirePage();
    const box = page.getByPlaceholder(/Versicherung nach Name oder IK suchen/).first();
    if ((await box.count()) === 0) return false;
    await box.fill(text, { timeout: 30_000 });
    await page.waitForTimeout(2_500);
    return true;
  }

  /** Whether a field label carries the required asterisk, e.g. `Versicherung *`. */
  async isMarkedRequired(label: string): Promise<boolean> {
    const t = await this.formText();
    return t.split('\n').some((l) => l.trim() === `${label} *`);
  }

  /** Whole-form text, read with textContent so CSS-uppercased labels keep their real casing. */
  async formText(): Promise<string> {
    return this.requirePage().evaluate(() => (document.body as HTMLElement).innerText);
  }

  /**
   * The x/y of a labelled leaf, so AC1's "same section as Insurance type and Versichertenstatus"
   * is a measurement rather than a guess.
   */
  async labelBox(label: string): Promise<{ x: number; y: number } | null> {
    return this.requirePage().evaluate((t) => {
      const el = [...document.querySelectorAll('div,span,label')].find(
        (n) => n.children.length === 0 && (n.textContent ?? '').trim().replace(/\s*\*$/, '') === t,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 && r.height === 0 ? null : { x: r.x, y: r.y };
    }, label);
  }

  /**
   * Presses Speichern and reports what happened. Polls, because the form re-renders as its
   * validation panel lands and a message read too early is simply absent — which reads exactly
   * like the rule not firing.
   */
  async trySave(expectMessages: string[], timeout = 60_000, label = 'Speichern'): Promise<{ shown: string[]; text: string }> {
    const page = this.requirePage();
    await page.getByText(label, { exact: true }).first().click({ timeout: 30_000, force: true });
    const deadline = Date.now() + timeout;
    let text = '';
    let shown: string[] = [];
    while (Date.now() < deadline) {
      text = await this.formText();
      shown = expectMessages.filter((m) => text.includes(m));
      if (shown.length === expectMessages.length) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return { shown, text };
  }
}
