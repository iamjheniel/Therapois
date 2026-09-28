import { Page, expect } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';
import { FlowBoardsPage } from './sa.flow-boards.page';

/**
 * The Übersicht section heading. **#3770 renamed it from "Arbeitszeiten" on 2026-09-22**, so both
 * spellings are accepted: staging serves "Übersicht", Production is still on the pre-3.14 build and
 * serves "Arbeitszeiten", and these page objects back mirrored specs in both projects.
 */
export const OVERVIEW_HEADING = /^(Übersicht|Arbeitszeiten)$/;

/**
 * The per-therapist traffic-light dot in the Arbeitszeiten table — RC 3.13 #3575 (PR #3606).
 *
 * A 10px dot left of each therapist's name in the Therapeuten-Orga board's **Arbeitszeiten** table,
 * coloured by that therapist's efficiency bucket. Frontend only: `bucketByTherapistId` was already
 * passed into `WorkingHoursTable` and already used for the bucket filter — it was simply never
 * drawn. The change also extracted one shared `BUCKET_COLOR` module so the pills, the Management
 * detail table and this table cannot drift apart.
 *
 * **This is the ticket's outstanding work.** All five ACs are covered by jest in the PR; its author
 * recorded "visual QA on web and Android is still outstanding", so everything here is on screen.
 *
 * ## The two endpoints, and why the dot and its row disagree by design
 *
 * - `GET /kpis/management/working-hours` — the table's rows (122 therapists unfiltered), and it DOES
 *   take the board's `from`/`to`.
 * - `GET /kpis/management/efficiency-buckets` — `therapistId → bucket` for all 236 therapists, and it
 *   **strips `from`/`to` by design** (#3242 AC2). Verified: the payload is byte-identical with and
 *   without a period. So the dot describes a rolling window while the rest of the row describes the
 *   selected Periode — a therapist can show a red dot beside a green efficiency figure for a past
 *   period. Pre-existing (the same buckets already drive the row filter and the summary pills, which
 *   AC2 asks the dot to mirror) and flagged by the PR as a possible follow-up, not a defect.
 *
 * ## Fixture: April 2026
 *
 * The bucket map is period-independent, so only the ROW population moves with the period — and that
 * decides which colours are on screen. Unfiltered, the 122 rows carry just three buckets
 * (rot 115 / abwesend 6 / grau 1). **April 2026 is the best coverage on staging: 116 rows carrying
 * four of the five buckets — rot 103 / grau 6 / gruen 2 / abwesend 5.**
 *
 * Two AC cases have **no live fixture at all**, and neither is a defect:
 * - **Gelb**: `efficiency-buckets` places **0 of 236** therapists in `gelb`, in any period, so no
 *   yellow dot can render anywhere on staging.
 * - **AC5's "no bucket"**: the buckets endpoint returns every therapist, active or not, so the
 *   working-hours rows are always a subset of the map — 0 rows lack a bucket in every period probed.
 *   The state IS reachable on screen though, and honestly: `stubEmptyBuckets()` answers the buckets
 *   request with an empty collection, which is exactly the still-loading / not-placed case AC5
 *   describes. Nothing reaches the server.
 *
 * ## Traps
 *
 * - **The testid is keyed by the ROW key, not the therapist id** — `bucket-dot-t<therapistId>` for a
 *   therapist row (`key: \`t${row.therapistId}\``). Team rows key `g<teamId>` / `gnone` and are drawn
 *   by a different block, which is what makes AC4 structural.
 * - **The Management detail table's dot has NO testid**, so AC2's parity comparison locates it by
 *   shape (a 10x10 round View first in the name cell). It also wraps the Grau dot in an
 *   `InfoTooltip` (#3580), so that one sits one level deeper than the others.
 * - **Read the dots only after a row has painted.** The section heading renders long before the
 *   table has rows, and `working-hours` is one of the slowest KPI reads on staging; a probe that
 *   reads too early sees the toggles, zero dots and no team names — which looks exactly like the
 *   feature being absent. `waitForRows()` is the readiness condition.
 * - The Arbeitszeiten table's own Gruppen / Therapeut:innen toggle carries the **same labels** as the
 *   Management board's detail-table toggle. They are on different boards, so scoping by board is
 *   enough — but never assume a page-wide `getByText('Gruppen')` belongs to this table.
 */

/** The window that puts four of the five buckets on screen. */
export const APRIL_2026 = { from: '2026-04-01', to: '2026-04-30', label: 'April 2026' } as const;

