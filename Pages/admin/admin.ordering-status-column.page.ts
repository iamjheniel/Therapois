import { Page, expect } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS, mintUiSession, type Credentials } from '../util/api-token';
import { settleAfter } from '../util/settle';
import { AdminDashboardPage } from './admin.dashboard.page';

/**
 * The Admin Board's **Bestell Status** column — RC 3.14 #3749, commits `5cbbf4ff6` (app) and
 * `14bd9aff4` (api), both on `release/3.14.0`, both landed under a `Ref #3749` trailer with no PR.
 *
 * The column showed "—" for the two facility-driven ordering statuses and still opened an editor
 * that could overwrite them. `StatusPillSelect` resolves its label out of the `options` array it is
 * handed, and the cell handed it only `[By Admin, By Therapist]`, so a VO carrying `Praxis` or
 * `ER bestellt selbst` resolved to `undefined` and fell through to the dash.
 *
 * ## Two commits, two independent deploys, and `/status` answers for neither
 *
 * The display fix is frontend (`roleCells.tsx` + `DashboardTable.tsx`) and the sort fix is API
 * (`OrderingStatusOrderFilter`). `GET /status` reports the RELEASE, not the commit (#3704), and
 * says nothing at all about the app bundle (#3705) — so each half is decided behaviourally:
 *
 *  - the API half by {@link sortedFirstValue}, because the two candidate orders are completely
 *    disjoint (see {@link RANKED_ASC} vs {@link LEXICOGRAPHIC_ASC});
 *  - the frontend half by reading the painted cell, which is the ticket's own subject anyway.
 *
 * A bundle grep is deliberately NOT used for the frontend half: the change is a `const
 * facilityDriven = …` and a `disabled={… || facilityDriven}`, both of which minify to nothing
 * greppable, so a zero would mean nothing either way (#3602's lesson about renamed identifiers).
 *
 * ## Traps
 *
 *  - **`button[aria-label^="Status: "]` is NOT unique to this column.** Beh. Status, VO Status and
 *    Folge-VO Status use the same pattern — a first probe here grabbed `Status: Aktiv` from the
 *    Beh. Status column and concluded the editor was showing the wrong value. Every cell read here
 *    is scoped to the header's own x-band ({@link orderingCell}).
 *  - **The column is far to the right of a 1440px viewport** (measured at x≈2017), inside the
 *    table's horizontally-scrolling port. Reading it works at any scroll position, but a click by
 *    coordinates silently does nothing — go through a Playwright locator, which scrolls it in.
 *  - **The editor is not a `role="menu"`.** It paints two plain leaves stacked directly under the
 *    cell, so it is detected by those labels appearing below the cell's own y, never by role.
 *  - **The column is OFF by default** — it must be switched on through the Spalten chooser, and
 *    that preference is sticky in `hidden_column_admin:dashboard`.
 *  - **Never `page.reload()` after `mintUiSession`.** The refresh token is single-use and the
 *    re-injected one is already spent, so the reload lands on the login form (#3460).
 */

/** The four values `FollowupOrderingStatus` stores — display strings, not keys (#3759). */
export const ORDERING_STATUSES = ['By Admin', 'By Therapist', 'Praxis', 'ER bestellt selbst'] as const;
export type OrderingStatus = (typeof ORDERING_STATUSES)[number];

/** The German labels the board paints, from the ticket's Localization Reference. */
export const LABELS: Record<OrderingStatus, string> = {
  'By Admin': 'Vom Admin',
  'By Therapist': 'Von Therapeut',
  Praxis: 'Praxis',
  'ER bestellt selbst': 'ER bestellt selbst',
};

/** AC1: the two an admin sets, which keep the editor they have today. */
export const ADMIN_SETTABLE: OrderingStatus[] = ['By Admin', 'By Therapist'];

/** AC1: the two that come from the facility's ordering mode, read-only for every role. */
export const FACILITY_DRIVEN: OrderingStatus[] = ['Praxis', 'ER bestellt selbst'];

/** `OrderingStatusOrderFilter::RANKS` — ascending = the German labels in alphabetical order. */
export const RANKED_ASC: OrderingStatus[] = ['ER bestellt selbst', 'Praxis', 'By Admin', 'By Therapist'];

