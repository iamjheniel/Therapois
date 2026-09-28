import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';
import { FlowBoardsPage } from './sa.flow-boards.page';

/**
 * The Therapeuten-Orga board's traffic-light tiles count ACTIVE therapists only (RC 3.13 #3705).
 *
 * #3579 did this for the Management board and deliberately stopped there: its two helpers were put
 * in their own module with **one call site each**, precisely so the shared `TrafficLightBuckets`
 * component would not silently change the Therapeuten-Orga board too. #3705 is the follow-up that
 * makes the same change on the TO board on purpose, and rewords its Grau pill and tooltip to match.
 *
 * ## What the fix is
 *
 * `activeTileRows` gains a second call site. In the served bundle the TO board component reads:
 *
 * ```js
 * H = useMemo(() => S.rows.reduce((e,o) => (e[o.therapistId]=o.bucket, e), {}), [S.rows]),  // AC2
 * N = useMemo(() => activeTileRows(S.rows), [S.rows]),                                       // AC1
 * U = useMemo(() => countByBucket(N), [N])
 * ```
 *
 * The two arrays come from the same unfiltered `S.rows`, and that asymmetry IS the ticket: the
 * **tiles** count active therapists (AC1) while `bucketByTherapistId` — the map that colours the
 * Arbeitszeiten dots (#3575) and drives the bucket filter — keeps **every** row (AC2), so a
 * deactivated therapist still gets a colour and is still reachable by filtering.
 *
 * ## The numbers that make AC1 falsifiable
 *
 * `GET /kpis/management/efficiency-buckets` serves 236 rows = **162 active + 74 deactivated**:
 *
 * | Bucket   | all rows | active only |
 * |----------|---------:|------------:|
 * | rot      |      121 |         121 |
 * | gelb     |        1 |           1 |
 * | gruen    |        2 |           1 |
 * | grau     |      104 |          31 |
 * | abwesend |        8 |           8 |
 * | **total**|  **236** |     **162** |
 *
 * Grün and Grau differ between the two columns, so a build without the fix paints a *different*
 * number in two tiles — the assertion cannot pass vacuously. (The Management board's #3579 fixture
 * needed a historical window for exactly this reason; here the default period already discriminates,
 * because this endpoint ignores `from`/`to` entirely — see below.)
 *
 * ## Traps
 *
 * - **`efficiency-buckets` returns a BARE JSON ARRAY**, not a Hydra collection. Every other KPI
 *   reader here unwraps `member` / `hydra:member`, which yields `[]` — an empty payload that reads
 *   exactly like "no therapists" and makes every count assertion pass at 0.
 * - **The endpoint strips `from`/`to`** (#3242 AC2): its window is rolling, so the payload is
 *   byte-identical with and without a period and there is no period to "choose" as a fixture.
 * - **`FlowBoardsPage.BUCKETS`'s Grau entry is now stale for BOTH boards.** #3580 relabelled the
 *   Management pill to "Grau — keine Personio-Stunden"; #3705 gives the TO pill the same label and
 *   range text, so "Grau — keine Aktivität" no longer matches anywhere.
 * - **Read the tiles only after the board has painted.** The TO board's shell, filter bar and KPI
 *   cards render long before the buckets land; a tile read taken early returns nulls, which looks
 *   like the tiles being absent (the same trap #3575 hit reading its dots).
 *
 * ## A naming discrepancy worth knowing
 *
 * The ticket's Developer Reference proposes the new tooltip key be called
 * `bucketGrauPersonioTooltipRollingWindow`. What shipped is **`bucketGrauWindowTooltip`**, and a grep
 * for the suggested name finds nothing in the bundle — so a probe written from the reference
 * concludes the fix is missing.
 */

/** The TO board's tile labels as #3705 leaves them. */
export const TO_BUCKET_LABELS = {
  rot: 'Rot',
  gelb: 'Gelb',
  gruen: 'Grün',
  grau: 'Grau — keine Personio-Stunden',
  abwesend: 'Abwesend',
} as const;

/**
 * The two Grau tooltips, which must NOT be the same string.
 *
 * AC3 gives the TO board rolling-window wording (its Effizienz is a 5-day rolling snapshot, #3486),
 * while AC4 leaves the Management board's period wording alone (its Effizienz is period-scoped).
 * Asserting each board shows its own — and not the other's — is what separates "the new key exists"
 * from "the right board reads it".
 */
