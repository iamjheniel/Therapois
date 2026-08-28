import { Page, expect } from '@playwright/test';
import { settleAfter, waitForStable } from '../util/settle';
import { AppPage } from '../base/app.page';

export type PriceEntry = {
  id: number;
  treatment: string;
  tariffType: string;
  effectiveDate: string;
  price: number;
  retroactiveTreatmentsUpdated?: number;
};

export type DocumentedTreatment = {
  activityTreatmentId: number;
  activityId: number;
  prescriptionId: number;
  date: string;
  resolvedTariff: number;
};

/**
 * Treatment prices and the retroactive recompute (RC 3.11, #3378).
 *
 * A treatment's price is snapshotted onto the `ActivityTreatment` when it is documented. Before this
 * ticket that snapshot was written once and never revisited, so entering a price with an effective
 * date in the past left every already-documented treatment on its old price. The fix recomputes those
 * snapshots whenever a price entry is created (single or bulk) or deleted, and reports the number of
 * rows it touched.
 *
 * Surfaces used here, all verified live on staging:
 *  - `POST /treatment_price_histories` — the single-entry path behind Heilmittelverwaltung's price
 *    editor. The 201 response carries **`retroactiveTreatmentsUpdated`**, the count AC5 shows the
 *    admin.
 *  - `DELETE /treatment_price_histories/{id}` — the delete path (AC3), whose 200 body is
 *    `{"retroactiveTreatmentsUpdated": n}`. Deleting an entry re-resolves the affected snapshots to
 *    whichever price applies next, which is what makes a test that adds an entry **self-restoring**.
 *  - `GET /activities?date[after]=&date[before]=` — the only way to find documented treatments by
 *    date. `activity_treatments` itself filters on `activity`, `treatment` and `prescription` only
 *    (no date filter, no ordering), and holds 45k+ rows for a single treatment type, so fixtures are
 *    found activity-first and then resolved.
 */
export class TreatmentPricesPage extends AppPage {
  static readonly API = 'https://api.staging.therapios.de';

  constructor(page: Page) {
    super(page);
  }

