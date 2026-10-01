import { APIRequestContext, Page } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS, type Credentials } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

export type Indicator = { therapistId: number; absentToday: boolean; absentInLeadTimeWindow: boolean };
export type Dot = { testId: string; color: string; aria: string | null };

/**
 * RC 3.15 #3721 — a coloured dot on the CRM practice detail's two VO lists saying that nothing is
 * happening because the therapist is away: RED on Nachverfolgen when they are absent today, AMBER
 * on Bestellen when an absence falls inside the practice's ordering lead-time window.
 *
 * **Personal data discipline, which the feature itself sets the standard for.** The new endpoint
 * deliberately returns two booleans and nothing else, so "Krankheit on Thursday" about a named
 * employee never reaches a CRM list. This page object mirrors that: the oracle reads `/absence-days`
 * for DATES only, never the absence type, and nothing here logs a date against a person — the
 * assertions are booleans and counts.
 */
export class AbsenceIndicatorPage {
  private token = '';
  /** `/therapist-absence-indicators` requests the screen issued, in order. */
  readonly requests: string[] = [];

  /** The route, kebab-case — the snake_case form 404s (the `/absence-days` trap, #3394). */
  static readonly ROUTE = '/therapist-absence-indicators';
  /** Exactly the fields the DTO exposes. Anything else would be a privacy regression. */
  static readonly FIELDS = ['therapistId', 'absentToday', 'absentInLeadTimeWindow'] as const;

  static readonly RED = 'rgb(211, 47, 47)';     // #D32F2F
  static readonly AMBER = 'rgb(230, 167, 0)';   // #E6A700
  static readonly LABEL_TODAY = 'Therapeut:in heute abwesend';
  static readonly LABEL_WINDOW = 'Therapeut:in in der Bestellvorlaufzeit abwesend';

  constructor(private request: APIRequestContext, private page?: Page) {}

