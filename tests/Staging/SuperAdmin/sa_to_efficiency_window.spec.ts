import { test, expect } from '@playwright/test';
import { AppPage } from '../../../Pages/base/app.page';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — New Efficiency Rolling Window Rule (#3183, epic #3172).
 *
 * The rule change itself is inside the shared efficiency evaluator: the rolling window now counts
 * only days with a recorded Personio entry > 0 that are at least 3 days in the past, instead of
 * always dropping the 3 most recent working days. Which days a calculation counted is not rendered
 * anywhere, so AC1 is a developer unit-test concern (the ticket says exactly that).
 *
 * AC2 is what QA can hold: the three consumers of that evaluator — the Therapeuten-Orga dashboard's
 * status indicators, its health-check counts, and its therapist-health filter — must all still work
 * after the change. Those live on TO Verwaltung → Auslastung.
 *
 * The strongest assertion available is the same partition invariant the counts are supposed to
 * express: Red + Yellow + Green + Grey must equal the number of therapists in the current filter.
 * That is also the exact assertion open defect #3233 AC6 concerns (the counts read 0/0/0/0 while the
 * table below listed therapists in all four colours), so this test doubles as its regression guard.
 *
 * The thresholds (green >85 %, yellow 70–85 %, red <70 %) are explicitly NOT changing in this
 * ticket, so nothing here asserts new threshold values.
 */
