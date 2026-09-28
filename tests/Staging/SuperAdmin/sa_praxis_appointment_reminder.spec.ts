import { test, expect } from '@playwright/test';
import {
  PraxisAppointmentReminderPage,
  PRAXIS_BASE,
  REMINDER_LEAD_HOURS,
  SHIPPED_DEFAULT_LEAD_HOURS,
  TICKET_DEFAULT_LEAD_HOURS,
  CRON,
  SENDING_WINDOW,
  REMINDER_HISTORY_ACTION,
  CANCELLED_VIA_LINK_ACTION,
  BLOCKED_NO_CONSENT,
  type Appointment,
  type ReminderMessage,
} from '../../../Pages/praxis/praxis.appointment-reminder.page';

/**
 * RC 3.14 #3640 — every practice appointment gets one reminder, at the practice's own lead time,
 * with a cancel link. Commit `d278cbca5` (monorepo PR #3707) + `therapios/praxis#8`.
 *
 * READ-ONLY except the one AC2 round trip, which moves a TEST practice's lead time and puts it
 * back. Nothing here sends a text: the scheduler is a console command on an EventBridge rule and
 * this file only reads what its passes left behind.
 */

const S = PraxisAppointmentReminderPage;

/** `Praxis Flow Test Praxis (PM)` — the practice the AC2 round trip is allowed to touch. */
const TEST_PRACTICE_ID = 253;

/**
 * Appointment 6: booked 2026-09-18, start 2026-09-21 11:20 Berlin, patient 8502 WITH consent,
 * cancelled by staff on 2026-09-18 — i.e. it passed through its whole due window cancelled.
 * The only reason it has no reminder is the status filter, which is what makes it a fixture and
 * not just an absence.
 */
const CANCELLED_IN_WINDOW_APPOINTMENT = 6;

/**
 * Appointments booked INSIDE the lead time whose patients have consent — AC1's "no reminder" row
 * on the only rows that can demonstrate it. Without consent, "no message" is explained twice over.
 */
const BOOKED_INSIDE_WITH_CONSENT = [16, 17, 20];

/**
 * Message 1 was NOT produced by the scheduler: it was requested 2026-09-18T09:06:09Z for an
 * appointment whose remind-at is 2026-09-20T08:00Z, off the hourly :01 stamp, as message id 1
 * beside a `freed_slot_offer` four minutes later — a hand-run #3637 probe. Pinned so the
 * due-at-send assertion can exclude it by name rather than by loosening the rule.
 */
const MANUAL_PROBE_MESSAGE_ID = 1;

