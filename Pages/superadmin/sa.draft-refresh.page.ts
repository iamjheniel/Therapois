import { APIRequestContext, expect } from '@playwright/test';

/**
 * Draft invoices refresh when a session delete reopens the VO (RC 3.12 #3589).
 *
 * `refreshDraftOnRevalidation()` only refreshed a draft while the VO's treatment status was in the
 * regeneration allowlist — `[COMPLETED, CANCELLED, INVOICED, ARCHIVED]`. Deleting a session flips a
 * Fertig-behandelt VO back to **Aktiv** (`ActivityDeleteListener::postFlush`), which is not on that
 * list, so `applyDraftRefresh()` threw `InvoiceNotEligibleForRegenerationException`, the caller
 * swallowed it, and the draft kept a stale amount with nobody told. `1e8e84361` splits the
 * predicate: `isEligibleForRegeneration()` is unchanged and still gates FIRST-TIME generation, and
 * a new `isEligibleForDraftRefresh()` additionally accepts a reopened ACTIVE VO.
 *
 * **The refresh is observable without deleting anything.** The listener runs on a `treatmentStatus`
 * OR a `validationStatus` changeset, so toggling validation on an already-Aktiv VO that carries a
 * draft exercises exactly the widened predicate — and a refresh is visible even when the amount is
 * already correct, because `applyDraftRefresh()` restamps the draft's **issueDate** and writes an
 * `invoice_logs` note (#3093: a regenerated draft is only "fresh" if its issue date and amount
 * snapshot are refreshed). That makes the round trip reversible, which deleting a documented
 * session is not: `Activity` exposes `Delete` but no plain `Post` — only `/activities/bulk`.
 *
 * **The two-step probe is what makes it conclusive**, because each step predicts a different
 * outcome under the same code:
 *
 * | step | expected |
 * |---|---|
 * | validated → `for_fixing` on an Aktiv VO | **no** refresh (not Validiert — unchanged behaviour) |
 * | `for_fixing` → validated on an Aktiv VO | refresh **post-fix**, silently rejected pre-fix |
 *
 * **Never toggle validation on an Aktiv VO that has NO invoice.** The same listener path can
 * CREATE one for an eligible VO (#3426), which is irreversible — every fixture here must already
 * carry a draft.
 */

export const API = 'https://api.staging.therapios.de';

export type DraftState = {
  treatmentStatus: string | null;
  validationStatus: string | null;
  copaymentAmount: number | null;
  totalRevenue: number | null;
  invoiceAmount: number | null;
  issueDate: string | null;
  datevSyncedAt: string | null;
  logCount: number;
};

export class DraftRefreshPage {
  static readonly API = API;
  /** The statuses that gated a refresh before #3589; ACTIVE was the missing one. */
  static readonly LEGACY_ALLOWLIST = ['Fertig Behandelt', 'Abgebrochen', 'Abgerechnet', 'Archiviert'];

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private async json(path: string, timeout = 240_000): Promise<any> {
    const response = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  async state(prescriptionId: number, invoiceId: number): Promise<DraftState> {
    const prescription = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    const invoice = await this.json(`/invoices/${invoiceId}`);
    const logs = DraftRefreshPage.members(await this.json(`/invoice_logs?pagination=false&invoice=${invoiceId}`));
    return {
      treatmentStatus: prescription.treatmentStatus ?? null,
      validationStatus: prescription.validationStatus ?? null,
      copaymentAmount: prescription.copaymentAmount ?? null,
      totalRevenue: prescription.totalRevenue ?? null,
      invoiceAmount: invoice.invoiceAmount ?? null,
      issueDate: invoice.issueDate ?? null,
      datevSyncedAt: invoice.datevSyncedAt ?? null,
      logCount: logs.length,
    };
  }

  /** Reversible: the caller restores the original value in a `finally`. */
  async setValidationStatus(prescriptionId: number, status: string | null): Promise<number> {
    const response = await this.request.patch(`${API}/prescriptions/${prescriptionId}`, {
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/merge-patch+json' },
      data: { validationStatus: status },
      timeout: 120_000,
    });
    return response.status();
  }

  /** Every unsent invoice that has never reached DATEV — the draft tier this ticket may touch. */
  async draftTierInvoices(): Promise<
    { id: number; number: string; type: string; amount: number | null; prescriptionId: number }[]
  > {
    const invoices: any[] = [];
    for (let page = 1; ; page++) {
      const body = await this.json(
        `/invoices?page=${page}&itemsPerPage=200&status=not_sent&groups%5B%5D=invoice-list%3Aread`,
      );
      const members = DraftRefreshPage.members(body);
      if (!members.length) break;
      invoices.push(...members);
      if (members.length < 200) break;
    }
    return invoices.map((invoice: any) => ({
      id: invoice.id,
      number: invoice.invoiceNumber,
      type: String(invoice.invoiceType ?? ''),
      amount: invoice.invoiceAmount ?? null,
      prescriptionId: Number(String(invoice.prescription?.['@id'] ?? invoice.prescription).split('/').pop()),
    }));
  }
}
