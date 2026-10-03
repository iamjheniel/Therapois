# #3729 — the Arbeitszeiten dot's hover tooltip: notes for a person

`tests/Staging/SuperAdmin/sa_dot_tooltip.spec.ts` covers all four ACs read-only. This
file records the coverage gap, the AC that changed mid-flight, and two navigation traps.

## The AC changed on 3 Oct, and the PM's own two verdicts disagree

AC1 originally asked for "the same tooltip" as the TO Management dot. The board ships a
**black one-line bar** (`InfoTooltip`, parts joined with a middle dot) where TO
Verwaltung shows a **light-red three-line box** (`PerformanceTrafficLight`'s Portal
tooltip). The PM's Developer Reference records **AC-1 → FAIL** for that style gap; the
results table records **PASS**, because the AC was *corrected the same day* to "the exact
same **wording and icon**", accepting the one-line style since it also opens on a tablet
long-press. Both entries are right, in order. The wording and icon do match:

```
0% Effizienz · Basierend auf 5 Tagen · 18.09.2026 – 28.09.2026
```

The implementation reason is in the code comment: `PerformanceTrafficLight` only wires
`onHoverIn`/`onHoverOut`, so reusing it would have lost the long-press AC1 also asks for.

## Coverage gap, measured each run

Staging carries **only `rot`, `grau` and `abwesend`** — on 2026-10-03, 120 / 106 / 10 of
236, with **0 `gelb` and 0 `gruen`**. So:

- **AC1 is exercised on red only.** Yellow and green dots cannot be produced here.
- **AC4's headline case cannot be built at all**: it wants two therapists with green
  period percentages whose dots differ, and there is only one dot colour available. What
  *is* verified is the cause — the dot's window is period-independent and per-therapist
  (50 distinct windows), so the mismatch the ticket explains is real and reproducible.

The last test prints this split every run, so the gap cannot go stale.

## Not driven here

- **Tablet long-press.** AC1 allows the one-line style precisely because it also opens on
  a long-press; that is the mobile build and not reachable from this suite. The PM did
  not test it either.
- **The TO Management screen itself.** The spec compares the two screens at the API
  level — `/kpis/management/efficiency-buckets` against `/therapist-performance`, which
  is what the ticket's own Developer Testing Guidance asks for — rather than hovering
  both dots. A person comparing the two visually is still the way to catch a styling
  regression, since the style is deliberately *not* identical.

## Traps

- **Do not reuse #3575's `openArbeitszeiten()`.** It steps six months back to April 2026
  for its own four-colour fixture — six slow board reloads, and the run here went from
  **7.6 min to 1.3 min** once dropped. This ticket needs no period at all: the dot's
  window is period-independent, which is AC4.
- **The board opens in Gruppen view**, whose rows are team toggles, so therapist markers
  do not exist until the view is switched (#3718/#3725).
- **Wait for a painted MARKER, not the heading or the rows.** The section and both
  toggles render long before `efficiency-buckets` answers — the slowest pair on this
  board — and reading early returns `[]`, which looks exactly like the feature being
  absent. #3575 hit this on its own dots.
- **`/kpis/management/efficiency-buckets` now answers as a Hydra collection**, where
  #3705 recorded a bare array. Unwrap both forms or a future build silently yields zero
  rows.
- **Both endpoints omit `efficiencyPercent` / `windowStart` / `windowEnd` when null**, so
  a comparison of two absent values passes while testing nothing. The spec requires a
  minimum number of rows populated on *both* sides before believing "0 mismatches".
