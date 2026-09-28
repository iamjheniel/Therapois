import { Page, expect } from '@playwright/test';

/**
 * The deployed German UI strings (RC 3.12 #3337 — "German Translation Cleanup, Admin Screens").
 *
 * A translation ticket has exactly one authoritative surface: **the dictionary the deployed bundle
 * actually ships**. i18next has no other source, so a key whose value is right and whose path is
 * referenced by the code *must* render right; and no amount of clicking around proves the other 50
 * strings. This page object therefore reads the dictionaries straight out of the served JavaScript
 * and lets a spec assert all 58 strings at once, then spot-checks the screens where the key→screen
 * mapping is the part worth doubting.
 *
 * **How the dictionaries are found.** Metro emits one module per locale as
 * `__d(function(...){<v>.exports={…}}, <id>, []);` — a plain object literal with ~3,800 leaf keys
 * and no dependencies. `loadDictionaries()` locates every such module in `entry-*.js`, evaluates
 * the literal, flattens it to dot-paths, and tells German from English by `controls.loading`. It is
 * deliberately not pinned to byte offsets or module ids: both change on every build.
 *
 * **Why `referenced()` matters.** #3337's own developer flagged that 12 of the 58 keys have no live
 * screen, and QA is told to sample from the other 46. That claim is checkable from the same bundle:
 * a live key appears as its full dotted path at a call site. Three keys are built as template
 * literals (`` `diagnosis_list.filters.${code}` ``) and so never appear whole — `prefixReferenced()`
 * covers exactly that case, which is what keeps a template-literal key from being miscounted as dead.
 *
 * **Non-ASCII arrives escaped.** The bundle writes `L\xe4dt...`, so a naive `grep 'Lädt'` over the
 * served file finds nothing. Evaluating the literal is what turns the escapes back into characters —
 * another reason not to regex the raw text.
 *
 * The download is ~9 MB and the parse is not free, so both are cached per bundle URL for the whole
 * worker.
 */

export type Dictionary = Record<string, string>;

type Loaded = { de: Dictionary; en: Dictionary; bundleUrl: string; source: string };

let cached: Promise<Loaded> | null = null;

export class TranslationsPage {
  static readonly ORIGIN = 'https://staging.therapios.de';

  constructor(private page: Page) {}

  // ───────────────────────────── the deployed strings ────────────────────────

  /** Downloads and parses the served locale dictionaries. Cached per worker. */
  async loadDictionaries(): Promise<Loaded> {
    if (!cached) cached = this.fetchAndParse();
    return await cached;
  }

  private async fetchAndParse(): Promise<Loaded> {
    const indexRes = await this.page.request.get(`${TranslationsPage.ORIGIN}/`, { timeout: 60_000 });
    expect(indexRes.status(), 'GET / must serve the app shell').toBe(200);
    const html = await indexRes.text();
    // The entry bundle is content-hashed, so it is read off the shell rather than hard-coded.
    const entry = html.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    expect(entry, 'the app shell must reference an entry bundle').toBeTruthy();

    const bundleUrl = `${TranslationsPage.ORIGIN}${entry}`;
    const bundleRes = await this.page.request.get(bundleUrl, { timeout: 120_000 });
    expect(bundleRes.status(), `GET ${entry}`).toBe(200);
    const source = await bundleRes.text();

    // `controls.loading` is the discriminator, and BOTH halves of the test matter: several other
    // modules in the bundle share the `<v>.exports={…}` shape and parse fine, and any of them would
    // satisfy a bare `!== 'Loading...'` simply by not having the key at all.
    const dictionaries = TranslationsPage.extractDictionaries(source).filter(
      (d) => typeof d['controls.loading'] === 'string',
    );
    const de = dictionaries.find((d) => d['controls.loading'] !== 'Loading...');
    const en = dictionaries.find((d) => d['controls.loading'] === 'Loading...');
    expect(de, 'the bundle must ship a German dictionary').toBeTruthy();
    expect(en, 'the bundle must ship an English dictionary').toBeTruthy();
    return { de: de!, en: en!, bundleUrl, source };
  }

