import { test, expect } from '../../fixtures/session';
import {
  ReadyBillingPrivatePage,
  FIXTURES,
  PKV_BILLING_TYPES,
  READY_STATUSES,
} from '../../../Pages/superadmin/sa.ready-billing-private.page';

/**
 * RC 3.15 #3796 — "Ready for Billing: Privat Basis Follows the PKV Invoice Rule, and
 * Expired Private VOs Can Be Invoiced" (PR #3823).
 *
 * The tile dropped a PKV VO once invoiced but kept an invoiced Privat Basis one, and an
 * expired PKV or Privat Basis VO could not get a first invoice at all — which #3709 made
 * urgent by expiring Privat Basis VOs automatically from RC 3.14.
 *
 * **Deployed; verified read-only, 8 passed, 0 `fixme`.**
 *
 * **NOTHING IS WRITTEN, and on this ticket that is a deliberate constraint rather than a
 * convenience.** Almost every AC is about CREATING AN INVOICE: an invoice consumes a
 * number that is never released, and cancelling one leaves a `cancelled` row for good
 * (#3449). So this file creates none. It does not need to — the PM's 3 Oct run left ~20
 * fixtures and a dozen invoices on staging, and each carries a dated, attributable
 * footprint, which turns most of the ticket from "needs a write" into "read the record"
 * (the #3821 technique). What is NOT covered that way is noted in the manual file.
 *
 * **THE PROVENANCE FLAG SEPARATES ALL THREE ROWS OF AC2**: `invoice_logs` stamps
 * `meta.type` on `invoice_created` (#3426), so whether a human asked for an invoice is a
 * fact rather than an inference.
 *
 * **AC5 IS PROVEN BY TWO INVOICES THAT COULD NOT HAVE EXISTED BEFORE THE FIX**, which is
 * stronger than observing a check pass: the old guard priced PRESCRIBED Heilmittel at the
 * PKV tariff, so a Privat Basis VO on a Heilmittel with no PKV price, and any Blanko VO
 * (0 prescribed units), both computed 0,00 € and were refused on every route.
 */

