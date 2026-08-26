import { Page } from '@playwright/test';

/**
 * Helpers for #3385 — the React Query offline cache and the Sentry traffic it produces.
 *
 * The app persists its whole dehydrated React Query cache into one localStorage key. When that write
 * exceeds the ~5MB per-origin budget the persister used to report the failure to Sentry every ~3s for
 * the rest of the session (32k events in 9 days). The fix evicts queries and retries, and reports at
 * most once per session.
 *
 * Everything here is read-only against the product: the only thing written is ballast in the test
 * browser's own localStorage, which dies with the Playwright context.
 *
 * **Never log the cache contents.** The blob is full of patient data (GDPR Article 9). Report
 * `queries.length` and sizes as numbers, as the ticket's QA plan requires.
 */

/** Where the MMKV instance `therapios` lands on web. */
export const OFFLINE_CACHE_KEY = 'therapios\\REACT_QUERY_OFFLINE_CACHE';

export type CacheSnapshot = { chars: number; queries: number | null; mutations: number | null };

/** A Sentry error event as it goes over the wire, reduced to what the ACs ask about. */
export type SentryError = {
  type: string;
  value: string;
  environment: string | null;
  release: string | null;
  context: Record<string, unknown> | null;
  /** The whole event item, kept so PII assertions can scan it. */
  raw: string;
};

/**
 * Collects the Sentry envelopes a page sends, plus how the ingest endpoint answers them.
 *
 * The ingest reply matters for AC5: a 429 carries `x-sentry-rate-limits` naming the categories being
 * dropped, which is the one way to tell "quiet app" from "suppressed app" without the Sentry UI.
 */
export class SentryTraffic {
  readonly errors: SentryError[] = [];
  readonly rateLimits: string[] = [];
  readonly statuses: number[] = [];

  private static readonly INGEST = /ingest\.[a-z]+\.sentry\.io/;

  attach(page: Page) {
    page.on('request', (request) => {
      if (!SentryTraffic.INGEST.test(request.url())) return;
      const body = request.postData() || '';
      const header = (() => {
        try {
          return JSON.parse(body.split('\n')[0]);
        } catch {
          return null;
        }
      })();
      for (const line of body.split('\n')) {
        if (!line.includes('"exception"')) continue;
        try {
          const event = JSON.parse(line);
          const first = event.exception?.values?.[0] ?? {};
          this.errors.push({
            type: String(first.type ?? ''),
            value: String(first.value ?? ''),
            environment: event.environment ?? header?.trace?.environment ?? null,
            release: event.release ?? header?.trace?.release ?? null,
            context: event.contexts?.persisted_cache ?? null,
            raw: line,
          });
        } catch {
          /* an envelope item we cannot parse is not an error event */
        }
      }
    });

    page.on('response', (response) => {
      if (!SentryTraffic.INGEST.test(response.url())) return;
      this.statuses.push(response.status());
      const limits = response.headers()['x-sentry-rate-limits'];
      if (limits) this.rateLimits.push(limits);
    });
  }

  /** Just the storage-quota reports — the issue this ticket is about. */
  quotaErrors(): SentryError[] {
    return this.errors.filter((e) => /quota/i.test(e.type) || /quota/i.test(e.value));
  }

  /**
   * The data categories Sentry is currently dropping, parsed out of `x-sentry-rate-limits`
   * (`<retry_after>:<categories>:<scope>:<reason>`, several rules separated by commas).
   */
  limitedCategories(): string[] {
    const categories = new Set<string>();
    for (const header of this.rateLimits) {
      for (const rule of header.split(',')) {
        for (const category of (rule.split(':')[1] ?? '').split(';')) {
          if (category.trim()) categories.add(category.trim());
        }
      }
    }
    return [...categories];
  }
}

