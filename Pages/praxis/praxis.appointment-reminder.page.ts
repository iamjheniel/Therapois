import { APIRequestContext } from '@playwright/test';
import { API_BASE, STAGING_CREDENTIALS } from '../util/api-token';

/**
 * Appointment reminders at each practice's own lead time — RC 3.14 #3640,
 * commit `d278cbca5` (PR #3707) in the monorepo, plus `therapios/praxis#8` for the Settings block.
 *
 * ## Praxis Flow is a SECOND FRONT END over the SAME API, and that is what makes this testable
 *
 * `therapios/praxis` holds no rows of its own — every appointment, room, text message and consent
 * flag is a Doctrine entity in `api/`, exposed through API Platform. So the whole of this ticket's
 * state is readable from `api.staging.therapios.de` with an ordinary Flow token: `/appointments`
 * (with its `history` embedded), `/text_messages` (the practice's message log) and
 * `/elderly_care_homes` (which carries the new `reminderLeadHours`). The Praxis app itself is
 * deployed separately at {@link PRAXIS_BASE} and is only needed for AC4.
 *
 * ## The scheduler is STATELESS, and that is AC2
 *
 * Nothing is scheduled at booking time. `AppointmentReminderScheduler::run()` asks, on every pass,
 * which appointments are due *under the setting as it stands* — so a practice moving 24 → 48 at
 * lunchtime has tomorrow afternoon's patients reminded this evening, with no queue to rewrite.
 * Two consequences for a test: there is **no due-time field anywhere on the appointment** (which
 * is assertable), and the rule is a pure function of data the API already serves (which is
 * portable — see {@link isDue}).
 *
 * The pass runs from EventBridge on {@link CRON} — hourly on the hour, 06:00–19:00 UTC — and its
 * fingerprint is visible in the log: every scheduler-sent reminder is stamped at about :01 past
 * an hour, which is how a reminder the scheduler sent can be told from one a QA sent by hand.
 *
 * ## Traps
 *
 *  - **`smsConsentGranted` is accepted and SILENTLY IGNORED as a filter on `/patients`.** `=true`,
 *    `=false` and no filter at all each answer the full 8,401 rows, so a consent population can
 *    only be counted by reading patients one at a time. Consent decides whether a reminder writes
 *    a history row at all, so getting this wrong inverts the ticket's headline result.
 *  - **A blocked reminder writes NO history row, by design.** `remind()` returns early on
 *    `blocked_no_consent`, because "reminder sent" against somebody never texted is a false
 *    statement. So "the message log has a row" and "the appointment history has a row" are
 *    deliberately not the same set, and a test that requires both on every message fails on a
 *    correct build.
 *  - **`dropped_staging` is NOT blocked.** Staging drops the actual send (#3637) but the message
 *    counts as sent, so it DOES write a history row. It is the only status on staging that can
 *    exercise AC1's history half.
 *  - **De-duplication reads the MESSAGE LOG, not the history row** — any `appointment_reminder`
 *    row for an appointment, whatever produced it and whenever, suppresses the scheduled one
 *    forever.
 *  - **`date` and `startTime` are two columns and they mean Berlin wall clock.** `date` serializes
 *    as `2026-09-22T00:00:00+00:00` and `startTime` as `1970-01-01T08:20:00+00:00`; reading either
 *    as UTC moves every appointment by the Berlin offset. See {@link berlinStart}.
 */

/** Where the Praxis Flow front end is deployed (from `therapios/praxis` `.github/workflows/deploy.yml`). */
export const PRAXIS_BASE = 'https://praxis-staging.curano.de';

/** `ElderlyCareHome::REMINDER_LEAD_HOURS` — the values `Assert\Choice` allows. */
export const REMINDER_LEAD_HOURS = [24, 48] as const;

/** `ElderlyCareHome::DEFAULT_REMINDER_LEAD_HOURS` — what the entity and the migration actually ship. */
export const SHIPPED_DEFAULT_LEAD_HOURS = 24;

