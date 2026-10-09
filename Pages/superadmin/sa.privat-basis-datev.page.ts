import { APIRequestContext } from '@playwright/test';
import { STAGING_CREDENTIALS, type Credentials } from '../util/api-token';

/**
 * RC 3.15 #3818 (PR #3839, merge `715d0f5b3`): the nightly DATEV transfer and payment pull select
 * Privat Basis invoices like PKV ones. The whole change is the VO type list of three
 * `InvoiceRepository` finders — `['public','private']` → `InsuranceTypeEnum::datevSyncableValues()`
 * (GKV + `pkvBillingValues()`).
 *
 * The jobs are console-only and DATEV is OFF on staging, so the transfer runs only as a preview the
 * dev team triggers and the pull not at all. What a client CAN do is port the finders exactly and
 * re-run them over the whole invoice book under BOTH type lists: the new-minus-old difference is
 * the ticket, and on 2026-10-06 it reproduced the dev team's own preview to the invoice
 * (Gesellschaft 1: 24 = 4 Privat Basis + 19 PKV + 1 Storno).
 *
 * Joining is the work: the invoice embeds its VO's `insuranceType` but NOT its Gesellschaft, so VOs
 * are read in `id[]` batches; `originalInvoiceId` is in `invoice-list:read` only and
 * `datevSyncStatus`/`datevSyncedAt` in the default group only, both OMITTED when null (#3604).
 */
export const OLD_TYPES = ['public', 'private'];
export const NEW_TYPES = ['public', 'private', 'privat_basis'];
const SYNCABLE = ['sent', 'overdue', 'sent_to_optica', 'reminded', 'to_send_to_dc', 'sent_to_dc', 'paid', 'on_hold'];

export type Inv = {
  id: number; invoiceNumber: string | null; status: string; voId: number; entity: number; type: string | null;
  originalId: number | null; datevSyncStatus: string | null; datevSyncedAt: string | null;
};
export type Picked = { inv: Inv; kind: 'invoice' | 'cancelled-with-storno' | 'storno' };

export class PrivatBasisDatevPage {
  private token = '';
  constructor(private request: APIRequestContext, readonly api = 'https://api.staging.therapios.de') {}

  async init(c: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    const r = await this.request.post(`${this.api}/auth`, {
      headers: { 'Content-Type': 'application/json' }, data: { username: c.email, password: c.password }, timeout: 120_000,
    });
    if (!r.ok()) throw new Error(`POST /auth -> ${r.status()}`);
    this.token = (await r.json()).token;
  }

  async get(path: string): Promise<any> {
    for (let i = 0; i < 4; i++) {
      const r = await this.request.get(`${this.api}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' }, timeout: 240_000,
      }).catch(() => null);
      if (r?.ok()) return r.json();
      if (r && r.status() < 500) throw new Error(`GET ${path} -> ${r.status()}`);
      await new Promise((res) => setTimeout(res, 3_000 * (i + 1)));
    }
    throw new Error(`GET ${path} failed`);
  }

  private async walk(path: string): Promise<any[]> {
    const out: any[] = [];
    let total = Infinity;
    for (let p = 1; out.length < total; p++) {
      const b = await this.get(`${path}${path.includes('?') ? '&' : '?'}page=${p}&itemsPerPage=100`);
      total = b.totalItems ?? 0;
      if (!b.member?.length) break;
      out.push(...b.member);
    }
    if (out.length < total) throw new Error(`${path}: read ${out.length} of ${total}`);
    return out;
  }

  /** The whole invoice book, joined to each VO's insurance type and Gesellschaft. */
  async book(): Promise<Inv[]> {
    const base = await this.walk('/invoices');
    const list = new Map((await this.walk('/invoices?groups[]=invoice-list:read')).map((x) => [x.id, x]));
    const voOf = (x: any) => Number(String(x?.['@id'] ?? x).match(/prescriptions\/(\d+)/)?.[1]);
    const ids = [...new Set(base.map((i) => voOf(i.prescription)).filter(Boolean))];
    const vos = new Map<number, { entity: number; type: string | null }>();
    for (let k = 0; k < ids.length; k += 50) {
      const b = await this.get(`/prescriptions?itemsPerPage=50&${ids.slice(k, k + 50).map((x) => `id[]=${x}`).join('&')}`);
      for (const v of b.member) vos.set(v.id, { entity: Number(String(v.entity?.['@id'] ?? v.entity ?? '').match(/(\d+)$/)?.[1]), type: v.insuranceType ?? null });
    }
    if (vos.size !== ids.length) throw new Error(`read ${vos.size} of ${ids.length} VOs`);
    return base.map((i) => {
      const l = list.get(i.id) ?? {};
      const v = vos.get(voOf(i.prescription))!;
      return {
        id: i.id, invoiceNumber: i.invoiceNumber ?? null, status: i.status, voId: voOf(i.prescription),
        entity: v.entity, type: v.type, originalId: l.originalInvoiceId ?? null,
        datevSyncStatus: i.datevSyncStatus ?? null, datevSyncedAt: i.datevSyncedAt ?? null,
      };
    });
  }

  /** `findPendingDatevSync()` + `findPendingStornoDatevSync()`, ported, for one Gesellschaft. */
  static transfer(book: Inv[], entity: number, types: string[]): Picked[] {
    const byId = new Map(book.map((i) => [i.id, i]));
    const reversed = new Set(book.filter((i) => i.originalId).map((i) => i.originalId));
    const pending = (i: Inv) => i.datevSyncStatus === null || i.datevSyncStatus === 'failed';
    const out: Picked[] = [];
    for (const i of book) {
      if (i.entity !== entity || !types.includes(i.type ?? '') || !i.invoiceNumber || !pending(i)) continue;
      if (i.originalId) {
        if (byId.get(i.originalId)?.datevSyncedAt) out.push({ inv: i, kind: 'storno' });
        continue;
      }
      if (i.status !== 'cancelled' && SYNCABLE.includes(i.status) && i.invoiceNumber.startsWith('R')) out.push({ inv: i, kind: 'invoice' });
      else if (i.status === 'cancelled' && reversed.has(i.id)) out.push({ inv: i, kind: 'cancelled-with-storno' });
    }
    return out;
  }

  /** `findUnpaidForPaymentMatching()`, ported. */
  static unpaidForMatching(book: Inv[], entity: number, types: string[]): Inv[] {
    return book.filter((i) => i.entity === entity && types.includes(i.type ?? '') && !!i.invoiceNumber
      && !['paid', 'cancelled'].includes(i.status) && (i.invoiceNumber!.startsWith('R') || i.datevSyncStatus === 'synced'));
  }

  async datevEnabledEntities(): Promise<any[]> {
    return (await this.get('/entities?itemsPerPage=50')).member.filter((e: any) => e.datevEnabled === true);
  }
}
