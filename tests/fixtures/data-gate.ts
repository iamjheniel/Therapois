import { test } from '@playwright/test';

/**
 * Remembers a data-gate verdict so a file does not re-prove the same environment fact per test.
 *
 * ## The problem this solves
 *
 * Several spec files are gated on a condition that belongs to the ENVIRONMENT, not to the
 * individual test — "no patient on this board exposes an IB signer dialog", "no practice here has
 * initial orders". The gate is evaluated inside each test, but reaching the point where it can be
 * evaluated costs a full navigation plus a board search in `beforeEach`. When the gate is closed,
 * every test in the file pays that setup and then skips.
 *
 * Measured on the Therapist project before this existed: **42% of the suite's wall clock (480 s of
 * 1144 s) was spent inside tests that ended up skipped**, and the four IB spec files alone burned
 * ~105 s re-establishing one unchanged fact across 14 tests.
 *
 * ## What it does, and what it deliberately does not do
 *
 * The first test probes as before. Once a probe comes back CLOSED, the remaining tests in that file
 * skip in `beforeEach` — before the navigation — so the cost collapses to one setup.
 *
 * Only the negative verdict is cached, and only within a file. An open gate is re-probed every
 * time, because a gate that was open can legitimately close mid-file (a fixture consumed by an
 * earlier test) and that must still be observed rather than assumed away.
 *
 * The caching is sound only where the file is already `serial` — tests then share a worker and run
 * in order, which is the same assumption the surrounding specs already make. Do not use this to
 * gate a parallel describe.
 *
 * ## What it is NOT for
 *
 * A flaky selector. If the probe is closed because a locator is wrong rather than because the data
 * is absent, this hides the breakage behind a fast skip instead of a slow one. Gate on data
 * conditions the spec's own comments already describe as environment-dependent.
 */
export class DataGate {
  private closed = false;

  constructor(private readonly reason: string) {}

  /**
   * Call at the TOP of `beforeEach`, before any navigation: skips immediately when an earlier test
   * in this file already found the gate closed.
   */
  skipIfKnownClosed(): void {
    test.skip(this.closed, `${this.reason} (established by an earlier test in this file)`);
  }

  /**
   * Records a freshly probed verdict and skips the current test when it is closed. Use in place of
   * `test.skip(!probe, reason)`.
   *
   * `detail` names the specific step that could not be reached ("signature overlay did not open"),
   * so a skipped run still says which stage of the flow the environment stopped at rather than
   * reporting the gate's generic reason for every stage.
   */
  apply(open: boolean, detail?: string): void {
    if (!open) this.closed = true;
    test.skip(!open, detail ? `${this.reason} — ${detail}` : this.reason);
  }
}
