import { test, expect } from '@playwright/test';
import {
  QUEUE_KEY,
  REPLAY_CONSTANTS,
  SyncQueuePage,
  filedEntry,
  queueEntry,
} from '../../../Pages/therapist/therapist.sync-queue.page';

/**
 * RC 3.12 #3594 — temporary server problems retry themselves, and the recovery notice counts only
 * unsent entries.
 *
 * **Deployed on staging; all seven ACs verified live.**
 *
 * The ticket is written against a Galaxy Tab A9+ and its own Testing Guidance gives up on two of the
 * cases: AC1 is "hard to provoke by hand … there is no manual staging repro — do not attempt to
 * force one", and AC2 wants an emulator with its DNS pointed at a dead address. Neither is needed.
 * `packages/dataprovider` is shared with the web build, its queue persists to `localStorage` under
 * `dataprovider/queue/v1`, and `page.route()` returns the exact 409 / 503 / 201 each AC describes on
 * demand. The collision case the ticket calls unreproducible is a one-line stub here.
 *
 * **Nothing reaches the server.** Every documentation write is answered by the test, so no Activity
 * is created on staging — and the queue is *seeded* rather than produced through the Doku modal, so
 * "2 waiting and 1 filed" is a literal fixture instead of something manufactured by documenting a VO
 * twice offline. That is what makes AC6 a two-line test instead of the ticket's six-step recipe.
 *
 * The one thing to hold onto while reading: **the sync bar and the recovery notice are supposed to
 * disagree.** `unsynced` (bar) counts `failed`; `awaitingSend` (notice) does not. Seeded with 2
 * pending + 1 filed, the same screen reads "3 Änderungen nicht gesendet" and "(2)", and both are
 * right.
 *
 * Runs at `--workers=1`: each test mints its own session with `POST /auth`, which #3462 throttles at
 * 5/minute per username. Serially these land ~2/minute; in parallel they would 429 and every test
 * would fail at login for a reason that has nothing to do with this ticket.
 */

