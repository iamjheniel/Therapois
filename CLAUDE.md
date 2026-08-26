
# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

E2E test suite for the **Therapios** platform using Playwright. Therapios is a German healthcare management platform for physiotherapy practices. Tests cover three user roles — Admin, Therapist, and SuperAdmin — against both Staging and Production environments.

**Platform language:** German (UI labels, field names, and status values are in German)

## Commands

There are no custom npm scripts — run Playwright directly:

```bash
# Run all tests for a specific role (Staging)
npx playwright test --project=AdminJhen          # Staging Admin
npx playwright test --project=SandraZeibig       # Staging Therapist
npx playwright test --project=SAJhen             # Staging SuperAdmin

# Run all tests for a specific role (Production)
npx playwright test --project=AdminJhen-Prod     # Production Admin
npx playwright test --project=JhenQA-Prod        # Production Therapist
npx playwright test --project=SAJhen-Prod        # Production SuperAdmin

# Run a single spec file
npx playwright test tests/Staging/Admin/admin_search.spec.ts --project=AdminJhen

# Run by tag (mix and match role + feature tags)
npx playwright test --project=AdminJhen --grep "@CRMActivities"
npx playwright test --project=SAJhen --grep "@Abrechnung"
npx playwright test --project=SandraZeibig --grep "@uploadvo"

# Run headed (visible browser)
npx playwright test --project=AdminJhen --headed

# Re-generate auth state (do this when sessions expire)
npx playwright test --project=setup             # Staging auth
npx playwright test --project=setup-prod        # Production auth

# View HTML report
npx playwright show-report
```

## Project Structure

```
.auth/                              # Saved session state files (JSON, gitignored)
Pages/                              # Page Object Model classes
  admin/
    admin.arzt-management.page.ts   # Arzt (doctor) management actions
    admin.vo-validation.page.ts     # VO edit form Validierung panel, save dialogs, creation-validation state PATCHes (RC 3.11 #3339, #3340)
    admin.optica-export.page.ts     # Optica GKV export + billing-readiness error codes, VO/practice BSNR lookups (RC 3.11 #3288)
    admin.patient-addresses.page.ts # Patient-form ADRESSEN section: Adresstyp, Anrede, billing switch (RC 3.10)
    admin.letters.page.ts           # Vorabinformation generation + letter PDF text + address-marker scanning (RC 3.11)
    admin.rebranding-banner.page.ts # Curano rebrand banner: entity isRebranded, banner copy/placement, PDF text per document type (RC 3.11.2 #3481)
  base/
    app.page.ts                     # Shared base page helpers
  crm/
    crm.base.page.ts                # CRM navigation + shared actions
    crm.list.page.ts                # CRM practice list interactions
    crm.activities.page.ts          # CRM activity creation/editing
    crm.follow-up-orders.page.ts    # CRM follow-up order actions
    crm.initial-orders.page.ts      # CRM initial order actions
  superadmin/
    sa.abrechnung.page.ts           # Abrechnung (billing) VO validation
    sa.icd-management.page.ts       # ICD code management
    sa.patient-management.page.ts   # Patient management
    sa.flow-boards.page.ts          # Flow Boards Management board (RC 3.10) + its /kpis/management* API probes
    sa.treatment-prices.page.ts     # Treatment price entries + the retroactive recompute, incl. read-only tariff/insurance reads (RC 3.11 #3378)
    sa.invoice-pdfs.page.ts         # Invoice/Storno/bulk-zip downloads + stored-vs-rebuilt detection (RC 3.11 #3332, #3333)
    sa.copayment-exclusions.page.ts # TheOrg-invoiced Blanko VO exclusion list + invoice_created provenance logs (RC 3.11.1 #3426)
    sa.board-filters.page.ts        # The nine board providers' /kpis/* endpoints + response canonicalisation (RC 3.11 #3311)
    sa.ordering-lead-time.page.ts   # Per-practice leadTimeDays/Source/Clamped, VO followupStatus/orderingStatus, follow-up status logs (RC 3.11 #3298, #3299, #3302)
    sa.billing-archived.page.ts     # /billing tabs + copaymentBilling/pkvBilling treatmentStatus & property-keyed search (RC 3.11 #3277)
  therapist/
    therapist.board-v2.page.ts      # Therapist Board v2 desktop table: column picker, widths, expanded row (RC 3.11)
    therapist.untreated-days.page.ts # "Tage seit Beh." per-patient measure: board payload capture, 14+ hint, Behandlungslücke filter, column sort (RC 3.11.1 #3471)
  util/
    pdf-text.ts                     # Reads text out of the generated letter PDFs (subset fonts + /ToUnicode)
    query-cache.ts                  # React Query offline-cache snapshots, localStorage ballast, Sentry envelope capture (#3385)
tests/
  Staging/
    Admin/                          # 33 spec files — project: AdminJhen
    SuperAdmin/                     # 51 spec files — project: SAJhen
    Therapist/                      # 20 spec files — project: SandraZeibig
  Production/
    Admin/                          # 13 spec files — project: AdminJhen-Prod
    SuperAdmin/                     # 26 spec files — project: SAJhen-Prod
    Therapist/                      # 12 spec files — project: JhenQA-Prod
  auth.setup.ts                     # Generates .auth/ session files for Staging
  production.auth.setup.ts          # Generates .auth/ session files for Production
playwright.config.ts
```

## Playwright Projects & Auth

| Project | Role | Environment | Auth file |
|---|---|---|---|
| `setup` | — | Staging | generates all Staging `.auth` files |
| `AdminJhen` | Admin | Staging | `.auth/AdminJhen.json` |
| `SandraZeibig` | Therapist | Staging | `.auth/SandraZeibig.json` |
| `SAJhen` | SuperAdmin | Staging | `.auth/SuperAdmin.json` |
| `setup-prod` | — | Production | generates all Production `.auth` files |
| `AdminJhen-Prod` | Admin | Production | `.auth/AdminJhen-Prod.json` |
| `JhenQA-Prod` | Therapist | Production | `.auth/JhenQA-Prod.json` |
| `SAJhen-Prod` | SuperAdmin | Production | `.auth/SuperAdmin-Prod.json` |

- **Staging base URL**: `https://staging.therapios.de/`
- **Production base URL**: `https://app.therapios.de/`

## Test Accounts

| Role | Staging | Production |
|---|---|---|
| Admin | admin.jhen@therapios.de | admin.jhen@therapios.de |
| Therapist | sandra.zeibig@therapios.de | jhenqa@therapios.de |
| SuperAdmin | sa.jhen@gmail.com | sa.jhen@gmail.com |

## Test Inventory

### Admin (Staging) — `tests/Staging/Admin/`