/**
 * What AC1 asks for TODAY: "default 48 hours, with 24 hours as the alternative (management
 * decision, 16 Sep 2026)". The decision landed the day AFTER PR #3707 merged, and the code still
 * carries the pre-decision default — kept as its own constant so the gap is stated rather than
 * discovered.
 */
export const TICKET_DEFAULT_LEAD_HOURS = 48;

/** The EventBridge schedule the reminder pass runs on. */
export const CRON = 'cron(0 6-19 * * ? *)' as const;

/** AC1's sending window, Europe/Berlin — enforced by `TextMessageSender` (#3637), not re-implemented. */
export const SENDING_WINDOW = { fromHour: 8, toHour: 20 } as const;

export const REMINDER_TEMPLATE = 'appointment_reminder';
export const REMINDER_HISTORY_ACTION = 'reminder_sent';
export const CANCELLED_VIA_LINK_ACTION = 'cancelled_via_link';
export const BLOCKED_NO_CONSENT = 'blocked_no_consent';

export type Practice = {
  id: number;
  name: string;
  type: string | null;
  reminderLeadHours: number | undefined;
};

export type HistoryRow = {
  action: string;
  changedAt: string;
  changedByName: string | null;
  detail: Record<string, unknown> | null;
};

export type Appointment = {
  id: number;
  patientId: number | null;
  practiceId: number | null;
  status: string;
  /** Berlin wall-clock start, as an absolute instant. */
  startsAt: Date;
  bookedAt: Date | null;
  history: HistoryRow[];
  /** Every key the payload actually carries — AC2 asserts none of them is a stored due time. */
  keys: string[];
};

export type ReminderMessage = {
  id: number;
  appointmentId: number | null;
  patientId: number | null;
  practiceId: number | null;
  status: string;
  locale: string | null;
  requestedAt: Date;
};

export class PraxisAppointmentReminderPage {
  private token: string | null = null;

  constructor(private request: APIRequestContext) {}

