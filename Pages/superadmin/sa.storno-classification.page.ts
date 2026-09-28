import { APIRequestContext, expect } from '@playwright/test';

/**
 * How a Storno is recognised (RC 3.12 #3449, PR #3451).
 *
 * `Invoice::isStorno()` used to infer Storno-ness from the invoice NUMBER (`str_starts_with(…, 'S')`)
 * while `setOriginalInvoice()` carried the relational truth, and nothing reconciled the two. The fix
 * makes the relation authoritative — `null !== $this->originalInvoice` — and converts the readers
 * that had re-implemented the prefix rule in DQL.
 *
 * **A converged predicate is, by construction, invisible on data where the two agreed.** So this
 * page object is built to check the things that remain observable from outside:
 *
 * | question | surface |
 * |---|---|
 * | do the three signals still agree on every invoice? | `GET /invoices?groups[]=invoice-list:read` — carries `invoiceNumber`, `originalInvoiceId` AND the serialized `invoiceType` in one payload |
 * | does a Storno ever surface as a VO's live invoice? | `prescription.invoice` IS `getActiveInvoice()` server-side |
 * | do the VO-rooted and invoice-rooted cancelled sets match? | `prescription.cancelledInvoices` vs `GET /invoices?cancelledRegister=true` |
 * | does the "Art" column's DQL agree with the PHP it mirrors? | `order[type]` vs the serialized `invoiceType` |
 *
 * The last one is the sharpest available test of the ticket's actual thesis. `InvoiceOrderFilter::
 * addTypeSort` builds `CASE WHEN i.originalInvoice IS NOT NULL THEN 2 …` in SQL while
 * `Invoice::getInvoiceType()` computes the same ranking in PHP, and the code comment says the two
 * "must stay in lockstep" — so sorting the whole book by Art and checking the serialized types come
 * back monotonic compares the two mechanisms directly, row by row, without needing a drifted fixture.
 *
 * **Trap:** the parameter is **`order[type]`**, not `order[invoiceType]` — the field serializes as
 * `invoiceType` but `InvoiceOrderFilter::SORT_TYPE` registers `type`. API Platform ignores an
 * unknown `order` key **silently**, so `order[invoiceType]=asc` and `=desc` return the identical
 * unsorted page and a monotonicity check "fails" with dozens of violations that have nothing to do
 * with the code under test. Read the IriTemplate (`search.template` on the collection) when in doubt.
 *
 * Read-only throughout — every request is a GET.
 */

export type InvoiceRow = {
  id: number;
  invoiceNumber: string;
  /** The serialized `Invoice::getInvoiceType()` — `copayment` | `pkv` | `storno`. */
  invoiceType: string;
  status: string;
  /** Present only when the invoice IS a Storno; the relational truth. */
  originalInvoiceId: number | null;
  /** Present only on a cancelled original: the number of the Storno that reverses it. */
  stornoNumber: string | null;
  prescriptionIri: string | null;
  prescriptionNumber: string | null;
};

export type VoBilling = {
  id: number;
  number: string;
  /** `getActiveInvoice()` — the VO's live successor, or null. */
  activeInvoiceId: number | null;
  activeInvoiceNumber: string | null;
  cancelledInvoiceIds: number[];
};

/** The rank `getInvoiceType()` and `addTypeSort` must agree on. */
export const TYPE_RANK: Record<string, number> = { copayment: 0, pkv: 1, storno: 2 };

export class StornoClassificationPage {
  static readonly API = 'https://api.staging.therapios.de';
  static readonly LIST_GROUP = 'groups%5B%5D=invoice-list%3Aread';

