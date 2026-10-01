import { APIRequestContext } from '@playwright/test';
import { NoticeWordingPage, FIXTURES, type LetterRead } from './admin.notice-wording.page';
import { pdfDocText } from '../util/pdf-layout';
import { pdfText } from '../util/pdf-text';

const API = 'https://api.therapios.de'.replace('api.', 'api.staging.');

/**
 * RC 3.15 #3848 — a patient whose Anrede is not Herr/Herrn/Frau is greeted by FIRST AND LAST name
 * ("Sehr geehrte/r Bärbel Kramp,") instead of by last name alone, and the Vorabinformation names
 * them the same way in its "Behandlung für …" line.
 *
 * The rule lives in ONE place — `DocumentRecipientResolver::resolve()` plus the new
 * `patientReference()` — which all six letter renderers read, so it is ported here once and used
 * as the oracle for every surface.
 *
 * Composes `NoticeWordingPage` for the Vorabinformation half, because generating a notice and
 * reading its PDF is already solved there (#3668), including the `pdfText` extractor gap.
 */
export class LetterGreetingPage {
  readonly notices: NoticeWordingPage;

  /** The salutations the resolver treats as known; everything else falls back to the full name. */
  static readonly KNOWN = ['Herr', 'Herrn', 'Frau'] as const;
  /** AC1's four rows, as the ticket states them. */
  static readonly AC1_ROWS = ['Frau', 'Herr', null, 'null'] as const;

  constructor(private request: APIRequestContext) {
    this.notices = new NoticeWordingPage(request);
  }

  static readonly FIXTURES = FIXTURES;

  adminToken = () => this.notices.adminToken();

