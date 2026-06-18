import { Page } from '@playwright/test';

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
   * Opens the collapsed left sidebar via its menu toggle (a nerd-font glyph, U+F451).
   * Best-effort — if the sidebar is already expanded the click is a harmless no-op.
   */
  async openSideMenu() {
    await this.page
      .getByText('')
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  }

  /**
   * Clicks a left-sidebar navigation item by visible label, glyph-agnostic.
   *
   * Sidebar buttons render as "<glyph> <Label>" (e.g. " Team"), so matching the literal name
   * is brittle. We match the label via regex and open the side menu first if the item isn't
   * already visible.
   */
  async navTo(label: string | RegExp) {
    const rx = typeof label === 'string' ? new RegExp(label) : label;
    const item = this.page.getByRole('button', { name: rx }).first();
    if (!(await item.isVisible({ timeout: 3000 }).catch(() => false))) {
      await this.openSideMenu();
    }
    await item.waitFor({ state: 'visible', timeout: 15000 });
    // The sidebar can be taller than the viewport, so the item may be below the fold. Scroll it
    // to centre via the DOM (more reliable than scrollIntoViewIfNeeded, which can no-op on RNW
    // scroll containers). Then force-click — the sidebar re-renders/animates, so Playwright's
    // "stable" actionability check would otherwise spin. If the force-click still can't land
    // (element off-screen/detached), fall back to a direct DOM click, which RNW Pressables honour.
    await item.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await item.click({ force: true, timeout: 8000 }).catch(async () => {
      await item.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
    });
  }
}
