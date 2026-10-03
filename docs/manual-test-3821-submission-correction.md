# #3821 — one-off billing-submission correction: what a person still has to do

`app:billing-batch:correct-3821` is console-only, so nothing in the Playwright suite
runs it. `tests/Staging/SuperAdmin/sa_submission_correction.spec.ts` verifies every
state the command reads and every footprint it leaves; this file covers the rest.

**AC8 governs completion:** "The ticket is done only after the production run of both
parts… A staging run does not complete it." Nothing below closes the ticket.

## Status on staging, 2026-10-03 (API 3.15.0)

| Part | State |
|---|---|
| **Part 2** | **Ran 2026-09-30 03:28:58 UTC.** Created `S-2026-457-001` (entity 3, Logopädie) and added `2707-27`. Verified by the spec. |
| **Part 1** | **Never run.** No VO on staging has ever been added to a sent submission. |

## Part 2 — the rehearsal in the Testing Guidance can no longer be performed

The Guidance asks for: preview with the IK missing → save the IK → preview → `--execute`
→ run again and see the VO skipped. **The first three steps are no longer reachable**:
entity 3 already holds its Logopädie IK (`400123457`) and `2707-27` is already batched.
The Developer Reference still describes the fixture as "in no batch, a ready fixture",
which was true of the 25 Sep snapshot it was written against.

Only the last step is still testable, and the spec checks the state that produces it.

**A replacement fixture exists.** `965112-2` (entity 6 Curano Hannover GmbH,
physiotherapy, validated, GKV, in no submission) is stuck for exactly this ticket's
reason — entity 6 has `ikErgotherapy` and `ikSpeechtherapy` but **no
`ikPhysiotherapy`** — and entity 6 has no pending physiotherapy submission either.
So it exercises both of AC5's branches: Part 2 stops while the IK is missing, and
creates a new waiting submission once it is saved.

To rehearse Part 2 end to end:

1. Confirm the staging safety controls **in the same session** (Testing Guidance):
   DATEV transfer off, every Gesellschaft on test Mandant 9999, the email redirect active.
2. `app:billing-batch:correct-3821 --entity=6 --stuck-vo=965112-2` → expect Part 2 to
   stop and name the missing Logopädie…sorry, **physiotherapy** IK for entity 6.
3. Save entity 6's physiotherapy IK (Admin → Entitäten → IK-Nummern, then the **Save**
   button at the bottom of the page, below the invoice list, until #3815 ships).
   Pick a number whose **last three digits collide with no other Gesellschaft's** —
   the spec's criterion-1 test prints the 20 pairs in use.
4. Preview, read it, then re-run with `--execute`.
5. Expect: a new waiting `P-2026-<last 3>-001` for entity 6 with `Batch erstellt` +
   `Rezept hinzugefügt`, the VO's status and invoices unchanged, and its
   `validationStatus` **not** written again.
6. Run once more → the VO is skipped as already in a submission.

## Part 1 — needs a human, and it writes

Part 1 is not rehearsed by the suite for three reasons, each sufficient on its own:

- **It creates a copayment invoice** on a real staging patient (AC4).
- Its two preparation steps are destructive UI actions on real records: detaching a
  confirmed back side from a VO, and resetting that VO's billing validation (which
  takes it out of a *sent* submission).
- The Need Command adds a third: open the target VO's billing-validation screen and
  tick every open check **without validating**. On the 25 Sep production copy those
  were #16 `treatment_documentation_complete`, #20 `co_payment_calculation` and
  #31 `group_therapy_switch_documented`.

**The comparable pair.** The Guidance asks QA to pick one and nobody has. The spec's
last test prints a live pair each run — it must have a **non-zero copayment**, or
AC4's invoice row is never exercised. The pair it named on 2026-10-03, out of 393 VO
candidates and 1,452 movable back sides:

```
--vo=4289-1                  Curano Berlin-Brandenburg 3, GKV, Fertig Behandelt,
                             unvalidated, 420,02 € revenue, 52,02 € copayment
--target-batch=P-2026-588-001   sent 2026-06-30, same Gesellschaft and therapy type
--source-batch=P-2026-862-001   sent 2026-06-30, Curano Hamburg GmbH
--detached-vo=4514-11        the VO the back side comes off
--back-image=83-037
```

Two Gesellschaften, as in production — the back side crosses from Hamburg's sent
submission into Berlin-Brandenburg 3's, mirroring 565-008's move.

Then check, per the Guidance: the VO is in the sent submission's list and history, the
totals of both submissions moved, the VO is Abgerechnet with its back side confirmed,
its copayment invoice is on the copayment tab in **Nicht gesendet**, and the waiting
submission did **not** get it. Run again → it stops at the checks and changes nothing.

## For the PM

- **A second stuck cause exists on staging.** The ticket says of its five production
  VOs: "These five are the only validated GKV or BG VOs on production that are in no
  submission", and attributes all of them to the missing IK. On staging there are
  seven such VOs, and **six of them hold the right IK** — five even have a pending
  submission of their own Gesellschaft and therapy type already open — and none was
  ever removed from a submission by hand. Neither #3821 nor #3822 covers that shape.
  Worth checking on production before the run, since #3822 prevents only the
  missing-IK cause.
- **`--entity` is the Gesellschaft, and its IK must not collide.** `findMostRecentAndPending()`
  filters on the submission-number prefix only, not on the entity, so two Gesellschaften
  whose IKs share their last three digits can take each other's VOs. Staging has no
  collision today across 20 (IK type, last 3) pairs; the spec asserts that, so a newly
  entered IK that collides will fail the check rather than go unnoticed.
