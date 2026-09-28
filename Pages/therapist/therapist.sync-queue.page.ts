import { Page } from '@playwright/test';
import { STAGING_CREDENTIALS, mintUiSession } from '../util/api-token';

/**
 * The Therapist Board V2 offline queue: automatic retry of temporary server problems, and what the
 * startup recovery notice counts (RC 3.12 #3594).
 *
 * The ticket is written for a Galaxy Tab A9+, and its own Testing Guidance calls AC1 impossible to
 * provoke by hand and suggests pointing an emulator's DNS at a dead address for AC2. None of that is
 * necessary: **`packages/dataprovider` is shared with the web build**, the queue persists to
 * `localStorage` under `dataprovider/queue/v1`, and Playwright's `page.route()` can return exactly
 * the 409 / 5xx / success the ACs describe — deterministically, on demand, one status at a time.
 *
 * That gives a far sharper harness than the ticket asks for, and one crucial safety property:
 *
 * **Nothing ever reaches the server.** Every documentation write is intercepted and answered by the
 * test, so no `Activity` is created on staging even though the entries look real to the app. The
 * queue is *seeded* rather than produced through the Doku modal, which also skips the suite's
 * flakiest surface and makes each AC's starting state exact — "2 waiting and 1 filed" is a literal
 * fixture, not something to manufacture by documenting a VO twice offline.
 *
 * ## What the deployed build actually does
 *
 * `ReplayLoop.handleFailure()` reads, deminified:
 *
 * ```js
 * const cls = classifyError(err), e = normalise(err, cls), attempt = entry.attempts + 1;
 * if (401 === e.status) return queue.markPending(id, {error: e, resetAttempts: true}), stop();
 * const isConflict = (409 === e.status);                     // ← the fix
 * return 'permanent' !== cls || isConflict
 *   ? ('no-response' === cls
 *       ? (attempt >= maxNoResponseAttempts ? markPending(resetAttempts) + stop()
 *                                           : markRetrying + backoff)
 *       : (attempt >= maxTransientAttempts  ? markPending(resetAttempts) + defer + refreshTotal()
 *                                           : markRetrying + backoff))
 *   : (queue.markFailed(id, e), refreshTotal());
 * ```
 *
 * **The fix is NOT where the ticket's Developer Reference says it should be**, and this is the trap
 * that decides whether the whole ticket reads as shipped or not. The reference says "409 currently
 * sits in the permanent set and needs to move to the transient/retry path" — but
 * `PERMANENT_STATUSES` in the served bundle is still `new Set([400,401,403,404,409,422])`, 409
 * included. A deployment probe written to that instruction concludes the fix never landed. What
 * actually shipped is the `isConflict` escape above, which lets a 409 through the retry arm while
 * leaving its classification alone — so `failureReasonKey` still maps 409 to `sync.failure.conflict`
 * ("Termin bereits dokumentiert"). The persisted entry makes the divergence visible: after a 409 it
 * reads `state: "pending"` with `lastError.class: "permanent"` — a permanent-classed error sitting
 * in a retryable state, which is precisely the shape of the fix.
 *
 * `queue.counts()` gained a second total beside the old one:
 *
 * ```js
 * unsynced     = pending + syncing + retrying + failed;   // the sync bar / Sync-Status panel
 * awaitingSend = pending + syncing + retrying;            // the recovery notice
 * ```
 *
 * and `useRecoveredWorkNotice` reads `awaitingSend`, firing only when it is `> 0`. So **one screen
 * legitimately shows two different numbers** — seeded with 2 pending + 1 filed, the bar reads
 * "3 Änderungen nicht gesendet" and the notice reads "(2)". Both are correct; a test that assumes
 * they agree will report a bug that is not there.
 *
 * ## Traps
 *
 * - **Seeded entries must be recent.** `hydrate()` calls `purgeExpired()`, which drops anything
 *   older than `PENDING_RETENTION_MS` (30 days) by `createdAt`. `queueEntry()` stamps `Date.now()`.
 * - **`hydrate()` rewrites `syncing` to `pending`**, so a seeded `syncing` entry is not the state it
 *   was seeded as (it still counts toward `awaitingSend` either way).
 * - **The write goes to `POST /activities`, not `/activities/bulk`** — the replay executor calls
 *   `dataProvider.create('activities', …)` per entry, whatever the Doku modal does when online.
 * - **The recovery notice is a toast** and disappears; `captureNotice()` polls from the first paint.
 *   It fires once per engine mount (a `useRef` latch), so a soft re-render will not repeat it.
 * - **`innerText` splits the sync bar in two** — "Stand von vor 0 Min" and "· 3 Änderungen nicht
 *   gesendet" arrive as separate lines, so a helper matching one line starting with "Stand von"
 *   silently loses the count.
 * - Backoff is 1s, 2s, 4s, 8s (cap 30s) over `MAX_TRANSIENT_ATTEMPTS = 5`, so a transient entry
 *   takes ~15s to exhaust — the observation windows here are sized from that, not guessed.
 */

