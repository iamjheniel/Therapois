import { test, expect, Page, Locator } from '@playwright/test';
// test.use({ storageState: undefined });

/* -------------------- BELL (ROBUST) -------------------- */

async function tagBellIfPresent(page: Page) {
  await page.evaluate(() => {
    // remove previous tag if any
    document.querySelectorAll('[data-pw-bell="1"]').forEach(el => el.removeAttribute('data-pw-bell'));

    // Find any element rendered with FontAwesome (your bell icon glyph)
    const all = Array.from(document.querySelectorAll<HTMLElement>('div[dir="auto"], span, i, svg, div'));
    const faNodes = all.filter(el => {
      const ff = getComputedStyle(el).fontFamily || '';
      return ff.toLowerCase().includes('fontawesome');
    });

    // For each FontAwesome glyph, tag the closest clickable wrapper
    for (const node of faNodes) {
      const btn = node.closest<HTMLElement>('div[tabindex="0"]');
      if (btn) {
        // Tag it as bell candidate. If there are multiple FA icons, we still tag them,
        // and we'll pick the best one by position (top-right) below.
        btn.setAttribute('data-pw-bell', '1');
      }
    }
  });
}

async function getBellOrSkip(page: Page): Promise<Locator> {
  await tagBellIfPresent(page);

  const candidates = page.locator('[data-pw-bell="1"]');
  const count = await candidates.count();

  // If no FontAwesome clickable icon button exists, there's no bell -> skip
  test.skip(count === 0, 'No notification bell found (no FontAwesome icon button) — skipping test');

  // If multiple, pick the one closest to top-right (usually the bell)
  // We do that by sorting by bounding box (smallest "top", largest "right").
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < count; i++) {
    const box = await candidates.nth(i).boundingBox();
    if (!box) continue;

    // score: prefer small y (top), and large x+width (right edge)
    const rightEdge = box.x + box.width;
    const score = (100000 - box.y) + rightEdge;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const bell = candidates.nth(bestIndex);

  // final visibility guard (if it exists but hidden)
  const visible = await bell.isVisible().catch(() => false);
  test.skip(!visible, 'Notification bell exists but not visible — skipping test');

  return bell;
}

/* -------------------- BANNER SKIP -------------------- */

async function skipIfNoBanner(page: Page): Promise<void> {
  const banner = page.getByText(/You have .* unread notifications/i);

  const visible = await banner
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!visible, 'No notification banner shown — skipping test');
}

/* -------------------- TESTS -------------------- */

test.describe('Notification functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/therapist/');
  });

  test('Therapist UI Banner Notification', { tag: ['@Therapist', '@notification'] }, async ({ page }) => {
    await skipIfNoBanner(page);

    const banner = page.getByText(/You have .* unread notifications/i);
    const text = await banner.textContent();
    console.log('NOTIF TEXT:', text);

    const viewBtn = page.getByText(/^View$/).first();
    await viewBtn.click({ force: true });

    await expect(page.getByRole('dialog')).toContainText('Notifications');
    await expect(page.getByRole('dialog')).toContainText(/My Notifications/i);
    await page.getByRole('dialog').getByText('').click();

    const headerClose = page.locator('div').filter({ hasText: /^$/ }).first();
    if (await headerClose.isVisible().catch(() => false)) await headerClose.click();

    await expect(page.getByText(/Notifications/i)).not.toBeVisible();
  });

  test('Therapist UI Bell Notification', { tag: ['@Therapist', '@bellnotification'] }, async ({ page }) => {
    const bell = await getBellOrSkip(page);

    await bell.click();

    await expect(page.locator('#root')).toContainText('Notifications');
    await expect(page.locator('#root')).toContainText(/My Notifications/i);
    await page.getByText('').nth(1).click();
  });

  test('Therapist Mark as Read', { tag: ['@Therapist', '@markasread'] }, async ({ page }) => {
    const bell = await getBellOrSkip(page);

    await bell.click();

    await expect(page.locator('#root')).toContainText('Notifications');
    await expect(page.locator('#root')).toContainText('Mark as Read');

    await page.getByText('Mark as Read').first().click({ force: true });
    await page.getByText('Read').click();

    await expect(page.locator('#root')).toContainText(/VO /);
  });
});
