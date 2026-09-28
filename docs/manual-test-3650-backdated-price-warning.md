# Manual test — #3650 Back-dated price entry: warning + draft refresh

**Environment:** staging · **Role:** Super Admin (`sa.jhen@gmail.com`) — the price dialog needs
`ROLE_SUPER_ADMIN` to save and `ROLE_ADMIN` for the warning.
**Verified against staging on 2026-09-14.** All figures below were read live; re-read them before you
start, because other people's test runs move them.

---

## Before you begin: what makes this ticket easy to get wrong

1. **Only a BACK-DATED entry warns.** Effective today or in the future → no dialog, by design (AC4).
   If you pick today's date you will conclude the feature is missing.
2. **The price must actually move the invoice.** Saving a back-dated entry at the price already in
   force → no dialog (AC4). Verified: KG PRIVAT back-dated at 39,00 (its current price) → 0 affected.
3. **`Tarif` is not the insurance type.** The dialog works per tariff — GKV / PRIVAT / PRIVAT_BASIS /
   BEIHILFE / BG. A back-dated PRIVAT entry does not touch copayment invoices and vice versa.
4. **The warning is a rehearsal, not a simulation.** It inserts the candidate price row, runs the
   real recalculation, reads the amounts, and rolls everything back. So the numbers it shows are the
   numbers a save would produce — but merely opening it changes nothing.

---

## Test A — the warning appears and lists the right invoices (AC1, AC2, AC3, AC6)

**Fixture: Heilmittel `KG`, tariff `GKV`, effective `2026-01-01`, price `34,00`.**
Current KG GKV price on that date is **29,63**. Expect **10 already-issued invoices** to be listed.

1. Log in as Super Admin → **Heilmittelverwaltung**.
2. Find **KG** and open its price/tariff entry dialog (the same one used for #3378 price entries).
3. Add a new entry: **Tarif = GKV**, **Gültig ab = 01.01.2026**, **Preis = 34,00**.
4. Press save.

**Expect the warning dialog** (mirrors the #3325 Zuzahlungsbefreiung overlap dialog):

- A table with four columns — **invoice number, invoice date, current amount, recomputed amount**.
- These rows, among 10 (read live 2026-09-14):

  | Invoice | VO | Date | Current | Recomputed |
  |---|---|---|---|---|
  | R426-68 | 7943-3 | 2026-07-29 | 35,62 | 38,26 |
  | R426-25 | 8202-2 | 2026-08-11 | 35,62 | 38,26 |
  | R526-50 | 7512-4 | 2026-07-20 | 35,62 | 38,26 |
  | R126-106 | 3300-4 | 2026-08-17 | 52,70 | **52,39** ← note this one goes DOWN |

- A message saying the listed invoices keep their current amount.
- **Both** `Abbrechen` and a save-anyway action (AC2 — it must never block).

5. **Press `Abbrechen`.** Nothing is saved; that is the whole of Test A.

**What you have proved:** AC1 (the four columns), AC2 (cancel is available), AC6 by construction
(the preflight writes nothing, so no issued invoice can have changed).

> **Check R126-106 specifically.** Its recomputed amount is *lower* than its current one. A warning
> that only ever shows increases would be wrong, and this row is the one that catches it.

---

## Test B — no warning when there is nothing to warn about (AC4)

Repeat Test A's steps 1–4 three times, changing only one field each time. **None** should show a
warning; the save should proceed exactly as it does today.

| Variation | Field to change | Expected |
|---|---|---|
| Not back-dated | Gültig ab = **today** | no dialog |
| Future-dated | Gültig ab = **01.01.2027** | no dialog |
| Price unchanged | Preis = **29,63** (the price already in force) | no dialog |

Cancel out of each rather than saving, unless you are continuing to Test C.

---

## Test C — the draft refresh (AC5) ⚠️ this one writes

**Only run this if you are willing to leave a price entry on staging, or to delete it afterwards.**

Use the same fixture: **KG / GKV / 01.01.2026 / 34,00**. KG is prescribed on **55 VOs that carry a
Not Sent copayment draft**, so this is the fixture that exercises AC5.

1. **First, record a "before" value.** Open **Zuzahlungsverwaltung** and note the amount on a Not
   Sent draft whose VO prescribes KG — for example **VO 8547-2, draft R426-67, 35,62 €**. (Confirm it
   is still Not Sent; other testers consume these.)
2. Run Test A through to the warning, then choose **save anyway**.
3. Re-open that draft. **Expect the amount to have refreshed** to the new price — the same in-place
   refresh used for session-driven changes. The invoice number must be unchanged.
4. Re-open one of the **issued** invoices from the warning table (e.g. R426-68). **Expect its amount
   to be unchanged** — 35,62, not 38,26 (AC6).

**To undo:** delete the price-history entry you created from the same dialog. That reverses the
recalculation of documented sessions (#3378 relies on this and it is exactly self-restoring). Note
that whether the DELETE also reverts the *draft* amount is not established — check the draft
afterwards and flag it if it stays at the new price.

---

## Test D — the statuses that are and are not warned about (AC3)

The AC's table says six statuses are included. Worth knowing before you read the dialog:

- **Included in practice: everything except `Nicht gesendet` and `Storniert`** — which is wider than
  the table. On staging the warning includes **R426-64, status `Pausiert` (on_hold)**, a status AC3
  never mentions. That is the implementation's choice, not a bug, but it will not match the table.
- **A `Nicht gesendet` invoice IS listed when it has already gone to DATEV.** Staging has exactly one
  — **R126-86** — and it appears in the PRIVAT warning. This is deliberate: the after-save draft
  refresh only covers drafts that have never synced, so a synced draft would otherwise be repriced
  with no warning at all.
- **Never listed:** cancelled invoices and Stornorechnungen.

To see both, run the warning with **KG / PRIVAT / 01.01.2026 / 99,00** (24 affected invoices) and
look for R426-64 and R126-86 in the table.

---

## If you would rather not touch the UI

The dialog calls one endpoint, and it writes nothing:

```bash
curl -s -X POST https://api.staging.therapios.de/treatments/price-change-invoice-impact \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"entries":[{"treatmentId":71,"tariffType":"GKV","effectiveDate":"2026-01-01","price":34.00}]}'
```

Returns `{count, invoices:[{prescriptionNumber, invoiceNumber, date, currentAmount, recomputedAmount}]}`.
`treatmentId` 71 is KG. Automated coverage of exactly this lives in
`tests/Staging/SuperAdmin/sa_price_change_invoice_impact.spec.ts`.
