import { test, expect } from '@playwright/test';
import { FlowBoardsPage } from '../../../Pages/superadmin/sa.flow-boards.page';

/**
 * RC 3.10 — Traffic-Light Buckets (#3176, epic #3172).
 *
 * These buckets are the selected-period efficiency calculation — deliberately NOT the rolling-window
 * one behind the Therapeuten-Orga status indicators that #3183 changes. The two share the 70/85
 * thresholds but use different windows, so their counts are not expected to agree; nothing here
 * cross-checks against that page.
 *
 * The strongest available assertion is the partition: every filtered therapist falls into exactly
 * one bucket, so the four counts must sum to the number of therapist rows in the flat detail view,
 * and clicking a bucket must narrow that view to exactly that count.
 */
test.describe('Flow Boards — Traffic-light buckets', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1/AC3 — the 4 buckets carry their threshold labels and live counts that partition the therapists',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBuckets'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();

      // AC1: the four buckets and the thresholds they represent
      for (const { label, range } of FlowBoardsPage.BUCKETS) {
        const bucket = board.bucket(label);
        await expect(bucket, `bucket "${label}"`).toBeVisible({ timeout: 20_000 });
        await expect(bucket, `bucket "${label}" must state its range "${range}"`).toContainText(range);
      }

      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      // AC3: every bucket carries a live count
      const counts = await board.allBucketCounts();
      for (const [label, n] of Object.entries(counts)) {
        expect(n, `bucket "${label}" must show a count`).not.toBeNull();
        expect(n!, `bucket "${label}" count`).toBeGreaterThanOrEqual(0);
      }

      // AC1's "exactly one bucket" — the counts must partition the therapist population
      await board.setDetailView('Therapeut:innen');
      const therapists = await board.detailRowNames();
      const sum = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      expect(
        sum,
        `the 4 bucket counts (${JSON.stringify(counts)} = ${sum}) must add up to the ` +
          `${therapists.length} therapists on the board — each therapist falls into exactly one bucket`,
      ).toBe(therapists.length);
    },
  );

  test(
    'AC4 — every bucket count recomputes when a filter changes',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBuckets'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      const before = await board.allBucketCounts();
      const beforeSum = Object.values(before).reduce((a, b) => a + (b ?? 0), 0);

      // scoping to a single TO team must shrink the population the buckets count over
      const teamOptions = await board.openDropdown('Alle Teams');
      await board.closeDropdown();
      const named = teamOptions.filter((o) => o !== 'Alle Teams' && o !== 'Ohne TO-Team');
      test.skip(
        !named.length,
        `No named TO team in the team selector; options were ${JSON.stringify(teamOptions)}.`,
      );

      await board.selectTeam(named[0]);
      const after = await board.allBucketCounts();
      const afterSum = Object.values(after).reduce((a, b) => a + (b ?? 0), 0);

      expect(
        afterSum,
        `scoping to "${named[0]}" must recompute the buckets over a smaller group ` +
          `(all=${beforeSum} → team=${afterSum})`,
      ).toBeLessThan(beforeSum);

      // and the partition invariant must still hold for the narrowed group
      await board.setDetailView('Therapeut:innen');
      expect(
        afterSum,
        `bucket counts must still partition the ${named[0]} members exactly`,
      ).toBe((await board.detailRowNames()).length);
    },
  );

  test(
    'AC5/AC6 — clicking a bucket filters the detail table to that bucket, and clicking it again restores all therapists',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBuckets'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      const counts = await board.allBucketCounts();
      await board.setDetailView('Therapeut:innen');
      const everyone = await board.detailRowNames();
      expect(everyone.length, 'therapist rows').toBeGreaterThan(0);

      // Only buckets that actually hold therapists can be observed narrowing the table; a bucket at
      // 0 would be indistinguishable from "the click did nothing".
      const nonEmpty = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0);
      expect(nonEmpty.length, `at least one non-empty bucket, got ${JSON.stringify(counts)}`)
        .toBeGreaterThan(0);

      for (const [label, n] of nonEmpty) {
        await board.clickBucket(label);
        const filtered = await board.detailRowNames();
        expect(
          filtered.length,
          `clicking "${label}" must narrow the table to its ${n} therapists`,
        ).toBe(n);
        expect(
          filtered.every((t) => everyone.includes(t)),
          `"${label}" must only show therapists that are on the unfiltered board`,
        ).toBe(true);

        // AC6: the same bucket again clears the filter
        await board.clickBucket(label);
        expect(
          (await board.detailRowNames()).length,
          `clicking "${label}" a second time must restore all ${everyone.length} therapists`,
        ).toBe(everyone.length);
      }
    },
  );

  test(
    'AC5 — in the Gruppen view a bucket filter keeps every team row visible',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FlowBoardsBuckets'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const board = new FlowBoardsPage(page);
      await board.open();
      const loaded = await board.waitForBoardLoaded();
      test.skip(!loaded, 'Board settled on the empty state — open defect #3233.');

      await board.setDetailView('Gruppen');
      const teamRows = await board.detailRowNames();
      expect(teamRows.length, 'team rows').toBeGreaterThan(0);

      const counts = await board.allBucketCounts();
      const [label] = Object.entries(counts).find(([, n]) => (n ?? 0) > 0) ?? [];
      test.skip(!label, `no non-empty bucket to click (${JSON.stringify(counts)})`);

      await board.clickBucket(label!);

      // per AC5 team rows stay listed even when a team has no member in the clicked bucket
      expect(
        await board.detailRowNames(),
        `clicking "${label}" must keep every team row visible (teams with no member in the ` +
          `bucket are shown with a zero count, not hidden)`,
      ).toEqual(teamRows);
    },
  );
});
