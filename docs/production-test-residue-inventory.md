# Inventory — records left in PRODUCTION by the test suite

Read-only audit, 2026-10-02, against `https://api.app.therapios.de` (production, API `3.14.0`).
**Nothing was deleted or modified.** The specs that created these were removed on the same day; see
the "Production specs must not CREATE records" section of `CLAUDE.md`.

Identifiers come from the removed specs themselves (recovered from git history), so each pattern is
exact rather than guessed.

## Summary

| # | Record type | Count | Still referenced by anything? | Live user impact |
|---|---|---|---|---|
| 1 | **Announcement** | **1** | — | **YES — visible to every user since 2026-07-03** |
| 2 | User accounts | 9 | 0 VOs, 0 activities each | a real login each, password `12345678` |
| 3 | Doctors (Arzt) | 7 | 0 VOs each | pollutes the doctor picker |
| 4 | Heilmittel | 10 | prescribed on 0 VOs | pollutes the treatment catalogue |
| 5 | ICD codes | 25 | **not determinable from the API** | pollutes ICD search |
| 6 | Documented treatments | see below | — | clinical data on real patients |
| 7 | Notes on VOs | **26** on 21 VOs | — | clutter in the VO change log |

## 1. Announcement — the one with live user impact

```
id 21 · "test automation 1783055776722" · type general_announcement
active: true · deleted: false · createdBy sa.jhen@gmail.com · createdAt 2026-07-03T05:16:30Z
```

**This has been showing on the production Admin Board to every user for three months.** The test
created it, toggled it active, and asserted it appeared — then left it. It is the only item in this
inventory that users can see. The other live announcement (id 20, the GKV rule notice) is genuine
and must be kept.

## 2. User accounts — 9, all active

Pattern `automation_<epoch-ms>@gmail.com`, first/last name `Automation Test`, role
`ROLE_THERAPIST`, password `12345678`.

```
219  automation_1773361532102@gmail.com      262  automation_1781579029533@gmail.com
221  automation_1773898832210@gmail.com      263  automation_1781593854963@gmail.com
227  automation_1774946348520@gmail.com      264  automation_1781595061675@gmail.com
265  automation_1781673898194@gmail.com      266  automation_1781745273245@gmail.com
271  automation_1783056399023@gmail.com
```

All are `active: true`. **Each carries 0 VOs and 0 activities**, so nothing depends on them — but
each is a working production login with a weak, published password. These are the highest security
priority even though they have no data.

Note: `sa_team.spec.ts`'s two surviving tests (Edit User, Inactivate + Activate) search for
`automation` and act on these. Clearing them leaves those two tests without a fixture — retire them
in the same pass.

## 3. Doctors — 7, none on any VO

Patterns `SA<ts>` / `AutoArzt<ts>` (SuperAdmin spec) and `Jhen<ts>` / `Sala<ts>` (Admin and
Therapist specs). Several last names carry a second timestamp or a ` test` suffix because the
*Update* tests renamed them afterwards.

```
1833  SA1781578730777   AutoArzt-1783057594116      1846  SA1781673727929   AutoArzt-1781745072039
1838  SA1781594676914   AutoArzt-1783055800194      1859  SA1781745057415   AutoArzt1781745057415
1940  SA1783057577684   AutoArzt1783057577684       1837  Jhen1781594514108 Sala-1781594530557
1845  Jhen1781673585031 Sala-1781673600603
```

**All 7 are referenced by 0 VOs** (`?doctor=<id>`, with a control proving the filter narrows).

## 4. Heilmittel — 10, prescribed on nothing

Code `QA-<epoch-ms>`, description `QA Automation Treatment`, area PT, kind treatment, each with a
GKV price of 78,99 €.

```
111  QA-1773361508437    114  QA-1781578873594    117  QA-1781673818426    120  QA-1783057599141
112  QA-1773898778547    115  QA-1781594242459    118  QA-1781745164308
113  QA-1774946224464    116  QA-1781595136829    119  QA-1783056023598
```

**All 10 are prescribed on 0 VOs** (`?treatment=<id>`).

## 5. ICD codes — 25

Codes `QA-<ts>` (20) and `QA-DIAG-<ts>` (5), ids 46244–46268. Descriptions `QA Automation ICD …` or
`Diag ICD …`; many end in ` - updated` because the update tests renamed them.

**Whether any VO references these is NOT determinable from the API.** `/prescriptions` registers no
ICD filter at all — `icdCode`, `icd`, `icd.code`, `icdCodes.code`, `secondaryIcdCode` and
`exact[icdCode]` are each accepted and silently ignored (all return the unfiltered 41,213). Someone
with database access should check before deleting. The legitimate code `QA.10` matches a `code=QA`
search and must NOT be touched.

