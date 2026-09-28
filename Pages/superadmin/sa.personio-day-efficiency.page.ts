import { Page } from '@playwright/test';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken, mintUiSession } from '../util/api-token';
import { FlowBoardsPage } from './sa.flow-boards.page';

/**
 * The Übersicht section heading. **#3770 renamed it from "Arbeitszeiten" on 2026-09-22**, so both
 * spellings are accepted: staging serves "Übersicht", Production is still on the pre-3.14 build and
 * serves "Arbeitszeiten", and these page objects back mirrored specs in both projects.
 */
export const OVERVIEW_HEADING = /^(Übersicht|Arbeitszeiten)$/;

/**
 * Effizienz and €/Stunde over qualifying days only — RC 3.13 #3666 (commit `bc5da6887`).
 *
 * Both figures used to divide the WHOLE period's treated time and revenue by the Personio hours that
 * exist, so a day with treatments and no Personio entry inflated the numerator against an unchanged
 * denominator — the ticket cites a production row reading 229,4%. The fix restricts the NUMERATOR to
 * days Personio holds an entry for. The denominator is arithmetically untouched, because such a day
 * contributes no Personio minutes either way — which is the single most useful thing to know here.
 *
 * ## Why this is verifiable exactly, and not by sampling
 *
 * `WorkingHoursRow` gained the two qualifying-day numerators, so `GET /kpis/management/working-hours`
 * now serves BOTH scopes side by side and the two candidate formulas are fully separable from one
 * payload:
 *
 * ```
 * new (shipped)  efficiency     = personioDayTreatmentMinutes / personioMinutes
 *                revenuePerHour = personioDayRevenue          / (personioMinutes / 60)
 * old            efficiency     = treatmentMinutes            / personioMinutes
 *                revenuePerHour = revenue                     / (personioMinutes / 60)
 * ```
 *
 * A row only discriminates when `personioDayTreatmentMinutes !== treatmentMinutes` — i.e. when the
 * therapist actually has a day with treated time and no Personio entry. **27 of 116 rows do in April
 * 2026**, with differences up to 34 percentage points (Nicole Mlady 79,44% against the old 113,89%),
 * so the period is a real fixture rather than a vacuous one.
 *
 * ## Traps
 *
 * - **The "Personio fehlt (N T.)" tag is NOT the set of affected rows.** It stays whole-period (AC5)
 *   and counts a different population: **9 of the 27 changed rows in April read "Personio fehlt
 *   (0 T.)"**. The tag counts *expected* working days with no entry, while the numerator restriction
 *   drops *any* day carrying treatment without an entry. A QA who finds fixtures via the tag — as the
 *   ticket's own reproduction step suggests — misses a third of them.
 * - **The time columns no longer divide into Effizienz, by design (AC4).** `treatmentMinutes` and
 *   `personioMinutes` stay whole-period, so `treatmentMinutes / personioMinutes` is *strictly larger*
 *   than the published Effizienz for any therapist with a gap day. Checking that division and finding
 *   it "checks out" means the row has no gap day — it is not evidence the fix is live.
 * - **Zero qualifying days means unavailable, not zero.** 10 April rows have `personioMinutes: 0` and
 *   serve `efficiency: null` / `revenuePerHour: null` — 5 of them while carrying treated time.
 * - **The trend providers keep the old rule on purpose** and will disagree with the table and the
 *   cards. Measured for April 2026: the monthly trend bucket serves €/Stunde **96,1** against the KPI
 *   card's **95,15** (the pooled whole-period figure is 96,31). `gesamt` carries no `efficiency` key
 *   at all, so €/Stunde is the only comparable number. Documented on the issue; do not file it.
 * - The tooltip key is **`flowBoards.effizienzPersonioTageTooltip`**, not the Developer Reference's
 *   suggested `effizienzPeriodRuleTooltip`.
 */

/** The period that actually contains gap days — 27 of 116 rows discriminate. */
export const GAP_PERIOD = { from: '2026-04-01', to: '2026-04-30', label: 'April 2026' } as const;

/** A month where the corrected figure crosses the 115% warning threshold and the old one does not. */
export const WARNING_STRADDLE_PERIOD = { from: '2026-05-01', to: '2026-05-31' } as const;

