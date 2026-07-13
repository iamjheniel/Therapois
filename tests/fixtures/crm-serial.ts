import { test as base, expect, type TestInfo } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Cross-process serialization lock for the CRM specs.
 *
 * WHY: every CRM test drives the SAME shared practice — `CRMListPage.openPracticeView()` opens the
 * first practice in the list, and the activity/order tests then create/resolve records on it. When
 * multiple CRM spec files run concurrently (Playwright spreads files across workers, and the Admin
 * and SuperAdmin projects run in parallel), they collide on that shared practice's data and UI
 * state — producing the intermittent "Anzeigen not visible" / missing-status-toast / timeout
 * failures. `test.describe.configure({ mode: 'serial' })` only serializes tests WITHIN one file, so
 * it cannot prevent this cross-file/cross-project contention.
 *
 * HOW: an auto-used fixture takes an exclusive OS-level lock (an atomic `mkdir` in the temp dir,
 * shared by every worker process of the run) before each CRM test and releases it after — so at
 * most one CRM test touches the practice at any moment, across all files and projects. This is
 * effectively "serial mode" for the entire CRM group.
 *
 * TIMEOUT: the lock wait happens in fixture setup, which Playwright charges to the test's timeout —
 * so a long queue would otherwise time the test out ("... while running beforeEach hook") before
 * its body runs. This fixture therefore OWNS the CRM timeout: it keeps the deadline ahead of the
 * wait, then grants a fixed `BODY_BUDGET_MS` measured from the moment the lock is acquired. Because
 * a spec-level `test.setTimeout()` runs AFTER this fixture and would clobber that (resetting the
 * timeout to an absolute value from test start, wait included), CRM specs must NOT call
 * `test.setTimeout()` themselves — this fixture is the single source of truth.
 *
 * USAGE: CRM specs import `test`/`expect` from this module instead of '@playwright/test'.
 */

const LOCK_DIR = join(tmpdir(), 'therapios-crm-serial.lock');
const STALE_MS = 5 * 60_000; // longer than any single CRM test; older ⇒ a crashed worker's stale lock
const POLL_MS = 200;
const BODY_BUDGET_MS = 180_000; // wall-clock a CRM test body gets AFTER it holds the lock
const ACQUIRE_TIMEOUT_MS = 10 * 60_000; // hard cap on queueing; then proceed rather than hang forever

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sets the test deadline to `BODY_BUDGET_MS` ahead of now (elapsed measured from `start`). */
function keepDeadlineAhead(testInfo: TestInfo, start: number): void {
  testInfo.setTimeout(Date.now() - start + BODY_BUDGET_MS);
}

async function acquire(testInfo: TestInfo): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR); // atomic: throws if the lock is already held
      writeFileSync(join(LOCK_DIR, 'held-at'), String(Date.now()));
      keepDeadlineAhead(testInfo, start); // body now gets a full BODY_BUDGET_MS from here
      return;
    } catch {
      keepDeadlineAhead(testInfo, start); // stay ahead of the queue so the wait never times us out
      // Lock is held by another test. Reclaim it if the holder crashed and left it stale.
      try {
        const heldAt = Number(readFileSync(join(LOCK_DIR, 'held-at'), 'utf8')) || 0;
        if (Date.now() - heldAt > STALE_MS) rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        // 'held-at' not written yet — a momentary race; just retry.
      }
      // Never fail the suite on the lock itself: after the cap, proceed rather than hang.
      if (Date.now() - start > ACQUIRE_TIMEOUT_MS) return;
      await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS));
    }
  }
}

function release(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // already released / never acquired
  }
}

export const test = base.extend<{ crmSerialLock: void }>({
  crmSerialLock: [
    async ({}, use, testInfo) => {
      await acquire(testInfo);
      try {
        await use();
      } finally {
        release();
      }
    },
    { auto: true },
  ],
});

export { expect };