/** Where the offline queue lives in `localStorage` on the web build. */
export const QUEUE_KEY = 'dataprovider/queue/v1';

/** `packages/dataprovider/offline/replay.ts` constants, as compiled into the served bundle. */
export const REPLAY_CONSTANTS = {
  maxTransientAttempts: 5,
  maxNoResponseAttempts: 2,
  backoffBaseMs: 1_000,
  backoffCapMs: 30_000,
} as const;

export type QueueState = 'pending' | 'syncing' | 'retrying' | 'failed' | 'done';

export type QueueEntry = {
  id: string;
  resource: string;
  type: 'create' | 'update' | 'delete';
  payload: unknown;
  state: QueueState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: { class: string; status?: number; message?: string; reasonKey?: string };
};

/** How the intercepted documentation write should answer. */
export type StubMode = 'conflict' | 'outage' | 'gateway' | 'invalid' | 'success' | 'offline';

const STUB: Record<Exclude<StubMode, 'offline' | 'success'>, { status: number; body: string }> = {
  // The only 409 the documentation endpoint returns: BulkPostActivitiesController catching a
  // LockWaitTimeoutException. Nothing was written, so resubmitting is safe.
  conflict: { status: 409, body: '{"detail":"Die Dokumentation wird gerade von einer anderen Anfrage gespeichert. Bitte erneut versuchen."}' },
  outage: { status: 503, body: '{"detail":"Service Unavailable"}' },
  gateway: { status: 502, body: '{"detail":"Bad Gateway"}' },
  invalid: { status: 422, body: '{"detail":"Behandlungslimit erreicht"}' },
};

