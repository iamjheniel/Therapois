# #3790 — manual steps for the parts the suite does not drive

`tests/Staging/SuperAdmin/sa_fee_agreement_upload.spec.ts` verifies AC1, AC2's *Not sent* row and
AC3 automatically. Three things are left, and each has a reason.

## First, the identifiers

**The ticket's "patient 8789 / 8786 / 9498" are UI patient NUMBERS, not API ids.** They resolve to
API patients **7517 / 7522 / 8286**. `GET /patients/8789` answers 200 — for an unrelated person — so
a query written on the ticket's numbers silently reads the wrong patient and reports the ticket as
unreproducible. The spec pins this mapping in its own test.

## 1. AC2's remaining two starting states

Verified automatically: **Not sent** (patient 8470, `Sanji VinsmokeTest`, Hono 622).

Still to do, each needing a patient in that state and an irreversible upload:

| Starting state | How to find one |
|---|---|
| Fee agreement **Sent** | `/honos?itemsPerPage=200` → `status: sent`, cross-referenced with `/prescriptions?treatmentStatus=For%20Review&insuranceType=private`. 58 such patients on 2026-09-25. |
| **No** fee agreement, or only archived/deleted | the same walk, keeping patients with no Hono in `not_sent`/`sent`/`signed`. This is the ticket's real case and the one `HonoUploadSigner` handles by creating a Hono. |

**Do not use patient 8286** (the ticket's "9498"). It is the billing team's real case and the last
untouched instance of the reported state — the ticket itself records that its other repro patient was
consumed by a workaround run. A spec test pins 8286 in its reported state so a change is noticed.

Steps: patient page → Patientendokumente → **+ Neues Dokument hochladen** → type
*Honorarvereinbarung*, status *Unterschrieben*, attach a PDF, save. Then check the Dokumentenzentrale
*Honorarvereinbarungen* card under *Unterschrieben*, the VO status and its Änderungsprotokoll.

## 2. The ETI contract date (AC1, last row)

`EtiClaimBuilder` sets `contractDate = $patient->getHono()?->getSignedDate() ?? $prescription->getDate()`,
so once the Hono is signed the contract date follows by construction. Confirming it end to end means
**submitting a claim to ETI Experts**, which files with a real debt-collection partner and cannot be
undone — this suite never submits (see `sa_eti_per_gesellschaft.spec.ts`). The ticket's own guidance
says to do this "only if the ETI connection on staging is confirmed to point at a test account;
otherwise leave this row to the developer's test", and `FeeAgreementScanConfirmTest` /
`SignedFeeAgreementUploadTest` cover it.

## 3. AC3's first clause — a NEW PKV VO starts Aktiv

Needs creating a VO, the suite's most write-heavy surface. `HonoStatusChecker` reads the latest
signed Honorarvereinbarung **document**, which is why this already worked before the fix; AC3's
second clause (the *Privat-VO ohne Honorarvereinb.* tile) IS asserted automatically, over the whole
tile rather than a sample.

## Running the automated end-to-end test

It is env-gated because an upload cannot be undone — `DELETE /patient_documents/{id}` is **405**, and
the request also archives the patient's unsigned Honos, signs one, and moves their PKV VOs to Aktiv.

```bash
FEE_AGREEMENT_PATIENT_ID=<api patient id> \
  npx playwright test tests/Staging/SuperAdmin/sa_fee_agreement_upload.spec.ts \
  --project=SAJhen --workers=1 --grep "end to end"
```

Pick a patient with an open Hono **and** a PKV VO in For Review/Pending, or the test cannot show the
activation — the half that was broken. It refuses to run against 8286.
