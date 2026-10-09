import { APIRequestContext, Page, Locator } from '@playwright/test';
import { STAGING_CREDENTIALS, type Credentials, seedRefreshToken } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

/**
 * RC 3.15 #3797 — every screen shows the saved values right after a save.
 * Commit e568e9cf2 (MutationCache invalidates the mutated resource) + PR #3946 (2026-10-03 23:39Z),
 * which fixed the PM's one failure: a browser RELOAD within ~3 s of a save restored the PRE-save
 * copy of the persisted React Query cache (`therapios\REACT_QUERY_OFFLINE_CACHE`, written on a
 * 3 s throttle) and served it as fresh for the 60 s staleTime.
 *
 * Every screen tested here is a plain list → `/{id}/edit` form → "Speichern" flow, so one page
 * object drives all of them from a {@link Screen} description.
 */
export type Screen = {
  key: string;
  /** App route of the list, e.g. `/ech`. */
  listPath: string;
  /** API collection, e.g. `/elderly_care_homes`. */
  apiPath: string;
  id: number;
  /** A search that finds the record whatever the edited field holds. */
  search: string;
  /** Text on the record's list row that does not change, to locate the row. */
  rowAnchor: string;
  /** Form label above the edited field. */
  fieldLabel: string;
  /** The API property behind that field. */
  apiField: string;
};

export class SaveRefreshPage {
  private token = '';
  readonly writes: { method: string; url: string; body: any; at: number }[] = [];

  constructor(private request: APIRequestContext, readonly page: Page) {}

  // ───────────────────────────── API ─────────────────────────────

  async init(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password }, timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  private h(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json', ...extra };
  }

  async read(s: Screen): Promise<any> {
    const res = await this.request.get(`${API}${s.apiPath}/${s.id}`, { headers: this.h(), timeout: 60_000 });
    if (!res.ok()) throw new Error(`GET ${s.apiPath}/${s.id} -> ${res.status()}`);
    return res.json();
  }

  /** A direct write — used to restore fixtures and to probe a refused value, never as evidence of the UI. */
  async patch(s: Screen, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const res = await this.request.patch(`${API}${s.apiPath}/${s.id}`, {
      headers: this.h({ 'Content-Type': 'application/merge-patch+json' }), data: body, timeout: 60_000,
    });
    return { status: res.status(), body: await res.text() };
  }

  async cacheControl(path: string): Promise<string | null> {
    const res = await this.request.get(`${API}${path}`, { headers: this.h(), timeout: 60_000 });
    return res.headers()['cache-control'] ?? null;
  }

  // ───────────────────────────── session ─────────────────────────────

