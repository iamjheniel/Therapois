import { APIRequestContext, Page } from '@playwright/test';
import { STAGING_CREDENTIALS } from '../util/api-token';

const API = 'https://api.staging.therapios.de';
const WEB = 'https://staging.therapios.de';

export type BsnrRow = { id: number; number: string; isMain: boolean; practiceId: number };
export type PracticeFacts = {
  id: number; name: string; practiceNumber: string | null;
  totalVos: number; doctorsCount: number; contacts: number; vacations: number;
  rows: BsnrRow[];
};

/**
 * RC 3.15 #3859 — `app:practice-doctor:merge-duplicates` could leave the surviving practice with no
 * **main** `practice_bsnr` row, which makes the practice form refuse to save and breaks #3285's rule
 * that `practice.practice_id` mirrors the main row.
 *
 * The fix is inside a console service, so it has **no client-decidable deployment probe** — no route,
 * no serialized field, and `/status` gives the release not the commit (#3704). What IS reachable is
 * everything the ticket's own ACs are stated in terms of:
 *
 *  - **AC5's check query**, re-expressed over `GET /practice_bsnrs` (a full collection carrying
 *    `number` / `isMain` / `practice`);
 *  - the **duplicate groups** the command derives, and its own decision rule, ported here so the
 *    preview's group list can be predicted before anyone runs it;
 *  - **AC2's gate**, the practice form's "One BSNR must be marked as main".
 */
export class PracticeBsnrMergePage {
  private token = '';

  /** AC2's exact refusal, as the deployed bundle carries it. */
  static readonly MAIN_ROW_GATE = 'One BSNR must be marked as main';

  constructor(private request: APIRequestContext) {}

  async init(): Promise<void> {
    const res = await this.request.post(`${API}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 120_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  /** A GET that retries a 5xx AND a thrown transport error (staging drops connections). */
  private async get<T>(path: string, timeout = 400_000): Promise<T> {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        const res = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
        if (res.ok()) return (await res.json()) as T;
        if (res.status() < 500) throw new Error(`GET ${path} -> ${res.status()}`);
        last = String(res.status());
      } catch (e: any) {
        if (/-> \d{3}$/.test(e?.message ?? '')) throw e;
        last = e?.message ?? String(e);
      }
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed: ${last}`);
  }

  // ───────────────────────────── the BSNR book ─────────────────────────────

  /** Every `practice_bsnr` row. ~1,460 rows, three pages. */
  async bsnrRows(): Promise<BsnrRow[]> {
    const out: BsnrRow[] = [];
    let total = -1;
    for (let page = 1; page <= 10; page++) {
      const b = await this.get<any>(`/practice_bsnrs?page=${page}&itemsPerPage=500`);
      if (total < 0) total = b.totalItems ?? b['hydra:totalItems'] ?? 0;
      const m = b.member ?? b['hydra:member'] ?? [];
      for (const r of m) {
        out.push({
          id: r.id,
          number: String(r.number ?? ''),
          isMain: r.isMain === true,
          practiceId: Number(String(r.practice).split('/').pop()),
        });
      }
      if (m.length < 500) break;
    }
    // A truncated read would silently report "0 practices without a main row".
    if (out.length !== total) throw new Error(`practice_bsnrs: read ${out.length} of ${total}`);
    return out;
  }

  static byPractice(rows: BsnrRow[]): Map<number, BsnrRow[]> {
    const m = new Map<number, BsnrRow[]>();
    for (const r of rows) m.set(r.practiceId, [...(m.get(r.practiceId) ?? []), r]);
    return m;
  }

  /**
   * AC5's check query, as the Need Command states it: practices that HOLD BSNR rows but none marked
   * main. A practice with no rows at all is deliberately excluded — that is a different, pre-#3806
   * condition the ticket says will not appear here.
   */
  static practicesWithoutAMainRow(rows: BsnrRow[]): number[] {
    return [...PracticeBsnrMergePage.byPractice(rows).entries()]
      .filter(([, v]) => !v.some((r) => r.isMain))
      .map(([p]) => p);
  }

  /** The complement failure: more than one row claiming to be main. */
  static practicesWithSeveralMainRows(rows: BsnrRow[]): number[] {
    return [...PracticeBsnrMergePage.byPractice(rows).entries()]
      .filter(([, v]) => v.filter((r) => r.isMain).length > 1)
      .map(([p]) => p);
  }

