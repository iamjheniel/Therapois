import { test, expect } from '@playwright/test';
import {
  FlowBoardsSessionStatePage,
  SESSION_KEYS,
  FILTER_BOARDS,
  DEFAULT_SLICE,
  BOARD_MARKERS,
} from '../../../Pages/superadmin/sa.flow-boards-session-state.page';
import { TranslationsPage } from '../../../Pages/superadmin/sa.translations.page';

/**
 * RC 3.14 #3761 — reloading Flow Boards in the same browser tab reopens the board, the
 * Gesellschaft and that board's filters; a new tab starts on the defaults.
 *
 * READ-ONLY on the server: every request the board makes is a GET, and nothing here writes to the
 * API. What it does change is this tab's own `sessionStorage`, which is the feature.
 */

const GESELLSCHAFT = 'Curano Hamburg GmbH';

test.describe('#3761 Flow Boards keeps its state across a reload', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let flow: FlowBoardsSessionStatePage;

  test.beforeEach(({ page }) => {
    flow = new FlowBoardsSessionStatePage(page);
  });

  test(
    'deployment — the three session keys ship in the bundle and materialise on first mount',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async ({ page }) => {
      // Frontend-only, so the bundle is the only surface that can answer: `/status` reports the
      // API release and says nothing about the app (#3705).
      const bundle = await new TranslationsPage(page).loadDictionaries();
      const source = (bundle as any).source as string;
      for (const key of SESSION_KEYS) {
        const count = source.split(key).length - 1;
        console.log(`#3761 bundle: "${key}" ×${count}`);
        expect(count, `${key} is not in the served build — #3761 is not deployed`).toBeGreaterThan(0);
      }

      await flow.seedSession();
      await flow.open();
      await expect
        .poll(async () => (await flow.readState()).filtersByTab !== null, { timeout: 30_000 })
        .toBe(true);

      // `useSessionState` writes on the first mount too, so an untouched board already carries all
      // three keys — which is what makes the state observable without a single click.
      const state = await flow.readState();
      console.log(`#3761 on first mount: selectedTab=${JSON.stringify(state.selectedTab)}, entity=${JSON.stringify(state.selectedEntity)}`);
      console.log(`#3761 filtersByTab keys: ${JSON.stringify(Object.keys(state.filtersByTab!))}`);
      for (const key of SESSION_KEYS) expect(state.raw[key], `${key} was never written`).not.toBeNull();

      // Exactly the three boards the ticket's table says have filters — Einrichtungen and
      // Ärzte-Management own no slice, which is the spec and not an omission.
      expect(Object.keys(state.filtersByTab!).sort()).toEqual([...FILTER_BOARDS].sort());

      // The default slice, field for field, so a changed default is visible here rather than as a
      // puzzling restore later.
      for (const board of FILTER_BOARDS) {
        const slice = state.filtersByTab![board];
        for (const [field, value] of Object.entries(DEFAULT_SLICE)) {
          expect(slice[field], `${board}.${field}`).toEqual(value);
        }
        expect(String(slice.periodAnchor), `${board}.periodAnchor is not a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    },
  );

  test(
    'AC1/AC2 — a reload reopens the same board, company and level',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async () => {
      await flow.seedSession();
      await flow.open();

      // The ticket's own QA recipe: Admin-Performance, Monat, one company.
      await flow.boards.openTab('Admin-Performance');
      await flow.boards.setLevel('Monat');
      // selectGesellschaft opens the picker itself — opening it first would leave the list over
      // the trigger and the next open would hang (actionTimeout is 0).
      await flow.boards.selectGesellschaft(GESELLSCHAFT);

      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 30_000 }).toBe('Monat');
      const before = await flow.readState();
      const paintedBefore = await flow.paintedBoard();
      console.log(
        `#3761 before reload: tab=${JSON.stringify(before.selectedTab)} entity=${JSON.stringify(before.selectedEntity?.name)} ` +
          `level=${before.filtersByTab!.adminPerformance.level} painted=${JSON.stringify(paintedBefore)}`,
      );
      expect(before.selectedTab).toBe('adminPerformance');
      expect(before.selectedEntity?.name).toBe(GESELLSCHAFT);
      expect(before.filtersByTab!.adminPerformance.level).toBe('monat');
      expect(paintedBefore.adminPerformance, 'the Admin-Performance board never painted').toBe(true);

      await flow.reload();

      // AC1: the board and the company. AC2: that board's own level.
      const after = await flow.readState();
      const paintedAfter = await flow.paintedBoard();
      console.log(
        `#3761 after reload:  tab=${JSON.stringify(after.selectedTab)} entity=${JSON.stringify(after.selectedEntity?.name)} ` +
          `level=${after.filtersByTab!.adminPerformance.level} painted=${JSON.stringify(paintedAfter)}`,
      );
      expect(after.selectedTab, 'the reload lost the board').toBe('adminPerformance');
      expect(after.selectedEntity?.name, 'the reload lost the Gesellschaft').toBe(GESELLSCHAFT);
      expect(after.filtersByTab!.adminPerformance.level, 'the reload lost the level').toBe('monat');

      // Read off the SCREEN too — storage surviving is not the promise, reopening where the user
      // was is. Both markers are checked so a half-rendered board cannot pass.
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 45_000 }).toBe('Monat');
      expect(await flow.gesellschaftLabel()).toBe(GESELLSCHAFT);
      expect(paintedAfter.adminPerformance, `"${BOARD_MARKERS.adminPerformance}" is not on screen after the reload`).toBe(true);
      expect(paintedAfter.management, 'the Management board painted instead').toBe(false);
    },
  );

  test(
    'AC2 — each board keeps its own filters, so switching boards never mixes them up',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async () => {
      await flow.seedSession();
      await flow.open();

      // Management → Tag, Therapeuten-Orga → Monat. Different values on two boards at once is the
      // only shape that can show the slices are separate rather than merely persisted.
      await flow.boards.openTab('Management');
      await flow.boards.setLevel('Tag');
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 30_000 }).toBe('Tag');

      await flow.boards.openTab('Therapeuten-Orga');
      await flow.boards.setLevel('Monat');
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 30_000 }).toBe('Monat');

      const before = await flow.readState();
      console.log(
        `#3761 slices before reload: management.level=${before.filtersByTab!.management.level}, ` +
          `therapeutenOrga.level=${before.filtersByTab!.therapeutenOrga.level}, ` +
          `adminPerformance.level=${before.filtersByTab!.adminPerformance.level}`,
      );
      expect(before.filtersByTab!.management.level).toBe('tag');
      expect(before.filtersByTab!.therapeutenOrga.level).toBe('monat');
      // The board that was never touched keeps the default — the slices do not leak into each other.
      expect(before.filtersByTab!.adminPerformance.level).toBe(DEFAULT_SLICE.level);

      await flow.reload();

      const after = await flow.readState();
      console.log(
        `#3761 slices after reload:  management.level=${after.filtersByTab!.management.level}, ` +
          `therapeutenOrga.level=${after.filtersByTab!.therapeutenOrga.level}, ` +
          `adminPerformance.level=${after.filtersByTab!.adminPerformance.level}`,
      );
      expect(after.filtersByTab!.management.level).toBe('tag');
      expect(after.filtersByTab!.therapeutenOrga.level).toBe('monat');
      expect(after.filtersByTab!.adminPerformance.level).toBe(DEFAULT_SLICE.level);

      // And on screen: the restored board is Therapeuten-Orga at Monat, while Management's own Tag
      // is still waiting for it.
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 45_000 }).toBe('Monat');
      await flow.boards.openTab('Management');
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 45_000 }).toBe('Tag');
    },
  );

  test(
    'AC3 — a new tab opens on the defaults: Management, Woche, Alle Gesellschaften',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async ({ browser }) => {
      // A fresh context is a fresh tab: its own sessionStorage, which IS the mechanism — the
      // memory lasts exactly as long as the tab and needs no expiry of its own.
      const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
      try {
        const fresh = new FlowBoardsSessionStatePage(await context.newPage());
        await fresh.seedSession();
        await fresh.open();

        await expect
          .poll(async () => (await fresh.readState()).filtersByTab !== null, { timeout: 30_000 })
          .toBe(true);
        const state = await fresh.readState();
        const painted = await fresh.paintedBoard();
        console.log(
          `#3761 new tab: selectedTab=${JSON.stringify(state.selectedTab)} entity=${JSON.stringify(state.selectedEntity)} ` +
            `level=${await fresh.boards.activeLevel()} gesellschaft=${await fresh.gesellschaftLabel()}`,
        );

        expect(state.selectedTab, 'the new tab remembered a board').toBeNull();
        expect(state.selectedEntity, 'the new tab remembered a Gesellschaft').toBeNull();
        expect(await fresh.boards.activeLevel()).toBe('Woche');
        expect(await fresh.gesellschaftLabel()).toBe('Alle Gesellschaften');
        expect(painted.management, 'the default board is not Management').toBe(true);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'AC4 — a remembered board that is not available falls back to the first visible one, with no error',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async () => {
      await flow.seedSession();
      // Seeded before the first navigation, so the screen mounts with it already remembered.
      // A board the user has lost access to cannot be staged on staging — every Flow-Boards
      // account here is a Super Admin and sees all five tabs (an Admin gets no board at all,
      // #3173) — so an unknown key is used, which is the SAME `visibleTabs.some(...)` branch the
      // permission case takes.
      await flow.seedStorage({ 'flowBoards.selectedTab': JSON.stringify('einBoardDasEsNichtGibt') });
      await flow.open();

      const painted = await flow.paintedBoard();
      const state = await flow.readState();
      const errors = await flow.errorText();
      console.log(
        `#3761 remembered "${state.selectedTab}" → painted ${JSON.stringify(painted)}, errors ${JSON.stringify(errors)}`,
      );

      // It renders the first visible board …
      expect(painted.management, 'the fallback board did not render').toBe(true);
      expect(painted.adminPerformance).toBe(false);
      // … with nothing to explain away.
      expect(errors, 'an error surfaced on the fallback').toEqual([]);
      // `activeTab` is DERIVED and never written back, so the stored value stays as seeded — which
      // is why AC4 has to be read off the screen rather than out of storage.
      expect(state.selectedTab).toBe('einBoardDasEsNichtGibt');
    },
  );

  test(
    'a value left by an older build cannot break the board — corrupt JSON and a partial slice',
    { tag: ['@SuperAdmin', '@FlowBoardsSessionState', '@ReadOnly'] },
    async () => {
      await flow.seedSession();
      // `useSessionState` JSON.parses on read and falls back to the default on ANY throw; and the
      // context value spreads the defaults UNDER the stored slice, so a field added since the slice
      // was written is never undefined. Both are seeded here at once.
      await flow.seedStorage({
        'flowBoards.selectedTab': '{not json',
        'flowBoards.filtersByTab': JSON.stringify({
          management: { level: 'monat' },
          therapeutenOrga: { level: 'tag' },
          adminPerformance: { level: 'tag' },
        }),
      });
      await flow.open();

      const painted = await flow.paintedBoard();
      const errors = await flow.errorText();
      console.log(`#3761 corrupt tab + partial slice → painted ${JSON.stringify(painted)}, errors ${JSON.stringify(errors)}`);
      // The corrupt tab falls back to the default board …
      expect(painted.management).toBe(true);
      expect(errors).toEqual([]);
      // … while the partial slice still honours the one field it does carry, with the rest taken
      // from the defaults rather than rendering as undefined.
      await expect.poll(async () => flow.boards.activeLevel(), { timeout: 45_000 }).toBe('Monat');
      expect(await flow.gesellschaftLabel()).toBe('Alle Gesellschaften');
    },
  );
});
