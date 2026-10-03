import { Page, expect } from '@playwright/test';
import { WorkingHoursAbrechnungPage } from './sa.working-hours-abrechnung.page';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3729 — the Arbeitszeiten traffic-light dot explains itself on hover
 * (commit `d1286327b`).
 *
 * The dot shows a rolling 5-day window while the Effizienz column beside it shows the
 * selected period, so the two legitimately disagree; management read that as a defect.
 * The fix adds the info icon and tooltip the TO Management dot already had.
 *
 * **THERE IS A REAL API SURFACE, which is what makes this more than a screenshot
 * ticket.** `EfficiencyBucketRow` gained four pass-through fields —
 * `efficiencyPercent`, `qualifyingDays`, `windowStart`, `windowEnd` — so
 * `GET /kpis/management/efficiency-buckets` both probes the deployment and carries every
 * number the tooltip prints.
 *
 * **THE TICKET'S OWN DEVELOPER CHECK IS A JOIN, and it is done here on live data rather
 * than as a snapshot:** "verify … the Arbeitszeiten table's dot shows the tooltip using
 * the same underlying values that the TO Management screen's dot already receives for
 * the same therapist". TO Management reads `/therapist-performance` (#3486), so the two
 * are compared therapist by therapist — with an anti-vacuity guard, because both
 * endpoints OMIT the three window fields when they are null and a naive comparison of
 * two absent values passes while testing nothing.
 *
 * **AC1 and AC3 are one condition, and it is readable in the bundle verbatim:**
 *
 * ```js
 * o = de.includes(t) && null != l && null != l.efficiencyPercent,
 * a = View({testID:`bucket-marker-${e}`, children:[ View({testID:`bucket-dot-${e}`,…}),
 *       o ? Icon({name:"information-circle-outline",…}) : null ]});
 * return o && null != l ? Tooltip({body: efficiencyTooltipBody(l,n), trigger:a}) : a
 * ```
 *
 * One flag gates the icon AND the tooltip, and `grau` / `abwesend` carry no
 * `efficiencyPercent`, so AC3 holds by construction rather than by a second branch.
 *
 * **Traps:**
 *  - `/kpis/management/efficiency-buckets` **strips `from`/`to`** (#3242 AC2), which is
 *    the whole point of AC4 — the window is per-therapist and rolling, not the selected
 *    period. 50 distinct windows across the roster on 2026-10-03.
 *  - The board opens in **Gruppen** view, whose rows are team toggles, so the therapist
 *    dots do not exist until the view is switched (#3718/#3725).
 *  - **Read the dots only after one has painted.** The heading and both toggles render
 *    long before `efficiency-buckets` answers, and reading early yields zero dots, which
 *    looks exactly like the feature being absent (#3575 hit this).
 *  - Staging carries **only rot, grau and abwesend** — 0 gelb and 0 gruen of 236 — so
 *    AC1 is exercised on red alone and AC4's "two green percentages, two dot colours"
 *    pair cannot be built here at all. Measured each run rather than assumed.
 */

/** Buckets that get the icon and tooltip. */
export const COLOURED_BUCKETS = ['rot', 'gelb', 'gruen'] as const;
/** Buckets that must get neither (AC3). */
export const SILENT_BUCKETS = ['grau', 'abwesend'] as const;

/** The three wording keys, shared with the TO Management dot so they cannot drift. */
export const TOOLTIP_KEYS = [
  'performanceDashboard.trafficLight.efficiency',
  'performanceDashboard.trafficLight.basedOnDays',
  'performanceDashboard.trafficLight.limitedData',
] as const;

export type BucketRow = {
  therapistId: number;
  bucket: string;
  active?: boolean;
  qualifyingDays?: number;
  efficiencyPercent?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
};

export type Marker = {
  therapistId: number;
  bucket: string | null;
  /** The marker's child count: 2 with an info icon, 1 without. */
  children: number;
  hasIcon: boolean;
};

export class DotTooltipPage {
  readonly board: WorkingHoursAbrechnungPage;

  constructor(private readonly page: Page) {
    this.board = new WorkingHoursAbrechnungPage(page);
  }

  /**
   * Open the Arbeitszeiten table in Therapeut:innen view, at whatever period the board
   * defaults to.
   *
   * Deliberately NOT #3575's `openArbeitszeiten()`, which steps six months back to April
   * 2026 for its own four-colour fixture: that is six slow board reloads, and it is
   * pointless here because the dot's window is period-independent — which is AC4.
   */
  async openForDots(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.board.open();
    await this.board.selectView('Therapeut:innen');
    await this.waitForMarkers();
  }

  /**
   * Readiness is a painted MARKER, not the heading or the rows.
   *
   * The section and both toggles render long before `efficiency-buckets` answers — the
   * slowest pair on this board — and reading markers early returns `[]`, which looks
   * exactly like the feature being absent (#3575 hit this on its own dots).
   */
  async waitForMarkers(timeout = 240_000): Promise<void> {
    await expect
      .poll(async () => (await this.markers()).length, { timeout, intervals: [2_000] })
      .toBeGreaterThan(0);
  }


  // ── API reads ────────────────────────────────────────────────────────────
  // Kept here rather than on WorkingHoursDotPage, which four other specs share.

  private token: string | null = null;

  private async apiToken(): Promise<string> {
    if (this.token) return this.token;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.page.request.post(`${API_BASE}/auth`, {
          headers: { 'Content-Type': 'application/json' },
          data: {
            username: STAGING_CREDENTIALS.superadmin.email,
            password: STAGING_CREDENTIALS.superadmin.password,
          },
          timeout: 60_000,
        });
        if (res.ok()) {
          this.token = (await res.json()).token;
          return this.token!;
        }
      } catch {
        /* a socket hang up throws before any status exists — retry (#3872) */
      }
      await this.page.waitForTimeout(3_000 * (attempt + 1));
    }
    throw new Error('POST /auth failed after 3 attempts');
  }

  private async apiGet(path: string): Promise<any> {
    const token = await this.apiToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.page.request.get(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
          timeout: 240_000,
        });
        if (res.status() < 500) return res.json();
      } catch {
        /* as above */
      }
      await this.page.waitForTimeout(4_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} failed after 3 attempts`);
  }

  /**
   * The buckets endpoint, unwrapped either way.
   *
   * #3705 recorded this as a BARE ARRAY; it now answers as a Hydra collection, so the
   * unwrap must accept both or a future (or past) build silently yields zero rows —
   * which reads exactly like "no therapists".
   */
  async rawBuckets(window?: { from: string; to: string }): Promise<BucketRow[]> {
    const query = window ? `?from=${window.from}&to=${window.to}` : '';
    const body = await this.apiGet(`/kpis/management/efficiency-buckets${query}`);
    return (Array.isArray(body) ? body : body?.member ?? body?.['hydra:member'] ?? []) as BucketRow[];
  }

  /** What the TO Management dot reads (#3486). Rows are keyed by `id`, not `therapistId`. */
  async therapistPerformance(): Promise<
    { id: number; efficiencyPercent?: number | null; qualifyingDays?: number; windowStart?: string; windowEnd?: string }[]
  > {
    const body = await this.apiGet('/therapist-performance?itemsPerPage=10000');
    return (Array.isArray(body) ? body : body?.member ?? body?.['hydra:member'] ?? []) as never;
  }

  /** Every marker on screen, with whether it carries the info icon. */
  async markers(): Promise<Marker[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="bucket-marker-t"]')].map((node) => {
        const el = node as HTMLElement;
        const dot = el.querySelector('[data-testid^="bucket-dot-"]');
        const colour = dot ? getComputedStyle(dot as HTMLElement).backgroundColor : null;
        return {
          therapistId: Number(el.dataset.testid!.replace('bucket-marker-t', '')),
          bucket: colour,
          children: el.children.length,
          // the icon is the only sibling the dot ever gets
          hasIcon: el.children.length > 1,
        };
      }),
    );
  }

  /**
   * Hover a marker and read whatever tooltip appears.
   *
   * The board uses react-native-paper's `Tooltip`, which renders into the app-root
   * portal rather than inside the marker — so it is found by what appeared on the page,
   * not by walking down from the dot (the #3400 lesson on this board family).
   */
  async hoverTooltip(therapistId: number): Promise<string | null> {
    const before = await this.pageText();
    await this.page.getByTestId(`bucket-marker-t${therapistId}`).first().hover({ timeout: 30_000 });
    // Paper animates the tooltip in; poll rather than read once.
    let text: string | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await this.page.waitForTimeout(500);
      const now = await this.pageText();
      const added = now.filter((line) => !before.includes(line));
      const hit = added.find((line) => /Effizienz|Basierend auf|Eingeschränkte/.test(line));
      if (hit) {
        text = hit;
        break;
      }
    }
    // Move away so the next read is not of this tooltip.
    await this.page.mouse.move(5, 5);
    await this.page.waitForTimeout(800);
    return text;
  }

  private async pageText(): Promise<string[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('div,span')]
        .filter((e) => e.children.length === 0)
        .map((e) => (e as HTMLElement).innerText?.trim() ?? '')
        .filter(Boolean),
    );
  }

  /** The served entry bundle — the only surface that answers for a frontend change. */
  async bundle(): Promise<string> {
    const shell = await this.page.request.get('https://staging.therapios.de', { timeout: 90_000 });
    const name = [
      ...new Set(
        [...(await shell.text()).matchAll(/\/_expo\/static\/js\/web\/(entry-[A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]),
      ),
    ][0];
    expect(name, 'the shell references an entry bundle').toBeTruthy();
    const js = await this.page.request.get(`https://staging.therapios.de/_expo/static/js/web/${name}`, {
      timeout: 180_000,
    });
    expect(js.status()).toBe(200);
    return js.text();
  }

  static occurrences(js: string, literal: string): number {
    const plain = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escaped = [...literal]
      .map((ch) => {
        const code = ch.codePointAt(0)!;
        if (code < 128) return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return code < 256
          ? `\\\\x${code.toString(16).padStart(2, '0')}`
          : `\\\\u${code.toString(16).padStart(4, '0')}`;
      })
      .join('');
    const count = (pattern: string) => (js.match(new RegExp(pattern, 'g')) ?? []).length;
    return count(plain) + (escaped === plain ? 0 : count(escaped));
  }
}
