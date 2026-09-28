# #3799 — the two steps the suite cannot drive, and why

`tests/Staging/SuperAdmin/sa_storno_overdue_exclusion.spec.ts` verifies the rule, the invariants and
AC4's data surface automatically (9 tests). Two things need the development team.

## Deployment is not decidable from a client — do not try to infer it

The API change is two lines inside `app:invoice:check-overdue` (`andWhere('i.originalInvoice IS
NULL')` on each query). No route, no serialized field, so nothing to probe; `/status` gives the
release, not the commit.

`Version20260925090000` **would** have been the probe — it runs at deploy and writes a
`status_change` log per corrected Storno — but staging had **0 Overdue Stornos**, so it corrected
nothing and left no fingerprint. Measured on 2026-09-25: 17 Stornos, all `not_sent`, and **zero**
`status_change` logs on any Storno in all of history. "The migration ran" and "there was never
anything to run on" are indistinguishable here.

## 1. AC1 live — the nightly check leaves a Sent Storno alone

The ticket's own recipe, steps 4 and 5 of which are dev-only:

1. Confirm the integration safety settings first: the DATEV switch off on staging, every
   Gesellschaft on test Mandant 9999, the staging email redirect active.
2. PKV-Abrechnung → search `R126-84`; its row shows Storno `S126-6` in the Storno Nr column.
   (**Staging's `S126-6` is not production's** — there its original is `R126-20`, here `R126-84`.
   The spec pins this so the numbers are not read across environments.)
3. Set `S126-6`'s Storno Status to **Gesendet**.
4. *Developer:* move the Storno's `sent_date` back 22 days.
5. *Developer:* run `app:invoice:check-overdue`.
6. Expected on the fixed build: `S126-6` still shows **Gesendet**, and no `status_change` log appears
   on it. On the old build it would move to Überfällig.

Run the spec straight afterwards — `AC1 the standing invariant` and `AC1 the history` both become
non-vacuous the moment any Storno is Sent, and they are what catch a regression.

## 2. AC3 live — the release correction

Staging had nothing to correct. To exercise it, a Storno must be put into Overdue **on the old
build** (the recipe above), then the fixed build deployed. Afterwards the spec asserts the outcome
automatically: no Storno in Overdue, the correction's `overdue → sent` log present, and the original
still Cancelled.

Per AC4, check the Storno then reads **Gesendet** on: PKV-Abrechnung and Zuzahlungsverwaltung (Storno
Status column on the original's row), Rechnungssuche, the patient page Rechnungen section, Gesellschaft
bearbeiten → Rechnungen, and the original's Rechnungsprotokoll.

## What the automated file already covers

- Both versions of both query steps, as pure functions, shown to differ **only** on Stornos — the
  live data cannot show this, since all 17 Stornos are `not_sent` and neither version selects any.
- No Storno is in a status only the check produces, and none ever has been.
- AC2's control: **128** invoices ARE in a check-produced status and **all** are non-Stornos, so the
  check demonstrably still works — without which the invariant above is satisfiable by a check that
  does nothing at all.
- AC4's data surface: `stornoStatus` on the ORIGINAL's row agrees with the Storno's own status on all
  17, and every original is Cancelled.
- The Out-of-Scope guard: the Storno column's vocabulary is still exactly Not sent / Sent, bound to
  the two call sites that feed it (the PKV and copayment tabs).
