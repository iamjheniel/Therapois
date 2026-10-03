import { APIRequestContext, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3869 — creating or changing a practice becomes Admin-only, matching the
 * rule that already governed deleting one and editing its BSNRs (fix `ff7f527bf`:
 * `security: is_granted('ROLE_ADMIN')` on Practice's Post and Patch).
 *
 * **This is an authorization ticket, so it is verified as a MATRIX OF STATUS CODES and
 * never by writing.** Every probe below either (a) is refused, which by definition
 * writes nothing — and a refusal that ever stops being one IS the vulnerability; or
 * (b) names an id that matches nothing, so there is nothing to write even when
 * authorization passes; or (c) is an empty merge-patch whose no-change is asserted by
 * a full before/after body diff.
 *
 * **THE ABSENT-ID PROBE IS THE KEY, and it works because authorization runs BEFORE the
 * object is fetched.** `PATCH /practices/99999999` answers **403 for a therapist and
 * 404 for an admin**, so one request proves the gate refuses one role and lets the
 * other through to a handler that has nothing to act on. Without it, showing "the
 * admin is still allowed" would mean actually creating or changing a practice.
 *
 * **THE MESSAGE IS THE DISCRIMINATOR, not the status.** A bare 403 cannot say WHICH
 * rule fired. The fix ships its own wording while the neighbouring resources keep
 * Symfony's generic one, so the three are told apart by what they say:
 *
 * | Resource | Therapist is refused with |
 * |---|---|
 * | `/practices` Post | `Only administrators can create practices.` ← new |
 * | `/practices` Patch | `Only administrators can change practices.` ← new |
 * | `/practices` Delete | `Only administrators can delete practices.` (pre-existing) |
 * | `/practice_bsnrs`, `/practice_contacts` | `Access Denied.` (pre-existing, generic) |
 * | `/practice_activities` | not refused at all — no role gate, and the ticket keeps it that way |
 *
 * **Trap:** an empty body is NOT a usable probe everywhere. `POST /practice_activities`
 * with `{}` answers **500 for every role**, so it discriminates nothing and reads like
 * a server fault rather than an authorization answer; the absent-id form answers a
 * clean 404/404 there instead. Prove the probe shape works on the resource before
 * reading a role rule out of it.
 *
 * **Run at `--workers=1`:** three tokens are minted per run and #3462 throttles
 * `POST /auth` at 5 per minute per username.
 */

export type Probe = { status: number; message: string };

/** The refusal wordings, as shipped. */
export const DENIAL = {
  create: 'Only administrators can create practices.',
  change: 'Only administrators can change practices.',
  delete: 'Only administrators can delete practices.',
  /** Symfony's generic refusal, kept by the neighbouring resources. */
  generic: 'Access Denied.',
} as const;

/**
 * An id that matches no row, so a request naming it writes nothing even when
 * authorization lets it through.
 */
export const ABSENT_ID = 99_999_999;

/** The ticket's own Steps to Reproduce fixture. */
export const REPRO_PRACTICE = { id: 1, practiceId: '723253500', name: 'Vantis Hausarztpraxis Mariendorf' } as const;

const MERGE_PATCH = 'application/merge-patch+json';

export class PracticeWriteRolesPage {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly request: APIRequestContext) {}

  /** Mint once per role and cache — #3462 throttles /auth at 5/min per username. */
  async token(role: 'therapist' | 'admin' | 'superadmin'): Promise<string> {
    const cached = this.tokens.get(role);
    if (cached) return cached;
    const creds: Credentials = STAGING_CREDENTIALS[role];
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth for ${role} -> ${res.status()}`);
    const token = (await res.json()).token as string;
    this.tokens.set(role, token);
    return token;
  }

  /** The roles a token actually carries, so a leg states the role it ran as (#3749). */
  async rolesOf(role: 'therapist' | 'admin' | 'superadmin'): Promise<string[]> {
    const token = await this.token(role);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.roles ?? [];
  }

  async call(
    role: 'therapist' | 'admin' | 'superadmin',
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Probe> {
    const token = await this.token(role);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/ld+json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = method === 'PATCH' ? MERGE_PATCH : 'application/ld+json';
    }
    const res = await this.request.fetch(`${API_BASE}${path}`, {
      method,
      headers,
      data: body === undefined ? undefined : JSON.stringify(body),
      timeout: 60_000,
    });
    const text = await res.text();
    let message = '';
    try {
      const json = JSON.parse(text);
      message = json['hydra:description'] ?? json.description ?? json.detail ?? json.title ?? '';
    } catch {
      message = text.slice(0, 120);
    }
    return { status: res.status(), message: String(message) };
  }

  /** The full serialized practice, for a before/after diff. */
  async practice(role: 'therapist' | 'admin' | 'superadmin', id: number): Promise<unknown> {
    const token = await this.token(role);
    const res = await this.request.get(`${API_BASE}/practices/${id}?groups%5B%5D=practice:detail`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 60_000,
    });
    expect(res.status(), `reading practice ${id}`).toBe(200);
    return res.json();
  }

  async totalPractices(role: 'therapist' | 'admin' | 'superadmin' = 'admin'): Promise<number> {
    const token = await this.token(role);
    const res = await this.request.get(`${API_BASE}/practices?itemsPerPage=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 60_000,
    });
    return (await res.json()).totalItems as number;
  }

  /** Refused for this role, with the shipped wording and naming no caller. */
  static expectRefused(probe: Probe, expected: string, label: string): void {
    expect(probe.status, `${label}: refused`).toBe(403);
    expect(probe.message, `${label}: the shipped refusal wording`).toContain(expected);
  }

  /** Reached the handler: anything but a 403, so authorization let this role through. */
  static expectAllowedThrough(probe: Probe, label: string): void {
    expect(probe.status, `${label}: authorization let this role past (not 403)`).not.toBe(403);
    expect(probe.status, `${label}: and it is not an auth failure either`).not.toBe(401);
  }
}
