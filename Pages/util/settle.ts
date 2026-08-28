import { Locator, Page, Request } from '@playwright/test';

/**
 * Waits for the effect of a board interaction instead of sleeping a flat guess.
 *
 * ## Why this exists
 *
 * The suite's page objects follow almost every click with `waitForTimeout(3000..6000)`. Those flat
 * sleeps are both too slow (most interactions finish far sooner) and too short (`/kpis/orga/risks`
 * alone measures ~11.6 s), so they cost minutes per run *and* still hand callers a half-painted
 * board under load.
 *
 * The obvious fix — "poll until the value stops changing" — was tried before and rejected, for a
 * good reason recorded in dd0d6b3: a value that has not moved yet is indistinguishable from a value
 * that will never move, so the check passes while the request is still in flight and the caller
 * reads the PRE-click number.
 *
 * This helper closes exactly that hole by requiring BOTH halves:
 *
 *   1. **the network is done** — every XHR/fetch the action triggered has come back, followed by a
 *      quiet window so a second request fired from the first one's `.then()` is still caught, and
 *   2. **the DOM has stopped changing** — two identical reads after that.
 *
 * "Stopped moving" is only trusted once the requests that would move it have landed, which is the
 * completion signal the earlier attempt was missing.
 *
 * ## Cost
 *
 * A purely client-side interaction (sorting an already-fetched table, expanding a row) issues no
 * request at all. Rather than sit out the full budget, the helper gives the click `probeMs` to
 * produce one and returns as soon as the DOM is stable if none appears — which is where most of the
 * saving comes from. `budgetMs` is only ever an upper bound, never a wait.
 */
export interface SettleOptions {
  /** Hard upper bound on the whole wait. Default 15 s. */
  budgetMs?: number;
  /** How long to wait for the click to issue its first request before deciding it was client-side. */
  probeMs?: number;
  /** Quiet period with no new request required before the network counts as settled. */
  quietMs?: number;
  /** Element whose text is watched for the DOM half. Default the whole app root. */
  domSelector?: string;
}

const isApiCall = (r: Request) => {
  const t = r.resourceType();
  return t === 'xhr' || t === 'fetch';
};

/**
 * Runs `action`, then waits for the requests it triggered to come back and the DOM to stop moving.
 * Returns whatever `action` returned.
 */
export async function settleAfter<T>(
  page: Page,
  action: () => Promise<T>,
  opts: SettleOptions = {},
): Promise<T> {
  const { budgetMs = 15_000, probeMs = 1_200, quietMs = 500, domSelector = '#root' } = opts;

  let inflight = 0;
  let seen = 0;
  let lastActivity = Date.now();

  const started = (r: Request) => {
    if (!isApiCall(r)) return;
    inflight++;
    seen++;
    lastActivity = Date.now();
  };
  // requestfailed fires for the client's own 8 s aborts too, so an aborted read still settles.
  const ended = (r: Request) => {
    if (!isApiCall(r)) return;
    inflight--;
    lastActivity = Date.now();
  };

  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);

  try {
    const result = await action();
    const deadline = Date.now() + budgetMs;
    const probeUntil = Date.now() + probeMs;

    // Phase 1 — the network.
    while (Date.now() < deadline) {
      if (seen === 0) {
        // Nothing issued yet. Give the click its probe window, then treat it as client-side.
        if (Date.now() >= probeUntil) break;
      } else if (inflight <= 0 && Date.now() - lastActivity >= quietMs) {
        break;
      }
      await page.waitForTimeout(100);
    }

    // Phase 2 — the paint. Only trusted now that the requests behind the change have landed.
    let previous: string | null = null;
    while (Date.now() < deadline) {
      const current = await page
        .locator(domSelector)
        .first()
        .innerText()
        .catch(() => null);
      if (current !== null && current === previous) break;
      previous = current;
      await page.waitForTimeout(200);
    }

    return result;
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
  }
}

/**
 * Waits until a list's rendered content stops changing.
 *
 * ## Why this is not the anti-pattern dd0d6b3 rejected
 *
 * `settleAfter` exists because "the number stopped moving" is, on its own, satisfied *before* the
 * request that would move it has landed — so the caller reads the pre-click value. That objection
 * applies to a value being watched for a CHANGE.
 *
 * This helper is for the other half of the problem, and every caller uses it the same way: the
 * result being waited for has ALREADY been observed (a `waitFor({ state: 'visible' })` on the first
 * option), and what remains is a streaming list still appending rows. Clicking mid-stream detaches
 * the target and — with `actionTimeout` at 0 — hangs the worker rather than failing, which is what
 * the flat `waitForTimeout(1500)` at these call sites was guarding against.
 *
 * So the precondition ("there is content") is established by the caller, and this only answers
 * "has it stopped growing". Three identical reads 150 ms apart cost ~450 ms against the 1200-1500 ms
 * the sleeps charged unconditionally, and unlike a sleep it keeps waiting - up to `budgetMs` - when
 * staging is slow enough that 1500 ms would have been too short.
 */
export async function waitForStable(
  locator: Locator,
  opts: { budgetMs?: number; intervalMs?: number; stableReads?: number } = {},
): Promise<void> {
  const { budgetMs = 6_000, intervalMs = 150, stableReads = 3 } = opts;
  const deadline = Date.now() + budgetMs;
  let previous: string | null = null;
  let repeats = 0;

  while (Date.now() < deadline) {
    const current = await locator
      .allTextContents()
      .then((t) => `${t.length} ${t.join('|')}`)
      .catch(() => null);

    if (current !== null && current === previous) {
      if (++repeats >= stableReads - 1) return;
    } else {
      repeats = 0;
    }
    previous = current;
    await locator.page().waitForTimeout(intervalMs);
  }
}

/**
 * Waits for a portalled overlay (dropdown flatlist, `[role="dialog"]` panel) to actually be on
 * screen, replacing the fixed 700-1000 ms sleeps that followed every control click.
 *
 * Those sleeps were sized for the slowest case and paid on every call. A dropdown that is already
 * mounted resolves here in a single poll, and one that is slow still gets the full `timeoutMs`
 * instead of being clicked into while half-open.
 */
/**
 * Waits until the app's `auth-state` entry — the bearer token every API helper in `Pages/` reads —
 * is present in localStorage.
 *
 * This replaces the `goto(...)` + `waitForTimeout(5000)` pair that opens a dozen API-driven specs.
 * That sleep was sized as though the token appeared once the app had booted and signed in, but it
 * does not: `auth-state` is restored from the project's `storageState` file as the origin loads, so
 * it is readable on the first poll after navigation. The five seconds bought nothing, on every one
 * of those tests.
 *
 * Use it only where what follows is an API read. A spec that goes on to drive the UI wants the
 * BOARD to be ready, which is a different (and later) condition — see `waitForStable`.
 */
export async function waitForAuthState(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      try {
        const raw = localStorage.getItem('auth-state');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return Boolean(parsed?.token || parsed?.accessToken || parsed?.access_token);
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: timeoutMs, polling: 100 },
  );
}

export async function waitForOpen(locator: Locator, timeoutMs = 10_000): Promise<boolean> {
  return await locator
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}