  /**
   * Signs the tab in so that a RELOAD keeps the session (#3761's technique): the refresh token is
   * single-use (#3460), so it is installed once per token behind a localStorage marker and the
   * app's own rotated replacement survives every later navigation.
   */
  async seedSession(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password }, timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    const refresh = (await res.json()).refresh_token as string;
    // IndexedDB + localStorage, once per token (see seedRefreshToken: since #3910 the app reads IndexedDB first).
    await seedRefreshToken(this.page, refresh, { once: true });
    this.page.on('request', (r) => {
      if (r.url().startsWith(API) && ['PATCH', 'POST', 'DELETE', 'PUT'].includes(r.method())
          && !/\/(auth|token\/refresh)/.test(r.url())) {
        let body: any = r.postData();
        try { body = JSON.parse(body ?? ''); } catch { /* raw */ }
        this.writes.push({ method: r.method(), url: r.url().slice(API.length), body, at: Date.now() });
      }
    });
  }

  // ───────────────────────────── the screens ─────────────────────────────

  private searchBox(): Locator {
    return this.page.locator('#root input[data-testid="text-input-outlined"][placeholder]:visible').first();
  }

  /** Waits for a list screen's search box after a reload landed on it. */
  async waitForList(): Promise<void> {
    await this.searchBox().waitFor({ timeout: 180_000 });
  }

  async openList(s: Screen): Promise<void> {
    await this.page.goto(`${WEB}${s.listPath}`, { waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ timeout: 180_000 });
  }

  /** Types a search and waits for the record's row. */
  async search(s: Screen, term = s.search): Promise<void> {
    let box = this.searchBox();
    // A searched list's box goes `readonly` after Enter (the Admin Dashboard quirk), so a second
    // search needs the list freshly opened. The navigation is a full load, so it ALSO restores the
    // persisted query cache — which keeps the read honest rather than weakening it.
    if ((await box.getAttribute('readonly')) !== null) {
      await this.openList(s);
      box = this.searchBox();
    }
    await box.fill(term);
    await box.press('Enter');
    await this.page.getByText(s.rowAnchor, { exact: true }).locator('visible=true').first().waitFor({ timeout: 90_000 });
  }

  /** The texts painted on the record's list row (every leaf on the anchor's line). */
  async rowTexts(s: Screen): Promise<string[]> {
    return this.page.evaluate((anchor) => {
      const leaves = [...document.querySelectorAll('#root *')].filter((e) => {
        const b = e.getBoundingClientRect(); return e.children.length === 0 && b.width > 0 && b.height > 0;
      });
      const a = leaves.find((e) => (e.textContent ?? '').trim() === anchor);
      if (!a) return [];
      const y = a.getBoundingClientRect().top;
      return leaves.filter((e) => Math.abs(e.getBoundingClientRect().top - y) < 14)
        .map((e) => (e.textContent ?? '').trim()).filter(Boolean);
    }, s.rowAnchor);
  }

  /** Opens the record's form from its list row (the rightmost focusable element on the row). */
  async openForm(s: Screen): Promise<void> {
    const pt = await this.page.evaluate((anchor) => {
      const leaf = [...document.querySelectorAll('#root *')].find((e) => {
        const b = e.getBoundingClientRect();
        return e.children.length === 0 && b.width > 0 && b.height > 0 && (e.textContent ?? '').trim() === anchor;
      });
      if (!leaf) return null;
      const r = leaf.getBoundingClientRect();
      const cands = [...document.querySelectorAll('#root [tabindex="0"], #root [role="button"]')]
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.height > 0 && b.width < 80 && Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) < 20);
      const b = cands.sort((x, y) => y.left - x.left)[0];
      return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    }, s.rowAnchor);
    if (!pt) throw new Error(`no action button on the row of ${s.rowAnchor}`);
    await this.page.mouse.click(pt.x, pt.y);
    await this.page.waitForURL(new RegExp(`${s.listPath}/${s.id}/edit`), { timeout: 60_000 });
    await this.page.getByText('Speichern', { exact: true }).first().waitFor({ timeout: 60_000 });
  }

  /** The text input placed under a form label. */
  async field(label: string): Promise<Locator> {
    const idx = await this.page.evaluate((label) => {
      const lab = [...document.querySelectorAll('#root *')].find((e) => {
        const b = e.getBoundingClientRect();
        return e.children.length === 0 && b.width > 0 && b.height > 0 && (e.textContent ?? '').trim() === label;
      });
      if (!lab) return -1;
      const lb = lab.getBoundingClientRect();
      const inputs = [...document.querySelectorAll('#root input[data-testid="text-input-outlined"]')];
      // Indices are over ALL inputs (the locator below is not visibility-filtered); a hidden one has
      // a zero rect and so can never be the nearest below a visible label.
      let best = -1; let bestD = Infinity;
      inputs.forEach((e, i) => {
        const b = e.getBoundingClientRect();
        const dy = b.top - lb.top;
        if (b.height > 0 && dy > 0 && dy < 60 && Math.abs(b.left - lb.left) < 20 && dy < bestD) { bestD = dy; best = i; }
      });
      return best;
    }, label);
    if (idx < 0) throw new Error(`no input under "${label}"`);
    return this.page.locator('#root input[data-testid="text-input-outlined"]').nth(idx);
  }

  /** Waits until the form's field holds a value (the form paints before the record lands). */
  async fieldValue(s: Screen, expected?: string): Promise<string> {
    let v = '';
    for (let i = 0; i < 60; i++) {
      v = await (await this.field(s.fieldLabel)).inputValue();
      if (expected === undefined ? v !== '' : v === expected) return v;
      await this.page.waitForTimeout(500);
    }
    return v;
  }

  /**
   * Types `value` and saves. Resolves when the PATCH has answered; returns that moment so the
   * caller can reload at a measured delay after it.
   */
  async save(s: Screen, value: string): Promise<{ status: number; at: number }> {
    const f = await this.field(s.fieldLabel);
    await f.fill(value);
    const resp = this.page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().endsWith(`${s.apiPath}/${s.id}`), { timeout: 60_000 });
    await this.page.getByText('Speichern', { exact: true }).last().click({ timeout: 30_000 });
    const r = await resp;
    return { status: r.status(), at: Date.now() };
  }

  /** ms until the persisted query cache contains `needle`, or -1 within `budget`. */
  async persistedWithin(needle: string, budget = 6_000): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      const hit = await this.page.evaluate((needle) => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          if (k.includes('REACT_QUERY_OFFLINE_CACHE') && (localStorage.getItem(k) ?? '').includes(needle)) return true;
        }
        return false;
      }, needle).catch(() => false);
      if (hit) return Date.now() - t0;
      await this.page.waitForTimeout(50);
    }
    return -1;
  }
}
