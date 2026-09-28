import { Page } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS, type Credentials } from '../util/api-token';
import { FlowBoardsPage } from './sa.flow-boards.page';

/**
 * Flow Boards keeps the board, the Gesellschaft and each board's filters across a reload — RC 3.14
 * #3761, commit `dc0b292c6` on `release/3.14.0` (a `Ref` trailer, no PR; the same commit also
 * ships #3762's Aktualisieren button).
 *
 * ## The whole feature is three sessionStorage keys
 *
 * `FlowBoardsScreen` swapped three `useState` calls for `useSessionState` (the `CRMScreen`
 * pattern), so the state is both **observable** and **seedable**:
 *
 * | key | holds |
 * |---|---|
 * | `flowBoards.selectedTab` | the open board, or `null` before one is picked |
 * | `flowBoards.selectedEntity` | the shared Gesellschaft — the whole `EntityOption`, not its id |
 * | `flowBoards.filtersByTab` | one filter slice per board that has filters |
 *
 * `useSessionState` writes on every state change **including the first mount**, so all three keys
 * exist as soon as the screen renders, even untouched. It `JSON.parse`s on read and falls back to
 * the default on ANY throw, which is what makes a corrupt value harmless.
 *
 * **sessionStorage is per TAB**, which is the whole of AC3: a new tab starts empty and therefore on
 * the defaults, with no extra logic and nothing to expire.
 *
 * ## THE OBSTACLE, and it is the ticket's own subject
 *
 * This ticket can only be tested by RELOADING, and `mintUiSession` re-injects its refresh token on
 * every navigation — the token is single-use, so the second load replays a spent one and lands on
 * the login form (#3460). {@link seedSession} installs the token **once per token**, keyed on a
 * marker, so the app's own rotated replacement survives the reload untouched.
 *
 * ## Traps
 *
 *  - **`selectGesellschaft()` opens the dropdown itself.** Calling `openGesellschaft()` first
 *    leaves the list covering the trigger and the second open HANGS to the test timeout, because
 *    `actionTimeout` is 0 project-wide.
 *  - **A board tab is NOT an `isSegmentActive()` segment.** All five report false whichever is
 *    open, so the active board is identified by its own content ({@link BOARD_MARKERS}) and by the
 *    stored key — never by the tab strip's colour.
 *  - **`activeTab` is DERIVED, never written back.** A remembered board the user cannot see falls
 *    back to the first visible one for rendering, but the stored value stays as it was, so AC4 has
 *    to be read off the screen rather than out of storage.
 *  - **Einrichtungen and Ärzte-Management carry no slice at all** — `filtersByTab` has exactly
 *    three keys, which is the ticket's own table and not an omission.
 */

export const SESSION_KEYS = [
  'flowBoards.selectedTab',
  'flowBoards.selectedEntity',
  'flowBoards.filtersByTab',
] as const;

/** The boards that own a filter slice — the ticket's table, and the keys of `filtersByTab`. */
export const FILTER_BOARDS = ['management', 'therapeutenOrga', 'adminPerformance'] as const;
export type FilterBoard = (typeof FILTER_BOARDS)[number];

/** `DEFAULT_FLOW_BOARDS_FILTER_STATE` plus the runtime `periodAnchor`, as it is stored. */
export const DEFAULT_SLICE = {
  periodMode: 'periode',
  level: 'woche',
  rangeStart: null,
  rangeEnd: null,
  therapistId: null,
  teamId: null,
  teamMode: 'all',
  patientType: 'all',
  location: 'all',
  selectedBucket: null,
  selectedTherapist: null,
} as const;

/**
 * A string only that board paints, for telling which one is open.
 *
 * `Privatpatient:innen` is a Management KPI card; `Ø / Woche (letzte 4 Wo.)` is Admin-Performance's
 * own column. Each test asserts the expected board's marker present AND the other's absent, so a
 * screen stuck between boards cannot pass.
 */
