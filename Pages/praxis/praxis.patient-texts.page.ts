import type { APIRequestContext, Page } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../util/api-token';

/**
 * RC 3.15 #3895 — the operations review's wording for the patient texts, the cancel page and the
 * Settings reminder preview.
 *
 * THE TICKET SPANS TWO REPOS AND ONLY ONE HALF IS CLIENT-DECIDABLE.
 *
 *  - (a) the stop line and (b) the freed-slot offer's closing clause live in the monorepo's
 *    `TextMessageTemplates.php`. The rendered text is handed to the SMS provider and **never
 *    persisted** — `TextMessage` has no body column, no serialization group exposes one, and no
 *    route renders a preview (all three probed by {@link apiBodySurfaces}). So on staging there is
 *    no way to read what a patient received; the ticket's own Testing Guidance says as much, and
 *    points at the allowlisted test phone or the provider dashboard.
 *  - (c) the cancel page's fee sentence and (d) the Settings preview are Praxis strings, and the
 *    deployed Praxis build serves BOTH translation dictionaries to an anonymous visitor at
 *    `/login` — the #3640 technique — so they are readable without logging in.
 *
 * What rescues the API half is the cross-repo invariant the fix's own docblock states: "Praxis's
 * Settings preview (`settings.reminder.sample`) spells out the reminder plus this line — change
 * one, change the other." {@link renderReminder} ports `TextMessageTemplates::render()` so the
 * deployed preview can be compared against it. That is AC3's own requirement AND the only
 * independent reading of the API wording available from a client.
 *
 * AC3/AC4 are driven on the real screen: **the Flow super admin can sign in to Praxis Flow**
 * (praxis-staging.curano.de) even though it holds no `praxis_flow_access` row, and the switcher
 * then lists every practice — which #3640 did not know and is what makes those two ACs testable
 * here rather than by reading the dictionary.
 */

export const PRAXIS_BASE = 'https://praxis-staging.curano.de';
export const API_BASE = 'https://api.staging.therapios.de';

/** The Localization Reference, verbatim. Rows L1/L3/L6/L8 must be GONE, L2/L4/L7/L9 present. */
export const L = {
  stopOld: { de: 'Keine SMS mehr: [Link]', en: 'No more texts: [link]' },
  stopNew: { de: 'Keine SMS mehr erhalten:', en: 'Stop receiving texts:' },
  offerClauseOld: {
    de: 'Wer zuerst bestätigt, bekommt den Termin:',
    en: 'First to confirm gets it:',
  },
  offerClauseNew: {
    de: 'Jetzt schnell bestätigen (Termin wird an die erste Person vergeben):',
    en: 'Confirm quickly (the appointment goes to the first person):',
  },
  feeOld: {
    de: 'Absage bitte mindestens 24 Stunden vorher. Bei späterer Absage oder Nichterscheinen berechnen wir das Ausfallhonorar laut Behandlungsvertrag.',
    en: 'Please cancel at least 24 hours ahead. For later cancellations or no-shows we charge the no-show fee under your treatment agreement.',
  },
  feeNew: {
    de: 'Absage bitte mindestens 24 Stunden vorher. Bei späterer Absage oder Nichterscheinen berechnen wir das Ausfallhonorar laut Behandlungsvertrag in Höhe der tatsächlichen Behandlungskosten.',
    en: 'Please cancel at least 24 hours ahead. For later cancellations or no-shows we charge the no-show fee under your treatment agreement, in the amount of the actual treatment costs.',
  },
  /** Row L9. `\n` is a real newline in the shipped value. */
  previewNew: {
    de: '{{practice}}: Erinnerung an Ihren Termin am Fr, 16.10. um 09:00 Uhr. Wir freuen uns auf Sie. Absagen: [Link]\nKeine SMS mehr erhalten: [Link]',
    en: '{{practice}}: Reminder for your appointment on Fri, 16.10. at 09:00. We look forward to seeing you. Cancel: [link]\nStop receiving texts: [link]',
  },
  /** Row L8 — the hardcoded sample the preview used to show, including another practice's name. */
  previewOldPractice: 'Praxis Rheinstraße',
  previewTitle: { de: 'Das erhält der Patient', en: 'What the patient receives' },
  /** AC2: the cancel page's other variants, which must NOT move. */
  noteSoft: {
    de: 'Bitte sagen Sie mindestens 24 Stunden vorher ab, damit wir den Termin an jemand anderen weitergeben können.',
    en: 'Please cancel at least 24 hours ahead so we can offer the appointment to someone else.',
  },
  withinDaySoft: {
    de: 'Ihre Absage kommt kurzfristig. Wir versuchen, den Termin noch weiterzugeben.',
    en: 'Your cancellation is short notice. We will try to pass the appointment on.',
  },
  withinDayFee: {
    de: 'Ihre Absage kommt innerhalb von 24 Stunden. Das Ausfallhonorar kann anfallen, wenn der Termin nicht mehr besetzt werden kann.',
    en: 'Your cancellation is inside 24 hours. The no-show fee may apply if the slot cannot be filled.',
  },
  /** AC2: the stop page, both steps, both locales. */
  /**
   * German only, because AC2 quotes the German. The English pair is asserted structurally — it
   * carries the practice placeholder and keeps its own title — rather than against a literal this
   * ticket never states.
   */
  stopPageBodyDe:
    'Wenn Sie abbestellen, erhalten Sie keine SMS mehr von {{practice}}: keine Erinnerungen und keine Hinweise auf frei gewordene Termine. Ihre Termine bleiben bestehen.',
  unsubscribedBodyDe:
    'Sie erhalten keine SMS mehr von {{practice}}. Sie können die Einwilligung jederzeit am Empfang wieder erteilen.',
} as const;