| File | Tags | What it tests |
|---|---|---|
| `admin_search.spec.ts` | `@Admin @AdminSearchActiveVo @AdminSearchAbgebrochenVo @AdminSearchFertigbehandeltVo @AdminSearchAbgelaufenVo @AdminSearchDoctor` | Search by VO status (Active, Abgebrochen, Fertig behandelt, Abgelaufen) and by doctor/facility |
| `admin_checkcolumns.spec.ts` | `@Admin @columns` | Admin Board column inventory: the heading total equals the pager total, the default headers render, and the "Spalten" chooser's full 37-column list + its 10 checked defaults + its "10/37" summary are asserted off the `[role="checkbox"][aria-label]` rows. "VO #"/"PATIENT" are fixed and must not be offered |
| `admin_dashboard.spec.ts` | `@Admin @DashboardSearch @DashboardQuickFilter @DashboardFolgeVoFilter @DashboardFilterPanel @DashboardColumnToggle @DashboardPageSize` | Admin Board top-bar and pager controls: free-text search (by VO number + patient name, captured live from row 1); summary status pills as quick filters (applied total == pill badge; "Alle VOs" restores); the "Filter" panel — its live "N VOs anzeigen" preview matching what the table then shows, its applied-filter badge, all 12 sections present, "Filter löschen" restoring the full list — including the "Folge-VO Status" filter inside it; the "Spalten" chooser hides/restores a column; "Zeilen pro Seite" changes the rendered row count without moving the total. Uses `Pages/admin/admin.dashboard.page.ts` |
| `admin_documents.spec.ts` | `@Admin @DocumentAddNoteAdmin @DocumentSearch @DocumentStatusChange` | Document search by ID/therapist name, add note, update inline status |
| `admin_pagination.spec.ts` | `@Admin @pagination` | Admin Board pager: "›"/"‹" arrows step a page each way, page numbers jump, and a full first page holds exactly one page-size worth of rows (asserted against the "Zeilen pro Seite" selector and the painted row count) |
| `admin_arzt_management.spec.ts` | `@Admin @ArztManagement` | Create and update Arzt (doctor) records |
| `admin_uploadprescription.spec.ts` | `@Admin @AddNoteUploadVO @SearchUploadVO @updateStatusUploadVO` | Upload dashboard: search VOs, add notes, update status |
| `admin_crm_practice.spec.ts` | `@Admin @CRMFilters` | CRM practice list filtering |
| `admin_crm_activities.spec.ts` | `@Admin @CRMActivities @CRMCreateIssue @CRMResolveIssue` | CRM: create activity, create issue, resolve issue |
| `admin_crm_follow-up-orders.spec.ts` | `@Admin @CRMFollowUpOrder` | CRM follow-up order actions |
| `admin_crm_initial-order-change-status.spec.ts` | `@Admin @CRMInitialOrder` | CRM initial order status changes |
| `admin_tboard.spec.ts` | `@Admin @AdminDoku` | T Board document treatment flow. The therapist picker is a "Therapeut:in wählen" button opening a searchable `[role="dialog"]` (the old "Therapist: (Select)" text trigger is gone), and the Doku modal is driven through `DokuModalPage`; the save outcome is asserted against the four legitimate results |
| `admin_reports.spec.ts` | `@Admin @Reports @ReportsDateFilter @ReportsExport @ReportsTherapieformFilter` | Reports page: date filter, therapieform filter, export |
| `admin_crm_tabs.spec.ts` | `@Admin @CRMTabs` | RC 3.9 (#2932) CRM 5-tab split: "Heute bestellen" / "Heute nachverfolgen" / Geplant / Mit Problemen / Alle, each with a badge count; each tab loads the table |
| `admin_crm_filter_scoping.spec.ts` | `@Admin @CRMRegionScope @CRMErFilter` | RC 3.9 (#2931 region + #2936 ER/"Einrichtung") filters re-scope the 5 summary cards + tab counts (Alle total changes, ≥1 card changes; clearing restores). ER dropdown lists elderly-care-homes with a search box |
| `admin_crm_fachrichtung.spec.ts` | `@Admin @CRMFachrichtung` | RC 3.9 (#2934) Fachrichtung: CRM table column; filter dropdown with all 7 specialties (Allgemeinmedizin…Sonstige) scoping the table (note: scopes rows, not tab badges); practice edit-form dropdown (opened + verified, never saved) |
| `admin_crm_activity_flexibility.spec.ts` | `@Admin @CRMActivityFlex` | RC 3.9 (#2935) Aktivitäten tab: history entries have an "Edit" control (edit mode opens — cancelled, not saved); "Nächste Aktivität planen" scheduler opens independently of documenting the current activity |
| `admin_crm_german_translation.spec.ts` | `@Admin @CRMTranslation @CRMLastActivity` | RC 3.9 (#2937) German strings across dashboard + Aktivitäten/Bestellung/Nachverfolgung tabs (incl. "Bestelt"→"Bestellt" typo fix, "In Transit"→"In Zustellung"); plus #2933 "Letzte Aktivität" column presence + dates |
| `admin_deceased_marking.spec.ts` | `@Admin @DeceasedMarking` | RC 3.9 (#2996) "Als verstorben markieren" action on the patient form: opens a confirmation dialog listing active VOs (VO-Nummer/Therapie/Behandlungsstatus) — cancelled, never confirmed; deceased patient shows the banner + admin sees no Mark/Undo |
| `admin_deceased_indicators.spec.ts` | `@Admin @DeceasedIndicators` | RC 3.9 (#2997) Patienten-Management "Verstorben: Ausblenden" filter (default hides deceased) → "Alle anzeigen" reveals the "Verstorben" badge; Admin Board inline "Verstorben" indicator (uses deceased QA patient NikkiQA DingdingTest) |
| `admin_deceased_vo_warning.spec.ts` | `@Admin @DeceasedVoWarning` | RC 3.9 (#2998 AC1) selecting a deceased patient in Create-VO shows the non-blocking warning ("Dieser Patient ist als verstorben markiert…"); VO never created |
| `admin_pkv_billing_translations.spec.ts` | `@Admin @PkvTranslations` | RC 3.9 (#2951) PKV-Abrechnung (/billing) invoice-status subtabs render German: Alle/Fehler/Nicht gesendet/Gesendet/Überfällig/Gemahnt/Inkasso/An Inkasso gesendet/Bezahlt/Storniert/Pausiert; English subtab labels gone |
| `admin_pkv_billing_eti.spec.ts` | `@Admin @PkvEtiSubmission @PkvEtiOutcome` | RC 3.9 ETI Debt Collection (#2949/#2950): "An ETI Experts senden" + "Als bezahlt/uneinbringlich markieren" are scoped away from non-Inkasso/Sent-to-DC subtabs (asserted on Gesendet); positive submission/outcome dialogs are data-gated (0 Inkasso & 0 Sent-to-DC invoices on staging) → attempt-and-skip, never confirmed |
| `admin_flow_boards_access.spec.ts` | `@Admin @FlowBoards @FlowBoardsAccess` | RC 3.10 (#3173 AC2) Admin half of the Flow Boards access gate: no "Flow Boards" nav entry, `/flow-boards` renders no board content, and all five `/kpis/management*` endpoints return 401/403 for the Admin's own bearer token |
| `admin_guardian_address_form.spec.ts` | `@Admin @GuardianContacts @GuardianAddressForm` | RC 3.10 (#3188) patient-form Adresstyp: 4 options (Pflegeheim / Gesetzliche/r Betreuer/in… / Angehörige/r / Sonstiges), existing addresses migrated to `care_home`; Pflegeheim hides Anrede + "Name der Person" while person types reveal them (and switching back re-hides); a saved person-type address persists `type`/`salutation`/`personName` and stays non-billing; the Rechnung toggle keeps exactly one billing address (the active switch is `disabled`). Only the save test mutates, and it deletes what it created |
| `admin_guardian_import.spec.ts` | `@Admin @GuardianContacts @GuardianImport` | RC 3.10 (#3189) verifies the state the TheOrg import must leave behind — the apply-mode run HAS happened on staging (89 guardian addresses per 1,000 patients scanned): Care Home addresses preserved (New branch) with no duplicate for Convert-branch patients, exactly one billing address per affected patient (AC9), mapped relationship types + Frau/Herr salutations + names present, deceased patients included (AC8). The "guardian is billing" test is `fixme`'d on a real defect (Pat-Nr 2752). Preview/apply modes and the change report are console-only → `fixme` |
| `admin_guardian_documents.spec.ts` | `@Admin @GuardianContacts @GuardianDocuments` | RC 3.10 (#3190) asserts the routing data all 6 renderers key off: guardian billing addresses carry a person type + name + address, salutations are Frau/Herr or absent (the AC3 fallback), and Care Home billing addresses with a contact name stay `care_home` (AC4 regression); the per-invoice "Rechnung neu erstellen" control exists with no bulk tool (AC6) and letters expose create + per-row actions (AC7). Recipient-block/greeting ACs are `fixme` — the 6 document types are PDF-only with subset CID fonts, so their text is not extractable without a PDF library |
| `admin_guardian_gkv_export.spec.ts` | `@Admin @GuardianContacts @GuardianGkvExport` | RC 3.10 (#3191) fetches `GET /billing_batches/{id}/optica-export` (capped at 60 s) and asserts no guardian street appears in the §302 claim file; AC4's fallback checked on patients with no Care Home address. Skips when no batch is exportable (a `pending` batch answers 422 and an eligible one exceeded 45 s live). DATEV debtor records → `fixme`, no readable export surface |
| `admin_optica_bsnr.spec.ts` | `@Admin @OpticaExport @BsnrPerVo` | RC 3.11 (#3288) the Optica GKV file must submit the VO's own BSNR. Asserts the AC1/AC3 preconditions live (VOs carry their own `bsnr`; 12 of 26 recent ones differ from their practice's main number — e.g. VO 965110-3 keeps the practice's *secondary* 723838300 against main 06132013) and AC4 through the readiness check, which reports per-VO codes on `GET /billing_batches/{id}/optica-export`: no VO with its own BSNR is flagged MISSING_BSNR. The exported file itself is unreachable on staging — all 50 batches fail (5 `pending` → 422, 45 blocked: 1,931 MISSING_INSURER_IK, 1,930 MISSING_VERSICHERTENSTATUS, 1,274 MISSING_POSITION_NUMBER, 8 MISSING_LANR, 2 MISSING_BSNR) and no batched VO has an own BSNR → `fixme`. **Finding:** the fallback reads the DOCTOR's practice, not the VO's, so doctorless hospital VOs (8986-1, 3447-27) are blocked although their practice holds a main BSNR → `fixme`'d AC2 test. Uses `Pages/admin/admin.optica-export.page.ts` |
| `admin_home_visit_validation.spec.ts` | `@Admin @HomeVisit @CreationValidation` | RC 3.11 (#3339) the Hausbesuch toggle and the Home Visit check must agree. Repro VO 1434-32: stored `homeVisit` true, check **50 `home_visit_expected_for_care_facility`** passed, form toggle on and "Hausbesuch" absent from the FEHLGESCHLAGEN list; control VO 4823-5 (facility, no HBH-*, toggle off) still fails with the German message; a sweep of 716 non-closed VOs finds 619 with an HBH-* remedy + Einrichtung and **0** with the flag off (AC3's population); the for_fixing queue is used to compare stored verdicts against the toggle. Traps: the check is id 50, not id 3 `home_visit_marked`; the facility is `elderlyCareHome`, not `entity`; `homeVisit`/code/facility API filters are silently ignored. AC3/AC4 backfill → `fixme` (console command). Uses `Pages/admin/admin.vo-validation.page.ts` |
| `admin_letter_country_marker.spec.ts` | `@Admin @LetterAddress @CountryMarker` | RC 3.11 (#3370) the stray country marker "D" in printed addresses. Generates a fresh Vorabinformation (both Regulär and Blanko variants) for the ticket's repro patient 9020 and reads the text back out of the PDF via `Pages/util/pdf-text.ts` — the street line must print clean; a pre-fix archived letter is read alongside it to prove the before/after (stored PDFs are **not** corrected retroactively). AC1's house-number edge case runs on patient 8837 ("Albert-Wiebach-Str. 1D, D 14513 Teltow", the ticket's own example). Optica export asserted when a batch is exportable (all staging batches answer 422). ETI/DATEV and the four invoice-driven letter types → `fixme`; SPACE-separated house-number letters → `fixme` on a real defect ("Essener Straße 13 D" prints as "Essener Straße 13") |
| `admin_rebranding_banner.spec.ts` | `@Admin @RebrandingBanner @ReadOnly @Mutating` | RC 3.11.2 (#3481) the Curano rebranding banner on outgoing documents. **NOT DEPLOYED on staging** (v3.11.0; ticket OPEN against 3.11.2) — the deployment probe runs on every execution and re-derives that verdict, the five AC tests are `fixme`/data-gated until it ships. Evidence: a Vorabinformation generated TODAY for a Curano-branded entity carries no banner and no "Therapios" string, its layout leaving exactly the gap AC1 targets (recipient block → date line, nothing between); a PKV invoice, GKV copayment invoice and Storno read the same way. It is **not an off-switch**: `/entities/{id}` exposes only `isRebranded` (no banner field) and `/settings`, `/system_settings`, `/app_settings`, `/configurations`, `/feature_flags`, `/branding_settings` all 404, so AC4's control does not exist yet. **Two standing gaps:** AC2 has no fixture — all 7 staging entities are `isRebranded: true`; and only 4 of the 7 document types are reachable (Vorabinformation, PKV, GKV copayment, Storno), with Hono/IB/TB reported rather than implied. AC5's frozen/live split is already observable — a PKV invoice issued 20.07.2026 prints "Therapios Hamburg 1 GmbH" while a copayment issued today prints "Curano Hamburg GmbH", the same entity under two frozen names. Uses `Pages/admin/admin.rebranding-banner.page.ts` |

### Therapist (Staging) — `tests/Staging/Therapist/`

| File | Tags | What it tests |
|---|---|---|
| `uploadprescription.spec.ts` | `@Therapist @uploadvo @AddNoteTherapist` | Upload VO (prescription), view and add note |
| `document.spec.ts` | `@Therapist @uploadcopayment @uploadpatientinfo @uploadHonorarvereinbarung @uploadsontiges @AddNoteTherapistCopayment` | Upload copayment, patient info, Honorarvereinbarung, Sonstiges documents; add note to copayment |
| `document_treatment.spec.ts` | `@Therapist @singleregular @multipleregular @plannedtreatment @rejecttreatment @bvtreatment @doppelbeh @validationerror @activity` | Document treatments through the redesigned "Doku erfassen" modal (see the Board Redesign section): single/multiple patients (multi-patient entries ship collapsed and are expanded first), planned, reject, BV, Doppel-Behandlung; validation errors; an activity entry ("Aktivität" appends a "Pause" needing a duration). Saves are classified `saved / conflict / rejected / blocked` because a duplicate is refused silently — the two silent-failure paths are `fixme`'d here with evidence. `@singleregular` still stops at the tracked Doku-panel selector gap |
| `check_doku.spec.ts` | `@Therapist @checkdoku @checkdokuclose @checkdokunote @checkeditactivity @checkdokusections @checklogs` | Doku panel: open/close, notes, edit activity modal, Behandlungsverlauf + Logs sections |
| `search.spec.ts` | `@Therapist @searchname @searchvo @searchunknownname @searchunknownvo @searchclear @searchlocation` | Board search by name and by a live VO number; the redesigned empty state ("Keine VOs für diese Auswahl") for an unknown name/VO, cross-checked against the row count and the heading summary; the "✕" control clearing a search back to the full board; and facility filtering, which now runs off the Filter panel's EINRICHTUNG section rather than a location dropdown |
| `calendar.spec.ts` | `@Therapist @calendar @editcalendar` | Calendar view and edit. The period arrows are icon-only buttons ("Vorherige Woche" — "Vorh." is gone) and appointment cards read "`n / m (N mins)`" rather than a clock time, so cards are matched on the duration |
| `notification.spec.ts` | `@Therapist @notification @bellnotification @markasread` | Banner notification, bell notification, mark as read |
| `share_patient.spec.ts` | `@Therapist @sharepatient @removesharedpatient` | Share patient with another therapist and remove shared access |
| `transfer_patient.spec.ts` | `@Therapist @transferpatient` | Transfer patient action: opens the "Patienten übertragen" modal, waits past its "Wird geladen …" placeholder, asserts the immediacy warning plus the Patient / VO Nr. / Einrichtung / Arzt confirmation columns (matched on `textContent`, since the headers are CSS-uppercased), and picks a target therapist from the `[role="dialog"]` picker; cancels without committing (transfer is irreversible) |
| `dashboard_actions.spec.ts` | `@Therapist @reviewbanner @bestelltvon` | The two controls the redesign re-homed: the review reminders, now sections of the **Hinweise** panel (headline counts + a "Diese anzeigen" control each; the 14-day section names the patients behind its count) instead of yellow "Überprüfen" banners; and "Bestellt von", now on the **row-selection action bar** — ticking a row raises "N ausgewählt / Auswahl aufheben / Doku erfassen (N) / Bestellt von / VO abbrechen / Patient transferieren", and the dropdown offers Therapeut/Admin without committing the follow-up-VO order. Both data-gated. The Production mirror still drives the old banner surface |
| `VO_termination.spec.ts` | `@KFvo` | Non-immediate VO termination (Keine Folge-VO bestellen) |
| `assessment_ib.spec.ts` | `@Therapist @assessment @IB` | Dashboard BF (Befund/Assessment) and IB (Initialbefund) columns. **BF ships opt-in now**, so its tests assert it is absent, enable it from the "Spalten" picker, then assert it lands in the table with a cell per row; IB is still a default column. Both open their modal from the row cell via `v2-cell-<key>` (skips when the control is inert for the patient state) |
| `therapist_deceased.spec.ts` | `@Therapist @DeceasedIndicators @DeceasedEscalation @DeceasedMarking` | RC 3.9 (#2995): T Board "Verstorben" indicator (#2997 AC5); VO termination offers the "Patient*in verstorben" reason that escalates to a patient-level confirm (#2998 AC2 — trigger verified, never confirmed); therapists have no Patienten-Management / Mark-as-Deceased surface (#2996 AC1) |
| `ib_signature_overlay.spec.ts` | `@Therapist @IBSignatureOverlay` | RC 3.9 (#2962) IB Infoblatt full-screen signature overlay: opens from "Unterschreiben", dashed baseline, Undo/Löschen, "Fertig" gated on empty canvas, drawing enables controls, Undo/Clear reset, empty-Cancel closes immediately, Cancel-with-strokes raises "Unterschrift verwerfen?" discard prompt, both DSGVO + Behandlung steps. Never submits an IB; data-gated |
| `ib_typed_signature.spec.ts` | `@Therapist @IBTypedSignature` | RC 3.9 (#2963) typed-name fallback: "Unterschrift nicht möglich? Namen eingeben" switches to a name input (pre-filled) + "Ich bestätige…" checkbox; Fertig gated on name+checkbox; "Zurück zum Zeichnen" returns to draw mode |
| `ib_signer_relationship.spec.ts` | `@Therapist @IBSignerRelationship` | RC 3.9 (#2964) IB signer dialog ("Wer unterschreibt?") relationship options (Patient/in, gesetzliche/r Betreuer/in, Bevollmächtigte/r) in a radiogroup; "Weiter" gated until a signer is chosen; each proceeds into the wizard (persistence AC needs a submitted IB → out of scope) |
| `ib_accessibility.spec.ts` | `@Therapist @IBAccessibility` | RC 3.9 (#2965) IB a11y: the signer options are announced by a meaningful accessible name, the wizard's `aria-modal` focus trap + "Sprache wechseln" toggle, the signature field's "Unterschriftenfeld" aria-label. The AC's *descriptive `aria-label`s inside a `[role="radiogroup"]`* are `fixme`'d on a live a11y regression — both the labels and the radiogroup wrapper are gone. IB-table actions + discipline badges live on the patient-profile surface → skip cleanly from the therapist view |
| `therapist_board_desktop_layout.spec.ts` | `@Therapist @TBoardV2 @BoardLayout` | Therapist Board **v2** desktop table at `/therapist/` (originally RC 3.11 #3362, re-verified against the current build): the default column set renders exactly the 8 expected headers and fits a 1440px viewport with no horizontal scroll (measured on `v2-table-scroll-port`, not the document, which never overflows), with per-column widths logged; the Spalten picker reports **5/17** with all 12 opt-in columns present but unchecked, re-enabling one puts it back in the table and bumps the summary to 6/17, and the picker persists the checked set to `column-select-therapist-board-v2` by column KEY (surviving a reload); no BF badge keeps a long-form discipline label; the expanded row leads with Doku erfassen / Aktivität erfassen / IB with the three displaced actions under "Weitere ▾"; 1000px gets the table and 810px the card list. AC2 → `fixme` (withdrawn by the PM in favour of #3386); the "PT" badge → `fixme` on a live defect (Physiotherapie badges as "P"). **Two surfaces share `/therapist/`** — clicking a patient NAME leaves v2 for the legacy board every other therapist spec drives, so rows are expanded by clicking a data cell |
| `therapist_board_toolbar.spec.ts` | `@Therapist @TBoardV2 @BoardToolbar @BoardFilters` | The controls around the v2 table: the "N VOs · M aktiv" heading agreeing with the "Meine VOs" tab badge, the "Aktive Patienten" group count and the painted row count; the three `role="tab"` tabs + the "Hinweise" button + the offline-queue status line, with "Geteilte VOs" re-scoping the table to its badge count; the Filter panel's EINRICHTUNG / VO STATUS / BEHANDLUNGSLÜCKE sections, its live "Ergebnis: N VOs" preview, the 14-day gap filter never widening the board and "Alle löschen" restoring it; and the active/inactive row grouping. Tab and group tests are data-gated |
| `therapist_flow_boards_access.spec.ts` | `@Therapist @FlowBoards @FlowBoardsAccess` | RC 3.10 (#3173 AC2) Therapist half of the Flow Boards access gate: no nav entry, `/flow-boards` renders no board content, all five `/kpis/management*` endpoints return 401/403 |
| `offline_cache_quota.spec.ts` | `@Therapist @OfflineCache @QuotaRecovery` | RC 3.11 (#3385) React Query offline cache vs. the localStorage quota. Shrinks the free space with ballast instead of growing the cache: with ~140KB free the persister evicts and keeps writing (234KB/6 queries → 31KB/5, no Sentry event); with none free it walks a shrinking retry ladder, reports **once** per session (8 failed writes → 1 event) with a `persisted_cache` context, and the app stays usable. Also asserts no patient data in that context. `largest[]` arrives as `[Object]` and Sentry is currently rate-limiting **error** events org-wide → both `fixme`'d with evidence; W1 (offline mutations survive eviction) is `fixme`'d as write-heavy. Uses `Pages/util/query-cache.ts` |
| `therapist_untreated_days.spec.ts` | `@Therapist @TBoardV2 @UntreatedDays` | RC 3.11.1 (#3471) "Tage seit Beh." is a property of the PATIENT, not of a VO row. **Read-only** — it reads the board's own `GET /therapist-prescription-groups` response as the page loads it (never a hand-built query, so the rows asserted are exactly the rows painted) and drives filter/sort/hint controls only. Asserts the rollup over the whole caseload: every VO row of a patient carries one value (0 of 17 multi-VO patients disagree), that value is the patient's most recent treatment on a **non-terminal** VO recomputed independently from `lastTreatmentDate`, and a patient with no treatable treatment reports **no value at all** — the API OMITS the field (so it reads `undefined`, never `null` or `0`) and the column paints a dash "–" (51 of 79 rows on this board). The 14+ hint reads "6 Patienten seit 14+ Tagen nicht behandelt" against 7 qualifying rows — the dedupe visible in one number; the BEHANDLUNGSLÜCKE option "Seit 14+ Tagen unbehandelt" previews and paints exactly the 7 rows, all ≥14; sorting the column orders by the corrected value (a dash sorts as 0, `?? 0`) and never splits a patient's rows apart. **Traps:** the applied-filter chip bar grows its OWN "Alle löschen", which `openFilterPanel()` mistakes for an open panel — with `actionTimeout` at 0 the click that follows hangs the whole test, so `clearGapFilter()` opens the panel by hand; and a served value must be compared against ONE resolved "today" (`resolveToday()`), or two treatment dates a day apart both "agree". **Finding:** the fix excludes **Abgelaufen and Abgebrochen** on top of the ticket's three statuses — 6 of Sandra's 49 patients (e.g. 8259 Lisa MontanaTest, 947201-1 [Abgebrochen] 2026-07-20) read "–" where AC2 as written yields a real gap, so they can never reach the hint → `fixme`'d for the PM. Uses `Pages/therapist/therapist.untreated-days.page.ts` |

### SuperAdmin (Staging) — `tests/Staging/SuperAdmin/`

| File | Tags | What it tests |
|---|---|---|
| `sa_search.spec.ts` | `@SuperAdmin @SuperAdminSearchActiveVo @SuperAdminSearchAbgebrochenVo @SuperAdminSearchFertigbehandeltVo @SuperAdminSearchAbgelaufenVo` | SA search by VO status |
| `sa_checkcolumns.spec.ts` | `@SuperAdmin @columns` | SA dashboard columns verification |
| `sa_document.spec.ts` | `@SuperAdmin @DocumentAddNoteAdmin @DocumentSearch` | SA document search and add note |
| `sa_pagination.spec.ts` | `@SuperAdmin @pagination` | SA pagination on Flow page |
| `sa_arzt_management.spec.ts` | `@SuperAdmin @ArztManagement` | SA Arzt management |
| `sa_uploadvo.spec.ts` | `@SuperAdmin @AddNoteUploadVO @SearchUploadVO` | SA upload VO: search, add note |
| `sa_team.spec.ts` | `@SuperAdmin @accountcreation @edituser @inactivateuser` | Team management: create account, edit user, inactivate/activate |
| `sa_heilmittelverwaltung.spec.ts` | `@SuperAdmin @heilmittel @SuperAdminCreateHeilmittel @SuperAdminSearchHeilmittel @SuperAdminFilterBereich @SuperAdminFilterKind @SuperAdminDownloadVorlage @SuperAdminImportLogs` | Heilmittelverwaltung: create, search, filter by Bereich/Kind, download template, view import logs |
| `sa_icd_management.spec.ts` | `@SuperAdmin @ICDManagement` | ICD code management |
| `sa_patient_management.spec.ts` | `@SuperAdmin @PatientManagement` | Patient management |
| `sa_announcement.spec.ts` | `@SuperAdmin @announcement` | Create system announcement |
| `sa_abrechnung.spec.ts` | `@SuperAdmin @Abrechnung @VOValidation` | Abrechnung (billing) VO validation workflows |
| `sa_deceased_undo.spec.ts` | `@SuperAdmin @DeceasedUndo` | RC 3.9 (#2996 AC5/AC8): on a deceased patient's form a Super Admin sees the "Markierung 'Verstorben' rückgängig machen" (Undo) action + banner (admins don't); never clicked (would restore terminated VOs) |
| `sa_flow_boards_shell.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsShell` | RC 3.10 (#3173) Flow Boards shell: "Flow Boards" nav entry beside "KPI Dashboard"; 5-board tab switcher (Management default); the 4 unbuilt boards show only "In Vorbereitung" (no filters/cards/buckets); Gesellschaft selector lists "Alle Gesellschaften" + each company and narrows the therapist population |
| `sa_flow_boards_filters.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsFilters` | RC 3.10 (#3174 AC1–6) filter bar: Zeitraum range picker + auto-derived Tag/Woche/Monat level; period arrows step one unit with the forward arrow disabled at the current period; therapist (with Search box) + TO-team ("Ohne TO-Team") selectors narrow the board; GKV/PKV and Einrichtung/Praxis partition the treated revenue |
| `sa_flow_boards_kpi_cards.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsCards @FlowBoardsValidatedRevenue` | RC 3.10 (#3174 AC7–10 + #3175) KPI cards: 4 live cards + targets ("Ziel 85,0 %" / "Ziel 42,00 €") + trend %; 3 "In Vorbereitung" cards; equal-length previous-period comparison asserted from the API's compareFrom/compareTo window; zero-Personio-hours exclusion via the Grau bucket; "Umsatz validiert" ≤ treated, == the waterfall Validiert step, GKV+PKV additive. Status transitions (AC3/4/6) fixme'd — period-scoped card + no archived staging data |
| `sa_flow_boards_buckets.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsBuckets` | RC 3.10 (#3176) traffic-light buckets: Rot/Gelb/Grün/Grau labels + ranges; the 4 counts partition the therapist rows exactly; counts recompute on filter change; clicking a bucket narrows the flat table to exactly its count and re-clicking restores; team rows stay visible in Gruppen view |
| `sa_flow_boards_waterfall.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsWaterfall` | RC 3.10 (#3177) revenue waterfall: Erarbeitet == treated card, Validiert == validated card, "− n. validiert" == the difference; 5 coming-soon steps; live Privatanteil badge vs. the patient-count-based Privatpatient:innen card asserted as intentionally different formulas |
| `sa_flow_boards_detail_table.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsDetailTable` | RC 3.10 (#3178) detail table: Gruppen/Therapeut:innen views + live and coming-soon columns; team rows + "Ohne TO-Team" member counts sum to the flat therapist count; expanding a team lists members and its Effizienz is falsified against the mean of member percentages; sortable headers toggle direction; ⚠ Zeiterfassung is per-therapist only |
| `sa_flow_boards_trend_chart.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsTrend` | RC 3.10 (#3179) trend chart: 12 periods at the filter-bar level (`?level=woche/monat` on `/kpis/management/trend`); 3 live metric toggles + 3 disabled; series selector offers Gesamt / "Team [name]" / "Ohne TO-Team"; filter changes re-request the trend data |
| `sa_flow_boards_billing_backlog.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsBacklog` | RC 3.10 (#3180) Abrechnungs-Stau: banner count + "≈ … € direkt abrechenbar"; drill-down grouped by TO team → therapist with "N VOs · X €" subtotals; per-VO rows (VO-Nr, patient initials only, Heilmittel, "n Wo.", "n Tage", revenue); no row younger than 6 weeks; row count == banner count; validation status is deliberately not a filter |
| `sa_flow_boards_download.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsDownload` | RC 3.10 (#3181 AC2) the CSV download is Kian/Dennis-only: no download control for the QA Super Admin **and** `POST /kpis/management/export` returns 403 while `GET /kpis/management` still returns 200 (proving a second, narrower gate). AC1/3/4 skipped — no allowlisted staging account |
| `sa_flow_boards_test_account.spec.ts` | `@SuperAdmin @FlowBoards @FlowBoardsTestAccount` | RC 3.10 (#3182) Testkonto flag: the "Nutzer bearbeiten" panel offers a second checkbox labelled "Testkonto", off ("Nein") by default — opened and cancelled, **never saved** (the panel's active=false defect would deactivate the SandraZeibig login). Exclusion ACs are data-gated: no staging account is marked yet (go-live prerequisite) |
| `sa_to_efficiency_window.spec.ts` | `@SuperAdmin @EfficiencyWindow @TOAuslastung` | RC 3.10 (#3183 AC2) the changed rolling window's three consumers on TO Verwaltung → Auslastung: Red/Yellow/Green/Gray counts sum exactly to the paginated therapist total (also the regression guard for #3233 AC6's 0/0/0/0), and the Therapeuten-Gesundheit filter narrows the table to the bucket's count. AC1 (which days count) skipped — unit-test only; a final test pins that these counts are *expected* to differ from #3176's period buckets |
| `sa_invoice_stored_pdfs.spec.ts` | `@SuperAdmin @InvoicePdfs @StoredPdf` | RC 3.11 (#3332) single-invoice downloads are served from stored PDFs. Decides stored-vs-rebuilt from **inside the file** — the PDF's `/CreationDate` must predate the test run and two downloads must be byte-identical — because wall-clock timing does not separate the cases (the same stored files measured 0.4–14 s here, straddling the 14–18 s pre-fix baseline). Covers copayment + PKV (`GET /invoices/{id}/download`), Storno (`GET /invoices/{id}/storno/download`), a 10-invoice coverage sample spread across all 521 invoices (AC8's backfill outcome), and the one mutating test: `POST /prescriptions/{id}/generate-invoice` on a `not_sent` draft refreshes the stored file (AC2). AC3/AC4/AC6/AC7 → `fixme` (issued regen creates a Storno + DATEV state; auto-refresh needs a VO content edit; the missing-file case needs S3 deletion; the catch-up is a console command). Uses `Pages/superadmin/sa.invoice-pdfs.page.ts` |
| `sa_vo_validation_choice.spec.ts` | `@SuperAdmin @ValidationChoice @CreationValidation` | RC 3.11 (#3340) an admin's explicit "Zur Korrektur speichern" / "Speichern" choice must not be silently overridden. Self-restoring writes on QA VOs (965110-4 all-passing, 965005-1 with 2 failures, 9653-1 with no choice): For Fixing survives on an all-passing VO both on its own write and a later one (AC1); Validated survives an all-pass write (AC2) and is not downgraded when a check fails (AC3); the `creationValidationStatusManuallySet` marker appears only from an explicit status write and clears when the status is cleared, while 27 of 28 for_fixing VOs still carry no marker (AC4); the For-Fixing dialog heading reads "Zur Prüfung — N bestanden, M nicht bestanden" and the all-passing form offers no For-Fixing button (AC5). Recompute is re-fired by flipping `actionRequired` — a re-check POST persists nothing when verdicts are unchanged. **Runs as Super Admin: Admin gets 403 PATCHing these VOs.** **Finding:** "Speichern" is inert (no dialog, no request) on a VO with failing checks → `fixme` |
| `sa_invoice_bulk_download.spec.ts` | `@SuperAdmin @InvoicePdfs @BulkDownload` | RC 3.11 (#3333) bulk invoice zips from stored PDFs, 50-invoice cap removed. `POST /invoices/bulk/download?disposition=inline` with `{id:[…], type:'copayment'|'pkv'}`: 61 copayment invoices → one 43.8MB zip with 61 entries; the cap is now a 2000-item abuse guard (2001 bogus ids → 400 "Batch size cannot exceed 2000 items") sitting above the 522 invoices that exist; PKV downloads on the same terms and a 74-id PKV request is accepted; the zip is opened and every PDF inside carries its stored `/CreationDate` (AC3), with a headers-vs-body split showing assembly is sub-second and the wall clock is transfer; Storno ids are excluded by entry name (AC5). AC4/AC6 → `fixme` (no way to remove a stored file; no failing-invoice fixture — 500 rows scanned). Uses `Pages/superadmin/sa.invoice-pdfs.page.ts` |
| `sa_retroactive_price_recompute.spec.ts` | `@SuperAdmin @TreatmentPrices @RetroactivePrice` | RC 3.11 (#3378) a price entry with a past effective date must reprice already-documented treatments. Round-trips through the API on HBH-E: `POST /treatment_price_histories` reports `retroactiveTreatmentsUpdated` (AC5) and reprices exactly the rows dated on/after the effective date while leaving earlier ones alone (AC1); a separate window proves treatments on VOs already in a billing batch are corrected too (AC4); `DELETE` recomputes them back (AC3) and is what makes every test **self-restoring**; an entry effective today reports 0 and changes nothing (AC6). The Heilmittelverwaltung Bearbeitungsmodus is checked for its per-row "Effective Date" column. Bulk CSV upload (AC2) and the one-time production backfill (AC7/AC8) → `fixme` — neither can be undone or read from a browser |
| `sa_wednesday_pull_forward.spec.ts` | `@SuperAdmin @OrderPullForward @ReadOnly` | RC 3.11 (#3299) a follow-up VO due Thu–Sun must flip to "Bestellen" on the preceding Wednesday. **Read-only — every request a GET.** The trace is `GET /prescription_logs?type=follow_up_status_change`, where the fix stamps `wednesday_pull_forward` / `pull_forward_days` / `regular_ready_date`. Two tests pass (the log is queryable, 815 VOs sit in Bestellen; plus a full inventory), **three skip with evidence rather than passing vacuously**. **Finding:** across 12,000 log rows back to 2026-01-17 there are 2,464 moves into Bestellen, 633 automatic — **every one in January–February 2026, all before the fix merged 2026-08-12**, and **zero rows carry the pull-forward marker**. The window 2026-06-30…08-18, which contains Wed 2026-08-12 (the day the PM records running `app:transition-to-order`), holds **no** move into Bestellen at all, so the PM's AC2 evidence (CRM 155→177) is not corroborated by the data. Not proof of a defect — the fix ships with unit tests over all 7 weekday scenarios — but #3299 is not re-verifiable here until the nightly job runs on a Wednesday against populated Individual lead times (all 1,459 practices are 21d/Standard, see `sa_order_flag_reset`). **Traps:** scope to the ship date or the 255 pre-fix Thu–Sun moves read as violations of a rule that did not exist; exclude `meta.type: manual` or ordinary Thursday admin work reads as failure; and the 851k-row log **must** carry its `type` filter — the unfiltered collection answers **504** from page 2. Uses `Pages/superadmin/sa.ordering-lead-time.page.ts` |
| `sa_billing_archived_vos.spec.ts` | `@SuperAdmin @BillingArchived @ReadOnly` | RC 3.11 (#3277) invoices of archived VOs must be findable on Zuzahlungsverwaltung and PKV-Abrechnung. **Read-only — every request a GET; the UI half only opens a tab and a dropdown.** AC5: both default lists return 14 rows restricted to Fertig Behandelt/Abgerechnet/Abgebrochen with no archived row and no fixture. AC3: `copaymentBilling[treatmentStatus]=Archiviert` → 380 rows, `pkvBilling[…]` → 118, all archived, and VO 7943-3 is found on page 2 with invoice R426-68. AC4: all three search paths return it with **no status filter applied**. AC1/AC2: both tabs' "VO Status" dropdown offers exactly Fertig Behandelt / Abgebrochen / Abgerechnet / **Archiviert**. **Traps:** `/billing` opens on the **Validierung** tab, whose dropdown is a different set (Pending/Bereit/Aktiv/…) with no Archiviert — read the option list off the right tab or you will wrongly call AC1 failed; the filter value is the **German** string (`archived` returns 0); and `search` is an **array keyed by property** — bare `search=` answers "search must be an array", `search[]=` answers 'The property "0" does not exist', and the invoice path is **`search[invoices.invoiceNumber]`** (plural; the singular is rejected as a non-existent association). A final test confirms the developer's flag that **the ticket's QA steps cannot be followed as written** — Zuzahlung is `public`-only and PKV `private`-only, so no VO appears on both tabs. Uses `Pages/superadmin/sa.billing-archived.page.ts` |
| `sa_retroactive_price_state.spec.ts` | `@SuperAdmin @TreatmentPrices @RetroactivePrice` | RC 3.11 (#3378) the same ticket verified **read-only — writes nothing**, as a companion to `sa_retroactive_price_recompute.spec.ts`. Reads the standing fixture the PM left on staging (HBH-E GKV €20.00 effective **2026-08-10**, over a prior €17.97) and asserts the recompute's outcome is a clean **step function at the effective date**: across 60 documented HBH-E treatments in 2026-07-20…08-21, all 44 GKV rows before it hold 17.97 and all 13 on/after hold 20.00 — including rows documented 11–12 Aug, i.e. *before the entry itself was created on 15 Aug*, which are exactly the rows the bug stranded. The four `ActivityTreatment` ids the PM names are checked directly (860470/860445/860443 → 20, control 860309 → 17.97). **Trap:** 3 rows in the same window read €24.00 and are **not** un-repriced — they are private-insurance VOs on the PRIVAT tariff, which a GKV-scoped entry must not touch, so every assertion is scoped by the VO's `insuranceType` (that scoping is itself asserted). AC4 is **data-gated-skipped with evidence** — all 9 repriced VOs have `billingBatchCount` 0, so "corrected in ALL billing states" cannot be shown positively read-only. AC2/AC5 (need a write) and AC7/AC8 (console command) → `fixme` |
| `sa_copayment_imported_blanko.spec.ts` | `@SuperAdmin @CopaymentBlanko @ImportedBlanko` | RC 3.11 (#3276) imported **Blanko** VOs become eligible for copayment invoicing. **Read-only — every request a GET**; the catch-up command already ran on staging in apply mode, so its outcome is readable. AC1's truth table is checked across the whole 520-row invoice population: 85 imported+Blanko GKV VOs now hold copayment invoices (the new behaviour) and **0** imported+non-Blanko GKV VOs do. AC2/AC3 on the Zuzahlungsverwaltung candidate list: 3 imported Blanko rows present, 0 imported non-Blanko. AC4 pins the catch-up as **one automatic batch of exactly 82 on 2026-08-12** (neighbouring days are single digits) plus the five VOs the ticket names (3210-4→R126-93, 6314-1→R326-45, 6504-1→R326-46, 5580-2→R426-73, 6536-1→R226-53). **Two traps:** the filter's `allWithInvoice` mode returns 108 imported non-Blanko rows *with invoices* that look like AC3 failing — all are `insuranceType: private` (PKV, not copayment), so every assertion is scoped to `public`; and regression VO 9136-1's `issueDate` reads 2026-08-19, *after* the run — its `invoice_created` log puts creation at 2026-07-14, so provenance comes from the log, never the date. AC5/AC6 (preview mode + CSV report) → `fixme` |
| `sa_order_flag_reset.spec.ts` | `@SuperAdmin @OrderFlagReset @LeadTime` | RC 3.11 (#3302 + the #3298 lead times it re-evaluates against) the one-time reset of VOs flagged "Bestellen" too early. **Read-only — every request a GET**; the command ran on staging in apply mode 2026-08-12, so the per-VO outcome is readable. AC1: the 3 RESET VOs (2105-8, 644-31, 4350-7) have no `followupStatus` — **the field is omitted from the payload entirely once cleared**, so "reset" reads as `undefined`, not `null`. AC2: KEPT (5878-5, 5300-3) and team-acted (5891-3, 8191-1, both `orderingStatus: "By Admin"`) and Blanko (4849-5, 3202-6) all still `order`. #3298's `leadTimeDays` / `leadTimeSource` / `leadTimeClamped` on `/practices` are asserted inside the 10–30 clamp with Standard ⇒ exactly 21. **Finding:** all **1,459** staging practices read 21d/Standard today — 0 Individual, against the 848 the PM's run resolved — so the reset's decisions can no longer be recomputed live; that is also the exact state #3302's deploy note warns makes the run a no-op → `fixme`'d as an unmet prerequisite. AC3/AC4/AC5 (preview/apply modes, CSV) → `fixme`. Uses `Pages/superadmin/sa.ordering-lead-time.page.ts` |
| `sa_board_filter_resolver.spec.ts` | `@SuperAdmin @FlowBoards @FilterResolver` | RC 3.11 (#3311) the nine board providers' copy-pasted filter parsing became one `ManagementFilterResolver`. **Read-only — every request a GET.** All nine providers are addressed by their live endpoints (`/kpis/management`, `/therapists`, `/teams`, `/trend`, `/billing-backlog`, `/kpis/orga/risks`, `/working-hours`, `/efficiency-buckets`, `/orga-trend`) and asserted to answer the same filter alike: the resolver's `absent` / `''` / `'all'` / unknown-value passthrough returns an **identical payload on all nine** (for both `patientType` and `location` — and note the UI can only send *absent*, so the other three forms are reachable only by calling the API); `gkv` / `pkv` / unfiltered are three distinct payloads on all nine, proving even the four endpoints no screen drives actually read the parameter; **four providers report the same treated revenue** (1259.8 unfiltered, 1196.8 GKV, 63 PKV, 0 Praxis) under every filter — the copy-drift detector; GKV+PKV reconstructs the total exactly; and identical requests return identical payloads (the external stand-in for AC3's cache keys). Comparison needs canonicalisation: every `member[].@id` is a random `/.well-known/genid/…` and the JSON-LD `view` block echoes the request URL back (and is **omitted entirely** when no query string is sent). AC1/AC2/AC3 as written are source-level → `fixme`. Uses `Pages/superadmin/sa.board-filters.page.ts` |
| `sa_copayment_theorg_exclusions.spec.ts` | `@SuperAdmin @CopaymentExclusions @TheOrgBlanko` | RC 3.11.1 (#3426) the 33 imported Blanko VOs TheOrg already invoiced must never get an automatic copayment invoice. Decided from `GET /invoice_logs`, whose `invoice_created` entry carries `meta.type: manual` / `automatic` — so "did an automatic path invoice this?" is a fact, not a timestamp inference: across all 33 there are **17 automatic creations, all pre-fix** (16 from a staging catch-up rehearsal on 2026-08-12, 6891-1 on 2026-08-08) and **0 since the exclusion shipped** (2026-08-20 07:14 UTC). Of the 14 rows in the `copaymentBilling=true` candidate set, 6314-2 is the *only* eligible imported Blanko VO left uninvoiced and it is on the list (AC3); the control 4876-1 — same profile, not listed — was invoiced **automatically at 2026-08-20 11:52**, proving the rule was narrowed rather than switched off (AC5). AC6 round-trips 6314-2's `validationStatus` through `for_fixing` four times (self-restoring) and it still creates nothing; AC4 re-fires `POST /prescriptions/26234/generate-invoice` on excluded 5714-3 → 200, same invoice number, draft replaced in place. AC1/AC2 (the catch-up preview's 136/18/9 split) → `fixme` — console-only command against a production dump. **Tests are split `@ReadOnly` / `@Mutating`**: `--grep "@ReadOnly"` runs six tests that write nothing (including read-only AC4 and AC6 substitutes — the standing `manual` `invoice_created` entry on 5714-3, and the exclusion holding across all 3 treatment statuses × 2 validation states the 33 span), while `@Mutating` is the two that re-prove AC4/AC6 live. The describe is `serial`, so a staging navigation flake in one test cascades the rest to "did not run" — re-run before reading that as a failure. Uses `Pages/superadmin/sa.copayment-exclusions.page.ts` |
| `sa_datev_old_format_push.spec.ts` | `@SuperAdmin @DatevOldFormat @ReadOnly` | RC 3.11.1 (#3440) PKV invoices whose number predates the `R` format must be delivered to DATEV **under their existing number**. **Read-only — every request a GET.** The delivery is a console command, `app:datev:push-legacy-pkv-invoices` (preview by default, `--force` to execute), run as a one-off Fargate task on `therapios-staging-console`. **Staging is preview-only by decision** — `DATEV_SYNC_ENABLED=false` makes `--force` abort at the guard, and that same SSM parameter also sets the State of the three DATEV EventBridge rules, so enabling it would start the nightly push/pull/debtor-creation against staging data on a Riecken gateway whose URL and credentials are **byte-identical to production** (only test Mandant 9999 separates the traffic). The real run happens on production. AC1 derives the population from the ticket's own rule and lands **set-identical to the command's 2026-08-24 preview**: **44 old-format PKV invoices, EUR 32,968.57, 0 skipped — 43 `overdue` ("Ausstehend") + 1 `to_send_to_dc` ("Inkasso", `126-4` on VO 91-2, €78)**, cross-checked on both count and total so a quietly widened rule breaks the sum. Two boundary cases the rule must exclude and does: **7 Storno documents (`S126-1`, `S426-2`, …) also fail "starts with R"** (the command excludes them explicitly — stornos have their own sync path) and **40 old-format GKV invoices** satisfy the number rule, so the insurance scope is load-bearing. AC2's pre-state is asserted from both surfaces: all 84 invoices in DATEV are current-format, each of the 44 has no `datevSyncStatus`/`datevSyncedAt`/`datev_push_success` log, and `datev_push_failed` is 0 — the exclusion is silent, nothing was attempted. AC5 is **structural, not observable**: `findPendingDatevSync()` (the nightly PUSH selection) is untouched and still `R`-only; only `findUnpaidForPaymentMatching()` widened, from `LIKE 'R%'` to `LIKE 'R%' OR datevSyncStatus = SYNCED` — so an old-format invoice becomes pollable *only* after the one-time push sets that status, and nothing is marked "already delivered". AC3 has **no fixture** — all 44 are unpaid. **Traps:** `datevSyncStatus`/`datevSyncedAt` are **omitted from the payload until an invoice is actually pushed**, so "not synced" reads `undefined` and `?datevSyncStatus=pending` answers **0**; `datevSyncAttempts` is a *failure* counter (0 on all 534) and cannot stand in for "was this pushed"; insurance type lives on the prescription, not the invoice; `batchId` is unique **per push, not per run**; and the 44 sit on archived VOs, so the UI needs `pkvBilling[treatmentStatus]=Archiviert` (#3277). **Finding (#2856, not #3440, but it blocks this ticket's QA route):** PKV-Abrechnung's `DATEV: Ausstehend` filter returns **0 rows in every combination** while the DATEV column renders "Ausstehend" for every unsynced row — a PM cannot list the affected invoices from the UI. **Runbook:** the nightly does not retry what the one-time command defers, so re-running the command is the only retry path — safe to repeat because its last selection clause is `datevSyncStatus IS NULL OR = FAILED`. The two post-run tests (AC2/AC6 and AC4) are data-gated and **run unchanged against production** after the real delivery. AC1/AC6 preview+CSV, AC3 and AC5 → `fixme` with the verified out-of-band evidence recorded inline. Uses `Pages/superadmin/sa.datev-old-format.page.ts` |
| `sa_untreated_days.spec.ts` | `@SuperAdmin @TBoardV2 @UntreatedDays` | RC 3.11.1 (#3471) the ticket's own reproduction on patient **4258** (Sergej Marin), which needs a Super Admin because the two VOs sit with **different therapists** — the Therapist Board v2 at `/therapist/` offers Admin/SA a "Therapeut:in wählen" picker onto any therapist's board. **Read-only.** On **Mara Nagel**'s board 4258-15 (Aktiv, treated 2026-07-08), 4258-17 (Abgelaufen) and 4258-14 (Fertig Behandelt, own treatment 2026-07-07 → 35 of its own) all read **34**; on **Kevin Mischke**'s board 4258-16 — the row the ticket screenshotted at 176 T — reads **"–"**, every VO he holds for that patient being terminal. His caseload also proves AC5 at scale: "**50 Patienten** seit 14+ Tagen nicht behandelt" against 51 top-level (65 incl. revealable) qualifying rows. **Traps:** the INAKTIVE PATIENTEN group ships collapsed, so a patient with only closed VOs has a header and a count but no painted row until it is clicked; and a patient's closed VOs reach the table only through the row's "▸ n v. VOs" control. **Finding:** the rollup is scoped to the caseload being served, so patient 4258 is "34 weekdays untreated" on one board and "unknown" on another, against AC1's "across all their VOs" — deliberate (a therapist must not see a figure derived from another's caseload) → `fixme`'d as `@RollupScope` for the PM. Uses `Pages/therapist/therapist.untreated-days.page.ts` |

`tests/Production/Therapist/sentry_environment.spec.ts` (`@Therapist @OfflineCache @SentryEnvironment`) covers #3385 AC6 from the production side: it reads the `environment` tag off the envelopes app.therapios.de sends unprompted and asserts `production`. It self-skips while production serves a pre-3.11 build (v3.10.0 today, tagging everything `staging` — the defect the ticket describes).

Production specs mirror the Staging inventory under `tests/Production/`. The RC 3.11 specs (`admin_letter_country_marker`, `admin_home_visit_validation`, `admin_optica_bsnr`, `sa_retroactive_price_recompute`, `sa_invoice_stored_pdfs`, `sa_invoice_bulk_download`, `sa_vo_validation_choice`, `therapist_board_desktop_layout`) and the RC 3.11.1 hotfix spec (`sa_copayment_theorg_exclusions`) are Staging-only for now: those changes sit on `release/3.11.0` / the 3.11.1 hotfix branch and are not deployed to Production yet, so mirrored specs would fail. Mirror them when 3.11 ships — `sa_copayment_theorg_exclusions` is the one to mirror *first*, since the 33 VOs it lists are production data and the held catch-up run executes there.

## Staging on v3.11.0 (2026-08-26)

Staging serves **v3.11.0** (the version string is in the sidebar footer). Production is still on the
older build, so every selector below must accept BOTH spellings — the Production mirrors share these
page objects.

**A broad German translation sweep landed.** The ones that moved selectors:

| Surface | Was | Is |
|---|---|---|
| Create-VO form heading | `Create VO` | `VO erstellen` — which now **collides with the trigger button's own label**, so it can't prove the form opened. Gate on the route `/vo-management/add` plus a required field. |
| Create-VO field labels | `Area`, `Insurance Type`, `Primary Therapist`, `Doctor`, `Prescribed Treatments`, `People & Facilities` | `Fachbereich`, `Versicherungsart`, `Hauptbehandler`, `Arzt`, `Verordnete Behandlungen`, `Personen & Einrichtungen` |
| Dropdown search box | `input[placeholder="Search"]` | `input[placeholder="Suchen"]` — **do not** loosen to `[placeholder*="suchen"]`: the VO form carries two ICD inputs placeheld "Nach Code oder Beschreibung suchen", so the wildcard resolves to four elements and trips strict mode |
| ICD search box | `Search by code or description` | `Nach Code oder Beschreibung suchen` |
| Abrechnung status tabs | `All` / `No Status` / `For Fixing` | `Alle` / `Kein Status` / `Zur Korrektur` (+ a fourth, `Alle inkl. Geschlossene`). `AbrechnungPage.TAB_LABELS` maps the English names callers still use. `Alle` is a **prefix of** `Alle inkl. Geschlossene` — anchor the match. |
| Upload IDs | `NNN-NN` | prefixed, e.g. `ADM-1341` |

**Not translation — actual product changes:**

- **"Rezepte-Sync" was withdrawn** from the Admin Board: the Spalten chooser is **37 columns
  ("10/37")**, and the Filter panel offers **12** sections. The 10 checked defaults are unchanged.
- **Therapist Board v2 defaults changed** (7/16, `Organizer` gone) — see the Board Redesign section.
- **Flow Boards placeholder boards have diverged.** `Einrichtungen` and `Ärzte-Management` are still
  clean "In Vorbereitung" placeholders; **`Therapeuten-Orga` renders a full filter bar** alongside
  the placeholder, and **`Admin-Performance` no longer shows "In Vorbereitung" at all**. #3173 AC4
  now only holds for two of the four.
- **The "Ohne TO-Team" bucket is EMPTY.** The option is still offered by the team selector, but
  selecting it returns 0 €, 0,0 % efficiency and Rot/Gelb/Grün/Grau all 0 — so no group row and no
  trend series render for it. Assert it on the **selector** (always true) and data-gate the row and
  the series; do not read its absence as a regression.
- The Entitäten list no longer contains a "Therapios" entity (seven Curano companies).

**Load, not defects.** Under 4 workers the suite produces `page.goto` 60s timeouts, `TypeError:
Failed to fetch (api.staging.therapios.de)`, `socket hang up` and **504s from the slower KPI
endpoints** — `/kpis/orga/risks` alone measures ~11.6 s and answers 200 every time when called by
itself. A full run at `--workers=4` reported 62 failures; re-running just those files at
`--workers=2` left 20. Triage anything network-shaped by re-running before believing it.

**Don't run a second `playwright test` while a suite is running** — each invocation wipes
`test-results/`, which makes the live run fail on missing artifact paths. Pass `--output=/tmp/...`
for ad-hoc probes.

## Domain Glossary

Understanding these German terms is essential when reading selectors, test steps, and bug reports:

| Term | Meaning |
|---|---|
| VO (Verordnung) | Prescription / treatment order |
| Abrechnung | Billing |
| Abgebrochen | Cancelled (VO status) |
| Fertig behandelt | Treatment completed (VO status) |
| Abgelaufen | Expired (VO status) |
| Heilmittel | Therapeutic remedy / treatment type |
| Arzt | Doctor |
| Doku | Documentation (treatment documentation) |
| T Board | Therapist Board — therapist-specific schedule/dashboard |
| CRM | Practice relationship management (not a standard CRM) |
| Gesellschaft | Company/Organization associated with a practice |
| Nächste Aktivität | Next Activity (CRM field) |
| Behandlungsverlauf | Treatment history |
| Copayment | Patient co-payment document |
| Honorarvereinbarung | Fee agreement document |
| Sonstiges | Miscellaneous |
| Keine Folge-VO | No follow-up prescription (VO termination reason) |
| BV | Berufsgenossenschaft (occupational insurance VO type) |
| PKV | Private health insurance |
| GKV | Statutory health insurance |

## Conventions

- **Auth**: Sessions are pre-generated via `auth.setup.ts` and stored in `.auth/`. Re-run `setup` when sessions expire (token expiry, password change).
- **Selectors**: The app is built with React Native Web — most elements are `div`-based with no semantic roles. Prefer `data-testid` where present; fall back to visible text or ARIA labels.
- **Tags**: Every test must carry a role tag (`@Admin`, `@Therapist`, `@SuperAdmin`) plus a feature tag. Use `--grep` to run subsets without running the full suite.
- **Serial mode**: Tests that share mutable backend state (same patient, same VO, same record) must use `test.describe.configure({ mode: 'serial' })` to prevent worker conflicts.
- **Cross-file serialization (CRM)**: `test.describe.configure({ mode: 'serial' })` only serializes tests *within one file*. The CRM specs all drive the same shared practice (`CRMListPage.openPracticeView()` opens the first practice) across multiple files and both the Admin and SuperAdmin projects, so they need cross-file/cross-project serialization. They import `test`/`expect` from `tests/fixtures/crm-serial.ts` — an auto fixture that takes an exclusive OS-level lock so only one CRM test runs at a time suite-wide. That fixture **owns the CRM timeout** (grants a fixed body budget from lock-acquisition and keeps the deadline ahead during the wait); CRM specs must therefore NOT call `test.setTimeout()` themselves (it runs after the fixture and would clobber the lock-wait allowance, reintroducing "timeout … while running beforeEach hook" failures).
- **Page Objects**: For any flow touched by multiple tests, extract selectors/actions into `Pages/`. Follow the existing CRM pattern in `Pages/crm/`.
- **Timeouts**: Default per-test timeout is 90 s. Extend with `test.setTimeout()` only when a test requires long setup/teardown. `actionTimeout` is disabled — rely on `expect` timeouts instead.
- **Language**: All UI text, field labels, and status values are in German. Use exact German strings in selectors and assertions.

## Board Redesign (staging, 2026-08-20)

Both main boards — Admin Board (`/dashboard`) and Therapist Board v2 (`/therapist/`) — were
re-skinned, and this moved nearly every selector the suite used. The new contract is *better* than
what it replaced; prefer it over text/geometry matching.

**Shared contract (both boards)**

| Surface | New hook |
|---|---|
| Toolbar chips | real `<button>`s: `getByRole('button', { name: 'Filter' \| 'Spalten', exact: true })`, badge count in their `innerText` |
| Filter panel / column chooser / every dropdown | `[role="dialog"][aria-modal="true"]` — **only one is mounted at a time**, so opening a dropdown from inside the Filter panel *replaces* the panel, then restores it |
| Column chooser rows | `[role="menuitem"]` wrapping `[role="checkbox"][aria-label="<column>"]`. **No `aria-checked`** — a column is on iff its checkbox renders a `✓` glyph |
| Row select boxes | `getByRole('checkbox', { name: 'Zeile auswählen' })`; the header one is `'Alle auswählen'` |

**Traps**

- **CSS-uppercased labels.** Row groups ("Aktive Patienten"), filter section headings and
  "Diese anzeigen" are `text-transform: uppercase`. They READ upper-case and arrive that way in
  `innerText`, but `textContent` — which Playwright's text engine matches — stays title-case.
  `getByText('AKTIVE PATIENTEN')` finds nothing; `getByText(/^Aktive Patienten$/)` works.
- **Sticky localStorage preferences.** Anything asserting a DEFAULT column set or page size has to
  clear the key and reload first: `hidden_column_admin:dashboard` and `dashboardV2.perPage` (admin),
  `column-select-therapist-board-v2` (therapist, a JSON array of column *keys*). The page objects do
  this via `open({ resetPreferences: true })` / `open()`.
- **`text-input-outlined` is gone from both boards** (it still exists inside modals). The board
  search boxes are addressed by placeholder — `boardSearchBox(page)` in `Pages/base/app.page.ts`
  accepts either shape, because Production has not taken the redesign yet.
- **The `.r-qklmqi` row-wrapper class no longer exists** on the therapist board.

**Admin Board specifics**

- Heading "Admin Board" over "Verordnungen (VO) · N gesamt"; pager reads
  "Zeilen pro Seite [30 ▾]  1–30 von N  ‹ 1 2 3 4 5 ›" (page numbers and arrows are plain
  `div[tabindex="0"]`; the page-size selector is a button labelled "Zeilen pro Seite: 30").
- The Filter panel previews its result live as "N VOs anzeigen" and offers 12 sections, each a
  button whose `aria-label` IS the section label — including the pickers that read
  "Therapeut: (Auswählen)". Buttons: "Filter löschen" / "Schließen".
- The Spalten chooser offers **37 columns, 10 on by default** ("10/37"). "VO #" / "PATIENT" are
  fixed and not offered. New since the last inventory: Heilmittel (now a default column) and
  Erstellungsvalidierungsstatus. **"Rezepte-Sync" has since been withdrawn** from both the chooser
  and the Filter panel (38 → 37 columns, 13 → 12 sections).
- Status cells are buttons labelled `Status: <value>`.

**Therapist Board v2 specifics**

- The table is `data-testid`-tagged: `v2-table-scroll-port` (owns the horizontal scroll),
  `v2-table-header-rail`, `v2-header-<key>`, `v2-header-sort-<key>`, `v2-cell-<key>`,
  `v2-rail-cell-<key>`. Keys: `prescriptionId`, `patient`, `date`, `deadlines`, `medications`,
  `therapyReport`, `frequency`, `daysSinceLastTreatment`, `followupStatus`, `elderlyCareHome`,
  `ibStatus`, `bfStatus`, …
- **7 of 16 columns on by default** ("7/16") since v3.11.0: Ausst. Datum, Startfrist /
  Gültigkeitsfrist, TB, Frequenz, Tage seit Beh., Folge-VO Status, Einrichtung — persisted as the
  keys `date`, `deadlines`, `therapyReport`, `frequency`, `daysSinceLastTreatment`,
  `followupStatus`, `elderlyCareHome`. The deadline sub-headers read **"Startfrist" / "Gültig bis"**
  again (they were briefly "Start" / "Gültig"). **`Organizer` no longer exists** — the picker offers
  16, not 17. **HM, IB and BF are all opt-in now** — enable them before asserting on Heilmittel,
  Initialbefund or Befund cells. `TherapistBoardV2Page` holds this as `DEFAULT_COLUMNS`,
  `DEFAULT_COLUMN_KEYS`, `OPT_IN_COLUMNS`, `ALL_COLUMNS` and `DEFAULT_SUMMARY`.
- **Anything that clicks a data cell must resolve a column that is actually painted.** With
  `actionTimeout: 0` a click on an un-rendered cell HANGS to the test timeout rather than failing —
  that is exactly how the HM cell took out `expandFirstRow()` when HM went opt-in.
- **The responsive card list is gone.** The table renders at every width measured (1440 → 390px);
  there is no breakpoint at which the board falls back to cards. `fixme`'d in
  `therapist_board_desktop_layout.spec.ts` as a regression against #3362 AC7.
- **The "Meine VOs" tab badges the ACTIVE count**, not the heading total (e.g. "69 VOs · 29 aktiv"
  with the tab reading 29).
- Header "Dashboard" over "N VOs · M aktiv"; `role="tab"` tabs "Meine VOs" / "Geteilte VOs" /
  "Kalender"; a "Hinweise" button; a "Warteschlange ›" button; an offline-queue line
  ("Stand von vor 0 Min · alles gesendet").
- **The yellow "Überprüfen" review banners are gone.** Their three reminders ("N Patienten seit 14+
  Tagen nicht behandelt", "N VOs laufen in 14 Tagen aus", "N Therapieberichte fällig") are now
  sections of the **Hinweise** panel, each over a "Diese anzeigen" control.
- **"Bestellt von" moved onto the row-selection action bar** ("N ausgewählt · Auswahl aufheben ·
  Doku erfassen (N) · Bestellt von · VO abbrechen · Patient transferieren · Patient teilen").
- Rows are grouped under collapsible "Aktive Patienten" / "Inaktive Patienten" headers.
- Empty state reads **"Keine VOs für diese Auswahl"** (was "Keine Patienten gefunden"); the search
  box is no longer readonly after a search — a "✕" clears it in place.
- Layout: table down to ~900px, card list at 810px.
- The standalone location dropdown is gone; facilities filter from the panel's EINRICHTUNG section
  (inline option buttons, not dropdowns), alongside VO STATUS and BEHANDLUNGSLÜCKE. Buttons:
  "Alle löschen" / "Schließen"; live preview "Ergebnis: N VOs".

**Surfaces launched FROM the boards, which moved with them**

- **The "Doku erfassen" modal** (`Pages/therapist/therapist.doku-modal.page.ts`, used by the therapist
  specs and both T Boards): surface testid is `modal-surface` (`surface` is gone from THIS modal but
  still used elsewhere — don't replace it globally); title "Doku erfassen (N)" (was "Mark as Treated");
  the note is a `<textarea>` placeheld "Doku eingeben" and is the only required field; save reads
  **"Speichern"** (was "Save") and stays `disabled` until the note is filled; the required
  "Heilmittel auswählen" step is **gone**; Behandlungsart offers "Durchgeführt" / "Geplant";
  "Patient:in hat die Behandlung verweigert" gained the ":in". **There is no success toast** — a save
  is observed by the modal closing.
  - With **more than one patient** selected every entry ships **collapsed** (no note fields at all
    until each is expanded). The toggle is a button whose `aria-label` is the entry's title; a SINGLE
    patient ships expanded, so expanding must be idempotent or it closes what it opened.
  - "Aktivität" no longer opens a picker: it **appends** an entry defaulting to type "Pause" that then
    requires "Dauer (Minuten) *".
  - A successful save fires `POST /activities/check-overlap`, `POST /activities/bulk`,
    `POST /prescriptions/organizer/bulk`.
- **The Kalender view**: the "Vorh." control is gone — the arrows are icon-only buttons labelled
  "Vorherige Woche" / "Heute" / "Nächste Woche", with Tag/Woche toggles and a "Datum wählen: …"
  range button. Appointment cards no longer show a clock time; they read
  "`<sessions> / <total> (N mins)`" under the patient name, grouped by day.
- **The "Patienten übertragen" modal** (was "Patient transferieren"): its confirmation table's headers
  are CSS-uppercased (`textContent` stays "Patient" / "VO Nr." / "Einrichtung" / "Arzt"; "Current
  Therapist" is gone), rows arrive behind a "Wird geladen …" placeholder, and the target-therapist
  picker is a `[role="dialog"]` — the `data-testid*="flatlist"` list is gone. Buttons: Abbrechen /
  Übertragen.
- **The IB signer dialog**: the options are still `[role="radio"]` and resolve by accessible name
  ("Patient/in", "Bevollmächtigte/r / Betreuer/in"), but the `[role="radiogroup"]` wrapper and their
  descriptive `aria-label`s are **gone** (an a11y regression — `fixme`'d in `ib_accessibility.spec.ts`).
  "Weiter" is correctly gated disabled → enabled.

**Two silent-failure defects this release introduced** (both `fixme`'d with evidence in
`tests/Staging/Therapist/document_treatment.spec.ts`)

- Documenting a patient who **already has an activity for the chosen date** is refused entirely
  client-side and silently: "Speichern" stays enabled, the click lands, no field is flagged, and **no
  request is sent at all**. The modal just stays open.
- A treatment+activity save **does** fire `POST /activities/bulk`, gets **HTTP 400/422 back, and still
  shows nothing**. `DokuModalPage.save()` therefore classifies the outcome as
  `saved | conflict | rejected | blocked` and callers accept all four — these specs re-document the
  same rows on every run, so the duplicate paths are expected. Watch the classification in the log
  rather than trusting a bare pass.

**`actionTimeout` is 0 project-wide**, so an action on a locator that never resolves waits FOREVER and
never rejects — which means the `.catch(() => …)` fallbacks these page objects rely on never fire, and
one stale selector hangs a worker instead of skipping. Give every action in a fallback path an explicit
`{ timeout: … }`.

**Never settle a board read with a fixed sleep — but don't replace it with a long one either.** The
redesigned boards paint in ~10s idle and much slower under parallel load, and every helper that reads
them degrades *silently* when it reads early: `headerLabels()` returns `[]`, `rowCount()` returns 0, a
group header "isn't rendered", and an applied-filter total still holds the PREVIOUS filter's number.
Those look exactly like product bugs and disappear on a re-run at `--workers=1`, which is the worst
possible failure signature. Wait on a readiness condition (`TherapistBoardV2Page.waitForBoardReady()`,
`TherapistListPage.settle()`; `AdminDashboardPage.clickPill()` waits for the total to move *and*
settle) and `expect.poll` any assertion comparing two counts read from different renders.

Three traps in doing that:
- A readiness check must not treat "not there yet" as ready. `isTableLayout()` is false both on a
  narrow viewport AND in the moments before the table mounts, so breaking on it returns instantly on
  desktop and hands the caller an unpainted board. Pass the expectation in (`open()` derives it from
  the viewport width) rather than inferring it from the DOM.
- A flat long settle is not a safe substitute: `share_patient` and the other loop-over-
  patients×therapists specs call `searchPatient()` many times inside a 180s budget, so ~10s per call
  exhausts the test before the work. Poll and return as soon as it is ready.
- Use `locator('[data-testid=…]').count()` in those hot loops, never `getByRole` — role queries walk
  the whole RNW accessibility tree and are slow enough to blow the budget on their own.

## Writing New Tests

### File placement
- Staging tests → `tests/Staging/<Role>/`
- Production tests → `tests/Production/<Role>/`
- Both environments need matching specs when adding new coverage.

### Test structure
```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Area', () => {
  test.describe.configure({ mode: 'serial' }); // add if tests share state

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test('Descriptive test name', { tag: ['@Role', '@FeatureTag'] }, async ({ page }) => {
    // use Page Objects for multi-step flows
    // use expect with web-first assertions
  });
});
```

### Adding a Page Object
Place in `Pages/<area>/<area>.<feature>.page.ts`. Export a class with methods that encapsulate selector logic. Import and instantiate in specs:
```typescript
import { MyFeaturePage } from '../../../Pages/area/area.feature.page';
const feature = new MyFeaturePage(page);
await feature.doSomething();
```

## Known Constraints

- **No custom npm scripts** — always use `npx playwright test` directly.
- **Sessions expire** — re-run `setup` / `setup-prod` if auth errors appear.
- **T Board requires therapist selection** — tests using the T Board must select a therapist from the dropdown or use a therapist account; it does not auto-populate.
- **Backend-only tickets** — auto-validation rules (VO creation validation, billing auto-validation) cannot be verified via UI alone; they require specific data scenarios to trigger.
- **Parallel writes conflict** — tests that create/modify the same record must run in serial mode.