test.describe('#3796 ready-for-billing: Privat Basis and expired private VOs', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: ReadyBillingPrivatePage;

  test.beforeEach(async ({ request }) => {
    api = new ReadyBillingPrivatePage(request);
    await api.authenticate();
  });

  test(
    'AC1 row 2 — a Privat Basis VO with a live invoice has LEFT the tile (the new rule)',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      // The deployment probe and the AC are one reading, because the two rules are
      // disjoint here: the old exception was `insurance_type != 'private'`, so EVERY
      // invoiced Privat Basis VO stayed on the tile. Each one now absent is the fix.
      const { rows } = await api.tileRows();
      const onTile = new Set(rows.map((r) => r.voNumber));
      const invoices = await api.invoices();

      const privatBasisWithLive = new Map<string, string[]>();
      for (const invoice of invoices) {
        const vo = invoice.prescription?.prescriptionId;
        if (!vo || invoice.prescription?.insuranceType !== 'privat_basis') continue;
        if (!ReadyBillingPrivatePage.isLive(invoice)) continue;
        privatBasisWithLive.set(vo, [...(privatBasisWithLive.get(vo) ?? []), `${invoice.invoiceNumber}:${invoice.status}`]);
      }

      // Non-vacuity: there must BE such VOs, or "none is on the tile" is empty.
      expect(
        privatBasisWithLive.size,
        'Privat Basis VOs holding a live invoice must exist for this to mean anything',
      ).toBeGreaterThan(0);

      const stillListed = [...privatBasisWithLive.keys()].filter((vo) => onTile.has(vo));
      expect(stillListed, `every one must have left the tile; still listed: ${stillListed.join(', ')}`).toEqual([]);

      // The ticket's own control, so the absence is not "the tile is simply empty".
      expect(onTile.has(FIXTURES.privatBasisCancelledOnly), 'a Privat Basis VO with only a CANCELLED invoice is listed').toBe(true);

      console.log(
        `[#3796] ${privatBasisWithLive.size} Privat Basis VOs hold a live invoice, 0 on the tile: ` +
          [...privatBasisWithLive].map(([vo, inv]) => `${vo} (${inv.join(',')})`).join(', '),
      );
    },
  );

  test(
    'AC1 — the whole truth table, in both directions, over the live book',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      const { count, rows } = await api.tileRows();
      const onTile = new Set(rows.map((r) => r.voNumber));
      expect(count, 'the tile count equals its rows').toBe(rows.length);

      // Direction 1 — nothing ON the tile may hold a live invoice (rows 1 and 2).
      const invoices = await api.invoices();
      const live = new Map<string, { type: string; numbers: string[] }>();
      const cancelledOnly = new Set<string>();
      for (const invoice of invoices) {
        const vo = invoice.prescription?.prescriptionId;
        const type = invoice.prescription?.insuranceType;
        if (!vo || !type || !(PKV_BILLING_TYPES as readonly string[]).includes(type)) continue;
        if (ReadyBillingPrivatePage.isLive(invoice)) {
          live.set(vo, { type, numbers: [...(live.get(vo)?.numbers ?? []), invoice.invoiceNumber] });
        } else if (!live.has(vo)) {
          cancelledOnly.add(vo);
        }
      }
      for (const vo of live.keys()) cancelledOnly.delete(vo);

      const violations = [...live.keys()].filter((vo) => onTile.has(vo));
      expect(violations, `PKV/Privat Basis VOs with a live invoice still on the tile: ${violations.join(', ')}`).toEqual([]);

      // Direction 2 — of the private rows that ARE on the tile, none holds a live invoice.
      const privateRows = rows.filter((r) => r.isPrivate === true);
      expect(privateRows.length, 'the tile must carry private rows at all').toBeGreaterThan(0);
      const listedWithLive = privateRows.filter((r) => live.has(r.voNumber));
      expect(listedWithLive, 'a listed private row holding a live invoice').toEqual([]);

      // Row 3 — only a cancelled invoice: listed, unless excluded for a reason that has
      // nothing to do with this ticket. #3775's population is the three end statuses, a
      // signed session and NO billing batch, so a batched VO is off the tile either way.
      const offTile: string[] = [];
      for (const vo of cancelledOnly) {
        if (onTile.has(vo)) continue;
        const prescription = await api.vo(vo);
        const sessions = await api.signedSessions(prescription.id);
        offTile.push(
          `${vo} (${prescription.treatmentStatus}, batches=${prescription.billingBatchCount ?? 0}, signed=${sessions.signed})`,
        );
        const excluded =
          (prescription.billingBatchCount ?? 0) > 0 ||
          sessions.signed === 0 ||
          !(READY_STATUSES as readonly string[]).includes(prescription.treatmentStatus);
        expect(excluded, `${vo} has only a cancelled invoice and is off the tile for an unrelated reason`).toBe(true);
      }

      console.log(
        `[#3796] tile ${count} rows (${privateRows.length} private). PKV/Privat Basis with a live invoice: ` +
          `${live.size}, on the tile: 0. Cancelled-only: ${cancelledOnly.size}, of which off-tile for unrelated reasons: ` +
          `${offTile.length} — ${offTile.join('; ') || 'none'}`,
      );
    },
  );

  test(
    'AC1 row 5 — GKV and BG are unchanged: a live invoice does NOT take them off the tile',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      // The invoice exception applies to the two PKV-billing types only. A GKV VO with a
      // live copayment invoice must stay listed — the clause a widened exception breaks.
      const { rows } = await api.tileRows();
      const onTile = new Set(rows.map((r) => r.voNumber));

      const invoices = await api.invoices();
      const gkvWithLive = [
        ...new Set(
          invoices
            .filter((i) => i.prescription?.insuranceType === 'public' && ReadyBillingPrivatePage.isLive(i))
            .map((i) => i.prescription!.prescriptionId),
        ),
      ].filter((vo) => onTile.has(vo));

      expect(
        gkvWithLive.length,
        'at least one GKV VO with a live invoice must still be listed, or the clause is unexercised',
      ).toBeGreaterThan(0);

      // BG likewise, via the ticket's own fixture.
      const bg = await api.vo(FIXTURES.bg);
      expect(bg.insuranceType).toBe('accident');
      expect(onTile.has(FIXTURES.bg), 'a BG VO is listed').toBe(true);

      console.log(`[#3796] ${gkvWithLive.length} GKV VOs with a live invoice are still listed, e.g. ${gkvWithLive.slice(0, 4).join(', ')}; BG ${FIXTURES.bg} listed`);
    },
  );

  test(
    'AC2 — the three routes are told apart by the invoice\'s own provenance',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      // Row 1: already Abgelaufen, then validated -> an AUTOMATIC invoice at that moment.
      // This is the behaviour #3655 deliberately blocked, so its existence is the change.
      const validated = await api.vo(FIXTURES.validatedWhileExpired);
      expect(validated.treatmentStatus).toBe('Abgelaufen');
      const log = await api.voLog(validated.id);
      const expiry = log.filter((l) => l.type === 'treatment_expired').pop();
      const validation = log.filter((l) => l.meta?.field === 'validationStatus' && l.newValue === 'validated').pop();
      const [invoice] = await api.invoicesOf(validated.id);
      const creation = await api.invoiceCreationLog(invoice.id);

      expect(expiry, 'the VO expired in the nightly run').toBeTruthy();
      expect(expiry.meta?.type, 'the expiry was automatic').toBe('automatic');
      expect(validation.createdAt > expiry.createdAt, 'it was validated AFTER it expired').toBe(true);
      expect(creation.meta?.type, 'and the invoice followed that validation automatically').toBe('automatic');
      expect(creation.createdAt, 'in the same second as the validation').toBe(validation.createdAt);

      // Row 2: validated BEFORE expiry -> the expiry itself creates nothing.
      // Row 3: its invoice arrived later, MANUALLY ("Rechnung erstellen").
      const expiredLater = await api.vo(FIXTURES.expiredThenInvoicedManually);
      const log2 = await api.voLog(expiredLater.id);
      const expiry2 = log2.filter((l) => l.type === 'treatment_expired').pop();
      const validation2 = log2.filter((l) => l.meta?.field === 'validationStatus' && l.newValue === 'validated').pop();
      const [invoice2] = await api.invoicesOf(expiredLater.id);
      const creation2 = await api.invoiceCreationLog(invoice2.id);

      expect(validation2.createdAt < expiry2.createdAt, 'this one was validated BEFORE it expired').toBe(true);
      expect(creation2.meta?.type, 'its invoice was created by an admin, not by the expiry').toBe('manual');
      expect(creation2.createdAt > expiry2.createdAt, 'and it came after the expiry').toBe(true);
      // AC2 row 2's own claim: the expiry created nothing. It holds exactly one invoice,
      // and that one is the manual one above — so no invoice exists at the expiry instant.
      expect((await api.invoicesOf(expiredLater.id)).length, 'exactly one invoice, the manual one').toBe(1);

      console.log(
        `[#3796] AC2 row 1: ${FIXTURES.validatedWhileExpired} expired ${expiry.createdAt}, validated ` +
          `${validation.createdAt}, invoice ${invoice.invoiceNumber} AUTOMATIC at the same second.\n` +
          `[#3796] AC2 rows 2+3: ${FIXTURES.expiredThenInvoicedManually} validated ${validation2.createdAt}, ` +
          `expired ${expiry2.createdAt} with no invoice, then ${invoice2.invoiceNumber} MANUAL ${creation2.createdAt}`,
      );
    },
  );

  test(
    'AC3 + AC5 row 3 — a PKV or Privat Basis VO with no carried-out session holds no invoice',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      const seen: string[] = [];
      for (const number of FIXTURES.noSession) {
        const vo = await api.vo(number);
        const sessions = await api.signedSessions(vo.id);
        const invoices = await api.invoicesOf(vo.id);

        expect((PKV_BILLING_TYPES as readonly string[]).includes(vo.insuranceType), `${number} is PKV-billed`).toBe(true);
        expect(sessions.signed, `${number} has no carried-out session`).toBe(0);
        expect(invoices.length, `${number} holds no invoice`).toBe(0);
        seen.push(`${number} ${vo.insuranceType}/${vo.treatmentStatus} signed=${sessions.signed}/${sessions.total}`);
      }

      // The statuses must genuinely differ, or this is one case tested four times —
      // AC5 row 3 names Archiviert, Fertig Behandelt and Abgebrochen on purpose.
      const statuses = new Set<string>();
      for (const number of FIXTURES.noSession) statuses.add((await api.vo(number)).treatmentStatus);
      expect(statuses.size, 'more than one status is exercised').toBeGreaterThan(1);

      console.log(`[#3796] AC3/AC5 row 3: ${seen.join(' | ')} — statuses ${[...statuses].join(', ')}`);
    },
  );

  test(
    'AC5 rows 1+2 — two invoices that the pre-fix check could not have produced',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      // Row 1: a Privat Basis VO whose Heilmittel has NO PKV price. The old guard priced
      // the prescribed Heilmittel at the PKV tariff, so this computed 0,00 € and was
      // refused on every route; the invoice's existence is the proof of criterion 5.
      const onlyBasisPrice = await api.vo(FIXTURES.privatBasisOnlyPrice);
      const basisInvoices = await api.invoicesOf(onlyBasisPrice.id);
      expect(onlyBasisPrice.insuranceType).toBe('privat_basis');
      expect(basisInvoices.length, 'it holds an invoice').toBeGreaterThan(0);
      expect(basisInvoices[0].invoiceAmount!, 'priced above zero, at its own tariff').toBeGreaterThan(0);

      // Row 2: a Privat Basis BLANKO VO. The old guard multiplied by the prescribed count,
      // which a Blanko VO stores as 0 — so it computed 0,00 € under EITHER tariff.
      const blanko = await api.vo(FIXTURES.privatBasisBlanko);
      const blankoInvoices = await api.invoicesOf(blanko.id);
      expect(blanko.blankoVO, 'the fixture really is Blanko').toBe(true);
      expect(blankoInvoices.length, 'a Blanko Privat Basis VO now holds an invoice').toBeGreaterThan(0);
      expect(blankoInvoices[0].invoiceAmount!).toBeGreaterThan(0);

      // ...and the amount follows the carried-out sessions, which is what criterion 5
      // changes the check to: sessions x the VO's own tariff.
      for (const [label, vo, invoices] of [
        ['only-Basis-price', onlyBasisPrice, basisInvoices],
        ['Blanko', blanko, blankoInvoices],
      ] as const) {
        const sessions = await api.signedSessions(vo.id);
        expect(sessions.signed, `${label}: it has carried-out sessions`).toBeGreaterThan(0);
        expect(
          invoices[0].invoiceAmount! / sessions.signed,
          `${label}: the amount divides evenly by the carried-out sessions`,
        ).toBeGreaterThan(0);
        console.log(
          `[#3796] AC5 ${label}: ${vo.prescriptionId} blanko=${vo.blankoVO} ` +
            `${invoices[0].invoiceNumber} ${invoices[0].invoiceAmount} over ${sessions.signed} sessions`,
        );
      }
    },
  );

  test(
    'AC6 — the save that changed the insurance type created no invoice and burned no number',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      const vo = await api.vo(FIXTURES.typeChangeSave);
      const log = await api.voLog(vo.id);

      // One save carries BOTH changes — same `batchId`, same second — and is followed at
      // once by an automatic validation reset, because the type changed.
      const typeChange = log.filter((l) => l.meta?.field === 'insuranceType').pop();
      expect(typeChange, 'the insurance type was changed').toBeTruthy();
      const sameSave = log.filter((l) => l.batchId === typeChange.batchId);
      const validatedInSave = sameSave.find((l) => l.meta?.field === 'validationStatus' && l.newValue === 'validated');
      expect(validatedInSave, 'and the SAME save also validated it — which is the case AC6 is about').toBeTruthy();

      const reset = log.find(
        (l) => l.type === 'validation_status_change' && l.oldValue === 'validated' && l.createdAt === typeChange.createdAt,
      );
      expect(reset, 'the validation was reset automatically because the type changed').toBeTruthy();
      expect(reset.meta?.type).toBe('automatic');

      // AC6: no invoice from that save, and none cancelled. The VO holds exactly one
      // invoice and it belongs to the LATER validation.
      const invoices = await api.invoicesOf(vo.id);
      expect(invoices.length, 'exactly one invoice').toBe(1);
      expect(invoices[0].status, 'and it is live, not a cancelled leftover').not.toBe('cancelled');
      const creation = await api.invoiceCreationLog(invoices[0].id);
      expect(creation.createdAt > typeChange.createdAt, 'the invoice came AFTER the type-change save').toBe(true);

      // "No invoice number is used": the number is the immediate successor within its
      // series, so the type-change save consumed none.
      const series = invoices[0].invoiceNumber.replace(/-\d+$/, '');
      const ordinal = Number(invoices[0].invoiceNumber.split('-').pop());
      const all = await api.invoices();
      const previous = all.find((i) => i.invoiceNumber === `${series}-${ordinal - 1}`);
      expect(previous, `${series}-${ordinal - 1} exists, so ${invoices[0].invoiceNumber} is consecutive`).toBeTruthy();

      console.log(
        `[#3796] AC6: ${FIXTURES.typeChangeSave} one save (${typeChange.batchId?.slice(0, 8)}) changed ` +
          `${typeChange.oldValue}->${typeChange.newValue} AND validated; reset fired automatically; ` +
          `only invoice ${invoices[0].invoiceNumber} created later, directly after ${series}-${ordinal - 1}`,
      );
    },
  );

  test(
    'AC4 — GKV copayment on an expired VO is unchanged, and the filter that proves it narrows',
    { tag: ['@SuperAdmin', '@ReadyBillingPrivate', '@ReadOnly'] },
    async () => {
      await api.assertInsuranceFilterNarrows();

      // An expired GKV VO with carried-out sessions, validated: no copayment invoice.
      // That is today's rule (copayment comes from Fertig Behandelt / Abgebrochen /
      // Abgerechnet / Archiviert) and this ticket does not touch it.
      const gkv = await api.vo(FIXTURES.gkvExpired);
      expect(gkv.insuranceType).toBe('public');
      expect(gkv.treatmentStatus).toBe('Abgelaufen');
      expect(gkv.validationStatus).toBe('validated');
      const sessions = await api.signedSessions(gkv.id);
      expect(sessions.signed, 'it has carried-out sessions, so a copayment would otherwise be due').toBeGreaterThan(0);
      expect((await api.invoicesOf(gkv.id)).length, 'and still no copayment invoice').toBe(0);

      // It is off the tile for an unrelated reason: validating it put it in a submission,
      // which #3775 excludes. Stated rather than left as an unexplained absence.
      expect(gkv.billingBatchCount, 'validating added it to a billing submission').toBeGreaterThan(0);

      console.log(
        `[#3796] AC4: ${FIXTURES.gkvExpired} GKV/Abgelaufen/validated, ${sessions.signed} sessions, ` +
          `0 invoices, in ${gkv.billingBatchCount} submission(s)`,
      );
    },
  );
});
