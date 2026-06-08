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
  vo/
    vo.form.page.ts                 # Create-VO form: practice (required) + doctor (optional) selectors
tests/
  Staging/
    Admin/                          # 13 spec files — project: AdminJhen
    SuperAdmin/                     # 12 spec files — project: SAJhen
    Therapist/                      # 9 spec files  — project: SandraZeibig
  Production/
    Admin/                          # 12 spec files — project: AdminJhen-Prod
    SuperAdmin/                     # 11 spec files — project: SAJhen-Prod
    Therapist/                      # 9 spec files  — project: JhenQA-Prod
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
| `admin_checkcolumns.spec.ts` | `@Admin @columns` | Verifies dashboard table columns are visible and correct |
| `admin_documents.spec.ts` | `@Admin @DocumentAddNoteAdmin @DocumentSearch @DocumentStatusChange` | Document search by ID/therapist name, add note, update inline status |
| `admin_pagination.spec.ts` | `@Admin @pagination` | Pagination works on the Flow page |
| `admin_arzt_management.spec.ts` | `@Admin @ArztManagement` | Create and update Arzt (doctor) records |
| `admin_uploadprescription.spec.ts` | `@Admin @AddNoteUploadVO @SearchUploadVO @updateStatusUploadVO` | Upload dashboard: search VOs, add notes, update status |
| `admin_crm_practice.spec.ts` | `@Admin @CRMFilters` | CRM practice list filtering |
| `admin_crm_activities.spec.ts` | `@Admin @CRMActivities @CRMCreateIssue @CRMResolveIssue` | CRM: create activity, create issue, resolve issue |
| `admin_crm_follow-up-orders.spec.ts` | `@Admin @CRMFollowUpOrder` | CRM follow-up order actions |
| `admin_crm_initial-order-change-status.spec.ts` | `@Admin @CRMInitialOrder` | CRM initial order status changes |
| `admin_tboard.spec.ts` | `@Admin @AdminDoku` | T Board document treatment flow |
| `admin_reports.spec.ts` | `@Admin @Reports @ReportsDateFilter @ReportsExport @ReportsTherapieformFilter` | Reports page: date filter, therapieform filter, export |
| `admin_vo_practice.spec.ts` | `@Admin @VOPracticeAssignment @VOFormPractice @VOPracticeSearch @VOPracticeSelect @DashboardPracticeColumn` | VO Direct Practice Assignment (#2670): Create-VO form requires Praxis + makes Doctor optional, practice searchable by name & BSNR, select a practice, Dashboard Praxis column |

### Therapist (Staging) — `tests/Staging/Therapist/`

| File | Tags | What it tests |
|---|---|---|
| `uploadprescription.spec.ts` | `@Therapist @uploadvo @AddNoteTherapist` | Upload VO (prescription), view and add note |
| `document.spec.ts` | `@Therapist @uploadcopayment @uploadpatientinfo @uploadHonorarvereinbarung @uploadsontiges @AddNoteTherapistCopayment` | Upload copayment, patient info, Honorarvereinbarung, Sonstiges documents; add note to copayment |
| `document_treatment.spec.ts` | `@Therapist @singleregular @multipleregular @plannedtreatment @rejecttreatment @bvtreatment @doppelbeh @validationerror @activity` | Document treatments: single/multiple patients, planned, reject, BV, Doppel-Behandlung; validation errors; activity |
| `check_doku.spec.ts` | `@Therapist @checkdoku @checkdokuclose @checkdokunote @checkeditactivity @checkdokusections @checklogs` | Doku panel: open/close, notes, edit activity modal, Behandlungsverlauf + Logs sections |
| `search.spec.ts` | `@Therapist @searchname @searchvo @searchunknownname @searchunknownvo @searchlocation` | Patient search by name, VO number, unknown inputs, and location |
| `calendar.spec.ts` | `@Therapist @calendar @editcalendar` | Calendar view and edit |
| `notification.spec.ts` | `@Therapist @notification @bellnotification @markasread` | Banner notification, bell notification, mark as read |
| `share_patient.spec.ts` | `@Therapist @sharepatient @removesharedpatient` | Share patient with another therapist and remove shared access |
| `VO_termination.spec.ts` | `@KFvo` | Non-immediate VO termination (Keine Folge-VO bestellen) |

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
| `sa_crm_practice.spec.ts` | `@SuperAdmin @CRMFilters` | CRM practice list filtering |
| `sa_crm_activities.spec.ts` | `@SuperAdmin @CRMActivities @CRMCreateIssue @CRMResolveIssue` | CRM: create activity, create issue, resolve issue, next activity |
| `sa_crm_follow-up-orders.spec.ts` | `@SuperAdmin @CRMFollowUpOrder` | CRM follow-up order actions |
| `sa_crm_initial-order-change-status.spec.ts` | `@SuperAdmin @CRMInitialOrder` | CRM initial order status changes |
| `sa_tboard.spec.ts` | `@SuperAdmin @SADoku` | T Board document treatment flow |
| `sa_reports.spec.ts` | `@SuperAdmin @Reports @ReportsDateFilter @ReportsTherapieformFilter @ReportsExport` | Reports page: date filter, therapieform filter, export |
| `sa_vo_rueckseite.spec.ts` | `@SuperAdmin @VORueckseite` | VO Rückseite (back-of-VO) batch upload page |
| `sa_daten_hochladen.spec.ts` | `@SuperAdmin @DatenHochladen` | Data upload (CSV) page and import history |
| `sa_praxis.spec.ts` | `@SuperAdmin @Praxis` | Practice tracking CRM page |
| `sa_entities.spec.ts` | `@SuperAdmin @Entities` | Entitätsverwaltung (entity/company management) |
| `sa_dokumentenzentrale.spec.ts` | `@SuperAdmin @Dokumentenzentrale` | Document center: Therapieberichte, Honorarvereinbarungen, etc. |
| `sa_kpi_dashboard.spec.ts` | `@SuperAdmin @KPIDashboard` | KPI Dashboard: period filters, charts |
| `sa_to_management.spec.ts` | `@SuperAdmin @TOManagement` | TO Verwaltung: Auslastung/Abrechnung/KPIs tabs, therapist health counters |
| `sa_validation_config.spec.ts` | `@SuperAdmin @ValidationConfig` | Validierungskonfiguration: rule table, auto-validation rules |
| `sa_vo_practice.spec.ts` | `@SuperAdmin @VOPracticeAssignment @VOFormPractice @VOPracticeSearch @VOPracticeSelect @DashboardPracticeColumn` | VO Direct Practice Assignment (#2670): Create-VO form requires Praxis + makes Doctor optional, practice searchable by name & BSNR, select a practice, Dashboard Praxis column |

Production specs mirror the Staging inventory under `tests/Production/`.

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
- **Page Objects**: For any flow touched by multiple tests, extract selectors/actions into `Pages/`. Follow the existing CRM pattern in `Pages/crm/`.
- **Timeouts**: Default per-test timeout is 90 s. Extend with `test.setTimeout()` only when a test requires long setup/teardown. `actionTimeout` is disabled — rely on `expect` timeouts instead.
- **Language**: All UI text, field labels, and status values are in German. Use exact German strings in selectors and assertions.

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
- **Staging `/practices` API returns 500** — the Create-VO practice dropdown renders no options on Staging, so `admin_vo_practice` / `sa_vo_practice`'s `@VOPracticeSelect` test self-skips there (it runs on Production where the API is healthy). The `@VOFormPractice` and `@VOPracticeSearch` tests still pass on Staging because they assert the form contract and the search request, not the API response.
