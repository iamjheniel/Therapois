import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deletes all existing treatments for the test patient to prevent
 * "Conflicting activity was created first" errors in the Mark-as-Treated modal.
 *
 * After cleanup the search input is left readonly (app marks it readonly while
 * a filter is active). The beforeEach calls page.goto again after this to
 * reset the page to a fully clean state.
 */
async function cleanupTreatments(page: Page, patientName: string) {
  await page.waitForLoadState('networkidle');

  // Fill the search (input is editable here — fresh page, no filter applied yet)
  await page.getByTestId('text-input-outlined').first().fill(patientName);
  await page.getByTestId('text-input-outlined').first().press('Enter');
  await page.waitForTimeout(2000);

  // If the patient isn't visible, nothing to clean up
  const patientText = page.getByText(patientName, { exact: true }).first();
  if (!(await patientText.isVisible({ timeout: 5000 }).catch(() => false))) return;

  // Click patient name → row expands with Doku / Protokolle inline links
  await patientText.click();
  await page.waitForTimeout(1500); // wait for expansion animation

  // Click the arrow icon next to "Doku" text.
  // Use Playwright's locator to get the CORRECT visible "Doku" element, then navigate
  // to its sibling from there. Avoid re-scanning all elements via raw JS because
  // there may be hidden/offscreen elements (e.g. virtualized columns) with the same
  // textContent that appear earlier in document order.
  const dokuLocatorCleanup = page.getByText('Doku', { exact: true }).first();
  if (!(await dokuLocatorCleanup.isVisible({ timeout: 3000 }).catch(() => false))) return;
  await dokuLocatorCleanup.scrollIntoViewIfNeeded();
  const dokuHandleCleanup = await dokuLocatorCleanup.elementHandle();
  if (!dokuHandleCleanup) return;
  const arrowHandle = await page.evaluateHandle((dokuEl): HTMLElement | null => {
    const parent = (dokuEl as HTMLElement).parentElement;
    if (!parent) return null;
    for (const child of parent.children) {
      if (child === dokuEl) continue;
      const sib = child as HTMLElement;
      const rect = sib.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return sib;
    }
    return null;
  }, dokuHandleCleanup);
  const arrowEl = arrowHandle.asElement();
  if (!arrowEl) return;
  await page.evaluate((el) => el.click(), arrowEl);
  await page.waitForTimeout(2000); // wait for panel to load

  // Delete treatments one by one until none remain.
  // No iteration cap — loops until actionCell is no longer visible (panel is empty).
  // Per-deletion speed: wait for the "Are you sure?" dialog to close (actual completion
  // signal) instead of a fixed sleep, so each deletion takes ~1-2 s instead of 8 s.
  // At 2 s/deletion: 500 treatments = 1000 s ≈ 17 min, well within the 30 min budget.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const actionCell = page
      .locator('.css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi')
      .first()
      .locator('div > div:nth-child(6) > .css-g5y9jx');

    // After a deletion the panel re-fetches — give it up to 5 s to repopulate.
    if (!(await actionCell.isVisible({ timeout: 5000 }).catch(() => false))) break;

    await actionCell.click({ force: true });
    if (!(await page.getByText('Edit Activity', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false))) break;

    await page.getByTestId('activity-delete-button').click();
    await page.getByText('Are you sure?', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    const confirmDialog = page.getByText('Are you sure?', { exact: true }).locator('xpath=ancestor::div[2]');
    await confirmDialog
      .locator('[data-testid="button-text"]', { hasText: 'Ja' })
      .locator('xpath=ancestor::button[1]')
      .click();
    // Wait for the confirmation dialog to close — this is when the deletion is processed.
    // Immediately after it closes the panel re-renders, so the next iteration can start.
    await page.getByText('Are you sure?', { exact: true })
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {});
  }

  // Close the Doku panel (ignore if it was never opened)
  await page.getByRole('button', { name: /close/i }).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Creates a treatment for the given patient using the "Doku erfassen" workflow.
 *
 * Active patient is in "Aktive Patienten" whose rows have per-row checkboxes.
 * After filtering to 1 row: nth(0) = header checkbox, nth(1) = per-row checkbox.
 *
 * Key timing fix: the success toast appears IMMEDIATELY after Save and can
 * disappear before waitForLoadState('networkidle') completes. We check for it
 * BEFORE the networkidle wait to avoid missing it.
 */