export const BOARD_MARKERS: Record<string, string> = {
  management: 'Privatpatient:innen',
  adminPerformance: 'Ø / Woche (letzte 4 Wo.)',
};

export type StoredState = {
  selectedTab: string | null;
  selectedEntity: { id: number; name: string } | null;
  filtersByTab: Record<string, Record<string, unknown>> | null;
  /** The raw strings, for the corrupt-value case where parsing is the thing under test. */
  raw: Record<string, string | null>;
};

export class FlowBoardsSessionStatePage {
  readonly boards: FlowBoardsPage;

  constructor(private page: Page) {
    this.boards = new FlowBoardsPage(page);
  }

  /**
   * Signs the tab in so that a RELOAD keeps the session.
   *
   * Seeded once per token behind a marker: the first navigation installs it, every later one
   * leaves the app's rotated replacement alone. The marker lives in `localStorage`, deliberately
   * not in `sessionStorage`, so it cannot disturb the storage this ticket is about.
   */
  async seedSession(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.page.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    const refresh = (await res.json()).refresh_token as string;
    await this.page.addInitScript((token: string) => {
      try {
        if (localStorage.getItem('__qaSeededRefresh') !== token) {
          localStorage.setItem('auth-refresh-token', JSON.stringify(token));
          localStorage.setItem('__qaSeededRefresh', token);
        }
      } catch {
        /* a context that refuses storage cannot be signed in this way either */
      }
    }, refresh);
  }

  /** Writes sessionStorage entries before the first navigation — the AC4 / corrupt-value seed. */
  async seedStorage(entries: Record<string, string>): Promise<void> {
    await this.page.addInitScript((seed: Record<string, string>) => {
      try {
        for (const [k, v] of Object.entries(seed)) sessionStorage.setItem(k, v);
      } catch {
        /* noop */
      }
    }, entries);
  }

  async open(): Promise<void> {
    await this.boards.open();
  }

  /** Reloads the tab — the action this whole ticket is about. */
  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.getByText('Flow Boards', { exact: true }).first().waitFor({ timeout: 60_000 });
  }

  async readState(): Promise<StoredState> {
    const raw = await this.page.evaluate((keys: readonly string[]) => {
      const out: Record<string, string | null> = {};
      for (const k of keys) out[k] = sessionStorage.getItem(k);
      return out;
    }, SESSION_KEYS);
    const parse = <T>(value: string | null): T | null => {
      try {
        return value === null ? null : (JSON.parse(value) as T);
      } catch {
        return null;
      }
    };
    return {
      selectedTab: parse<string | null>(raw['flowBoards.selectedTab']),
      selectedEntity: parse<{ id: number; name: string }>(raw['flowBoards.selectedEntity']),
      filtersByTab: parse<Record<string, Record<string, unknown>>>(raw['flowBoards.filtersByTab']),
      raw,
    };
  }

  /** Which board is painted, decided by content rather than by the tab strip. */
  async paintedBoard(): Promise<{ management: boolean; adminPerformance: boolean }> {
    const text = await this.boards.boardText();
    return {
      management: text.includes(BOARD_MARKERS.management),
      adminPerformance: text.includes(BOARD_MARKERS.adminPerformance),
    };
  }

  /** The Gesellschaft the header shows. */
  async gesellschaftLabel(): Promise<string | null> {
    return await this.page.evaluate(() => {
      const hit = [...document.querySelectorAll('div,span')]
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || '').trim())
        .find((t) => t === 'Alle Gesellschaften' || /^Curano .+ GmbH$/.test(t));
      return hit ?? null;
    });
  }

  /** Any error surface the board can raise, so AC4's "with no error message" is a real assertion. */
  async errorText(): Promise<string[]> {
    const text = await this.boards.boardText();
    return ['Daten konnten nicht geladen werden', 'Fehler', 'Something went wrong', 'Error'].filter((m) =>
      text.includes(m),
    );
  }
}