/** Reads the persisted cache's size and entry counts — never its contents. */
export async function cacheSnapshot(page: Page): Promise<CacheSnapshot> {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key) || '';
    let queries: number | null = null;
    let mutations: number | null = null;
    try {
      const parsed = JSON.parse(raw);
      queries = parsed?.clientState?.queries?.length ?? null;
      mutations = parsed?.clientState?.mutations?.length ?? null;
    } catch {
      /* absent or truncated — reported as chars 0 / null counts */
    }
    return { chars: raw.length, queries, mutations };
  }, OFFLINE_CACHE_KEY);
}

/**
 * Fills localStorage with ballast until writes fail, then hands back `headroom` characters.
 *
 * The cache takes days to outgrow the quota on its own, so the QA plan shrinks the free space
 * instead. The current cache value is removed first: localStorage counts a key's own value as
 * reclaimable, so overwriting an unchanged 234KB blob succeeds even in a "full" store and the
 * failure path is never reached.
 *
 * Returns the total characters resident afterwards.
 */
export async function installBallast(page: Page, headroom: number): Promise<number> {
  return await page.evaluate(
    ({ key, head }) => {
      localStorage.removeItem(key);
      for (const name of Object.keys(localStorage)) if (name.startsWith('qa-ballast')) localStorage.removeItem(name);
      let coarse = 0;
      try {
        for (; coarse < 400; coarse++) localStorage.setItem(`qa-ballast-c${coarse}`, 'x'.repeat(100_000));
      } catch {
        /* full */
      }
      let fine = 0;
      try {
        for (; fine < 3000; fine++) localStorage.setItem(`qa-ballast-f${fine}`, 'x'.repeat(1000));
      } catch {
        /* full to the character */
      }
      let freed = 0;
      while (freed < head && fine > 0) {
        fine--;
        freed += (localStorage.getItem(`qa-ballast-f${fine}`) || '').length;
        localStorage.removeItem(`qa-ballast-f${fine}`);
      }
      while (freed < head && coarse > 0) {
        coarse--;
        freed += (localStorage.getItem(`qa-ballast-c${coarse}`) || '').length;
        localStorage.removeItem(`qa-ballast-c${coarse}`);
      }
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) total += (localStorage.getItem(localStorage.key(i)!) || '').length;
      return total;
    },
    { key: OFFLINE_CACHE_KEY, head: headroom },
  );
}

/**
 * Installs ballast and a write-attempt counter *before the app boots*, so the very first persist of
 * the session already fails.
 *
 * Counting attempts is what separates "the persister gave up after one try" from "it evicted and
 * retried": the ladder of shrinking payloads is only visible from inside `setItem`.
 */
export async function installBallastAtBoot(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    (window as unknown as Record<string, unknown>).__qaPersistAttempts = [] as unknown[];
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name !== key) return original.call(this, name, value);
      const attempts = (window as unknown as Record<string, unknown>).__qaPersistAttempts as unknown[];
      try {
        original.call(this, name, value);
        attempts.push({ ok: true, chars: value.length });
      } catch (error) {
        attempts.push({ ok: false, chars: value.length, error: (error as Error)?.name });
        throw error;
      }
    };
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing persisted yet */
    }
    let coarse = 0;
    try {
      for (; coarse < 400; coarse++) original.call(localStorage, `qa-ballast-c${coarse}`, 'x'.repeat(100_000));
    } catch {
      /* full */
    }
    try {
      for (let fine = 0; fine < 3000; fine++) original.call(localStorage, `qa-ballast-f${fine}`, 'x'.repeat(1000));
    } catch {
      /* full to the character */
    }
  }, OFFLINE_CACHE_KEY);
}

/** The persist attempts the boot-time counter recorded: the eviction ladder, largest first. */
export async function persistAttempts(page: Page): Promise<{ ok: boolean; chars: number; error?: string }[]> {
  return await page.evaluate(
    () => ((window as unknown as Record<string, unknown>).__qaPersistAttempts as never[]) ?? [],
  );
}
