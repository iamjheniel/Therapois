import { APIRequestContext, Page, Locator } from '@playwright/test';
import { mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

export type IkField = 'ikPhysiotherapy' | 'ikErgotherapy' | 'ikSpeechtherapy';

/**
 * RC 3.15 #3815 (PR #3840, follow-up #3945): on an EXISTING Gesellschaft the IK row's check mark
 * and its confirmed delete each send their own `PATCH /entities/{id}` carrying that ONE field.
 *
 * The form lives at `/entities` with no route of its own (the URL does not change when a
 * Gesellschaft is opened), and the IK table carries testids keyed by field:
 * `ik-add-` / `ik-edit-` / `ik-delete-` / `ik-input-` / `ik-confirm-` / `ik-saving-<field>`.
 * The rest of the form has no testids — every text input is `text-input-outlined` — so fields are
 * found by their label's position.
 */
export class EntityIkSavePage {
  private token = '';
  /** Every non-GET request to `/entities`, oldest first. */
  readonly writes: { method: string; url: string; body: any }[] = [];

  static readonly SAVED = 'IK-Nummer gespeichert.';
  static readonly FAILED_PREFIX = 'IK-Nummer konnte nicht gespeichert werden: ';
  static readonly REMOVE_TITLE = 'IK-Nummer entfernen?';
  static removeMessage(therapy: string, number: string, entity: string): string {
    return `Die IK-Nummer ${therapy} ${number} wird sofort aus ${entity} entfernt. ` +
      'VOs dieser Therapieform können für diese Gesellschaft ohne IK-Nummer nicht abgerechnet werden.';
  }

  constructor(private request: APIRequestContext, readonly page: Page) {}

  // ───────────────────────────── API ─────────────────────────────

  async init(): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: STAGING_CREDENTIALS.superadmin.email, password: STAGING_CREDENTIALS.superadmin.password },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  async entity(id: number): Promise<any> {
    const res = await this.request.get(`${API}/entities/${id}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' }, timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`GET /entities/${id} -> ${res.status()}`);
    return res.json();
  }

  /** Restores fields directly — used for fixture repair, never as evidence. */
  async patch(id: number, body: Record<string, unknown>): Promise<void> {
    const res = await this.request.patch(`${API}/entities/${id}`, {
      headers: {
        Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json',
        'Content-Type': 'application/merge-patch+json',
      },
      data: body, timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`PATCH /entities/${id} -> ${res.status()} ${await res.text()}`);
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /** Mints a session ONCE (single-use refresh token, #3460) and lands on the list. */
  async open(): Promise<void> {
    this.page.on('request', (r) => {
      if (r.url().startsWith(`${API}/entities`) && r.method() !== 'GET') {
        let body: any = r.postData();
        try { body = JSON.parse(body ?? ''); } catch { /* keep raw */ }
        this.writes.push({ method: r.method(), url: r.url().slice(API.length), body });
      }
    });
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    await this.page.goto(`${WEB}/entities`, { waitUntil: 'domcontentloaded' });
    await this.page.getByText('Entitätsverwaltung').first().waitFor({ timeout: 180_000 });
  }

  /** Opens a Gesellschaft from the list by clicking the pencil on its row. */
  async openEntity(name: string): Promise<void> {
    const cell = this.page.getByText(name, { exact: true }).first();
    await cell.waitFor({ timeout: 120_000 });
    const pencil = await this.page.evaluate((name) => {
      const leaf = [...document.querySelectorAll('#root *')]
        .find((e) => e.children.length === 0 && (e.textContent ?? '').trim() === name)!;
      const r = leaf.getBoundingClientRect();
      const btns = [...document.querySelectorAll('#root [role="button"], #root button, #root [tabindex="0"]')]
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.height > 0 && Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) < 15 && b.left > r.right);
      const b = btns.sort((x, y) => y.left - x.left)[0];
      return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    }, name);
    if (!pencil) throw new Error(`no pencil on the row of ${name}`);
    await this.page.mouse.click(pencil.x, pencil.y);
    await this.page.getByText('Gesellschaft bearbeiten').first().waitFor({ timeout: 120_000 });
    await this.page.getByText('IK-Nummern').first().waitFor({ timeout: 60_000 });
    // The form paints before the entity's values land; wait for the Name field to be filled.
    for (let i = 0; i < 40; i++) {
      if ((await (await this.input('Name *')).inputValue()) === name) break;
      await this.page.waitForTimeout(500);
    }
  }

  /** The text input placed under a form label. */
  async input(label: string): Promise<Locator> {
    const idx = await this.page.evaluate((label) => {
      const lab = [...document.querySelectorAll('#root *')]
        .find((e) => e.children.length === 0 && (e.textContent ?? '').trim() === label);
      if (!lab) return -1;
      const ly = lab.getBoundingClientRect().top;
      const inputs = [...document.querySelectorAll('#root input[data-testid="text-input-outlined"]')];
      let best = -1; let bestDy = Infinity;
      inputs.forEach((e, i) => {
        const dy = e.getBoundingClientRect().top - ly;
        if (dy > 0 && dy < bestDy) { bestDy = dy; best = i; }
      });
      return best;
    }, label);
    if (idx < 0) throw new Error(`no input under "${label}"`);
    return this.page.locator('#root input[data-testid="text-input-outlined"]').nth(idx);
  }

  tid(kind: 'add' | 'edit' | 'delete' | 'input' | 'confirm' | 'saving', field: IkField): Locator {
    return this.page.getByTestId(`ik-${kind}-${field}`);
  }

  /** The IK text field in edit mode (the testid may sit on the input or on its wrapper). */
  async ikInput(field: IkField): Promise<Locator> {
    const el = this.tid('input', field).first();
    await el.waitFor({ timeout: 30_000 });
    const tag = await el.evaluate((e) => e.tagName);
    return tag === 'INPUT' ? el : el.locator('input').first();
  }

  /** The value painted in an IK row's "IK-Nummer" column (its leaf on the row's line). */
  async rowValue(therapy: string): Promise<string | null> {
    return this.page.evaluate((therapy) => {
      const leaves = [...document.querySelectorAll('#root *')].filter((e) => e.children.length === 0);
      const lab = leaves.find((e) => (e.textContent ?? '').trim() === therapy);
      const head = leaves.find((e) => (e.textContent ?? '').trim() === 'IK-Nummer');
      if (!lab || !head) return null;
      const y = lab.getBoundingClientRect().top; const hx = head.getBoundingClientRect().left;
      const hit = leaves.find((e) => {
        const b = e.getBoundingClientRect();
        return Math.abs(b.top - y) < 12 && Math.abs(b.left - hx) < 20 && (e.textContent ?? '').trim();
      });
      return hit ? (hit.textContent ?? '').trim() : null;
    }, therapy);
  }

  /** "Cancel" at the bottom of the form, back to the list. */
  async cancelForm(): Promise<void> {
    await this.page.getByText('Cancel', { exact: true }).last().click({ timeout: 30_000 });
    await this.page.getByText('Entitätsverwaltung').first().waitFor({ timeout: 60_000 });
  }

  /** The writes made since `mark`. */
  since(mark: number) { return this.writes.slice(mark); }
}
