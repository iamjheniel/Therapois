import { APIRequestContext, expect } from '@playwright/test';
import { StoredAddress, stripCountryMarker } from './sa.patient-address-migration.page';

/**
 * The four billing exports read a patient's structured address fields (RC 3.12 #3375).
 *
 * DATEV debtor accounts, the ETI claim, the Optica export and the IB record document each used to
 * split the free-text address themselves. Since `b786b073b` (PR #3418) they read
 * `street`/`postalCode`/`city` directly, with the old parser kept as the fallback for rows
 * #3373's migration has not filled (AC5).
 *
 * **The gate is `StructuredPatientAddress::fromRow()` — all three fields or nothing.** That is
 * deliberately stricter than #3374's letters (postal code + city), because every export sends a
 * street whenever its parser succeeds, so a row missing its street must fall back rather than send
 * less than it sends today. `structuredUsable()` below is that rule; `parseFreeText()` is
 * `OpticaExportService::splitAddress()`, the fallback it defers to.
 *
 * **Which row each consumer reads is not the same row**, and the ticket's ACs read as if it were:
 *
 * | consumer | row |
 * |---|---|
 * | DATEV provisioning, ETI claim | the **billing** address |
 * | DATEV bootstrap, Optica, IB record | the **residence** address (`Patient::getResidenceAddress()`) |
 *
 * **Almost nothing is observable from a client, and that is the finding, not a gap in effort.**
 * Because #3373's migration DERIVED the fields with the same splitter these exports fall back to,
 * the two paths agree BYTE-FOR-BYTE on every row either can answer (1,806 of 1,825 sampled) — the
 * commit itself had to corrupt the free text to attribute a path. Note that
 * `AddressNormalizer::stripCountryMarker` also collapses runs of whitespace; a port that omits
 * that reports false divergences, which is why `parseFreeText()` reuses the #3373 helper. Of the
 * four exports:
 *
 * - **Optica** answers 422 on every staging batch (#3288),
 * - **DATEV** is off (`DATEV_SYNC_ENABLED=false`, #3440) and exposes no debtor collection (#3499),
 * - **ETI** submission is blocked on staging, and
 * - **IB records** render their PDF ONCE, lazily, on the first signed-url request
 *   (`IbRecordPdfGeneratorService::generate()` no-ops when `signedFileName` is set) — so an
 *   existing PDF shows the render from its signing day, and the only records without one carry no
 *   signature, which answers `404 "PDF not yet available for this IB record."`.
 *
 * What IS decidable: the switch predicate over the live address population, the divergence between
 * the two paths (where this ticket can change an export at all), and the whole of AC2's client
 * half — `hasUsableAddress` ships in the bundle and is checkable there.
 */

export const API = 'https://api.staging.therapios.de';

export type AddressParts = { street: string; postalCode: string; city: string };

/** How a row resolves for these four exports. */
export type AddressPath = 'structured' | 'fallback' | 'neither';