  /**
   * Every `<v>.exports={…}` dependency-free module big enough to be a locale file, flattened.
   *
   * The closing brace hunt is the fiddly part: a module ends `}},<id>,[]);` — the FIRST brace closes
   * the object, the second the factory function — so the object literal stops one character before
   * the match, not at it.
   */
  private static extractDictionaries(source: string): Dictionary[] {
    const out: Dictionary[] = [];
    const moduleStart = /__d\(function\([^)]*\)\{(\w+)\.exports=\{/g;
    let match: RegExpExecArray | null;
    while ((match = moduleStart.exec(source)) !== null) {
      const objectStart = match.index + match[0].length - 1;
      const tail = /\},(\d+),\[\]\);/g;
      tail.lastIndex = objectStart;
      const end = tail.exec(source);
      if (!end) continue;
      const literal = source.slice(objectStart, end.index);
      // A locale file is the only module of this shape with thousands of keys; anything smaller is
      // some other data module and is skipped rather than risking an eval of unrelated code.
      if (literal.length < 50_000) continue;
      try {
        const value = new Function(`return ${literal};`)() as Record<string, unknown>;
        out.push(TranslationsPage.flatten(value));
      } catch {
        /* a module that does not parse as a literal is not a locale file */
      }
      moduleStart.lastIndex = end.index;
    }
    return out;
  }

  private static flatten(value: Record<string, unknown>, prefix = ''): Dictionary {
    const out: Dictionary = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object') Object.assign(out, TranslationsPage.flatten(entry as Record<string, unknown>, `${prefix}${key}.`));
      else out[`${prefix}${key}`] = String(entry);
    }
    return out;
  }

  // ─────────────────────────────── key usage ─────────────────────────────────

  /** Whether the deployed bundle contains this key as a whole dotted path at a call site. */
  async referenced(key: string): Promise<boolean> {
    const { source } = await this.loadDictionaries();
    return source.includes(key);
  }

  /**
   * Whether the bundle builds keys under this namespace with a template literal —
   * `` translate(`document_center.bulk_status.type.${type}`) ``. A key reached that way never
   * appears whole and would otherwise be miscounted as dead.
   */
  async prefixReferenced(prefix: string): Promise<boolean> {
    const { source } = await this.loadDictionaries();
    return source.includes(`${prefix}\${`);
  }

  /** Every key whose German value still contains one of the ticket's old, wrong values. */
  async keysStillHolding(oldValue: string): Promise<string[]> {
    const { de } = await this.loadDictionaries();
    return Object.entries(de)
      .filter(([, value]) => value.includes(oldValue))
      .map(([key]) => key);
  }

  /**
   * German values that are still English, found without reference to the ticket's list: identical
   * to the English file, at least two words, pure ASCII, and carrying English function words. The
   * heuristic deliberately ignores loanwords German UI uses natively (Upload, Download, Export,
   * Filter, Batch) — the false-positive class the ticket's own audit had to filter out.
   */
  async remainingEnglishValues(): Promise<{ key: string; value: string }[]> {
    const { de, en } = await this.loadDictionaries();
    const english = /\b(the|to|of|and|for|with|please|try|again|failed|error|added|deleted|successfully|not|is|are|this|your|you|show|hide|save|cancel|select|search|loading|rows|per|page|view|confirm|action|attitude|unbilled|generate|form|order|breakdown|assessments)\b/i;
    return Object.entries(de)
      .filter(([key, value]) => en[key] === value && /^[\x00-\x7F]+$/.test(value) && value.trim().split(/\s+/).length >= 2 && english.test(value))
      .map(([key, value]) => ({ key, value }));
  }

  /**
   * German values still using an ae/oe/ue/ss digraph where an umlaut or eszett belongs.
   *
   * Matched on whole German words rather than the bare letter pairs, because `dass`, `Adresse` and
   * `Klasse` are correct and a naive `/ss/` sweep reports dozens of them.
   */
  async remainingDigraphs(): Promise<{ key: string; value: string }[]> {
    const patterns = [
      /aendern/i, /ausgewaehl/i, /waehl/i, /staetig/i, /koenn/i, /moecht/i, /\bfuer\b/i, /ueber/i,
      /gueltig/i, /eintraeg/i, /schliess/i, /muess/i, /groess/i, /strass/i, /spaet/i, /naech/i,
      /zurueck/i, /hinzufueg/i, /verfueg/i, /loesch/i, /oeffn/i, /taeg/i, /erklaerung/i, /mueller/i,
      /aerzt/i, /laeuft/i, /logopaedie/i, /infoblaett/i, /bestaetig/i,
    ];
    const { de } = await this.loadDictionaries();
    return Object.entries(de)
      .filter(([, value]) => patterns.some((p) => p.test(value)))
      .map(([key, value]) => ({ key, value }));
  }
}
