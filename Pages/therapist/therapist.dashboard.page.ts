import { Page, Locator, expect } from '@playwright/test';
import { settleAfter, waitForOpen, waitForStable } from '../util/settle';
import { boardSearchBox } from '../base/app.page';

/**
 * Page Object for two previously-untested Therapist dashboard controls:
 *
 *   - "Überprüfen" review banners — the yellow reminder banners above the patient list
 *     ("N Patienten wurden seit 14+ Tagen nicht behandelt", "TB fällig (N)", "VOs laufen aus (N)").
 *     Each carries an "Überprüfen" (Review) link that opens a popover listing the affected patients.
 *
 *   - "Bestellt von" (Ordered by) — an action-bar dropdown (options: Therapeut / Admin) that records
 *     who ordered the follow-up VO for the selected patient row.
 *
 * The app is React-Native-Web: controls are `div`s without roles, banner text is duplicated
 * (an inline link plus a right-aligned button render the same "Überprüfen" string), and options
 * are plain text nodes. Selectors therefore lean on exact visible German text.
 *
 * Both features are data-dependent — banners only show when items are due, and the dropdown needs
 * a selected patient — so the helpers report false/empty rather than throwing so callers can skip.
 */
export class TherapistDashboardPage {
  /** The three review-banner shapes, matched loosely on their stable German phrasing. */
  private static REVIEW_BANNER = /seit 14\+ Tagen nicht behandelt|TB fällig \(\d+\)|VOs laufen aus \(\d+\)/;

  constructor(private page: Page) {}

  private searchBox(): Locator {
    // The redesigned board dropped the `text-input-outlined` testid on this surface in favour of a
    // placeholder ("Patient, VO Nr. …"); Production still serves the older build, so accept either.
    return boardSearchBox(this.page);
  }

  /** Loads the therapist landing page and lets the reminder banners paint. */
  async open(baseUrl = 'https://staging.therapios.de'): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.goto(`${baseUrl}/therapist/`, { waitUntil: 'domcontentloaded' });
    await this.searchBox().waitFor({ state: 'visible', timeout: 45_000 });
    // The search box paints ahead of the board rows and the Hinweise panel behind it, and every
    // caller reads those. Wait for the row set to stop changing instead of sleeping 2.5 s at it.
    await waitForStable(this.page.getByRole('checkbox'));
  }

  // ─────────────────────────── Überprüfen review banners ───────────────────────────

  /**
   * Polls for review banners for up to `timeoutMs` before concluding none are due. The banners
   * render off a background data fetch that can lag several seconds after the list paints, so a
   * single immediate read would spuriously report "nothing due" (and skip the test).
   */
  async waitForReviewBanners(timeoutMs = 15_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const banners = await this.reviewBannerTexts();
      if (banners.length > 0 || Date.now() > deadline) return banners;
      await this.page.waitForTimeout(300);
    }
  }

  /** Deduped visible review-banner strings currently shown (empty when nothing is due). */
  async reviewBannerTexts(): Promise<string[]> {
    return this.page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const out = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (re.test(t) && t.length < 90 && el.children.length <= 3) out.add(t);
      }
      return [...out];
    }, TherapistDashboardPage.REVIEW_BANNER.source);
  }

  /** True when the "14+ Tagen nicht behandelt" banner (the one with a patient popover) is shown. */
  async has14DayBanner(): Promise<boolean> {
    return (await this.waitForReviewBanners()).some((t) => /seit 14\+ Tagen nicht behandelt/.test(t));
  }

  /**
   * Opens the "14+ Tagen nicht behandelt" banner's review popover and reports whether it rendered.
   * The popover lists patients with a "Zuletzt:" (last-treated) date, which is the presence signal.
   * The Überprüfen link is scoped to that banner's row so the correct popover opens regardless of
   * how many other review banners are present.
   */
  async open14DayReviewPopover(): Promise<boolean> {
    const banner = this.page
      .locator('div')
      .filter({ hasText: /seit 14\+ Tagen nicht behandelt/ })
      .filter({ has: this.page.getByText('Überprüfen', { exact: true }) })
      .last();
    const link = banner.getByText('Überprüfen', { exact: true }).first();
    if (!(await link.count())) return false;
    await settleAfter(this.page, () => link.click({ force: true }), { budgetMs: 12_000 });
    return this.page.getByText(/Zuletzt:/).first().isVisible().catch(() => false);
  }

  /** Asserts the open review popover lists at least one affected patient (a "Zuletzt:" entry). */
  async assertReviewPopoverListsPatients(): Promise<void> {
    await expect(this.page.getByText(/Zuletzt:/).first()).toBeVisible();
  }

  async closePopover(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.mouse.click(5, 400).catch(() => {}); // click away from any popover
    await this.page.waitForTimeout(500);
  }

  // ─────────────────────────── Bestellt von (Ordered by) ───────────────────────────

  /**
   * Filters the list and selects the first patient row (the "Bestellt von" dropdown acts on the
   * selected VO). Returns false when no patient row is available.
   */
  async filterAndSelectFirstRow(term = 'Test'): Promise<boolean> {
    const box = this.searchBox();
    await box.click();
    await box.fill(term);
    // Searching refetches the board; settle on that rather than the flat 2.5 s, which was both
    // slower than the common case and too short whenever staging lagged (the checkbox count below
    // would then read the PREVIOUS result set and the method would wrongly report "no rows").
    await settleAfter(this.page, () => box.press('Enter'), { budgetMs: 15_000 });
    if ((await this.page.getByRole('checkbox').count()) < 2) return false;
    await this.page.getByRole('checkbox').nth(1).click({ force: true });
    await this.page.waitForTimeout(600);
    return true;
  }

  private option(name: 'Therapeut' | 'Admin'): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true });
  }

  /**
   * Opens the "Bestellt von" dropdown and reports whether its options surfaced. Does NOT pick an
   * option — selecting one records who ordered the follow-up VO (a backend mutation), which the
   * test deliberately avoids.
   */
  async openBestelltVonDropdown(): Promise<boolean> {
    const trigger = this.page.getByText('Bestellt von', { exact: true }).filter({ visible: true }).first();
    if (!(await trigger.count())) return false;
    await trigger.click({ force: true });
    // The dropdown's own options are the readiness signal the return value reads.
    await waitForOpen(this.option('Therapeut'), 6_000);
    return (await this.option('Therapeut').count()) > 0 && (await this.option('Admin').count()) > 0;
  }

  /** Asserts both "Bestellt von" options (Therapeut, Admin) are visible in the open dropdown. */
  async assertBestelltVonOptions(): Promise<void> {
    await expect(this.option('Therapeut').first()).toBeVisible();
    await expect(this.option('Admin').first()).toBeVisible();
  }
}