  async init(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth (${creds.email}) -> ${res.status()}`);
    const t = (await res.json()).token as string;
    if (!this.token) this.token = t;
    return t;
  }

  private headers(token = this.token) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' };
  }

  async get<T>(path: string, token = this.token, timeout = 500_000): Promise<T> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(token), timeout });
        if (res.ok()) return (await res.json()) as T;
        if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
        last = String(res.status());
      } catch (e: any) {
        if (/-> \d{3}$/.test(e?.message ?? '')) throw e;
        last = e?.message ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  /** The status alone, for the authorization matrix — never scoring a 5xx as a verdict. */
  async status(path: string, token = this.token): Promise<number> {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(token), timeout: 300_000 });
        if (res.status() < 500) return res.status();
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    return 0;
  }

  /** The indicator for each therapist, batched the way the screen batches. */
  async indicators(practiceId: number, therapistIds: number[], token = this.token): Promise<Map<number, Indicator>> {
    const out = new Map<number, Indicator>();
    for (let i = 0; i < therapistIds.length; i += 40) {
      const q = therapistIds.slice(i, i + 40).map((t) => `therapist%5B%5D=${t}`).join('&');
      const b = await this.get<any>(`${AbsenceIndicatorPage.ROUTE}?practice=${practiceId}&${q}`, token);
      for (const x of b.member ?? b['hydra:member'] ?? []) out.set(x.therapistId, x as Indicator);
    }
    return out;
  }

  /** Raw rows, so a test can assert the payload's SHAPE as well as its values. */
  async rawIndicators(practiceId: number, therapistIds: number[]): Promise<any[]> {
    const q = therapistIds.map((t) => `therapist%5B%5D=${t}`).join('&');
    const b = await this.get<any>(`${AbsenceIndicatorPage.ROUTE}?practice=${practiceId}&${q}`);
    return b.member ?? b['hydra:member'] ?? [];
  }

  /**
   * A therapist's absence DATES — the independent oracle.
   *
   * `/absence-days` is kebab-case, filters only by `user` and has NO date filter (#3394/#3663), so
   * a user's whole history comes back and the window is applied here. Only the dates are read; the
   * absence TYPE is deliberately left on the floor.
   */
  async absenceDates(userId: number): Promise<string[]> {
    const b = await this.get<any>(`/absence-days?user=%2Fusers%2F${userId}&itemsPerPage=1000`);
    const rows = b.member ?? b['hydra:member'] ?? [];
    return [...new Set(rows.map((r: any) => String(r.date ?? '').slice(0, 10)).filter(Boolean))] as string[];
  }

  /** Every `dayPortion` a user's rows carry — for the half-day coverage report. */
  async dayPortions(userId: number): Promise<string[]> {
    const b = await this.get<any>(`/absence-days?user=%2Fusers%2F${userId}&itemsPerPage=1000`);
    return (b.member ?? []).map((r: any) => String(r.dayPortion ?? ''));
  }

  /** Therapist ids from the board's own roster. */
  async therapistIds(): Promise<number[]> {
    const b = await this.get<any>('/kpis/management/working-hours');
    const rows = (b.member ?? b) as any[];
    return [...new Set(rows.map((r) => r.therapistId).filter(Boolean))].sort((a, b2) => a - b2);
  }

  async practice(id: number): Promise<any> { return this.get<any>(`/practices/${id}`); }

  // ───────────────────────────── oracles ─────────────────────────────

  static iso(d: Date): string { return d.toISOString().slice(0, 10); }
  static addDays(iso: string, n: number): string {
    return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  }

  /** AC1: absent today. */
  static derivedToday(dates: string[], today: string): boolean { return dates.includes(today); }

  /** AC3: an absence anywhere in `[today, today + leadTimeDays]`. */
  static derivedWindow(dates: string[], today: string, leadTimeDays: number): boolean {
    const end = AbsenceIndicatorPage.addDays(today, leadTimeDays);
    return dates.some((d) => d >= today && d <= end);
  }

  /** Days from today to the nearest absence on or after it, or null when there is none. */
  static daysToNextAbsence(dates: string[], today: string): number | null {
    const up = dates.filter((d) => d >= today).sort();
    if (!up.length) return null;
    return Math.round((Date.parse(`${up[0]}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /** Opens the CRM, finds a practice by name and opens its detail view. */
  async openPractice(nameFragment: string): Promise<void> {
    if (!this.page) throw new Error('constructed without a Page');
    this.page.on('request', (r) => {
      if (r.url().includes('therapist-absence-indicators')) {
        this.requests.push(decodeURIComponent(r.url().split('api.staging.therapios.de')[1] ?? ''));
      }
    });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto(`${WEB}/crm`, { waitUntil: 'domcontentloaded' });
    await this.page.getByText(/Heute bestellen/).first().waitFor({ timeout: 240_000 });
    await this.page.waitForTimeout(12_000);
    const box = this.page.getByPlaceholder(/such/i).first();
    await box.click({ timeout: 60_000 });
    await box.fill(nameFragment);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(12_000);
    await this.page.getByText('Anzeigen', { exact: true }).first().click({ force: true, timeout: 60_000 });
    await this.page.waitForTimeout(12_000);
  }

  /** Switches to one of the practice detail tabs and waits for its list. */
  async openTab(label: 'Bestellung' | 'Nachverfolgung'): Promise<void> {
    this.requests.length = 0;
    await this.page!.getByText(label, { exact: true }).first().click({ force: true, timeout: 60_000 });
    await this.page!.waitForTimeout(16_000);
  }

  /** The indicator dots currently painted, with their computed colour and accessible name. */
  async dots(prefix: 'absence-today' | 'absence-window'): Promise<Dot[]> {
    return this.page!.evaluate((p) => [...document.querySelectorAll(`[data-testid^="${p}-"]`)].map((e) => ({
      testId: e.getAttribute('data-testid') ?? '',
      color: getComputedStyle(e).color,
      aria: e.getAttribute('aria-label'),
    })), prefix);
  }

  /** Every absence aria-label on the page — so a dot of the WRONG tone is visible. */
  async absenceLabels(): Promise<string[]> {
    return this.page!.evaluate(() => [...new Set([...document.querySelectorAll('[aria-label]')]
      .map((e) => e.getAttribute('aria-label') ?? '')
      .filter((t) => /abwesend/i.test(t)))]);
  }
}