export const GRAU_TOOLTIPS = {
  /** `flowBoards.bucketGrauWindowTooltip` — Therapeuten-Orga (AC3). */
  to: 'Für diese:n Therapeut:in wurde im für diese Berechnung verwendeten Zeitraum kein Arbeitstag mit Personio-Stunden erfasst.',
  /** `flowBoards.bucketGrauPersonioTooltip` — Management, unchanged (AC4). */
  management: 'Dieser Therapeut/diese Therapeutin hat für diesen Zeitraum keine Arbeitsstunden aus Personio erfasst.',
} as const;

export type BucketRow = { therapistId: number; bucket: string; active: boolean };
export type TileCounts = { rot: number; gelb: number; gruen: number; grau: number; abwesend: number };

export class ToBoardActiveTilesPage {
  private token = '';

  constructor(private page: Page) {}

  /**
   * Mints the bearer token, retrying the login itself.
   *
   * `POST /auth` is a single point of failure for every test here and staging answers it with
   * `ETIMEDOUT` / `ERR_CONNECTION_CLOSED` under load — a failure that has nothing to do with #3705
   * but, in a serial describe, cascades every remaining test to "did not run". The waits grow so the
   * retries are also spaced clear of #3462's 5-per-minute login throttle.
   */
  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
        if (this.token) return;
        last = new Error('no bearer token returned');
      } catch (err) {
        last = err;
      }
      await this.page.waitForTimeout(8_000 * (attempt + 1));
    }
    throw new Error(`#3705: no bearer token — ${last instanceof Error ? last.message : String(last)}`);
  }

  /**
   * The rows both the tiles and `bucketByTherapistId` are built from.
   *
   * Tolerates the Hydra shape as well as the bare array this endpoint actually serves, so the helper
   * keeps working if the serialization is ever normalised — but the array branch is the live one.
   */
  async bucketRows(): Promise<BucketRow[]> {
    const res = await this.page.request.get(`${API_BASE}/kpis/management/efficiency-buckets`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`#3705: efficiency-buckets → HTTP ${res.status()}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body?.member ?? body?.['hydra:member'] ?? []);
    return rows.map((r: any) => ({ therapistId: r.therapistId, bucket: r.bucket, active: !!r.active }));
  }

  /** AC1's predicate, in the shipped form. */
  static activeTileRows<T extends { active: boolean }>(rows: T[]): T[] {
    return rows.filter((r) => r.active);
  }

  static tileCounts(rows: { bucket: string }[]): TileCounts {
    const c: TileCounts = { rot: 0, gelb: 0, gruen: 0, grau: 0, abwesend: 0 };
    for (const r of rows) if (r.bucket in c) (c as any)[r.bucket] += 1;
    return c;
  }

  /** AC2's map: `therapistId → bucket` over EVERY row, deactivated included. */
  static bucketByTherapistId(rows: BucketRow[]): Record<number, string> {
    return rows.reduce((acc, r) => ({ ...acc, [r.therapistId]: r.bucket }), {} as Record<number, string>);
  }

  // ─────────────────────────────── the deployed bundle ───────────────────────────────

  async entryBundle(): Promise<string> {
    const html = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3705: no entry bundle in the served HTML');
    return await (await this.page.request.get(`https://staging.therapios.de${src}`, { timeout: 180_000 })).text();
  }

  static occurrences(bundle: string, needle: string): number {
    return bundle.split(needle).length - 1;
  }

  /**
   * A German literal as the bundle actually stores it.
   *
   * Metro escapes every non-ASCII character (`ü` → `\xfc`, `ä` → `\xe4`, `—` → `—`), so a plain
   * grep for a German string returns 0 and reads exactly like "never shipped" (#3611, #3337).
   */
  static escaped(literal: string): string {
    return [...literal]
      .map((ch) => {
        const code = ch.codePointAt(0)!;
        if (code < 0x80) return ch;
        return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
      })
      .join('');
  }

  static escapedCount(bundle: string, literal: string): number {
    return ToBoardActiveTilesPage.occurrences(bundle, ToBoardActiveTilesPage.escaped(literal));
  }

  // ───────────────────────────────── the board on screen ─────────────────────────────────

  /**
   * Opens the Therapeuten-Orga board and waits for its tiles to paint.
   *
   * `mintUiSession` rather than the saved `storageState`: a `.auth/*.json` refresh token is spent by
   * the first run since the v3.12 migration, and a spec relying on it lands on the login form, which
   * reads as "the board renders nothing".
   *
   * No period is set — this board's buckets come from the rolling-window endpoint, which ignores the
   * period entirely, so stepping to a fixture month would change nothing but the wall clock.
   */
  async openToBoard(): Promise<FlowBoardsPage> {
    let lastAuthError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
        lastAuthError = null;
        break;
      } catch (err) {
        lastAuthError = err;
        await this.page.waitForTimeout(8_000 * (attempt + 1));
      }
    }
    if (lastAuthError) throw lastAuthError;
    const boards = new FlowBoardsPage(this.page);
    // Staging drops connections often enough (`net::ERR_CONNECTION_CLOSED`) that a single `goto` is
    // not a safe precondition; a bare failure here cascades the whole serial describe to "did not
    // run", which reads far worse than the blip it is.
    let lastNavError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await boards.open();
        lastNavError = null;
        break;
      } catch (err) {
        lastNavError = err;
        await this.page.waitForTimeout(5_000 * (attempt + 1));
      }
    }
    if (lastNavError) throw lastNavError;
    await this.page.waitForFunction(
      () => ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes('Therapeuten-Orga'),
      null,
      { timeout: 180_000 },
    );
    await this.page.getByText('Therapeuten-Orga', { exact: true }).first().click({ force: true, timeout: 30_000 });
    await this.waitForTiles();
    return boards;
  }

  /** Waits until all five pills carry a number — never a fixed sleep, and never a bare visibility check. */
  async waitForTiles(timeout = 240_000): Promise<void> {
    await this.page.waitForFunction(
      (labels: string[]) => {
        const text = (document.querySelector('#root') as HTMLElement)?.innerText ?? '';
        return labels.every((l) => new RegExp(`${l.replace(/[.*+?^${}()|[\]\\—]/g, '\\$&')}\\s*\\n\\s*\\d+`).test(text));
      },
      ['Rot', 'Gelb', 'Grün', 'Abwesend'],
      { timeout },
    );
    await this.page.waitForTimeout(3_000);
  }

  /**
   * The five rendered tile counts.
   *
   * A pill whose count cannot be parsed comes back `null` rather than 0 — a board that has not
   * painted and a board with four real zeros are otherwise indistinguishable (#3233).
   */
  async renderedTileCounts(): Promise<Record<keyof TileCounts, number | null>> {
    return this.page.evaluate((labels) => {
      const out: Record<string, number | null> = {};
      const pills = [...document.querySelectorAll('[role="button"]')] as HTMLElement[];
      for (const [key, label] of Object.entries(labels)) {
        const pill = pills.find((el) => (el.innerText || '').trim().startsWith(label));
        const match = pill ? (pill.innerText || '').match(/\n\s*(\d+)\s*\n?/) : null;
        out[key] = match ? Number(match[1]) : null;
      }
      return out;
    }, TO_BUCKET_LABELS as unknown as Record<string, string>) as Promise<Record<keyof TileCounts, number | null>>;
  }

  /** The Grau pill's lines, joined — label, count, range text. */
  async grauPillText(): Promise<string | null> {
    return this.page.evaluate((label) => {
      const pill = ([...document.querySelectorAll('[role="button"]')] as HTMLElement[])
        .find((el) => (el.innerText || '').trim().startsWith(label));
      return pill ? (pill.innerText || '').replace(/\n/g, ' | ') : null;
    }, TO_BUCKET_LABELS.grau);
  }

  /**
   * Hovers the Grau pill and returns which of the two tooltips the board revealed.
   *
   * The tooltip is rendered into the page rather than as a title attribute, so it is read out of the
   * board text after the hover. Returning BOTH flags (rather than a boolean for the expected one)
   * is what lets a test assert the other board's wording is absent.
   */
  async grauTooltip(): Promise<{ text: string; rollingWindow: boolean; period: boolean }> {
    await this.page.getByText(new RegExp(`^${TO_BUCKET_LABELS.grau.slice(0, 4)}`)).first()
      .hover({ force: true, timeout: 20_000 })
      .catch(() => {});
    await this.page.waitForTimeout(1_500);
    const text = (await this.page.locator('#root').innerText().catch(() => '')) || '';
    return {
      text,
      rollingWindow: text.includes(GRAU_TOOLTIPS.to),
      period: text.includes(GRAU_TOOLTIPS.management),
    };
  }
}
