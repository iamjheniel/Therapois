# #3871 — Operativ note columns: what a person still has to check

`tests/Staging/SuperAdmin/sa_operativ_note_columns.spec.ts` covers all six ACs plus
the three Out-of-Scope freezes, read-only. This file records what it deliberately
leaves out and the two things a tester should know before measuring.

## Do not pin a pixel

The name column is sized to the longest therapist name and the two note columns split
whatever is left, so **every absolute width drifts with the roster**:

| Measured | Gruppen (Problem / Maßnahme) | Therapeut:innen |
|---|---|---|
| PM, 2 Oct 2026 | 315 / 450 | 330 / 480 |
| This suite, 3 Oct 2026 | 320 / 460 | 333 / 488 |

Same build, same correct behaviour. Assert relationships — notes wider than 180,
Maßnahme wider than Problem / Thema, name identical in Operativ and Details — never
the numbers.

**180 is the one safe constant**: `NOTE_COLUMN_WIDTH` in `WorkingHoursTable.tsx`, still
the width in Details and Abrechnung, and in Operativ once the table stops fitting.

## The wide layout does not begin at a fixed window width

AC3's table says "wider than the Operativ columns need at today's widths (for example
1920)". That threshold moves with the data, because the name column does. On staging
on 3 Oct the Operativ table needs:

- Gruppen: 1,417 px
- Therapeut:innen: 1,376 px

A 1440 px window gives 1,358 px of scroller, so **both are on the narrow side — by 59
and 18 px**. That is why the PM recorded 1440 behaving like AC3's second row, and why
the wide notes start at roughly 1,470 px today. **Eighteen pixels is a knife edge**: a
shorter longest-name would flip Therapeut:innen at 1440 to the wide layout without any
code change. Test the two unambiguous widths (1920 and ~1100) and treat 1440 as
informational — the spec's last test measures it rather than asserting a side.

## Not driven by the suite

- **Writing a long note.** The PM added a 202-character Maßnahme to get a cut note.
  The suite does not: the board already carries 169 note cells in Therapeut:innen view
  and several are genuinely cut (the longest shows 32 px of a 224 px text), so AC4 and
  AC5 are exercised on existing data and nothing is written. If you do add one, note
  that a **Problem / Thema cell shows the issue TYPE name, never the typed text**, so
  it only reaches two lines with a long type name — AC4 really bites on Maßnahme.
- **The side panel's history list.** AC5 is asserted as "the panel shows more of the
  same note than the clamped cell did". Whether the older entries beneath it are
  complete and correctly ordered is `IssueHistoryPanel` / `CallToActionPanel`
  behaviour, unchanged by this ticket.
- **Android.** The fix is web layout; the table is not reachable from the mobile build.

## Two things that make the panel hard to locate

- There is **no `role="dialog"`** on the note panel — the same RNW gap recorded on this
  board family in #3400, #3343 and #3505. Locate it by its content.
- Clicking a note cell is a **read**, so it is safe to drive; press Escape afterwards or
  the open panel swallows the next click and the following measurement reads the panel
  rather than the table.
