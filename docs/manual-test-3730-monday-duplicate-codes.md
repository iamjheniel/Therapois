# #3730 — duplicate station codes: notes for a person

`tests/Staging/SuperAdmin/sa_monday_duplicate_codes.spec.ts` (6 passed, 2026-10-05). Read-only;
the sync is a console command and is never run.

## Verdict: not deployed

Decided behaviourally, because a commit search is not evidence on this repo (#3895's API half
rode in under a performance subject):

| Probe | Result |
|---|---|
| A duplicate count on the run summary (AC5) | **absent** — the entity serves `matchedCount`, `createdCount`, `mismatchCount`, `gapCount` and nothing else |
| A `duplicate` category in any report | **none**, across runs sampled from April to 4 Oct |
| Categories ever used | `matched`, `created`, `name_updated`, `name_update_skipped`, `gap`, `conflict`, `held` |

**The control matters:** the nightly sync runs at 19:32 UTC and the newest run is hours old, so
"no duplicate was ever reported" is not explained by the job being off.

## Do not mistake #3783's `conflict` rows for this ticket

They are **mirror images** and the newest run has five of them:

- **#3783 `conflict`** — one Monday **row** kept by two Flow **facilities**. Reason text:
  *"Monday row 2114947979 is also kept by active facility …"*
- **#3730 `duplicate`** — one station **code** carried by two Monday **items**, so both updates
  land on one facility and the second silently overwrites the first.

The spec asserts every conflict reason names a *Monday row* and never a duplicate station code,
so the two cannot be confused in a later run.

## A partial: the `board` column exists but is empty

AC4 wants four fields per conflicting item, one of which is the Monday board. A **`board` column
appeared in the CSV between report 154 (27 Sep, 7 columns) and 158 (1 Oct, 8 columns)** — but it
is **empty on all 272 rows of the newest run**, including the conflict rows. So the header is
there and nothing fills it. Reported rather than asserted: whether that column belongs to this
ticket or another cannot be read from here.

## Even once it ships, staging cannot exercise it

The trigger is **two Monday.com items configured with the same station code** — a third-party
board state this suite does not write, the same wall #3783's rules 6 and 8 hit. The ticket's own
Testing Guidance says as much: *"Ask a developer to run the sync (with the existing preview option
first) after temporarily giving two Monday.com test-board items the same station code."*

**What is ready for that moment:** the report reader, the category vocabulary and the count
assertions in the spec all flip from "absent" to a real check as soon as a duplicate row appears.
