import { Page, expect } from '@playwright/test';
import { Credentials, STAGING_CREDENTIALS, mintUiSession } from '../util/api-token';

/**
 * Hardcoded English strings on the admin screens — RC 3.13 #3611 (`55ad84cb1` + `141fc1c92`).
 *
 * #3337 corrected the German *dictionary*; this ticket covers the strings written straight into the
 * screens, which a dictionary diff is structurally blind to (that blindness is #3337's own recorded
 * finding, and it is what seeded items 1–6 here). Nine items across four screens.
 *
 * ## Why the screen is the oracle, and the bundle only sometimes
 *
 * A hardcoded literal shows up in the served entry bundle — but so does the **en.json value of the
 * same phrase**, because the English dictionary ships too. Subtracting the dictionary occurrences
 * works only for distinctive phrases:
 *
 * | literal | bundle | in the shipped dictionaries | outside | usable? |
 * |---|---|---|---|---|
 * | `Created Date` | 1 | 1 | **0** | yes |
 * | `Revenue (total)` | 1 | 1 | **0** | yes |
 * | `My Notifications` | 1 | 1 | **0** | yes |
 * | `Actions` | 168 | 16 | 152 | no — `useActions`, `ActionSheet`, … |
 * | `View` | 2896 | 23 | 2873 | no — `ScrollView`, `TextView`, … |
 * | `Cancel` | 382 | 44 | 338 | no — `cancelAnimationFrame`, … |
 *
 * So the three distinctive phrases are checked in the bundle (that is AC7's scan in the only form a
 * client can run), and everything else is read off the rendered screen.
 *
 * ## What was measured on staging (2026-09-11)
 *
 * **The GKV batch table is fully German** and the fix went wider than the nine items: `Batch-ID`,
 * `IK Nummer` and `Bilder` were translated too, which the Developer Reference had flagged as the
 * same pattern but outside the list.
 *
 * **The PKV and Zuzahlung tables were not.** They carry the one in-scope item — `Gesendet am` — and
 * **21 (PKV) and 22 (copayment) English strings around it**. The commit says so outright: *"The PKV
 * and copayment tables still carry roughly twenty English headers each. The ticket lists nine items
 * and does not cover those, so they are deliberately left in place."* That satisfies the ACs and
 * contradicts the End Goal, which names those tables explicitly — see the spec's finding.
 *
 * ## Traps
 *
 * - **The billing tabs carry counts in their labels** (`PKV-Abrechnung (26)`), so an exact-text click
 *   silently finds nothing. Match on a prefix.
 * - **A column label may be a translation KEY rather than text.** `pkvColumns.tsx` mixes
 *   `label: 'Patient'` with `label: 'columns.hono_doc'`, and the table calls `translate()` on it —
 *   so keys resolve ("Hono Dok.", "VA-Status", verified on screen) and plain text falls through
 *   unchanged, because i18next returns a missing key verbatim. A bare read of the column files
 *   therefore looks like a raw-key bug that does not exist.
 * - `de.json` uses three dots in `performanceDashboard.add_cta` (`Maßnahme hinzufügen...`), not the
 *   `…` character the ticket's AC6 writes.
 */

/** The nine items' German replacements, by the screen they belong to. */
export const GKV_HEADERS = ['Erstellt am', 'Gesendet am', 'Aktionen', 'Umsatz (gesamt)', 'Stapelstatus'] as const;

/** Their English predecessors — none may appear on the GKV table. */
export const GKV_ENGLISH = ['Created Date', 'Sent Date', 'Actions', 'Revenue (total)', 'Batch Status', 'View'] as const;

/** Distinctive enough to separate a code literal from an en.json value in the bundle. */
export const DISTINCTIVE = ['Created Date', 'Revenue (total)', 'My Notifications'] as const;

/** The English labels still rendered by the PKV / copayment column definitions. */
export const LEFTOVER_ENGLISH = [
  'Invoice Nr', 'Invoice Date', 'Invoice Status', 'Invoice Amount', 'Therapist', 'Insurance Type',
  'Overdue Date', 'Paid Date', 'Reminded Date', 'Sent to DC Date', 'To DC Date', 'Storno Nr',
  'Storno Status', 'Storno DATEV Status', 'Billing Validation Status', 'VO Status', 'VO Nr',
  'Revenue', 'Logs', 'Beh Status',
] as const;

/** The copayment tab's invoice-status sub-tabs, still English where PKV's are German (#2951). */
export const COPAYMENT_SUBTABS_ENGLISH = [
  'Not Sent', 'Sent', 'Overdue', 'Sent to Optica', 'Reminded', 'To Debt Collector', 'Sent to DC',
  'Paid', 'Cancelled', 'On Hold',
] as const;
export const PKV_SUBTABS_GERMAN = [
  'Nicht gesendet', 'Gesendet', 'Überfällig', 'Gemahnt', 'Inkasso', 'An Inkasso gesendet',
  'Bezahlt', 'Storniert', 'Pausiert',
] as const;

