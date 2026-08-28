import { Page, Locator } from '@playwright/test';
import { settleAfter } from '../util/settle';

/**
 * Page Object for the RC 3.9 "ETI Experts Debt Collection (PKV)" epic (#2947): the PKV-Abrechnung
 * tab's German invoice-status subtabs (#2951), the "An ETI Experts senden" submission action on the
 * Inkasso (To Debt Collector) subtab (#2949), and the "Als bezahlt/uneinbringlich markieren" outcome
 * actions on the "An Inkasso gesendet" (Sent to DC) subtab (#2950).
 *
 * Reached at /billing → the "PKV-Abrechnung" top tab (the /billing page is "Validierung, Abrechnung
 * & Zuzahlung", with tabs Validierung / GKV-Abrechnung / Zuzahlungsverwaltung / PKV-Abrechnung).
 *
 * SAFETY: submitting to ETI or marking paid/uncollectable mutates invoice status and (for ETI) calls
 * the external ETI API — this POM opens those dialogs but the specs always CANCEL, never confirm.
 */
export const PKV_STATUS_SUBTABS = [
  'Alle', 'Fehler', 'Nicht gesendet', 'Gesendet', 'Überfällig', 'Gemahnt',
  'Inkasso', 'An Inkasso gesendet', 'Bezahlt', 'Storniert', 'Pausiert',
];

export class PkvBillingPage {
  constructor(private page: Page, private baseUrl = 'https://staging.therapios.de') {}

  /** Opens /billing and switches to the PKV-Abrechnung tab; waits for the status subtabs. */
  async open(): Promise<void> {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.goto(`${this.baseUrl}/billing`, { waitUntil: 'domcontentloaded' });
    // The tab being clickable is the precondition for the click, so wait for THAT rather than
    // sleeping 5 s at it. `/billing` opens on the Validierung tab and is slow to paint, hence the
    // generous ceiling - but a warm page clears it in well under a second.
    const pkvTab = this.page
      .getByText('PKV-Abrechnung', { exact: false })
      .filter({ visible: true })
      .first();
    await pkvTab.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    // Switching tabs refetches the invoice list; settle on that instead of the flat 3.5 s.
    await settleAfter(this.page, () => pkvTab.click({ force: true, timeout: 8000 }).catch(() => {}), {
      budgetMs: 20_000,
    });
    await this.subtab('Alle').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  }

  /** An invoice-status subtab label (e.g. "Inkasso", "An Inkasso gesendet"). */
  subtab(name: string): Locator {
    return this.page.getByText(name, { exact: true }).filter({ visible: true }).first();
  }

  async openSubtab(name: string): Promise<void> {
    await settleAfter(this.page, () => this.subtab(name).click({ force: true }), { budgetMs: 15_000 });
  }

  /** Number of selectable invoice rows on the current subtab (excludes the header checkbox). */
  async invoiceRowCount(): Promise<number> {
    return Math.max(0, (await this.page.getByRole('checkbox').count()) - 1);
  }

  /** Selects the first invoice row. Returns false when the subtab has no invoices. */
  async selectFirstInvoice(): Promise<boolean> {
    if ((await this.invoiceRowCount()) < 1) return false;
    // Ticking a row raises the bulk-action bar client-side; settle covers the case where it also
    // triggers a fetch, and returns quickly when it does not.
    await settleAfter(this.page, () => this.page.getByRole('checkbox').nth(1).click({ force: true }), {
      budgetMs: 8_000,
    });
    return true;
  }

  // ---- bulk action bar buttons (context-aware per subtab) ----
  etiSendButton(): Locator {
    return this.page.getByText('An ETI Experts senden', { exact: true }).filter({ visible: true });
  }
  downloadButton(): Locator {
    return this.page.getByText('Rechnungen herunterladen', { exact: true }).filter({ visible: true });
  }
  changeStatusButton(): Locator {
    return this.page.getByText('Rechnungsstatus ändern', { exact: true }).filter({ visible: true });
  }
  markPaidButton(): Locator {
    return this.page.getByText('Als bezahlt markieren', { exact: true }).filter({ visible: true });
  }
  markUncollectableButton(): Locator {
    return this.page.getByText('Als uneinbringlich markieren', { exact: true }).filter({ visible: true });
  }

  // ---- ETI pre-submission dialog (#2949) ----
  /** Opens the ETI submission dialog. Returns whether it appeared. */
  async openEtiDialog(): Promise<boolean> {
    await this.etiSendButton().first().click({ force: true, timeout: 6000 }).catch(() => {});
    return this.page.getByText(/Gesamtforderung|Bestätigen & Senden|An ETI Experts/)
      .filter({ visible: true }).first()
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  }

  /** Closes any open dialog without confirming. */
  async cancelDialog(): Promise<void> {
    await this.page.getByText(/^(Abbrechen|Cancel)$/).filter({ visible: true }).last()
      .click({ force: true, timeout: 4000 }).catch(() => {});
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(600);
  }
}
