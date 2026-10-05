# #3822 — Billing validation refused when the Gesellschaft has no IK: manual steps

Automated coverage: `tests/Staging/SuperAdmin/sa_missing_ik_validation.spec.ts`
(page object `Pages/superadmin/sa.missing-ik-validation.page.ts`).

The spec drives every path whose correct outcome is a **refusal**, because a refused
request writes nothing — the check runs before the flush, and AC3 makes the bulk path
all-or-nothing. What is left here is (a) the on-screen German message, (b) anything whose
correct outcome is a successful validation, which creates a billing submission and a
copayment invoice, and (c) one case staging has no fixture for.

---

## 1. THE PRIORITY — re-test the regular-Admin edit forms (the PM's one FAIL)

The 3 Oct PM run recorded **AC-1 row 3 and AC-2 bullet 1 as FAIL**: as a regular Admin,
choosing *Validiert* on either VO edit form locked the form, `Speichern` sent only
`therapist / doctor / elderlyCareHome / followupStatus / followupPrescription`, reported
success and saved nothing — no refusal message, and the VO stayed unvalidated.

**That has since been fixed by `0eae51982` ("fix(app): let a regular admin validate on the
VO edit forms", 2026-10-04), which is live on staging.** The strip is now keyed on the
**stored** validation status, not the one just chosen:

```js
// deployed bundle
if (V && 'validated' === z?.validationStatus && Y && !H) { … ADMIN_WHITELIST … }
//                       ^ prescriptionData, optional-chained — was `values`
```

The spec asserts that from the bundle and proves the server refuses a regular Admin
identically (422 on both paths), but **nobody has re-tested the screen since the fix**.

Steps, as a **regular Admin** (`admin.jhen@gmail.com`), on **VO 99969-1**
(Curano Berlin-Brandenburg 2 GmbH, GKV, Logopädie — the Gesellschaft has no Logopädie IK):

1. `/vo-management/<id>/edit` → change one ordinary field (e.g. the frequency Min).
2. Set **Abrechnungsprüfstatus** to **Validiert** → `Speichern`.
   **Expect:** the red message
   *"Diese VO kann nicht validiert werden. Für Curano Berlin-Brandenburg 2 GmbH ist keine
   IK-Nummer für Logopädie hinterlegt. Bitte zuerst unter Admin → Entitäten → Curano
   Berlin-Brandenburg 2 GmbH → IK-Nummern eintragen und dann erneut validieren."*
   shown **once**, the form still open, and nothing saved.
3. Repeat on the old form at `/v1/vo-management/<id>/edit`.
4. Set the status back to **Kein Status** and `Speichern` → the other change saves (AC2 bullet 4).
5. Control: the same two steps on **99968-1** (Curano Berlin-Brandenburg GmbH, which HAS the
   Logopädie IK) must still *validate* for a regular Admin — the PM's FAIL hit that VO too,
   so it is the proof the lock was the cause and not the missing IK.

> Keep the Gesellschaft's Logopädie IK **empty**. #3821's own checks depend on it.

---

## 2. The German message on screen (AC2 bullet 1, AC3)

The API's `detail` is **English by design**; the German comes from the client keys
`billing.missing_ik.single` / `.bulk`, which the spec asserts in the deployed dictionary
and proves are referenced — but it never renders them.

- **Validation screen**: Abrechnung → Validierung → search `FT3822` → *Validate* on
  **99969-1** → mark the manual checks *Pass* → **Validierung bestanden**.
  Expect the single message above, naming the Gesellschaft and **Logopädie**.
- **Bulk**: tick **99969-1** and **4363-2** (Curano Berlin-Brandenburg 3, which has its IK)
  → **Ausgewählte validieren**. Expect
  *"Es wurden keine VOs validiert. Für diese VOs fehlt die IK-Nummer ihrer Gesellschaft für
  die Therapieform: 99969-1 (Curano Berlin-Brandenburg 2 GmbH, Logopädie). …"* —
  with **4363-2 not listed and not validated**.
- A second fixture at a different Gesellschaft and therapy type: **100302-1**
  (Curano Hannover GmbH, Physiotherapie). The message must name those, not the pair above.

---

## 3. AC4 — save the IK, then validate (writes a submission and an invoice)

Not driven: validating creates a billing submission and a copayment invoice, neither of
which has a client-reachable undo.

The PM already did this on **99970-1** (Curano Hannover, Ergotherapie) and the footprint is
asserted read-only by the spec: entity 6 now holds `ikErgotherapy = 999999982`, the VO
resolves to it, is validated, sits in submission **75** and carries invoice **R626-1**.

To repeat it fresh, use **100302-1** (Curano Hannover, **Physiotherapie** — entity 6 still
has no PT IK, which is also why that VO is a live refusal fixture):

1. Validate it → refused, naming *Curano Hannover GmbH* and *Physiotherapie*.
2. Admin → Entitäten → Curano Hannover GmbH → **+** on Physiotherapie → a test number →
   check mark → *"IK-Nummer gespeichert."*
3. Validate again → no message; GKV-Abrechnung shows it in that Gesellschaft's open
   physiotherapy submission.

> Doing this **consumes the last unvalidated missing-IK fixture of entity 6**. Delete the
> IK again afterwards (the delete icon in the same table) if you want 100302-1 back as a
> refusal fixture; the VO itself stays validated either way.

---

## 4. AC5 bullet 3 — the other statuses (writes a status)

The refusal is gated on the target status being `validated`, so *Zur Korrektur*, *Kann
nicht validiert werden* and *An Therapeut zurückgesendet* need no IK. The spec asserts
that as **data** — 99961-1 is `for_fixing` and 99963-1 is `cannot_validate`, both at the
missing-IK Gesellschaft — rather than by setting a status on a real VO. Driving them live
is a one-click check on the validation screen.

---

## 5. No staging fixture — the refused direction of the therapy-type rule

AC1 resolves the therapy type as *the therapist's department, else the VO's own*. The
**allowed** direction is exercised and asserted: **99967-1** is a speech-therapy VO whose
therapist is in physiotherapy at a Gesellschaft with **no** Logopädie IK, and it resolved
to the **Physiotherapie** IK and joined that submission — so a rule reading the VO's own
type would have refused it.

The **mirror** — a therapist whose department has no IK on a VO whose own therapy type does
have one — would be refused only by the shipped rule, and **staging has no instance**:
0 of the 1,261 unvalidated GKV *Fertig Behandelt* VOs, and the spec re-measures it over the
validated population each run. Building one means a VO at Curano Berlin-Brandenburg 2
(PT ✓, ERGO ✓, **LOGO ✗**) with `therapyType = physiotherapy` and a therapist whose
department is **Logopädie** — e.g. Alexandra Schöner. It must then be refused naming
*Logopädie*.

---

## Live IK gaps on staging (the fixture supply)

| Gesellschaft | missing |
|---|---|
| Curano Berlin-Brandenburg 2 GmbH (2) | Logopädie — **keep empty for #3821** |
| Curano Hannover GmbH (6) | Physiotherapie |
| Curano Stuttgart GmbH (7) | Ergotherapie |
| ZZPerf Entity 746286 / 241643 (8, 9) | all three |
| FT3815 Testentität (10) | Physiotherapie |
| FT3816 / FT3805 Gesellschaft (11, 12) | Ergotherapie, Logopädie |

**The ticket's own Steps to Reproduce are stale.** They name Curano Berlin-Brandenburg 3
and VO 2706-27 / 2707-27; entity 3 now holds `ikSpeechtherapy = 400123457` and 2707-27 is
in submission `S-2026-457-001` — both the doing of **#3821's Part 2 run** on 30 Sep.