  private cachedBook: InvoiceRow[] | null = null;

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private async json(path: string): Promise<any> {
    const response = await this.request.get(`${StornoClassificationPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 120_000,
    });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private static shape(row: any): InvoiceRow {
    return {
      id: row.id,
      invoiceNumber: String(row.invoiceNumber ?? ''),
      invoiceType: String(row.invoiceType ?? ''),
      status: String(row.status ?? ''),
      originalInvoiceId: row.originalInvoiceId ?? null,
      stornoNumber: row.stornoNumber ?? null,
      prescriptionIri: row.prescription?.['@id'] ?? null,
      prescriptionNumber: row.prescription?.prescriptionId ?? null,
    };
  }

  /** Every invoice in the book, id-ascending. Cached — the whole file reasons over one snapshot. */
  async allInvoices(): Promise<InvoiceRow[]> {
    if (this.cachedBook) return this.cachedBook;
    const rows: InvoiceRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.json(
        `/invoices?page=${page}&itemsPerPage=100&${StornoClassificationPage.LIST_GROUP}&order%5Bid%5D=asc`,
      );
      const member = StornoClassificationPage.members(body);
      rows.push(...member.map(StornoClassificationPage.shape));
      if (member.length < 100) break;
    }
    this.cachedBook = rows;
    return rows;
  }

  /**
   * The three independent Storno signals as id sets: the RELATION (the new truth), the NUMBER PREFIX
   * (the old inference), and the serialized `invoiceType` (what the screens actually render).
   */
  async stornoSignals(): Promise<{ relational: Set<number>; prefix: Set<number>; serialized: Set<number> }> {
    const rows = await this.allInvoices();
    return {
      relational: new Set(rows.filter((r) => r.originalInvoiceId !== null).map((r) => r.id)),
      prefix: new Set(rows.filter((r) => r.invoiceNumber.startsWith('S')).map((r) => r.id)),
      serialized: new Set(rows.filter((r) => r.invoiceType === 'storno').map((r) => r.id)),
    };
  }

  /**
   * The DATEV state of one invoice (RC 3.12 #3502).
   *
   * `datevSyncedAt` and `datevSyncStatus` are **omitted from the payload until an invoice is
   * actually pushed** (#3440), so "never pushed" reads as `undefined`, never `null` — and
   * `datevSyncAttempts` is a FAILURE counter, so 0 means "no failures", not "no push".
   */
  async datevState(invoiceId: number): Promise<{
    status: string;
    amount: number | null;
    syncedAt: string | null;
    syncStatus: string | null;
    attempts: number;
    originalInvoiceId: number | null;
  }> {
    const invoice = await this.json(`/invoices/${invoiceId}`);
    const original = invoice.originalInvoice
      ? Number(String(invoice.originalInvoice['@id'] ?? invoice.originalInvoice).split('/').pop())
      : null;
    return {
      status: String(invoice.status ?? ''),
      amount: invoice.invoiceAmount ?? null,
      syncedAt: invoice.datevSyncedAt ?? null,
      syncStatus: invoice.datevSyncStatus ?? null,
      attempts: invoice.datevSyncAttempts ?? 0,
      originalInvoiceId: original,
    };
  }

  /**
   * Every cancelled original paired with the Storno that reverses it, both sides' DATEV state, and
   * the billing entity — which is what separates AC5's "held because the entity is not activated"
   * from a genuine failure.
   *
   * The pairing is RELATIONAL (`originalInvoice`), not by number prefix — #3449 made the relation
   * authoritative, and a Storno's own number tells you nothing about which invoice it reverses.
   */
  async cancelledPairs(): Promise<
    {
      original: { id: number; number: string; amount: number | null; syncedAt: string | null; attempts: number };
      storno: { id: number; number: string; amount: number | null; syncedAt: string | null } | null;
      entity: string | null;
    }[]
  > {
    const book = await this.allInvoices();
    const cancelled = book.filter((row) => 'cancelled' === row.status);
    const stornos = book.filter((row) => 'storno' === row.invoiceType);

    const stornoOriginals = new Map<number, InvoiceRow>();
    for (const storno of stornos) {
      const state = await this.datevState(storno.id);
      if (state.originalInvoiceId !== null) stornoOriginals.set(state.originalInvoiceId, storno);
    }

    const pairs = [];
    for (const row of cancelled) {
      const originalState = await this.datevState(row.id);
      const storno = stornoOriginals.get(row.id) ?? null;
      const stornoState = storno ? await this.datevState(storno.id) : null;
      let entity: string | null = null;
      if (row.prescriptionIri) {
        const prescription = await this.json(`${row.prescriptionIri.replace(StornoClassificationPage.API, '')}`);
        entity = prescription.entity?.name ?? null;
      }
      pairs.push({
        original: {
          id: row.id,
          number: row.invoiceNumber,
          amount: originalState.amount,
          syncedAt: originalState.syncedAt,
          attempts: originalState.attempts,
        },
        storno: storno
          ? { id: storno.id, number: storno.invoiceNumber, amount: stornoState!.amount, syncedAt: stornoState!.syncedAt }
          : null,
        entity,
      });
    }
    return pairs;
  }

  /** The Storniert register — invoice-rooted, cancelled originals only, Stornos excluded (#3427). */
  async cancelledRegister(): Promise<InvoiceRow[]> {
    const body = await this.json(
      `/invoices?page=1&itemsPerPage=200&cancelledRegister=true&${StornoClassificationPage.LIST_GROUP}&order%5Bid%5D=asc`,
    );
    return StornoClassificationPage.members(body).map(StornoClassificationPage.shape);
  }

  /** One VO's billing view: `getActiveInvoice()` plus `getCancelledInvoices()`. */
  async voBilling(prescriptionId: number): Promise<VoBilling> {
    const body = await this.json(`/prescriptions/${prescriptionId}?groups%5B%5D=billing%3Aread`);
    return {
      id: body.id,
      number: body.prescriptionId,
      activeInvoiceId: body.invoice?.id ?? null,
      activeInvoiceNumber: body.invoice?.invoiceNumber ?? null,
      cancelledInvoiceIds: (body.cancelledInvoices ?? []).map((invoice: { id: number }) => invoice.id),
    };
  }

  /** The prescriptions that carry at least one Storno, by numeric id. */
  async prescriptionsWithAStorno(): Promise<number[]> {
    const rows = await this.allInvoices();
    const ids = rows
      .filter((r) => r.originalInvoiceId !== null && r.prescriptionIri)
      .map((r) => Number(r.prescriptionIri!.split('/').pop()));
    return [...new Set(ids)];
  }

  /**
   * The whole book ordered by the "Art" column. `order[type]` — see the class docs before changing
   * that key.
   */
  async orderedByType(direction: 'asc' | 'desc'): Promise<InvoiceRow[]> {
    const rows: InvoiceRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = await this.json(
        `/invoices?page=${page}&itemsPerPage=100&${StornoClassificationPage.LIST_GROUP}&order%5Btype%5D=${direction}`,
      );
      const member = StornoClassificationPage.members(body);
      rows.push(...member.map(StornoClassificationPage.shape));
      if (member.length < 100) break;
    }
    return rows;
  }

  /** Positions where the serialized type breaks the order the DQL claims to have imposed. */
  static monotonicityViolations(rows: InvoiceRow[], direction: 'asc' | 'desc'): string[] {
    const out: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const previous = TYPE_RANK[rows[i - 1].invoiceType];
      const current = TYPE_RANK[rows[i].invoiceType];
      const ordered = direction === 'asc' ? current >= previous : current <= previous;
      if (!ordered) {
        out.push(`#${i}: ${rows[i - 1].invoiceNumber}(${rows[i - 1].invoiceType}) then ${rows[i].invoiceNumber}(${rows[i].invoiceType})`);
      }
    }
    return out;
  }

  /**
   * Invoices the legacy-PKV DATEV finder would select on its NUMBER rule alone
   * (`NOT LIKE 'R%' AND NOT LIKE 'S%'`) — the one reader #3451 left on the prefix.
   */
  async legacyFinderCandidates(): Promise<InvoiceRow[]> {
    const rows = await this.allInvoices();
    return rows.filter((r) => r.invoiceNumber !== '' && !r.invoiceNumber.startsWith('R') && !r.invoiceNumber.startsWith('S'));
  }
}
