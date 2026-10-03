# #3796 — ready-for-billing for private VOs: what still needs a person

`tests/Staging/SuperAdmin/sa_ready_billing_private.spec.ts` verifies all six ACs
**read-only**, by reading the footprint the PM's 3 Oct run left on staging. This file
records what that cannot cover, and why the suite creates nothing.

## Why nothing is written

Almost every AC here is about **creating an invoice**. An invoice consumes a number that
is never released, and cancelling one leaves a `cancelled` row behind permanently
(#3449). So the suite creates none — it does not need to, because each of the PM's
fixtures carries a dated, attributable record:

| AC | How the suite settles it without writing |
|---|---|
| AC1 | The tile is a pure data predicate: 158 PKV/Privat Basis VOs hold a live invoice and **none** is listed; the 44 private rows that are listed hold none |
| AC2 | `invoice_logs.meta.type` (#3426) separates all three routes — see below |
| AC3, AC5 row 3 | Four zero-session VOs across three statuses hold **0** invoices |
| AC5 rows 1+2 | Two invoices exist that the **pre-fix check could not have produced** |
| AC6 | One save's `batchId` carries both changes; the VO holds one invoice, created later, with a consecutive number |
| AC4 | An expired validated GKV VO with sessions holds no copayment invoice |

## The provenance flag is what makes AC2 readable

`invoice_created` carries `meta.type`, so whether a human asked for an invoice is a fact:

| Footprint | AC2 row |
|---|---|
| `automatic`, same second as a validation while the VO was **already** Abgelaufen | row 1 — validated while expired |
| the `treatment_expired` entry has **no** invoice beside it | row 2 — the expiry creates nothing |
| `manual`, hours after the expiry | row 3 — an admin clicked "Rechnung erstellen" |

Measured on 99816-1 (expired 02 Oct 20:02:51 → validated 03 Oct 00:26:56 → `R126-139`
**automatic at that same second**) against 99815-1 (validated *before* its expiry →
nothing at the expiry → `R126-136` **manual** four hours later).

## AC5 is proven by two invoices that could not have existed

Stronger than watching a check pass. The old guard priced the VO's **prescribed**
Heilmittel at the **PKV** tariff:

- **99978-1** is Privat Basis on **BGM**, which has *no PKV price* → old check 0,00 € →
  refused on every route. It now holds `R126-141` at **51,96 €** (2 × 25,98 €).
- **99979-1** is a Privat Basis **Blanko** VO with **0 prescribed units**, so the old
  check gave 0,00 € under *either* tariff. It now holds `R126-142` at **59,26 €**.

## What a person still has to do

Everything below creates an invoice, so it is left for a human who has first confirmed
the staging safety controls the Testing Guidance names (**DATEV transfer switch off,
every Gesellschaft on test Mandant 9999, the staging email redirect on**) — the PM
re-confirmed these before *each* invoicing step, which is the right cadence.

1. **AC2 row 1 on a fresh VO.** The existing fixtures are now invoiced, so build one:
   PKV or Privat Basis, KG, 6 units, 2 carried-out sessions with the first more than
   three months ago, not validated, no invoice. Let the nightly check (20:00 UTC) expire
   it, then validate it → invoice in *Nicht gesendet*, VO stays Abgelaufen.
2. **AC2 row 2** needs the nightly run on a VO validated beforehand. The Need Command
   (`app:prescription:expire`, `--dry-run` first) only saves waiting for 20:00 UTC.
   **Use a non-Blanko VO**: a Blanko VO past its 16 weeks goes to *Fertig Behandelt*,
   not *Abgelaufen*, and a validated VO turning Fertig Behandelt is invoiced in the same
   run — which would look like the expiry having created an invoice.
3. **AC5 rows 1+2 on fresh VOs**, if you want to watch the creation rather than read it.
4. **AC6 in one save** needs a **Super Admin**: a regular Admin cannot validate on the VO
   edit form, so the two changes cannot be made in one save as an Admin.

## Traps

- **Absence from the tile is not evidence by itself.** #3775's population is
  `Fertig Behandelt | Abgebrochen | Abgelaufen`, ≥1 signed session, **in no billing
  batch**. Two cancelled-only VOs (5714-3, 3277-4) are off the tile because they are
  batched, and the GKV control **99977-1 left the tile when validating put it in batch
  63** — which is exactly what the PM recorded under AC-4, having seen it listed
  beforehand. Exclude those reasons before reading an absence as this ticket's doing.
- **A Storno is not a live invoice.** Exclude `cancelled`, and exclude the reversal by
  its relation rather than only by its `S` prefix (#3449).
- **The signed-session predicate reads `rejectedTreatment` /
  `rejectedTreatmentWithSignature`**; the short names do not exist on an Activity, so a
  predicate built on them excludes nothing (#3649, #3814).
- **Ask the invoice book, not the VO book.** The converse of AC1 is one walk of 622
  invoices — each row embeds its VO with `insuranceType` — where a per-VO walk of the
  ~1,300 PKV VOs did not finish in two minutes.
- On `/invoices` the per-VO key is the **bare `prescription=`**; `prescription.id=` is
  silently ignored and returns the whole book. The opposite holds on
  `/prescription_billing_batches` (#3821).

## Known, outside this ticket

**Privat Basis invoices are never sent to DATEV and their payments are never picked up**
— both daily jobs select GKV and PKV only. The development team raised it while building
this ticket; the PM split it to **#3818**, shipping with #3796. Worth confirming #3818
is on the same build before the production run, since this ticket increases the number
of Privat Basis invoices.