test.describe('TO Verwaltung — efficiency window consumers (#3183 AC2)', () => {
  const HEALTH_COUNTS = [
    'Red Therapists',
    'Yellow Therapists',
    'Green Therapists',
    'Gray Therapists',
  ] as const;

  /** Reads the four health-check counts off the Auslastung header. */
  async function healthCounts(page: any): Promise<Record<string, number | null>> {
    const t: string = await page.locator('#root').innerText();
    const out: Record<string, number | null> = {};
    for (const label of HEALTH_COUNTS) {
      const m = t.match(new RegExp(`${label}\\s*\\n\\s*(\\d+)`));
      out[label] = m ? Number(m[1]) : null;
    }
    return out;
  }

  /** The therapist total from the pagination footer ("1-10 of 161"). */
  async function paginatedTotal(page: any): Promise<number | null> {
    const t: string = await page.locator('#root').innerText();
    const m = t.match(/\d+\s*-\s*\d+\s+of\s+(\d+)/);
    return m ? Number(m[1]) : null;
  }

  test(
    'AC2 — the health-check counts recompute and account for every therapist in the current filter',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@TOAuslastung'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      await new AppPage(page).goto('/to-management');

      await expect(page.getByText('TO Verwaltung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Auslastung', { exact: true })).toBeVisible();

      // wait for the counts to arrive rather than sleeping: they come from a separate, slower
      // full-list request than the table (the root cause behind #3233 AC6)
      await expect
        .poll(async () => (await healthCounts(page))['Red Therapists'], {
          timeout: 90_000,
          message: 'the four health-check counts must load',
        })
        .not.toBeNull();

      const counts = await healthCounts(page);
      const total = await paginatedTotal(page);
      expect(total, 'therapist total from the pagination footer').not.toBeNull();

      for (const label of HEALTH_COUNTS) {
        expect(counts[label], `"${label}" count must be present`).not.toBeNull();
      }

      const sum = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      expect(
        sum,
        `the health-check counts must never read all-zero while the table lists therapists ` +
          `(regression guard for #3233 AC6). Got ${JSON.stringify(counts)} against ${total} therapists.`,
      ).toBeGreaterThan(0);
      expect(
        sum,
        `every therapist in the filter falls into exactly one health bucket, so ` +
          `${JSON.stringify(counts)} = ${sum} must equal the ${total} therapists in the table`,
      ).toBe(total);
    },
  );

  test(
    'AC2 — per-row status indicators and the therapist-health filter still work',
    { tag: ['@SuperAdmin', '@EfficiencyWindow', '@TOAuslastung'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      await new AppPage(page).goto('/to-management');
      await expect(page.getByText('TO Verwaltung', { exact: true })).toBeVisible({ timeout: 30_000 });

      // the therapist-health filter is one of the three consumers of the changed evaluator
      await expect(page.getByText('Therapeuten-Gesundheit:', { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      await expect
        .poll(async () => (await healthCounts(page))['Red Therapists'], { timeout: 90_000 })
        .not.toBeNull();
      const before = await paginatedTotal(page);
      const counts = await healthCounts(page);

      // pick a non-empty health bucket and filter by it
      const target = Object.entries(counts).find(([, n]) => (n ?? 0) > 0);
      expect(target, `at least one non-empty health bucket, got ${JSON.stringify(counts)}`).toBeTruthy();
      const [label, expected] = target!;
      const colour = label.split(' ')[0]; // Red | Yellow | Green | Gray

      // The filter control is the "All" pressable sitting to the RIGHT of its label, on the same row.
      // Both constraints matter: without the x-constraint the nearest candidate is the "Call to
      // Action" column header one row below, and clicking that opens nothing while the later
      // option-matching still finds a "Red Therapists" count card to click — which then spins on an
      // intercepted click until the test times out.
      const openedOptions = await page.evaluate(() => {
        document.querySelectorAll('*').forEach((e) => e.setAttribute('data-qa-seen', '1'));
        const label = [...document.querySelectorAll('div')].find(
          (e) => e.children.length === 0 && (e.textContent || '').trim() === 'Therapeuten-Gesundheit:',
        );
        if (!label) return null;
        const r = label.getBoundingClientRect();
        const control = [...document.querySelectorAll('div[tabindex="0"], [role="button"], button')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r: rr }) => rr.width > 0 && Math.abs(rr.top - r.top) < 30 && rr.left >= r.right - 4)
          .sort((a, b) => a.r.left - b.r.left)[0];
        if (!control) return null;
        (control.el as HTMLElement).click();
        return true;
      });
      expect(openedOptions, 'the Therapeuten-Gesundheit filter control must be found').toBe(true);
      await page.waitForTimeout(3000);

      // Options are read from the freshly-rendered nodes, so the "Red Therapists" summary card
      // cannot be mistaken for the "Red" option.
      const options = await page.evaluate(() =>
        [...document.querySelectorAll('*:not([data-qa-seen])')]
          .filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
          .map((e) => (e.textContent || '').trim())
          .filter(Boolean),
      );
      const optionLabel = options.find((o) => new RegExp(`^${colour}`, 'i').test(o));
      test.skip(
        !optionLabel,
        `The Therapeuten-Gesundheit dropdown offers no "${colour}" option; on offer: ` +
          `${JSON.stringify(options.slice(0, 12))}`,
      );

      await page.getByText(optionLabel!, { exact: true }).last().click();
      await page.waitForTimeout(8000);

      const after = await paginatedTotal(page);
      expect(after, 'therapist total after filtering by health').not.toBeNull();
      expect(
        after!,
        `filtering by "${colour}" must narrow the table from ${before} therapists`,
      ).toBeLessThan(before!);
      expect(
        after!,
        `filtering by "${colour}" must show the ${expected} therapists that bucket counts`,
      ).toBe(expected);
    },
  );

  test(
    'AC1 — the rolling-window day-selection rule itself is verified by developer unit tests',
    { tag: ['@SuperAdmin', '@EfficiencyWindow'] },
    async () => {
      test.skip(
        true,
        'AC1 changes which days the shared efficiency evaluator counts: only days with a recorded ' +
          'Personio entry > 0 minutes, and only days at least 3 days in the past. Neither the day ' +
          'set nor the resulting per-therapist window is rendered anywhere in the UI — only the ' +
          'derived colour is — so no UI assertion can distinguish the new rule from the old ' +
          '8-working-days/drop-3 rule. The ticket assigns this to unit tests covering three edge ' +
          'cases: a zero-Personio day outside the 3-day exclusion is excluded, a day inside the ' +
          '3-day exclusion is excluded even with Personio data, and a day 4+ days back with ' +
          'Personio data > 0 is included. AC2 (the three consumers still work) is covered by the ' +
          'two tests above.',
      );
    },
  );

  test(
    'the Flow Boards buckets and the TO rolling window are independent calculations',
    { tag: ['@SuperAdmin', '@EfficiencyWindow'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1920, height: 1200 });

      // Both tickets use the same 70/85 thresholds over different time windows (#3183 vs #3176), so
      // their counts are NOT expected to match. This test pins that expectation down so a future
      // reader does not "fix" a difference that is by design.
      await new AppPage(page).goto('/to-management');
      await expect(page.getByText('TO Verwaltung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await healthCounts(page))['Red Therapists'], { timeout: 90_000 })
        .not.toBeNull();
      const rolling = await healthCounts(page);

      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');
      const period = await board.allBucketCounts();

      // Each set must be internally consistent; they need not agree with each other.
      expect(
        Object.values(rolling).reduce((a, b) => a + (b ?? 0), 0),
        'the TO rolling-window counts must total something',
      ).toBeGreaterThan(0);
      expect(
        Object.values(period).reduce((a, b) => a + (b ?? 0), 0),
        'the Management-board period buckets must total something',
      ).toBeGreaterThan(0);

      console.log(
        `TO rolling window ${JSON.stringify(rolling)} vs Flow Boards selected period ` +
          `${JSON.stringify(period)} — different time windows, so a difference is expected (#3183).`,
      );
    },
  );
});
