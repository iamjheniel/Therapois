# #3859 — the merge command's main BSNR row: notes for a person

`tests/Staging/SuperAdmin/sa_practice_merge_main_bsnr.spec.ts` covers what a client can reach
(7 passed, re-verified 2026-10-03). **Nothing in it runs the command** — `--force` merges
practices irreversibly, and both Need Command comments say to run it only once the fix is live.

## The command has NOT been run, on either environment

Staging still shows **7 duplicate BSNR groups over 14 practices**; a run would collapse each
group to one practice. Production shows **6 groups**.

## AC1 is verifiable on PRODUCTION ONLY — and the fixture is confirmed

The fixed branch needs a survivor that owns **no** main row once `moveBsnrRows()` has brought
the others in, and `ensureMainBsnrRow()` returns early when one already exists.

- **Staging cannot produce it.** All 14 practices in all 7 groups already hold their own main
  row, so **0 of 7** groups could exercise the fix. The spec re-derives that count each run.
- **Production can.** Measured 2026-10-03, the reported fixture is intact:

| Practice | Name | `practice_bsnr` rows |
|---|---|---|
| 1763 | Gemeinschaftspraxis Dres. Flemming/Lock/le Blond | **0** |
| 1764 | Gemeinschaftspraxis Dres. Flemming/Lock/le Blond | **0** |
| 1765 | Gemeinschaftspraxis Dres. Flemming/Lock/le Blond | 1 — `724443500`, main |

Three same-named practices where only one holds the BSNR row. If the merge keeps 1763 or 1764,
the row arrives as a secondary and — before the fix — the survivor ends with no main row, which
is exactly what AC1 describes.

## Do not run it on production yet

`GET https://api.app.therapios.de/status` reports **3.14.0**. PR #3876 merged into
`release/3.15.0`, so **the fix is not on production**, and the Need Command's own warning
applies: *before the fix, `--force` is what creates the broken state this ticket is about.*

Order of operations: 3.15 reaches production → preview → apply → check.

## AC5's check query cannot be the evidence

It asks for 0 practices with BSNR rows and no main row after the run. **It already returns 0 on
both environments** (staging 0 and 0; production 0 and 0), so a 0 afterwards is the same 0 that
was there before — the #3799 shape, where a probe is perfect unless it had nothing to correct.

What *is* evidence: the surviving practice of a merged group holds **exactly one** main row, and
its `practice.practiceId` still mirrors that row's number (#3285). The spec's last test is armed
for precisely that and becomes a real assertion the moment the groups collapse.

## What the staging run is still worth

AC3 and AC4 — the preview's group list and the decision each group takes. Predicted on staging:
**5 merges (all `placeholder`) and 2 skips**. Reported, never asserted: `hasData` is only a
lower bound from a client, because the command also counts CRM activities and prescription
images, which no endpoint exposes — so a predicted merge can legitimately turn into a skip.

The two skips are instructive: `727504400` is two genuinely different practices sharing a
number, and `830039500`'s "FOR UPDATING" row **has 3 VOs**, so it is not a placeholder-with-no-
data and its group skips too.