/** `WorkingHoursRowProvider::WARN_EFFICIENCY` — the Zeiterfassung marker's efficiency arm. */
export const WARN_EFFICIENCY = 115.0;

/** AC7's string, and the key that actually carries it. */
export const TOOLTIP = { key: 'flowBoards.effizienzPersonioTageTooltip', de: 'Nur Tage mit Personio-Eintrag' } as const;

/**
 * The Therapeuten-Orga board's legend still states the invariant #3666 removed.
 * `TherapeutenOrgaLegend.tsx` renders this key; see the finding in the spec.
 */
/**
 * The Therapeuten-Orga legend line, and the qualifier AC9 added to it (shipped 2026-09-14).
 *
 * `de` is the formula half, which is unchanged; `qualifier` is what AC9 required and what makes the
 * legend agree with the table again. AC9's literal text proposed a `/` divider, but the shipped
 * string keeps the existing **`÷`** and only appends the qualifier — consistent with the sibling
 * `toLegendDifferenz` line, and the better call. Matching on the two halves separately rather than
 * on one exact sentence keeps this test insensitive to that choice.
 */
export const LEGEND = {
  key: 'flowBoards.toLegendEffizienz',
  de: 'Effizienz = Behandlungszeit ÷ Personio-Stunden',
  qualifier: '(nur Tage mit Personio-Eintrag)',
  en: 'Efficiency = treatment time ÷ Personio hours (only days with a Personio entry)',
} as const;

export type HoursRow = {
  therapistId: number;
  therapistName: string;
  teamId: number | null;
  teamName: string | null;
  efficiency: number | null;
  revenuePerHour: number | null;
  /** Whole-period (AC4 freezes these). */
  treatmentMinutes: number;
  revenue: number;
  personioMinutes: number;
  /** Qualifying-day numerators — the #3666 additions. */
  personioDayTreatmentMinutes: number;
  personioDayRevenue: number;
  missingPersonioDays: number;
  timeRecordingWarning: boolean;
  otherMinutes: number;
  sonstigeAbwesenheitMinutes: number;
};

export type TeamRow = {
  teamId: number | null;
  teamName: string | null;
  efficiency: number | null;
  revenuePerHour: number | null;
  memberCount: number;
};

export type ManagementRow = { therapistId: number; therapistName: string; efficiency: number | null; revenuePerHour: number | null; timeRecordingWarning?: boolean };

export class PersonioDayEfficiencyPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3666: no bearer token');
  }

  private async get(path: string, timeout = 300_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(4_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  private static window(w: { from: string; to: string }): string {
    return `from=${w.from}&to=${w.to}`;
  }

  // ─────────────────────────────── the three row surfaces ───────────────────────────────

  /** The Therapeuten-Orga Arbeitszeiten rows — the only surface carrying BOTH scopes. */
  async hoursRows(w: { from: string; to: string }): Promise<HoursRow[]> {
    const body = await this.get(`/kpis/management/working-hours?${PersonioDayEfficiencyPage.window(w)}`);
    return (body.member ?? []).map((r: any) => ({
      therapistId: r.therapistId,
      therapistName: r.therapistName,
      teamId: r.teamId ?? null,
      teamName: r.teamName ?? null,
      efficiency: r.efficiency ?? null,
      revenuePerHour: r.revenuePerHour ?? null,
      treatmentMinutes: r.treatmentMinutes ?? 0,
      revenue: r.revenue ?? 0,
      personioMinutes: r.personioMinutes ?? 0,
      personioDayTreatmentMinutes: r.personioDayTreatmentMinutes ?? 0,
      personioDayRevenue: r.personioDayRevenue ?? 0,
      missingPersonioDays: r.missingPersonioDays ?? 0,
      timeRecordingWarning: !!r.timeRecordingWarning,
      otherMinutes: r.otherMinutes ?? 0,
      sonstigeAbwesenheitMinutes: r.sonstigeAbwesenheitMinutes ?? 0,
    }));
  }

  /**
   * The rows for the board's DEFAULT period (no `from`/`to`).
   *
   * Kept as its own method because it is the period a verification run naturally lands on, and it is
   * almost entirely non-discriminating — measured at **2 of 122 rows** against 22-27 of 116 in
   * `GAP_PERIOD`. Reading Effizienz there tells you nothing about which rule is live.
   */
  async defaultHoursRows(): Promise<HoursRow[]> {
    const body = await this.get('/kpis/management/working-hours');
    return (body.member ?? []).map((r: any) => ({
      therapistId: r.therapistId,
      therapistName: r.therapistName,
      teamId: r.teamId ?? null,
      teamName: r.teamName ?? null,
      efficiency: r.efficiency ?? null,
      revenuePerHour: r.revenuePerHour ?? null,
      treatmentMinutes: r.treatmentMinutes ?? 0,
      revenue: r.revenue ?? 0,
      personioMinutes: r.personioMinutes ?? 0,
      personioDayTreatmentMinutes: r.personioDayTreatmentMinutes ?? 0,
      personioDayRevenue: r.personioDayRevenue ?? 0,
      missingPersonioDays: r.missingPersonioDays ?? 0,
      timeRecordingWarning: !!r.timeRecordingWarning,
      otherMinutes: r.otherMinutes ?? 0,
      sonstigeAbwesenheitMinutes: r.sonstigeAbwesenheitMinutes ?? 0,
    }));
  }

  /** The Management board's own Arbeitszeiten row (AC8's other side). */
  async managementRows(w: { from: string; to: string }): Promise<ManagementRow[]> {
    const body = await this.get(`/kpis/management/therapists?${PersonioDayEfficiencyPage.window(w)}`);
    return (body.member ?? []).map((r: any) => ({
      therapistId: r.therapistId,
      therapistName: r.therapistName,
      efficiency: r.efficiency ?? null,
      revenuePerHour: r.revenuePerHour ?? null,
      timeRecordingWarning: r.timeRecordingWarning,
    }));
  }

  /** Team rows (AC3). */
  async teamRows(w: { from: string; to: string }): Promise<TeamRow[]> {
    const body = await this.get(`/kpis/management/teams?${PersonioDayEfficiencyPage.window(w)}`);
    return (body.member ?? []).map((r: any) => ({
      teamId: r.teamId ?? null,
      teamName: r.teamName ?? null,
      efficiency: r.efficiency ?? null,
      revenuePerHour: r.revenuePerHour ?? null,
      memberCount: r.memberCount ?? 0,
    }));
  }

  /** The KPI cards above the table — changed by the same commit so card and table agree. */
  async kpiCard(w: { from: string; to: string }): Promise<{ efficiency: number | null; revenuePerHour: number | null }> {
    const body = await this.get(`/kpis/management?${PersonioDayEfficiencyPage.window(w)}`);
    const card = (body.member ?? [])[0] ?? {};
    return { efficiency: card.efficiency ?? null, revenuePerHour: card.revenuePerHour ?? null };
  }

  /** A monthly trend bucket — deliberately still on the whole-period rule. */
  async trendBucket(monthStart: string, to: string): Promise<{ efficiency: number | null; revenuePerHour: number | null } | null> {
    const body = await this.get(`/kpis/management/trend?level=monat&to=${to}`);
    for (const bucket of body.member ?? []) {
      if (String(bucket.periodStart ?? '').startsWith(monthStart)) {
        const total = bucket.gesamt ?? {};
        return { efficiency: total.efficiency ?? null, revenuePerHour: total.revenuePerHour ?? null };
      }
    }
    return null;
  }

  // ─────────────────────────────── the two formulas ───────────────────────────────

  /** The shipped rule: qualifying-day numerator over the (unchanged) Personio denominator. */
  static qualifyingEfficiency(row: HoursRow): number | null {
    return row.personioMinutes > 0 ? (100 * row.personioDayTreatmentMinutes) / row.personioMinutes : null;
  }

  /** The rule #3666 replaced — whole-period numerator over the same denominator. */
  static wholePeriodEfficiency(row: HoursRow): number | null {
    return row.personioMinutes > 0 ? (100 * row.treatmentMinutes) / row.personioMinutes : null;
  }

  static qualifyingRevenuePerHour(row: HoursRow): number | null {
    return row.personioMinutes > 0 ? row.personioDayRevenue / (row.personioMinutes / 60) : null;
  }

  static wholePeriodRevenuePerHour(row: HoursRow): number | null {
    return row.personioMinutes > 0 ? row.revenue / (row.personioMinutes / 60) : null;
  }

  /** Rows where the two formulas differ — the only ones that can tell the build apart. */
  static discriminating(rows: HoursRow[]): HoursRow[] {
    return rows.filter((r) => r.personioMinutes > 0 && Math.abs(r.personioDayTreatmentMinutes - r.treatmentMinutes) > 0.001);
  }

  /** AC3's pooled ratio: sum the numerators, sum the denominators, divide ONCE. */
  static pooledEfficiency(rows: HoursRow[]): number | null {
    const denominator = rows.reduce((sum, r) => sum + r.personioMinutes, 0);
    if (denominator <= 0) return null;
    return (100 * rows.reduce((sum, r) => sum + r.personioDayTreatmentMinutes, 0)) / denominator;
  }

  static pooledRevenuePerHour(rows: HoursRow[]): number | null {
    const hours = rows.reduce((sum, r) => sum + r.personioMinutes, 0) / 60;
    if (hours <= 0) return null;
    return rows.reduce((sum, r) => sum + r.personioDayRevenue, 0) / hours;
  }

  /** The wrong way AC3 rules out: averaging the members' published percentages. */
  static averageOfMemberPercentages(rows: HoursRow[]): number | null {
    const values = rows.map((r) => r.efficiency).filter((v): v is number => null !== v);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  // ─────────────────────────────── the screen ───────────────────────────────

  /** The served web bundle, for the AC7 string and the legend check (#3337's technique). */
  /**
   * Occurrences of a literal in the bundle, matched in its ESCAPED non-ASCII form.
   *
   * The bundle stores `÷` as `\xf7`, `ü` as `\xfc` and so on, so a raw grep for a German string
   * returns 0 and reads exactly like "never shipped" — the #3611 trap. A first check of AC9 searched
   * for the `/`-divider form the AC's text proposed and found 0, which looked like a pass.
   */
  escapedCount(source: string, needle: string): number {
    const escaped = [...needle]
      .map((c) => (c.charCodeAt(0) < 128 ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
      .join('');
    return source.split(escaped).length - 1;
  }

  async bundle(): Promise<string> {
    const shell = await (await this.page.request.get('https://staging.therapios.de/', { timeout: 60_000 })).text();
    const entry = shell.match(/src="(\/_expo\/static\/js\/web\/entry-[^"]+\.js)"/)?.[1];
    if (!entry) throw new Error('#3666: no entry bundle on the app shell');
    return (await this.page.request.get(`https://staging.therapios.de${entry}`, { timeout: 240_000 })).text();
  }

  /** Opens the Therapeuten-Orga board and waits for the Arbeitszeiten table to paint a row. */
  async openArbeitszeiten(expectName: string): Promise<FlowBoardsPage> {
    await mintUiSession(this.page, STAGING_CREDENTIALS.superadmin);
    const boards = new FlowBoardsPage(this.page);
    await boards.open();
    await boards.openTab('Therapeuten-Orga');
    await this.page.getByText(OVERVIEW_HEADING).first().waitFor({ state: 'visible', timeout: 240_000 });
    await boards.setLevel('Monat');
    for (let step = 0; step < 24; step++) {
      if (GAP_PERIOD.label === (await boards.periodLabel())) break;
      await boards.stepPeriod('back');
    }
    // The heading and the toggles render long before `working-hours` answers; a name from the
    // payload is the readiness condition (the same trap #3575 records).
    for (let poll = 0; poll < 120; poll++) {
      const text = await this.page.evaluate(() => (document.querySelector('#root') as HTMLElement)?.innerText ?? '');
      if (text.includes(expectName)) return boards;
      await this.page.waitForTimeout(2_000);
    }
    throw new Error(`#3666: the Arbeitszeiten table never painted "${expectName}"`);
  }

  /** Whether a string is on screen anywhere (legend and tooltip copy). */
  async onScreen(needle: string): Promise<boolean> {
    return this.page.evaluate(
      (text) => ((document.querySelector('#root') as HTMLElement)?.innerText ?? '').includes(text),
      needle,
    );
  }
}