export type BucketKey = 'rot' | 'gelb' | 'gruen' | 'grau' | 'abwesend';

export type Dot = {
  testId: string;
  therapistId: number;
  background: string;
  width: string;
  height: string;
  borderRadius: string;
  /** True when the dot is the first element in its name cell, i.e. before the name (AC1). */
  firstInNameCell: boolean;
  nameAfterDot: string;
};

export class WorkingHoursDotPage {
  private token = '';
  private boards!: FlowBoardsPage;

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3575: no bearer token');
  }

  private async get(path: string, timeout = 240_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(4_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  // ─────────────────────────────── the data behind the dots ───────────────────────────────

  /** `therapistId → bucket`, the map the dot is coloured from. Period-independent. */
  async bucketByTherapistId(window?: { from: string; to: string }): Promise<Map<number, BucketKey>> {
    const qs = window ? `?from=${window.from}&to=${window.to}` : '';
    const body = await this.get(`/kpis/management/efficiency-buckets${qs}`);
    // Hydra today, a bare array per #3705 — see the capture listener's note.
    const member = Array.isArray(body) ? body : ((body as any).member ?? (body as any)['hydra:member'] ?? []);
    const out = new Map<number, BucketKey>();
    for (const row of member) out.set(row.therapistId, row.bucket);
    return out;
  }

  /** The table's rows. Unlike the buckets, these DO move with the board's period. */
  async workingHoursRows(window?: { from: string; to: string }): Promise<Array<{ therapistId: number; therapistName: string; teamName: string | null; efficiency: number | null }>> {
    const qs = window ? `?from=${window.from}&to=${window.to}` : '';
    const body = await this.get(`/kpis/management/working-hours${qs}`);
    return (body.member ?? []).map((r: any) => ({
      therapistId: r.therapistId,
      therapistName: r.therapistName,
      teamName: r.teamName ?? null,
      efficiency: r.efficiency ?? null,
    }));
  }

  // ─────────────────────────────── the board ───────────────────────────────

  private capturedBuckets: Map<number, BucketKey> | null = null;
  private capturedRows: Array<{ therapistId: number; therapistName: string; teamName: string | null; efficiency: number | null }> | null = null;

  /** Watches for the board's own KPI responses and keeps the last of each. */
  private attachCapture(): void {
    this.page.on('response', (response) => {
      const url = response.url();
      const isBuckets = url.includes('/kpis/management/efficiency-buckets');
      const isHours = url.includes('/kpis/management/working-hours');
      if ((!isBuckets && !isHours) || !response.ok()) return;
      void response
        .json()
        .then((body: any) => {
          // Accepts a Hydra collection OR a bare array. Measured 2026-09-23: this endpoint serves
          // `{member: [...]}` with and without an `Accept` header — but #3705 recorded it serving a
          // BARE ARRAY, and on that shape a `body.member` unwrap yields `[]`, so the captured map
          // comes back EMPTY and every assertion built on it reads as "no therapist has a bucket"
          // rather than as a parse miss. Cheap to tolerate both; expensive to diagnose either.
          const member = Array.isArray(body) ? body : (body?.member ?? body?.['hydra:member'] ?? []);
          if (isBuckets) {
            const map = new Map<number, BucketKey>();
            for (const row of member) map.set(row.therapistId, row.bucket);
            this.capturedBuckets = map;
          } else {
            this.capturedRows = member.map((r: any) => ({
              therapistId: r.therapistId,
              therapistName: r.therapistName,
              teamName: r.teamName ?? null,
              efficiency: r.efficiency ?? null,
            }));
          }
        })
        .catch(() => {
          /* a body that cannot be parsed is simply not captured */
        });
    });
  }

  /**
   * Waits until the board's OWN `efficiency-buckets` response has been captured AND is non-empty.
   *
   * `boardBuckets()` throws only when nothing was captured at all; a response that arrived but
   * parsed to no rows leaves an EMPTY map, which every caller then reads as "no therapist has a
   * bucket". That is a third variant of the same readiness mistake this file has now hit twice
   * elsewhere — and the most misleading, because it is captured in `beforeAll` and so poisons every
   * test in the file at once, at 0ms, with an assertion error that names none of this.
   */
  async waitForBucketCapture(timeout = 300_000): Promise<void> {
    await expect
      .poll(() => this.capturedBuckets?.size ?? 0, { timeout, intervals: [2_000] })
      .toBeGreaterThan(0);
  }

  /** The bucket map the page itself fetched — what the painted dots were coloured from. */
  boardBuckets(): Map<number, BucketKey> {
    if (!this.capturedBuckets) throw new Error('#3575: the board never returned an efficiency-buckets payload');
    return this.capturedBuckets;
  }

  /** The row payload the page itself fetched — what the table actually rendered. */
  boardRows(): Array<{ therapistId: number; therapistName: string; teamName: string | null; efficiency: number | null }> {
    if (!this.capturedRows) throw new Error('#3575: the board never returned a working-hours payload');
    return this.capturedRows;
  }

  /**
   * Opens the Therapeuten-Orga board at `APRIL_2026` and waits for the Arbeitszeiten table to paint.
   *
   * `mintUiSession` rather than the saved storageState — a `.auth/*.json` refresh token is spent by
   * the first run since the v3.12 auth migration, and a spec relying on it lands on the login form.
   */
  async openArbeitszeiten(opts: { stubEmptyBuckets?: boolean } = {}): Promise<void> {
    if (opts.stubEmptyBuckets) await this.stubEmptyBuckets();
    // Capture the BOARD's own responses rather than issuing the same reads again. Two reasons, and
    // the second is the important one: these are the exact payloads the dots were drawn from (the
    // #3471 technique), and `working-hours` / `efficiency-buckets` are among the slowest KPI reads
    // on staging — re-fetching them doubles the exposure to a 504 for data the page already has.
    this.attachCapture();
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    this.boards = new FlowBoardsPage(this.page);
    await this.boards.open();
    await this.boards.openTab('Therapeuten-Orga');
    await expect(
      this.page.getByText(OVERVIEW_HEADING).first(),
      'the Übersicht section (named "Arbeitszeiten" before #3770)',
    ).toBeVisible({ timeout: 240_000 });

    await this.boards.setLevel('Monat');
    for (let step = 0; step < 24; step++) {
      if (APRIL_2026.label === (await this.boards.periodLabel())) return;
      await this.boards.stepPeriod('back');
    }
    throw new Error(`#3575: could not step back to ${APRIL_2026.label}`);
  }

  /**
   * AC5's state, produced without touching the server: the buckets request is answered with an
   * empty collection, so no therapist is placed and `renderTherapistRow` draws no dot. This is the
   * same shape as the still-loading render the PR's jest case covers.
   */
  async stubEmptyBuckets(): Promise<void> {
    await this.page.route('**/kpis/management/efficiency-buckets**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/ld+json',
        body: JSON.stringify({ '@context': '/contexts/EfficiencyBucketRow', '@id': '/kpis/management/efficiency-buckets', '@type': 'Collection', totalItems: 0, member: [] }),
      }),
    );
  }

  /** The Arbeitszeiten table's own view toggle. */
  async setView(view: 'Gruppen' | 'Therapeut:innen'): Promise<void> {
    await this.page.getByText(view, { exact: true }).first().click();
    await this.page.waitForTimeout(1_500);
  }

  /**
   * Waits until the table has painted therapist rows.
   *
   * The readiness condition is a NAME from the served payload, not a row count: the section heading
   * and both toggles render long before `working-hours` answers, and reading dots in that window
   * yields zero of them — indistinguishable from the feature being absent.
   */
  async waitForRows(expectedName?: string, timeout = 300_000): Promise<void> {
    // Readiness is "the payload arrived AND a name from it is on screen". Waiting on the payload
    // alone is not enough (the rows paint after it) and waiting on a hard-coded name is not enough
    // either (the period decides who is in the table).
    await expect
      .poll(
        async () => {
          const name = expectedName ?? this.capturedRows?.[0]?.therapistName;
          if (!name) return false;
          return this.page.evaluate(
            (needle) => ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes(needle),
            name,
          );
        },
        { timeout, intervals: [2_000] },
      )
      .toBe(true);
  }

  /** Every dot the Arbeitszeiten table has painted, with its geometry and its place in the cell. */
  /**
   * Readiness for the DOTS specifically, which {@link waitForRows} cannot give.
   *
   * The dots are painted from `efficiency-buckets`, a different and slower read than the
   * `working-hours` one the rows come from — so a name can be on screen while the bucket map is
   * still in flight, and {@link dots} then returns `[]`. That reads exactly like the feature being
   * absent, and it is what failed this file's AC3/AC4 test on 2026-09-23 (`flat.size` 0) on a build
   * where a probe measured 102 dots in both column modes moments later.
   */
  async waitForDots(timeout = 300_000): Promise<void> {
    await expect
      .poll(async () => (await this.dots()).length, { timeout, intervals: [2_000] })
      .toBeGreaterThan(0);
  }

  async dots(): Promise<Dot[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="bucket-dot-"]')].map((el) => {
        const h = el as HTMLElement;
        const cs = getComputedStyle(h);
        const cell = h.parentElement as HTMLElement | null;
        const siblings = cell ? [...cell.children] : [];
        const next = siblings[1] as HTMLElement | undefined;
        return {
          testId: el.getAttribute('data-testid')!,
          therapistId: Number(el.getAttribute('data-testid')!.replace('bucket-dot-t', '')),
          background: cs.backgroundColor,
          width: cs.width,
          height: cs.height,
          borderRadius: cs.borderRadius,
          firstInNameCell: siblings[0] === h,
          nameAfterDot: (next?.innerText ?? '').trim(),
        };
      }),
    );
  }

  /** `bucket → rgb`, derived from the painted dots and the served bucket map. */
  static colourByBucket(dots: Dot[], buckets: Map<number, BucketKey>): Map<BucketKey, Set<string>> {
    const out = new Map<BucketKey, Set<string>>();
    for (const dot of dots) {
      const bucket = buckets.get(dot.therapistId);
      if (!bucket) continue;
      if (!out.has(bucket)) out.set(bucket, new Set());
      out.get(bucket)!.add(dot.background);
    }
    return out;
  }

  /** Expands a team in the Gruppen view and returns its revealed member names. */
  async expandTeam(team: string): Promise<void> {
    await this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .first()
      .click({ timeout: 30_000 });
    await this.page.waitForTimeout(2_000);
  }

  // ─────────────────────────── AC2's parity surface ───────────────────────────

  /**
   * `bucket → rgb` from the MANAGEMENT board's detail table, which is the surface AC2 names.
   *
   * Its dot carries no testid, so it is located by shape — a 10x10 element with a 5px radius sitting
   * first in a name cell — and paired with the name beside it. The Grau dot is wrapped in an
   * `InfoTooltip` (#3580), so the shape search must not assume a fixed depth.
   */
  async managementColourByBucket(window: { from: string; to: string }): Promise<Map<string, Set<string>>> {
    // The Management board fetches its own therapist rows when the tab opens; that response is
    // captured here too, so this needs no extra API read either.
    let therapists: Array<{ therapistName: string; bucket: string }> = [];
    this.page.on('response', (response) => {
      if (!response.url().includes('/kpis/management/therapists') || !response.ok()) return;
      void response
        .json()
        .then((body: any) => {
          therapists = (body?.member ?? []).map((r: any) => ({ therapistName: r.therapistName, bucket: r.bucket }));
        })
        .catch(() => {});
    });

    await this.boards.openTab('Management');
    await expect
      .poll(async () => this.page.evaluate(() => document.querySelectorAll('[data-testid^="risk-tile-"]').length > 0 || ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes('Effizienz')), { timeout: 240_000, intervals: [2_000] })
      .toBe(true);
    await this.boards.setDetailView('Therapeut:innen');
    await expect.poll(() => therapists.length, { timeout: 300_000, intervals: [2_000] }).toBeGreaterThan(0);
    const bucketByName = new Map<string, string>();
    for (const row of therapists) bucketByName.set(String(row.therapistName).replace(/\s+/g, ' ').trim(), row.bucket);

    const painted = await this.page.evaluate(() => {
      const out: Array<{ name: string; background: string }> = [];
      for (const el of document.querySelectorAll('div')) {
        const h = el as HTMLElement;
        if (h.children.length) continue;
        const cs = getComputedStyle(h);
        if ('10px' !== cs.width || '10px' !== cs.height || !cs.borderRadius.startsWith('5px')) continue;
        // The name is the nearest following text in the same cell, however deep the dot sits.
        let cell: HTMLElement | null = h.parentElement;
        let name = '';
        for (let up = 0; up < 3 && cell && !name; up += 1) {
          name = (cell.innerText ?? '').split('\n')[0].trim();
          cell = cell.parentElement;
        }
        if (name) out.push({ name: name.replace(/\s+/g, ' ').trim(), background: cs.backgroundColor });
      }
      return out;
    });

    const out = new Map<string, Set<string>>();
    for (const dot of painted) {
      const bucket = bucketByName.get(dot.name.replace(/ \(Inaktiv\)$/, ''));
      if (!bucket) continue;
      if (!out.has(bucket)) out.set(bucket, new Set());
      out.get(bucket)!.add(dot.background);
    }
    return out;
  }
}
