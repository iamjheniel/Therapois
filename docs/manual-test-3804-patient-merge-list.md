# #3804 — what the suite cannot verify, and what is still outstanding

`tests/Staging/SuperAdmin/sa_patient_merge_list.spec.ts` verifies the dev team's 25 Sep staging run
(7 tests) by reading its footprint. Three things remain.

## First, the identifiers

**"patient 99693", "patient 8864" are UI patient NUMBERS, not API ids.** They are serialized as
`patient.patientId`; 99693 is API id **8993**. `GET /patients/99693` is a 404 here — on #3790's
fixtures the same mistake resolved to a *different real patient*, which is worse. The spec pins this.

## 1. AC6 — the production run has NOT happened

The ticket's own Production Run section is "a post-deploy step, not done until confirmed", and no
report has been posted to the ticket. It requires, in order:

1. RC 3.14.0 live on production (the `<list>` argument does not exist in 3.13).
2. A fresh candidate pull (query in the Developer Reference), reviewed by operations — twins,
   couples and test patients removed.
3. The list uploaded to `s3://therapios-csv-files` at `temp/patient-merge-<date>.csv`. **It holds
   names, birth dates and insurance numbers — it must never go into Drive, Slack, the ticket or the
   repo.**
4. `php bin/console app:patient:merge-duplicates temp/patient-merge-<date>.csv` (preview), report
   posted.
5. After GO: the same with `--force` (takes a full dump first), report posted.

Expected for the first list: keep **8181** ← merge **8864**, `group_merged`, 7 × `vo_renumbered`
(8864-1 and 8864-3…8864-8 → 8181-3…8181-9), patient 8864 removed. Those are PRODUCTION patient
numbers; the equivalents do not exist on staging.

Afterwards this suite can verify it read-only, with the same assertions the staging run gets: the
survivor's VOs and their `formerNumbers`, the removed record 404, the `patient_merged` log, and a
re-run preview reporting `group_skipped` "record missing".

## 2. AC3's other skip reasons have no staging instance

Verified live: **a listed record no longer exists** (run 3 skipped FT1) and **the last name differs**
(FT2). Not reachable here:

| Row of AC3 | Why |
|---|---|
| birth date differs | needs another prepared fixture and a dev run |
| insurance number differs | same |
| the merge fails part-way, nothing of the group changes | needs an induced failure inside the transaction |

All three are covered by the developer's tests (six changed-record cases and a rolled-back group
failure, per the PM's AC-3 row).

## 3. AC5's report content

The report is console output plus a CSV in `reports/PatientMerge/` on S3. **There is no merge report
resource in the API** — verified by listing the whole entrypoint, which exposes only
`CrmActivityReport`, `SyncFacilityReport` and `TherapyReport` (the #3783 lesson applied: look for a
report resource before concluding, but here there genuinely is none).

What IS a client-side audit trail is `patient_logs?type=patient_merged` — 93 entries on staging, 92
from #3131's July batch and 1 from this ticket's run, so the two engines' work is distinguishable.

## Re-running the staging FT

The fixtures are consumed: 99694 is merged away and re-running the same list would skip FT1 with
"record missing" (which is itself AC3's first row). A fresh FT needs new test patients.