/** A queue entry stamped now, so `purgeExpired()` keeps it. */
export function queueEntry(id: string, state: QueueState, extra: Partial<QueueEntry> = {}): QueueEntry {
  const now = Date.now();
  return {
    id,
    resource: 'activities',
    type: 'create',
    payload: { seeded: id },
    state,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/** A `failed` entry as a permanent 422 rejection would leave it — AC5/AC6/AC7's "Nicht gespeichert". */
export function filedEntry(id: string): QueueEntry {
  return queueEntry(id, 'failed', {
    attempts: 3,
    lastError: { class: 'permanent', status: 422, message: 'Behandlungslimit', reasonKey: 'sync.failure.validation' },
  });
}

export class SyncQueuePage {
  /** Documentation writes the stub answered, for asserting the app retried on its own. */
  readonly writeAttempts: string[] = [];

  constructor(private page: Page) {}

  // ──────────────────────────────── setting the scene ────────────────────────────────

  /**
   * Seeds the queue and installs the write stub, then opens the board.
   *
   * Order matters: both the seed and the route must be in place before the first navigation, since
   * the engine hydrates and the notice fires on mount.
   */
  async open(entries: QueueEntry[], mode: StubMode): Promise<void> {
    await mintUiSession(this.page, STAGING_CREDENTIALS.therapist);
    await this.page.addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key as string, value as string);
        } catch {
          /* a private-mode browser has no localStorage; the test below will say so */
        }
      },
      [QUEUE_KEY, JSON.stringify({ version: 1, entries })],
    );
    await this.stubWrites(mode);
    await this.page.goto('https://staging.therapios.de/therapist/', { waitUntil: 'domcontentloaded' });
  }

  /**
   * Answers every documentation WRITE from the test and lets reads through.
   *
   * This is what keeps the file safe to run against staging: the app believes it is talking to the
   * server, and no `Activity` is ever created.
   */
  async stubWrites(mode: StubMode): Promise<void> {
    await this.page.route('**/activities**', async (route) => {
      const req = route.request();
      if ('GET' === req.method()) return route.continue();
      this.writeAttempts.push(`${req.method()} ${req.url()}`);
      if ('offline' === mode) return route.abort('internetdisconnected');
      if ('success' === mode) {
        return route.fulfill({
          status: 201,
          contentType: 'application/ld+json',
          body: JSON.stringify({ '@context': '/contexts/Activity', '@id': '/activities/999999999', '@type': 'Activity', id: 999999999 }),
        });
      }
      const s = STUB[mode];
      await route.fulfill({ status: s.status, contentType: 'application/json', body: s.body });
    });
  }

  // ───────────────────────────────── reading the queue ─────────────────────────────────

  async entries(): Promise<QueueEntry[]> {
    const raw = await this.page.evaluate((k) => window.localStorage.getItem(k as string), QUEUE_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw).entries ?? [];
    } catch {
      return [];
    }
  }

  async entry(id: string): Promise<QueueEntry | null> {
    return (await this.entries()).find((e) => e.id === id) ?? null;
  }

  /** `counts()` recomputed here, so a test can assert the two totals independently of the UI. */
  async counts(): Promise<{ pending: number; syncing: number; retrying: number; failed: number; done: number; unsynced: number; awaitingSend: number }> {
    const e = await this.entries();
    const n = (s: QueueState) => e.filter((x) => x.state === s).length;
    const c = { pending: n('pending'), syncing: n('syncing'), retrying: n('retrying'), failed: n('failed'), done: n('done'), unsynced: 0, awaitingSend: 0 };
    c.unsynced = c.pending + c.syncing + c.retrying + c.failed;
    c.awaitingSend = c.pending + c.syncing + c.retrying;
    return c;
  }

  /**
   * Polls until every named entry has settled, recording every state each one passed through.
   *
   * The transitions are the evidence for AC1/AC2 — that an entry went `retrying → pending` and never
   * touched `failed` is a stronger claim than its final state alone, and it cannot be reconstructed
   * afterwards because the queue only stores the current one.
   */
  async trackUntilSettled(ids: string[], budgetMs = 60_000): Promise<Map<string, QueueState[]>> {
    const seen = new Map<string, QueueState[]>(ids.map((id) => [id, []]));
    const settled = (s: QueueState) => 'pending' === s || 'failed' === s || 'done' === s;
    const deadline = Date.now() + budgetMs;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const all = await this.entries();
      let allSettled = true;
      for (const id of ids) {
        const e = all.find((x) => x.id === id);
        // A `done` entry is removed from nothing but may simply be absent if purged; treat missing
        // as settled so a drained queue does not spin out the budget.
        if (!e) continue;
        const track = seen.get(id)!;
        if (track[track.length - 1] !== e.state) track.push(e.state);
        if (!settled(e.state)) allSettled = false;
      }
      if (allSettled) {
        // Require the settled reading to hold — an entry between backoffs is momentarily `pending`.
        if (!stableSince) stableSince = Date.now();
        else if (Date.now() - stableSince > 4_000) break;
      } else stableSince = 0;
      await this.page.waitForTimeout(500);
    }
    return seen;
  }

  // ──────────────────────────────────── reading the UI ────────────────────────────────────

  /**
   * The startup recovery notice, captured from the first paint.
   *
   * It is a toast on a timer, so this polls tightly rather than waiting and looking once.
   */
  async captureNotice(windowMs = 25_000): Promise<{ text: string | null; count: number | null; syncBarLines: string[] }> {
    const lines = new Set<string>();
    let text: string | null = null;
    const end = Date.now() + windowMs;
    while (Date.now() < end) {
      const body = await this.page.locator('body').innerText().catch(() => '');
      for (const l of body.split('\n').map((x) => x.trim())) {
        if (/Stand von|Änderungen nicht gesendet|alles gesendet|Warteschlange/i.test(l)) lines.add(l);
      }
      if (!text) {
        const m = body.match(/[^\n]*wiederhergestellt[^\n]*/);
        if (m) text = m[0].trim();
      }
      await this.page.waitForTimeout(250);
    }
    return { text, count: text ? Number(text.match(/\((\d+)\)/)?.[1] ?? NaN) : null, syncBarLines: [...lines] };
  }

  /** The sync bar's own count, e.g. "· 3 Änderungen nicht gesendet" → 3; `0` when it reads "alles gesendet". */
  async syncBarUnsent(): Promise<number | null> {
    const body = await this.page.locator('body').innerText().catch(() => '');
    if (/alles gesendet/i.test(body)) return 0;
    const m = body.match(/(\d+)\s+Änderungen nicht gesendet/);
    return m ? Number(m[1]) : null;
  }

  /** Opens the "Warteschlange ›" Sync-Status panel and returns its text. */
  async openSyncPanel(): Promise<string> {
    const trigger = this.page.getByRole('button', { name: /Warteschlange/i }).first();
    // `actionTimeout` is 0 project-wide, so an unresolved locator would hang the whole test.
    await trigger.click({ timeout: 20_000 });
    const dialog = this.page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 20_000 });
    return await dialog.innerText();
  }

  /** "NICHT GESPEICHERT (1)" → 1; `0` when the section is absent. */
  static filedCount(panelText: string): number {
    const m = panelText.match(/NICHT GESPEICHERT\s*\((\d+)\)/i);
    return m ? Number(m[1]) : 0;
  }

  // ─────────────────────────────── the deployed bundle ───────────────────────────────

  /**
   * The served entry bundle, for the deployment probe. The dataprovider's identifiers survive
   * minification (`markFailed`, `awaitingSend`, `maxTransientAttempts` …), so the shipped logic can
   * be read directly rather than inferred from behaviour.
   */
  async entryBundle(): Promise<string> {
    const html = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const src = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!src) throw new Error('#3594: no entry bundle in the served HTML');
    return await (await this.page.request.get(`https://staging.therapios.de${src}`, { timeout: 120_000 })).text();
  }
}