/**
 * What the stock `OrderFilter` produced before `14bd9aff4`: a lexicographic sort of the STORED
 * strings, which matched no order the board renders. Kept as the pre-fix arm of the oracle.
 */
export const LEXICOGRAPHIC_ASC: OrderingStatus[] = ['By Admin', 'By Therapist', 'ER bestellt selbst', 'Praxis'];

export const COLUMN_HEADER = 'Bestell Status';

/** The ticket's own reproduction VOs, plus the editable and locked controls they are read against. */
export const FIXTURES = {
  /** Ordering status Praxis, facility `Praxis Flow Test Praxis (PM)` (orderingMode `praxis_vo`). */
  praxis: '99651-1',
  /** Ordering status ER bestellt selbst, facility HH27 (orderingMode `er_bestellt_selbst`). */
  er: '7381-4',
  /** By Admin, no billing validation — the editor must still open here (AC3). */
  byAdmin: '375-46',
  /** By Therapist, no billing validation. */
  byTherapist: '532-13',
  /** By Admin AND `validationStatus: validated` — AC4's lock, Aktiv so the board shows it. */
  validatedByAdmin: '5104-1',
} as const;

export type CellRead = {
  /** The painted label, or `null` when the column has no cell on this row. */
  text: string | null;
  /** True when the cell is an editor (a `StatusPillSelect`), false for a read-only `StatusPill`. */
  editable: boolean;
  ariaLabel: string | null;
  /** `"true"` when the editor is present but locked — AC4's billing-validation lock. */
  ariaDisabled: string | null;
  cursor: string | null;
  /** Index of this cell's button among all `Status: ` buttons on the page, for a scoped click. */
  buttonIndex: number;
};

export class OrderingStatusColumnPage {
  /** One token per role for the whole file — `POST /auth` is throttled at 5/min per username (#3462). */
  private static tokens = new Map<string, string>();

  readonly board: AdminDashboardPage;

  constructor(private page: Page) {
    this.board = new AdminDashboardPage(page);
  }

  // ───────────────────────────── API ─────────────────────────────

