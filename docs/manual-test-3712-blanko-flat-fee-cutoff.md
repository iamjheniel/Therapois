# Manual test — #3712 Blanko VBP-BV flat fee, cutoff 30.07.2026

**Environment:** staging · **Role:** Admin or Super Admin.
**Verified against staging on 2026-09-22.** Every figure below was read live; re-read it before you
start, because other people's runs move it.

Automated coverage lives in `tests/Staging/SuperAdmin/sa_blanko_flat_fee_cutoff.spec.ts` — it
verifies the rule's arithmetic, the gated code list, and that no VO issued on or after the cutoff
carries the fee. The two steps below are the ones that need a write and so are not automated.

---

## Read this first: the ticket's own QA step cannot fail

The Testing Guidance says:

> create a test Blanko VO with an issue date of 30 Jul 2026 or later, document its first treatment,
> and confirm the Heilmittel breakdown does not include VBP-BV.

**Following that literally proves nothing.** The fee is only ever attached from the VO's
**prescribed** treatments (`ActivityFeeService::attachFeesForNewActivity()` loops
`Prescription::getOneTimeFees()`), and a Blanko VO created by hand on staging does not prescribe
VBP-BV at all. Measured 2026-09-22:

- **14** Blanko VOs issued on or after 30.07.2026 exist on staging; **0** of them prescribe a VBP
  fee (three of those were created on 17.09.2026, the day the fix shipped).
- **2,068** VOs prescribe a VBP fee and **all** were issued before the cutoff; the newest is
  **15.07.2026** (VBP-BV) and **14.07.2026** (VBP-BV-P).
- Of 61 PT-Blanko VOs, **22 do not prescribe VBP-BV-P at all**, including ones issued well before
  the cutoff (2026-06-01 onward).

So the breakdown is empty on a fixed build **and** on an unfixed one. The ticket's premise —
"Every Blanko VO automatically carries the VBP-BV one-time flat fee" — is a property of how the
TheOrg import builds a VO, not of being Blanko.

**To test the gate you have to reach it**, which means step 1 below: put a VBP fee into the VO's
prescribed treatments yourself.

---

## Test A — a post-cutoff VO that DOES prescribe the fee gets no fee row (AC2, AC3)

1. Create a Blanko VO, or reuse one, with **Ausstellungsdatum on or after 30.07.2026** and **no
   documented treatment yet**. Candidates read live (all Aktiv, 0 activities):
   **965505-3** (31.08.2026, PT), **965505-5** (11.09.2026, PT), **99647-1** / **99650-1**
   (17.09.2026). A VO with `acts=0` is required — the fee attaches on the FIRST treatment only.
2. Open the VO's edit form → **Verordnete Behandlungen** and add the VBP flat fee for its area:
   **`VBP-BV-P`** (PT, 58,63 EUR) or **`VBP-BV`** (Ergo, 98,59 EUR). Save.
3. Confirm the VO now prescribes it (the Heilmittel list shows the code).
4. Document the VO's **first** treatment.
5. **Expect:** the session's Heilmittel breakdown shows the treatment and any per-treatment fee
   (e.g. `HBH-PT-BV`), and **no `VBP-BV-P` / `VBP-BV` line**. The VO's Gesamtumsatz must not move
   by 58,63 / 98,59.

**Control, so a pass means something (AC1).** Repeat on a VO issued **29.07.2026 or earlier** that
prescribes the fee and has no treatment documented yet. There the first treatment **must** attach
the fee. Without this half, "no VBP line" is equally consistent with one-time-fee attachment being
broken altogether.

A cheaper partial control already passes automatically: post-cutoff Blanko VOs **965111-1**,
**965112-1** and **965506-1** each carry their *other* one-time fee (`AB-P-BV` / `AB-E-BV`) exactly
once, so the attach path itself works after the cutoff.

---

## Test B — an existing post-cutoff fee row is NOT removed (AC4)

Staging has **no** VO in this state (the ticket's "7 Blanko VOs issued on or after 30 Jul 2026
already carry the fee" is a **production** count from a 15.09.2026 snapshot), so this is a
production check.

1. On production, take one of the 7 VOs management listed.
2. Confirm its `VBP-BV` fee row is **still attached** and still appears in the VO's Heilmittel
   breakdown.
3. Confirm it still bills: the VO's Gesamtumsatz still includes 58,63 / 98,59.

**Why step 3 matters.** The fix changed the revenue engines too, not only the attachment. On a
post-cutoff VO the fee now bills **only if its `ActivityTreatment` row exists**. Those 7 have the
row, so they keep billing — but a VO that was being billed the fee *without* a row stops. The
commit measured that as a KPI delta of **−197,18**, reconciling to exactly two post-cutoff VOs.
If management corrects the 7 by hand, deleting the row is what stops the billing.

---

## Things that will mislead you

| Trap | What happens |
|---|---|
| **There are TWO VBP codes.** `VBP-BV-P` is PT (58,63), `VBP-BV` is Ergo (98,59). | Testing only the PT one leaves half the rule unchecked. Both are gated; there is no Logo/SSSST variant. |
| **The cutoff is inclusive.** | 30.07.2026 is already excluded. 29.07.2026 keeps the fee. |
| **The check is on the VO's issue date, not the documentation date.** | A VO issued 20.07.2026 whose first treatment is documented today still correctly gets the fee. |
| **A VO with no issue date keeps the fee.** | Absent data must not silently remove a charge. |
| **Only VBP is gated.** | `AB-P-BV`, `AB-E-BV` and `BD-BV` are Blanko one-time fees too and are deliberately untouched at every date. |
| **`bv` is not in the VO payload.** | `prescribedTreatments[].treatment` carries no `bv` flag — only `/treatments` does. "Is this Blanko?" read off the VO is silently always false. |
