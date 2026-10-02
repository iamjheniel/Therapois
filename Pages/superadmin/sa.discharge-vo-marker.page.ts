import { APIRequestContext, Page, expect } from '@playwright/test';
import { STAGING_CREDENTIALS, mintUiSession, type Credentials } from '../util/api-token';

const API = 'https://api.staging.therapios.de';

export type Vo = {
  id: number;
  number: string;
  treatmentStatus: string | null;
  followupStatus: string | null;
  orderingStatus: string | null;
  orderDate: string | null;
  createdAt: string | null;
  isDischargeManagement: boolean;
  practice: { id: number; name: string } | null;
  facility: { id: number; name: string; orderingMode: string | null } | null;
};

export type Badge = {
  text: string;
  x: number; y: number; w: number; h: number;
  color: string; fontSize: string;
  pill: { bg: string; radius: string; w: number; h: number; x: number; y: number } | null;
};

/**
 * RC 3.15 #3819 (the Entlassmanagement badge) and #3820 (Folge-VO "Bestellen" at creation).
 *
 * Two tickets, one population. A discharge VO carries the hospital's numbers but its follow-up is
 * requested through the ER, so #3819 marks it in the CRM order lists and on the Admin Board, and
 * #3820 puts it into "Bestellen" the moment it is created instead of waiting an average 4.7 days
 * for the nightly run.
 *
 * Shipped as `04df30f59aa` (app, `Ref #3819`) and `b103c748dbc` (api, `Ref #3820`) on
 * `release/3.15.0`, 2026-09-26, **neither naming its issue in the subject** — a commit search on
 * the number finds nothing, which is why they are pinned here by sha.
 *
 * ## The guard that decides whether #3820 is observable at all
 *
 * `b103c748dbc`'s own message records an assumption **no AC states**: a discharge VO at a facility
 * that orders its own follow-ups (`praxis_vo` / `er_bestellt_selbst`, #2617) keeps its status
 * blank, as the nightly run does. On staging **every discharge VO created since the deploy is at
 * one such facility**, so the positive path is unexercised and a PM following the ticket's QA steps
 * on those VOs sees no "Bestellen" and would report the ticket as broken. `isGuarded()` is the
 * predicate; the spec reports the population rather than asserting a count.
 *
 * ## Traps
 *
 * **Do NOT probe the bundle for `DischargeManagementBadge`.** Minification renames a component, so
 * it occurs 0 times — and so does `DeceasedBadge`, the badge this one is modelled on and which has
 * shipped for releases. That control is what makes the zero meaningless; the badge's own STRING and
 * the row field survive.
 *
 * **`isDischargeManagement` is not a registered filter** (#3800) — `=true`, `=false` and a bogus
 * key all return the whole book — so the population is walked and the flag read per row. On
 * `/v2/prescriptions` the same flag is served as **`dischargeManagement`** (no `is` prefix).
 *
 * **The collection is id-ascending**, so discharge VOs (all created from July 2026) sit at the END:
 * a slice of the first page reports 0 of them and reads like the flag never being set (#3704).
 *
 * **`/patients?deceased=true` is silently ignored**, and `deceased` is omitted rather than false —
 * a deceased patient is recognised by `deceasedAt`. Patient 8124 (NikkiQA DingdingTest) is the QA
 * fixture whose Verstorben badge #3819 AC3 compares against.
 */
export class DischargeVoMarkerPage {
  /** The label, in both locales (the ticket does not change it). */
  static readonly LABEL_DE = 'Entlassmanagement';
  static readonly LABEL_EN = 'Discharge Management';
  static readonly DECEASED_LABEL = 'Verstorben';

  /** The ticket's own QA fixture: practice "Mauritius Therapieklinik", its only Bestellung row. */
  static readonly TICKET_VO = '9594-1';
  static readonly TICKET_PRACTICE = { id: 1610, name: 'Mauritius Therapieklinik' };

  /**
   * A deceased patient's VO, for AC3's "same pill as Verstorben" comparison.
   *
   * VO 934201-99 belongs to the QA patient NikkiQA DingdingTest (8124). Finding it is its own trap:
   * **`/v2/prescriptions?patient=` is SILENTLY IGNORED** — it returns the unfiltered, id-ascending
   * head, byte-identical to a bogus key — so reading "that patient's VOs" that way hands back four
   * VOs of four unrelated people, and the first one picked carried no Verstorben badge at all. The
   * registered form is **`patient.id=`**, on `/v2/prescriptions` and on `/prescriptions` alike
   * (#3550's split, where `practice=` and `practice.id=` both work but `patient=` does not).
   */
  static readonly DECEASED_VO = '934201-99';

  /**
   * AC2's control practice — one that issues BOTH kinds, which is the case the AC calls out
   * (18 of the 30 hospital practices on the production copy have both). Practice 1610, the
   * ticket's own, has exactly ONE VO and so cannot serve as this control.
   */
  static readonly MIXED_PRACTICE = { id: 755, name: 'JhenQA Medical Center' };

