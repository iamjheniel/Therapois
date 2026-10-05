# #3849 — the 14-day expiry hint: notes for a person

`tests/Staging/SuperAdmin/sa_expiry_hint_running_vos.spec.ts` covers AC1, AC2's counted half and
AC3 (8 passed, 2026-10-05). Read-only.

## What the fix does on Sara Fischer's board today

| | |
|---|---|
| Rows in the board payload | 868 |
| …the board actually lists | 846 (22 are in never-listed statuses) |
| Validity inside 14 days | **58** ← what the hint used to show |
| Counted under #3849 | **37** ← what it shows now |
| Dropped | **21**, every one a closed status |

The painted hint reads **"37 VOs laufen in 14 Tagen aus"**, "Diese anzeigen" lists **37** rows, and
the set computed from the payload matches it exactly — nothing in either direction.

## The PM's fixture block

Sara Fischer, all validity 12.10.2026 (7 days out). Re-read each before relying on it — two have
already moved since the PM's run of 4 Oct.

| VO | Status | Expected |
|---|---|---|
| 100160-1 | Aktiv | counted |
| 100161-1 … 100165-1 | Abgerechnet / Fertig Behandelt / Abgebrochen / Abgelaufen / Archiviert | **not** counted |
| 100166-1, 100167-1, 100173-1, 100174-1 | Bereit / For Review / Pending / Sent Back | not counted — the board does not list them at all |
| 100168-2 … 100172-2 | Aktiv follow-ups, predecessors all closed | counted |

## AC2's exclusion half has no live fixture

Measured across six boards: **44 follow-up VOs with a still-running predecessor, and not one of
them has a validity date inside 14 days**. So the rule has a population, but the exclusion is not
demonstrated on live data.

**The PM's own fixture for it was consumed.** Their notes record 100169-1 as *Bereit* — a running
status — which made 100169-2 the held case. It now reads **Fertig Behandelt**, so 100169-2 counts.

**To restore it:** set **100169-1** back to **Bereit** (or any running status). 100169-2 is Aktiv
with validity 12.10.2026, so it is already in the window; the hint should then drop from 37 to 36
and 100169-2 should disappear from "Diese anzeigen".

## AC4 — the tablet

Not driven here; this suite has no tablet target. The PM covered it on 2 Oct (Android emulator,
Galaxy Tab A9+, app v3.15.0, as Karsten Jahns). The predicate is shared app code, so the risk is
in the rendering rather than the rule.

## Traps worth knowing

- **Each patient group carries TWO arrays**, `prescriptions` and **`completed`**. The closed VOs —
  the whole subject of this ticket — are in `completed`. Read only `prescriptions` and the fix
  appears to drop nothing at all (the board then shows 41 of 41 rather than 37 of 58).
- **Four statuses are never listed by the board** — Bereit, For Review, Pending, Sent Back to
  Therapist — so they must come out of the pool before the predicate runs. Leave them in and the
  computed hint over-counts by exactly the number of them in the window; here that is 41 against
  the painted 37. This is not part of the fix: it is unchanged board behaviour since 9 Aug 2026,
  and the PM corrected AC1's wording on 5 Oct to say so.
- **The saved session is single-use** (#3460) and `UntreatedDaysPage` does not mint, so the board
  lands on the login form and the therapist picker never appears — which reads as the picker being
  gone. Call `mintUiSession` first.
- **The predicate fails OPEN on an unknown parent**: a follow-up VO whose parent status is null or
  unreadable is *counted*, deliberately, because an over-count is a row the therapist can dismiss
  and an under-count is work that never reaches them. A port that treats "unknown" as "running"
  under-counts and reads as the fix being too aggressive.
