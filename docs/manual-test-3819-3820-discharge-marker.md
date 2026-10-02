# Manual steps — #3819 / #3820, the Entlassmanagement marker and ordering

Everything verifiable read-only is in
`tests/Staging/SuperAdmin/sa_discharge_vo_marker.spec.ts` (8 tests) and
`tests/Staging/Admin/admin_crm_discharge_badge.spec.ts` (2 tests). This file records only the
steps that need a WRITE, and why the automated suite does not make them.

## #3820 AC1 / AC2 / AC3 — the positive path

**Why it is not automated.** Both ACs need a VO created with "Entlassmanagement" ticked, or the
checkbox ticked on an existing VO. Ticking is **not reversible in the way that counts**: AC4 says
unticking leaves the Folge-VO status alone, so the write is one-way per VO and would leave a real
VO sitting in "Bestellen" on the CRM ordering list the billing team works from.

**Why staging cannot show it today, which matters more.** Commit `b103c748dbc` carries a guard that
no AC states:

> Assumption: a discharge VO at a facility that orders its own follow-ups (praxis_vo /
> er_bestellt_selbst, #2617) keeps its status blank, as the nightly ordering run does.

**Every discharge VO created on staging since the deploy is at `QA Test ER`, a `praxis_vo`
facility**, so all of them are behind that guard and stay blank — which is correct behaviour and
looks exactly like the ticket not working. A PM following the ticket's own QA steps on
`99699-1`, `99700-1`, `99701-1`, `99703-1` or `99709-1` will see no "Bestellen" and should not
report it as a defect.

Staging holds **14 facilities of 268** that order their own follow-ups (13 `praxis_vo`, 1
`er_bestellt_selbst`).

### Steps

1. Pick a patient at a facility whose ordering mode is **not** `praxis_vo` / `er_bestellt_selbst`
   — i.e. whose VOs show Folge-VO ordering status "Vom Admin", not "Praxis". The four pre-deploy
   discharge VOs sit at such facilities (`CMS Wohn- und Pflegezentrum Bergeck`,
   `HEWAG Seniorenstift Neumühl`, `ER in Klärung`).
2. **AC1** — create a VO with "Entlassmanagement" ticked (discharge date and clinic filled in).
   Right after saving, check: Folge-VO status **Bestellen**, Bestelldatum **today**, and the
   Änderungsprotokoll showing one **automatic** entry with the reason
   **`Entlassmanagement-VO: Folge-VO sofort bestellen`**.
3. **AC2** — repeat from the previous VO form (v1) and from a scan in the Upload Dashboard, ticking
   the checkbox in the review form. The scan itself never ticks it.
4. **AC3** — take an existing VO with an EMPTY Folge-VO status at such a facility, tick
   "Entlassmanagement", save: the status turns Bestellen with the same date and log entry.
5. **AC4** — take one already in "Keine Folge-VO" and tick it: the status and its dates must not
   move. Then untick one: nothing changes.
6. **The guard itself** — repeat step 2 at a `praxis_vo` facility (e.g. `QA Test ER`): the status
   must stay blank. This is the behaviour the commit intends and no AC covers, so it is worth
   confirming with the PM rather than only testing.

### What the suite already proves without writing

- The guard is real and consistent: every post-deploy discharge VO is guarded, and the facility's
  ordering mode and the VO's ordering status agree on every one of them.
- **AC6** — the discharge VOs that were blank when the fix shipped are blank still, so nothing was
  back-filled.
- **AC5** — every discharge VO in "Bestellen" was moved there exactly once.
- **No log entry anywhere carries this fix's reason**, which is the other half of the finding: with
  the whole population guarded, "deployed" and "not deployed" are indistinguishable from a client.
  The commit adds no route and no serialized field, and `GET /status` reports the release, not the
  commit (#3704).

## #3819 — what is NOT covered

- **AC1's CRM Nachverfolgung row has no staging fixture.** The tab lists VOs whose Folge-VO status
  is `received` or `tracking`; walked over the 10,236 VOs issued since 2026-04-01, the 46 discharge
  VOs split `order` 21 / none 13 / `no_follow_up` 11 / `deceased` 1 — **zero** in either state. The
  badge is rendered by the one shared `DashboardTable` the Bestellung tab uses, so the surface is
  covered; what is missing is a row. To produce one, set a discharge VO's Folge-VO status to
  "Bestellt" and let it move to Nachverfolgung.
- **AC2's second half** — ticking and unticking "Entlassmanagement" and seeing the badge appear and
  go — needs the same one-way write as #3820 AC3 and is best done in the same pass as step 4 above.

## Fixtures

| What | Where |
|---|---|
| Discharge VO, the ticket's own | `9594-1`, practice **1610 Mauritius Therapieklinik** (its only VO) |
| Practice with BOTH kinds (AC2 control) | **755 JhenQA Medical Center** — 31 discharge, 154 normal |
| Deceased patient for the Verstorben comparison | VO `934201-99`, patient 8124 NikkiQA DingdingTest |
| Guarded facility | `QA Test ER` (`praxis_vo`) |

**Reaching the CRM fixture:** practice 1610 is **not** on "Heute bestellen" — #3885 took discharge
VOs off that tab — so search it from the **"Alle"** tab.
