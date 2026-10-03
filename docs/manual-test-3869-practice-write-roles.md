# #3869 — only admins may create or change a practice: what a person still has to do

`tests/Staging/SuperAdmin/sa_practice_write_roles.spec.ts` verifies AC1, AC2 and AC4 as
a status-code matrix, plus the Out-of-Scope neighbours — **without writing anything**.
This file records the one AC that needs a real save, and the reasoning behind the
probe shapes so nobody re-derives them.

## Status on staging, 2026-10-03 (API 3.15.0, fix `ff7f527bf`)

Deployed. A therapist is refused on create, change and delete; both admin roles pass
the gate.

## Why the suite does not simply save something

AC3 says admins must still be able to save on the practice form and in the CRM notes.
Proving that by saving means **changing a real practice** — and one of the fields the
ticket is about, `practiceId`, renumbers the main BSNR row and removes other rows
holding that number (`Practice::setPracticeId()`). So the suite proves the *gate* lets
admins through and stops there:

| What the suite proves | How |
|---|---|
| The admin passes authorization | `PATCH /practices/99999999` → **404**, where a therapist gets **403** |
| The write path is live | `PATCH /practices/1` with `{}` → **200**, body byte-identical before and after |
| Nothing was created | the practice count is unchanged |

**What it does not prove** is that a field-changing save works end to end. The PM
verified that in the UI (create + edit on the Practices page, a CRM note saved twice),
and it is the one step worth repeating by hand after a deploy:

1. As an Admin: Admin → Praxis → **+ Praxis hinzufügen**, fill BSNR, name, region and a
   phone contact → created and listed at once.
2. Open it, change the name, **Speichern** → saved (check the form, the list, the
   reopened form and a reload — #3797 changed how these refresh).
3. Open its CRM page → **Notizen hinzufügen** → type → **Speichern** →
   "Notizen erfolgreich gespeichert".
4. Delete the practice you created.

## The probe shapes, and why they are what they are

- **An absent id is the safe way to test an "allowed" leg.** Authorization runs *before*
  the object is fetched here, so `PATCH /practices/99999999` answers **403 for a
  therapist and 404 for an admin** — one request separates the roles and writes nothing
  either way. Without it, showing "the admin is allowed" means mutating a practice.
- **The message, not the status, says which rule fired.** The fix ships its own wording
  while the neighbours keep Symfony's generic one:

  | Resource | Therapist refusal |
  |---|---|
  | `/practices` Post / Patch / Delete | `Only administrators can create / change / delete practices.` |
  | `/practice_bsnrs`, `/practice_contacts` | `Access Denied.` |
  | `/practice_activities` | not refused — **404 for both roles**, no gate |

  A test that checked only for 403 could not tell the new gate from a pre-existing one.
- **An empty body is not a universal probe.** `POST /practice_activities` with `{}`
  answers **500 for every role**, so it discriminates nothing and looks like a server
  fault rather than an authorization answer. The absent-id form answers a clean 404
  there instead. Prove the probe shape works on a resource before reading a role rule
  out of it.
- **Every refused attempt sends the field's CURRENT value** (`notes`, `practiceId`,
  `name`), so even a build whose gate had failed would write nothing. The 403 is the
  assertion; the before/after body diff is the safety net.

## Notes for the PM

- AC4's example names "the Practice field in the VO form", a screen **a therapist cannot
  open on the web** — the VO form route is admin-only and unchanged by this ticket. The
  PM raised the same point. The suite checks what a therapist genuinely reaches instead:
  the dropdown search (`/v2/practices?groups[]=practice:dropdown&search[name]=`), the
  list, a detail and the count — all 200.
- **There is no audit trail for this.** `practice` has no `created_by`/`updated_by` and
  there is no practice change log, so "only admin screens ever wrote practices" cannot
  be measured after the fact — it rests on the code read in the ticket's Developer
  Reference. That is also why the ticket is worth a regression guard: nothing in the
  data would reveal a future regression.
- **Run at `--workers=1`.** Three tokens are minted per run and #3462 throttles
  `POST /auth` at 5 per minute per username.
