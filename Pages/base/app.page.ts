import { Locator, Page } from '@playwright/test';

/**
 * The free-text search box on the therapist board and the admin board.
 *
 * The redesign dropped the `text-input-outlined` testid from these surfaces in favour of a
 * placeholder that names what the box matches ("Patient, VO Nr. …" on the therapist board,
 * "Patient, VO-Nr. suchen …" on the admin one). Production has not taken the redesign yet, so both
 * shapes are accepted — remove the testid arm once every environment is on the new build.
 *
 * Note the testid is still used INSIDE modals; this helper is only for the board-level box.
 */
export function boardSearchBox(page: Page): Locator {
  return page
    .getByPlaceholder(/Patient, VO/i)
    .or(page.getByTestId('text-input-outlined'))
    .first();
}

/**
 * Shared base page: centralizes navigation and Production-safe waits so individual specs
 * don't repeat fragile patterns (raw nerd-font glyph clicks, `networkidle` waits that hang
 * on Production, hard-coded sleeps).
 */
export class AppPage {
  constructor(protected page: Page) {}

  /**
   * Navigate to an app path and wait for the DOM only.
   *
   * IMPORTANT: never wait for 'networkidle' — Production polls continuously, so 'networkidle'
   * never settles and times out (~60s). 'domcontentloaded' + the app's own web-first waits is
   * the reliable contract. Accepts an absolute URL or a path (resolved against the baseURL).
   */
  async goto(pathOrUrl = '/dashboard') {
    await this.page.goto(pathOrUrl, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Sidebar collapse toggle. The nerd-font glyph (U+F451) this used to click no longer exists —
   * the left rail is now permanently expanded — so this is a best-effort no-op kept for callers
   * that still invoke it defensively.
   */
  async openSideMenu() {
    /* the rail no longer collapses; nothing to open */
  }

  /**
   * Top-level sidebar entries that expand a submenu (rendered with a "▾" caret). Their children
   * are portalled OUTSIDE the sidebar container, so a submenu item is only findable page-wide and
   * only after its parent has been clicked.
   */
  private static readonly SUBMENUS = ['Upload Dashboard', 'Admin', 'Management'];

  /**
   * Builds an anchored matcher for a nav label. Callers pass loose regexes (e.g. /Rezept/) that
   * date from when entries rendered as "<glyph> <Label>"; anchoring keeps those callers working
   * while stopping a loose match from also hitting the submenu *wrapper* (whose text is every
   * child concatenated, e.g. "TeamERAnnouncements…") or a longer sibling ("Dokument" would
   * otherwise also match "Dokumentenzentrale"). Leading icon glyphs and the trailing caret stay
   * optional.
   */
  private navMatcher(label: string | RegExp): RegExp {
    const src =
      typeof label === 'string' ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : label.source;
    return new RegExp(`^[\\s\\uE000-\\uF8FF]*${src}[\\s▾]*$`);
  }

  /**
   * Matches a sidebar/submenu entry across BOTH nav implementations the app still ships:
   *  - the main rail, where entries are plain `div[tabindex="0"]` with no role/`<button>`/testid, so
   *    the tabindex hook plus the visible label is the only contract;
   *  - the drawer used by pages like /announcement, which are still real `<button role="button">`
   *    elements labelled "<glyph> <Label>" (the shape the whole suite used to rely on).
   * `navMatcher` tolerates the leading glyph, so one matcher covers both.
   */
  private navItem(label: string | RegExp) {
    return this.page
      .locator('div[tabindex="0"], button, [role="button"]')
      .filter({ hasText: this.navMatcher(label) })
      .filter({ visible: true })
      .first();
  }

  /** Clicks a nav entry if it is present. Returns whether the click landed. */
  private async clickNavItem(label: string | RegExp): Promise<boolean> {
    const item = this.navItem(label);
    if (!(await item.isVisible({ timeout: 2000 }).catch(() => false))) return false;
    // The rail can be taller than the viewport, so scroll via the DOM (scrollIntoViewIfNeeded can
    // no-op on RNW scroll containers), then force-click — the rail re-renders/animates, so the
    // "stable" actionability check would otherwise spin. Fall back to a direct DOM click, which
    // RNW Pressables honour.
    await item.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    const clicked = await item
      .click({ force: true, timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return true;
    return await item
      .evaluate((el) => (el as HTMLElement).click())
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Clicks a left-sidebar navigation item by visible label, expanding the owning submenu first
   * when the entry is nested (Rezept/Dokument under "Upload Dashboard"; Team, Arzt Management,
   * Patienten Management, Abrechnung, ICD-Code Verwaltung, Announcements … under "Admin").
   */
  async navTo(label: string | RegExp) {
    const startedAt = this.page.url();
    let everClicked = false;

    // The rail paints its labels before React Native Web attaches the Pressable handlers, so an
    // early click lands on live text but does nothing. Retry until the SPA actually routes.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.attemptNav(label)) {
        everClicked = true;
        const routed = await this.page
          .waitForFunction((from) => location.href !== from, startedAt, { timeout: 6000 })
          .then(() => true)
          .catch(() => false);
        if (routed) return;
      }
      await this.page.waitForTimeout(1500);
    }

    // Clicking worked but the route never changed — we may already be on the target page. Leave the
    // caller's own assertion to describe the mismatch rather than masking it with a nav error.
    if (everClicked) return;

    throw new Error(
      `navTo: no sidebar entry matched ${this.navMatcher(label)} (checked top level and the ` +
        `${AppPage.SUBMENUS.join('/')} submenus)`,
    );
  }

  /** One pass at locating + clicking the entry, expanding submenus as needed. */
  private async attemptNav(label: string | RegExp): Promise<boolean> {
    if (await this.clickNavItem(label)) return true;

    const wanted = this.navMatcher(label);
    for (const parent of AppPage.SUBMENUS) {
      if (wanted.test(parent)) continue; // the target *is* this parent — don't collapse it
      if (!(await this.clickNavItem(parent))) continue;
      // give the portalled submenu a beat to mount before looking for the child
      await this.navItem(label)
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => {});
      if (await this.clickNavItem(label)) return true;
      await this.clickNavItem(parent); // collapse before trying the next parent
    }
    return false;
  }
}
