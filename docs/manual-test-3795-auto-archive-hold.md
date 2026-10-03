# #3795 — the auto-archive hold: notes for a person

`tests/Staging/SuperAdmin/sa_auto_archive_hold.spec.ts` covers every AC that leaves a readable
trace (8 passed, 2026-10-03). **Nothing in it runs the command** — `app:prescription:auto-archive`
without `--dry-run` writes real statuses on real VOs.

## The state on staging today

The fix is live and the evidence is a partition of one nightly window:

| | |
|---|---|
| Abgelaufen VOs | 2,072 |
| …expired ≥ 90 days ago | **1** — VO **9120-1** |
| …of those with a signed session | **1** (the same one) |
| Archived from Abgelaufen since 30 Sep | **95, none with a signed session** |

VO **9120-1** expired 2026-07-02, is GKV, has one signed session (16 Jun 2026, so its deadline is
31 Mar 2027), sits in no billing submission and has no invoice. It became eligible on 30 Sep; the
archiver ran on **30 Sep, 1 Oct and 2 Oct**, took 95 other VOs, and left it. Under the old rule it
would have gone on the first of those runs.

**Why the held population is only 1.** Before the fix every Abgelaufen VO was archived the moment
it passed 90 days, so the population was a rolling 90-day window — `expiredAt` on staging spans
2026-07-02 to today and nothing older exists. The fix shipped 25 Sep, so held VOs have only just
started to accumulate. The Need Command comment says the same: *"N starts near 0 and grows as
held VOs accumulate."* Expect this number to climb; the spec asserts `> 0`, never a figure.

## What to check by hand, and why it is not automated

### The PM/QA walkthrough (Testing Guidance)

Needs the development team to run the job, and the last two steps **write to a real VO**:

1. Pick an Abgelaufen VO with a signed session, no billing submission, expired > 90 days ago.
   **9120-1 is exactly that VO today.**
2. `php bin/console app:prescription:auto-archive --dry-run` → it is held. The run prints
   `Abgelaufen: kept N VO(s) past the 90 days …` — that line is console-only and has no API
   surface.
3. Add it to a billing submission, run again → still held.
4. Set the submission to **Vollständig und Gesendet** → the VO turns Abgerechnet and follows the
   30-day rule.

Steps 3 and 4 put a real VO into a real billing submission and then mark that submission sent,
which is not reversible from a client, so they are left for a person.

### AC3 row 3

The one row of the truth table that is not a hold decision: once the submission is sent the VO is
**Abgerechnet**, so the hold predicate never sees it. AC1 says this outright — billing is what
moves a VO out of Abgelaufen, and no separate check of submissions or invoices exists. Criterion
4's 30-day branch takes over, and that branch is verified (261 `Abgerechnet → Archiviert`
transitions in the window, same job, same 20:46 UTC run).

### The billing-validation changes

The 9-month deadline is now anchored on the last **signed** session and the month-overflow is
fixed. Stored `PrescriptionValidation` rows are the **pre-fix** answer — the ticket says results
change only when the validation runs again for a VO — so seeing the new behaviour on a stored
verdict means re-running `POST /prescriptions/{id}/check-billing-validation`, which re-creates
that VO's billing verdict rows and can move it on or off the billing Validierung queue. Left as a
call a PM can make.

The helper itself is verified as a pure function at its boundaries, including the ticket's own
example (31 May 2026 → 28 Feb 2027) and the Developer Reference's trap (31 Dec 2025 → 30 Sep
2026, not 31 Oct).

## The AC5 fixture worth keeping

**VO 4053-7** separates both halves of the change at once: its last signed session is 17 Jul 2026
but its last activity of any kind is 6 Aug 2026 — a different month. The board serves
**2027-04-30**, which is the month-end 9 months after the *signed* session. The three rules it is
not:

| Anchor | Rule | Date |
|---|---|---|
| last signed | last day of month (new) | **2027-04-30** ← served |
| last signed | first of next month (old) | 2027-05-01 |
| last activity | last day of month | 2027-05-31 |
| last activity | first of next month | 2027-06-01 |

All five worklist rows match the new rule and none matches the old one.
