# #3899 + #3908 — what is not automated, and why

`tests/Staging/SuperAdmin/sa_refusal_reasons.spec.ts` covers every client-reachable AC of both
tickets (5 passed, 2026-10-05).

## Verified automatically

| Ticket | AC | How |
|---|---|---|
| #3899 | 1 | a refused `POST /activities/bulk` carries `code: ACTIVITY_MAX_TREATMENTS_REACHED` beside the unchanged `propertyPath: prescription` |
| #3899 | 2 | the shipped `violationDigest` sends `violationCount` / `violationFields` / `violationCodes` and reads nothing but `propertyPath` and `code` off a violation; `violationCodes` is on the Sentry `ALLOWLIST_KEYS` |
| #3899 | 3 | the digest filters codes through `/^[A-Za-z0-9_-]{1,64}$/`, driven over identifier-shaped and not-identifier-shaped values |
| #3908 | 1 | the duplicate guard runs **before** the POST, showing `vo_validation.treatment_history.treatment_already_added` (DE + EN both ship) |
| #3908 | 2 | `HTTP 422` occurs **0** times in the served bundle; `detailOf` reads `detail` / `hydra:description` off the body |

## Not verifiable from a client

### #3899 AC4 and AC5 — production observation

*"After one release in production, THERAPIOS-REACT-NATIVE-4W events can be grouped by refusal
code, and the dominant cause is identified."* That is a Sentry query after a production release,
not a staging check. AC5 then depends on what the grouping shows.

**What to do after the release:** group THERAPIOS-REACT-NATIVE-4W by `violationCodes` and read off
the distribution. The five candidates are `vo_deleted`, the conflict resolver's
`controls.activity.limit`, `MaxTreatmentReached`, the `ActivityLimit` double-treatment rule and
`PrescriptionNotDeleted`. Expected business refusals should stop being reported as errors; any
that look like a defect get their own ticket.

### #3908 AC4, AC5, AC6 — the DATEV payment pull

`app:datev:pull-payments` (21:47 UTC) is a console command and its warning is a CloudWatch/Sentry
log line. **No route, no serialized field, nothing a client can read.**

- **AC4** (the warning carries the company ID and both counts) — read it in CloudWatch after a
  nightly run.
- **AC5** (a new logger context key that is not on the allowlist fails `LoggerContextKeyWhitelistTest`)
  — a PHPUnit test in the repo.
- **AC6** (the held-back counts per company are known after the first production nightly) — a
  production observation.

### #3908 AC3 — adding a Heilmittel that is *not* yet on the session

Not driven: it is a successful write that puts a real Heilmittel on a real session, with the
`ActivityTreatment` row and its price snapshot that implies. The guard it has to get past is the
`some(...)` check verified above, which by construction does not fire for a Heilmittel that is
absent.

## How the one write in the automated file stays safe

`POST /activities/bulk` is aimed at a VO that has already used every prescribed treatment, so the
only correct outcome is a **422** and a passing run creates nothing. Picking any other VO would
create a real Activity. Two shape traps on that endpoint, either of which produces a **400** that
reads like a refusal on the merits:

- the payload is a **bare array** — wrapped in `{activities: […]}` it answers *"expected a JSON array"*;
- each row needs a **`therapist` IRI**, and the VO serializes its therapist as an **object**, so
  passing it through gives *"item 0 is missing a therapist IRI"*.