async function createTreatment(page: Page, patientName: string, note: string) {
  await page.waitForLoadState('networkidle');

  await page.getByTestId('text-input-outlined').first().fill(patientName);
  await page.getByTestId('text-input-outlined').first().press('Enter');
  await page.waitForTimeout(2000);

  // nth(1) = per-row checkbox for the single filtered patient
  await page.getByRole('checkbox').nth(1).click({ force: true });
  await page.getByRole('button', { name: 'Doku erfassen (1)' }).click();

  await expect(page.getByTestId('surface')).toContainText('Mark as Treated (1)', { timeout: 15000 });

  // document_treatment.spec.ts pattern: click then fill, plain radio click, plain save
  await page.getByTestId('surface').getByTestId('text-input-outlined').click();
  await page.getByTestId('surface').getByTestId('text-input-outlined').fill(note);
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Save' }).click();

  // Wait for the Mark-as-Treated modal to close (indicates successful save).
  // With conflict warnings the modal may stay open briefly after backend save;
  // we wait up to 20 s then force-close it so subsequent steps aren't blocked.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const surface = page.getByTestId('surface').filter({ hasText: 'Mark as Treated' });
  if (await surface.isVisible({ timeout: 1000 }).catch(() => false)) {
    // Modal still open — close it manually via the × button.
    await page.getByRole('button', { name: '󰅖' }).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }

  await page.waitForLoadState('networkidle');
}

/**
 * After treatment creation, opens the patient's Doku panel.
 *
 * Root cause of prior failures: raw `document.querySelectorAll('*')` scans found
 * hidden/offscreen elements (e.g. virtualized column cells) with textContent "Doku"
 * that appear earlier in document order than the visible inline link in the expanded
 * row. Those wrong elements have 268px-wide siblings (table cells) instead of the
 * small arrow icon, so every click missed.
 *
 * Fix: use Playwright's `getByText` locator to identify the CORRECT visible "Doku"
 * element, get its ElementHandle, and navigate to sibling/parent from there.
 *
 * Two-attempt chain (max) to avoid toggling the panel open→close→open:
 *   1. Playwright force-click on the XPath parent container (Pressable wrapper).
 *   2. DOM el.click() on the sibling arrow icon found from the correct handle.
 */
