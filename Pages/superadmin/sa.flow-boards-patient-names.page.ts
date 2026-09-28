import { APIRequestContext, expect, Page } from '@playwright/test';
import { FlowBoardsPage } from './sa.flow-boards.page';
import { API_BASE, Credentials, mintUiSession, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Full patient names on every Flow Boards table and export — RC 3.14 #3724 (PR #3779).
 *
 * Flow Boards shows patient identity as initials ("M. B."); this ticket replaces them with the full
 * name on every table, drill-down modal and CSV export, renaming the API field `patientInitials` →
 * `patientName` on six DTOs.
 *
 * ## The whole ticket turns on ONE measurement, and it is not `/status`
 *
 * The change is a field rename plus a formatter, so the deployment question is simply **what shape
 * are the values**. Five collections carry it, and {@link patientValues} reads all five; a value is
 * classified by {@link looksLikeInitials}, not by the field NAME — because the Developer Reference
 * explicitly warns against "keeping the old field name with new content", so a build could ship
 * full names under `patientInitials` and a name-only probe would call it undeployed.
 *
 * **Do NOT grep the bundle for `patientName`.** It occurs **174 times** in the served bundle and
 * always has: it is Flow's ordinary patient-name field, used across VO forms, patient management
 * and the boards' own unrelated code. Only `patientInitials` (4 occurrences, one of them the risk
 * cell's `children: t.patientInitials`) says anything about this ticket. This is #3611's rule —
 * a common token cannot decide a deployment — in the direction that fakes a PASS.
 *
 * ## Why it is not on staging, which is a release-management fact rather than a defect
 *
 * The ticket is milestoned **RC 3.14.0** (the PM moved it there on 22 Sep: "the management team
 * asked for full patient names on the boards as part of the RC 3.14 release"), but the work merged
 * to **`release/3.15.0`** as PR #3779 from `task/3724-rc315`; the 3.14 PR, **#3778, was CLOSED
 * unmerged**. Verified structurally: `f40476707` is *diverged* from `release/3.14.0`, and the new
 * `api/src/Service/Kpi/PatientDisplayName.php` is **404 on `release/3.14.0`** and present on 3.15.
 * Staging serves 3.14.0, so none of it is here.
 *
 * ## The #3774 interaction, which is the one thing that IS already full-named
 *
 * #3774's own AC5 changed its new export's patient column "from today's export, which showed
 * initials only" — so `POST /kpis/orga/risks/export` writes full names on staging **today**, from
 * `BillingBacklogVoFacts::patientFullNames()`, independently of this ticket. Half of #3724 AC5 is
 * therefore already satisfied, by a different ticket. {@link riskExportCsv} covers it, and the spec
 * asserts it so a #3724 deploy cannot silently regress it.
 *
 * ## Traps
 *
 *  - **`/kpis/management/revenue-drilldown` needs `?bar=`** — `erarbeitet`, `nicht_validiert` or
 *    `validiert`. Without it the route answers **400 `Unknown bar ""`**, which reads like the
 *    endpoint being gone. Its rows are nested `teams[] → therapists[] → prescriptions[]`, not flat.
 *  - **Both CSV exports that this ticket's AC5 names are gated differently.** The revenue-drilldown
 *    export answers **403** for the QA Super Admin — the #3181 Kian/Dennis allowlist, confirmed by
 *    the known-allowlisted `/kpis/management/export` answering 403 in the same breath — so it is
 *    unreachable here, not broken.
 *  - **The banner's OLD export is still routed and still serves initials.** #3774 removed the
 *    banner from both boards but deliberately kept its files, so
 *    `POST /kpis/management/billing-backlog/export` still answers 200 with 1,170 rows of "K. P.".
 *    #3724's PR modifies that controller too, so it is a second, independent deployment probe.
 *  - **`patientInitials` is nested at different depths per surface** (flat rows on the risk and
 *    working-hours collections, three levels deep on the drilldown), so the reader walks the whole
 *    document rather than assuming a row shape.
 */

export const STAGING_WEB = 'https://staging.therapios.de';

/** The five collections that carry the patient field, and which AC each serves. */
export const SURFACES = [
  { path: '/kpis/orga/risks', label: 'Therapeuten-Orga risks', acs: 'AC2/AC3' },
  { path: '/kpis/duplikat/worklist', label: 'Duplikat worklist', acs: 'AC3' },
  { path: '/kpis/management/working-hours', label: 'Arbeitszeiten rows', acs: 'AC4' },
  { path: '/kpis/admin-performance/risks', label: 'Admin-Performance risks', acs: 'AC3 (sibling)' },
  { path: '/kpis/management/revenue-drilldown?bar=erarbeitet', label: 'Revenue drilldown', acs: 'AC1' },
] as const;

/** `ManagementRevenueDrilldownProvider` — the only accepted values; anything else is a 400. */
export const DRILLDOWN_BARS = ['erarbeitet', 'nicht_validiert', 'validiert'] as const;

/** The field today, and the field PR #3779 renames it to. Both are read; neither alone decides. */
export const FIELD = { before: 'patientInitials', after: 'patientName' } as const;

export type PatientValue = { field: string; value: string };
export type SurfaceReading = {
  path: string;
  label: string;
  acs: string;
  status: number;
  values: PatientValue[];
  initials: number;
  fullNames: number;
};

export class FlowBoardsPatientNamesPage {
  private static cache = new Map<string, Promise<SurfaceReading>>();
  private bearer: string | null = null;

  constructor(
    private request: APIRequestContext,
    private page?: Page,
  ) {}

  // ───────────────────────────────── auth ─────────────────────────────────

  async token(creds: Credentials = STAGING_CREDENTIALS.superadmin): Promise<string> {
    if (this.bearer) return this.bearer;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: { username: creds.email, password: creds.password },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()} ${await res.text()}`);
    this.bearer = (await res.json()).token as string;
    return this.bearer;
  }

  // ───────────────────────────── classification ───────────────────────────

  /**
   * Is this value an abbreviation rather than a name?
   *
   * `"M. B."`, `"K. P."`, and the one- and three-part variants. Deliberately shape-based: the point
   * of the ticket is the VALUE, and the field name is not trusted to describe it.
   */
  static looksLikeInitials(value: string): boolean {
    return /^(?:[A-ZÄÖÜ]\.\s*){1,3}$/.test(value.trim());
  }

  /** Every patient value anywhere in a document, at any depth, under either field name. */
  static collect(node: unknown, out: PatientValue[] = []): PatientValue[] {
    if (Array.isArray(node)) {
      for (const item of node) FlowBoardsPatientNamesPage.collect(item, out);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((key === FIELD.before || key === FIELD.after) && typeof value === 'string')
          out.push({ field: key, value });
        else FlowBoardsPatientNamesPage.collect(value, out);
      }
    }
    return out;
  }

  // ─────────────────────────────── the API ────────────────────────────────

  /** One surface, read once per worker — several of these are multi-megabyte. */
  async surface(path: string): Promise<SurfaceReading> {
    const hit = FlowBoardsPatientNamesPage.cache.get(path);
    if (hit) return await hit;
    const promise = this.fetchSurface(path);
    FlowBoardsPatientNamesPage.cache.set(path, promise);
    return await promise;
  }

  private async fetchSurface(path: string): Promise<SurfaceReading> {
    const meta = SURFACES.find((s) => s.path === path);
    const token = await this.token();
    let res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
      timeout: 300_000,
    });
    // These are the slowest reads on staging and 504 under load; a 5xx is the server being
    // unhealthy, never a verdict about the payload's shape.
    for (let attempt = 1; attempt <= 2 && res.status() >= 500; attempt++) {
      console.log(`  GET ${path} -> ${res.status()}; retrying (${attempt}/2)`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      res = await this.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        timeout: 300_000,
      });
    }
    const body = res.status() === 200 ? await res.json().catch(() => null) : null;
    const values = FlowBoardsPatientNamesPage.collect(body);
    return {
      path,
      label: meta?.label ?? path,
      acs: meta?.acs ?? '',
      status: res.status(),
      values,
      initials: values.filter((v) => FlowBoardsPatientNamesPage.looksLikeInitials(v.value)).length,
      fullNames: values.filter((v) => v.value && !FlowBoardsPatientNamesPage.looksLikeInitials(v.value)).length,
    };
  }

  /** Every surface, in order. */
  async allSurfaces(): Promise<SurfaceReading[]> {
    const out: SurfaceReading[] = [];
    for (const s of SURFACES) out.push(await this.surface(s.path));
    return out;
  }

  /**
   * The deployment verdict, re-derived every run from behaviour.
   *
   * Deployed iff any surface serves a value that is not an abbreviation. Reading the VALUES rather
   * than the field names is what makes this survive the rename either way round.
   */
  async isDeployed(): Promise<boolean> {
    return (await this.allSurfaces()).some((s) => s.fullNames > 0);
  }

  // ─────────────────────────────── the exports ────────────────────────────

  /** Raw status for a route, retrying a 5xx. */
  async status(path: string, method: 'GET' | 'POST' = 'GET', data: unknown = {}): Promise<number> {
    const token = await this.token();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/ld+json' };
    let last = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res =
        method === 'GET'
          ? await this.request.get(`${API_BASE}${path}`, { headers, timeout: 180_000 })
          : await this.request.post(`${API_BASE}${path}`, { headers, data: data as Record<string, unknown>, timeout: 180_000 });
      last = res.status();
      if (last < 500) return last;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
    return last;
  }

  /** The banner's OLD export — #3774 hid the banner but kept this route, and #3724's PR edits it. */
  async billingBacklogExportCsv(): Promise<{ status: number; text: string }> {
    const token = await this.token();
    const res = await this.request.post(`${API_BASE}/kpis/management/billing-backlog/export`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {},
      timeout: 600_000,
    });
    return { status: res.status(), text: res.status() === 200 ? await res.text() : '' };
  }

  /** #3774's risk export. Needs the VO ids the board would send. */
  async riskExportCsv(prescriptionIds: number[]): Promise<{ status: number; text: string }> {
    const token = await this.token();
    const res = await this.request.post(`${API_BASE}/kpis/orga/risks/export`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { filters: {}, prescriptionIds },
      timeout: 600_000,
    });
    return { status: res.status(), text: res.status() === 200 ? await res.text() : '' };
  }

  /** Split a CSV these controllers wrote: BOM-stripped, `;`-delimited, quotes unwrapped. */
  static parseCsv(text: string): { header: string[]; rows: string[][] } {
    const clean = text.replace(/^﻿/, '').trim();
    const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
    const split = (line: string) => {
      const out: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (quoted && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else quoted = !quoted;
        } else if (c === ';' && !quoted) {
          out.push(cur);
          cur = '';
        } else cur += c;
      }
      out.push(cur);
      return out;
    };
    return { header: split(lines[0]), rows: lines.slice(1).map(split) };
  }

  /** The `Patient:in` column of a parsed export, by header position rather than by index. */
  static patientColumn(parsed: { header: string[]; rows: string[][] }): { index: number; values: string[] } {
    const index = parsed.header.findIndex((h) => h.trim() === 'Patient:in');
    return { index, values: index < 0 ? [] : parsed.rows.map((r) => (r[index] ?? '').trim()) };
  }

  // ─────────────────────────── the deployed bundle ───────────────────────────

  /**
   * Occurrence counts for the two field names in the served entry bundle.
   *
   * `patientName` is reported but NEVER asserted on: it is Flow's ordinary patient-name field and
   * occurs ~174 times regardless of this ticket. Only `patientInitials` is diagnostic.
   */
  async bundleFieldCounts(): Promise<{ url: string; before: number; after: number; rendersInitials: boolean }> {
    const shell = await this.request.get(`${STAGING_WEB}/`, { timeout: 60_000 });
    const entry = (await shell.text()).match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    expect(entry, 'the shell references an entry bundle').toBeTruthy();
    const res = await this.request.get(`${STAGING_WEB}${entry}`, { timeout: 180_000 });
    const js = await res.text();
    const count = (needle: string) => {
      let n = 0;
      let i = js.indexOf(needle);
      while (i >= 0) {
        n++;
        i = js.indexOf(needle, i + 1);
      }
      return n;
    };
    return {
      url: entry!,
      before: count(FIELD.before),
      after: count(FIELD.after),
      // The risk cell renders the field directly; this is the one bundle fact that is diagnostic.
      rendersInitials: js.includes(`children:t.${FIELD.before}`),
    };
  }

  // ─────────────────────────────── the screen ────────────────────────────────

  async openBoard(tab: 'Therapeuten-Orga' | 'Management' | 'Admin-Performance'): Promise<FlowBoardsPage> {
    const page = this.requirePage();
    await mintUiSession(page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(page);
    await boards.open();
    await boards.openTab(tab);
    return boards;
  }

  /**
   * Every painted patient cell on the risk table, classified.
   *
   * Located by SHAPE rather than by a testid, because the cells carry none — and the shape is the
   * assertion, so the locator and the question are the same thing. The `privat` badge shares the
   * cell, so only leaves matching a name-or-initials shape are taken.
   */
  async paintedPatientValues(): Promise<{ initials: string[]; fullNames: string[] }> {
    const page = this.requirePage();
    const texts = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('div,span').forEach((node) => {
        const el = node as HTMLElement;
        if (el.children.length !== 0) return;
        const text = (el.textContent ?? '').trim();
        if (!text || text.length > 60) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        out.push(text);
      });
      return out;
    });
    const initialsShape = /^(?:[A-ZÄÖÜ]\.\s*){1,3}$/;
    return { initials: texts.filter((t) => initialsShape.test(t)), fullNames: [] };
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('This helper needs a Page; construct FlowBoardsPatientNamesPage(request, page).');
    return this.page;
  }
}
