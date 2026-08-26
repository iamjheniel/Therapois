import { Page, expect } from '@playwright/test';

export class CRMBasePage {
  constructor(protected page: Page) {}

  async openCRM() {
    // The sidebar CRM button can sit outside the viewport in React Native Web,
    // which makes a normal click hang ("element is outside of the viewport").
    // The button is a link to /crm, so navigate directly (respects the project baseURL).
    await this.page.goto('/crm', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('domcontentloaded');
    // The CRM list sometimes lands on an empty/slow default tab. The "Mit Problemen"
    // tab reliably surfaces practice rows, so settle there if no rows are visible yet.
    await this.ensurePracticeRowsVisible();
  }

  /**
   * Ensures the practice list has rendered rows ("Anzeigen" buttons). The default tab is
   * occasionally empty/slow; the "Mit Problemen" tab reliably has practices. Retries a few
   * times to absorb slow first paints.
   */
  async ensurePracticeRowsVisible(maxTries = 4) {
    const anzeigen = this.page.getByText('Anzeigen', { exact: true });
    for (let i = 0; i < maxTries; i++) {
      if (await anzeigen.first().isVisible({ timeout: 6000 }).catch(() => false)) return;
      await this.page.getByText('Mit Problemen').first().click().catch(() => {});
      await this.page.waitForTimeout(2500);
    }
    // Final wait so callers get a clear assertion failure if the list truly never renders.
    await expect(anzeigen.first()).toBeVisible({ timeout: 15000 });
  }

  async expectHeaderStats() {
    const root = this.page.locator('#root');

    // v3.9.0 (#2937) translated the CRM summary cards to German
    // ("Pending Bestellen" → "Ausstehende Bestellungen"). Accept both so this
    // shared smoke check works on Staging (German) and Production (may still lag).
    await expect(root).toContainText(/Ausstehende Bestellungen|Pending Bestellen/);
    await expect(root).toContainText(/Ausstehende Folge-VOs/);
    await expect(root).toContainText(/Aktive Probleme/);
  }
}
