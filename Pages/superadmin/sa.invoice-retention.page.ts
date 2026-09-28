import { APIRequestContext, expect } from '@playwright/test';

/**
 * Invoices can never be deleted (RC 3.12 #3492).
 *
 * Invoices are financial records under an eight-year statutory retention period (§ 14b UStG), and
 * a maintenance command could previously wipe every invoice and its history in any environment.
 * `bd91fa410` closes that off in three places at once:
 *
 * | AC | mechanism | reachable from a client? |
 * |---|---|---|
 * | AC1 | an allow-list env guard on **three** console commands | no — console only |
 * | AC2 | `InvoiceRetentionListener` on `Prescription::preRemove`, plus `PatientDeleteProcessor` for a readable 422 | **yes** — `DELETE /patients/{id}` |
 * | AC3 | no Delete operation on Invoice, InvoiceLog, Prescription or BillingBatch | **yes** — route probes |
 * | AC4 | `api/docs/invoice-retention-compliance.md` | no — a repo document |
 *
 * **The rule is enforced on Prescription, not on Invoice, and that is deliberate.** An invoice is
 * always reached through its prescription, so `preRemove` there is the single choke point covering
 * the `Patient -> Prescription` cascade (`Patient::$prescriptions` is `cascade: ['remove']`),
 * console commands, and code not yet written. The database FK (`invoice.prescription_id`, NOT
 * NULL) would refuse the delete too, but an FK error is an accident of the schema — AC2 asks for a
 * stated rule, which is why the listener exists on top of it.
 *
 * **How to prove a delete route does not exist.** A missing operation answers **405**; an existing
 * one with a missing entity answers **404**. `deleteProbe()` is used with a nonexistent id on both
 * a protected resource and a control resource that DOES expose Delete
 * (`/activity_treatments/{id}`), so "405" is read as "no such operation" rather than "the id was
 * not found" — the two are indistinguishable from a single probe.
 *
 * **The AC2 probe issues a real DELETE.** It is expected to be refused, and the safe outcome is
 * the passing one: 422 with the invoice count, patient intact. If the guard ever regressed the
 * request would do exactly what the ticket forbids, so the spec verifies the patient still exists
 * afterwards rather than trusting the status code alone. Pick a patient that HAS invoices — never
 * one without, since that delete would succeed and is irreversible.
 */

export const API = 'https://api.staging.therapios.de';

/** The refusal `PatientDeleteProcessor` raises, minus the ids. */
export const RETENTION_REFUSAL = /cannot be deleted: (\d+) invoice\(s\) on their prescriptions are financial records/;

export type DeleteProbe = { path: string; status: number; detail: string };

export class InvoiceRetentionPage {
  static readonly API = API;

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

  private static detailOf(body: string): string {
    try {
      const parsed = JSON.parse(body);
      return parsed.detail ?? parsed.description ?? parsed['hydra:description'] ?? parsed.title ?? '';
    } catch {
      return body.includes('<!DOCTYPE') ? '(html error page)' : body.slice(0, 200);
    }
  }

  /** A DELETE against one route, reported rather than thrown, so a spec can assert the status. */
  async deleteProbe(path: string, timeout = 120_000): Promise<DeleteProbe> {
    const response = await this.request.delete(`${API}${path}`, { headers: this.headers(), timeout });
    return { path, status: response.status(), detail: InvoiceRetentionPage.detailOf(await response.text()) };
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout: 120_000 });
    return 200 === response.status();
  }

  /**
   * Every invoice on the environment, with the patient it hangs off — the independent count the
   * refusal message is checked against, so the assertion is not just "some number came back".
   */
  async invoicesByPatient(): Promise<Map<number, { count: number; numbers: string[] }>> {
    const response = await this.request.get(
      `${API}/invoices?pagination=false&groups%5B%5D=invoice-list%3Aread`,
      { headers: this.headers(), timeout: 240_000 },
    );
    expect(response.status(), 'GET /invoices').toBe(200);
    const out = new Map<number, { count: number; numbers: string[] }>();
    for (const invoice of InvoiceRetentionPage.members(await response.json())) {
      const patientId = invoice.prescription?.patient?.id;
      if (!patientId) continue;
      const entry = out.get(patientId) ?? { count: 0, numbers: [] };
      entry.count++;
      entry.numbers.push(invoice.invoiceNumber);
      out.set(patientId, entry);
    }
    return out;
  }
}