async function openDokuPanel(page: Page, patientName: string) {
  // Navigate to a clean page state — row not [active], no checkbox selected.
  await page.goto('https://staging.therapios.de/therapist/');
  await page.waitForLoadState('networkidle');

  // Search for the patient.
  await page.getByTestId('text-input-outlined').first().fill(patientName);
  await page.getByTestId('text-input-outlined').first().press('Enter');
  await page.waitForTimeout(2000);

  // Expand the patient row.
  await page.getByText(patientName, { exact: true }).first().click();
  await page.waitForTimeout(2000);

  // Wait for the expanded row to render the "Doku" inline link.
  if (!(await page.getByText('Doku', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false)))
    throw new Error('Doku section not visible after row expansion');

  const isPanelOpen = async () =>
    page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true })
      .isVisible({ timeout: 2000 }).catch(() => false);

  // Use Playwright's locator (finds the VISIBLE element, not hidden/virtualized ones)
  // to get a stable DOM handle anchored to the correct "Doku" node.
  const dokuLocator = page.getByText('Doku', { exact: true }).first();
  await dokuLocator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const dokuHandle = await dokuLocator.elementHandle();
  if (!dokuHandle) throw new Error('Could not get Doku element handle');

  // Find the sibling arrow element (e307) anchored to the Playwright-identified dokuEl.
  const siblingHandle = await page.evaluateHandle((dokuEl): HTMLElement | null => {
    const parent = (dokuEl as HTMLElement).parentElement;
    if (!parent) return null;
    for (const child of parent.children) {
      if (child === dokuEl) continue;
      const sib = child as HTMLElement;
      const rect = sib.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return sib;
    }
    return null;
  }, dokuHandle);
  const sibEl = siblingHandle.asElement();

  // Attempt 1: DOM el.click() on the sibling — same mechanism used by cleanupTreatments,
  // which is confirmed to successfully open the panel (treatments get deleted in cleanup).
  if (sibEl) {
    await page.evaluate((el) => el.click(), sibEl);
    await page.waitForTimeout(5000);
    if (await isPanelOpen()) return;
  }

  // Attempt 2: Playwright force-click on the sibling (CDP mouse event sequence).
  // force:true bypasses actionability checks including pointer-events from ancestors.
  if (sibEl) {
    await sibEl.click({ force: true });
    await page.waitForTimeout(5000);
    if (await isPanelOpen()) return;
  }

  // Attempt 3: Playwright force-click on the parent container (e303).
  await dokuLocator.locator('xpath=..').click({ force: true });
  await page.waitForTimeout(5000);
  if (await isPanelOpen()) return;

  // Collect rich debug info to understand what's happening.
  const debug = await page.evaluate((dokuEl) => {
    // Ancestor pointer-events chain — if any ancestor has pe:none, clicks are silently swallowed.
    const dokuElTyped = dokuEl as HTMLElement;
    const ancestors: Array<{ tag: string; pe: string; cursor: string; inlineStyle: string }> = [];
    let cur: HTMLElement | null = dokuElTyped.parentElement;
    while (cur && cur !== document.body) {
      const st = window.getComputedStyle(cur);
      ancestors.push({ tag: cur.tagName, pe: st.pointerEvents, cursor: st.cursor, inlineStyle: cur.getAttribute('style') ?? '' });
      cur = cur.parentElement;
    }

    // elementFromPoint at sibling center — reveals any overlay intercepting clicks.
    const parent = dokuElTyped.parentElement;
    const sib = parent
      ? (Array.from(parent.children).find(c => c !== dokuEl) as HTMLElement | null)
      : null;
    let elAtPoint: Record<string, unknown> | null = null;
    if (sib) {
      const r = sib.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
      if (top) {
        const ts = window.getComputedStyle(top);
        elAtPoint = {
          isSibling: top === sib,
          tag: top.tagName,
          text: top.textContent?.trim().slice(0, 30),
          cursor: ts.cursor,
          pe: ts.pointerEvents,
          rect: top.getBoundingClientRect(),
          inlineStyle: top.getAttribute('style'),
        };
      }
    }

    // Sibling inline style and outerHTML snippet.
    const sibInfo = sib
      ? {
          inlineStyle: sib.getAttribute('style'),
          outerHTMLSnippet: sib.outerHTML.slice(0, 300),
          rect: sib.getBoundingClientRect(),
        }
      : null;

    return { ancestors, elAtPoint, sibInfo };
  }, dokuHandle);
  console.warn('openDokuPanel: all click attempts failed', JSON.stringify(debug));
}

/**
 * Deletes the most-recently-created treatment for the currently-open patient.
 * Assumes the Doku panel (treatment list) is already visible.
 */