export class BillingExportAddressPage {
  static readonly API = API;

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' };
  }

  async raw(path: string, timeout = 180_000): Promise<{ status: number; body: string }> {
    const response = await this.request.get(`${API}${path}`, { headers: this.headers(), timeout });
    return { status: response.status(), body: await response.text() };
  }

  private async json(path: string): Promise<any> {
    const response = await this.raw(path);
    expect(response.status, `GET ${path}`).toBe(200);
    return JSON.parse(response.body);
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  // ───────────────────────────── the two paths ───────────────────────────────

  /**
   * `StructuredPatientAddress::fromRow()`: the three fields, trimmed, or null. All three or none —
   * a partially filled row is NOT usable here even though #3374's letters would take it.
   */
  static structuredUsable(row: StoredAddress): AddressParts | null {
    const street = row.street.trim();
    const postalCode = row.postalCode.trim();
    const city = row.city.trim();
    if ('' === street || '' === postalCode || '' === city) return null;
    return { street, postalCode, city };
  }

  /**
   * `OpticaExportService::splitAddress()` — the fallback. Strips the #3370 country marker first,
   * then anchors on a five-digit postal code; with no anchor the whole string becomes the street.
   */
  static parseFreeText(raw: string | null): AddressParts {
    const address = stripCountryMarker(raw);
    if ('' === address) return { street: '', postalCode: '', city: '' };
    const match = address.match(/^(.*?)[,\s]+(\d{5})\s+(.+)$/u);
    if (match) {
      return { street: match[1].replace(/^[\s,]+|[\s,]+$/g, ''), postalCode: match[2], city: match[3].trim() };
    }
    return { street: address, postalCode: '', city: '' };
  }

  /** Which arm a row takes, and what the export therefore sends. */
  static resolve(row: StoredAddress): { path: AddressPath; parts: AddressParts } {
    const structured = BillingExportAddressPage.structuredUsable(row);
    if (structured) return { path: 'structured', parts: structured };
    if ('' !== row.raw.trim()) return { path: 'fallback', parts: BillingExportAddressPage.parseFreeText(row.raw) };
    return { path: 'neither', parts: { street: '', postalCode: '', city: '' } };
  }

  static same(a: AddressParts, b: AddressParts): boolean {
    return a.street === b.street && a.postalCode === b.postalCode && a.city === b.city;
  }

  // ──────────────────────────── AC2's predicates ─────────────────────────────

  /**
   * The deployed `hasUsableAddress` (`etiRecipient.ts`): the structured triple, else the old comma
   * heuristic. It is an OR, not a replacement — the dialog must never block a patient the backend
   * would submit, because the claim builder still parses the text for unmigrated rows.
   */
  static hasUsableAddress(row: StoredAddress | undefined): boolean {
    if (!row) return false;
    if (row.street.trim() && row.postalCode.trim() && row.city.trim()) return true;
    return !!row.raw && row.raw.includes(',');
  }

  /** What the dialog used to ask: does the free text contain a comma. */
  static commaHeuristic(row: StoredAddress | undefined): boolean {
    return !!row?.raw && row.raw.includes(',');
  }

  /** The billing row DATEV provisioning and the ETI claim read. */
  static billingAddress(addresses: StoredAddress[]): StoredAddress | null {
    return addresses.find((address) => address.isBilling) ?? null;
  }

  // ──────────────────────────── reachability probes ──────────────────────────

  /** Optica: `GET /billing_batches/{id}/optica-export` on the newest batches. */
  async opticaExportStatuses(limit = 5): Promise<{ id: number; status: string; http: number }[]> {
    const batches = BillingExportAddressPage.members(
      await this.json(`/billing_batches?page=1&itemsPerPage=${limit}&order%5Bid%5D=desc`),
    );
    const out: { id: number; status: string; http: number }[] = [];
    for (const batch of batches) {
      const probe = await this.raw(`/billing_batches/${batch.id}/optica-export`, 120_000);
      out.push({ id: batch.id, status: batch.status, http: probe.status });
    }
    return out;
  }

  /** IB records, with whether a PDF is already stored (which is what makes a re-render impossible). */
  async ibRecords(): Promise<{ id: number; status: string; stored: boolean }[]> {
    return BillingExportAddressPage.members(await this.json('/ib_records?page=1&itemsPerPage=200')).map((row: any) => ({
      id: row.id,
      status: String(row.status ?? ''),
      stored: !!row.signedFileName,
    }));
  }

  /**
   * The signed-url route, which is also the lazy render trigger: 200 hands back an S3 URL for a
   * PDF rendered on its signing day; 404 means no stored file AND no signature to render from.
   */
  async ibSignedUrlStatus(id: number): Promise<{ status: number; detail: string }> {
    const probe = await this.raw(`/ib_records/${id}/signed-url`, 120_000);
    let detail = '';
    try {
      detail = JSON.parse(probe.body).detail ?? '';
    } catch {
      detail = probe.body.slice(0, 120);
    }
    return { status: probe.status, detail };
  }

  /** DATEV exposes no debtor collection to a client — the surface AC1 would need. */
  async datevDebtorSurfaces(): Promise<{ path: string; status: number }[]> {
    const paths = ['/datev_debtors', '/debtors', '/datev_debtor_accounts'];
    const out: { path: string; status: number }[] = [];
    for (const path of paths) out.push({ path, status: (await this.raw(`${path}?page=1&itemsPerPage=1`, 60_000)).status });
    return out;
  }
}
