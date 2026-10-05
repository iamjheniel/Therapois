import type { APIRequestContext, Page } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3849 — the T Board v2 hint "N VOs laufen in 14 Tagen aus" counts only running,
 * non-follow-up VOs.
 *
 * Shipped as `76f76ff451d` (PR #3864) on `release/3.15.0`. Both halves are probeable:
 *
 *  - **API.** `Prescription::getFollowUpParentStatus()` is a NEW transient field in the
 *    `therapist-board:read` group, set by `PrescriptionGroupingService` beside `isFollowUp`. It
 *    could not exist before the fix, so its presence is the deployment probe — and it is the
 *    whole reason AC2 is implementable, since the VO a follow-up follows is usually NOT on the
 *    board (a parent that has just closed is exactly when the follow-up starts counting).
 *  - **App.** `HINT_PREDICATES.expiring` in `useBoardRows.ts`, which drives BOTH the hint's count
 *    and the rows "Diese anzeigen" lists — one predicate, so AC3 holds by construction.
 *
 * The board reads `GET /therapist-prescription-groups?therapist=<id>`, so the painted hint can be
 * compared against the payload it was drawn from (#3471's technique).
 */

export const API_BASE = 'https://api.staging.therapios.de';

/** AC1: the five statuses in which a VO can no longer be acted on. */
export const CLOSED_STATUSES = [
  'Abgerechnet',
  'Fertig Behandelt',
  'Abgebrochen',
  'Abgelaufen',
  'Archiviert',
] as const;

/**
 * Statuses the T Board does not list at all.
 *
 * NOT part of this ticket — unchanged since 9 Aug 2026 — but load-bearing for the oracle: the
 * hint draws from the rows the board shows, so a VO in one of these is never counted however its
 * validity reads. The PM corrected AC1's wording to say exactly this on 5 Oct 2026. Leave them in
 * and the computed hint over-counts by precisely the number of them in the window.
 */
export const NOT_SHOWN_STATUSES = ['Bereit', 'For Review', 'Pending', 'Sent Back to Therapist'] as const;

export const EXPIRING_DAYS = 14;

export type BoardRow = {
  id: number;
  number: string;
  treatmentStatus: string;
  validityDate: string | null;
  isFollowUp: boolean;
  followUpParentStatus: string | null;
  /** Which array of which section it came from — `completed` is the inactive pool. */
  kind: 'prescriptions' | 'completed';
  section: 'active' | 'others';
};

/** ───────────────── the shipped predicate, ported ───────────────── */

/** `isStillRunning` from `useBoardRows.ts`. */
export function isStillRunning(status: string | null | undefined): boolean {
  return !(CLOSED_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * `countsTowardExpiryHint` from `useBoardRows.ts`, verbatim.
 *
 * Note the deliberate FAIL-OPEN on an unknown parent: only a KNOWN, still-running predecessor
 * holds a follow-up back, because an over-count is a row the therapist can dismiss while an
 * under-count is work that never reaches them. A port that treated a missing parent status as
 * "running" would under-count and read as the fix being too aggressive.
 */
export function countsTowardExpiryHint(row: {
  treatmentStatus?: string | null;
  isFollowUp?: boolean;
  followUpParentStatus?: string | null;
}): boolean {
  if (!isStillRunning(row.treatmentStatus)) return false;
  const parent = row.followUpParentStatus;
  if (row.isFollowUp && parent && isStillRunning(parent)) return false;
  return true;
}

/** Berlin start-of-day difference, as `daysUntilExpiry` computes it. */
export function daysUntilExpiry(validityDate: string | null, today: string): number | null {
  if (!validityDate) return null;
  const v = Date.parse(`${validityDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(v)) return null;
  return Math.round((v - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Today in the business timezone, which is what the board uses. */
export function berlinToday(now: Date = new Date()): string {
  return now.toLocaleString('en-CA', { timeZone: 'Europe/Berlin' }).slice(0, 10);
}

export class ExpiryHintPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  private async get<T = any>(path: string): Promise<T> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
          timeout: 180_000,
        });
        if (res.ok()) return (await res.json()) as T;
        last = `status ${res.status()}`;
        if (res.status() < 500) break;
      } catch (e) {
        last = String(e).slice(0, 120);
      }
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  /**
   * Every row of a therapist's board, from the payload the board itself reads.
   *
   * TWO TRAPS IN THE SHAPE. The response wraps everything in a SINGLE Hydra member, and each
   * patient group carries TWO arrays: `prescriptions` (the active rows) and **`completed`** — the
   * closed VOs that render under "Inaktive Patienten". The hint pool is both, which is the whole
   * bug this ticket fixes, so reading only `prescriptions` makes the fix look like it drops
   * nothing at all.
   */
  async boardRows(therapistId: number): Promise<BoardRow[]> {
    const body = await this.get<{ member: any[] }>(
      `/therapist-prescription-groups?therapist=${therapistId}`,
    );
    const root = (body.member ?? [])[0] ?? {};
    const out: BoardRow[] = [];
    const seen = new Set<number>();
    for (const section of ['active', 'others'] as const) {
      for (const group of root[section] ?? []) {
        for (const kind of ['prescriptions', 'completed'] as const) {
          for (const v of group[kind] ?? []) {
            if (seen.has(v.id)) continue;
            seen.add(v.id);
            out.push({
              id: Number(v.id),
              number: String(v.prescriptionId ?? ''),
              treatmentStatus: String(v.treatmentStatus ?? ''),
              validityDate: v.validityDate ? String(v.validityDate).slice(0, 10) : null,
              isFollowUp: Boolean(v.isFollowUp),
              followUpParentStatus: v.followUpParentStatus ?? null,
              kind,
              section,
            });
          }
        }
      }
    }
    return out;
  }

  /** The rows the board actually lists — the hint's pool. */
  static shown(rows: BoardRow[]): BoardRow[] {
    return rows.filter((r) => !(NOT_SHOWN_STATUSES as readonly string[]).includes(r.treatmentStatus));
  }

  /** Rows whose validity falls in the 0..14-day window — the hint under the OLD rule. */
  static inWindow(rows: BoardRow[], today: string): BoardRow[] {
    return rows.filter((r) => {
      const d = daysUntilExpiry(r.validityDate, today);
      return d !== null && d >= 0 && d <= EXPIRING_DAYS;
    });
  }

  /** The hint under #3849. */
  static expected(rows: BoardRow[], today: string): BoardRow[] {
    return ExpiryHintPage.inWindow(ExpiryHintPage.shown(rows), today).filter(countsTowardExpiryHint);
  }

  /** Does the payload carry the new field at all, and only where it should? */
  static parentStatusCoverage(rows: BoardRow[]): { followUps: number; withParent: number; nonFollowUpsWithParent: number } {
    const followUps = rows.filter((r) => r.isFollowUp);
    return {
      followUps: followUps.length,
      withParent: followUps.filter((r) => r.followUpParentStatus !== null).length,
      nonFollowUpsWithParent: rows.filter((r) => !r.isFollowUp && r.followUpParentStatus !== null).length,
    };
  }

  /** A VO by its number, for pinning a fixture's status before it is relied on. */
  async voByNumber(number: string): Promise<any | null> {
    const b = await this.get<{ member: any[] }>(
      `/prescriptions?exact[prescriptionId]=${encodeURIComponent(number)}&itemsPerPage=1`,
    );
    return (b.member ?? [])[0] ?? null;
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /**
   * Read the expiry hint's headline and the rows "Diese anzeigen" then lists.
   *
   * The caller opens the board — this only drives the Hinweise panel, so the board page object
   * stays the one place that knows how to get there.
   */
  static async readHint(page: Page, board: { openHinweise: () => Promise<void>; hinweiseHeadlines: () => Promise<string[]>; hinweiseShowAll: (i: number) => any }): Promise<{
    headline: string;
    count: number;
    listed: string[];
  }> {
    await board.openHinweise();
    await page.waitForTimeout(2000);
    const headlines = await board.hinweiseHeadlines();
    const index = headlines.findIndex((h) => /laufen in \d+ Tagen aus/.test(h));
    if (index < 0) throw new Error(`no expiry hint among: ${JSON.stringify(headlines)}`);
    const headline = headlines[index];
    const count = Number(headline.match(/(\d+)/)?.[1] ?? -1);
    await board.hinweiseShowAll(index).click({ timeout: 30_000 });
    await page.waitForTimeout(8000);
    const listed = await page
      .locator('[data-testid^="v2-rail-cell-prescriptionId"]')
      .evaluateAll((els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean));
    return { headline, count, listed };
  }
}