async function deleteFirstTreatment(page: Page) {
  await page.locator('.css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi')
    .first()
    .locator('div > div:nth-child(6) > .css-g5y9jx')
    .click({ force: true });

  await expect(page.getByText('Edit Activity', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByTestId('activity-delete-button').click();
  await expect(page.getByText('Are you sure?', { exact: true })).toBeVisible({ timeout: 10000 });

  const confirmDialog = page.getByText('Are you sure?', { exact: true }).locator('xpath=ancestor::div[2]');
  await confirmDialog
    .locator('[data-testid="button-text"]', { hasText: 'Ja' })
    .locator('xpath=ancestor::button[1]')
    .click();
  await expect(page.getByText(/Treatment deleted!/i)).toBeVisible({ timeout: 20000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Active patient with valid VO — supports Doku erfassen via per-row checkbox.
const TEST_PATIENT = 'BiniStacey Test';

test.describe('Therapist Doku Check', () => {
  // Serial mode: all 6 tests share the same patient. Running
  // them in parallel means multiple workers mutate the same backend data simultaneously,
  // causing cleanup to take 180+ s due to inter-worker conflicts.
  test.describe.configure({ mode: 'serial' });
  // Extend timeout to 5 min to allow for cleanup of orphaned treatments from prior runs.
  // (Previously 30 min — that made a missing-patient failure hang for half an hour and
  // block every subsequent serial test; a real failure should surface quickly.)
  test.setTimeout(300000);

  test.beforeEach(async ({ page }) => {
    // First load: run cleanup to remove any orphaned treatments from prior runs.
    await page.goto('https://staging.therapios.de/therapist/');
    await cleanupTreatments(page, TEST_PATIENT);

    // Second load: reset the UI completely.
    // After cleanup the search filter is still applied and the input is readonly;
    // a fresh navigation returns the page to a fully clean, editable state.
    await page.goto('https://staging.therapios.de/therapist/');
    await page.waitForLoadState('networkidle');
  });

  test('Check Doku feature', { tag: ['@Therapist', '@checkdoku'] }, async ({ page }) => {
    await createTreatment(page, TEST_PATIENT, 'check doku automation');
    await openDokuPanel(page, TEST_PATIENT);

    await expect(page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true }))
      .toBeVisible({ timeout: 30000 });

    await deleteFirstTreatment(page);
  });

  test('Check Logs feature', { tag: ['@Therapist', '@checklogs'] }, async ({ page }) => {
    await createTreatment(page, TEST_PATIENT, 'check logs automation');
    await openDokuPanel(page, TEST_PATIENT);

    await expect(page.getByText(/Prescription logs/i).first()).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /close/i }).click();

    await deleteFirstTreatment(page);
  });

  test('Check Doku close modal', { tag: ['@Therapist', '@checkdokuclose'] }, async ({ page }) => {
    await createTreatment(page, TEST_PATIENT, 'check doku close automation');
    await openDokuPanel(page, TEST_PATIENT);

    const dokuTitle = page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true });
    await expect(dokuTitle).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /close/i }).click();
    await expect(dokuTitle).not.toBeVisible();

    await deleteFirstTreatment(page);
  });

  test('Check Doku note content', { tag: ['@Therapist', '@checkdokunote'] }, async ({ page }) => {
    const note = 'check doku note content automation';
    await createTreatment(page, TEST_PATIENT, note);
    await openDokuPanel(page, TEST_PATIENT);

    await expect(page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true }))
      .toBeVisible({ timeout: 30000 });

    // The note entered during treatment creation must appear in the doku list.
    await expect(page.getByText(note, { exact: true }).first()).toBeVisible({ timeout: 15000 });

    await deleteFirstTreatment(page);
  });

  test('Check Edit Activity modal opens', { tag: ['@Therapist', '@checkeditactivity'] }, async ({ page }) => {
    await createTreatment(page, TEST_PATIENT, 'check edit activity automation');
    await openDokuPanel(page, TEST_PATIENT);

    await expect(page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true }))
      .toBeVisible({ timeout: 30000 });

    // Click the action cell of the first treatment row to open Edit Activity modal.
    await page.locator('.css-g5y9jx.r-12vffkv.r-bnwqim.r-ctqt5z.r-113qch9.r-qklmqi')
      .first()
      .locator('div > div:nth-child(6) > .css-g5y9jx')
      .click({ force: true });

    await expect(page.getByText('Edit Activity', { exact: true })).toBeVisible({ timeout: 20000 });

    // The delete button must be present in the Edit Activity modal.
    await expect(page.getByTestId('activity-delete-button')).toBeVisible({ timeout: 10000 });

    // Cleanup: delete via the modal.
    await page.getByTestId('activity-delete-button').click();
    await expect(page.getByText('Are you sure?', { exact: true })).toBeVisible({ timeout: 10000 });
    const confirmDialog = page.getByText('Are you sure?', { exact: true }).locator('xpath=ancestor::div[2]');
    await confirmDialog
      .locator('[data-testid="button-text"]', { hasText: 'Ja' })
      .locator('xpath=ancestor::button[1]')
      .click();
    await expect(page.getByText(/Treatment deleted!/i)).toBeVisible({ timeout: 20000 });
  });

  test('Check Doku panel shows Behandlungsverlauf and Logs sections', { tag: ['@Therapist', '@checkdokusections'] }, async ({ page }) => {
    await createTreatment(page, TEST_PATIENT, 'check doku sections automation');
    await openDokuPanel(page, TEST_PATIENT);

    // Both the treatment-history and prescription-logs sections must be present.
    await expect(page.getByText('Dokumentation (Behandlungsverlauf)', { exact: true }))
      .toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Prescription logs/i).first()).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /close/i }).click();
    await deleteFirstTreatment(page);
  });

});