/** Column labels that are translation keys, and the German they must resolve to. */
export const KEY_LABELS = {
  'columns.hono_doc': 'Hono Dok.',
  'columns.hono_status': 'Hono Status',
  'columns.vorab_status': 'VA-Status',
} as const;

export class HardcodedGermanPage {
  constructor(public page: Page) {}

  async signIn(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    await mintUiSession(this.page, credentials);
    // Wide enough that the billing tables render every column rather than clipping them.
    await this.page.setViewportSize({ width: 2400, height: 1300 });
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(`https://staging.therapios.de${path}`, { waitUntil: 'domcontentloaded' });
  }

  /** Everything the screen currently renders, as one blob — these are all text assertions. */
  async screenText(): Promise<string> {
    return this.page.evaluate(() => (document.querySelector('#root') as HTMLElement)?.innerText ?? '');
  }

  /** Waits until a marker string is on screen, so a header read never lands on an empty table. */
  async waitForText(needle: string, timeoutMs = 180_000): Promise<void> {
    await expect
      .poll(async () => (await this.screenText()).includes(needle), { timeout: timeoutMs, intervals: [2_000] })
      .toBe(true);
  }

  /**
   * Opens one of the /billing tabs.
   *
   * The labels carry live counts (`PKV-Abrechnung (26)`), so this matches on a PREFIX — an exact
   * `getByText` finds nothing and the test then reads the previous tab's headers.
   */
  async openBillingTab(name: 'Validierung' | 'GKV-Abrechnung' | 'PKV-Abrechnung' | 'Zuzahlungsverwaltung'): Promise<void> {
    const tab = this.page
      .locator('div[tabindex="0"]')
      .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
      .first();
    await tab.click({ timeout: 60_000 });
    await this.page.waitForTimeout(8_000);
  }

  /** The header's notification control: icon-only, no testid, addressed by position + unread count. */
  bellControl() {
    return this.page
      .locator('div[tabindex="0"], button, [role="button"]')
      .filter({ hasText: /^\s*\d+\s*$/ })
      .last();
  }

  /** Which of `needles` the screen currently shows. */
  async present(needles: readonly string[]): Promise<string[]> {
    const text = await this.screenText();
    return needles.filter((n) => text.includes(n));
  }

  // ─────────────────────────── the bundle, for AC7's distinctive phrases ───────────────────────────

  /**
   * Occurrences of a literal in the served bundle, split by whether they sit inside the two shipped
   * locale dictionaries. `outside > 0` means something other than a dictionary value holds the
   * string — i.e. a hardcoded literal — but only for a phrase distinctive enough not to collide with
   * identifiers (see the class docblock's table).
   */
  async literalCounts(needle: string): Promise<{ total: number; inDictionaries: number; outside: number }> {
    const { source, dictionaries } = await this.bundle();
    const total = source.split(needle).length - 1;
    const inDictionaries = dictionaries.split(needle).length - 1;
    return { total, inDictionaries, outside: total - inDictionaries };
  }

  /**
   * Occurrences of a German string in the bundle, matched in its ESCAPED form.
   *
   * The bundle escapes non-ASCII (`Ma\xdfnahme hinzuf\xfcgen...`), so a grep for the literal
   * "Maßnahme hinzufügen..." returns **0** and reads as "the string was never shipped" — the #3337
   * trap. Everything with an umlaut or an eszett must go through here.
   */
  async escapedCount(needle: string): Promise<number> {
    const { source } = await this.bundle();
    const escaped = [...needle]
      .map((ch) => (ch.charCodeAt(0) < 128 ? ch : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`))
      .join('');
    return source.split(escaped).length - 1;
  }

  private cached: { source: string; dictionaries: string } | null = null;

  /** The served entry bundle, plus just the de/en dictionary modules carved out of it. */
  async bundle(): Promise<{ source: string; dictionaries: string }> {
    if (this.cached) return this.cached;
    const shell = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const entry = shell.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!entry) throw new Error('#3611: no entry bundle on the app shell');
    const source = await (
      await this.page.request.get(`https://staging.therapios.de${entry}`, { timeout: 240_000 })
    ).text();

    // The locale modules are found by SHAPE, never by offset: they are content-hashed and
    // renumbered every build (#3337). Each is an `exports={…}` object carrying a known key, and the
    // German and English ones are told apart by a value only one of them has.
    const modules: string[] = [];
    const re = /exports\s*=\s*\{/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const open = source.indexOf('{', m.index);
      let depth = 0;
      for (let i = open; i < Math.min(open + 900_000, source.length); i++) {
        if ('{' === source[i]) depth += 1;
        else if ('}' === source[i]) {
          depth -= 1;
          if (0 === depth) {
            modules.push(source.slice(open, i + 1));
            break;
          }
        }
      }
    }
    const locale = modules.filter((mod) => mod.includes('bucketGrauKeinePersonioStunden'));
    if (!locale.length) throw new Error('#3611: could not locate the locale modules in the bundle');
    this.cached = { source, dictionaries: locale.join('') };
    return this.cached;
  }
}