  /** The two facility ordering modes that make a facility order its own follow-ups (#2617). */
  static readonly SELF_ORDERING_MODES = ['praxis_vo', 'er_bestellt_selbst'];

  private token = '';

  constructor(private request: APIRequestContext) {}

  async init(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
  }

  /** A GET that retries a thrown transport error and a 5xx — neither means "absent". */
  async get<T = any>(path: string, timeout = 400_000): Promise<{ status: number; body: T | null }> {
    let last = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await this.request.get(`${API}${path}`, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
          timeout,
        });
        last = res.status();
        if (last < 500) return { status: last, body: (await res.json().catch(() => null)) as T };
      } catch { last = 0; }
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
    return { status: last, body: null };
  }

  private static shape(r: any): Vo {
    const practice = r.practice && typeof r.practice === 'object' ? r.practice : null;
    const ech = r.elderlyCareHome && typeof r.elderlyCareHome === 'object' ? r.elderlyCareHome : null;
    return {
      id: r.id,
      number: r.prescriptionId,
      treatmentStatus: r.treatmentStatus ?? null,
      followupStatus: r.followupStatus ?? null,
      orderingStatus: r.orderingStatus ?? null,
      orderDate: r.orderDate ?? null,
      createdAt: r.createdAt ?? null,
      // `/prescriptions` serves `isDischargeManagement`; `/v2/prescriptions` serves
      // `dischargeManagement`. Accept both so one shape serves either collection.
      isDischargeManagement: Boolean(r.isDischargeManagement ?? r.dischargeManagement),
      practice: practice ? { id: practice.id, name: practice.name } : null,
      facility: ech ? { id: ech.id, name: ech.name, orderingMode: ech.orderingMode ?? null } : null,
    };
  }

  /** Read VOs by number — `prescriptionId[]` is a registered multi-value filter. */
  async vosByNumber(numbers: string[]): Promise<Vo[]> {
    const q = numbers.map((n) => `prescriptionId%5B%5D=${encodeURIComponent(n)}`).join('&');
    const { body } = await this.get<any>(`/prescriptions?itemsPerPage=${numbers.length + 10}&${q}`);
    return (body?.member ?? []).map(DischargeVoMarkerPage.shape);
  }

  /** The VOs of one practice, through the list the CRM and the board both read. */
  async practiceVos(practiceId: number, extra = ''): Promise<Vo[]> {
    const { body } = await this.get<any>(
      `/v2/prescriptions?itemsPerPage=300&practice=${practiceId}${extra ? `&${extra}` : ''}`);
    const rows = Array.isArray(body) ? body : (body?.member ?? []);
    return rows.map(DischargeVoMarkerPage.shape);
  }

  /**
   * #3820's guard, ported: the facilities that order their own follow-ups.
   *
   * The service gates on the facility's ordering mode; the nightly run gates on the VO's
   * `orderingStatus` (`Praxis` / `ER bestellt selbst` — note the backing values are NOT
   * `By Praxis`/`By ER`, #3759). Both are checked, because the claim the commit makes is that the
   * two agree.
   */
  static isGuarded(vo: Vo): boolean {
    const byFacility = vo.facility?.orderingMode != null
      && DischargeVoMarkerPage.SELF_ORDERING_MODES.includes(vo.facility.orderingMode);
    const byVo = vo.orderingStatus === 'Praxis' || vo.orderingStatus === 'ER bestellt selbst';
    return byFacility || byVo;
  }

  /** Every log entry of one VO. */
  async logs(prescriptionId: number): Promise<any[]> {
    const { body } = await this.get<any>(
      `/prescription_logs?itemsPerPage=60&prescription=${prescriptionId}`);
    return body?.member ?? [];
  }

  // ───────────────────────────── the served bundle ─────────────────────────────

  async bundle(): Promise<{ names: string[]; js: string }> {
    const html = await (await this.request.get('https://staging.therapios.de/', { timeout: 180_000 })).text();
    const names = [...new Set([...html.matchAll(/\/_expo\/static\/js\/web\/(entry-[A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]))];
    let js = '';
    for (const n of names) {
      js += await (await this.request.get(`https://staging.therapios.de/_expo/static/js/web/${n}`, { timeout: 300_000 })).text();
    }
    return { names, js };
  }

  /** Count a literal in both its plain and its escaped form — the bundle escapes non-ASCII (#3611). */
  static occurrences(js: string, needle: string): number {
    const escaped = [...needle].map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 128) return ch;
      return c < 256 ? `\\x${c.toString(16).padStart(2, '0')}` : `\\u${c.toString(16).padStart(4, '0')}`;
    }).join('');
    const count = (s: string) => js.split(s).length - 1;
    return needle === escaped ? count(needle) : count(needle) + count(escaped);
  }

  // ───────────────────────────── the screen ─────────────────────────────

  /** Open the Admin Board and search it. One navigation: the refresh token is single-use (#3460). */
  static async openBoardAndSearch(
    page: Page, term: string, creds: Credentials = STAGING_CREDENTIALS.superadmin,
    width = 1920,
  ): Promise<void> {
    await mintUiSession(page, creds);
    await page.setViewportSize({ width, height: 1080 });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.getByText(/Admin Board/).first().waitFor({ timeout: 240_000 });
    const box = page.locator('input').first();
    await box.waitFor({ timeout: 120_000 });
    await box.fill(term, { timeout: 120_000 });
    await box.press('Enter');
    // The pager's "1–N von N" is the readiness signal: the table repaints as the query lands, and
    // reading rows before it returns the PREVIOUS search's rows.
    await expect
      .poll(() => DischargeVoMarkerPage.pagerSummary(page), { timeout: 240_000, intervals: [1_000] })
      .toMatch(/von \d+/);
  }

  static async pagerSummary(page: Page): Promise<string> {
    return page.evaluate(() => {
      let out = '';
      document.querySelectorAll('*').forEach((e) => {
        if (e.children.length) return;
        const t = (e.textContent || '').trim();
        if (/^\d+–\d+ von \d+$/.test(t)) out = t;
      });
      return out;
    });
  }

  /**
   * One painted badge: its own box, and the pill behind it.
   *
   * The pill is the nearest ancestor carrying a background, which is what AC3's "same pill shape
   * and size as Verstorben" is a claim about — the text leaf alone cannot answer it.
   */
  static async badge(page: Page, text: string): Promise<Badge | null> {
    return page.evaluate((label) => {
      const el = [...document.querySelectorAll('*')]
        .find((e) => !e.children.length && (e.textContent || '').trim() === label);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let node: Element | null = el;
      let pill: any = null;
      for (let i = 0; i < 4 && node; i += 1) {
        const ncs = getComputedStyle(node);
        const nr = node.getBoundingClientRect();
        if (ncs.backgroundColor && ncs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          pill = {
            bg: ncs.backgroundColor, radius: ncs.borderRadius,
            w: Math.round(nr.width), h: Math.round(nr.height),
            x: Math.round(nr.x), y: Math.round(nr.y),
          };
          break;
        }
        node = node.parentElement;
      }
      return {
        text: label,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        color: cs.color, fontSize: cs.fontSize,
        pill,
      };
    }, text);
  }

  /**
   * The smallest element holding BOTH the VO number and the badge — the VO-number cell.
   *
   * AC1 says the badge sits "next to the VO number", and the implementation stacks it UNDER the
   * number inside that one cell, exactly as the Verstorben badge sits under the patient name. So a
   * same-row, left-to-right adjacency check finds no VO number at all on the badge's own line and
   * reports AC1 as failing on a correct build. What the AC is really a claim about is the CELL:
   * it must contain the number and the badge and nothing else between them.
   */
  static async voNumberCell(page: Page, voNumber: string, label: string): Promise<{
    text: string; x: number; y: number; w: number; h: number;
    numberY: number; badgeY: number;
  } | null> {
    return page.evaluate(({ num, lab }) => {
      const norm = (s: string) => s.replace(/\s+/g, '');
      let best: Element | null = null;
      document.querySelectorAll('*').forEach((el) => {
        const t = norm(el.textContent || '');
        if (!t.includes(num) || !t.includes(norm(lab))) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (!best || r.width * r.height < best.getBoundingClientRect().width * best.getBoundingClientRect().height) best = el;
      });
      if (!best) return null;
      const r = (best as Element).getBoundingClientRect();
      // The CRM paints the VO number in BRACKETS — "[9594-1]", as the ticket's own Visual
      // Reference writes it — while the Admin Board paints it bare, so the leaf is matched by
      // containment. An exact match finds nothing in the CRM and reports the number as absent.
      const leafY = (text: string) => {
        const el = [...(best as Element).querySelectorAll('*')]
          .find((e) => !e.children.length && (e.textContent || '').trim().includes(text));
        return el ? Math.round(el.getBoundingClientRect().y) : -1;
      };
      return {
        text: ((best as Element).textContent || '').trim(),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        numberY: leafY(num), badgeY: leafY(lab),
      };
    }, { num: voNumber, lab: label });
  }

  /** Every painted leaf on the row band around a y, left to right — for "next to the VO number". */
  static async rowLeaves(page: Page, y: number, band = 18): Promise<{ t: string; x: number }[]> {
    return page.evaluate(({ y: at, band: b }) => {
      const out: { t: string; x: number }[] = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 60) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (Math.abs(r.y - at) > b) return;
        out.push({ t, x: Math.round(r.x) });
      });
      return out.sort((a, c) => a.x - c.x);
    }, { y, band });
  }
}