  /** BSNR numbers held by more than one PRACTICE — the groups the command derives. */
  static duplicateNumbers(rows: BsnrRow[]): Map<string, number[]> {
    const byNumber = new Map<string, Set<number>>();
    for (const r of rows) {
      if (!byNumber.has(r.number)) byNumber.set(r.number, new Set());
      byNumber.get(r.number)!.add(r.practiceId);
    }
    return new Map([...byNumber.entries()]
      .filter(([, v]) => v.size > 1)
      .map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
  }

  // ───────────────────────────── practices ─────────────────────────────

  /**
   * One practice with the fields the merge rule reads.
   *
   * **`practiceId` is on the ITEM read only** — it is absent from the collection and from the
   * `practice-list:read` / `billing:read` groups, so #3285's mirror invariant cannot be checked in
   * bulk.
   */
  async practice(id: number, rows: BsnrRow[]): Promise<PracticeFacts> {
    const b = await this.get<any>(`/practices/${id}`);
    return {
      id,
      name: String(b.name ?? ''),
      practiceNumber: b.practiceId == null ? null : String(b.practiceId),
      totalVos: Number(b.totalVos ?? 0),
      doctorsCount: Number(b.doctorsCount ?? 0),
      contacts: (b.practiceContacts ?? []).length,
      vacations: (b.vacations ?? []).length,
      rows: rows.filter((r) => r.practiceId === id),
    };
  }

  // ───────────────────── the command's own decision rule, ported ─────────────────────

  static normalizeName(name: string): string {
    return name.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * `hasData` as the command computes it — **a LOWER bound here**.
   *
   * The command counts prescriptions, doctors, contacts, activities, images and vacations; the API
   * exposes the first, second, third and sixth. So a `false` from this may be a `true` for the
   * command, which can turn a predicted merge into a skip. Predictions are therefore REPORTED, and
   * the assertions in the spec never depend on which branch a group takes.
   */
  static hasDataLowerBound(p: PracticeFacts): boolean {
    return p.totalVos > 0 || p.doctorsCount > 0 || p.contacts > 0 || p.vacations > 0;
  }

  static isPlaceholderWithNoData(p: PracticeFacts): boolean {
    if (PracticeBsnrMergePage.hasDataLowerBound(p)) return false;
    const n = p.name.toLowerCase();
    return p.name.trim() === '' || n.includes('for updating') || n.includes('no name');
  }

  /** `mostPrescriptions()`: highest count, lowest id breaking the tie. */
  static mostPrescriptions(ps: PracticeFacts[]): PracticeFacts {
    return [...ps].sort((a, b) => b.totalVos - a.totalVos || a.id - b.id)[0];
  }

  /**
   * `decideNewGroup()`: same name → merge; a placeholder beside a real one → merge; a
   * leading-zero-only number difference → merge with a flag; otherwise skip for a decision.
   */
  static decide(ps: PracticeFacts[], number: string):
    { action: 'merge'; basis: string; survivor: PracticeFacts } | { action: 'skip'; reason: string } {
    const names = new Set(ps.map((p) => PracticeBsnrMergePage.normalizeName(p.name)));
    if (names.size === 1) {
      return { action: 'merge', basis: 'same-name', survivor: PracticeBsnrMergePage.mostPrescriptions(ps) };
    }
    const real = ps.filter((p) => !PracticeBsnrMergePage.isPlaceholderWithNoData(p));
    if (real.length > 0 && real.length < ps.length) {
      return { action: 'merge', basis: 'placeholder', survivor: PracticeBsnrMergePage.mostPrescriptions(real) };
    }
    const distinctRaw = new Set(ps.map((p) => String(p.practiceNumber ?? '')));
    if (distinctRaw.size > 1) {
      return { action: 'merge', basis: 'leading-zero', survivor: PracticeBsnrMergePage.mostPrescriptions(ps) };
    }
    return { action: 'skip', reason: `differently-named practices share BSNR ${number}` };
  }

  /**
   * Whether a group could exercise #3859 at all.
   *
   * The bug needs the survivor to own **no main row of its own** after `moveBsnrRows()` brought the
   * others in as secondaries. `ensureMainBsnrRow()` returns early when a main row already exists, so
   * a group in which every member already has one can never reach the fixed code.
   */
  static couldExerciseTheBug(ps: PracticeFacts[]): boolean {
    return ps.some((p) => p.rows.length === 0 || !p.rows.some((r) => r.isMain));
  }

  // ───────────────────────────── the bundle ─────────────────────────────

  /** How often a literal occurs in the served entry bundle, counting its escaped form too. */
  static async bundleOccurrences(page: Page, texts: string[]): Promise<Record<string, number>> {
    const html = await (await page.request.get(`${WEB}/`, { timeout: 120_000 })).text();
    const entry = html.match(/\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/);
    if (!entry) throw new Error('no entry bundle in the served HTML');
    const js = await (await page.request.get(`${WEB}${entry[0]}`, { timeout: 300_000 })).text();
    const esc = (t: string) => [...t].map((c) => {
      const n = c.codePointAt(0)!;
      return n < 128 ? c : n < 256 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
    }).join('');
    const out: Record<string, number> = {};
    for (const t of texts) {
      const e = esc(t);
      out[t] = js.split(t).length - 1 + (e === t ? 0 : js.split(e).length - 1);
    }
    return out;
  }
}