  private async api(
    path: string,
    init?: { method?: string; body?: any },
  ): Promise<{ status: number; json: any }> {
    return await this.page.evaluate(
      async ([base, p, method, body]: [string, string, string, string | null]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* the caller asserts on the status it gets */
        }
        const r = await fetch(`${base}${p}`, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            Accept: 'application/ld+json',
            ...(body ? { 'Content-Type': 'application/ld+json' } : {}),
          },
          ...(body ? { body } : {}),
        });
        const text = await r.text();
        try {
          return { status: r.status, json: text ? JSON.parse(text) : {} };
        } catch {
          return { status: r.status, json: { raw: text.slice(0, 400) } };
        }
      },
      [TreatmentPricesPage.API, path, init?.method ?? 'GET', init?.body ? JSON.stringify(init.body) : null] as [
        string,
        string,
        string,
        string | null,
      ],
    );
  }

  // ──────────────────────────────── treatments ───────────────────────────────

  async treatmentByCode(code: string): Promise<any> {
    const res = await this.api(`/treatments?page=1&itemsPerPage=5&code=${encodeURIComponent(code)}`);
    expect(res.status, `GET /treatments?code=${code}`).toBe(200);
    const members = res.json.member ?? res.json['hydra:member'] ?? [];
    const exact = members.find((m: any) => m.code === code);
    expect(exact, `treatment code ${code} must exist on this environment`).toBeTruthy();
    return exact;
  }

  async priceHistory(treatmentId: number): Promise<PriceEntry[]> {
    const res = await this.api(
      `/treatment_price_histories?page=1&itemsPerPage=50&treatment=${treatmentId}&order%5BeffectiveDate%5D=desc`,
    );
    expect(res.status, 'GET /treatment_price_histories').toBe(200);
    return res.json.member ?? res.json['hydra:member'] ?? [];
  }

  // ──────────────────────── documented-treatment fixtures ────────────────────

  /**
   * Documented treatments of one code inside a date window, newest first.
   *
   * Two steps because of the filter gap described in the class docs: activities are found by date,
   * then each candidate's `activity_treatments` are resolved to get the snapshotted price.
   */
  async documentedTreatments(
    code: string,
    from: string,
    to: string,
    limit = 15,
    activityPages = 4,
  ): Promise<DocumentedTreatment[]> {
    return await this.page.evaluate(
      async ([base, wantedCode, after, before, max, pages]: [string, string, string, string, number, number]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* an unauthenticated scan returns nothing and the caller skips */
        }
        const H = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' };

        const candidates: { id: number; date: string; prescriptionId: number }[] = [];
        for (let p = 1; p <= pages && candidates.length < max * 2; p++) {
          const r = await fetch(
            `${base}/activities?page=${p}&itemsPerPage=100&date%5Bafter%5D=${after}&date%5Bbefore%5D=${before}` +
              `&order%5Bdate%5D=desc`,
            { headers: H },
          );
          if (!r.ok) break;
          const j = await r.json();
          const members = j.member ?? j['hydra:member'] ?? [];
          if (!members.length) break;
          for (const m of members) {
            const codes = (m.prescription?.treatmentCodes ?? []).map((c: any) => c.code);
            if (codes.includes(wantedCode)) {
              candidates.push({ id: m.id, date: m.date, prescriptionId: m.prescription?.id });
            }
          }
        }

        const rows: any[] = [];
        for (const c of candidates) {
          if (rows.length >= max) break;
          const r = await fetch(`${base}/activity_treatments?page=1&itemsPerPage=20&activity=${c.id}`, { headers: H });
          if (!r.ok) continue;
          const j = await r.json();
          for (const m of j.member ?? j['hydra:member'] ?? []) {
            if (m.treatment?.code === wantedCode && m.resolvedTariff !== null && m.resolvedTariff !== undefined) {
              rows.push({
                activityTreatmentId: m.id,
                activityId: c.id,
                prescriptionId: c.prescriptionId,
                date: c.date,
                resolvedTariff: m.resolvedTariff,
              });
            }
          }
        }
        return rows;
      },
      [TreatmentPricesPage.API, code, from, to, limit, activityPages] as [string, string, string, string, number, number],
    );
  }

  /** Re-reads the snapshotted price of a known set of rows, keyed by ActivityTreatment id. */
  async resolvedTariffs(rows: DocumentedTreatment[]): Promise<Record<number, number>> {
    const activityIds = [...new Set(rows.map((r) => r.activityId))];
    return await this.page.evaluate(
      async ([base, ids]: [string, number[]]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* the caller compares against a baseline and will see the gap */
        }
        const H = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' };
        const out: Record<number, number> = {};
        for (const id of ids) {
          const r = await fetch(`${base}/activity_treatments?page=1&itemsPerPage=20&activity=${id}`, { headers: H });
          if (!r.ok) continue;
          const j = await r.json();
          for (const m of j.member ?? j['hydra:member'] ?? []) out[m.id] = m.resolvedTariff;
        }
        return out;
      },
      [TreatmentPricesPage.API, activityIds] as [string, number[]],
    );
  }

  /**
   * How many billing batches each VO is already part of — AC4's "in any billing state".
   *
   * `billingBatchCount` is the only billing linkage the prescription payload exposes; there is no
   * `prescription_billing_batches` resource to join against, so a non-zero count is what "already
   * billed" means here.
   */
  async billingBatchCounts(prescriptionIds: number[]): Promise<Record<number, number>> {
    return await this.page.evaluate(
      async ([base, ids]: [string, number[]]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* an empty result reads as "no billing information available" */
        }
        const H = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' };
        const out: Record<number, number> = {};
        for (const id of ids) {
          const r = await fetch(`${base}/prescriptions/${id}`, { headers: H });
          if (!r.ok) continue;
          const j = await r.json();
          out[id] = j.billingBatchCount ?? 0;
        }
        return out;
      },
      [TreatmentPricesPage.API, prescriptionIds] as [string, number[]],
    );
  }


  /**
   * Insurance type per VO — `public` (GKV) or `private` (PKV/Privat).
   *
   * Needed because a price entry is scoped to one **tariff type**: the HBH-E entry effective
   * 2026-08-10 is GKV-only, so private-insurance treatments of the same code in the same window
   * legitimately resolve to the PRIVAT tariff (€24) and must not be read as un-repriced GKV rows.
   */
  async prescriptionInsurance(prescriptionIds: number[]): Promise<Record<number, string>> {
    return await this.page.evaluate(
      async ([base, ids]: [string, number[]]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* an empty result reads as "unknown" and the caller drops the row */
        }
        const H = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' };
        const out: Record<number, string> = {};
        for (const id of ids) {
          const r = await fetch(`${base}/prescriptions/${id}`, { headers: H });
          if (!r.ok) continue;
          const j = await r.json();
          out[id] = j.insuranceType ?? 'unknown';
        }
        return out;
      },
      [TreatmentPricesPage.API, prescriptionIds] as [string, number[]],
    );
  }


  /**
   * Snapshotted prices for a known set of `ActivityTreatment` ids, read one by one.
   *
   * `resolvedTariffs()` goes the other way round — from activities — because that is how fixtures are
   * discovered. When the ids are already known (the ticket names four of them) this is the direct
   * read.
   */
  async resolvedTariffsById(activityTreatmentIds: number[]): Promise<Record<number, number>> {
    return await this.page.evaluate(
      async ([base, ids]: [string, number[]]) => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* a missing row is absent from the result and the caller's assertion fails loudly */
        }
        const H = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' };
        const out: Record<number, number> = {};
        for (const id of ids) {
          const r = await fetch(`${base}/activity_treatments/${id}`, { headers: H });
          if (!r.ok) continue;
          const j = await r.json();
          out[id] = j.resolvedTariff;
        }
        return out;
      },
      [TreatmentPricesPage.API, activityTreatmentIds] as [string, number[]],
    );
  }

  // ───────────────────────────── price entries ───────────────────────────────

  /** Creates a price entry. The 201 body carries `retroactiveTreatmentsUpdated` (AC5). */
  async addPrice(input: {
    treatmentId: number;
    tariffType: string;
    effectiveDate: string;
    price: number;
  }): Promise<{ status: number; entry: PriceEntry }> {
    const res = await this.api('/treatment_price_histories', {
      method: 'POST',
      body: {
        treatment: `/treatments/${input.treatmentId}`,
        tariffType: input.tariffType,
        effectiveDate: input.effectiveDate,
        price: input.price,
      },
    });
    return { status: res.status, entry: res.json };
  }

  /** Deletes a price entry; the 200 body reports how many snapshots were recomputed (AC3). */
  async deletePrice(id: number): Promise<{ status: number; recomputed: number | null }> {
    const res = await this.api(`/treatment_price_histories/${id}`, { method: 'DELETE' });
    return { status: res.status, recomputed: res.json?.retroactiveTreatmentsUpdated ?? null };
  }

  // ──────────────────────────────── the UI ───────────────────────────────────

  async openHeilmittelverwaltung() {
    await this.page.setViewportSize({ width: 1920, height: 1200 });
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.navTo(/Heilmittelverwaltung/);
    await expect(this.page.getByText('Heilmittelverwaltung', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    // The heading paints well before the price table under it. Wait for that table to stop growing
    // rather than sleeping a flat 4 s that was neither necessary on a warm page nor sufficient on a
    // cold one.
    await waitForStable(this.page.locator('tr, [role="row"]'));
  }

  /**
   * Turns the price table into the inline editor.
   *
   * The editor is what makes a retroactive entry possible from the UI at all: it adds a per-row
   * **Effective Date** column (defaulting to today) next to the tariff fields, and replaces the row
   * actions with "Save All Changes" / "Discard".
   */
  async enterEditMode() {
    // Entering the editor re-renders every row with its Effective Date column; settle on that.
    await settleAfter(
      this.page,
      () => this.page.getByText('Bearbeitungsmodus', { exact: true }).first().click(),
      { budgetMs: 15_000 },
    );
  }
}