test.describe('#3594 offline queue retry + recovery notice', () => {
  // Deliberately NOT `serial`: every test seeds its own queue on its own page and shares nothing, so
  // a cascade would only turn one failure into eight "did not run" lines. `--workers=1` is what keeps
  // the logins under the throttle, not the describe mode.

  test(
    'deployment — all four touchpoints shipped, and the fix is NOT where the ticket says it is',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const sync = new SyncQueuePage(page);
      const bundle = await sync.entryBundle();
      expect(bundle.length, 'the entry bundle downloaded').toBeGreaterThan(1_000_000);

      // (1) counts() gained `awaitingSend`, and it excludes `failed`.
      expect(bundle, 'counts() computes both totals').toContain(
        'e.unsynced=e.pending+e.syncing+e.retrying+e.failed,e.awaitingSend=e.pending+e.syncing+e.retrying',
      );
      // (2) the recovery notice reads the new total, and only fires above zero.
      expect(bundle, 'useRecoveredWorkNotice reads awaitingSend').toMatch(
        /awaitingSend:\w+\}=\w+\.queue\.counts\(\);\w+>0&&\w+\(\w+\('sync_status\.recovered_last_session'/,
      );
      // (3) handleFailure carries an explicit 409 escape…
      expect(bundle, 'handleFailure special-cases 409').toMatch(/409===\w+\.status;return'permanent'!==\w+\|\|\w+\?/);
      // (4) …and the exhausted-transient arm parks the entry as pending instead of failing it.
      expect(bundle, 'exhausted transient retries mark pending, not failed').toMatch(
        /maxTransientAttempts\?\(this\.queue\.markPending\(\w+\.id,\{error:\w+,resetAttempts:!0\}\),this\.deferred\.add/,
      );

      // THE TRAP. The Developer Reference says "409 currently sits in the permanent set and needs to
      // move to the transient/retry path". It never moved: PERMANENT_STATUSES still lists 409, and a
      // probe written to that instruction reports the fix as missing. What shipped instead is the
      // escape hatch above, which leaves the classification alone — deliberately, since
      // `failureReasonKey` still maps 409 to `sync.failure.conflict`.
      expect(bundle, 'PERMANENT_STATUSES still contains 409 — the reference’s prescription was not followed').toContain(
        'new Set([400,401,403,404,409,422])',
      );
      expect(bundle, '409 still maps to the conflict reason key').toContain("case 409:return'sync.failure.conflict'");

      // The V1 board's own permanent set is a different one and is explicitly out of scope.
      expect(bundle, 'the V1 set is untouched and distinct').toContain('new Set([400,404,409,422])');

      console.log('retry constants in the served bundle:', JSON.stringify(REPLAY_CONSTANTS));
      expect(bundle).toContain(`const s=${REPLAY_CONSTANTS.maxTransientAttempts},n=${REPLAY_CONSTANTS.maxNoResponseAttempts}`);
    },
  );

  test(
    'AC1 — a collision (409) is retried automatically and never filed under "Nicht gespeichert"',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      await sync.open([queueEntry('ac1-a', 'pending'), queueEntry('ac1-b', 'pending')], 'conflict');

      const tracks = await sync.trackUntilSettled(['ac1-a', 'ac1-b']);
      for (const [id, states] of tracks) console.log(`  ${id}: ${states.join(' → ')}`);

      // The claim is about the PATH, not just the destination: the entry must have gone through
      // `retrying` (i.e. the app tried again on its own) and must never have touched `failed`.
      for (const [id, states] of tracks) {
        expect(states, `${id} was retried automatically`).toContain('retrying');
        expect(states, `${id} was never filed under "Nicht gespeichert"`).not.toContain('failed');
      }
      const counts = await sync.counts();
      expect(counts.failed, 'nothing is filed after a pure 409 run').toBe(0);
      console.log(`documentation writes the app made on its own: ${sync.writeAttempts.length}`);
      expect(sync.writeAttempts.length, 'the app retried without anyone touching it').toBeGreaterThan(2);

      // The shape of the fix, visible in the persisted entry: a permanent-CLASSED error parked in a
      // retryable state. That combination is only possible via the 409 escape hatch.
      const a = await sync.entry('ac1-a');
      expect(a!.state).toBe('pending');
      expect(a!.lastError?.status, 'the 409 is recorded').toBe(409);
      expect(a!.lastError?.class, 'and still classified permanent — see the deployment test').toBe('permanent');
      expect(a!.attempts, 'markPending reset the attempt counter, so it will try again cleanly').toBe(0);
    },
  );

  test(
    'AC2 — an outage exhausts the retries and leaves the entry waiting, not filed',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      await sync.open([queueEntry('ac2-a', 'pending'), queueEntry('ac2-b', 'pending')], 'outage');

      const tracks = await sync.trackUntilSettled(['ac2-a', 'ac2-b']);
      for (const [id, states] of tracks) console.log(`  ${id}: ${states.join(' → ')}`);
      for (const [id, states] of tracks) {
        expect(states, `${id} kept retrying through the outage`).toContain('retrying');
        expect(states, `${id} is NOT filed under "Nicht gespeichert"`).not.toContain('failed');
      }

      const counts = await sync.counts();
      expect(counts.failed).toBe(0);
      expect(counts.awaitingSend, 'both entries are still waiting to send').toBe(2);

      // The sync bar is the AC's own wording.
      expect(await sync.syncBarUnsent(), 'the bar reads "N Änderungen nicht gesendet"').toBe(2);

      // And the Sync-Status panel must show nothing under "Nicht gespeichert" — the failure mode the
      // ticket was raised for is exactly an outage landing entries there.
      const panel = await sync.openSyncPanel();
      console.log('--- Sync-Status panel ---\n' + panel);
      expect(SyncQueuePage.filedCount(panel), 'the outage filed nothing').toBe(0);

      // Observation for the PM, not an AC failure. With nothing filed, the panel's only line is
      // "Alle Änderungen synchronisiert" — while the bar two lines above it reads "2 Änderungen nicht
      // gesendet" and the two entries are, in fact, unsent. That contradiction was rare before this
      // ticket, because a stuck entry was quickly filed and the panel then had something to show;
      // now entries legitimately sit in "waiting to send" indefinitely, so it is the normal state
      // during an outage. Recorded rather than asserted — the copy predates #3594.
      if (/Alle Änderungen synchronisiert/.test(panel)) {
        console.log('NOTE: panel says "Alle Änderungen synchronisiert" while the bar says 2 unsent');
      }
    },
  );

  test(
    'AC3 — once the server recovers the entries send themselves, with no action from the therapist',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      // The app starts with work waiting and meets a server that is answering again. Nothing in this
      // test clicks anything — that is the whole assertion.
      await sync.open([queueEntry('ac3-a', 'pending'), queueEntry('ac3-b', 'pending')], 'success');

      const seen = await sync.captureNotice(25_000);
      console.log('notice:', seen.text);
      console.log('sync bar lines seen:', JSON.stringify(seen.syncBarLines));

      const tracks = await sync.trackUntilSettled(['ac3-a', 'ac3-b']);
      for (const [id, states] of tracks) console.log(`  ${id}: ${states.join(' → ')}`);
      const counts = await sync.counts();
      expect(counts.awaitingSend, 'nothing is left waiting').toBe(0);
      expect(counts.failed, 'and nothing was filed on the way').toBe(0);
      expect(counts.done, 'both entries synced').toBe(2);

      // The AC's precondition — "entries are still waiting to send" — is taken from the notice, which
      // is computed once at mount, and from the seed itself. It is deliberately NOT taken from the
      // sync bar: with the server answering, the queue can drain inside a single 250ms poll, so the
      // bar's intermediate "N Änderungen nicht gesendet" reading is not reliably samplable and an
      // assertion on it fails on a fast run while the product is behaving perfectly.
      expect(seen.count, 'two entries were waiting when the app started').toBe(2);
      expect(await sync.syncBarUnsent(), 'and the bar ends at "alles gesendet"').toBe(0);
    },
  );

  test(
    'AC4 — the recovery notice counts the entries still waiting to send',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      // Three waiting, nothing filed. Held on a 503 so the count cannot drain mid-observation.
      await sync.open(
        [queueEntry('ac4-a', 'pending'), queueEntry('ac4-b', 'pending'), queueEntry('ac4-c', 'pending')],
        'outage',
      );
      const seen = await sync.captureNotice(20_000);
      console.log('notice:', seen.text);
      expect(seen.text, 'the notice appeared').toBeTruthy();
      expect(seen.text!, 'with the production wording, unchanged by this ticket').toContain(
        'Nicht gesendete Arbeit aus Ihrer letzten Sitzung wurde wiederhergestellt',
      );
      expect(seen.count, 'and counts the three waiting entries').toBe(3);
    },
  );

  test(
    'AC5 — with only filed entries there is no notice at all, and the panel is untouched',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      await sync.open([filedEntry('ac5-f')], 'outage');

      const seen = await sync.captureNotice(20_000);
      console.log('notice:', seen.text ?? '(none — correct)');
      // `useRecoveredWorkNotice` guards on `awaitingSend > 0`, so this is an absence, and absence is
      // the assertion. It is watched for 20s rather than sampled once, because the notice is a toast
      // that would otherwise be easy to miss rather than genuinely absent.
      expect(seen.text, 'no recovery notice is shown for a filed entry').toBeNull();

      const panel = await sync.openSyncPanel();
      console.log('--- Sync-Status panel ---\n' + panel);
      expect(SyncQueuePage.filedCount(panel), 'the filed entry is still listed').toBe(1);
      expect(panel, 'with its reason').toContain('Grund');
      expect(panel, 'and its Retry action').toContain('Erneut versuchen');
      expect(panel, 'and its Discard action').toContain('Verwerfen');

      // "unchanged" is also a claim about the entry itself — the notice change must not have
      // rewritten it.
      const f = await sync.entry('ac5-f');
      expect(f!.state).toBe('failed');
      expect(f!.lastError?.reasonKey).toBe('sync.failure.validation');
    },
  );

  test(
    'AC6 — 2 waiting + 1 filed shows "(2)", while the sync bar legitimately says 3',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      await sync.open([queueEntry('ac6-a', 'pending'), queueEntry('ac6-b', 'pending'), filedEntry('ac6-f')], 'outage');

      const seen = await sync.captureNotice(20_000);
      console.log('notice:', seen.text);
      console.log('sync bar lines:', JSON.stringify(seen.syncBarLines));
      expect(seen.count, 'the filed entry is not counted in the notice').toBe(2);

      // The deliberate divergence. `unsynced` (bar) includes `failed`; `awaitingSend` (notice) does
      // not, and the Developer Reference explicitly keeps the bar as it was. A test that expected
      // these to agree would report a defect that is not there.
      expect(await sync.syncBarUnsent(), 'the bar still counts all three').toBe(3);
      const counts = await sync.counts();
      expect(counts.awaitingSend).toBe(2);
      expect(counts.unsynced).toBe(3);
    },
  );

  test(
    'AC7 — a genuine rejection is still filed under "Nicht gespeichert" with its reason',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const sync = new SyncQueuePage(page);
      // 422 is the ticket's own example: a treatment limit reached, which no amount of retrying fixes.
      await sync.open([queueEntry('ac7-a', 'pending')], 'invalid');

      const tracks = await sync.trackUntilSettled(['ac7-a']);
      console.log(`  ac7-a: ${tracks.get('ac7-a')!.join(' → ')}`);
      const e = await sync.entry('ac7-a');
      expect(e!.state, 'a permanent rejection is filed, exactly as before').toBe('failed');
      expect(e!.lastError?.status).toBe(422);
      expect(e!.lastError?.class).toBe('permanent');
      expect(e!.lastError?.reasonKey, 'and keeps its reason for the panel to render').toBe('sync.failure.validation');

      const panel = await sync.openSyncPanel();
      console.log('--- Sync-Status panel ---\n' + panel);
      expect(SyncQueuePage.filedCount(panel)).toBe(1);
      expect(panel).toContain('Erneut versuchen');

      // AC7's second half — "not shown a recovery notice for it at the next app start" — is a claim
      // about the NEXT start, once the entry is already filed. That is precisely the AC5 scenario,
      // and it is asserted there rather than duplicated here: at THIS start the entry was still
      // pending, so the notice counting it was correct.
    },
  );

  test(
    'evidence — the queue shape and constants this file depends on',
    { tag: ['@Therapist', '@SyncQueue', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(180_000);
      const sync = new SyncQueuePage(page);
      await sync.open([queueEntry('ev-a', 'pending'), filedEntry('ev-f')], 'outage');
      const raw = await page.evaluate((k) => window.localStorage.getItem(k as string), QUEUE_KEY);
      console.log(`storage key: ${QUEUE_KEY}`);
      console.log(`persisted: ${raw?.slice(0, 600)}`);
      console.log(`counts: ${JSON.stringify(await sync.counts())}`);
      console.log(`writes intercepted (none reached the server): ${sync.writeAttempts.length}`);
      console.log(`write target: ${sync.writeAttempts[0] ?? '(none yet)'}`);

      // Observation, not a finding, and not this ticket's change: the bar renders "1 Änderungen
      // nicht gesendet" for a single entry — the German plural is wrong at N=1. The ticket's own
      // Localization Reference carries the same string, so it predates this work.
      const body = await page.locator('body').innerText().catch(() => '');
      const bar = body.split('\n').map((l) => l.trim()).filter((l) => /nicht gesendet/.test(l));
      console.log(`sync bar line(s): ${JSON.stringify(bar)}`);
      expect(await sync.counts()).toMatchObject({ awaitingSend: 1, unsynced: 2, failed: 1 });
    },
  );
});