export type Locale = 'de' | 'en';

export class PraxisPatientTextsPage {
  private js: string | null = null;
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  // ───────────────────────────── the deployed Praxis build ─────────────────────────────

  /**
   * The JavaScript the Praxis app serves to an anonymous visitor at `/login`, which carries BOTH
   * translation dictionaries whole (#3640). The RENDER SITES are not in it — the settings screen
   * is route-split and only loads after authentication — so the preview's wiring is checked on
   * the screen, not here.
   */
  async bundle(): Promise<string> {
    if (this.js !== null) return this.js;
    const page = await this.request.get(`${PRAXIS_BASE}/login`, { timeout: 120_000 });
    if (!page.ok()) throw new Error(`GET ${PRAXIS_BASE}/login -> ${page.status()}`);
    const html = await page.text();
    const chunks = [...new Set([...html.matchAll(/"(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
    if (chunks.length === 0) throw new Error('no chunks found on the Praxis login page');
    let js = '';
    for (const c of chunks) {
      const res = await this.request.get(`${PRAXIS_BASE}${c}`, { timeout: 120_000 });
      if (res.ok()) js += await res.text();
    }
    this.js = js;
    return js;
  }

  /**
   * Occurrences of a literal in the served build.
   *
   * UNLIKE Flow's bundle, the Praxis build does NOT escape non-ASCII (#3337/#3611's trap does not
   * apply here) — "Keine SMS mehr erhalten" and "Höhe der tatsächlichen" are present verbatim.
   * That is asserted by its own test rather than assumed, because a build that started escaping
   * would make every "the old wording is gone" check pass for the wrong reason.
   */
  async occurrences(s: string): Promise<number> {
    return (await this.bundle()).split(s).length - 1;
  }

  /**
   * A dictionary block, per locale.
   *
   * The two dictionaries sit in the bundle one after the other, so each block is located by an
   * anchor key and then CLASSIFIED by a marker this ticket does not touch (`saving` in the
   * reminder block, `withinDay.a` on the cancel page) — never by position, and never by the very
   * value under test, which would be circular.
   */
  private async block(anchor: string, markers: Record<Locale, string>): Promise<Record<Locale, string>> {
    const js = await this.bundle();
    const out: Partial<Record<Locale, string>> = {};
    let i = js.indexOf(anchor);
    while (i >= 0) {
      const win = js.slice(Math.max(0, i - 1800), i + 1800);
      for (const loc of ['de', 'en'] as Locale[]) {
        if (win.includes(markers[loc]) && out[loc] === undefined) out[loc] = win;
      }
      i = js.indexOf(anchor, i + 1);
    }
    if (!out.de || !out.en) {
      throw new Error(`could not classify both locales for ${anchor}: ${Object.keys(out).join(',')}`);
    }
    return out as Record<Locale, string>;
  }

  /** `settings.reminder.*`, per locale. */
  async reminderBlock(): Promise<Record<Locale, Record<string, string>>> {
    const wins = await this.block('"sampleTitle"', {
      de: '"saving":"Wird gespeichert',
      en: '"saving":"Saving',
    });
    const out = {} as Record<Locale, Record<string, string>>;
    for (const loc of ['de', 'en'] as Locale[]) {
      out[loc] = PraxisPatientTextsPage.keys(wins[loc], ['sampleTitle', 'sample', 'unnamedPractice', 'title']);
    }
    return out;
  }

  /** `link.cancel.note.*` and `link.cancel.withinDay.*`, per locale. */
  async cancelNotes(): Promise<Record<Locale, Record<string, string>>> {
    const wins = await this.block('"withinDay"', {
      de: 'Ihre Absage kommt kurzfristig',
      en: 'Your cancellation is short notice',
    });
    const out = {} as Record<Locale, Record<string, string>>;
    for (const loc of ['de', 'en'] as Locale[]) {
      const note = wins[loc].match(/"note"\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
      const within = wins[loc].match(/"withinDay"\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
      out[loc] = {
        noteA: PraxisPatientTextsPage.keys(note, ['a']).a ?? '',
        noteB: PraxisPatientTextsPage.keys(note, ['b']).b ?? '',
        withinA: PraxisPatientTextsPage.keys(within, ['a']).a ?? '',
        withinB: PraxisPatientTextsPage.keys(within, ['b']).b ?? '',
      };
    }
    return out;
  }

  /**
   * `link.stop.body` and `link.unsubscribed.body`, per locale (AC2).
   *
   * Anchored on `"stop":{` and `"unsubscribed":{` DIRECTLY rather than on a window around a
   * neighbouring key — a window wide enough to contain the block also contains other objects with
   * a `"stop"` key, and the first match then wins and yields an empty string, which reads exactly
   * like the wording having been removed.
   */
  async stopPage(): Promise<Record<Locale, Record<string, string>>> {
    const js = await this.bundle();
    const pick = (anchor: string): string[] => {
      const out: string[] = [];
      let i = js.indexOf(anchor);
      while (i >= 0) {
        out.push(js.slice(i, i + 600));
        i = js.indexOf(anchor, i + 1);
      }
      return out;
    };
    const stops = pick('"stop":{"title"');
    const unsubs = pick('"unsubscribed":{"title"');
    if (!stops.length || !unsubs.length) throw new Error('stop-page blocks not found in the build');

    const german = (v: string) => /[äöüß]/.test(v) || v.includes('Sie ');
    const out = {} as Record<Locale, Record<string, string>>;
    for (const loc of ['de', 'en'] as Locale[]) {
      const want = loc === 'de';
      const stop = stops.map((t) => PraxisPatientTextsPage.keys(t, ['body']).body ?? '').find((v) => v && german(v) === want);
      const uns = unsubs.map((t) => PraxisPatientTextsPage.keys(t, ['body']).body ?? '').find((v) => v && german(v) === want);
      out[loc] = { stopBody: stop ?? '', unsubscribedBody: uns ?? '' };
    }
    return out;
  }

  /**
   * Pull `"<key>":"<value>"` out of a slice of the bundle.
   *
   * THE VALUES ARE DOUBLE-ENCODED. Next.js ships the dictionary as a JSON string *inside* a JS
   * string literal, so AC3's line break is three bytes in the file (`\\` `\\` `n`): one
   * `JSON.parse` yields the literal two-character sequence `\n`, not a newline. A test that
   * compares against a real `\n` then fails on a correct build and reads as "the stop line is not
   * on its own line" — which is precisely the thing AC3 asks for. The second pass is what makes
   * the comparison meaningful, and it is guarded so a value that is NOT double-encoded is
   * returned unchanged rather than mangled.
   */
  private static keys(src: string, names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names) {
      const m = src.match(new RegExp(`"${n}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (!m) continue;
      let v: string = JSON.parse(`"${m[1]}"`);
      if (/\\[nrt"\\\\]/.test(v)) {
        try {
          v = JSON.parse(`"${v.replace(/"/g, '\\"')}"`);
        } catch {
          /* not double-encoded after all — keep the single-decoded value */
        }
      }
      out[n] = v;
    }
    return out;
  }

  // ───────────────────────── the port of TextMessageTemplates ─────────────────────────

  /**
   * `TextMessageTemplates::render()` for `appointment_reminder`, ported from
   * `api/src/Service/TextMessage/TextMessageTemplates.php` on `release/3.15.0`.
   *
   * This exists for ONE assertion: AC3 requires the Settings preview to be what the patient
   * actually receives, and the fix's own docblock couples the two files. Comparing the deployed
   * preview against this is the only independent reading of the API wording a client can take.
   */
  static renderReminder(
    locale: Locale,
    o: { practice: string; date: string; time: string; link: string; stopLink: string },
  ): string {
    const body =
      locale === 'de'
        ? `${o.practice}: Erinnerung an Ihren Termin am ${o.date} um ${o.time} Uhr. Wir freuen uns auf Sie. Absagen: ${o.link}`
        : `${o.practice}: Reminder for your appointment on ${o.date} at ${o.time}. We look forward to seeing you. Cancel: ${o.link}`;
    const stop = locale === 'de' ? `Keine SMS mehr erhalten: ${o.stopLink}` : `Stop receiving texts: ${o.stopLink}`;
    return `${body}\n${stop}`;
  }

  /** The same for `freed_slot_offer` — row L5. */
  static renderOffer(
    locale: Locale,
    o: { practice: string; date: string; time: string; link: string; stopLink: string },
  ): string {
    const body =
      locale === 'de'
        ? `${o.practice}: Bei uns ist kurzfristig ein Termin frei geworden: ${o.date}, ${o.time} Uhr. Jetzt schnell bestätigen (Termin wird an die erste Person vergeben): ${o.link}`
        : `${o.practice}: A short-notice appointment has opened up: ${o.date}, ${o.time}. Confirm quickly (the appointment goes to the first person): ${o.link}`;
    const stop = locale === 'de' ? `Keine SMS mehr erhalten: ${o.stopLink}` : `Stop receiving texts: ${o.stopLink}`;
    return `${body}\n${stop}`;
  }

  // ───────────────────────────── the Flow API (the wall) ─────────────────────────────

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  private async get(path: string): Promise<{ status: number; body: any }> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status(), body };
  }

  /**
   * Everything a client could read a sent text from — and none of them serves one.
   *
   * Returns the message-log field set under each serialization group plus the status of every
   * plausible render/preview route, against a 404 control, so "the body is unreadable" is a
   * measurement rather than a claim.
   */
  async apiBodySurfaces(): Promise<{
    fields: Record<string, string[]>;
    routes: Record<string, number>;
    newestId: number | null;
  }> {
    const list = await this.get('/text_messages?itemsPerPage=1000');
    const rows: any[] = list.body?.member ?? [];
    const newest = rows.length ? Math.max(...rows.map((r) => Number(r.id))) : null;

    const fields: Record<string, string[]> = {};
    fields.collection = rows[0] ? Object.keys(rows[0]).filter((k) => !k.startsWith('@')) : [];
    if (newest !== null) {
      for (const g of ['', 'text_message:read', 'default']) {
        const item = await this.get(`/text_messages/${newest}${g ? `?groups[]=${g}` : ''}`);
        fields[g || 'item'] = item.body ? Object.keys(item.body).filter((k) => !k.startsWith('@')) : [];
      }
    }

    const routes: Record<string, number> = {};
    for (const p of [
      '/text_messages/preview',
      '/text_message_previews',
      '/text_message_templates',
      `/text_messages/${newest ?? 1}/preview`,
      '/zzz-not-a-route',
    ]) {
      routes[p] = (await this.get(p)).status;
    }
    return { fields, routes, newestId: newest };
  }

  /** The message log, for the inventory the texts would have to be read from. */
  async messageLog(): Promise<{ template: string; status: string; requestedAt: string; id: number }[]> {
    const list = await this.get('/text_messages?itemsPerPage=1000');
    return ((list.body?.member ?? []) as any[]).map((m) => ({
      id: Number(m.id),
      template: String(m.template ?? ''),
      status: String(m.status ?? ''),
      requestedAt: String(m.requestedAt ?? ''),
    }));
  }

  // ───────────────────────────── the Praxis screen ─────────────────────────────

  /**
   * Sign in to Praxis Flow and open Settings → Treatments.
   *
   * TRAP: the login form is a hydrated React form, so a `fill()` issued on `domcontentloaded`
   * lands in an unhydrated input and is WIPED on hydration — the form then posts empty and the
   * page simply stays on `/login`, which reads exactly like a refused credential. The fill is
   * therefore asserted to have stuck before the submit.
   */
  async openTreatmentSettings(page: Page): Promise<void> {
    await page.goto(`${PRAXIS_BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const user = page.getByRole('textbox', { name: 'Benutzername' });
    await user.waitFor({ state: 'visible', timeout: 60_000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(2500);
      await user.fill(STAGING_CREDENTIALS.superadmin.email);
      await page.getByRole('textbox', { name: 'Passwort' }).fill(STAGING_CREDENTIALS.superadmin.password);
      if ((await user.inputValue()) === STAGING_CREDENTIALS.superadmin.email) break;
    }
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 90_000 });
    await page.goto(`${PRAXIS_BASE}/settings/treatments`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await page.locator('[data-testid="reminder-sample"]').waitFor({ state: 'visible', timeout: 90_000 });
  }

  /** The preview as it is painted. `textContent` keeps the real newline; the block title is CSS-uppercased. */
  async preview(page: Page): Promise<string> {
    return (await page.locator('[data-testid="reminder-sample"]').textContent()) ?? '';
  }

  /** The practice named in the switcher at the top of the screen. */
  async activePractice(page: Page): Promise<string> {
    return (
      (await page.locator('button[data-practice-switcher="true"]').first().textContent()) ?? ''
    ).trim();
  }

  /** The practices the switcher offers, current one first-labelled "Aktuell". */
  async practiceOptions(page: Page): Promise<string[]> {
    const sw = page.locator('button[data-practice-switcher="true"]').first();
    if ((await sw.getAttribute('aria-expanded')) !== 'true') {
      await sw.click({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    const panel = page.locator('#practice-switcher-panel');
    const names = await panel.getByRole('button').evaluateAll((els) =>
      els.map((e) => (e.textContent || '').replace(/Aktuell$/, '').trim()).filter(Boolean),
    );
    return [...new Set(names)];
  }

  /**
   * Switch the active practice and return to Settings -> Treatments.
   *
   * THE SWITCH LEAVES THE TAB: choosing a practice sends the app to the Kalender, so the preview
   * element is gone the moment the switch lands and a wait for it times out — which reads exactly
   * like the preview failing to follow the switcher. AC4 is phrased as if the user stays on the
   * tab ("Given a user ... is on the Treatments tab ... Then the preview shows ..."), so the
   * re-navigation is done here and reported rather than hidden.
   */
  async switchPractice(page: Page, name: string): Promise<{ landedOn: string }> {
    const sw = page.locator('button[data-practice-switcher="true"]').first();
    if ((await sw.getAttribute('aria-expanded')) !== 'true') {
      await sw.click({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    await page.locator('#practice-switcher-panel').getByRole('button', { name, exact: false })
      .first()
      .click({ timeout: 30_000 });
    await page.waitForTimeout(4000);
    const landedOn = new URL(page.url()).pathname;
    if (!landedOn.includes('/settings/treatments')) {
      await page.goto(`${PRAXIS_BASE}/settings/treatments`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
    }
    await page.locator('[data-testid="reminder-sample"]').waitFor({ state: 'visible', timeout: 90_000 });
    return { landedOn };
  }
}