test.describe('#3640 appointment reminders at the practice lead time', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let api: PraxisAppointmentReminderPage;

  test.beforeEach(({ request }) => {
    api = new PraxisAppointmentReminderPage(request);
  });

  test(
    'deployment — the lead time is served by Flow and the reminder block is in the Praxis build',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      // The API half. `/status` cannot answer for this ticket (it gives the release, not the
      // commit — #3704), but `reminderLeadHours` is a NEW serialized column, so its presence is
      // the migration and the entity together.
      const practices = await api.practices();
      const served = practices.filter((p) => typeof p.reminderLeadHours === 'number');
      console.log(`#3640 Flow: ${served.length} of ${practices.length} facilities serve reminderLeadHours`);
      expect(served.length, 'reminderLeadHours is absent → PR #3707 is not on this API').toBe(practices.length);

      // The Praxis half, which is a separate deploy at a separate host.
      const { js, chunks } = await api.praxisLoginBundle();
      console.log(`#3640 Praxis ${PRAXIS_BASE}: ${chunks.length} chunks, ${js.length} bytes of JS`);
      expect(js.length).toBeGreaterThan(10_000);
      expect(js, 'the Settings reminder block (praxis#8) is not in the deployed build').toContain(
        '"reminder":{"title":"Terminerinnerung"',
      );
    },
  );

  test(
    'AC1 the lead time is a per-practice setting — FINDING: the default is 24, the AC now says 48',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const practices = await api.practices();
      const byValue = new Map<number, number>();
      for (const p of practices) byValue.set(p.reminderLeadHours!, (byValue.get(p.reminderLeadHours!) ?? 0) + 1);
      const praxis = practices.filter((p) => p.type === 'practice');

      console.log(
        `#3640 lead times across ${practices.length} facilities: ${JSON.stringify(Object.fromEntries(byValue))}`,
      );
      console.log(
        `#3640 Praxis Flow practices (type=practice): ${praxis.map((p) => `${p.id} ${p.name} @${p.reminderLeadHours}h`).join(' | ')}`,
      );

      // Every value is one of the two the AC names — that part holds.
      for (const p of practices) {
        expect(REMINDER_LEAD_HOURS, `facility ${p.id} ${p.name}`).toContain(p.reminderLeadHours);
      }
      // It is genuinely per practice: the column is on the facility, one value each.
      expect(praxis.length).toBeGreaterThan(0);

      // FINDING, stated rather than failed. The rule table reads "default 48 hours, with 24 hours
      // as the alternative (management decision, 16 Sep 2026)". PR #3707 merged on 15 Sep and
      // ships `DEFAULT_REMINDER_LEAD_HOURS = 24`, a migration that wrote 24 onto every existing
      // row, and a frontend schema defaulting to 24 (praxis#8 `REMINDER_LEAD_HOURS_DEFAULT`).
      const atTicketDefault = practices.filter((p) => p.reminderLeadHours === TICKET_DEFAULT_LEAD_HOURS).length;
      console.log(
        `#3640 FINDING: AC1 asks for a default of ${TICKET_DEFAULT_LEAD_HOURS}h; the shipped default is ` +
          `${SHIPPED_DEFAULT_LEAD_HOURS}h and ${atTicketDefault} of ${practices.length} facilities read ${TICKET_DEFAULT_LEAD_HOURS}h. ` +
          `The management decision (16 Sep) postdates the merge (15 Sep) — the PM's comment says "no action needed ` +
          `unless the default lives somewhere that needs a separate change", and it does: the entity constant, ` +
          `migration Version20260915114322, and praxis#8's zod default.`,
      );
      expect(byValue.get(SHIPPED_DEFAULT_LEAD_HOURS) ?? 0).toBeGreaterThan(0);
    },
  );

  test(
    'AC1 the setting accepts only 24 or 48 — the guards refuse before any write',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const before = (await api.practice(TEST_PRACTICE_ID)).reminderLeadHours;

      // Assert\Choice. Each of these is a real PATCH whose passing outcome is the refusal, so the
      // value is re-read afterwards to prove nothing was written.
      for (const bad of [36, 0, 12]) {
        const res = await api.setLeadHours(TEST_PRACTICE_ID, bad);
        console.log(`#3640 PATCH reminderLeadHours=${bad} -> ${res.status}`);
        expect(res.status, `a lead time of ${bad}h must be refused`).toBe(422);
        expect(JSON.stringify(res.body)).toContain('not a valid choice');
      }

      // NOT NULL. A null would have to mean "no reminders" or "use the default" and the screen
      // cannot tell which, so the column refuses it at the type level rather than at validation.
      const nulled = await api.setLeadHours(TEST_PRACTICE_ID, null as unknown as number);
      console.log(`#3640 PATCH reminderLeadHours=null -> ${nulled.status}`);
      expect(nulled.status).toBe(400);

      expect((await api.practice(TEST_PRACTICE_ID)).reminderLeadHours).toBe(before);
    },
  );

  test(
    'AC1 an appointment booked inside the lead time is never reminded',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const [appointments, messages, practices] = await Promise.all([
        api.appointments(),
        api.reminderMessages(),
        api.practices(),
      ]);
      const leadOf = new Map(practices.map((p) => [p.id, p.reminderLeadHours!]));
      const remindedIds = new Set(messages.map((m) => m.appointmentId));

      const bookedInside = appointments.filter((a) => {
        const lead = leadOf.get(a.practiceId!)!;
        return a.bookedAt !== null && a.bookedAt > S.remindAt(a, lead);
      });
      console.log(`#3640 ${bookedInside.length} of ${appointments.length} appointments were booked inside the lead time`);

      // The rule itself: not one of them carries a reminder.
      const violations = bookedInside.filter((a) => remindedIds.has(a.id));
      expect(violations.map((a) => a.id), 'an appointment booked inside the lead time was reminded').toEqual([]);

      // The rule is only DEMONSTRATED where the absence has no second explanation. A patient with
      // no SMS consent produces no reminder either way, so the fixtures have to be consented ones.
      const consent = await api.consentByPatient(
        BOOKED_INSIDE_WITH_CONSENT.map((id) => appointments.find((a) => a.id === id)!.patientId!),
      );
      for (const id of BOOKED_INSIDE_WITH_CONSENT) {
        const a = appointments.find((x) => x.id === id)!;
        const lead = leadOf.get(a.practiceId!)!;
        const remindAt = S.remindAt(a, lead);
        console.log(
          `#3640 appt ${id}: starts ${S.berlinWallClock(a.startsAt)} Berlin, remind-at ` +
            `${S.berlinWallClock(remindAt)}, booked ${S.berlinWallClock(a.bookedAt!)}, ` +
            `patient ${a.patientId} consent=${consent.get(a.patientId!)} -> no reminder`,
        );
        expect(consent.get(a.patientId!), `appt ${id} must have consent to be discriminating`).toBe(true);
        expect(a.bookedAt!.getTime()).toBeGreaterThan(remindAt.getTime());
        expect(remindedIds.has(id)).toBe(false);
      }
    },
  );

  test(
    'AC1 every reminder sent was due when it was sent, and nothing due was missed',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const [appointments, messages, practices] = await Promise.all([
        api.appointments(),
        api.reminderMessages(),
        api.practices(),
      ]);
      const leadOf = new Map(practices.map((p) => [p.id, p.reminderLeadHours!]));
      const byId = new Map(appointments.map((a) => [a.id, a]));
      const now = new Date();
      const lastRun = S.lastRunBefore(now);
      console.log(`#3640 now ${now.toISOString()}; the most recent hourly pass was ${lastRun.toISOString()} (${CRON})`);

      // Forwards: every reminder in the log was inside its appointment's due window when it was
      // requested, and carries the scheduler's :01-past-the-hour fingerprint.
      for (const m of messages) {
        const a = byId.get(m.appointmentId!);
        if (!a) continue;
        const remindAt = S.remindAt(a, leadOf.get(a.practiceId!)!);
        const dueAtSend = remindAt <= m.requestedAt && m.requestedAt < a.startsAt;
        console.log(
          `#3640 msg ${m.id} appt ${a.id} ${m.status} requested ${m.requestedAt.toISOString()} ` +
            `(remind-at ${remindAt.toISOString()}, start ${a.startsAt.toISOString()}) -> ${dueAtSend ? 'due at send' : 'NOT due at send'}`,
        );
        if (m.id === MANUAL_PROBE_MESSAGE_ID) {
          expect(dueAtSend, 'the pinned manual probe is expected to be early; if it is not, re-check it').toBe(false);
          continue;
        }
        expect(dueAtSend, `msg ${m.id} was sent outside appointment ${a.id}'s due window`).toBe(true);
        expect(m.requestedAt.getUTCMinutes(), `msg ${m.id} is not on the hourly pass`).toBeLessThan(15);
      }

      // Backwards — the catch-up invariant, which is what makes this durable rather than a
      // snapshot: an appointment may only still be un-reminded if it entered its window AFTER the
      // last pass ran.
      const missed = appointments.filter((a) => {
        if (messages.some((m) => m.appointmentId === a.id)) return false;
        const lead = leadOf.get(a.practiceId!)!;
        if (!S.isDue(a, lead, now).due) return false;
        return S.remindAt(a, lead) <= lastRun;
      });
      for (const a of missed) {
        console.log(`#3640 MISSED appt ${a.id} remind-at ${S.remindAt(a, leadOf.get(a.practiceId!)!).toISOString()}`);
      }
      expect(missed.map((a) => a.id), 'an appointment was due before the last pass and has no reminder').toEqual([]);
    },
  );

  test(
    'AC1 one reminder per appointment, and a cancelled appointment gets none',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const [appointments, messages, practices] = await Promise.all([
        api.appointments(),
        api.reminderMessages(),
        api.practices(),
      ]);
      const leadOf = new Map(practices.map((p) => [p.id, p.reminderLeadHours!]));

      // De-duplication. The scheduler reads the message log, so however many passes have run
      // there is at most one reminder row per appointment.
      const perAppointment = new Map<number, number>();
      for (const m of messages) perAppointment.set(m.appointmentId!, (perAppointment.get(m.appointmentId!) ?? 0) + 1);
      const doubled = [...perAppointment].filter(([, n]) => n > 1);
      console.log(`#3640 ${messages.length} reminders over ${perAppointment.size} appointments; duplicates: ${doubled.length}`);
      expect(doubled).toEqual([]);

      // A cancelled appointment is skipped — demonstrated on one that sat cancelled THROUGH its
      // whole due window with a consented patient, so the status filter is the only explanation.
      const a = appointments.find((x) => x.id === CANCELLED_IN_WINDOW_APPOINTMENT)!;
      const remindAt = S.remindAt(a, leadOf.get(a.practiceId!)!);
      const cancelledAt = new Date(a.history.find((h) => h.action === 'cancelled')!.changedAt);
      const consent = await api.consentByPatient([a.patientId!]);
      console.log(
        `#3640 appt ${a.id}: cancelled ${cancelledAt.toISOString()} before its remind-at ${remindAt.toISOString()}; ` +
          `patient ${a.patientId} consent=${consent.get(a.patientId!)}; window has passed (start ${a.startsAt.toISOString()}) -> no reminder`,
      );
      expect(a.status).toBe('cancelled');
      expect(consent.get(a.patientId!)).toBe(true);
      expect(cancelledAt.getTime()).toBeLessThan(remindAt.getTime());
      expect(remindAt.getTime()).toBeLessThan(Date.now());
      expect(messages.some((m) => m.appointmentId === a.id)).toBe(false);
    },
  );

  test(
    'AC1 every reminder was requested inside the 08:00–20:00 Berlin window',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const messages = await api.reminderMessages();
      for (const m of messages) {
        const hour = S.berlinHour(m.requestedAt);
        console.log(`#3640 msg ${m.id} requested ${S.berlinWallClock(m.requestedAt)} Berlin (hour ${hour})`);
        expect(hour, `msg ${m.id} was requested outside the sending window`).toBeGreaterThanOrEqual(
          SENDING_WINDOW.fromHour,
        );
        expect(hour).toBeLessThan(SENDING_WINDOW.toHour);
      }

      // The window is #3637's rule, not re-implemented here — the schedule simply never asks
      // outside it. `cron(0 6-19 * * ? *)` is 07:00–20:00 Berlin in winter and 08:00–21:00 in
      // summer, and TextMessageSender holds anything at the edges until 08:00.
      expect(CRON).toBe('cron(0 6-19 * * ? *)');
      for (const utcHour of [6, 19]) {
        const berlin = S.berlinHour(new Date(Date.UTC(2026, 6, 1, utcHour, 0, 0)));
        console.log(`#3640 cron hour ${utcHour}:00 UTC is ${berlin}:00 Berlin (CEST)`);
      }
    },
  );

  test(
    'AC1 logging — the message log carries every reminder; the appointment history carries only the ones that went',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const [appointments, messages] = await Promise.all([api.appointments(), api.reminderMessages()]);
      const byId = new Map(appointments.map((a) => [a.id, a]));

      const historyRows = appointments.flatMap((a) =>
        a.history.filter((h) => h.action === REMINDER_HISTORY_ACTION).map((h) => ({ appointment: a.id, ...h })),
      );
      const blocked = messages.filter((m) => m.status === BLOCKED_NO_CONSENT);
      const delivered = messages.filter((m) => m.status !== BLOCKED_NO_CONSENT);
      console.log(
        `#3640 message log: ${messages.length} reminders (${delivered.length} not blocked, ${blocked.length} ${BLOCKED_NO_CONSENT}); ` +
          `appointment history: ${historyRows.length} "${REMINDER_HISTORY_ACTION}" rows across ${appointments.length} appointments`,
      );

      // The half that holds on today's data: a blocked reminder writes NO history row. That is
      // deliberate — "reminder sent" against somebody never texted is the sentence a receptionist
      // would read out to a patient complaining they were never told.
      for (const m of blocked) {
        const a = byId.get(m.appointmentId!);
        if (!a) continue;
        expect(
          a.history.some((h) => h.action === REMINDER_HISTORY_ACTION),
          `appt ${a.id} was blocked for consent and must carry no ${REMINDER_HISTORY_ACTION} row`,
        ).toBe(false);
      }

      // The other half, whenever it exists: a reminder that DID go must appear in the history
      // carrying the message id, so the two surfaces point at each other.
      for (const row of historyRows) {
        console.log(`#3640 ${REMINDER_HISTORY_ACTION} on appt ${row.appointment} at ${row.changedAt}: ${JSON.stringify(row.detail)}`);
        expect(row.detail, 'the history row must carry the message id').toHaveProperty('textMessage');
        expect(row.changedByName, 'the system sent it, not a member of staff').toBeFalsy();
        expect(messages.some((m) => m.id === row.detail!.textMessage)).toBe(true);
      }

      // FINDING — reported, not failed: on today's staging AC1's history half has never run.
      if (historyRows.length === 0) {
        const explained = messages.map((m) =>
          m.id === MANUAL_PROBE_MESSAGE_ID ? `msg ${m.id} sent by hand outside the scheduler` : `msg ${m.id} ${m.status}`,
        );
        console.log(
          `#3640 FINDING: ZERO "${REMINDER_HISTORY_ACTION}" rows exist on staging, so AC1's ` +
            `"and in the appointment's own history" half is unexercised. Every candidate is accounted for — ${explained.join('; ')} — ` +
            `so this is a data gap, not a defect: the two scheduler reminders were correctly blocked for consent, and the one ` +
            `consented appointment in its window (appt 3) had its scheduled reminder suppressed by the hand-run probe already in the log.`,
        );
      }
    },
  );

  test(
    'AC2 nothing is scheduled ahead — the lead time is the only state, and moving it moves what is due',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@Mutating'] },
    async () => {
      const [appointments, messages, practices] = await Promise.all([
        api.appointments(),
        api.reminderMessages(),
        api.practices(),
      ]);

      // AC2's implementation IS the absence of a queue: there is no due-time, no "reminder
      // scheduled at", no reminder flag anywhere on an appointment. A stamped schedule would have
      // to be rewritten on every settings save; this cannot drift because it does not exist.
      const keys = new Set(appointments.flatMap((a) => a.keys));
      console.log(`#3640 appointment payload keys: ${[...keys].sort().join(', ')}`);
      for (const k of [...keys]) {
        expect(
          /remind|scheduledFor|dueAt|notifyAt/i.test(k),
          `"${k}" looks like a stored reminder schedule — AC2 assumes there is none`,
        ).toBe(false);
      }

      // The due set is therefore a pure function of the CURRENT setting. Re-derive it at both
      // allowed lead times and show the two differ, which is the whole of "reminders not yet sent
      // follow the new lead time".
      const now = new Date();
      const windows = REMINDER_LEAD_HOURS.map((lead) => ({
        lead,
        inWindow: appointments
          .filter((a) => a.startsAt > now && S.remindAt(a, lead) <= now)
          .map((a) => a.id),
      }));
      for (const w of windows) console.log(`#3640 at a ${w.lead}h lead, ${w.inWindow.length} appointments are inside the window: [${w.inWindow}]`);
      expect(windows[1].inWindow.length, 'a wider lead time must reach at least as many appointments').toBeGreaterThanOrEqual(
        windows[0].inWindow.length,
      );
      expect(
        windows[1].inWindow.filter((id) => !windows[0].inWindow.includes(id)).length,
        'no appointment separates the two lead times right now — this run cannot demonstrate AC2',
      ).toBeGreaterThan(0);

      // And the live round trip, on a test practice, restored immediately.
      const before = (await api.practice(TEST_PRACTICE_ID)).reminderLeadHours!;
      const other = REMINDER_LEAD_HOURS.find((h) => h !== before)!;
      try {
        const moved = await api.setLeadHours(TEST_PRACTICE_ID, other);
        expect(moved.status).toBe(200);
        const readBack = (await api.practice(TEST_PRACTICE_ID)).reminderLeadHours;
        console.log(`#3640 practice ${TEST_PRACTICE_ID}: ${before}h -> ${readBack}h, no queue rewritten`);
        expect(readBack).toBe(other);

        // "reminders already sent are unaffected" — the log is history, and a settings change is
        // not allowed to touch it.
        const after = await api.reminderMessages();
        const shape = (m: ReminderMessage[]) =>
          m.map((x) => `${x.id}:${x.appointmentId}:${x.status}:${x.requestedAt.toISOString()}`).sort();
        expect(shape(after), 'a lead-time change rewrote an already-sent reminder').toEqual(shape(messages));
      } finally {
        const restored = await api.setLeadHours(TEST_PRACTICE_ID, before);
        expect(restored.status).toBe(200);
        expect((await api.practice(TEST_PRACTICE_ID)).reminderLeadHours).toBe(before);
      }
    },
  );

  test(
    'AC4 the reminder block ships in German and in English',
    { tag: ['@SuperAdmin', '@PraxisReminder', '@ReadOnly'] },
    async () => {
      const { js, html } = await api.praxisLoginBundle();

      // The language toggle AC4 points at is on the login page itself.
      expect(html).toContain('Deutsch');
      expect(html).toContain('English');

      const pairs: [string, string][] = [
        ['Terminerinnerung', 'Appointment reminder'],
        ['Erinnerung senden', 'Send the reminder'],
        ['{{count}} Stunden vorher', '{{count}} hours before'],
        ['Das erhält der Patient', 'What the patient receives'],
        ['Erinnerung versendet', 'Reminder sent'],
        [
          'Eine Änderung verschiebt alle noch nicht versendeten Erinnerungen.',
          'Changing this moves every reminder that has not gone out yet.',
        ],
        [
          'die Vorlaufzeit für Terminerinnerungen zu ändern',
          'change the appointment-reminder lead time',
        ],
      ];
      for (const [de, en] of pairs) {
        const deCount = js.split(de).length - 1;
        const enCount = js.split(en).length - 1;
        console.log(`#3640 i18n  de "${de}" ×${deCount}   en "${en}" ×${enCount}`);
        expect(deCount, `German value missing: ${de}`).toBeGreaterThan(0);
        expect(enCount, `English value missing: ${en}`).toBeGreaterThan(0);
      }

      // The sample reminder text the Settings block shows, in both locales — the Localization
      // Reference's own wording, cancel link included.
      expect(js).toContain('Erinnerung an Ihren Termin am');
      expect(js).toContain('Wir freuen uns auf Sie. Absagen:');
      expect(js).toContain('Reminder for your appointment on');
      expect(js).toContain('We look forward to seeing you. Cancel:');
    },
  );
});
