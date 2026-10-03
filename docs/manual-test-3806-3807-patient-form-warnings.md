# #3806 + #3807 — patient-form warnings: what still needs a person

`tests/Staging/SuperAdmin/sa_patient_form_warnings.spec.ts` covers both tickets
**read-only, creating no patient**. This file records what that cannot reach, and the
reasoning behind the probe shapes.

## Why no patient is created

Both tickets are *about* creating patients, but **both checks are reads the form issues
while someone types**, so each AC table is driven against the endpoint the screen itself
calls:

| Ticket | Endpoint | Answers |
|---|---|---|
| #3806 | `GET /patients/insurance-number-check?number=` | `{matchType: 'bsnr' \| 'lanr' \| null}` |
| #3807 | `GET /patients/duplicate-check?firstName=&lastName=&lenient=1&birthDate=` | members carrying `matchType` |

**#3806's other half is client-side**, and the deployed rule survives minification
verbatim, so the spec ports it from the bundle rather than reconstructing it from the AC:

```js
y = /^[A-Za-z]\d{9}$/,
N = (e,n) => 'public'===n && /^\d{9}$/.test(e.trim()),    // isInsuranceNumberLookupCandidate
f = (e,n,t) => { const s = e.trim();
  return 'public'!==n || ''===s ? null : null!==t ? t : y.test(s) ? null : 'format' }
```

That is AC1 and AC2 entire — the trim, the empty case, the insurance-type gate, the
format regex, and `null !== t ? t`, which *is* "the BSNR or LANR warning replaces the
format warning". `N` also explains why a correct number costs no request: the server is
asked only for values that are exactly nine digits.

## What a person still has to do

1. **#3806 AC4** — save a patient while the warning shows. Needs a real `POST /patients`
   and a free insurance number. The PM did it (patient 99867, number `A12345678`) and
   also re-checked the unchanged hard block for a number already in use, which answers
   **422** and names the existing Patienten-ID.
2. **#3807 AC5** — "Kein Duplikat bestätigen", then create. Also a real patient (the PM
   created 99866 and 99879, which is why rows 4 and 5 of the AC3 table now return **two**
   members each: the AC's intended partner plus the patient the PM created).
3. **The three surfaces (#3806 AC3, #3807 AC4)** — the Create Patient pop-up from both VO
   forms and the Patient Management add/edit forms. One `PatientForm` renders in all of
   them, so the logic is shared by construction; what a person is really checking is that
   each route mounts it and that the edit form shows the warning **on opening** with a
   saved bad number (the PM used patient 99864, saved `9876543210`).
4. **The scan path** — the pop-up opening pre-filled from a scan with GKV already chosen
   shows the warning before any typing. #3811 is what fills the type from the scan;
   before it, the type starts empty and no warning can appear until GKV is chosen.

## Traps

- **Do not use a plain 9-digit number as a "format only" example.** `123456789` is itself
  a BSNR on staging, so it answers `bsnr` and the BSNR warning replaces the format one.
  The PM hit this too. Use `1234567890` (ten digits) or `A12345678` (eight).
- **`/practice_bsnrs?number=` and `/doctors?doctorId=` are silently ignored** — both
  return the whole collection (1,459 and 1,946), exactly like a bogus key. "I filtered
  and found it" is not evidence the row exists; walk instead. Walking also settles
  something a filter could not: that each fixture is **unambiguous** — `723253500` is a
  BSNR and nobody's LANR, `820665702` a LANR and no practice's BSNR. A number that were
  both would leave the expected warning undefined by the AC.
- **`773748000` is an ADDITIONAL BSNR** (`isMain: false`), which is the half of AC1's
  "main or additional" clause that a main-only lookup would miss.
- **The bundle escapes non-ASCII** (`\xNN` below 256, `\uXXXX` above), so a plain search
  for `"… Bitte prüfen Sie die Nummer."` returns 0 and reads like "never shipped"
  (#3611, #3873). Count both forms.
- **#3807's fixtures share a birth date (01.02.1950) and a last-name stem**, so a query
  typed slightly wrong silently matches a neighbouring row rather than failing. Assert on
  the expected `patientId`, not merely on "something was returned".

## Notes for the PM

- **AC3 rows 4 and 5 now return two members each**, because AC5's own test created
  "Anna Testmüller … R4/R5". The extra row is a correct `name_dob` match, not a defect —
  but a QA following the reproduction steps will see two rows where the ticket's table
  implies one. The PM's own reproduction notes this.
- **#3807's "expected effect" (39 groups, 80 patients) is a production figure** from the
  25 Sep copy and is not re-derived here: it needs a walk of the whole patient table with
  the fold applied on both sides. The named example pairs (8864/8181 and the rest) are
  **production ids**; the staging pairs the PM used are 9443/5675 and 2900/9579.
- These two tickets and **#3810** all put a message on the same form — #3810's required
  insurer (blocks the save), #3806's number warning (never blocks), and #3807's duplicate
  dialog (confirm or cancel). Worth one pass with all three showing at once.