  async bearer(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.request.post(`${API_BASE}/auth`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        username: STAGING_CREDENTIALS.superadmin.email,
        password: STAGING_CREDENTIALS.superadmin.password,
      },
      timeout: 60_000,
    });
    if (!res.ok()) throw new Error(`POST /auth -> ${res.status()}`);
    this.token = (await res.json()).token as string;
    return this.token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}`);
    return (await res.json()) as T;
  }

  // ───────────────────────────── the ported rule ─────────────────────────────

  /**
   * `FreedSlot::berlinStart($date, $time)` — the two columns read as one Berlin wall clock.
   *
   * Built through `Intl` rather than by adding a fixed offset, because the offset is +01:00 or
   * +02:00 depending on the date and a hard-coded one is wrong for half the year.
   */
  static berlinStart(date: string, startTime: string): Date {
    const day = date.slice(0, 10);
    const hhmm = startTime.slice(11, 16);
    // Find the UTC instant whose Europe/Berlin rendering is `day hhmm`.
    const naive = Date.parse(`${day}T${hhmm}:00Z`);
    for (const offsetHours of [0, 1, 2, 3]) {
      const candidate = new Date(naive - offsetHours * 3_600_000);
      if (PraxisAppointmentReminderPage.berlinWallClock(candidate) === `${day} ${hhmm}`) return candidate;
    }
    throw new Error(`#3640: no Berlin instant for ${day} ${hhmm}`);
  }

  /** `YYYY-MM-DD HH:MM` as a clock on a wall in Berlin would read it. */
  static berlinWallClock(at: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }

  /** The Berlin hour of day, for AC1's 08:00–20:00 sending window. */
  static berlinHour(at: Date): number {
    return Number(PraxisAppointmentReminderPage.berlinWallClock(at).slice(11, 13));
  }

  /** When this appointment's reminder becomes due, at a given lead time. */
  static remindAt(appointment: Appointment, leadHours: number): Date {
    return new Date(appointment.startsAt.getTime() - leadHours * 3_600_000);
  }

  /**
   * A faithful port of `AppointmentReminderScheduler::isDue()`, minus the message-log lookup —
   * the caller supplies that, so the three *rules* can be asserted separately from de-duplication.
   *
   * ```php
   * if ($startsAt <= $now || $remindAt > $now)            return false;   // inside the lead time, still ahead
   * if (null === $bookedAt || $bookedAt > $remindAt)      return false;   // booked inside the lead time
   * return !$this->alreadyLogged($appointment);
   * ```
   *
   * Note both boundaries: an appointment starting exactly now is NOT due (`<=`), and one booked
   * exactly AT its remind-at instant IS eligible (`>`, not `>=`).
   */
  static isDue(
    appointment: Appointment,
    leadHours: number,
    now: Date,
  ): { due: boolean; reason: 'due' | 'not_booked' | 'started' | 'too_early' | 'booked_inside' | 'unknown_booking' } {
    if (appointment.status !== 'booked') return { due: false, reason: 'not_booked' };
    const remindAt = PraxisAppointmentReminderPage.remindAt(appointment, leadHours);
    if (appointment.startsAt <= now) return { due: false, reason: 'started' };
    if (remindAt > now) return { due: false, reason: 'too_early' };
    if (appointment.bookedAt === null) return { due: false, reason: 'unknown_booking' };
    if (appointment.bookedAt > remindAt) return { due: false, reason: 'booked_inside' };
    return { due: true, reason: 'due' };
  }

  /**
   * The most recent instant the hourly pass can have run at or before `now`.
   *
   * The catch-up invariant needs this: an appointment that entered its due window five minutes ago
   * has no reminder yet and that is correct, not a miss.
   */
  static lastRunBefore(now: Date): Date {
    const hour = now.getUTCHours();
    const onTheHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
    if (hour >= 6 && hour <= 19) return onTheHour;
    // Before 06:00 UTC the last pass was yesterday's 19:00; after 19:00 it was today's.
    if (hour > 19) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 0, 0));
    const yesterday = new Date(onTheHour.getTime() - 24 * 3_600_000);
    return new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 19, 0, 0));
  }

  // ───────────────────────────── live reads ─────────────────────────────

  /** Every facility, with its lead time. `reminderLeadHours` is in the DEFAULT group, not only `ech:read`. */
  async practices(): Promise<Practice[]> {
    const body = await this.get<{ member: Record<string, any>[] }>('/elderly_care_homes?itemsPerPage=1000');
    return (body.member ?? []).map((e) => ({
      id: e.id as number,
      name: (e.name as string) ?? '',
      type: (e.type as string) ?? null,
      reminderLeadHours: e.reminderLeadHours as number | undefined,
    }));
  }

  async practice(id: number): Promise<Practice> {
    const e = await this.get<Record<string, any>>(`/elderly_care_homes/${id}`);
    return { id: e.id, name: e.name ?? '', type: e.type ?? null, reminderLeadHours: e.reminderLeadHours };
  }

  /** `PATCH /elderly_care_homes/{id}` with only the lead time — the write `therapios/praxis#8` makes. */
  async setLeadHours(id: number, hours: number): Promise<{ status: number; body: unknown }> {
    const res = await this.request.patch(`${API_BASE}/elderly_care_homes/${id}`, {
      headers: {
        Authorization: `Bearer ${await this.bearer()}`,
        'Content-Type': 'application/merge-patch+json',
        Accept: 'application/ld+json',
      },
      data: { reminderLeadHours: hours },
      timeout: 120_000,
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
  }

  /** Every appointment, with its embedded history. */
  async appointments(): Promise<Appointment[]> {
    const body = await this.get<{ member: Record<string, any>[] }>('/appointments?itemsPerPage=1000');
    return (body.member ?? []).map((a) => ({
      id: a.id as number,
      patientId: PraxisAppointmentReminderPage.idOf(a.patient),
      practiceId: PraxisAppointmentReminderPage.idOf(a.elderlyCareHome),
      status: (a.status as string) ?? '',
      startsAt: PraxisAppointmentReminderPage.berlinStart(a.date as string, a.startTime as string),
      bookedAt: a.createdAt ? new Date(a.createdAt as string) : null,
      history: ((a.history as Record<string, any>[]) ?? []).map((h) => ({
        action: (h.action as string) ?? '',
        changedAt: (h.changedAt as string) ?? '',
        changedByName: (h.changedByName as string) ?? null,
        detail: (h.detail as Record<string, unknown>) ?? null,
      })),
      keys: Object.keys(a),
    }));
  }

  /** The practice's message log, narrowed to this ticket's template. */
  async reminderMessages(): Promise<ReminderMessage[]> {
    const body = await this.get<{ member: Record<string, any>[] }>(
      `/text_messages?template=${REMINDER_TEMPLATE}&itemsPerPage=1000`,
    );
    return (body.member ?? [])
      .filter((m) => m.template === REMINDER_TEMPLATE)
      .map((m) => ({
        id: m.id as number,
        appointmentId: PraxisAppointmentReminderPage.idOf(m.appointment),
        patientId: PraxisAppointmentReminderPage.idOf(m.patient),
        practiceId: PraxisAppointmentReminderPage.idOf(m.elderlyCareHome),
        status: (m.status as string) ?? '',
        locale: (m.locale as string) ?? null,
        requestedAt: new Date(m.requestedAt as string),
      }));
  }

  /** The whole message log, for the template/status inventory. */
  async allMessages(): Promise<Record<string, any>[]> {
    const body = await this.get<{ member: Record<string, any>[] }>('/text_messages?itemsPerPage=1000');
    return body.member ?? [];
  }

  /**
   * `smsConsentGranted` per patient.
   *
   * ONE REQUEST PER PATIENT, deliberately: the collection filter of that name is accepted and
   * silently ignored (`=true`, `=false` and unfiltered all answer 8,401), so there is no cheaper
   * way and a count taken from the filter is meaningless.
   */
  async consentByPatient(ids: number[]): Promise<Map<number, boolean>> {
    const out = new Map<number, boolean>();
    for (const id of ids) {
      const p = await this.get<Record<string, any>>(`/patients/${id}`);
      out.set(id, Boolean(p.smsConsentGranted));
    }
    return out;
  }

  /** Proof that the consent filter partitions nothing — run before any count built on it is believed. */
  async consentFilterTotals(): Promise<{ yes: number; no: number; all: number }> {
    const total = async (q: string) =>
      (await this.get<{ totalItems?: number }>(`/patients?${q}itemsPerPage=1`)).totalItems ?? -1;
    return {
      yes: await total('smsConsentGranted=true&'),
      no: await total('smsConsentGranted=false&'),
      all: await total(''),
    };
  }

  // ───────────────────────────── the Praxis front end ─────────────────────────────

  /**
   * The JavaScript the deployed Praxis app serves to an anonymous visitor at `/login`.
   *
   * AC4 is decidable without a Praxis login because the whole translation dictionary — both
   * locales — ships inside the login page's own chunks, so the reminder block's German and
   * English strings can be read off the served build the way #3337 reads Flow's.
   */
  async praxisLoginBundle(): Promise<{ html: string; js: string; chunks: string[] }> {
    const page = await this.request.get(`${PRAXIS_BASE}/login`, { timeout: 120_000 });
    if (!page.ok()) throw new Error(`GET ${PRAXIS_BASE}/login -> ${page.status()}`);
    const html = await page.text();
    const chunks = [...new Set([...html.matchAll(/"(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
    let js = '';
    for (const chunk of chunks) {
      const res = await this.request.get(`${PRAXIS_BASE}${chunk}`, { timeout: 120_000 });
      if (res.ok()) js += await res.text();
    }
    return { html, js, chunks };
  }

  private static idOf(iri: unknown): number | null {
    if (typeof iri !== 'string') return null;
    const n = Number(iri.split('/').pop());
    return Number.isFinite(n) ? n : null;
  }
}
