# Manual test — #3561 Notice when reactivation clears the "Bestellen" status

**Environment:** staging · **Role:** Admin or Super Admin
**Verified against staging 2026-09-14.** Fixture ids move as people test — re-check the pool before
you start (see "Finding a fixture" below).

---

## What you are testing

Reactivating an expired VO (**Abgelaufen → Aktiv**) whose **Folge-VO Status is "Bestellen"** already
clears that status and the Bestelldatum — that behaviour is #3197's and is *not* what you are
testing. This ticket adds the **notice** that tells the admin it happened.

**⚠️ This test is destructive and cannot be undone.** Setting the VO back to Abgelaufen afterwards
does **not** restore the Folge-VO Status and Bestelldatum the reactivation cleared. Each run
consumes one fixture VO. There are currently **166** to spend.

---

## Finding a fixture

Abgelaufen **and** Folge-VO Status "Bestellen". On the Admin Board, filter VO Status = `Abgelaufen`
and Folge-VO Status = `Bestellen`. Or via the API:

```
GET /prescriptions?treatmentStatus=Abgelaufen&followupStatus=order&itemsPerPage=10
```

Live examples (2026-09-14): **VO 2322-4** (id 4), **VO 1284-17** (id 5708), **VO 2428-4** (id 17859).

> VO **5708** is the one the ticket's own Testing Guidance names. It was reactivated on 31 Aug,
> cleared correctly, has since expired again and re-acquired "Bestellen" — so it is usable again.

---

## Test 1 — single reactivation shows the notice (AC1, AC5)

1. Open the VO's edit form (`/vo-management/{id}/edit`). Confirm **VO Status = Abgelaufen** and
   **Folge-VO Status = Bestellen**, and note the **Bestelldatum**.
2. Change **VO Status** to **Aktiv** and save.
3. **Expect a notice:** *"Folge-VO Status „Bestellen" und Bestelldatum wurden bei 1 reaktivierten VO
   entfernt."*
4. **Expect no confirmation step** — the save completes on its own; the notice only informs (AC5).
5. Re-open the VO: **Folge-VO Status and Bestelldatum are now empty.**

> The notice also fires from the **dashboards' inline VO-status pills** — the developer flagged this
> on the PR and it is not in the ticket body. Changing the status from the Admin Board or Board v2
> row pill is a separate surface worth exercising, not just the edit form.

## Test 2 — no notice when nothing was cleared (AC2)

Pick an **Abgelaufen** VO whose Folge-VO Status is anything *other* than "Bestellen" (or empty).
Reactivate it the same way. **Expect no notice at all.** Everything else behaves as today.

A second case worth trying, because the implementation handles it deliberately: on a
Bestellen VO, **clear the Folge-VO Status dropdown yourself in the same save** as the reactivation.
**Expect no notice** — the admin already knows, and the helper's `fvoStatus === Bestellen` guard
keeps it quiet.

## Test 3 — bulk reactivation shows one summary with a count (AC3)

1. On the Admin Board, select **several** Abgelaufen VOs, at least 2 of them with Folge-VO Status
   "Bestellen" and at least one without.
2. Bulk-change VO Status to **Aktiv**.
3. **Expect one summary notice** naming how many were cleared — e.g. *"… wurden bei 4 reaktivierten
   VOs entfernt."* The count must be **only those that actually had "Bestellen"**, not the size of
   your selection. That is the assertion: select 5 where 2 had Bestellen, expect **2**.

## Test 4 — no summary when none had "Bestellen" (AC4)

Bulk-reactivate several Abgelaufen VOs where **none** has Folge-VO Status "Bestellen".
**Expect no clearing notice.**

---

## Reading the result without the UI

The bulk endpoint reports the count directly, so you can confirm a bulk run's number independently:

```
POST /prescriptions/status/bulk   {"id":[...], "treatmentStatus":"Aktiv"}
-> {"count": 5, "clearedFollowupCount": 2}
```

`clearedFollowupCount` is what the summary notice renders. **Do not use this endpoint to "just
check" a live VO** — it writes a `treatment_status_change` log for every prescription it matches,
even when the status does not change. A payload naming an id that exists nowhere is safe and returns
`{"count":0,"clearedFollowupCount":0}`.

Automated read-only coverage: `tests/Staging/SuperAdmin/sa_reactivation_notice.spec.ts`.

---

## Things that will make you think it is broken when it is not

- **The notice is one string with a `{{count}}`.** A single reactivation renders the *singular* of
  the same string the bulk summary uses ("bei 1 reaktivierten VO"), so it correctly reads like a
  count even on the single path.
- **Reactivating a VO that is not Abgelaufen** clears nothing and notifies nothing — the clearing is
  gated on the *old* status being Abgelaufen, not on the new one being Aktiv.
- **Already-cleared VOs from before this shipped** are out of scope; the ticket explicitly adds no
  bulk cleanup for them.
