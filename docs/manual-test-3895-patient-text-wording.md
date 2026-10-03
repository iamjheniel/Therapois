# #3895 — the operations review's wording: notes for a person

`tests/Staging/SuperAdmin/sa_patient_texts_wording.spec.ts` covers everything a client can
reach (9 passed). This file records the half that no client can reach, and why.

## What is verified automatically

| AC | Row | How |
|---|---|---|
| 1 | L7 fee sentence | the deployed Praxis dictionary, both locales, old wording asserted gone |
| 1 | L9 preview string | the deployed Praxis dictionary, both locales |
| 2 | cancel page's other three lines, stop page both steps | the same dictionary |
| 3 | preview content | on screen, equal to the ported `render()` for the active practice |
| 4 | practice switch | on screen, switcher → preview name follows |

## What cannot be verified on staging, and why

### AC1 rows L2, L4 and L5 — the texts themselves

**The rendered text is never persisted.** `TextMessage` has no body column, no serialization
group exposes one, and no route renders a preview — the spec probes all three against a 404
control each run, so this is measured rather than assumed. The text exists only in flight
between the renderer and the SMS provider.

So reading what a patient received needs what the ticket's own Testing Guidance says, and what
#3637 describes:

1. A patient whose mobile is on the **staging allowlist** (otherwise the send is
   `dropped_staging` — 70 of the 109 rows in the log today).
2. Trigger a **freed-slot offer** and an **appointment reminder** for them.
3. Read both on the allowlisted handset, or in the **provider dashboard** (`sevenio`).
4. Check row **L2** (`Keine SMS mehr erhalten: [Link]`) as the last line of BOTH texts, row
   **L5** (the full offer), and that the reminder text above the stop line is unchanged.

What the automated file gives you instead is the strongest indirect reading available: the
deployed Settings preview equals the ported `render()` character for character, which is the
invariant the fix's own docblock states ("change one, change the other").

### AC1 row L7 on the cancel page itself

The dictionary value is verified; the **page** is not. Two walls:

- The cancel link is a one-time link delivered only in a text body, and redeeming it is
  irreversible (#3638/#3640).
- The fee variant is switched on per environment (`PRAXIS_CANCEL_NOTE_VARIANT=b`), which is an
  ops setting and not client-readable. The build ships both variants; which one a patient sees
  is config.

To check it by hand: open the cancel link from a reminder on an environment with variant `b`,
and compare the 24-hour note against row L7. `patient-link-screen.stories.tsx` shows variant B
for a visual check without a live link.

### Message length

The ticket estimates the offer grows from **2 to 3 billed SMS parts** (~328 characters with two
24-character production links). That is a provider-dashboard reading; nothing on staging bills
or counts parts.

## Findings for the PM

1. **The API half shipped inside an unrelated commit.** Both (a) and (b) are in monorepo
   `0e349765c87`, a 49-file commit titled *"perf(api,app,packages): cut the slow VO scopes,
   count fan-outs and per-row queries"* whose message never mentions 3895. A commit search for
   the ticket number in the monorepo returns nothing and the ticket reads as un-started; only
   the inline docblock names it. The Praxis half is properly labelled
   (`c0404551749`, "fix(copy): name the fee amount and show the real reminder in Settings
   (#3895)").
2. **AC4 is phrased as though the user stays on the tab.** Choosing a practice sends the app to
   the **Kalender**, so "Then the preview shows the newly active practice's name" is only
   observable after navigating back to Settings → Treatments. Pre-existing switcher behaviour,
   not something this ticket introduced — but the AC cannot be followed literally.

## Trap worth knowing

**The Flow super admin can sign in to Praxis Flow** even though they hold no `praxis_flow_access`
row, and the switcher then lists every practice (13 on staging). #3640 concluded the Praxis app
needed credentials this suite does not have; it does not. That is what makes AC3 and AC4
testable on the real screen here.