## 6. Documented treatments — scan in progress

The T-Board and `document_treatment` tests documented treatments on **real patients**, writing one
of three note strings:

| Note | Written by |
|---|---|
| `test admin` | `Admin/admin_tboard.spec.ts` |
| `test superadmin` | `SuperAdmin/sa_tboard.spec.ts` |
| `automation test` | `Therapist/document_treatment.spec.ts` (7 tests) |

**`/activities` registers no `notes` filter** — `notes=…` is accepted and returns the unfiltered
318,430, byte-identical to a bogus key — so these cannot be selected server-side and the window has
to be walked and filtered client-side.

Established so far: the QA therapist account (user **198**, `jhenqa@therapios.de`) has **228
activities and NOT ONE** carries any of the three notes. So the writes did not land on that
account — most likely on whichever therapist the T-Board picker selected. A walk of the 2026 window
is running; this section will be completed with the count, the dates and the **VO numbers only**.

**No patient names are recorded in this inventory**, here or anywhere else in it.

Whoever does the cleanup should treat this category differently from the rest: an Activity is
clinical documentation on a real patient's VO, it feeds revenue and billing, and `/activities`
exposes a `Delete`. Deleting one changes what that VO reports as treated. This needs the billing
team's decision, not a QA judgement call.

## 7. Notes added to VOs — COMPLETE: 26 notes on 21 VOs

The four CRM order specs each called `addNote('test automation')` as a bulk action, writing a
`prescription_log` of type `note` against every selected VO. All **16,417** `type=note` logs were
scanned (production holds 1,052,429 logs in total, so the `type` filter is what makes this
affordable).

**26 notes, every one reading exactly `test automation`, across 21 distinct VOs**, all in 2026:

| Date | Notes |
|---|---|
| 2026-03-13 | 2 |
| 2026-03-19 | 2 |
| 2026-03-31 | 1 |
| 2026-04-02 | 2 |
| 2026-06-16 | 8 |
| 2026-06-17 | 3 |
| 2026-06-18 | 4 |
| 2026-07-03 | 4 |

The bursts match CRM test runs — a bulk action notes every selected VO at once, which is why single
days carry 8 and 4.

VO numbers only, no patient data:

```
1426-39   Abgerechnet  1      3500-6    Archiviert   1      6449-3    Archiviert   1
1775-27   Archiviert   1      3557-5    Archiviert   1      6818-6    Abgerechnet  1
2000-28   Archiviert   1      5251-7    Archiviert   1      8173-2    Archiviert   1
261-38    Archiviert   1      5421-11   Archiviert   1      8647-1    Archiviert   1
2678-16   Archiviert   3      5496-7    Archiviert   1      8649-1    Archiviert   1
2928-24   Archiviert   1      5760-11   Abgerechnet  2      8650-1    Archiviert   1
3119-16   Abgelaufen   2      5972-2    Archiviert   1      8651-1    Archiviert   2
```

**17 of the 21 are Archiviert and 3 are Abgerechnet** — i.e. closed, already-billed VOs — so the
notes are cosmetic clutter in the change log rather than anything that affects billing. They are
the lowest-risk category in this inventory. A note is also the one kind of residue here that is
plainly identifiable by its own text, so a targeted cleanup is unambiguous.

## Method and caveats

- Everything above is a **GET**. Nothing was deleted, modified or created.
- Every count that rests on a filter was checked against a control proving the filter narrows,
  because this API **accepts unregistered filters and silently ignores them** — returning the whole
  collection, which reads exactly like "everything matches". That is how the ICD question in
  section 5 turned out to be unanswerable.
- Identifier patterns were recovered from the removed specs in git history (`git show 7ed331d^:…`),
  so they are exact rather than inferred from the data.
- Counts are as of 2026-10-02 and will drift if anyone runs the old specs from an older checkout.

## Suggested order of work

1. **Deactivate announcement 21** — the only item users can see, and a one-field change.
2. **Disable the 9 `automation_*` accounts** — working logins with a published password. They carry
   no data, so this is clean; retire `sa_team.spec.ts`'s two remaining tests at the same time,
   because they depend on these accounts existing.
3. **Delete the 7 doctors and 10 Heilmittel** — confirmed referenced by 0 VOs.
4. **Check the 25 ICD codes against the database first** (section 5), then delete.
5. **Leave the activities and VO notes to the billing team** (sections 6–7) — real patient records.