  private headers(token: string) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' };
  }

  // ───────────────────────────── the rule, as an oracle ─────────────────────────────

  /** `DocumentRecipientResolver`: the greeting phrase follows the salutation. */
  static greetingPhrase(salutation: string | null | undefined): string {
    if (salutation === 'Frau') return 'Sehr geehrte';
    if (salutation === 'Herr' || salutation === 'Herrn') return 'Sehr geehrter';
    return 'Sehr geehrte/r';
  }

  /** The shipped rule: salutation + last name when known, otherwise first + last name. */
  static greetingName(salutation: string | null | undefined, first: string, last: string): string {
    return (LetterGreetingPage.KNOWN as readonly string[]).includes(salutation ?? '')
      ? `${salutation} ${last}` : `${first} ${last}`.trim();
  }

  /** The whole greeting line, ending in the comma the letters print. */
  static expectedGreeting(salutation: string | null | undefined, first: string, last: string): string {
    return `${LetterGreetingPage.greetingPhrase(salutation)} ` +
      `${LetterGreetingPage.greetingName(salutation, first, last)},`;
  }

  /** `patientReference()`: how the Vorabinformation body names the patient. */
  static expectedReference(salutation: string | null | undefined, first: string, last: string): string {
    return LetterGreetingPage.greetingName(salutation, first, last);
  }

  /**
   * The PRE-fix rule, kept so each assertion can also show what the letter no longer says.
   * It greeted by last name alone whatever the salutation was.
   */
  static legacyGreeting(salutation: string | null | undefined, last: string): string {
    return `${LetterGreetingPage.greetingPhrase(salutation)} ${last},`;
  }

  /** True when the two rules disagree — i.e. the row actually tests the change. */
  static discriminates(salutation: string | null | undefined, first: string, last: string): boolean {
    return LetterGreetingPage.expectedGreeting(salutation, first, last)
      !== LetterGreetingPage.legacyGreeting(salutation, last);
  }

  // ───────────────────────────── reading a letter ─────────────────────────────

  static flatten = NoticeWordingPage.flatten;

  /** The greeting line a letter prints, or null. */
  static greetingIn(text: string): string | null {
    return /Sehr geehrte?\/?r?\s+[^,]{0,80},/.exec(text)?.[0] ?? null;
  }

  /** The Vorabinformation's "Behandlung für …" subject, trimmed to the name. */
  static referenceIn(text: string): string | null {
    const m = /Behandlung f[üu]r\s+(.{0,60}?)\s+übernehmen/.exec(text);
    return m ? m[1].trim() : null;
  }

  // ───────────────────────────── patients ─────────────────────────────

  async patient(id: number, token: string): Promise<any> {
    const res = await this.request.get(`${API}/patients/${id}`,
      { headers: this.headers(token), timeout: 200_000 });
    if (!res.ok()) throw new Error(`GET /patients/${id} -> ${res.status()}`);
    return res.json();
  }

  async setSalutation(id: number, value: string | null, token: string): Promise<void> {
    const res = await this.request.patch(`${API}/patients/${id}`, {
      headers: { ...this.headers(token), 'Content-Type': 'application/merge-patch+json' },
      data: { salutation: value },
      timeout: 200_000,
    });
    if (!res.ok()) throw new Error(`PATCH /patients/${id} salutation -> ${res.status()}`);
  }

  /**
   * Runs `fn` with the patient's Anrede temporarily set, and ALWAYS puts the original back.
   *
   * This is the ticket's own QA step ("Set the Anrede to Frau and preview again"), and it is what
   * makes AC1 a controlled experiment on ONE patient: four patients with four different names
   * would confound the rule with the names. Only ever pointed at a QA patient.
   */
  async withSalutation<T>(
    id: number, value: string | null, token: string, fn: () => Promise<T>,
  ): Promise<T> {
    const before = (await this.patient(id, token)).salutation ?? null;
    try {
      await this.setSalutation(id, value, token);
      return await fn();
    } finally {
      await this.setSalutation(id, before, token);
    }
  }

  // ───────────────────────────── the letters ─────────────────────────────

  /** Generate a fresh Vorabinformation and read it (mutating — it archives the previous one). */
  generateNotice(fixture: typeof FIXTURES[keyof typeof FIXTURES], token: string): Promise<LetterRead> {
    return this.notices.generateAndRead(fixture, token);
  }

  /**
   * The Zahlungserinnerung, rendered ON DEMAND and never stored (#3559), so reading one writes
   * nothing — which is what makes a second letter type checkable here with no side effect at all.
   */
  async reminderLetter(invoiceId: number, token: string): Promise<{ text: string; naive: string }> {
    const res = await this.request.get(`${API}/invoices/${invoiceId}/reminder-letter`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 300_000 });
    if (!res.ok()) throw new Error(`reminder ${invoiceId} -> ${res.status()}`);
    const buf = Buffer.from(await res.body());
    return {
      text: NoticeWordingPage.flatten(pdfDocText(buf)),
      naive: NoticeWordingPage.flatten(pdfText(buf)),
    };
  }

  /** Overdue PKV invoices with their embedded patient — the reminder-eligible population. */
  async overduePkvInvoices(token: string): Promise<{ id: number; number: string; patientId: number }[]> {
    const res = await this.request.get(
      `${API}/invoices?itemsPerPage=400&groups%5B%5D=invoice-list%3Aread&status=overdue`,
      { headers: this.headers(token), timeout: 400_000 });
    if (!res.ok()) throw new Error(`GET /invoices -> ${res.status()}`);
    const rows = (await res.json()).member ?? [];
    return rows
      .filter((x: any) => x.invoiceType === 'pkv' && x.prescription?.patient?.id)
      .map((x: any) => ({ id: x.id, number: x.invoiceNumber, patientId: x.prescription.patient.id }));
  }

  /** Several patients in one request — `?id[]=` is registered on /patients (#3560). */
  async patientsById(ids: number[], token: string): Promise<Map<number, any>> {
    const out = new Map<number, any>();
    for (let i = 0; i < ids.length; i += 50) {
      const q = ids.slice(i, i + 50).map((v) => `id%5B%5D=${v}`).join('&');
      const res = await this.request.get(`${API}/patients?itemsPerPage=60&${q}`,
        { headers: this.headers(token), timeout: 400_000 });
      if (!res.ok()) throw new Error(`GET /patients?id[] -> ${res.status()}`);
      for (const p of (await res.json()).member ?? []) out.set(p.id, p);
    }
    return out;
  }

  /** The address types that name a PERSON — a letter for one of these greets the guardian (AC3). */
  static readonly PERSON_TYPES = ['relative', 'legal_guardian', 'other'] as const;

  /**
   * The billing address a letter would be addressed to, when it names a person.
   *
   * **This is the trap on this ticket:** a letter whose patient has a person-type billing address
   * does NOT greet the patient at all, so a greeting read off it says nothing about the patient
   * rule — it is AC3's path. A reminder for "Herr Karl Schäfer" legitimately reads
   * "Sehr geehrte Frau Schäfer," because his daughter is the billing contact.
   */
  static billingPerson(patient: any): any | null {
    const bill = (patient?.patientAddresses ?? []).filter((a: any) => a.isBilling);
    return bill.find((a: any) =>
      (LetterGreetingPage.PERSON_TYPES as readonly string[]).includes(a.type) || a.personName) ?? null;
  }
}