  async bearer(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    const cached = OrderingStatusColumnPage.tokens.get(credentials.email);
    if (cached) return cached;
    const res = await this.page.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: credentials.email, password: credentials.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth as ${credentials.email} -> ${res.status()}`);
    const token = (await res.json()).token as string;
    OrderingStatusColumnPage.tokens.set(credentials.email, token);
    return token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.page.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  /** `totalItems` for one ordering status — the filter is `exact` and genuinely partitions. */
  async countOf(status: OrderingStatus | null): Promise<number> {
    const q = status === null ? '' : `orderingStatus=${encodeURIComponent(status)}&`;
    const body = await this.get<{ totalItems?: number }>(`/prescriptions?${q}itemsPerPage=1`);
    return body.totalItems ?? -1;
  }

  /**
   * The ordering status of the row at `position` under `order[orderingStatus]`.
   *
   * `itemsPerPage=1&page=N` addresses one row by ordinal, which is what makes the whole ranked
   * partition provable in eight requests instead of a 35,000-row walk.
   */
  async statusAtPosition(
    position: number,
    direction: 'asc' | 'desc' = 'asc',
    resource: 'prescriptions' | 'v2/prescriptions' = 'prescriptions',
  ): Promise<string | null> {
    const body = await this.get<any>(
      `/${resource}?order%5BorderingStatus%5D=${direction}&itemsPerPage=1&page=${position}`,
    );
    const rows = Array.isArray(body) ? body : (body.member ?? []);
    return rows.length ? ((rows[0].orderingStatus as string) ?? null) : null;
  }

  /** The first value a sorted page serves — the discriminator between the two candidate orders. */
  async sortedFirstValue(
    direction: 'asc' | 'desc',
    resource: 'prescriptions' | 'v2/prescriptions',
  ): Promise<string | null> {
    return this.statusAtPosition(1, direction, resource);
  }

  /** Whether `order[orderingStatus]` is still advertised after the stock entry was removed. */
  async advertisesOrderKey(resource: 'prescriptions' | 'v2/prescriptions'): Promise<boolean> {
    const body = await this.get<any>(`/${resource}?itemsPerPage=1`);
    return String(body?.search?.template ?? '').includes('order[orderingStatus]');
  }

  async voByNumber(prescriptionId: string): Promise<Record<string, any> | null> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/prescriptions?exact%5BprescriptionId%5D=${encodeURIComponent(prescriptionId)}&itemsPerPage=2`,
    );
    return body.member?.[0] ?? null;
  }

  // ───────────────────────────── screen ─────────────────────────────

  /**
   * Signs in as `credentials`, opens the board and switches the column on.
   *
   * **`auth-state` is cleared before the first navigation, and that is load-bearing for AC4.**
   * `mintUiSession` only replaces the refresh token; the project's saved `storageState` still
   * carries the Super Admin's `{user: {roles}}`, and the app reads roles from there while `/me`
   * is in flight. So a board opened "as the admin" can render with `isSuper` true — which shows a
   * billing-validated cell as editable and reports AC4's lock as missing. Removing the stored user
   * forces the app to derive the role from the token it just minted.
   */
  async openBoardWithColumn(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await mintUiSession(this.page, credentials);
    await this.page.addInitScript(() => {
      try {
        localStorage.removeItem('auth-state');
      } catch {
        /* a context that refuses storage has nothing stale to clear */
      }
    });
    await this.board.open({ resetPreferences: true });
    await this.board.openColumnChooser();
    await this.board.setColumn(COLUMN_HEADER, true);
    await this.board.closeColumnChooser();
    await expect(this.page.getByText(COLUMN_HEADER, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  }

  /** The roles the app is actually running with — read back rather than assumed (see above). */
  async currentRoles(): Promise<string[]> {
    return await this.page.evaluate(() => {
      try {
        const state = JSON.parse(localStorage.getItem('auth-state') || '{}');
        return (state?.user?.roles as string[]) ?? [];
      } catch {
        return [];
      }
    });
  }

  /**
   * The Bestell Status cell of the row at `rowIndex`, read by the header's own x-band.
   *
   * Scoped by geometry rather than by `aria-label`, because three other columns paint
   * `Status: <label>` buttons too.
   */
  async orderingCell(rowIndex = 0): Promise<CellRead> {
    return await this.page.evaluate(
      ({ header, index }) => {
        const leaves = [...document.querySelectorAll('div,span')].filter(
          (e) => e.children.length === 0 && (e.textContent || '').trim(),
        ) as HTMLElement[];
        const hdr = leaves.find((e) => (e.textContent || '').trim() === header);
        if (!hdr) return { text: null, editable: false, ariaLabel: null, ariaDisabled: null, cursor: null, buttonIndex: -1 };
        const band = hdr.getBoundingClientRect();
        const inColumn = (r: DOMRect) => r.width > 0 && r.left >= band.left - 60 && r.left < band.right + 60;
        const cell = leaves
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return inColumn(r) && r.top > band.bottom;
          })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[index];
        if (!cell) return { text: null, editable: false, ariaLabel: null, ariaDisabled: null, cursor: null, buttonIndex: -1 };

        let node: HTMLElement | null = cell;
        for (let i = 0; i < 5 && node; i++) {
          if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') break;
          node = node.parentElement;
        }
        const editable = !!node && (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button');
        const buttons = [...document.querySelectorAll('button[aria-label^="Status: "]')];
        return {
          text: (cell.textContent || '').trim(),
          editable,
          ariaLabel: editable ? node!.getAttribute('aria-label') : null,
          ariaDisabled: editable ? node!.getAttribute('aria-disabled') : null,
          cursor: getComputedStyle(editable ? node! : cell).cursor,
          buttonIndex: editable ? buttons.indexOf(node as Element) : -1,
        };
      },
      { header: COLUMN_HEADER, index: rowIndex },
    );
  }

  /** Every value painted in the column, top to bottom. */
  async columnValues(): Promise<string[]> {
    return await this.page.evaluate((header) => {
      const leaves = [...document.querySelectorAll('div,span')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim(),
      ) as HTMLElement[];
      const hdr = leaves.find((e) => (e.textContent || '').trim() === header);
      if (!hdr) return [];
      const band = hdr.getBoundingClientRect();
      return leaves
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.top > band.bottom && r.left >= band.left - 60 && r.left < band.right + 60;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .map((e) => (e.textContent || '').trim())
        // The column's rows are separated by zero-width leaves, which survive `trim()` and are
        // truthy — so a bare `filter(Boolean)` keeps them and they read back as "" in a log and as
        // strays in a "every value is one of the four labels" assertion.
        .filter((t) => /\p{L}/u.test(t));
    }, COLUMN_HEADER);
  }

  /** Searches for one VO and waits until the board has narrowed to it. */
  async showOnly(prescriptionId: string): Promise<void> {
    await this.board.search(prescriptionId);
    await expect
      .poll(async () => (await this.board.renderedRowCount().catch(() => 0)), { timeout: 45_000, intervals: [1000] })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await this.orderingCell()).text, { timeout: 30_000, intervals: [1000] })
      .not.toBeNull();
  }

  /**
   * Opens the cell's editor and returns the option labels it paints.
   *
   * The editor is two plain leaves stacked directly under the cell — no `role="menu"` — so they
   * are read by position. Nothing is selected: choosing an option writes.
   */
  async openEditorOptions(): Promise<string[]> {
    const cell = await this.orderingCell();
    if (!cell.editable || cell.buttonIndex < 0) return [];
    // `force`, deliberately. A cell locked by billing validation is an `aria-disabled` button, and
    // an ordinary click on one waits out its actionability timeout instead of answering the
    // question — while a FORCED click dispatches and lets the absence of an editor be the result.
    // That is the stronger statement anyway: AC4's lock has to survive the press, not merely
    // discourage it.
    await this.page
      .locator('button[aria-label^="Status: "]')
      .nth(cell.buttonIndex)
      .click({ force: true, timeout: 15_000 });
    // The options paint a beat after the press — reading straight after the click returns an empty
    // list, which looks exactly like "the editor did not open" and is how this helper first failed.
    // Poll rather than sleep: a locked cell legitimately never paints any, so the caller needs the
    // empty answer promptly and the open case needs however long it takes.
    const options = await this.page
      .waitForFunction(
        () => {
          const wanted = ['Vom Admin', 'Von Therapeut', 'Praxis', 'ER bestellt selbst'];
          const hits = [...document.querySelectorAll('div,span')]
            .filter((e) => e.children.length === 0 && wanted.includes((e.textContent || '').trim()))
            .map((e) => ({ t: (e.textContent || '').trim(), r: e.getBoundingClientRect() }))
            .filter((o) => o.r.width > 0)
            .sort((a, b) => a.r.top - b.r.top);
          if (hits.length < 2) return null;
          const top = hits[0].r.top;
          const below = hits.filter((o) => o.r.top > top + 4).map((o) => o.t);
          return below.length ? [...new Set(below)] : null;
        },
        undefined,
        { timeout: 8_000, polling: 300 },
      )
      .then((handle) => handle.jsonValue() as Promise<string[]>)
      .catch(() => [] as string[]);

    return options;
  }

  async closeEditor(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);
  }

  /**
   * Clicks the column header, which is how the board asks the API for `order[orderingStatus]`.
   *
   * The sort is a SERVER round trip, so the click must be wrapped rather than followed by a sleep:
   * reading straight after it returns the PREVIOUS ordering, which looks exactly like the sort
   * doing nothing. `settleAfter` waits for the requests the click itself triggered.
   */
  async sortByColumn(): Promise<void> {
    const before = (await this.columnValues())[0] ?? null;
    await settleAfter(this.page, async () => {
      await this.page.getByText(COLUMN_HEADER, { exact: true }).first().click({ force: true, timeout: 20_000 });
    });
    // …and then for the table to repaint from it. A re-sort that legitimately leaves the first
    // value alone would time out here, so the poll is bounded and its result is not asserted.
    await expect
      .poll(async () => (await this.columnValues())[0] ?? null, { timeout: 20_000, intervals: [750] })
      .not.toBe(before)
      .catch(() => undefined);
  }
}
